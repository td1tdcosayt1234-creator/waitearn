/* ============================================================================
   WaitEarn backend (v0.4 — REAL earning mode)
   ----------------------------------------------------------------------------
   The real money path:
   1. The operator (you) adds REAL offers in the admin panel (/admin):
      brand, headline, destination URL (affiliate / sponsor / referral link)
      and the payout per verified click.
   2. The extension serves those real offers while the AI is thinking.
   3. When a user actually CLICKS the CTA, the click is reported and the
      server validates + de-dupes it (15-min window per user+offer).
   4. User earns a share (default 50%) of that click's payout — a real LEDGER.
   5. Conversions/payments land in your affiliate accounts; you pay users
      from the ledger at payout time.

   HONESTY NOTE: no fake money accrues any more. Impressions feed the UI
   (attention stats) but only verified CLICKS move balances.

   Run:  node server/server.js
        app:    http://localhost:8000
        admin:  http://localhost:8000/admin   (key: waitearn-admin default)
   ============================================================================ */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 8000;
const ADMIN_SECRET = process.env.WAITEARN_ADMIN || "waitearn-admin";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const ADS_FILE = path.join(DATA_DIR, "ads.json");

const EVENTS_CAP = 100;
const HISTORY_CAP = 300;
const CLICK_DEDUPE_MS = 15 * 60 * 1000; // one payout per user+offer per 15 min
const MAX_POST = 100_000;

/* ------------------------------- inventory -------------------------------- */
/* Seeded with REAL brand destinations. Plain homepages pay nothing by
   themselves — replace the URLs (via /admin) with your real affiliate /
   sponsor / referral links to turn this into real revenue. */
const SEED_ADS = [
  { id: "duolingo",  brand: "Duolingo",  emoji: "🦉", headline: "Turn waiting time into a streak",      sub: "5 minutes of Spanish while the AI thinks?",  cta: "Try Duolingo",  accent: "#f97316", url: "https://www.duolingo.com",  cpc: 0.55 },
  { id: "notion",    brand: "Notion",    emoji: "🗂️", headline: "Your tidy second brain",               sub: "Free plan for personal use — forever",       cta: "Get Notion",    accent: "#ea580c", url: "https://www.notion.so",     cpc: 0.85 },
  { id: "wise",      brand: "Wise",      emoji: "💸", headline: "Send money at the real exchange rate", sub: "No hidden fees, no markup",                  cta: "Learn more",    accent: "#d97706", url: "https://wise.com",          cpc: 0.90 },
  { id: "grammarly", brand: "Grammarly", emoji: "✏️", headline: "Sound sharp in every reply",           sub: "Write better everywhere you type",           cta: "Add Grammarly", accent: "#f97316", url: "https://www.grammarly.com", cpc: 0.75 },
  { id: "audible",   brand: "Audible",   emoji: "🎧", headline: "One audiobook, on us",                 sub: "30-day free trial, cancel anytime",          cta: "Start free",    accent: "#fb923c", url: "https://www.audible.com",   cpc: 1.20 },
  { id: "framer",    brand: "Framer",    emoji: "🚀", headline: "Design and ship sites in minutes",     sub: "No code needed for your next landing page",  cta: "Try Framer",    accent: "#f59e0b", url: "https://www.framer.com",    cpc: 1.10 }
];

let ads = SEED_ADS.map((a) => ({ ...a }));
try {
  if (fs.existsSync(ADS_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(ADS_FILE, "utf8"));
    if (Array.isArray(parsed) && parsed.length) ads = sanitizeAds(parsed);
  }
} catch (e) {
  console.warn("[ads] load failed, using seed:", e.message);
}
saveAds();
let AD_BY_ID = new Map(ads.map((a) => [a.id, a]));

function sanitizeAds(list) {
  return (Array.isArray(list) ? list : []).filter(Boolean).map((a, i) => ({
    id: String(a.id || "offer-" + (i + 1)).slice(0, 40),
    brand: String(a.brand || "Offer").slice(0, 48),
    emoji: String(a.emoji || "🎯").slice(0, 8),
    headline: String(a.headline || "").slice(0, 120),
    sub: String(a.sub || "").slice(0, 160),
    cta: String(a.cta || "Open").slice(0, 32),
    accent: /^#[0-9a-fA-F]{3,8}$/.test(String(a.accent || "")) ? a.accent : "#f97316",
    url: /^(https?:\/\/)/i.test(String(a.url || "")) ? String(a.url) : "",
    cpc: Math.max(0, Math.min(25, Number(a.cpc) || 0))
  }));
}

function saveAds() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ADS_FILE, JSON.stringify(ads, null, 2));
  } catch (e) {
    console.warn("[ads] save failed:", e.message);
  }
}

