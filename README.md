# WaitEarn — real earning browser extension (ChatWait-style) 🧡

> **Ki eta?** Jokhon AI (ChatGPT / Claude / Gemini / DeepSeek...) reply generate korche,
> tokhon chat er pasa e ekta **real sponsored offer card** dekha jay. Card er CTA te
> click korle **real click** ledger e record hoy — prottek verified click er
> **50% (tumi set korte parba)** user er balance e jay. Kono mock money nai:
> balance = operator (tumi) asole koto taka owe korcho, seta.

⚠️ **Real notes**: card jeta dekhay sheta operator er offer inventory theke ase
(affiliate / sponsor / referral link — tumi `/admin` e boshao). Seed offers real
brand homepage e jay, kintu **paya tabe hobe jokhon tumi nijer affiliate tracking
URL boshabei** (Amazon Associates, Impact, Digistore24, CJ, direct sponsors...).
Not affiliated with any AI platform or brand.

---

## How REAL money flows (v0.4)

```
operator adds real offer (brand + affiliate URL + payout per click)  in  /admin
        │  saved to server/data/ads.json
        ▼
extension pulls offers from  GET /api/ads  → card shows while AI thinks
        │  user CLICKS the CTA (real intent, real new tab to the real URL)
        ▼
content script → background.js →  POST /api/events  { kind:"click" }
        │  server verifies + de-dupes (15 min window per user+offer)
        ▼
user ledger +  user_share × payout  (default 50%)   ·   SSE → live dashboard
        ▼
conversions/report land in YOUR affiliate account → pay users from the ledger
```

- Impressions = **attention stats only** (feed, sparkline, platform heatmap) — $0.
- Clicks = **REAL ledger events** — the only way balance moves.
- Ledger lives on the **server** (`server/data/db.json`) — popup/dashboard read
  server truth. Browser balance field is legacy-compatible but no longer accrues.

## What it does

- Detects "AI is generating" and shows the offer card on 12 platforms:
  **ChatGPT, Claude, Gemini, DeepSeek, Grok (+x.com/i/grok), Copilot, Mistral,
  Perplexity, Kimi (moonshot.cn), Qwen (tongyi), Meta AI, Character.AI**
- CTA click opens the **real destination URL** in a new tab and reports a
  `waitearn:click` → backend credit (de-duped per user+offer per 15 min)
- Card never touches the chat DOM (same privacy stance as the original)
- 5s continuous visible display = 1 qualified impression (stats only)
- Live dashboard + **operator admin panel**, orange/white theme everywhere

## Files

```
chatwait-clone/
├── manifest.json        MV3 (content scripts + popup + SW, orange badge)
├── background.js        event queue → POST /api/events, offer restock, badge
├── content/
│   ├── main.js          "AI is generating" detection (12 adapters + generic)
│   ├── card.js          REAL offer engine: server queue, CTA opens ad.url,
│   │                    click reporting, fallback local pool
│   └── card.css         card styles (orange)
├── popup/               balance (server ledger) + stats + backend status
├── server/
│   ├── server.js        v0.4: ledger, CLICK credit + dedupe, admin API, SSE
│   ├── public/
│   │   ├── dashboard.html/css/js   live dashboard (orange theme)
│   │   └── admin.html             operator panel at /admin
│   └── data/
│       ├── ads.json     REAL offer inventory (operator-managed)
│       └── db.json      users, ledger, clickLog, sessions (auto)
└── demo/
    └── demo.html        no-install demo (same card engine, fake chat)
```

## Run

```
node server/server.js
```

- App/dashboard → **http://localhost:8000**
- Admin panel   → **http://localhost:8000/admin** (key: `waitearn-admin`,
  override with env `WAITEARN_ADMIN` before starting)

### Admin panel (/admin)

- Add / edit / delete real offers: brand, emoji, headline, CTA text,
  **destination URL** (apnar affiliate link + id), **payout per click $**, accent
- **Save inventory** → `ads.json` persist + extension next pull e notun offer
- **User share** setting (0.1–0.9, default 0.50 = 50% tumi user ke dibe)
- Ledger overview: devices, revenue owed, paid clicks, live offers

### Go real in 3 steps

1. Register an affiliate/sponsor account (Amazon Associates, Impact, ShareASale,
   Digistore24, Booking partner, direct sponsorship — je kono network).
2. `/admin` e tracking URL + payout boshao → Save inventory.
3. Extension reload koro (`chrome://extensions` → 🔄) — card e real offer,
   real link, real clicks, real ledger.

Also project-dependent legal: disclose sponsored content, follow each AI
platform's terms, and affiliate program policies (some ban extension placement).
Serious launch = real legal review. Eta education-grade production draft.

## API quick reference

| Route | What |
|---|---|
| `GET /api/ads?n=8` | real offer inventory (URL + payout per click) |
| `POST /api/events` | `{userId, events:[{kind:"impression"\|"click", adId, platform, ts}]}` — clicks pay, dedupes reported |
| `POST /api/impressions` | legacy impression-only ingest (stats) |
| `POST /api/session` | `{userId, platform, seconds}` → session/wait stats |
| `GET /api/stream?userId=` | SSE: `snapshot`, `impression`, `click`, `session`, `leaderboard`, `inventory` |
| `GET /api/me?userId=` | user snapshot (balance, clicks, history, topAds) |
| `POST /api/simulate` | synthetic impression (test attention — pays nobody) |
| `GET/PUT /api/admin/overview` · `/api/admin/ads` · `/api/admin/settings` | operator API (header `x-admin-key`) |

## Try it in 10 seconds (no install)

Open `demo/demo.html` in any browser (with `node server/server.js` running for
the full ledger loop; offline holeo card + local fallback log clicks queue e
thakbe). Type anything, press **Send** — card dekhabe generation cholakalin,
CTA click korle real URL khule jabe.

## Install as a real Chrome extension

1. `chrome://extensions` → **Developer mode** ON
2. **Load unpacked** → select this `chatwait-clone` folder
3. Keep the backend running (`node server/server.js`)
4. Chat on ChatGPT etc. — card slides in while the AI thinks
5. **Click the CTA** → real link opens + verified click → `+50% of payout`
   lands in your ledger (dashboard live, badge shows `$` total)

## Detection (unchanged, privacy-first)

- Primary: platform's own **Stop** button (only exists while generating)
- Fallback: last assistant message **text-length growth** (lengths only)
- First ~4s after load ignored; hidden tabs never count (like real ad systems)
- Chat content kokhono pora hoy na, log hoy na, transmit hoy na.

## Roadmap

- Postback-aware ledger: affiliate conversion webhooks → exact per-click EV
- Payout rails (bKash / UPI / Stripe) tied to ledger + payout requests
- Viewport/attention heuristics + fraud scoring on click stream
- Multi-currency display, export CSV ledger, Firefox/Safari ports

## Disclaimer

Real flow, real clicks — kintu **payout satisfies only when real advertisers pay
you**. Seed offers point to plain brand homepages ($0 revenue) until you plug
real affiliate/sponsor URLs. Educational foundation code; production e legal
review + platform ToS compliance lagbe.
