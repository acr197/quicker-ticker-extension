// offscreen.js — All Yahoo Finance fetch logic lives here.
// The service worker creates this document; the sidepanel/popup
// sends messages to it via chrome.runtime.sendMessage.

const YAHOO_QUERY1 = 'https://query1.finance.yahoo.com';
const YAHOO_FEEDS  = 'https://feeds.finance.yahoo.com';
const STOOQ_BASE   = 'https://stooq.com';

// Known crypto base symbols. Kept in sync with shared/tickers.js CRYPTO_BASES.
// Duplicated here because offscreen.html does not load shared/tickers.js.
const CRYPTO_BASES = new Set([
  'BTC','ETH','SOL','DOGE','ADA','XRP','BNB','DOT','LTC','AVAX',
  'LINK','MATIC','TRX','SHIB','ATOM','UNI','ICP','ETC','FIL','APE',
  'NEAR','ALGO','XLM','HBAR','EOS','AAVE','MKR','CRV','LDO','ARB',
  'OP','SUI','APT','TON','PEPE','BCH','XMR','USDT','USDC','DAI',
  'FTM','XTZ','SAND','MANA','AXS','FLOW','CHZ','GRT','QNT','VET',
  'INJ','RNDR','IMX','STX','TIA','SEI','JUP','WIF','BONK','FET'
]);

function isCryptoSymbol(symbol) {
  if (!symbol) return false;
  const s = String(symbol).toUpperCase();
  const dashIdx = s.indexOf('-');
  const base = dashIdx >= 0 ? s.slice(0, dashIdx) : s;
  return CRYPTO_BASES.has(base);
}

// Short tickers that frequently collide with common English words in
// headlines. These must match on the asset name rather than the symbol alone.
const GENERIC_TICKERS = new Set([
  'A','I','IT','ON','OR','SO','BE','DO','GO','WE','HE','AN','AS','AT',
  'BY','IF','IN','IS','MY','NO','OF','OK','TO','UP','US','ALL','ANY',
  'ARE','CAN','FOR','GET','HAS','HER','HIS','HOW','NEW','NOW','ONE',
  'OUR','OUT','SEE','SHE','THE','TWO','WAS','WHO','WHY','YOU'
]);

const QUOTE_FIELDS = [
  'currency',
  'regularMarketPrice',
  'regularMarketChange',
  'regularMarketChangePercent',
  'shortName',
  'longName',
  'marketCap',
  'netAssets',
  'totalAssets',
  'quoteType',
  'regularMarketPreviousClose',
  'regularMarketOpen'
].join(',');

let cachedCrumb = null;

// ---------- Crumb ----------

async function fetchCrumb({ force = false } = {}) {
  if (cachedCrumb && !force) return cachedCrumb;
  try {
    const res = await fetch(`${YAHOO_QUERY1}/v1/test/getcrumb`, {
      credentials: 'include',
      headers: { 'Accept': 'text/plain' }
    });
    if (!res.ok) throw new Error(`crumb status ${res.status}`);
    const text = (await res.text()).trim();
    if (!text || text.length > 64) throw new Error('invalid crumb');
    cachedCrumb = text;
    return text;
  } catch (err) {
    cachedCrumb = null;
    throw err;
  }
}

// ---------- Quotes (batched) ----------

async function fetchQuotes(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) return {};
  // Yahoo handles ~20 symbols comfortably per call.
  const batches = [];
  for (let i = 0; i < symbols.length; i += 20) {
    batches.push(symbols.slice(i, i + 20));
  }
  const out = {};
  for (const batch of batches) {
    const data = await fetchQuoteBatch(batch);
    Object.assign(out, data);
  }
  return out;
}

