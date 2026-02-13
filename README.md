# ✨ Quicker Ticker: an AI-powered watchlist that explains price moves (Chrome Extension)

A compact Chrome popup watchlist for stocks + ETFs that shows **Today / 7d / 30d** performance, pulls live price + market cap/AUM, and uses an **AI “why did it move?”** assistant to surface only the most relevant, price-moving headlines with source links.

- Live demo video: 
- Prompting doc / notes (optional): 

---

## 🚀 Why this matters

- **Turns noise into signal:** the AI assistant filters down to **2–4** short, high-impact bullets tied to the lookback window.
- **Portfolio context, instantly:** optional shares-based math shows **total value** plus **total P/L** for Today, 7d, and 30d.
- **Responsible AI by design:** strict formatting rules, deduping, character limits, and source links help keep the output scannable and trustworthy.

---

## ✅ What it does

- Add tickers via autocomplete (click to add instantly)
- View **Today / 7d / 30d** performance, current price, and market cap/AUM
- Organize tickers into **movable groups** (reorder tickers and groups)
- Optional **shares** entry per ticker, with totals across the watchlist
- One-click AI recap that explains moves using recent, non-duplicative headlines (with links)

---

## 🧠 AI assistant behavior (built for signal)

- Returns **2–4 bullets** max, **200 characters** per bullet
- Date-first format (ex: `Feb 7, 2026`), no extra headers or fluff
- Prioritizes headlines likely to affect price and avoids same-day/topic duplicates
- Always includes a **source + link**
- Uses only recent inputs (no “hallucinated” news)

---

## 🧰 Tech stack

- **Chrome Extension (Manifest V3)**: popup UI, options/preferences, `chrome.storage` persistence
- **Finnhub API**: quote + fundamentals metadata (user-provided token)
- **AI proxy via Cloudflare (Workers / reverse proxy)**: consistent request routing, API abstraction, and rate-control point
- Simple, responsive UI for fast scanning in a constrained popup surface

---

## 🔐 Privacy & security notes

- No hardcoded API keys in the repo
- Finnhub token is user-supplied via Preferences
- Stores only local watchlist + preferences in `chrome.storage` (no analytics)

---

## 📌 Future ideas

- Add optional “key upcoming dates” for equities (earnings, major events)
- Per-ticker news sentiment snapshot alongside the AI bullets
- Export/import watchlist + groups
- Firefox Support
- Referral links
- Subscriptions for deeper insights or more advanced APIs/metrics
