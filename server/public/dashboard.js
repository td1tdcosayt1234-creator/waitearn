/* WaitEarn live dashboard — real-time via SSE (EventSource), zero dependencies. */
"use strict";

const $ = (s, r) => (r || document).querySelector(s);

/* ------------------------------- identity ---------------------------------- */
const UID_KEY = "waitearn_uid";
let uid = localStorage.getItem(UID_KEY);
if (!uid || !/^[a-zA-Z0-9-]{6,64}$/.test(uid)) {
  uid = (crypto.randomUUID && crypto.randomUUID()) ||
        ("dash-" + Math.random().toString(36).slice(2) + "-" + Date.now().toString(36));
  localStorage.setItem(UID_KEY, uid);
}
$("#uidShort").textContent = uid.slice(0, 8) + "…";

$("#uidChip").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(uid); } catch (e) { /* ignore */ }
  const chip = $("#uidChip");
  chip.innerHTML = "✓ copied";
  setTimeout(() => { chip.innerHTML = '⧉ <span id="uidShort">' + uid.slice(0, 8) + "…</span>"; }, 1400);
});

/* viewing identity: the logged-in account's ledger when signed in, else device */
let VIEW_UID = uid;

/* --------------------------------- state ----------------------------------- */
const S = {
  balance: 0,
  clicks: 0,
  impressions: 0,
  waitedSeconds: 0,
  sessions: 0,
  platformCounts: {},
  stamps: [],            // impression timestamps for the 15-min sparkline
  history: [],           // [{ts, balance}] cumulative curve (server-backed, capped)
  adStats: {}            // {adId: {brand, emoji, clicks, revenue}}
};

const MILESTONES = [0.01, 0.025, 0.05, 0.10, 0.25, 0.50, 1.00, 2.50, 5.00];
const milestoneKey = (m) => "waitearn_m_" + String(m).replace(".", "_");

const PLATFORM_ICONS = {
  "chatgpt.com": "🤖", "openai.com": "🤖", "claude.ai": "🧠", "gemini.google.com": "✨",
  "deepseek.com": "🐋", "grok.com": "⚡", "x.com": "𝕏", "copilot.microsoft.com": "🪟",
  "mistral.ai": "🌬️", "perplexity.ai": "🔎", "kimi.com": "🌙", "moonshot.cn": "🌙",
  "qwen.ai": "🌀", "aliyun.com": "🌀", "meta.ai": "🅜", "character.ai": "🎭",
  "dashboard-demo": "🧪"
};

function plIcon(platform) {
  for (const key of Object.keys(PLATFORM_ICONS)) {
    if (platform && (platform === key || platform.endsWith(key))) return PLATFORM_ICONS[key];
  }
  return "🌐";
}

const money = (n) => "$" + (Number(n) || 0).toFixed(4);

function fmtSecs(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return h + "h " + m + "m";
  if (m) return m + "m " + (s % 60) + "s";
  return s + "s";
}

/* --------------------------- animated numbers ------------------------------ */
const shown = {}; // element -> last shown value
function countUp(el, target, fmt) {
  if (!el) return;
  const from = typeof shown[el.id] === "number" ? shown[el.id] : 0;
  shown[el.id] = target;
  if (Math.abs(target - from) < 0.000001) { el.textContent = fmt(target); return; }
  el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
  const t0 = performance.now(), dur = 550;
  (function step(t) {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (target - from) * eased);
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = fmt(target);
  })(t0);
}

/* -------------------------------- sparkline -------------------------------- */
const spark = $("#spark");
const sctx = spark.getContext("2d");