async function fetchQuoteBatch(symbols, retried = false) {
  let crumb;
  try {
    crumb = await fetchCrumb();
  } catch {
    crumb = '';
  }
  const url = new URL(`${YAHOO_QUERY1}/v7/finance/quote`);
  url.searchParams.set('symbols', symbols.join(','));
  if (crumb) url.searchParams.set('crumb', crumb);
  url.searchParams.set('fields', QUOTE_FIELDS);

  const res = await fetch(url.toString(), { credentials: 'include' });
  if ((res.status === 401 || res.status === 404) && !retried) {
    await fetchCrumb({ force: true });
    return fetchQuoteBatch(symbols, true);
  }
  if (!res.ok) throw new Error(`quote status ${res.status}`);
  const json = await res.json();
  const list = (json && json.quoteResponse && json.quoteResponse.result) || [];
  const out = {};
  for (const q of list) {
    if (!q || !q.symbol) continue;
    // Unify "size" across asset types:
    //   * Equities + crypto  -> marketCap
    //   * ETFs + mutual funds -> netAssets (AUM), or totalAssets as fallback
    // The UI labels this "Market Cap" regardless of source.
    const size = numOrNull(q.marketCap)
      ?? numOrNull(q.netAssets)
      ?? numOrNull(q.totalAssets);
    out[q.symbol] = {
      symbol: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price: numOrNull(q.regularMarketPrice),
      change: numOrNull(q.regularMarketChange),
      changePct: numOrNull(q.regularMarketChangePercent),
      open: numOrNull(q.regularMarketOpen),
      prevClose: numOrNull(q.regularMarketPreviousClose),
      marketCap: size,
      quoteType: q.quoteType || null,
      currency: q.currency || 'USD',
      fetchedAt: Date.now()
    };
  }
  return out;
}

// ---------- Charts ----------

const RANGE_TO_PARAMS = {
  '1D': { interval: '5m',  range: '1d'  },
  '1W': { interval: '30m', range: '5d'  },
  '1M': { interval: '1d',  range: '1mo' },
  '3M': { interval: '1d',  range: '3mo' },
  '6M': { interval: '1d',  range: '6mo' },
  '1Y': { interval: '1d',  range: '1y'  }
};

async function fetchChart(symbol, range = '1D', retried = false) {
  const params = RANGE_TO_PARAMS[range] || RANGE_TO_PARAMS['1D'];
  const url = new URL(`${YAHOO_QUERY1}/v8/finance/chart/${encodeURIComponent(symbol)}`);
  // Crypto trades 24/7, so a calendar-day window mis-reports direction vs.
  // what sources like CoinMarketCap show. Use a rolling 24h window instead.
  if (range === '1D' && isCryptoSymbol(symbol)) {
    const nowSec = Math.floor(Date.now() / 1000);
    url.searchParams.set('interval', '5m');
    url.searchParams.set('period1', String(nowSec - 24 * 60 * 60));
    url.searchParams.set('period2', String(nowSec));
  } else {
    url.searchParams.set('interval', params.interval);
    url.searchParams.set('range', params.range);
  }

  let res;
  try {
    res = await fetch(url.toString(), { credentials: 'include' });
  } catch (err) {
    return fetchStooqFallback(symbol, range);
  }
  if ((res.status === 401 || res.status === 404) && !retried) {
    await fetchCrumb({ force: true }).catch(() => {});
    return fetchChart(symbol, range, true);
  }
  if (!res.ok) {
    return fetchStooqFallback(symbol, range);
  }
  const json = await res.json();
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) return fetchStooqFallback(symbol, range);

  const ts = result.timestamp || [];
  const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null) continue;
    points.push({ t: ts[i] * 1000, p: c });
  }
  return { symbol, range, points, fetchedAt: Date.now(), source: 'yahoo' };
}

