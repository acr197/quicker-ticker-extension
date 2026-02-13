/* Quicker Ticker popup */
const $ = (sel) => document.querySelector(sel);

const STORE_DEFAULTS = {
  finnhubToken: "",
  tickers: [],
  sortKey: "manual",
  sortDir: "asc",
  columnOrder: null,

  // Grouping
  groupsEnabled: false,
  groupAveraging: true,
  groups: [
    { id: "g1", name: "Group 1" },
    { id: "g2", name: "Group 2" }
  ],
  groupTickers: { g1: [], g2: [] },

  // Portfolio value
  personalValueEnabled: false,
  sharesBySymbol: {},

  // AI
  aiEnabled: true,
  aiProxyUrl: "https://quicker-ticker-ai-proxy.acr197.workers.dev/summarize",
  aiPromptTemplate: "",

  // Fast startup snapshot
  lastSnapshot: {} // symbol -> row-like object
};

const DEFAULT_AI_PROMPT_TEMPLATE = [
  "You write concise, date-led driver bullets for a stock/ETF watchlist popup.",
  "Use ONLY the inputs below. Do not guess or use outside news.",
  "",
  "Output rules:",
  "- Output 2 to 4 lines total. No headings, no labels, no extra blank lines.",
  "- Each line starts with a date formatted like \"Feb 7, 2026\".",
  "- Do NOT include any leading bullet characters (the UI adds bullets).",
  "- Max 200 characters per line.",
  "- Do NOT repeat ticker/name/price/market cap or the raw performance numbers.",
  "",
  "Content rules:",
  "- Focus on what may have driven the Today, 7d, and 30d moves using the headlines only.",
  "- Prefer diverse dates and topics; avoid repeating the same story.",
  "- Cite sources as \"Source #N\" referencing the numbered headline list.",
  "- For equities: you may use ONE optional forward-looking line if an upcoming earnings date is provided.",
  "- For ETFs: skip forward-looking unless a split event is provided.",
  "",
  "Inputs:",
  "As of: {{AS_OF}}",
  "Asset type: {{ASSET_TYPE}}",
  "Performance: Today {{DAY_PCT}}, 7d {{WEEK_PCT}}, 30d {{MONTH_PCT}}",
  "",
  "Headlines (last 30d, numbered):",
  "{{HEADLINES}}",
  "",
  "Upcoming events (if any):",
  "{{EARNINGS}}",
].join("\n");

const COLS_ALL = [
  { key: "symbol", label: "Symbol", cls: "col-sym" },
  { key: "name", label: "Name", cls: "col-name" },
  { key: "dayPct", label: "Today", cls: "col-day center" },
  { key: "weekPct", label: "7d", cls: "col-week center" },
  { key: "monthPct", label: "30d", cls: "col-month center" },
  { key: "price", label: "Price", cls: "col-price" },
  { key: "mcap", label: "Mkt Cap/AUM", cls: "col-mcap" },
  { key: "shares", label: "Shares", cls: "col-shares" },
  { key: "value", label: "Value", cls: "col-value" }
];

const ACTIONS_COL = { key: "actions", label: "", cls: "col-act" };

const DEFAULT_COL_ORDER_BASE = ["symbol", "name", "dayPct", "weekPct", "monthPct", "price", "mcap"];

let CACHE = {}; // persisted in storage
let LAST_ROWS = [];
let RENDER_SEQ = 0;
let STATUS_STICKY = null;
let TOAST_TIMER = null;

function safeUpper(s) {
  return (s || "").toString();
}

function fmtPct(n, digits = 2) {
  if (!Number.isFinite(n)) return "n/a";
  const sign = n > 0 ? "+" : "";
  return sign + n.toFixed(digits) + "%";
}