function drawSpark() {
  const now = Date.now();
  while (S.stamps.length && now - S.stamps[0] > 15 * 60000) S.stamps.shift();

  const dpr = window.devicePixelRatio || 1;
  const w = spark.clientWidth, h = 120;
  if (spark.width !== w * dpr) { spark.width = w * dpr; spark.height = h * dpr; }
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sctx.clearRect(0, 0, w, h);

  const buckets = new Array(15).fill(0);
  for (const ts of S.stamps) {
    const idx = Math.min(14, Math.floor((ts - (now - 15 * 60000)) / 60000));
    buckets[idx]++;
  }
  const max = Math.max(3, ...buckets);

  // baseline
  sctx.strokeStyle = "rgba(36,26,30,0.10)";
  sctx.beginPath(); sctx.moveTo(0, h - 18); sctx.lineTo(w, h - 18); sctx.stroke();

  const px = (i) => (i / 14) * (w - 8) + 4;
  const py = (v) => h - 18 - (v / max) * (h - 32);

  // area fill
  const grad = sctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(225,29,72,0.26)");
  grad.addColorStop(1, "rgba(225,29,72,0)");
  sctx.beginPath();
  sctx.moveTo(px(0), py(buckets[0]));
  for (let i = 1; i < 15; i++) sctx.lineTo(px(i), py(buckets[i]));
  sctx.lineTo(px(14), h - 18); sctx.lineTo(px(0), h - 18); sctx.closePath();
  sctx.fillStyle = grad; sctx.fill();

  // line
  sctx.beginPath();
  sctx.moveTo(px(0), py(buckets[0]));
  for (let i = 1; i < 15; i++) sctx.lineTo(px(i), py(buckets[i]));
  sctx.strokeStyle = "#e11d48"; sctx.lineWidth = 2.2;
  sctx.lineJoin = "round"; sctx.stroke();

  // dots + labels
  sctx.fillStyle = "#e11d48";
  for (let i = 0; i < 15; i++) {
    if (buckets[i]) { sctx.beginPath(); sctx.arc(px(i), py(buckets[i]), 2.6, 0, Math.PI * 2); sctx.fill(); }
  }
  sctx.fillStyle = "rgba(139,130,146,0.95)";
  sctx.font = "10px system-ui";
  sctx.fillText("-15m", 2, h - 4);
  sctx.fillText("now", w - 26, h - 4);
}