async function fetchStooqFallback(symbol, range) {
  // Stooq uses lowercase + .us suffix for US tickers, no suffix for indices/forex.
  // Best-effort: try lowercase first, then lowercase + .us
  const candidates = [symbol.toLowerCase(), `${symbol.toLowerCase()}.us`];
  for (const cand of candidates) {
    try {
      const url = `${STOOQ_BASE}/q/d/l/?s=${encodeURIComponent(cand)}&i=d`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const text = await res.text();
      const lines = text.trim().split('\n').slice(1);
      if (lines.length === 0) continue;
      const points = [];
      for (const line of lines) {
        const cols = line.split(',');
        if (cols.length < 5) continue;
        const dt = Date.parse(cols[0]);
        const close = parseFloat(cols[4]);
        if (!isFinite(close) || isNaN(dt)) continue;
        points.push({ t: dt, p: close });
      }
      if (points.length === 0) continue;
      const limit = rangeDayLimit(range);
      const trimmed = limit ? points.slice(-limit) : points;
      return { symbol, range, points: trimmed, fetchedAt: Date.now(), source: 'stooq' };
    } catch {
      continue;
    }
  }
  return { symbol, range, points: [], fetchedAt: Date.now(), source: 'none', error: 'no data' };
}

function rangeDayLimit(range) {
  switch (range) {
    case '1W': return 7;
    case '1M': return 22;
    case '3M': return 66;
    case '6M': return 132;
    case '1Y': return 260;
    default:   return 0;
  }
}

// ---------- News ----------

async function fetchNews(symbol, name) {
  // Try JSON search endpoint first
  try {
    const url = new URL(`${YAHOO_QUERY1}/v1/finance/search`);
    url.searchParams.set('q', symbol);
    url.searchParams.set('quotesCount', '0');
    // Ask for more than we display so relevance filtering has headroom.
    url.searchParams.set('newsCount', '15');
    url.searchParams.set('lang', 'en-US');
    url.searchParams.set('region', 'US');
    const res = await fetch(url.toString(), { credentials: 'include' });
    if (res.ok) {
      const json = await res.json();
      const news = (json && json.news) || [];
      const raw = news.map((n) => {
        const link = typeof n.link === 'string' && n.link.startsWith('https://') ? n.link : '';
        let publisher = String(n.publisher || '').slice(0, 60);
        if (!publisher && link) publisher = sourceFromUrl(link);
        return {
          title: String(n.title || '').slice(0, 200),
          link,
          publisher,
          providerPublishTime: typeof n.providerPublishTime === 'number' ? n.providerPublishTime * 1000 : 0
        };
      }).filter((h) => h.title && h.link);
      const filtered = filterHeadlinesByRelevance(raw, symbol, name).slice(0, 5);
      if (filtered.length > 0) {
        return { symbol, headlines: filtered, fetchedAt: Date.now(), source: 'yahoo-json' };
      }
    }
  } catch {
    // fall through
  }
  // RSS fallback
  try {
    const url = `${YAHOO_FEEDS}/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
    const res = await fetch(url);
    if (res.ok) {
      const text = await res.text();
      const raw = parseRss(text);
      const filtered = filterHeadlinesByRelevance(raw, symbol, name).slice(0, 5);
      if (filtered.length > 0) {
        return { symbol, headlines: filtered, fetchedAt: Date.now(), source: 'yahoo-rss' };
      }
    }
  } catch {
    // fall through
  }
  return { symbol, headlines: [], fetchedAt: Date.now(), source: 'none' };
}

// ---------- News relevance filtering ----------

// Extract the most recognizable token from a company/asset name.
// "Apple Inc." -> "Apple", "Nvidia Corporation" -> "Nvidia",
// "Bitcoin USD" -> "Bitcoin".
function extractAssetToken(name) {
  if (!name || typeof name !== 'string') return '';
  const STOP = new Set([
    'inc','inc.','incorporated','corp','corp.','corporation','ltd','ltd.',
    'llc','plc','co','co.','company','holdings','holding','group','trust',
    'fund','etf','the','and','usd','usdt','n.v.','s.a.','sa','ag','ab',
    'se','class','cl','common','stock','shares','a','b','c'
  ]);
  const tokens = name.split(/[\s,.\-/()]+/).filter(Boolean);
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (STOP.has(t.toLowerCase())) continue;
    return t;
  }
  return '';
}

function hasWholeWordMatch(text, word) {
  if (!text || !word) return false;
  const escaped = String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:[^A-Za-z0-9]|$)`, 'i');
  return re.test(text);
}

