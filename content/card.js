/* WaitEarn — sponsored offer card engine (REAL earning edition).
   Environment-agnostic: runs as a Chrome content script AND in the demo page.
   The card shows REAL offers (affiliate / sponsor / referral links). Earns
   only move when a human CLICKS the CTA — the click is verified server-side.
   PRIVACY: chat content is never read, logged or transmitted. */
(() => {
  "use strict";
  if (window.__waitearnCardLoaded) return;
  window.__waitearnCardLoaded = true;

  /* ------------------------- config ---------------------------------------- */
  const STORAGE_KEY = "waitearn_state_v1";
  const QUALIFY_SECONDS = 5; // continuous visible seconds to count an impression
  const DEFAULT_SHARE = 0.5; // fallback split (server's value is authoritative)

  /* --------------------- local inventory (server offline) ------------------ */
  /* Real destinations, real payouts are defined by the operator in /admin.
     These fallbacks keep the card useful without a server. */
  const ADS = [
    { id: "duolingo",  brand: "Duolingo",  emoji: "🦉", headline: "Turn waiting time into a streak",      sub: "5 minutes of Spanish while the AI thinks?",  cta: "Try Duolingo",  accent: "#f97316", url: "https://www.duolingo.com",  cpc: 0.55 },
    { id: "notion",    brand: "Notion",    emoji: "🗂️", headline: "Your tidy second brain",               sub: "Free plan for personal use — forever",       cta: "Get Notion",    accent: "#ea580c", url: "https://www.notion.so",     cpc: 0.85 },
    { id: "wise",      brand: "Wise",      emoji: "💸", headline: "Send money at the real exchange rate", sub: "No hidden fees, no markup",                  cta: "Learn more",    accent: "#d97706", url: "https://wise.com",          cpc: 0.90 },
    { id: "grammarly", brand: "Grammarly", emoji: "✏️", headline: "Sound sharp in every reply",           sub: "Write better everywhere you type",           cta: "Add Grammarly", accent: "#f97316", url: "https://www.grammarly.com", cpc: 0.75 },
    { id: "audible",   brand: "Audible",   emoji: "🎧", headline: "One audiobook, on us",                 sub: "30-day free trial, cancel anytime",          cta: "Start free",    accent: "#fb923c", url: "https://www.audible.com",   cpc: 1.20 },
    { id: "framer",    brand: "Framer",    emoji: "🚀", headline: "Design and ship sites in minutes",     sub: "No code needed for your next landing page",  cta: "Try Framer",    accent: "#f59e0b", url: "https://www.framer.com",    cpc: 1.10 }
  ];

  const DEFAULT_STATE = {
    enabled: true,
    balance: 0,          // legacy local cache — real balance lives on the server
    impressions: 0,
    sessions: 0,
    dismissed: 0,
    visibleSeconds: 0,
    platformCounts: {}
  };

  /* ------------------ storage (chrome.* with localStorage fallback) -------- */
  function sanitize(raw) {
    const out = { ...DEFAULT_STATE };
    if (raw && typeof raw === "object") {
      for (const k of Object.keys(DEFAULT_STATE)) {
        if (typeof raw[k] === typeof DEFAULT_STATE[k]) out[k] = raw[k];
      }
    }
    return out;
  }

  function loadState() {
    return new Promise((resolve) => {
      try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get([STORAGE_KEY], (res) => {
            resolve(sanitize(res && res[STORAGE_KEY]));
          });
          return;
        }
      } catch (e) { /* fall through to localStorage */ }
      try {
        resolve(sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")));
      } catch (e) {
        resolve({ ...DEFAULT_STATE });
      }
    });
  }

  function saveState(state) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ [STORAGE_KEY]: state }, () => resolve());
          return;
        }
      } catch (e) { /* fall through to localStorage */ }
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
      resolve();
    });
  }

  const money = (n) => "$" + n.toFixed(4);

  /* --------------------------------- UI ----------------------------------- */
  let el = null, fill = null, earnEl = null, timerEl = null,
      emojiEl = null, brandEl = null, headEl = null, subEl = null, ctaEl = null;

  let running = false;
  let tickHandle = 0;
  let cycleSeconds = 0;      // visible seconds on the CURRENT card
  let unflushed = 0;         // visible seconds not yet written to storage
  let lastAdIndex = -1;
  let currentAd = null;      // ad object shown on the current card
  let shownThisCycle = false;

  function buildCard() {
    el = document.createElement("div");
    el.className = "we-card we-hidden";
    el.setAttribute("data-waitearn", "card");
    el.innerHTML = `
      <div class="we-top">
        <span class="we-sponsored">Sponsored</span>
        <span class="we-brandname">WaitEarn</span>
        <span class="we-info" title="Real offers from the operator's inventory. Clicks are verified and pay the ledger. Chats are never read.">ⓘ</span>
        <button class="we-x" title="Dismiss" aria-label="Dismiss offer">✕</button>
      </div>
      <div class="we-body">
        <div class="we-emoji">🎯</div>
        <div class="we-copy">
          <div class="we-adbrand"></div>
          <div class="we-headline"></div>
          <div class="we-sub"></div>
        </div>
        <button class="we-cta">Open</button>
      </div>
      <div class="we-progress"><div class="we-fill"></div></div>
      <div class="we-foot">
        <span class="we-earn">💸 <b>$0.0000</b> to you per verified click</span>
        <span class="we-timer">5.0s qualify view</span>
      </div>
      <div class="we-note">Click opens the real offer — your share is credited to the ledger.</div>
    `;
    document.documentElement.appendChild(el);

    emojiEl = el.querySelector(".we-emoji");
    brandEl = el.querySelector(".we-adbrand");
    headEl = el.querySelector(".we-headline");
    subEl = el.querySelector(".we-sub");
    ctaEl = el.querySelector(".we-cta");
    fill = el.querySelector(".we-fill");
    earnEl = el.querySelector(".we-earn b");
    timerEl = el.querySelector(".we-timer");

    el.querySelector(".we-x").addEventListener("click", () => hide("dismissed"));

    ctaEl.addEventListener("click", () => {
      ctaEl.classList.remove("we-cta-press");
      void ctaEl.offsetWidth;
      ctaEl.classList.add("we-cta-press");

      // REAL action: open the operator's real destination (affiliate/sponsor
      // link) and let the backend verify + pay out on the ledger.
      if (currentAd && currentAd.url) {
        try { window.open(currentAd.url, "_blank", "noopener"); } catch (e) { /* popup blocked */ }
        reportEvent({
          type: "waitearn:click",
          payload: {
            adId: currentAd.id,
            brand: currentAd.brand,
            platform: PLATFORM,
            ts: Date.now()
          }
        });
        spawnCashParticle((Number(currentAd.cpc) || 0) * DEFAULT_SHARE);
      }
    });
  }

  function pickLocalAd() {
    let i;
    do {
      i = Math.floor(Math.random() * ADS.length);
    } while (ADS.length > 1 && i === lastAdIndex);
    lastAdIndex = i;
    return ADS[i];
  }

  /* Server-served real inventory: the backend owns offers + payouts.
     The service worker refills this queue from /api/ads. */
  const AD_QUEUE_KEY = "waitearn_ad_queue";
  const PLATFORM = location.hostname.replace(/^www\./, "") || "unknown";

  async function takeServerAd() {
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return null;
      const bag = await new Promise((r) => chrome.storage.local.get([AD_QUEUE_KEY], (g) => r(g && g[AD_QUEUE_KEY])));
      const queue = Array.isArray(bag) ? bag : [];
      if (!queue.length) return null;
      const ad = queue.shift();
      await new Promise((r) => chrome.storage.local.set({ [AD_QUEUE_KEY]: queue }, r));
      if (queue.length < 2) {
        try { chrome.runtime?.sendMessage({ type: "waitearn:restock", platform: PLATFORM }); } catch (e) { /* ignore */ }
      }
      if (ad && typeof ad.brand === "string" && typeof ad.headline === "string") return ad;
      return null;
    } catch (e) {
      return null;
    }
  }

  function reportEvent(msg) {
    try { chrome.runtime?.sendMessage(msg); } catch (e) { /* extension context gone */ }
  }

  function renderAd(ad) {
    document.documentElement.style.setProperty("--we-accent", ad.accent);
    emojiEl.textContent = ad.emoji;
    brandEl.textContent = ad.brand;
    headEl.textContent = ad.headline;
    subEl.textContent = ad.sub;
    ctaEl.textContent = ad.cta || "Open";
    if (earnEl) earnEl.textContent = money((Number(ad.cpc) || 0) * DEFAULT_SHARE);
    if (timerEl) timerEl.textContent = QUALIFY_SECONDS.toFixed(1) + "s qualify view";
  }

  /* Floating "+$0.2750" particle when the click fires */
  function spawnCashParticle(amount) {
    if (!el || el.classList.contains("we-hidden")) return;
    const p = document.createElement("span");
    p.className = "we-cash";
    p.textContent = "+" + money(Number(amount) || 0);
    p.style.setProperty("--we-drift", (Math.random() * 40 - 20).toFixed(0) + "px");
    p.style.right = (14 + Math.random() * 40).toFixed(0) + "px";
    el.appendChild(p);
    setTimeout(() => p.remove(), 1500);
  }

  /* --------------------------- attention loop ----------------------------- */
  function startLoop() {
    cycleSeconds = 0;
    if (tickHandle) return;
    tickHandle = setInterval(tick, 200);
  }

  function stopLoop() {
    if (tickHandle) {
      clearInterval(tickHandle);
      tickHandle = 0;
    }
  }

  function tick() {
    if (!running || !el) return;
    // hidden tab never counts impressions (like real ad systems)
    if (document.hidden) { updateFooter(); return; }

    const before = cycleSeconds;
    cycleSeconds += 0.2;
    unflushed += 0.2;

    if (Math.floor(before / QUALIFY_SECONDS) < Math.floor(cycleSeconds / QUALIFY_SECONDS)) {
      award();
    }
    updateFooter();
  }

  function updateFooter() {
    if (!el) return;
    const inner = ((cycleSeconds % QUALIFY_SECONDS) + QUALIFY_SECONDS) % QUALIFY_SECONDS;
    fill.style.width = (inner / QUALIFY_SECONDS) * 100 + "%";
    timerEl.textContent = (QUALIFY_SECONDS - inner).toFixed(1) + "s qualify view";
  }

  function award() {
    loadState().then((st) => {
      st.impressions += 1;
      st.visibleSeconds += unflushed;
      st.platformCounts[PLATFORM] = (st.platformCounts[PLATFORM] || 0) + 1;
      unflushed = 0;
      saveState(st);

      // Attention stat for the operator's dashboards. No money moves here —
      // verified CTA clicks are the only earning path now.
      if (currentAd && currentAd.id) {
        reportEvent({
          type: "waitearn:impression",
          payload: {
            adId: currentAd.id,
            brand: currentAd.brand,
            platform: PLATFORM,
            ts: Date.now()
          }
        });
      }
      updateFooter();
    });
  }

  /* --------------------------- lifecycle ---------------------------------- */
  async function show() {
    const st = await loadState();
    if (!st || !st.enabled) return;
    if (!el) buildCard();

    currentAd = (await takeServerAd()) || pickLocalAd();
    renderAd(currentAd);
    shownThisCycle = true;
    running = true;
    el.classList.remove("we-hidden");
    startLoop();
    updateFooter();
  }

  async function hide(reason) {
    running = false;
    stopLoop();
    if (!el || !shownThisCycle) return;
    shownThisCycle = false;
    el.classList.add("we-hidden");

    const st = await loadState();
    st.sessions += 1;
    st.visibleSeconds += unflushed;
    unflushed = 0;
    if (reason === "dismissed") st.dismissed += 1;
    saveState(st);

    // backend tracks sessions + watching time for the ops dashboard
    if (cycleSeconds > 1) {
      reportEvent({ type: "waitearn:session", payload: { platform: PLATFORM, seconds: Math.round(cycleSeconds) } });
    }
    currentAd = null;
  }

  window.WaitEarnCard = { show, hide, STORAGE_KEY, QUALIFY_SECONDS };
})();
