/* WaitEarn popup — server-backed balance + stats + account login. */

const KEY = "waitearn_state_v1";
const AUTH_KEY = "waitearn_auth";
const $ = (id) => document.getElementById(id);

function fmtSecs(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return h + "h " + m + "m";
  if (m) return m + "m " + (s % 60) + "s";
  return s + "s";
}

function load() {
  return new Promise((res) => {
    try {
      chrome.storage.local.get([KEY], (r) => res((r && r[KEY]) || null));
    } catch (e) {
      res(null);
    }
  });
}

function save(state) {
  try {
    chrome.storage.local.set({ [KEY]: state });
  } catch (e) { /* ignore */ }
}

async function render() {
  let s = await load();
  if (!s) {
    s = { enabled: true, balance: 0, impressions: 0, sessions: 0, dismissed: 0, visibleSeconds: 0 };
  }
  $("balance").textContent = "$" + (s.balance || 0).toFixed(4);
  $("impressions").textContent = s.impressions || 0;
  $("waited").textContent = fmtSecs(s.visibleSeconds || 0);
  $("sessions").textContent = s.sessions || 0;
  $("enabled").checked = s.enabled !== false;
  renderServerRow();
}

/* Server truth: written by background.js when the backend acknowledges events.
   Fresh within 5 minutes = online. The REAL balance + click count live here. */
let latestServer = null;

function renderServerRow() {
  try {
    chrome.storage.local.get(["waitearn_server_balance"], (r) => {
      const sb = r && r["waitearn_server_balance"];
      const dot = $("srvDot"), text = $("srvText"), bal = $("srvBalance");
      if (sb && sb.balance !== undefined && Date.now() - (sb.ts || 0) < 5 * 60 * 1000) {
        dot.classList.add("on"); dot.classList.remove("off");
        text.textContent = "Backend: live · " + (sb.clicks || 0) + " paid clicks";
        bal.textContent = "$" + sb.balance.toFixed(4);
        latestServer = sb;
        $("clicks").textContent = sb.clicks || 0;
        const share = (sb.share != null) ? sb.share : 0.5;
      } else {
        dot.classList.add("off"); dot.classList.remove("on");
        text.textContent = "Backend: offline (node server/server.js)";
        bal.textContent = "—";
        $("clicks").textContent = "—";
      }
    });
  } catch (e) { /* ignore */ }
}

$("enabled").addEventListener("change", async () => {
  const s = (await load()) || {};
  s.enabled = $("enabled").checked;
  save(s);
});

$("reset").addEventListener("click", async () => {
  if (!confirm("Clear balance and all stats?")) return;
  const s = (await load()) || {};
  s.balance = 0;
  s.impressions = 0;
  s.sessions = 0;
  s.dismissed = 0;
  s.visibleSeconds = 0;
  save(s);
  render();
});

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes[KEY] || changes[AUTH_KEY])) render();
  });
} catch (e) { /* ignore */ }

/* -------------------------------- account ----------------------------------- */
function sendBg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        void chrome.runtime.lastError; // swallow closed-port errors
        resolve(resp || {});
      });
    } catch (e) { resolve({ ok: false, error: "extension context lost — reload the extension" }); }
  });
}

function getAuth() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([AUTH_KEY], (g) => resolve((g && g[AUTH_KEY]) || null));
    } catch (e) { resolve(null); }
  });
}

async function renderAuth() {
  const a = await getAuth();
  const logged = !!(a && a.username);
  $("acctLogged").hidden = !logged;
  $("acctForm").hidden = logged;
  if (logged) {
    $("acctName").textContent = "@" + a.username;
    $("acctMsg").textContent = "";
  }
}

function acctBusy(on) {
  $("loginBtn").disabled = on;
  $("regBtn").disabled = on;
}

async function submitAuth(action) {
  const username = $("uName").value.trim();
  const password = $("uPass").value;
  if (!username || !password) {
    $("acctMsg").textContent = "username r password duitai dan";
    return;
  }
  acctBusy(true);
  $("acctMsg").textContent = "…connecting to ledger";
  const out = await sendBg({ type: "waitearn:auth", payload: { action, username, password } });
  acctBusy(false);
  if (out && out.ok) {
    $("uPass").value = "";
    $("acctMsg").textContent = "✓ @" + out.username + " linked · balance $" + (out.balance || 0).toFixed(2) + " (" + (out.clicks || 0) + " clicks)";
    renderServerRow();
    renderAuth();
  } else {
    $("acctMsg").textContent = "✕ " + ((out && out.error) || "failed");
  }
}

$("loginBtn").addEventListener("click", () => submitAuth("login"));
$("regBtn").addEventListener("click", () => submitAuth("register"));
$("uPass").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAuth("login"); });

$("logoutBtn").addEventListener("click", async () => {
  await sendBg({ type: "waitearn:auth-logout" });
  renderAuth();
  renderServerRow();
});

render();