// Filter + rank headlines by relevance to a ticker.
// An article qualifies if its title/publisher whole-word-matches either the
// asset name token OR the ticker symbol. Articles that only match a short/
// generic ticker string (e.g. "IT", "GO", "BTC" appearing as acronyms) are
// dropped — they need a name match to qualify.
function filterHeadlinesByRelevance(headlines, symbol, name) {
  if (!Array.isArray(headlines) || headlines.length === 0) return [];
  const sym = String(symbol || '').toUpperCase();
  const dashIdx = sym.indexOf('-');
  const symBase = dashIdx >= 0 ? sym.slice(0, dashIdx) : sym;
  const token = extractAssetToken(name);
  // A ticker is "generic" (prone to collisions with English words) only if
  // it's on the blocklist OR it's a very short symbol AND we also have an
  // asset name token to fall back on. Without a name token we can't apply
  // this filter without wiping out all results.
  const isGenericTicker = GENERIC_TICKERS.has(symBase)
    || (symBase.length <= 3 && !!token);

  const scored = [];
  for (const h of headlines) {
    const text = `${h.title || ''} ${h.publisher || ''}`;
    const nameMatch = token ? hasWholeWordMatch(text, token) : false;
    const symMatch = hasWholeWordMatch(text, symBase);
    if (!nameMatch && !symMatch) continue;
    // If only the symbol matches and it's a short/common string, treat it
    // as coincidental (e.g. "IT" in "IT sector", "GO" in "let's go") and drop.
    if (!nameMatch && symMatch && isGenericTicker) continue;
    // Score: prefer articles where the full asset name appears.
    const score = (nameMatch ? 2 : 0) + (symMatch ? 1 : 0);
    scored.push({ h, score });
  }
  // Stable-ish sort: higher score first, then preserve original order via
  // providerPublishTime (newest first) as a tiebreaker.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.h.providerPublishTime || 0) - (a.h.providerPublishTime || 0);
  });
  return scored.map((x) => x.h);
}

function parseRss(xmlText) {
  const out = [];
  // Naive but safe-enough: scan <item>…</item> blocks.
  const itemRe = /<item[\s\S]*?<\/item>/g;
  const titleRe = /<title>([\s\S]*?)<\/title>/;
  const linkRe  = /<link>([\s\S]*?)<\/link>/;
  const pubRe   = /<pubDate>([\s\S]*?)<\/pubDate>/;
  const srcRe   = /<source[^>]*>([\s\S]*?)<\/source>/;
  const items = xmlText.match(itemRe) || [];
  for (const item of items) {
    const t = item.match(titleRe);
    const l = item.match(linkRe);
    const p = item.match(pubRe);
    const s = item.match(srcRe);
    let title = t ? decodeXml(t[1]).trim() : '';
    let link  = l ? decodeXml(l[1]).trim() : '';
    let source = s ? decodeXml(s[1]).trim() : '';
    if (!title || !link) continue;
    if (!link.startsWith('https://')) continue;
    if (!source) source = sourceFromUrl(link);
    out.push({
      title: title.slice(0, 200),
      link,
      publisher: source.slice(0, 60),
      providerPublishTime: p ? Date.parse(p[1]) || 0 : 0
    });
  }
  return out;
}

// Derive a short human-readable source name from a URL.
// "https://finance.yahoo.com/…" -> "Yahoo"
// "https://www.bloomberg.com/…" -> "Bloomberg"
// "https://www.reuters.com/…"   -> "Reuters"
function sourceFromUrl(url) {
  try {
    const u = new URL(url);
    let host = u.hostname.replace(/^www\./, '');
    const parts = host.split('.');
    // Strip common subdomain prefixes so "finance.yahoo.com" -> "yahoo"
    const SKIP = new Set(['finance','news','money','business','investor','markets','marketwatch']);
    let name = parts[0];
    if (parts.length >= 2 && SKIP.has(parts[0])) name = parts[1];
    // Title case
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return '';
  }
}