function fmtMoney(n) {
  if (!Number.isFinite(n)) return "n/a";
  if (Math.abs(n) >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
  if (Math.abs(n) >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  return "$" + n.toFixed(2);
}

function fmtShares(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "";
  const abs = Math.abs(n);
  const dec = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  const s = n.toFixed(dec).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  return s;
}


function fmtPrice(n) {
  if (!Number.isFinite(n)) return "n/a";
  return "$" + n.toFixed(2);
}

function pctClass(n) {
  if (!Number.isFinite(n)) return "";
  if (n > 0) return "good";
  if (n < 0) return "bad";
  return "";
}

function showToast(msg, ms = 1200) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(TOAST_TIMER);
  TOAST_TIMER = setTimeout(() => el.classList.add("hidden"), ms);
}

function setStatus(msg, { sticky = false } = {}) {
  if (sticky) STATUS_STICKY = msg;
  const el = $("#status");
  el.textContent = sticky ? msg : (STATUS_STICKY || msg);
}

function clearStickyStatus() {
  STATUS_STICKY = null;
  setStatus("Done");
}

async function getStore() {
  const s = await chrome.storage.local.get(null);
  const merged = { ...STORE_DEFAULTS, ...s };
  if (!merged.aiPromptTemplate) merged.aiPromptTemplate = DEFAULT_AI_PROMPT_TEMPLATE;
  return merged;
}

async function setStore(patch) {
  await chrome.storage.local.set(patch);
}

function visibleCols(store) {
  return COLS_ALL.filter((c) => store.personalValueEnabled || (c.key !== "shares" && c.key !== "value"));
}

function normalizeColumnOrder(order, store) {
  const allowed = visibleCols(store).map((c) => c.key);
  const set = new Set(allowed);

  let out = Array.isArray(order) ? order.filter((k) => set.has(k)) : [];
  for (const k of allowed) if (!out.includes(k)) out.push(k);
  return out;
}

function defaultColumnOrder(store) {
  const base = [...DEFAULT_COL_ORDER_BASE];
  if (store.personalValueEnabled) base.push("shares", "value");
  return normalizeColumnOrder(base, store);
}

function clearSuggest() {
  $("#suggest").classList.add("hidden");
  $("#suggest").innerHTML = "";
}

let AI_ABORT = null;
let AI_LAST_STORE = null;
let AI_LAST_PAYLOAD = null;
let AI_LAST_SYMBOL = null;

function setAiLoading(isLoading, label) {
  const load = $("#aiLoad");
  const cancel = $("#aiCancel");
  const run = $("#aiRun");
  const ok = $("#aiOk");

  if (label) $("#aiLoadText").textContent = label;
  load.style.display = isLoading ? "flex" : "none";
  cancel.style.display = isLoading ? "inline-flex" : "none";
  run.disabled = isLoading;
  ok.disabled = isLoading;
}

function setAiBodyMessage(msg) {
  const body = $("#aiBody");
  body.innerHTML = "";
  body.textContent = msg || "";
}

function openAiModal(title, bodyText) {
  $("#aiTitle").textContent = title;
  setAiBodyMessage(bodyText || "");
  $("#aiModal").classList.remove("hidden");
}

function closeAiModal() {
  try { if (AI_ABORT) AI_ABORT.abort(); } catch (e) {}
  AI_ABORT = null;
  setAiLoading(false);
  $("#aiModal").classList.add("hidden");
}

function todayIso() {
  const d = new Date();
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

const MONTHS3 = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtDatePrettyFromIso(iso) {
  if (!iso || typeof iso !== "string") return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return "";
  const mon = MONTHS3[Math.max(1, Math.min(12, mo)) - 1];
  return `${mon} ${d}, ${y}`;
}

function stripLeadingBullet(line) {
  return (line || "").replace(/^\s*[•\-*\u2022]+\s*/, "").trim();
}

function postProcessAiLines(rawText, asOfPretty) {
  const lines = String(rawText || "")
    .split("\n")
    .map((s) => stripLeadingBullet(s))
    .map((s) => s.replace(/^\[(.*?)\]\s*/, "$1 ").trim())
    .filter((s) => s.length);

  const out = [];
  for (const ln of lines) {
    let s = ln;
    // Convert leading ISO dates to pretty dates
    s = s.replace(/^(\d{4}-\d{2}-\d{2})\b/, (m, iso) => fmtDatePrettyFromIso(iso) || m);
    // Ensure date is first token
    if (!/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/.test(s)) {
      s = `${asOfPretty} ${s}`.trim();
    }
    if (s.length > 200) s = s.slice(0, 200).trim();
    if (s) out.push(s);
    if (out.length >= 4) break;
  }
  return out;
}

function renderAiLines(lines, newsList) {
  const body = $("#aiBody");
  body.innerHTML = "";

  if (!Array.isArray(lines) || !lines.length) {
    body.textContent = "No summary returned.";
    return;
  }

  for (const line of lines) {
    const m = String(line).match(/Source\s*#(\d+)/i);
    const idx = m ? Number(m[1]) : NaN;
    const srcItem = Number.isFinite(idx) && Array.isArray(newsList) ? newsList[idx - 1] : null;

    const clean = String(line)
      .replace(/\s*\(?Source\s*#\d+\)?\s*/ig, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    const row = document.createElement("div");
    row.className = "aiLine";

    const bullet = document.createElement("div");
    bullet.className = "aiBullet";
    bullet.textContent = "•";

    const text = document.createElement("div");
    text.className = "aiText";
    text.textContent = clean;

    row.appendChild(bullet);
    row.appendChild(text);

    if (srcItem && srcItem.url) {
      const a = document.createElement("a");
      a.className = "aiSrc";
      a.href = srcItem.url;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.textContent = `${(srcItem.source || "Source").trim()} ↗`;
      row.appendChild(a);
    }

    body.appendChild(row);
  }
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}

function cacheGet(key, ttlMs) {
  const hit = CACHE[key];
  if (!hit) return null;
  const age = Date.now() - Number(hit.fetchedAtMs || 0);
  if (!Number.isFinite(age) || age > ttlMs) return null;
  return hit.value;
}

async function cacheSet(key, value) {
  CACHE[key] = { fetchedAtMs: Date.now(), value };
  await setStore({ cache: CACHE });
}

async function getCached(key, ttlMs, fn) {
  const v = cacheGet(key, ttlMs);
  if (v !== null && v !== undefined) return v;
  const fresh = await fn();
  await cacheSet(key, fresh);
  return fresh;
}

function cacheKey(prefix, symbol) {
  const s = (symbol || "").toString().trim().toUpperCase();
  return `${prefix}:${s}`;
}

async function cachedFetchJson(url, key, ttlMs) {
  return await getCached(key, ttlMs, () => fetchJson(url));
}

async function cachedFetchText(url, key, ttlMs) {
  return await getCached(key, ttlMs, () => fetchText(url));
}

/* ---------- Data sources ---------- */
function finnhubQuoteUrl(symbol, token) {
  return `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`;
}

function finnhubProfileUrl(symbol, token) {
  return `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`;
}

function finnhubEtfProfileUrl(symbol, token) {
  return `https://finnhub.io/api/v1/etf/profile?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`;
}

function finnhubSearchUrl(q, token) {
  return `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${encodeURIComponent(token)}`;
}

function finnhubCompanyNewsUrl(symbol, fromIso, toIso, token) {
  return `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&token=${encodeURIComponent(token)}`;
}

function finnhubEarningsCalUrl(symbol, fromIso, toIso, token) {
  return `https://finnhub.io/api/v1/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&token=${encodeURIComponent(token)}`;
}

function yahooQuoteUrl(symbol) {
  return `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
}

function yahooQuoteSummaryUrl(symbol, modules) {
  return `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${encodeURIComponent(modules)}`;
}

/* --- Stooq for 7d / 30d percent --- */
function stooqDailyUrl(stooqSymbol) {
  return `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&i=d`;
}

function stooqCandidates(symbol) {
  const s = symbol.toLowerCase().trim();
  const out = [];
  // Common U.S. suffixes
  out.push(`${s}.us`);
  out.push(`${s}.us`);
  out.push(`${s}`);
  // ETFs and some tickers might exist without .us
  out.push(`${s}.us`);
  return [...new Set(out)];
}

function parseStooqCsv(csv) {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 3) return [];
  const headers = lines[0].split(",");
  const idxDate = headers.indexOf("Date");
  const idxClose = headers.indexOf("Close");
  if (idxDate < 0 || idxClose < 0) return [];

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const dt = parts[idxDate];
    const close = Number(parts[idxClose]);
    if (!dt || !Number.isFinite(close)) continue;
    rows.push({ dt, close });
  }
  return rows;
}

function closestBefore(rows, isoDate) {
  // rows are ascending by date
  let best = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].dt <= isoDate) return rows[i];
    best = rows[i];
  }
  return best;
}

async function stooqPctChange(symbol, daysBack) {
  const isoNow = todayIso();
  const isoPast = isoDaysAgo(daysBack);
  const cands = stooqCandidates(symbol);

  for (const cand of cands) {
    try {
      const csv = await fetchText(stooqDailyUrl(cand));
      const rows = parseStooqCsv(csv);
      if (!rows.length) continue;

      const nowRow = closestBefore(rows, isoNow) || rows[rows.length - 1];
      const pastRow = closestBefore(rows, isoPast);
      if (!nowRow || !pastRow) continue;

      const pct = ((nowRow.close - pastRow.close) / pastRow.close) * 100;
      if (Number.isFinite(pct)) return pct;
    } catch (e) {
      // try next candidate
    }
  }
  return NaN;
}

/* ---------- Market cap + name fallbacks ---------- */
function pickYahooQuote(q) {
  const r = q && q.quoteResponse && Array.isArray(q.quoteResponse.result) ? q.quoteResponse.result[0] : null;
  if (!r) return {};
  const dayPct = Number.isFinite(Number(r.regularMarketChangePercent)) ? Number(r.regularMarketChangePercent) : NaN;
  return {
    name: r.longName || r.shortName || "",
    mcap: Number.isFinite(r.marketCap) ? Number(r.marketCap) : NaN,
    price: Number.isFinite(r.regularMarketPrice) ? Number(r.regularMarketPrice) : NaN,
    dayPct,
    quoteType: (r.quoteType || "").toString().toUpperCase()
  };
}

function pickFinnhubQuote(q) {
  // Finnhub /quote -> { c: current, dp: % change }
  if (!q || typeof q !== "object") return {};
  const price = Number.isFinite(Number(q.c)) ? Number(q.c) : NaN;
  const dayPct = Number.isFinite(Number(q.dp)) ? Number(q.dp) : NaN;
  return { price, dayPct };
}

function pickFinnhubProfile(p) {
  // Finnhub /stock/profile2 -> { name, marketCapitalization (in millions) }
  if (!p || typeof p !== "object") return {};
  const name = (p.name || "").toString();
  const mc = Number(p.marketCapitalization);
  const mcap = Number.isFinite(mc) ? mc * 1e6 : NaN;
  return { name, mcap, assetType: "EQUITY" };
}

function pickFinnhubEtfProfile(p) {
  // Finnhub /etf/profile -> typically includes { name, aum (in millions) }
  if (!p || typeof p !== "object") return {};
  const name = (p.name || p.etfName || "").toString();
  const aum = Number(p.aum ?? p.AUM ?? p.totalAssets);
  const mcap = Number.isFinite(aum) ? aum * 1e6 : NaN;
  return { name, mcap, assetType: "ETF" };
}

function pickYahooSummary(s) {
  const r = s && s.quoteSummary && Array.isArray(s.quoteSummary.result) ? s.quoteSummary.result[0] : null;
  if (!r) return {};
  const price = r.price || {};
  const summary = r.summaryDetail || {};
  const name = (price.longName && price.longName.raw) || (price.shortName && price.shortName.raw) || "";
  const marketCap = summary.marketCap && summary.marketCap.raw ? Number(summary.marketCap.raw) : NaN;
  const totalAssets = summary.totalAssets && summary.totalAssets.raw ? Number(summary.totalAssets.raw) : NaN;
  const regPrice = price.regularMarketPrice && price.regularMarketPrice.raw ? Number(price.regularMarketPrice.raw) : NaN;
  return { name, mcap: Number.isFinite(marketCap) ? marketCap : totalAssets, price: regPrice };
}

/* ---------- Build one row ---------- */
async function buildRow(symbol, store) {
  const token = (store.finnhubToken || "").trim();
  const shares = Number(store.sharesBySymbol && store.sharesBySymbol[symbol]) || 0;

  // Start from the last snapshot so we can render something quickly even if a fetch fails.
  const snap = (store.lastSnapshot && store.lastSnapshot[symbol]) ? store.lastSnapshot[symbol] : {};

  // Treat placeholder names as empty so real names can overwrite them.
  const snapNameRaw = (snap.name || "").toString();
  let name = (!snapNameRaw || /loading/i.test(snapNameRaw)) ? "" : snapNameRaw;
  let price = Number.isFinite(snap.price) ? snap.price : NaN;
  let dayPct = Number.isFinite(snap.dayPct) ? snap.dayPct : NaN;
  let weekPct = Number.isFinite(snap.weekPct) ? snap.weekPct : NaN;
  let monthPct = Number.isFinite(snap.monthPct) ? snap.monthPct : NaN;
  let mcap = Number.isFinite(snap.mcap) ? snap.mcap : NaN;
  let assetType = (snap.assetType || "").toString();

  let tsQuote = 0;
  let tsProfile = 0;
  let tsMcap = 0;
  let tsStooq7d = 0;
  let tsStooq30d = 0;

  // 1) Finnhub (optional): price + today % + company/ETF name + market cap
  if (token) {
    try {
      const qKey = cacheKey("finnhubQuote", symbol);
      const q = await cachedFetchJson(finnhubQuoteUrl(symbol, token), qKey, 30_000);
      const picked = pickFinnhubQuote(q);
      if (picked) {
        if (Number.isFinite(picked.price)) price = picked.price;
        if (Number.isFinite(picked.dayPct)) dayPct = picked.dayPct;
      }
      tsQuote = CACHE[qKey] ? Number(CACHE[qKey].fetchedAtMs) : tsQuote;
    } catch (e) {}

    try {
      const pKey = cacheKey("finnhubProfile", symbol);
      const p = await cachedFetchJson(finnhubProfileUrl(symbol, token), pKey, 24 * 60 * 60_000);
        const picked = pickFinnhubProfile(p);
      if (picked) {
        if (!name && picked.name) name = picked.name;
        if (!Number.isFinite(mcap) && Number.isFinite(picked.mcap)) mcap = picked.mcap;
          if (!assetType && picked.assetType) assetType = picked.assetType;
      }
      tsProfile = CACHE[pKey] ? Number(CACHE[pKey].fetchedAtMs) : tsProfile;
      tsMcap = CACHE[pKey] ? Number(CACHE[pKey].fetchedAtMs) : tsMcap;
    } catch (e) {}

    // ETF profile is a separate endpoint on Finnhub
    if (!name || !Number.isFinite(mcap)) {
      try {
        const eKey = cacheKey("finnhubEtf", symbol);
        const ep = await cachedFetchJson(finnhubEtfProfileUrl(symbol, token), eKey, 24 * 60 * 60_000);
        const picked = pickFinnhubEtfProfile(ep);
        if (picked) {
          if (!name && picked.name) name = picked.name;
          if (!Number.isFinite(mcap) && Number.isFinite(picked.mcap)) mcap = picked.mcap;
          if (!assetType && picked.assetType) assetType = picked.assetType;
        }
        tsProfile = Math.max(tsProfile, CACHE[eKey] ? Number(CACHE[eKey].fetchedAtMs) : 0);
        tsMcap = Math.max(tsMcap, CACHE[eKey] ? Number(CACHE[eKey].fetchedAtMs) : 0);
      } catch (e) {}
    }

    // Last resort name fix if Finnhub returns an empty profile
    if (!name) {
      try {
        const sKey = cacheKey("finnhubSearch", symbol);
        const data = await cachedFetchJson(finnhubSearchUrl(symbol, token), sKey, 6 * 60 * 60_000);
        const res = Array.isArray(data && data.result) ? data.result : [];
        const hit = res.find((x) => String(x.symbol || "").toUpperCase() === String(symbol).toUpperCase());
        if (hit && hit.description) name = String(hit.description);
      } catch (e) {}
    }
  }

  // 2) Stooq (always): 7d + 30d % changes (no API key)
  // Cached for speed, but computed from the CSV.
  try {
    const k7 = cacheKey("stooq7d", symbol);
    const pct7 = await getCached(k7, 12 * 60 * 60_000, () => stooqPctChange(symbol, 7));
    if (Number.isFinite(pct7)) weekPct = pct7;
    tsStooq7d = CACHE[k7] ? Number(CACHE[k7].fetchedAtMs) : tsStooq7d;
  } catch (e) {}

  try {
    const k30 = cacheKey("stooq30d", symbol);
    const pct30 = await getCached(k30, 12 * 60 * 60_000, () => stooqPctChange(symbol, 30));
    if (Number.isFinite(pct30)) monthPct = pct30;
    tsStooq30d = CACHE[k30] ? Number(CACHE[k30].fetchedAtMs) : tsStooq30d;
  } catch (e) {}

  // 3) Yahoo (always): fallbacks for name/price/market cap and (sometimes) today %
  if (!name || !Number.isFinite(price) || !Number.isFinite(mcap) || !Number.isFinite(dayPct)) {
    try {
      const yKey = cacheKey("yahooQuote", symbol);
      const y = await cachedFetchJson(yahooQuoteUrl(symbol), yKey, 30_000);
      const picked = pickYahooQuote(y);
      if (picked) {
        if (!name && picked.name) name = picked.name;
        if (!Number.isFinite(mcap) && Number.isFinite(picked.mcap)) mcap = picked.mcap;
        if (!Number.isFinite(price) && Number.isFinite(picked.price)) price = picked.price;
        if (!Number.isFinite(dayPct) && Number.isFinite(picked.dayPct)) dayPct = picked.dayPct;
        if (!assetType && picked.quoteType) assetType = picked.quoteType;
      }
      tsMcap = Math.max(tsMcap, CACHE[yKey] ? Number(CACHE[yKey].fetchedAtMs) : 0);
      tsQuote = Math.max(tsQuote, CACHE[yKey] ? Number(CACHE[yKey].fetchedAtMs) : 0);
    } catch (e) {}
  }

  if (!name || !Number.isFinite(mcap)) {
    try {
      const ysKey = cacheKey("yahooSummary", symbol);
      const ys = await cachedFetchJson(yahooSummaryUrl(symbol), ysKey, 24 * 60 * 60_000);
      const picked = pickYahooSummary(ys);
      if (picked) {
        if (!name && picked.name) name = picked.name;
        if (!Number.isFinite(mcap) && Number.isFinite(picked.mcap)) mcap = picked.mcap;
      }
      tsMcap = Math.max(tsMcap, CACHE[ysKey] ? Number(CACHE[ysKey].fetchedAtMs) : 0);
    } catch (e) {}
  }

  const value = Number.isFinite(price) ? (shares * price) : NaN;

  return {
    symbol,
    name: name || "",
    assetType,
    price,
    dayPct,
    weekPct,
    monthPct,
    mcap,
    assetType,
    shares,
    value,
    tsQuote,
    tsProfile,
    tsMcap,
    tsStooq7d,
    tsStooq30d
  };
}

function getSymbolsFromStore(store) {
  if (store.groupsEnabled) {
    const out = [];
    (store.groups || []).forEach((g) => {
      const arr = (store.groupTickers && store.groupTickers[g.id]) || [];
      arr.forEach((s) => out.push(s));
    });
    return [...new Set(out)];
  }
  return [...new Set(store.tickers || [])];
}

function isAlreadyAdded(symbol, store) {
  const sym = symbol.toUpperCase();
  if (store.groupsEnabled) {
    const gt = store.groupTickers || {};
    return Object.values(gt).some((arr) => Array.isArray(arr) && arr.map((x) => String(x).toUpperCase()).includes(sym));
  }
  return (store.tickers || []).map((x) => String(x).toUpperCase()).includes(sym);
}

/* ---------- Rendering ---------- */
function renderHeader(store) {
  const hdr = $("#hdr");
  hdr.innerHTML = "";

  const cols = visibleCols(store);
  const order = normalizeColumnOrder(store.columnOrder, store);

  const byKey = new Map(cols.map((c) => [c.key, c]));
  const finalCols = order.map((k) => byKey.get(k)).filter(Boolean);

  for (const c of finalCols) {
    const th = document.createElement("th");
    th.className = c.cls || "";

    const wrap = document.createElement("div");
    wrap.className = "thwrap";

    const label = document.createElement("div");
    label.className = "thlabel";
    label.textContent = c.label;

    label.addEventListener("click", () => {
      const ts = newestTimestampForColumn(c.key);
      if (!ts) return;
      const when = new Date(ts).toLocaleString();
      setStatus(`${c.label} last refreshed: ${when}`, { sticky: true });
    });

    wrap.appendChild(label);
    th.appendChild(wrap);
    hdr.appendChild(th);
  }

  const thAct = document.createElement("th");
  thAct.className = ACTIONS_COL.cls;
  hdr.appendChild(thAct);
}

function newestTimestampForColumn(colKey) {
  const rows = LAST_ROWS || [];
  const keys = {
    dayPct: "tsQuote",
    price: "tsQuote",
    name: "tsProfile",
    mcap: "tsMcap",
    weekPct: "tsStooq7d",
    monthPct: "tsStooq30d",
    symbol: null,
    shares: null,
    value: null
  };
  const tsKey = keys[colKey] || null;
  if (!tsKey) return null;

  let best = 0;
  for (const r of rows) {
    if (r && Number.isFinite(Number(r[tsKey]))) best = Math.max(best, Number(r[tsKey]));
  }
  return best || null;
}

function renderRows(rows, store) {
  const tbody = $("#rows");
  tbody.innerHTML = "";

  const cols = visibleCols(store);
  const order = normalizeColumnOrder(store.columnOrder, store);
  const colByKey = new Map(cols.map((c) => [c.key, c]));

  function makeCell(key, r, isGroupRow = false) {
    const td = document.createElement("td");
    const col = colByKey.get(key);
    td.className = col && col.cls ? col.cls : "";

    if (key === "symbol") {
      td.innerHTML = isGroupRow ? `<span class="group-name">${safeUpper(r.groupName)}</span>` : `<span class="sym">${safeUpper(r.symbol)}</span>`;
      return td;
    }

    if (key === "name") {
      td.textContent = safeUpper(r.name || "");
      return td;
    }

    if (key === "dayPct" || key === "weekPct" || key === "monthPct") {
      const v = r[key];
      if (isGroupRow) {
        td.classList.add("center");
        if (store.groupAveraging && Number.isFinite(v)) {
          const div = document.createElement("div");
          div.className = "group-avg";
          div.textContent = fmtPct(v, 3);
          td.appendChild(div);
        }
        return td;
      }

      const span = document.createElement("span");
      span.className = `pct ${pctClass(v)}`;
      span.textContent = fmtPct(v, 2);
      td.appendChild(span);
      return td;
    }

    if (key === "price") {
      td.classList.add("money");
      td.textContent = fmtPrice(r.price);
      return td;
    }

    if (key === "mcap") {
      td.classList.add("money");
      td.textContent = fmtMoney(r.mcap);
      return td;
    }

    if (key === "shares") {
      if (isGroupRow) {
        td.classList.add("center");
        td.textContent = fmtShares(r.shares);
        return td;
      }

      const inp = document.createElement("input");
      inp.className = "shares no-drag";
      inp.type = "text";
      inp.inputMode = "decimal";
      inp.autocomplete = "off";
      inp.spellcheck = false;
      inp.value = Number.isFinite(r.shares) && r.shares !== 0 ? String(r.shares) : "";
      inp.placeholder = "Shares";
      inp.addEventListener("mousedown", (e) => e.stopPropagation());
      inp.addEventListener("click", (e) => e.stopPropagation());
      inp.addEventListener("input", async () => {
        const raw = (inp.value || "").trim();
        const v = raw === "" ? 0 : Number(raw);
        const s = await getStore();
        const map = { ...(s.sharesBySymbol || {}) };
        map[r.symbol] = Number.isFinite(v) ? v : 0;
        await setStore({ sharesBySymbol: map });
        // update in-memory row + value cell immediately
        r.shares = Number.isFinite(v) ? v : 0;
        r.value = Number.isFinite(r.price) ? r.shares * r.price : NaN;
        renderTableOnly();
      });
      td.appendChild(inp);
      return td;
    }

    if (key === "value") {
      td.classList.add("money");
      td.textContent = fmtMoney(r.value);
      return td;
    }

    td.textContent = "";
    return td;
  }

  function addActionsCell(tr, r, meta) {
    const td = document.createElement("td");
    td.className = ACTIONS_COL.cls;

    const actions = document.createElement("div");
    actions.className = "actions";

    const isGroup = meta && meta.type === "group";

    if (!isGroup && store.aiEnabled) {
      const ai = document.createElement("button");
      ai.className = "mini ai no-drag";
      ai.title = "AI summary";
      ai.innerHTML = "✨";
      ai.draggable = false;
      ai.addEventListener("mousedown", (e) => e.stopPropagation());
      ai.addEventListener("click", async (e) => {
        e.stopPropagation();
        await showAiSummary(r);
      });
      actions.appendChild(ai);
    }

    const up = document.createElement("button");
    up.className = "mini no-drag";
    up.title = "Move up";
    up.innerHTML = "▲";
    up.disabled = !(meta && meta.canUp);
    up.draggable = false;
    up.addEventListener("mousedown", (e) => e.stopPropagation());
    up.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (up.disabled) return;
      if (isGroup) {
        await moveGroupStep(meta.groupId, -1);
      } else {
        await moveTickerStep(r.symbol, -1);
      }
    });
    actions.appendChild(up);

    const down = document.createElement("button");
    down.className = "mini no-drag";
    down.title = "Move down";
    down.innerHTML = "▼";
    down.disabled = !(meta && meta.canDown);
    down.draggable = false;
    down.addEventListener("mousedown", (e) => e.stopPropagation());
    down.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (down.disabled) return;
      if (isGroup) {
        await moveGroupStep(meta.groupId, 1);
      } else {
        await moveTickerStep(r.symbol, 1);
      }
    });
    actions.appendChild(down);

    if (!isGroup) {
      const rm = document.createElement("button");
      rm.className = "mini rm no-drag";
      rm.title = "Remove";
      rm.innerHTML = "×";
      rm.draggable = false;
      rm.addEventListener("mousedown", (e) => e.stopPropagation());
      rm.addEventListener("click", async (e) => {
        e.stopPropagation();
        await removeTicker(r.symbol);
      });
      actions.appendChild(rm);
    }

    td.appendChild(actions);
    tr.appendChild(td);
  }

  if (store.groupsEnabled) {
    const gt = store.groupTickers || {};
    const groups = store.groups || [];

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const gsyms = Array.isArray(gt[g.id]) ? gt[g.id] : [];
      const gRows = gsyms.map((s) => rows.find((x) => x.symbol === s)).filter(Boolean);

      // Group row aligned to columns
      const groupRow = document.createElement("tr");
      groupRow.className = "group-row row";
      groupRow.draggable = false;
      groupRow.dataset.type = "group";
      groupRow.dataset.groupId = g.id;

      const avg = calcGroupAvg(gRows, store);
      const totalVal = calcGroupTotalValue(gRows);
      const totalShares = gRows.reduce((a, r) => a + (Number.isFinite(r.shares) ? r.shares : 0), 0);

      const groupObj = {
        groupName: g.name || "Group",
        dayPct: avg.day,
        weekPct: avg.week,
        monthPct: avg.month,
        shares: totalShares,
        value: totalVal
      };

      for (const key of order) {
        if (!colByKey.has(key)) continue;
        if (key === "value" && !store.personalValueEnabled) continue;
        groupRow.appendChild(makeCell(key, groupObj, true));
      }      addActionsCell(groupRow, groupObj, { type: "group", groupId: g.id, canUp: gi > 0, canDown: gi < groups.length - 1 });

      tbody.appendChild(groupRow);

      for (let ri = 0; ri < gRows.length; ri++) {
        const r = gRows[ri];
        const tr = document.createElement("tr");
        tr.className = "row";
        tr.draggable = false;
        tr.dataset.type = "ticker";
        tr.dataset.symbol = r.symbol;
        tr.dataset.groupId = g.id;

        for (const key of order) {
          if (!colByKey.has(key)) continue;
          if ((key === "shares" || key === "value") && !store.personalValueEnabled) continue;
          tr.appendChild(makeCell(key, r, false));
        }
        addActionsCell(tr, r, { type: "ticker", canUp: (ri > 0 || gi > 0), canDown: (ri < gRows.length - 1 || gi < groups.length - 1) });
        tbody.appendChild(tr);
      }
    }
  } else {
    // Flat list
    const manual = (store.sortKey || "manual") === "manual";
    const bySym = new Map(rows.map((r) => [r.symbol, r]));
    let ordered = rows.slice();

    if (manual) {
      ordered = (store.tickers || []).map((s) => bySym.get(s)).filter(Boolean);
    } else {
      ordered.sort((a, b) => {
        const k = store.sortKey || "symbol";
        const av = a[k];
        const bv = b[k];
        const dir = (store.sortDir || "asc") === "asc" ? 1 : -1;
        if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
        if (!Number.isFinite(av) && Number.isFinite(bv)) return 1;
        if (Number.isFinite(av) && !Number.isFinite(bv)) return -1;
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * dir;
      });
    }

    for (let i = 0; i < ordered.length; i++) {
      const r = ordered[i];
      const tr = document.createElement("tr");
      tr.className = "row";
      tr.draggable = false;
      tr.dataset.type = "ticker";
      tr.dataset.symbol = r.symbol;

      for (const key of order) {
        if (!colByKey.has(key)) continue;
        if ((key === "shares" || key === "value") && !store.personalValueEnabled) continue;
        tr.appendChild(makeCell(key, r, false));
      }
      addActionsCell(tr, r, { type: "ticker", canUp: (manual && i > 0), canDown: (manual && i < ordered.length - 1) });
      tbody.appendChild(tr);
    }
  }
}

function calcGroupAvg(rows, store) {
  const useWeights = !!(store && store.personalValueEnabled);

  if (useWeights) {
    // Weighted by held value when shares are set; falls back to simple average.
    const finiteRows = rows.filter((r) => r && Number.isFinite(r.value) && r.value > 0);
    if (finiteRows.length) {
      const pctFrom = (keyPct) => {
        let prev = 0;
        let delta = 0;

        for (const r of finiteRows) {
          const f = safePctToFrac(r[keyPct]);
          const pr = Number(r.price);
          const sh = Number(r.shares);
          if (!Number.isFinite(f) || !Number.isFinite(pr) || !Number.isFinite(sh) || sh <= 0) continue;

          prev += (sh * pr) / (1 + f);
          const d = dollarDelta(pr, sh, r[keyPct]);
          if (Number.isFinite(d)) delta += d;
        }

        if (!Number.isFinite(prev) || prev <= 0) return NaN;
        return (delta / prev) * 100;
      };

      return { day: pctFrom("dayPct"), week: pctFrom("weekPct"), month: pctFrom("monthPct") };
    }
  }

  const nums = (arr, key) => arr.map((r) => r[key]).filter((v) => Number.isFinite(v));
  const avg = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : NaN;
  return { day: avg(nums(rows, "dayPct")), week: avg(nums(rows, "weekPct")), month: avg(nums(rows, "monthPct")) };
}


function calcGroupTotalValue(rows) {
  const vals = rows.map((r) => r.value).filter((v) => Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) : NaN;
}

function safePctToFrac(pct) {
  const p = Number(pct);
  if (!Number.isFinite(p)) return NaN;
  const f = p / 100;
  // Avoid 1 + f hitting 0 or negative due to bad data
  if (f <= -0.999) return NaN;
  return f;
}

function dollarDelta(price, shares, pct) {
  const pr = Number(price);
  const sh = Number(shares);
  const f = safePctToFrac(pct);
  if (!Number.isFinite(pr) || !Number.isFinite(sh) || sh <= 0 || !Number.isFinite(f)) return NaN;
  return sh * pr * (f / (1 + f));
}

function updateTotalsBox(store, rows) {
  const box = $("#totalsBox");
  if (!box) return;

  if (!store || !store.personalValueEnabled || !Array.isArray(rows) || !rows.length) {
    box.style.display = "none";
    return;
  }

  let totalValue = 0;
  let dDay = 0, d7 = 0, d30 = 0;
  let hasValue = false;

  for (const r of rows) {
    if (!r) continue;
    const val = Number.isFinite(r.value) ? Number(r.value) : 0;
    totalValue += val;
    if (val > 0) hasValue = true;

    const dd = dollarDelta(r.price, r.shares, r.dayPct);
    const d7i = dollarDelta(r.price, r.shares, r.weekPct);
    const d30i = dollarDelta(r.price, r.shares, r.monthPct);

    if (Number.isFinite(dd)) dDay += dd;
    if (Number.isFinite(d7i)) d7 += d7i;
    if (Number.isFinite(d30i)) d30 += d30i;
  }

  $("#totValue").textContent = fmtMoney(totalValue);

  const pill = (id, v) => {
    const el = $(id);
    if (!el) return;
    if (!hasValue || !Number.isFinite(v)) {
      el.textContent = el.textContent.split(":")[0] + ": n/a";
      el.classList.remove("good", "bad");
      return;
    }
    const s = (v >= 0 ? "+" : "") + fmtMoney(v);
    el.textContent = el.textContent.split(":")[0] + ": " + s;
    el.classList.remove("good", "bad");
    if (v > 0) el.classList.add("good");
    if (v < 0) el.classList.add("bad");
  };

  pill("#totDay", dDay);
  pill("#tot7", d7);
  pill("#tot30", d30);

  box.style.display = "flex";
}

/* ---------- Column drag reorder ---------- */
function initColumnDnD(store) {
  const hdr = $("#hdr");
  const order = normalizeColumnOrder(store.columnOrder, store);

  let dragKey = null;

  hdr.querySelectorAll(".col-drag").forEach((h) => {
    h.draggable = true;

    h.addEventListener("dragstart", (e) => {
      dragKey = h.dataset.colkey;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragKey || "col");
    });
  });

  hdr.addEventListener("dragover", (e) => {
    if (!dragKey) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  });

  hdr.addEventListener("drop", async (e) => {
    if (!dragKey) return;
    e.preventDefault();

    const th = e.target.closest("th");
    if (!th) return;

    const idx = Array.from(hdr.children).indexOf(th);
    const keys = order.slice();
    keys.splice(keys.indexOf(dragKey), 1);
    keys.splice(Math.max(0, Math.min(idx, keys.length)), 0, dragKey);

    const storeNow = await getStore();
    const normalized = normalizeColumnOrder(keys, storeNow);
    await setStore({ columnOrder: normalized });

    dragKey = null;
    renderTableOnly();
  });
}

/* ---------- Row drag reorder ---------- */
let DRAG_STATE = null;

function initRowDnD(store) {
  const tbody = $("#rows");

  tbody.addEventListener("dragstart", (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;

    // Don't start dragging from interactive controls
    if (e.target.closest(".no-drag")) {
      e.preventDefault();
      return;
    }

    const type = tr.dataset.type;
    if (type !== "ticker" && type !== "group") return;

    DRAG_STATE = {
      type,
      symbol: tr.dataset.symbol || null,
      groupId: tr.dataset.groupId || null
    };

    tr.classList.add("dragging");

    e.dataTransfer.effectAllowed = "move";
    // Some Chrome builds are pickier if the payload is empty
    e.dataTransfer.setData("text/plain", DRAG_STATE.symbol || DRAG_STATE.groupId || "row");
  }, { capture: true });

  tbody.addEventListener("dragend", () => {
    tbody.querySelectorAll("tr.dragging").forEach((x) => x.classList.remove("dragging"));
    tbody.querySelectorAll(".drop-before,.drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
    DRAG_STATE = null;
  });

  tbody.addEventListener("dragover", (e) => {
    if (!DRAG_STATE) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

    const tr = e.target.closest("tr");
    tbody.querySelectorAll(".drop-before,.drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
    if (!tr) return;

    const rect = tr.getBoundingClientRect();
    const after = (e.clientY - rect.top) > rect.height / 2;
    tr.classList.add(after ? "drop-after" : "drop-before");
  });

  tbody.addEventListener("drop", async (e) => {
    if (!DRAG_STATE) return;
    e.preventDefault();

    const storeNow = await getStore();
    const tr = e.target.closest("tr");
    const targetType = tr ? tr.dataset.type : null;

    // Find "after" from class, fallback to bottom if no target row
    const after = tr ? tr.classList.contains("drop-after") : true;

    if (storeNow.groupsEnabled) {
      if (DRAG_STATE.type === "group") {
        const fromGid = DRAG_STATE.groupId;
        let toGid = null;

        if (targetType === "group") toGid = tr.dataset.groupId;
        if (targetType === "ticker") toGid = tr.dataset.groupId;

        // drop on empty space => move to end
        if (!toGid) {
          const lastGroup = (storeNow.groups || []).slice(-1)[0];
          toGid = lastGroup ? lastGroup.id : fromGid;
        }

        if (fromGid && toGid) await moveGroup(fromGid, toGid, after);
      }

      if (DRAG_STATE.type === "ticker") {
        const sym = DRAG_STATE.symbol;
        if (!sym) return;

        let fromGid = findSymbolGroupId(sym, storeNow.groupTickers || {});
        let toGid = null;
        let targetSym = null;

        if (targetType === "group") {
          toGid = tr.dataset.groupId;
        } else if (targetType === "ticker") {
          toGid = tr.dataset.groupId;
          targetSym = tr.dataset.symbol;
        } else {
          // empty area => last group
          const lastGroup = (storeNow.groups || []).slice(-1)[0];
          toGid = lastGroup ? lastGroup.id : fromGid;
        }

        if (!toGid) toGid = fromGid;
        await moveTickerGrouped(sym, fromGid, toGid, targetSym, after);
      }
    } else {
      if (DRAG_STATE.type !== "ticker") return;
      const sym = DRAG_STATE.symbol;
      if (!sym) return;

      let targetSym = null;
      if (targetType === "ticker") targetSym = tr.dataset.symbol;

      await moveTickerFlat(sym, targetSym, after);
    }

    tbody.querySelectorAll(".drop-before,.drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
    DRAG_STATE = null;

    renderTableOnly();
  });
}

/* ---------- Move helpers ---------- */
function findSymbolGroupId(symbol, groupTickers) {
  const sym = String(symbol).toUpperCase();
  for (const [gid, arr] of Object.entries(groupTickers || {})) {
    const a = Array.isArray(arr) ? arr : [];
    if (a.map((x) => String(x).toUpperCase()).includes(sym)) return gid;
  }
  return null;
}

function removeSymbolFromAllGroups(symbol, groupTickers) {
  const sym = String(symbol).toUpperCase();
  for (const gid of Object.keys(groupTickers)) {
    const arr = Array.isArray(groupTickers[gid]) ? groupTickers[gid] : [];
    groupTickers[gid] = arr.filter((x) => String(x).toUpperCase() !== sym);
  }
}

async function moveGroup(fromGid, toGid, after) {
  const s = await getStore();
  const groups = (s.groups || []).slice();
  const fromIdx = groups.findIndex((g) => g.id === fromGid);
  const toIdx = groups.findIndex((g) => g.id === toGid);
  if (fromIdx < 0 || toIdx < 0) return;

  const [moved] = groups.splice(fromIdx, 1);
  let insertIdx = toIdx;
  if (fromIdx < toIdx) insertIdx = toIdx - 1;
  if (after) insertIdx += 1;

  groups.splice(Math.max(0, Math.min(insertIdx, groups.length)), 0, moved);
  await setStore({ groups });
}

async function moveTickerGrouped(symbol, fromGid, toGid, targetSymbol, after) {
  const s = await getStore();
  const gt = { ...(s.groupTickers || {}) };

  // ensure keys exist
  (s.groups || []).forEach((g) => { if (!gt[g.id]) gt[g.id] = []; });
  if (!gt[toGid]) gt[toGid] = [];

  removeSymbolFromAllGroups(symbol, gt);

  const dest = Array.isArray(gt[toGid]) ? gt[toGid].slice() : [];
  const sym = String(symbol).toUpperCase();

  if (targetSymbol) {
    const t = String(targetSymbol).toUpperCase();
    const idx = dest.findIndex((x) => String(x).toUpperCase() === t);
    if (idx >= 0) dest.splice(after ? idx + 1 : idx, 0, sym);
    else dest.push(sym);
  } else {
    dest.push(sym);
  }

  gt[toGid] = dest;
  await setStore({ groupTickers: gt });
}

async function moveTickerFlat(symbol, targetSymbol, after) {
  const s = await getStore();
  const tickers = (s.tickers || []).slice().map((x) => String(x).toUpperCase());
  const sym = String(symbol).toUpperCase();

  const fromIdx = tickers.findIndex((x) => x === sym);
  if (fromIdx < 0) return;
  tickers.splice(fromIdx, 1);

  if (targetSymbol) {
    const t = String(targetSymbol).toUpperCase();
    const toIdx = tickers.findIndex((x) => x === t);
    if (toIdx >= 0) tickers.splice(after ? toIdx + 1 : toIdx, 0, sym);
    else tickers.push(sym);
  } else {
    tickers.push(sym);
  }

  await setStore({ tickers, sortKey: "manual" });
}
/* ---------- One-step move (▲▼ buttons) ---------- */
async function moveGroupStep(groupId, dir) {
  const s = await getStore();
  const groups = (s.groups || []).slice();
  const fromIdx = groups.findIndex((g) => g.id === groupId);
  if (fromIdx < 0) return;

  const toIdx = fromIdx + (dir < 0 ? -1 : 1);
  if (toIdx < 0 || toIdx >= groups.length) return;

  // swap the headers, tickers stay attached to their group ids
  const tmp = groups[toIdx];
  groups[toIdx] = groups[fromIdx];
  groups[fromIdx] = tmp;

  await setStore({ groups });
  renderTableOnly();
}

async function moveTickerStep(symbol, dir) {
  const s = await getStore();
  const sym = String(symbol).toUpperCase();

  if (s.groupsEnabled) {
    const groups = s.groups || [];
    const gt = { ...(s.groupTickers || {}) };
    const gid = findSymbolGroupId(sym, gt);
    if (!gid) return;

    const gIdx = groups.findIndex((g) => g.id === gid);
    const arr = (Array.isArray(gt[gid]) ? gt[gid] : []).map((x) => String(x).toUpperCase());
    const idx = arr.findIndex((x) => x === sym);
    if (idx < 0) return;

    if (dir < 0) {
      if (idx > 0) {
        // move up inside the same group
        [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
        gt[gid] = arr;
      } else {
        // move to previous group (to the bottom)
        if (gIdx <= 0) return;
        const prevGid = groups[gIdx - 1].id;
        const prevArr = (Array.isArray(gt[prevGid]) ? gt[prevGid] : []).map((x) => String(x).toUpperCase());
        gt[gid] = arr.slice(1); // remove first
        prevArr.push(sym);
        gt[prevGid] = prevArr;
      }
    } else {
      if (idx < arr.length - 1) {
        // move down inside the same group
        [arr[idx + 1], arr[idx]] = [arr[idx], arr[idx + 1]];
        gt[gid] = arr;
      } else {
        // move to next group (to the top)
        if (gIdx < 0 || gIdx >= groups.length - 1) return;
        const nextGid = groups[gIdx + 1].id;
        const nextArr = (Array.isArray(gt[nextGid]) ? gt[nextGid] : []).map((x) => String(x).toUpperCase());
        gt[gid] = arr.slice(0, arr.length - 1); // remove last
        nextArr.unshift(sym);
        gt[nextGid] = nextArr;
      }
    }

    await setStore({ groupTickers: gt });
    renderTableOnly();
    return;
  }

  // Flat list
  const tickers = (s.tickers || []).slice().map((x) => String(x).toUpperCase());
  const i = tickers.findIndex((x) => x === sym);
  if (i < 0) return;

  const j = i + (dir < 0 ? -1 : 1);
  if (j < 0 || j >= tickers.length) return;

  [tickers[i], tickers[j]] = [tickers[j], tickers[i]];
  await setStore({ tickers, sortKey: "manual" });
  renderTableOnly();
}


/* ---------- Add / remove ---------- */
async function addTicker(raw) {
  const symbol = String(raw || "").trim().toUpperCase();
  if (!symbol) return;

  const store = await getStore();
  if (isAlreadyAdded(symbol, store)) {
    showToast("Already added");
    return;
  }

  if (store.groupsEnabled) {
    const groups = store.groups || [];
    const gid = groups.length ? groups[0].id : "g1";
    const gt = { ...(store.groupTickers || {}) };
    (groups || []).forEach((g) => { if (!gt[g.id]) gt[g.id] = []; });
    removeSymbolFromAllGroups(symbol, gt);
    gt[gid] = Array.isArray(gt[gid]) ? gt[gid].concat([symbol]) : [symbol];
    await setStore({ groupTickers: gt });
  } else {
    const tickers = (store.tickers || []).slice();
    tickers.push(symbol);
    await setStore({ tickers, sortKey: "manual" });
  }

  // Show it immediately as a placeholder row while data loads
  const snap = { ...(store.lastSnapshot || {}) };
  if (!snap[symbol]) {
    snap[symbol] = {
      symbol,
      name: "LOADING…",
      price: NaN,
      dayPct: NaN,
      weekPct: NaN,
      monthPct: NaN,
      mcap: NaN,
      shares: Number(store.sharesBySymbol && store.sharesBySymbol[symbol]) || 0,
      value: NaN
    };
  }
  await setStore({ lastSnapshot: snap });

  $("#ticker").value = "";
  clearSuggest();

  await render(false);
  await render(true);
}

async function removeTicker(symbol) {
  const sym = String(symbol).toUpperCase();
  const store = await getStore();

  if (store.groupsEnabled) {
    const gt = { ...(store.groupTickers || {}) };
    removeSymbolFromAllGroups(sym, gt);
    await setStore({ groupTickers: gt });
  } else {
    const tickers = (store.tickers || []).slice().filter((x) => String(x).toUpperCase() !== sym);
    await setStore({ tickers });
  }

  // also remove shares
  const shares = { ...(store.sharesBySymbol || {}) };
  delete shares[sym];
  await setStore({ sharesBySymbol: shares });

  showToast("Removed");
  renderTableOnly();
}

/* ---------- Suggestions (autocomplete) ---------- */
let SUGGEST_TIMER = null;
let SUGGEST_LAST_Q = "";

async function fetchSuggestions(q, store) {
  const token = (store.finnhubToken || "").trim();
  if (!token || !q) return [];

  const data = await fetchJson(finnhubSearchUrl(q, token));
  const res = Array.isArray(data.result) ? data.result : [];
  // prioritize common US listings, ETFs, and equities
  const cleaned = res
    .filter((x) => x && x.symbol && x.description)
    .map((x) => ({
      symbol: String(x.symbol).toUpperCase(),
      desc: String(x.description),
      type: String(x.type || "")
    }))
    .slice(0, 8);

  // de-dupe symbols
  const seen = new Set();
  const out = [];
  for (const it of cleaned) {
    if (seen.has(it.symbol)) continue;
    seen.add(it.symbol);
    out.push(it);
  }
  return out;
}

async function updateSuggest() {
  const q = ($("#ticker").value || "").trim();
  if (!q) { clearSuggest(); return; }

  const store = await getStore();
  const items = await fetchSuggestions(q, store);
  if ((($("#ticker").value || "").trim()) !== q) return; // stale

  const box = $("#suggest");
  box.innerHTML = "";
  if (!items.length) { clearSuggest(); return; }

  for (const it of items) {
    const div = document.createElement("div");
    div.className = "sitem";
    div.innerHTML = `<div class="sleft">
        <div class="ssym">${it.symbol}</div>
        <div class="sdesc">${it.desc}</div>
      </div>
      <div class="stype">${it.type}</div>`;
    div.addEventListener("mousedown", (e) => e.preventDefault()); // keep input focus
    div.addEventListener("click", async () => {
      clearSuggest();
      $("#ticker").value = "";
      try { await addTicker(it.symbol); } catch (e) {}
      $("#ticker").focus();
    });
    box.appendChild(div);
  }

  box.classList.remove("hidden");
}

/* ---------- AI Summary ---------- */
function topicKey(headline) {
  const s = String(headline || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!s) return "";

  const stop = new Set([
    "the","a","an","and","or","to","of","in","on","for","with","as","at","from","by","is","are",
    "market","markets","stocks","stock","shares","etf","fund","index","nasdaq","sp","s&p","dow"
  ]);
  const toks = s.split(" ").filter((t) => t && !stop.has(t));
  return toks.slice(0, 3).join(" ");
}

function selectDiverseNews(raw, maxItems = 12) {
  const items = Array.isArray(raw) ? raw.map((x) => {
    const ts = Number(x.datetime) || 0;
    const iso = ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "";
    return {
      iso,
      datePretty: fmtDatePrettyFromIso(iso) || "",
      source: (x.source || "").toString(),
      headline: (x.headline || "").toString(),
      url: (x.url || "").toString(),
      _ts: ts,
      _topic: topicKey(x.headline || "")
    };
  }) : [];

  items.sort((a, b) => (b._ts || 0) - (a._ts || 0));

  const chosen = [];
  const usedDays = new Set();
  const usedTopics = new Set();
  const usedHeadlines = new Set();

  for (const it of items) {
    const hl = (it.headline || "").trim();
    if (!hl || usedHeadlines.has(hl)) continue;
    if (it.iso && usedDays.has(it.iso)) continue;
    if (it._topic && usedTopics.has(it._topic)) continue;

    chosen.push(it);
    usedHeadlines.add(hl);
    if (it.iso) usedDays.add(it.iso);
    if (it._topic) usedTopics.add(it._topic);
    if (chosen.length >= maxItems) break;
  }

  if (chosen.length < Math.min(4, maxItems)) {
    for (const it of items) {
      const hl = (it.headline || "").trim();
      if (!hl || usedHeadlines.has(hl)) continue;
      chosen.push(it);
      usedHeadlines.add(hl);
      if (chosen.length >= maxItems) break;
    }
  }

  return chosen;
}

async function showAiSummary(rowOrSymbol) {
  const store = await getStore();
  if (!store.aiEnabled) return;

  const symbol = typeof rowOrSymbol === "string" ? rowOrSymbol : (rowOrSymbol && rowOrSymbol.symbol);
  if (!symbol) return;

  AI_LAST_SYMBOL = symbol;
  AI_LAST_STORE = store;

  openAiModal(`${symbol} · AI Summary`, "Gathering inputs…");
  setAiLoading(true, "Gathering inputs…");
  await new Promise(requestAnimationFrame);

  try {
    const fresh = await buildRow(symbol, store);
    const token = (store.finnhubToken || "").trim();
    const asOfIso = todayIso();
    const asOfPretty = fmtDatePrettyFromIso(asOfIso) || "";

    let news = [];
    if (token) {
      try {
        const from = isoDaysAgo(30);
        const to = asOfIso;
        const raw = await fetchJson(finnhubCompanyNewsUrl(symbol, from, to, token));
        news = selectDiverseNews(raw, 12);
      } catch (e) {}
    }

    let earnings = [];
    const assetType = (fresh.assetType || "").toString().toUpperCase();
    if (token && assetType !== "ETF") {
      try {
        const from = asOfIso;
        const to = isoDaysAgo(-90);
        const cal = await fetchJson(finnhubEarningsCalUrl(symbol, from, to, token));
        const arr = cal && cal.earningsCalendar ? cal.earningsCalendar : [];
        earnings = Array.isArray(arr) ? arr.slice(0, 3).map((x) => ({
          date: (x.date || "").toString(),
          epsEstimate: x.epsEstimate ?? null,
          revenueEstimate: x.revenueEstimate ?? null
        })) : [];
      } catch (e) {}
    }

    const payload = {
      symbol,
      name: fresh.name || "",
      assetType: assetType || "UNKNOWN",
      metrics: {
        dayPct: fresh.dayPct,
        weekPct: fresh.weekPct,
        monthPct: fresh.monthPct,
        price: fresh.price,
        mcap: fresh.mcap
      },
      news,
      earnings,
      asOf: asOfIso
    };

    AI_LAST_PAYLOAD = payload;
    const prompt = buildAiPrompt(payload, store);

    const text = await runAiPrompt(prompt);
    const lines = postProcessAiLines(text, asOfPretty || "Feb 7, 2026");
    renderAiLines(lines, news);
  } catch (e) {
    if (e && e.name === "AbortError") {
      setAiBodyMessage("Canceled.");
    } else {
      setAiBodyMessage(`Could not generate summary.\n\n${String(e.message || e)}`);
    }
  } finally {
    setAiLoading(false);
  }
}

function extractResponseText(data) {
  if (!data) return "";
  if (typeof data.summary === "string") return data.summary;
  if (typeof data.text === "string") return data.text;
  if (typeof data.output_text === "string") return data.output_text;
  try {
    const out = data.output && data.output[0] && data.output[0].content && data.output[0].content[0];
    if (out && typeof out.text === "string") return out.text;
  } catch (e) {}
  return "";
}

async function runAiPrompt(prompt) {
  const store = AI_LAST_STORE || (await getStore());
  const payload = AI_LAST_PAYLOAD || {};

  if (!store.aiProxyUrl) {
    return "AI is enabled, but the proxy URL is missing in Preferences.";
  }

  try { if (AI_ABORT) AI_ABORT.abort(); } catch (e) {}
  AI_ABORT = new AbortController();
  setAiLoading(true, "Working…");
  await new Promise(requestAnimationFrame);

  const r = await fetch(store.aiProxyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: prompt, symbol: payload.symbol || "" }),
    signal: AI_ABORT.signal
  });

  if (!r.ok) throw new Error(`AI proxy HTTP ${r.status}`);
  const data = await r.json();
  return extractResponseText(data);
}

async function aiSummarize(payload, store) {
  // We never ship an OpenAI key in the extension.
  // The Cloudflare Worker holds the key and the extension only sends a prompt.
  AI_LAST_STORE = store;
  AI_LAST_PAYLOAD = payload;
  return await runAiPrompt(buildAiPrompt(payload, store));
}


function buildAiPrompt(p, store) {
  const m = p.metrics || {};
  const asOfIso = (p.asOf || todayIso()).toString();
  const asOfPretty = fmtDatePrettyFromIso(asOfIso) || asOfIso;

  const headlines = Array.isArray(p.news) && p.news.length
    ? p.news.slice(0, 12).map((n, i) => {
        const dt = (n.datePretty || fmtDatePrettyFromIso(n.iso) || asOfPretty).trim();
        const src = (n.source || "").trim();
        const hl = (n.headline || "").trim();
        const srcPart = src ? ` | ${src}` : "";
        return `#${i + 1} ${dt}${srcPart} | ${hl || "(headline missing)"}`.trim();
      }).join("\n")
    : "None provided";

  const earn = Array.isArray(p.earnings) && p.earnings.length
    ? p.earnings.slice(0, 3).map((e, i) => {
        const dt = fmtDatePrettyFromIso((e.date || "").toString()) || asOfPretty;
        return `E${i + 1} ${dt} Earnings`;
      }).join("\n")
    : "None provided";

  const tpl = (store && store.aiPromptTemplate) ? store.aiPromptTemplate : DEFAULT_AI_PROMPT_TEMPLATE;

  const vars = {
    "{{AS_OF}}": asOfPretty,
    "{{ASSET_TYPE}}": (p.assetType || "UNKNOWN").toString(),
    "{{DAY_PCT}}": fmtPct(m.dayPct, 2),
    "{{WEEK_PCT}}": fmtPct(m.weekPct, 2),
    "{{MONTH_PCT}}": fmtPct(m.monthPct, 2),
    "{{HEADLINES}}": headlines,
    "{{EARNINGS}}": earn,
  };

  let out = tpl;
  for (const [k, v] of Object.entries(vars)) out = out.split(k).join(v);
  return out;
}

/* ---------- Render orchestration ---------- */
function renderTableOnly() {
  getStore().then((store) => {
    store.columnOrder = normalizeColumnOrder(store.columnOrder || defaultColumnOrder(store), store);
    renderHeader(store);
    renderRows(LAST_ROWS, store);
    updateTotalsBox(store, LAST_ROWS);
  });
}

async function render(doFetch) {
  const seq = ++RENDER_SEQ;
  const store = await getStore();

  // Version label
  try {
    const v = chrome.runtime.getManifest().version;
    $("#ver").textContent = "· v" + v;
  } catch (e) {}

  // Cache
  CACHE = store.cache || {};

  store.columnOrder = normalizeColumnOrder(store.columnOrder || defaultColumnOrder(store), store);
  if (!store.columnOrder || !store.columnOrder.length) {
    store.columnOrder = defaultColumnOrder(store);
    await setStore({ columnOrder: store.columnOrder });
  }

  renderHeader(store);

  const symbols = getSymbolsFromStore(store);
  if (!symbols.length) {
    LAST_ROWS = [];
    renderRows([], store);
    updateTotalsBox(store, []);
    if (!STATUS_STICKY) setStatus("Done");
    return;
  }

  // Fast path: show snapshot immediately when doFetch is false
  if (!doFetch) {
    const snapRows = symbols
      .map((s) => (store.lastSnapshot && store.lastSnapshot[s]) ? store.lastSnapshot[s] : null)
      .filter(Boolean);
    if (snapRows.length) {
      LAST_ROWS = snapRows.map((r) => ({
        ...r,
        shares: Number(store.sharesBySymbol && store.sharesBySymbol[r.symbol]) || 0,
        value: Number.isFinite(r.price) ? (Number(store.sharesBySymbol && store.sharesBySymbol[r.symbol]) || 0) * r.price : NaN
      }));
      renderRows(LAST_ROWS, store);
    updateTotalsBox(store, LAST_ROWS);
    }
    if (!STATUS_STICKY) setStatus("Loading…");
    return;
  }

  if (!STATUS_STICKY) setStatus("Refreshing…");

  // Build rows with small concurrency for speed
  const rows = [];
  const limit = 4;
  let idx = 0;

  async function worker() {
    while (idx < symbols.length) {
      const i = idx++;
      const sym = symbols[i];
      const r = await buildRow(sym, store);
      rows[i] = r;
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(limit, symbols.length); i++) workers.push(worker());
  await Promise.all(workers);

  if (seq !== RENDER_SEQ) return; // stale render

  LAST_ROWS = rows;

  // Save snapshot for next open
  const snap = { ...(store.lastSnapshot || {}) };
  for (const r of rows) snap[r.symbol] = r;
  await setStore({ lastSnapshot: snap, cache: CACHE });

  renderRows(rows, store);
  updateTotalsBox(store, rows);
  if (!STATUS_STICKY) setStatus("Done");
}

/* ---------- Sponsor ---------- */
function pickSponsor() {
  // simple rotation (no tracking)
  return {
    logo: "P",
    name: "Public",
    tag: "Referral rewards vary. See current terms.",
    url: "https://public.com/"
  };
}

async function initSponsor() {
  const s = await getStore();
  if (s.sponsorHidden) return;

  const sp = pickSponsor();
  $("#sponsorLogo").textContent = sp.logo;
  $("#sponsorName").textContent = sp.name;
  $("#sponsorTag").textContent = sp.tag;
  $("#sponsorBox").style.display = "block";

  $("#sponsorOpen").addEventListener("click", () => chrome.tabs.create({ url: sp.url }));
  $("#sponsorClose").addEventListener("click", async () => {
    await setStore({ sponsorHidden: true });
    $("#sponsorBox").style.display = "none";
  });
}

/* ---------- Events ---------- */
async function openPrefs() {
  // MV3: open options page
  chrome.runtime.openOptionsPage();
}

async function init() {
  $("#add").addEventListener("click", async () => await addTicker($("#ticker").value));
  $("#refresh").addEventListener("click", async () => { STATUS_STICKY = null; await render(true); });
  $("#prefs").addEventListener("click", openPrefs);

  $("#ticker").addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      await addTicker($("#ticker").value);
    }
    if (e.key === "Escape") {
      clearSuggest();
    }
  });

  $("#ticker").addEventListener("input", () => {
    clearTimeout(SUGGEST_TIMER);
    SUGGEST_TIMER = setTimeout(updateSuggest, 180);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".inputwrap")) clearSuggest();
  });

  $("#status").addEventListener("click", clearStickyStatus);

  $("#aiClose").addEventListener("click", closeAiModal);
  $("#aiOk").addEventListener("click", closeAiModal);
  $("#aiCancel").addEventListener("click", () => {
    try { if (AI_ABORT) AI_ABORT.abort(); } catch (e) {}
  });
  $("#aiRun").addEventListener("click", async () => {
    if (!AI_LAST_SYMBOL) return;
    await showAiSummary(AI_LAST_SYMBOL);
  });
  $("#aiModal").addEventListener("click", (e) => {
    if (e.target.id === "aiModal") closeAiModal();
  });

  // First paint: snapshot, then refresh
  await render(false);
  setTimeout(() => render(true), 20);

  initSponsor();
}

document.addEventListener("DOMContentLoaded", init);
