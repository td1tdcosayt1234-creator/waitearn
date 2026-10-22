/* WaitEarn prototype — service worker (v0.4, REAL earning edition)
   - keeps the toolbar badge in sync (impressions)
   - generates a stable userId for this browser
   - forwards card events to the backend ledger:
       waitearn:impression  → attention stats (no $)
       waitearn:click       → verified-click payouts (REAL ledger)
   - refills the server-served offer queue used by content/card.js
   Backend: http://localhost:8000 (node server/server.js) */

const SERVER = "http://localhost:8000";
const UID_KEY = "waitearn_uid";
const QUEUE_KEY = "waitearn_event_queue";
const AD_QUEUE_KEY = "waitearn_ad_queue";
const SERVER_BAL_KEY = "waitearn_server_balance";
const AUTH_KEY = "waitearn_auth";               // {username, userId, token, ts}
const BADGE_COLOR = [249, 115, 22, 255]; // orange

/* --------------------------------- badge ----------------------------------- */
function fmtCount(n) {
  if (n >= 10000) return Math.round(n / 1000) + "k+";
  return String(n);
}

function updateLocalBadge() {
  try {
    chrome.storage.local.get(["waitearn_state_v1", SERVER_BAL_KEY], (res) => {
      const s = res && res.waitearn_state_v1;
      chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
      if (chrome.action.setBadgeTextColor) {
        chrome.action.setBadgeTextColor({ color: [255, 255, 255, 255] });
      }
      // badge shows REAL money status: server clicks when known, else local impressions
      const sb = res && res[SERVER_BAL_KEY];
      const fresh = sb && sb.balance !== undefined && Date.now() - (sb.ts || 0) < 5 * 60 * 1000;
      if (fresh && Number(sb.balance) > 0) {
        chrome.action.setBadgeText({ text: "$" + sb.balance.toFixed(2) });
      } else if (s && s.impressions) {
        chrome.action.setBadgeText({ text: fmtCount(s.impressions) });
      } else {
        chrome.action.setBadgeText({ text: "" });
      }
    });
  } catch (e) { /* ignore */ }
}

/* --------------------------------- user id ---------------------------------- */
function ensureUserId() {
  return new Promise((resolve) => {
    chrome.storage.local.get([UID_KEY], (res) => {
      const existing = res && res[UID_KEY];
      if (existing && /^[a-zA-Z0-9-]{6,64}$/.test(existing)) return resolve(existing);
      const uid = (crypto.randomUUID && crypto.randomUUID()) ||
        ("dev-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));
      chrome.storage.local.set({ [UID_KEY]: uid }, () => resolve(uid));
    });
  });
}

/* The ledger subject: the logged-in account when present, else this device. */
function getSubject() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([AUTH_KEY], (g) => {
        const auth = g && g[AUTH_KEY];
        if (auth && auth.userId && auth.token) return resolve({ userId: auth.userId, token: auth.token });
        ensureUserId().then((uid) => resolve({ userId: uid, token: "" }));
      });
    } catch (e) {
      ensureUserId().then((uid) => resolve({ userId: uid, token: "" }));
    }
  });
}

/* ------------------------------ event queue ---------------------------------
   Events land here and are POSTed to /api/events. If the server is down,
   events stay queued in chrome.storage and are flushed later. */
let flushing = false;
let flushTimer = 0;

