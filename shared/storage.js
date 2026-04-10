// shared/storage.js — Centralized chrome.storage helpers.
// Loaded as a classic script (no ES modules) so it can be reused
// from sidepanel, popup, and options pages.

(function (root) {
  'use strict';

  // ---------- Defaults ----------

  const PREF_DEFAULTS = {
    enableGrouping: true,
    showGroupAverages: true,
    personalValue: false,
    aiSummaries: false,
    showCrypto: false,
    defaultView: 'sidepanel',
    darkMode: true,
    backupSourcesEnabled: false,
    finnhubKey: '',
    alphaVantageKey: '',
    coinGeckoKey: '',
    coinGeckoUseFreeTier: true,
    groups: ['Watchlist']
  };

  const LOCAL_DEFAULTS = {
    watchlist: [],
    priceCache: {},
    chartCache: {},
    newsCache: {},
    aiUsage: { count: 0, date: '' }
  };

  const AI_DAILY_LIMIT = 20;

  // ---------- Cache TTLs ----------

  const TTL = {
    QUOTE_MS: 5 * 60 * 1000,            // 5 min
    INTRADAY_CHART_MS: 5 * 60 * 1000,   // 5 min
    DAILY_CHART_MS: 60 * 60 * 1000,     // 1 hour
    NEWS_MS: 30 * 60 * 1000             // 30 min
  };

  // ---------- Preferences (sync) ----------

  function getPrefs() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(PREF_DEFAULTS, (items) => resolve(items));
    });
  }

  function setPrefs(partial) {
    return new Promise((resolve) => {
      chrome.storage.sync.set(partial, () => resolve());
    });
  }

  // ---------- Watchlist + cache (local) ----------

  function getLocal() {
    return new Promise((resolve) => {
      chrome.storage.local.get(LOCAL_DEFAULTS, (items) => resolve(items));
    });
  }

  function setLocal(partial) {
    return new Promise((resolve) => {
      chrome.storage.local.set(partial, () => resolve());
    });
  }

  function getWatchlist() {
    return getLocal().then((l) => l.watchlist || []);
  }

  function setWatchlist(list) {
    return setLocal({ watchlist: list });
  }

  // ---------- Price cache ----------

  function getCachedQuotes(symbols) {
    return getLocal().then((l) => {
      const cache = l.priceCache || {};
      const out = {};
      for (const s of symbols) {
        if (cache[s]) out[s] = cache[s];
      }
      return out;
    });
  }

  async function mergeQuoteCache(quotesBySymbol) {
    const local = await getLocal();
    const cache = Object.assign({}, local.priceCache || {});
    for (const sym of Object.keys(quotesBySymbol)) {
      cache[sym] = quotesBySymbol[sym];
    }
    await setLocal({ priceCache: cache });
  }

  function isQuoteFresh(entry) {
    if (!entry || !entry.fetchedAt) return false;
    return (Date.now() - entry.fetchedAt) < TTL.QUOTE_MS;
  }

  // ---------- Chart cache ----------

  function chartKey(symbol, range) {
    return `${symbol}_${range}`;
  }

  function getCachedChart(symbol, range) {
    return getLocal().then((l) => (l.chartCache || {})[chartKey(symbol, range)] || null);
  }

  async function setCachedChart(symbol, range, data) {
    const local = await getLocal();
    const cache = Object.assign({}, local.chartCache || {});
    cache[chartKey(symbol, range)] = data;
    await setLocal({ chartCache: cache });
  }

  function isChartFresh(entry, range) {
    if (!entry || !entry.fetchedAt) return false;
    const ttl = range === '1D' ? TTL.INTRADAY_CHART_MS : TTL.DAILY_CHART_MS;
    return (Date.now() - entry.fetchedAt) < ttl;
  }

  // ---------- News cache ----------

  function getCachedNews(symbol) {
    return getLocal().then((l) => (l.newsCache || {})[symbol] || null);
  }

  async function setCachedNews(symbol, data) {
    const local = await getLocal();
    const cache = Object.assign({}, local.newsCache || {});
    cache[symbol] = data;
    await setLocal({ newsCache: cache });
  }

  function isNewsFresh(entry) {
    if (!entry || !entry.fetchedAt) return false;
    return (Date.now() - entry.fetchedAt) < TTL.NEWS_MS;
  }

  // ---------- AI query usage tracking ----------

  // Returns the current date in Eastern Time as YYYY-MM-DD.
  // en-CA locale yields ISO-style YYYY-MM-DD output.
  function todayET() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  }

  // Reads aiUsage and resets the count if the stored date is not today (ET).
  async function readAiUsage() {
    const local = await getLocal();
    const usage = local.aiUsage || { count: 0, date: '' };
    const today = todayET();
    if (usage.date !== today) {
      return { count: 0, date: today, _stale: true };
    }
    return { count: usage.count || 0, date: usage.date, _stale: false };
  }

  async function getQueryCount() {
    const usage = await readAiUsage();
    if (usage._stale) {
      await setLocal({ aiUsage: { count: 0, date: usage.date } });
    }
    return usage.count;
  }

  async function incrementQueryCount() {
    const usage = await readAiUsage();
    const next = { count: usage.count + 1, date: usage.date };
    await setLocal({ aiUsage: next });
    return next.count;
  }

  async function getRemainingQueries() {
    const count = await getQueryCount();
    return Math.max(0, AI_DAILY_LIMIT - count);
  }

  // ---------- Bulk export / import / clear ----------

  async function exportAll() {
    const [prefs, local] = await Promise.all([getPrefs(), getLocal()]);
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      prefs,
      watchlist: local.watchlist || []
    };
  }

  async function importAll(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid payload');
    if (Array.isArray(payload.watchlist)) {
      const sanitized = payload.watchlist
        .filter((t) => t && typeof t.symbol === 'string')
        .map((t, i) => ({
          symbol: String(t.symbol).toUpperCase().slice(0, 16),
          name: typeof t.name === 'string' ? t.name.slice(0, 100) : '',
          group: typeof t.group === 'string' ? t.group.slice(0, 60) : 'Watchlist',
          shares: typeof t.shares === 'number' && isFinite(t.shares) ? t.shares : 0,
          order: typeof t.order === 'number' ? t.order : i
        }));
      await setLocal({ watchlist: sanitized });
    }
    if (payload.prefs && typeof payload.prefs === 'object') {
      const allowed = {};
      for (const k of Object.keys(PREF_DEFAULTS)) {
        if (k in payload.prefs) allowed[k] = payload.prefs[k];
      }
      await setPrefs(allowed);
    }
  }

  async function clearAll() {
    return new Promise((resolve) => {
      chrome.storage.local.clear(() => {
        chrome.storage.sync.clear(() => resolve());
      });
    });
  }

  // ---------- Public API ----------

  root.QTStorage = {
    PREF_DEFAULTS,
    TTL,
    AI_DAILY_LIMIT,
    getPrefs,
    setPrefs,
    getLocal,
    setLocal,
    getWatchlist,
    setWatchlist,
    getCachedQuotes,
    mergeQuoteCache,
    isQuoteFresh,
    getCachedChart,
    setCachedChart,
    isChartFresh,
    getCachedNews,
    setCachedNews,
    isNewsFresh,
    getQueryCount,
    incrementQueryCount,
    getRemainingQueries,
    exportAll,
    importAll,
    clearAll
  };
})(typeof window !== 'undefined' ? window : globalThis);