/* -------------------------------- rendering -------------------------------- */
function renderStats() {
  countUp($("#balance"), S.balance, money);
  countUp($("#impressions"), S.impressions, (n) => Math.round(n).toLocaleString());
  countUp($("#waited"), S.waitedSeconds, (n) => fmtSecs(Math.floor(n)));
  countUp($("#clicks"), S.clicks, (n) => String(Math.round(n)));
  countUp($("#sessions"), S.sessions, (n) => String(Math.round(n)));

  // split: user takes S.balance; the platform takes the same (50%)
  const total = S.balance * 2;
  $("#totalRevenue").textContent = money(total);
  $("#splitYou").textContent = money(S.balance);
  $("#splitWe").textContent = money(S.balance - 0);

  // platform breakdown
  const wrap = $("#platforms");
  const entries = Object.entries(S.platformCounts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return;
  const maxC = entries[0][1];
  wrap.innerHTML = entries.map(([p, c]) => `
    <div class="pl">
      <span class="nm">${plIcon(p)} ${p.replace(/^www\./, "")}</span>
      <span class="bar"><i style="width:${(c / maxC) * 100}%"></i></span>
      <span class="ct">${c}</span>
    </div>`).join("");
}

function pushFeed(ev) {
  const feed = $("#feed");
  const waiting = feed.querySelector(".muted");
  if (waiting) waiting.remove();

  const d = new Date(ev.ts || Date.now());
  const isClick = (ev.type === "click");
  const item = document.createElement("div");
  item.className = "ev" + (isClick ? " click" : "");
  item.innerHTML = `
    <span class="ic">${ev.ad && ev.ad.emoji ? ev.ad.emoji : (isClick ? "💸" : "👁️")}</span>
    <span class="tx">
      <b>${ev.ad ? ev.ad.brand : "Ad"}</b> <span class="pt">· ${ev.platform.replace(/^www\./, "")}
      · ${d.toLocaleTimeString()}${isClick ? " · 💸 verified click" : ""}${ev.synthetic ? " · <span style='color:#b45309'>test</span>" : ""}</span>
    </span>
    <span class="cut">${isClick ? "+" + money(ev.userCut) : "👁"}</span>`;
  feed.prepend(item);
  while (feed.children.length > 24) feed.lastElementChild.remove();
}

function renderLeaderboard(top) {
  const lb = $("#leaderboard");
  if (!top || !top.length) return;
  lb.innerHTML = top.map((u, i) => `
    <div class="lrow${u.userId === VIEW_UID ? " me" : ""}">
      <span class="rk">${["🥇", "🥈", "🥉", "4", "5"][i] || i + 1}</span>
      <span class="id">${u.short}…</span>
      <span class="bl">${money(u.balance)}</span>
    </div>`).join("");
}

/* ------------------------------ cumulative chart --------------------------- */
const cum = $("#cumulus");
const cctx = cum.getContext("2d");

function drawCumulus() {
  const pts = S.history.slice(-300);
  const dpr = window.devicePixelRatio || 1;
  const w = cum.clientWidth, h = 150;
  if (cum.width !== w * dpr) { cum.width = w * dpr; cum.height = h * dpr; }
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cctx.clearRect(0, 0, w, h);

  const padL = 6, padR = 58, padT = 10, padB = 16;
  const last = pts.length ? pts[pts.length - 1] : null;
  $("#cumValue").textContent = money(S.balance);

  const maxB = Math.max(0.005, ...pts.map((p) => p.balance));
  const t0 = pts.length ? pts[0].ts : Date.now() - 60000;
  const t1 = Math.max(last ? last.ts : Date.now(), t0 + 60000);
  const px = (ts) => padL + ((ts - t0) / (t1 - t0)) * (w - padL - padR);
  const py = (b) => h - padB - (b / maxB) * (h - padT - padB);

  // floor line
  cctx.strokeStyle = "rgba(36,26,30,0.10)";
  cctx.beginPath();
  cctx.moveTo(padL, h - padB);
  cctx.lineTo(w - padR + 40, h - padB);
  cctx.stroke();

  if (pts.length < 2) {
    cctx.fillStyle = "rgba(139,130,146,0.9)";
    cctx.font = "11.5px system-ui";
    cctx.fillText("First impression-income ashlei ekhane curve banbe 📈", padL + 4, h / 2);
    return;
  }

  // area
  const grad = cctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(225,29,72,0.18)");
  grad.addColorStop(1, "rgba(225,29,72,0.02)");
  cctx.beginPath();
  cctx.moveTo(px(pts[0].ts), py(pts[0].balance));
  for (let i = 1; i < pts.length; i++) cctx.lineTo(px(pts[i].ts), py(pts[i].balance));
  cctx.lineTo(px(last.ts), h - padB);
  cctx.lineTo(px(pts[0].ts), h - padB);
  cctx.closePath();
  cctx.fillStyle = grad;
  cctx.fill();

  // line
  cctx.beginPath();
  cctx.moveTo(px(pts[0].ts), py(pts[0].balance));
  for (let i = 1; i < pts.length; i++) cctx.lineTo(px(pts[i].ts), py(pts[i].balance));
  cctx.strokeStyle = "#e11d48";
  cctx.lineWidth = 2.2;
  cctx.lineJoin = "round";
  cctx.stroke();

  // glowing head dot
  cctx.beginPath();
  cctx.arc(px(last.ts), py(last.balance), 4, 0, Math.PI * 2);
  cctx.fillStyle = "#e11d48";
  cctx.shadowColor = "rgba(225,29,72,0.8)";
  cctx.shadowBlur = 12;
  cctx.fill();
  cctx.shadowBlur = 0;

  // axis labels
  cctx.fillStyle = "rgba(139,130,146,0.95)";
  cctx.font = "10px system-ui";
  cctx.fillText("start", padL, h - 2);
  cctx.fillText("$" + maxB.toFixed(2), w - padR + 6, padT + 8);
}

/* -------------------------------- top ads ---------------------------------- */
function renderTopAds() {
  const wrap = $("#topads");
  const rows = Object.values(S.adStats).sort((a, b) => b.revenue - a.revenue);
  if (!rows.length) return;
  const maxR = Math.max(...rows.map((r) => r.revenue));
  wrap.innerHTML = rows.map((r) => `
    <div class="ta">
      <span class="em">${r.emoji || "🎯"}</span>
      <span class="br">${r.brand}</span>
      <span class="ts"><i style="width:${(r.revenue / maxR) * 100}%"></i></span>
      <span class="rv">${money(r.revenue)}<span class="ct"> · ${r.count}×</span></span>
    </div>`).join("");
}

/* ---------------------------- celebration bits ------------------------------ */
function floatCash(amount) {
  const card = document.querySelector(".card.balance") || document.querySelector(".bcard");
  if (!card) return;
  const p = document.createElement("span");
  p.className = "bcash";
  p.textContent = "+" + money(amount);
  p.style.setProperty("--drift", (Math.random() * 44 - 22).toFixed(0) + "px");
  p.style.top = (34 + Math.random() * 22).toFixed(0) + "px";
  card.appendChild(p);
  setTimeout(() => p.remove(), 1400);
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "tmsg";
  t.textContent = msg;
  $("#toast").appendChild(t);
  setTimeout(() => t.classList.add("out"), 2600);
  setTimeout(() => t.remove(), 3100);
}

function checkMilestones() {
  for (const m of MILESTONES) {
    if (S.balance >= m && !localStorage.getItem(milestoneKey(m))) {
      localStorage.setItem(milestoneKey(m), "1");
      toast("🎉 Milestone: $" + m.toFixed(2) + " earned!");
    }
  }
}

/* --------------------------------- SSE ------------------------------------ */
/* Reconnectable: connectSSE() is called again after login/logout so the
   stream follows the active ledger identity (account ↔ device). */
let es = null;

function connectSSE() {
  if (es) { try { es.close(); } catch (e) { /* ignore */ } }
  const stream = new EventSource("/api/stream?userId=" + encodeURIComponent(VIEW_UID));
  es = stream;
  const isMe = (ev) => !ev.userId || ev.userId === VIEW_UID;

  function setConn(state, text) {
    const pill = $(".live-pill");
    pill.classList.remove("on", "off");
    pill.classList.add(state);
    $("#connText").textContent = text;
  }

  stream.addEventListener("open", () => setConn("on", "live · sse"));
  stream.addEventListener("error", () => setConn("off", "reconnecting…"));

  stream.addEventListener("snapshot", (e) => {
    try {
      const s = JSON.parse(e.data);
      S.balance = s.balance || 0;
      S.clicks = s.clicks || 0;
      S.impressions = s.impressions || 0;
      S.waitedSeconds = s.waitedSeconds || 0;
      S.sessions = s.sessions || 0;
      S.platformCounts = s.platformCounts || {};
      S.history = Array.isArray(s.history) ? s.history : [];
      S.adStats = {};
      if (Array.isArray(s.topAds)) {
        for (const a of s.topAds) S.adStats[a.adId] = a;
      }
      if (!shown.balance) shown.balance = S.balance; // no count-up on first paint
      renderStats(); renderTopAds(); checkMilestones(); drawSpark(); drawCumulus();
    } catch (err) { /* ignore */ }
  });

  /* REAL money moment: a verified CTA click lands on the ledger */
  stream.addEventListener("click", (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (!isMe(ev)) return;
      S.balance = ev.balance;
      S.clicks = ev.clicks;
      S.platformCounts[ev.platform] = (S.platformCounts[ev.platform] || 0) + 1;
      S.stamps.push(Date.now());
      if (ev.ad && ev.ad.id) {
        const st = S.adStats[ev.ad.id] || (S.adStats[ev.ad.id] = { adId: ev.ad.id, brand: ev.ad.brand, emoji: ev.ad.emoji, clicks: 0, revenue: 0 });
        st.clicks = (st.clicks || 0) + 1;
        st.revenue = Math.round((st.revenue + ev.revenue * ev.share * 2) * 10000) / 10000;
      }
      pushFeed(ev);
      floatCash(ev.userCut);
      toast("💸 Verified click · +" + money(ev.userCut) + " to " + (ev.ad && ev.ad.brand));
      checkMilestones();
      renderStats(); renderTopAds(); drawSpark(); drawCumulus();
    } catch (err) { /* ignore */ }
  });

  stream.addEventListener("impression", (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (!isMe(ev)) return;
      S.balance = ev.balance;
      S.impressions = ev.impressions;
      S.platformCounts[ev.platform] = (S.platformCounts[ev.platform] || 0) + 1;
      S.stamps.push(Date.now());
      S.history.push({ ts: ev.ts || Date.now(), balance: ev.balance });
      if (S.history.length > 300) S.history.shift();
      if (ev.ad && ev.ad.id && ev.bid != null) {
        const st = S.adStats[ev.ad.id] || (S.adStats[ev.ad.id] = { adId: ev.ad.id, brand: ev.ad.brand, emoji: ev.ad.emoji, count: 0, revenue: 0 });
        st.count += 1;
        st.revenue = Math.round((st.revenue + ev.bid) * 10000) / 10000;
      }
      pushFeed(ev);
      floatCash(ev.userCut);
      checkMilestones();
      renderStats(); renderTopAds(); drawSpark(); drawCumulus();
    } catch (err) { /* ignore */ }
  });

  stream.addEventListener("session", (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (!isMe(ev)) return;
      S.sessions = ev.sessions;
      S.waitedSeconds = ev.waitedSeconds;
      S.balance = ev.balance;
      renderStats();
    } catch (err) { /* ignore */ }
  });

  stream.addEventListener("leaderboard", (e) => {
    try { renderLeaderboard(JSON.parse(e.data).top); } catch (err) { /* ignore */ }
  });
}