async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    const subject = await getSubject();
    const bag = await new Promise((r) => chrome.storage.local.get([QUEUE_KEY], (g) => r(g && g[QUEUE_KEY])));
    const queue = Array.isArray(bag) ? bag : [];
    if (!queue.length) return;

    const batch = queue.slice(0, 50);
    const res = await fetch(`${SERVER}/api/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(subject.token ? { Authorization: "Bearer " + subject.token } : {})
      },
      body: JSON.stringify({ userId: subject.userId, events: batch })
    });
    if (!res.ok) throw new Error("status " + res.status);
    const out = await res.json();

    // drop only what the server acknowledged (all counted outcomes)
    const acked = (out.clickCredits || 0) + (out.clickDupes || 0) + (out.unpaid || 0) +
                  (out.impressions || 0) + (out.skipped || 0);
    const rest = queue.slice(Math.min(acked, batch.length));
    await new Promise((r) => chrome.storage.local.set({ [QUEUE_KEY]: rest }, r));

    if (out.balance !== undefined) {
      await new Promise((r) => chrome.storage.local.set(
        { [SERVER_BAL_KEY]: { balance: out.balance, clicks: out.clicks || 0, ts: Date.now() } }, r));
    }
    if (rest.length) scheduleFlush(4000);
  } catch (e) {
    scheduleFlush(15000); // server down — retry later
  } finally {
    flushing = false;
  }
}

function enqueueEvent(event) {
  return new Promise((resolve) => {
    chrome.storage.local.get([QUEUE_KEY], (g) => {
      const queue = Array.isArray(g && g[QUEUE_KEY]) ? g[QUEUE_KEY] : [];
      queue.push(event);
      chrome.storage.local.set({ [QUEUE_KEY]: queue.slice(-500) }, () => {
        resolve();
        flushQueue();
      });
    });
  });
}

function scheduleFlush(ms) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushQueue, ms);
}

/* ------------------------------ offer inventory -----------------------------
   The server owns the REAL offers (affiliate/sponsor links + payout per
   verified click). The card pops them from this local queue; when it runs
   low it asks us (waitearn:restock) to refill. */
async function restockAds(prefill) {
  try {
    const bag = await new Promise((r) => chrome.storage.local.get([AD_QUEUE_KEY], (g) => r(g && g[AD_QUEUE_KEY])));
    let queue = Array.isArray(bag) ? bag : [];
    if (prefill) queue = []; // fresh install/extension reload: take server inventory up front
    if (queue.length >= 6) return;
    const uid = await ensureUserId();
    const res = await fetch(`${SERVER}/api/ads?n=8&userId=${encodeURIComponent(uid)}`);
    if (!res.ok) throw new Error("status " + res.status);
    const data = await res.json();
    if (Array.isArray(data.ads) && data.ads.length) {
      queue = queue.concat(data.ads).slice(-12);
      await new Promise((r) => chrome.storage.local.set({ [AD_QUEUE_KEY]: queue }, r));
    }
  } catch (e) {
    // backend offline — card falls back to its bundled local inventory
  }
}

/* --------------------------------- wiring ----------------------------------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("waitearn:")) return;
  const p = msg.payload || {};

  /* account login / register from the popup (merge the device ledger in) */
  if (msg.type === "waitearn:auth") {
    handleAuth(p, sendResponse);
    return true; // async response
  }
  if (msg.type === "waitearn:auth-logout") {
    handleLogout(sendResponse);
    return true; // async response
  }

  if (msg.type === "waitearn:impression") {
    enqueueEvent({ kind: "impression", adId: p.adId, brand: p.brand, platform: p.platform, ts: p.ts || Date.now() });
  } else if (msg.type === "waitearn:click") {
    // REAL money path — the backend verifies + pays the user's ledger share
    enqueueEvent({ kind: "click", adId: p.adId, brand: p.brand, platform: p.platform, ts: p.ts || Date.now() });
  } else if (msg.type === "waitearn:session" && p.platform) {
    getSubject().then((subject) => {
      try {
        fetch(`${SERVER}/api/session`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(subject.token ? { Authorization: "Bearer " + subject.token } : {})
          },
          body: JSON.stringify({ userId: subject.userId, platform: p.platform, seconds: p.seconds })
        });
      } catch (e) { /* ignore */ }
    });
  } else if (msg.type === "waitearn:restock") {
    restockAds(false);
  }
});

/* ---------------------------- auth implementations -------------------------- */
async function handleAuth(p, respond) {
  const action = p.action === "register" ? "register" : "login";
  try {
    const deviceUid = await ensureUserId();
    const res = await fetch(`${SERVER}/api/auth/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: p.username, password: p.password, mergeUid: deviceUid })
    });
    let out = {};
    try { out = await res.json(); } catch (e) { /* non-json */ }
    if (!res.ok || !out.ok) {
      return respond({ ok: false, error: (out && out.error) || ("HTTP " + res.status) });
    }
    await new Promise((r) => chrome.storage.local.set(
      { [AUTH_KEY]: { username: out.username, userId: out.userId, token: out.token, ts: Date.now() } }, r));
    flushQueue();          // queued events now post under the account id
    updateLocalBadge();
    respond({ ok: true, username: out.username, balance: out.balance || 0, clicks: out.clicks || 0 });
  } catch (e) {
    respond({ ok: false, error: "backend offline — node server/server.js chalao" });
  }
}

async function handleLogout(respond) {
  try {
    const g = await new Promise((r) => chrome.storage.local.get([AUTH_KEY], (s) => r(s && s[AUTH_KEY])));
    if (g && g.token) {
      try {
        await fetch(`${SERVER}/api/auth/logout`, { method: "POST", headers: { Authorization: "Bearer " + g.token } });
      } catch (e) { /* offline is fine — we still clear locally */ }
    }
    await new Promise((r) => chrome.storage.local.remove([AUTH_KEY, SERVER_BAL_KEY], r));
    flushQueue();
    updateLocalBadge();
  } catch (e) { /* ignore */ }
  respond({ ok: true });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureUserId().then(() => {
    restockAds(true);   // prefill with the operator's real inventory
    flushQueue();       // flush anything queued while we were away
    updateLocalBadge();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes["waitearn_state_v1"] || changes[SERVER_BAL_KEY])) updateLocalBadge();
});

updateLocalBadge();
restockAds(true);
flushQueue();
