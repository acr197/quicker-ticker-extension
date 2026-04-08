// offscreen.js — All Yahoo Finance fetch logic lives here.
// The service worker creates this document; the sidepanel/popup
// sends messages to it via chrome.runtime.sendMessage.

const YAHOO_QUERY1 = 'https://query1.finance.yahoo.com';
const YAHOO_FEEDS  = 'https://feeds.finance.yahoo.com';
const STOOQ_BASE   = 'https://stooq.com';

const QUOTE_FIELDS = [
  'currency',
  'regularMarketPrice',
  'regularMarketChange',
  'regularMarketChangePercent',
  'shortName',
  'longName',
  'marketCap',
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
    out[q.symbol] = {
      symbol: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price: numOrNull(q.regularMarketPrice),
      change: numOrNull(q.regularMarketChange),
      changePct: numOrNull(q.regularMarketChangePercent),
      open: numOrNull(q.regularMarketOpen),
      prevClose: numOrNull(q.regularMarketPreviousClose),
      marketCap: q.marketCap || null,
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
  url.searchParams.set('interval', params.interval);
  url.searchParams.set('range', params.range);

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

async function fetchNews(symbol) {
  // Try JSON search endpoint first
  try {
    const url = new URL(`${YAHOO_QUERY1}/v1/finance/search`);
    url.searchParams.set('q', symbol);
    url.searchParams.set('quotesCount', '0');
    url.searchParams.set('newsCount', '5');
    url.searchParams.set('lang', 'en-US');
    url.searchParams.set('region', 'US');
    const res = await fetch(url.toString(), { credentials: 'include' });
    if (res.ok) {
      const json = await res.json();
      const news = (json && json.news) || [];
      const headlines = news.slice(0, 5).map((n) => ({
        title: String(n.title || '').slice(0, 200),
        link: typeof n.link === 'string' && n.link.startsWith('https://') ? n.link : '',
        publisher: String(n.publisher || '').slice(0, 60),
        providerPublishTime: typeof n.providerPublishTime === 'number' ? n.providerPublishTime * 1000 : 0
      })).filter((h) => h.title && h.link);
      if (headlines.length > 0) {
        return { symbol, headlines, fetchedAt: Date.now(), source: 'yahoo-json' };
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
      const headlines = parseRss(text).slice(0, 5);
      if (headlines.length > 0) {
        return { symbol, headlines, fetchedAt: Date.now(), source: 'yahoo-rss' };
      }
    }
  } catch {
    // fall through
  }
  return { symbol, headlines: [], fetchedAt: Date.now(), source: 'none' };
}

function parseRss(xmlText) {
  const out = [];
  // Naive but safe-enough: scan <item>…</item> blocks.
  const itemRe = /<item[\s\S]*?<\/item>/g;
  const titleRe = /<title>([\s\S]*?)<\/title>/;
  const linkRe  = /<link>([\s\S]*?)<\/link>/;
  const pubRe   = /<pubDate>([\s\S]*?)<\/pubDate>/;
  const items = xmlText.match(itemRe) || [];
  for (const item of items) {
    const t = item.match(titleRe);
    const l = item.match(linkRe);
    const p = item.match(pubRe);
    let title = t ? decodeXml(t[1]).trim() : '';
    let link  = l ? decodeXml(l[1]).trim() : '';
    if (!title || !link) continue;
    if (!link.startsWith('https://')) continue;
    out.push({
      title: title.slice(0, 200),
      link,
      publisher: '',
      providerPublishTime: p ? Date.parse(p[1]) || 0 : 0
    });
  }
  return out;
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
      return await fetchNews(msg.symbol);
    case 'searchSymbols':
      return await searchSymbols(msg.query || '');
    case 'refreshCrumb':
      return await fetchCrumb({ force: true });
    default:
      throw new Error(`unknown message type: ${msg.type}`);
  }
}