/* --------------------------------- storage -------------------------------- */
let db = { users: {}, settings: { userShare: 0.5 }, adStats: {} };
let saveTimer = null;

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      db = { ...db, ...parsed };
    }
  } catch (e) {
    console.warn("[db] could not load, starting fresh:", e.message);
  }
  if (!db.users || typeof db.users !== "object") db.users = {};
  if (!db.settings || typeof db.settings !== "object") db.settings = {};
  if (typeof db.settings.userShare !== "number") db.settings.userShare = 0.5;
  if (!db.adStats || typeof db.adStats !== "object") db.adStats = {};
}

function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(db));
    } catch (e) {
      console.warn("[db] save failed:", e.message);
    }
  }, 400);
}

function userFor(userId) {
  if (!db.users[userId]) {
    db.users[userId] = {
      id: userId,
      createdAt: Date.now(),
      balance: 0,          // REAL click-earnings ledger
      clicks: 0,
      impressions: 0,      // attention stats (no money attached)
      sessions: 0,
      waitedSeconds: 0,
      platformCounts: {},
      clickLog: {},        // adId -> last paid click ts (dedupe)
      events: [],
      history: []
    };
  }
  // normalize legacy records (created before the real-ledger schema)
  const u = db.users[userId];
  u.balance = Number(u.balance) || 0;
  u.clicks = Number(u.clicks) || 0;
  u.impressions = Number(u.impressions) || 0;
  u.sessions = Number(u.sessions) || 0;
  u.waitedSeconds = Number(u.waitedSeconds) || 0;
  u.platformCounts = (u.platformCounts && typeof u.platformCounts === "object") ? u.platformCounts : {};
  u.clickLog = (u.clickLog && typeof u.clickLog === "object") ? u.clickLog : {};
  u.events = Array.isArray(u.events) ? u.events : [];
  u.history = Array.isArray(u.history) ? u.history : [];
  return u;
}

const round4 = (n) => Math.round(n * 10000) / 10000;

function snapshot(u) {
  const topAds = Object.entries(db.adStats)
    .map(([adId, s]) => ({ adId, brand: s.brand, emoji: s.emoji, clicks: s.clicks || 0, count: s.count || 0, revenue: s.revenue }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 8);

  let totalClickRevenue = 0, totalClicks = 0, users = 0;
  for (const u2 of Object.values(db.users)) {
    users++;
    totalClickRevenue += u2.balance || 0;
    totalClicks += u2.clicks || 0;
  }

  return {
    userId: u.id,
    balance: u.balance,
    clicks: u.clicks,
    impressions: u.impressions,
    sessions: u.sessions,
    waitedSeconds: u.waitedSeconds,
    platformCounts: u.platformCounts || {},
    history: u.history || [],
    recent: (u.events || []).slice(0, 12),
    topAds,
    totals: { users, totalClicks, totalClickRevenue: round4(totalClickRevenue) },
    settings: { userShare: db.settings.userShare },
    serverTime: Date.now()
  };
}

/* --------------------------------- SSE hub -------------------------------- */
const streams = new Set();

function send(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { /* dropped */ }
}

function broadcast(event, data) {
  for (const s of streams) {
    if (data && data.userId && s.userId && data.userId !== s.userId) continue;
    send(s.res, event, data);
  }
}

function publishLedger() {
  const top = Object.values(db.users)
    .filter((u) => u.clicks || u.balance)
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 5)
    .map((u) => ({ userId: u.id, short: u.id.slice(0, 8), balance: u.balance, clicks: u.clicks }));
  broadcast("leaderboard", { top, serverTime: Date.now() });
}

/* ---------------------------- money: click credit ------------------------- */
function creditClick(userId, adId, platform) {
  const ad = AD_BY_ID.get(adId);
  if (!ad || !ad.url) return { reason: "ad-not-payable" };
  const u = userFor(userId);

  const lastPaid = (u.clickLog || {})[adId] || 0;
  if (Date.now() - lastPaid < CLICK_DEDUPE_MS) return { reason: "dupe" };

  const revenue = ad.cpc;
  const userCut = round4(revenue * db.settings.userShare);

  u.balance = round4(u.balance + userCut);
  u.clicks += 1;
  u.clickLog[adId] = Date.now();
  u.platformCounts[platform] = (u.platformCounts[platform] || 0) + 1;
  u.history.push({ ts: Date.now(), balance: u.balance });
  if (u.history.length > HISTORY_CAP) u.history.shift();

  u.events.unshift({
    type: "click",
    adId: ad.id,
    brand: ad.brand,
    emoji: ad.emoji,
    platform,
    revenue,
    userCut,
    ts: Date.now()
  });
  u.events.length = Math.min(u.events.length, EVENTS_CAP);

  db.adStats[ad.id] = db.adStats[ad.id] || { brand: ad.brand, emoji: ad.emoji, count: 0, clicks: 0, revenue: 0 };
  const stat = db.adStats[ad.id];
  stat.clicks = (stat.clicks || 0) + 1;
  stat.count = stat.clicks;
  stat.revenue = round4(stat.revenue + revenue);
  saveDb();

  const payload = {
    type: "click",
    userId,
    platform,
    revenue,
    userCut,
    balance: u.balance,
    clicks: u.clicks,
    ad: { id: ad.id, brand: ad.brand, emoji: ad.emoji, headline: ad.headline, accent: ad.accent },
    share: db.settings.userShare,
    ts: Date.now()
  };
  broadcast("click", payload);
  publishLedger();
  return { reason: "credited", payload };
}