function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------- AI insights (via Cloudflare Worker -> OpenAI) ----------

const AI_PROXY_URL = 'https://quicker-ticker-ai-proxy.acr197.workers.dev/';

async function fetchAiInsights(symbol, name) {
  const sym = String(symbol || '').toUpperCase();
  const assetName = String(name || '').trim();
  const label = assetName ? `${assetName} (${sym})` : sym;

  const systemMsg = [
    'You are a concise financial analyst assistant for a retail investor.',
    'Give objective, factual context only. Do NOT give personalized investment recommendations.',
    'Respond ONLY in the exact template provided. No intro, no outro, no extra prose.'
  ].join(' ');

  const userMsg = [
    `Provide a deeper-dive analysis for ${label} that goes beyond what's on Yahoo Finance.`,
    'Use the following EXACT template (preserve headings in all caps followed by a colon):',
    '',
    'PAST PERFORMANCE:',
    '2-3 sentences summarizing recent share-price performance, notable highs/lows, and the trend over the last 6-12 months.',
    '',
    'FUTURE OUTLOOK:',
    '3-4 sentences covering upcoming earnings call expectations, analyst estimates, potential devaluations or catalysts, sector tailwinds/headwinds, and any forward-looking factors a retail investor would not easily find on Yahoo Finance.',
    '',
    'ADVICE:',
    '- ONE short bullet point of general-education consideration (not a buy/sell recommendation).'
  ].join('\n');

  const body = {
    model: 'gpt-4o-mini',
    temperature: 0.4,
    messages: [
      { role: 'system', content: systemMsg },
      { role: 'user',   content: userMsg }
    ]
  };

  const res = await fetch(AI_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`AI service returned ${res.status}`);
  }
  const json = await res.json();
  // Tolerate several possible response shapes from the worker.
  const text =
    (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) ||
    (json && json.text) ||
    (json && json.content) ||
    (json && json.output_text) ||
    '';
  if (!text || typeof text !== 'string') {
    throw new Error('empty AI response');
  }
  return { symbol: sym, name: assetName, text: text.trim(), fetchedAt: Date.now() };
}

// ---------- Symbol search ----------

async function searchSymbols(query) {
  if (!query || typeof query !== 'string') return [];
  const url = new URL(`${YAHOO_QUERY1}/v1/finance/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('quotesCount', '8');
  url.searchParams.set('newsCount', '0');
  url.searchParams.set('lang', 'en-US');
  url.searchParams.set('region', 'US');
  try {
    const res = await fetch(url.toString(), { credentials: 'include' });
    if (!res.ok) return [];
    const json = await res.json();
    const quotes = (json && json.quotes) || [];
    return quotes.map((q) => ({
      symbol: q.symbol || '',
      name: q.shortname || q.longname || q.symbol || '',
      type: q.quoteType || '',
      exchange: q.exchDisp || ''
    })).filter((q) => q.symbol);
  } catch {
    return [];
  }
}

// ---------- Helpers ----------

function numOrNull(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

// ---------- Message routing ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  handleMessage(msg).then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // async
});

async function handleMessage(msg) {
  switch (msg.type) {
    case 'ping':
      return { pong: true };
    case 'fetchQuotes':
      return await fetchQuotes(msg.symbols || []);
    case 'fetchChart':
      return await fetchChart(msg.symbol, msg.range || '1D');
    case 'fetchNews':
      return await fetchNews(msg.symbol, msg.name);
    case 'fetchAiInsights':
      return await fetchAiInsights(msg.symbol, msg.name);
    case 'searchSymbols':
      return await searchSymbols(msg.query || '');
    case 'refreshCrumb':
      return await fetchCrumb({ force: true });
    default:
      throw new Error(`unknown message type: ${msg.type}`);
  }
}