/* -------------------------------- simulate ---------------------------------- */
$("#simulateBtn").addEventListener("click", async () => {
  const btn = $("#simulateBtn");
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "⚡ bumping…";
  try {
    await fetch("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: VIEW_UID, platform: "dashboard-demo" })
    });
  } catch (e) { /* ignore */ }
  setTimeout(() => { btn.disabled = false; btn.textContent = label; }, 500);
});

/* ----------------------------- account (login) ------------------------------- */
const AMODAL = $("#authModal");

$("#acctChip").addEventListener("click", async () => {
  try {
    const me = await (await fetch("/api/auth/me")).json();
    if (me && me.loggedIn) {
      if (confirm("@" + me.username + " theke logout korbe?")) {
        await fetch("/api/auth/logout", { method: "POST" });
        location.reload();
      }
      return;
    }
  } catch (e) { /* fall through to modal */ }
  AMODAL.hidden = false;
  $("#mUser").focus();
});

$("#authClose").addEventListener("click", () => { AMODAL.hidden = true; });
AMODAL.addEventListener("click", (e) => { if (e.target === AMODAL) AMODAL.hidden = true; });

async function submitModal(kind) {
  const btn = kind === "register" ? $("#mReg") : $("#mLogin");
  const other = kind === "register" ? $("#mLogin") : $("#mReg");
  btn.disabled = other.disabled = true;
  $("#mMsg").textContent = "…backend er sathe jachchi";
  try {
    const res = await fetch("/api/auth/" + kind, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("#mUser").value, password: $("#mPass").value, mergeUid: uid })
    });
    const out = await res.json();
    if (res.ok && out.ok) {
      $("#mMsg").textContent = "✓ @" + out.username + " — reloading…";
      // merge this browser's device ledger into the account, then reload
      setTimeout(() => location.reload(), 550);
      return;
    }
    $("#mMsg").textContent = "✕ " + (out.error || "failed");
  } catch (e) {
    $("#mMsg").textContent = "✕ backend offline";
  }
  btn.disabled = other.disabled = false;
}

$("#mLogin").addEventListener("click", () => submitModal("login"));
$("#mReg").addEventListener("click", () => submitModal("register"));
$("#mPass").addEventListener("keydown", (e) => { if (e.key === "Enter") submitModal("login"); });

async function bootAccount() {
  try {
    const me = await (await fetch("/api/auth/me")).json();
    if (me && me.loggedIn) {
      VIEW_UID = me.userId;
      const chip = $("#acctChip");
      chip.classList.add("authed");
      chip.title = "Ledger linked to @" + me.username + " — click to logout";
      $("#acctLabel").textContent = "@" + me.username;
    }
  } catch (e) { /* offline — device view */ }
  connectSSE();
}

window.addEventListener("resize", () => { drawSpark(); drawCumulus(); });
setInterval(drawSpark, 60000);
// "time waited" feels alive — re-render every second
setInterval(() => {
  const el = $("#waited");
  if (el) el.textContent = fmtSecs(Math.floor(S.waitedSeconds)) + (S.waitedSeconds ? " ⏱" : "");
}, 1000);
renderStats();
drawSpark();
drawCumulus();
bootAccount();