/* ------------------------- attention: impression -------------------------- */
function creditImpression(userId, adId, platform, opts = {}) {
  const ad = AD_BY_ID.get(adId);
  if (!ad) return { reason: "ad-not-found" };
  const u = userFor(userId);
  u.impressions += 1;
  u.platformCounts[platform] = (u.platformCounts[platform] || 0) + 1;
  u.events.unshift({
    type: "impression",
    adId: ad.id,
    brand: ad.brand,
    emoji: ad.emoji,
    platform,
    ts: Date.now(),
    synthetic: !!opts.synthetic
  });
  u.events.length = Math.min(u.events.length, EVENTS_CAP);
  saveDb();

  const payload = {
    type: "impression",
    userId,
    platform,
    balance: u.balance,
    clicks: u.clicks,
    impressions: u.impressions,
    ad: { id: ad.id, brand: ad.brand, emoji: ad.emoji, headline: ad.headline, accent: ad.accent },
    synthetic: !!opts.synthetic,
    ts: Date.now()
  };
  broadcast("impression", payload);
  return { reason: "ok", payload };
}

/* --------------------------------- helpers -------------------------------- */
function json(res, code, body) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_POST) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function validId(x) { return /^[a-zA-Z0-9-]{6,64}$/.test(String(x || "")); }

function adminOk(req) {
  return (req.headers["x-admin-key"] || "") === ADMIN_SECRET;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "dashboard.html" : (urlPath === "/admin" ? "admin.html" : urlPath.replace(/^\/+/, ""));
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 — not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(fs.readFileSync(file));
}

/* ---------------------------------- API ----------------------------------- */
async function handleApi(req, res, url) {
  const route = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-admin-key"
    });
    return res.end();
  }

  if (route === "/api/health") {
    return json(res, 200, { ok: true, name: "waitearn-backend", offers: ads.length, uptime: process.uptime() });
  }

  /* -------- public inventory (extension pulls its cards from here) -------- */
  if (route === "/api/ads") {
    const n = Math.min(parseInt(url.searchParams.get("n") || "6", 10) || 6, 20);
    const shuffled = ads.slice().sort(() => Math.random() - 0.5).slice(0, n);
    return json(res, 200, { ads: shuffled });
  }

  if (route === "/api/me") {
    const userId = url.searchParams.get("userId");
    if (!validId(userId)) return json(res, 400, { error: "userId required" });
    return json(res, 200, snapshot(userFor(userId)));
  }

  /* ----------------------------- SSE stream ------------------------------- */
  if (route === "/api/stream") {
    const userId = url.searchParams.get("userId") || "anon";
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });
    res.flushHeaders?.();
    res.write(`retry: 3000\n\n`);
    const stream = { res, userId };
    streams.add(stream);
    send(res, "snapshot", snapshot(userFor(userId)));
    publishLedger();
    req.on("close", () => streams.delete(stream));
    return;
  }

  /* --------------- both ledger paths in one ingest endpoint --------------- */
  if (route === "/api/events" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const userId = String(body.userId || "");
    if (!validId(userId)) return json(res, 400, { error: "userId invalid" });
    const events = Array.isArray(body.events) ? body.events.slice(0, 100) : [];
    const out = { clickCredits: 0, clickDupes: 0, unpaid: 0, impressions: 0, skipped: 0, lastClick: null };
    for (const ev of events) {
      const platform = String(ev.platform || "unknown").slice(0, 64);
      if (ev.kind === "click") {
        const r = creditClick(userId, String(ev.adId || ""), platform);
        if (r.reason === "credited") { out.clickCredits++; out.lastClick = r.payload; }
        else if (r.reason === "dupe") out.clickDupes++;
        else out.unpaid++;
      } else if (ev.kind === "impression") {
        if (creditImpression(userId, String(ev.adId || ""), platform).reason === "ok") out.impressions++;
        else out.skipped++;
      } else out.skipped++;
    }
    const u = userFor(userId);
    return json(res, 200, {
      ...out,
      balance: u.balance,
      clicks: u.clicks,
      serverTime: Date.now()
    });
  }

  /* legacy impression-only endpoint (dashboard simulate etc.) */
  if (route === "/api/impressions" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const userId = String(body.userId || "");
    if (!validId(userId)) return json(res, 400, { error: "userId invalid" });
    const events = Array.isArray(body.events) ? body.events.slice(0, 100) : [];
    let ok = 0, skipped = 0;
    for (const ev of events) {
      if (creditImpression(userId, String(ev.adId || ""), String(ev.platform || "unknown")).reason === "ok") ok++;
      else skipped++;
    }
    const u = userFor(userId);
    return json(res, 200, { credited: ok, skipped, balance: u.balance, clicks: u.clicks, serverTime: Date.now() });
  }

  if (route === "/api/session" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const userId = String(body.userId || "");
    if (!validId(userId)) return json(res, 400, { error: "userId invalid" });
    const u = userFor(userId);
    u.sessions += 1;
    u.waitedSeconds += Math.max(0, Number(body.seconds) || 0);
    saveDb();
    const payload = { type: "session", userId, sessions: u.sessions, waitedSeconds: u.waitedSeconds, balance: u.balance, ts: Date.now() };
    broadcast("session", payload);
    return json(res, 200, payload);
  }

  if (route === "/api/simulate" && req.method === "POST") {
    // pipeline testing only — pays nobody anything (no $)
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const userId = String(body.userId || "");
    if (!validId(userId)) return json(res, 400, { error: "userId invalid" });
    const ad = ads[Math.floor(Math.random() * ads.length)];
    const r = creditImpression(userId, ad.id, body.platform || "dashboard-demo", { synthetic: true });
    return json(res, 200, { ok: true, event: r.payload });
  }

  /* ------------------------------ admin API ------------------------------- */
  if (route.startsWith("/api/admin/")) {
    if (!adminOk(req)) return json(res, 401, { error: "unauthorized" });

    if (route === "/api/admin/overview" && req.method === "GET") {
      const totals = { users: Object.keys(db.users).length, totalClicks: 0, totalClickRevenue: 0 };
      for (const u2 of Object.values(db.users)) {
        totals.totalClicks += u2.clicks || 0;
        totals.totalClickRevenue += u2.balance || 0;
      }
      totals.totalClickRevenue = round4(totals.totalClickRevenue);
      return json(res, 200, {
        ads,
        settings: db.settings,
        totals,
        adStats: Object.entries(db.adStats)
          .map(([id, s]) => ({ adId: id, ...s }))
          .sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
      });
    }
    if (route === "/api/admin/ads" && (req.method === "PUT" || req.method === "POST")) {
      let body;
      try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
      if (!Array.isArray(body.ads)) return json(res, 400, { error: "ads[] required" });
      ads = sanitizeAds(body.ads);
      saveAds();
      AD_BY_ID = new Map(ads.map((a) => [a.id, a]));
      broadcast("inventory", { count: ads.length, ts: Date.now() });
      return json(res, 200, { ok: true, count: ads.length });
    }
    if (route === "/api/admin/settings" && req.method === "POST") {
      let body;
      try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
      const share = Number(body.userShare);
      if (!Number.isFinite(share) || share < 0.1 || share > 0.9) {
        return json(res, 400, { error: "userShare must be 0.1–0.9" });
      }
      db.settings.userShare = round4(share);
      saveDb();
      return json(res, 200, { ok: true, settings: db.settings });
    }
    return json(res, 404, { error: "admin route not found" });
  }

  return json(res, 404, { error: "route not found" });
}

/* ---------------------------------- server -------------------------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method === "GET") return serveStatic(res, url.pathname);
    res.writeHead(405, { "Content-Type": "text/plain" });
    return res.end("405 — method not allowed");
  } catch (e) {
    console.error("[server]", e);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  }
});

setInterval(() => {
  for (const s of streams) {
    try { s.res.write(":ping\n\n"); } catch (e) { streams.delete(s); }
  }
}, 15000);

loadDb();

function shutdown() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
    saveAds();
    console.log("[saved] db + inventory on shutdown");
  } catch (e) { /* best effort */ }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  WaitEarn backend  →  http://localhost:${PORT}`);
  console.log(`  Admin panel       →  http://localhost:${PORT}/admin  (key: default "waitearn-admin")`);
  console.log(`  Offers in inventory: ${ads.length}\n`);
});
