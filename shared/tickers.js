// shared/tickers.js — Watchlist data model.
// All mutations go through here so the storage shape stays consistent.

(function (root) {
  'use strict';

  const SYMBOL_RE = /^[A-Z0-9._\-^=]{1,16}$/;

  // Known crypto base symbols. Used to detect crypto tickers so the
  // UI can show a rolling 24h window instead of a calendar-day window.
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

  function normalizeSymbol(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim().toUpperCase();
  }

  function isValidSymbol(sym) {
    return SYMBOL_RE.test(sym);
  }

  function makeTicker(symbol, name = '', group = 'Watchlist') {
    return {
      symbol: normalizeSymbol(symbol),
      name: String(name || '').slice(0, 100),
      group: String(group || 'Watchlist').slice(0, 60),
      shares: 0,
      order: 0
    };
  }

  function findIndex(list, symbol) {
    const sym = normalizeSymbol(symbol);
    return list.findIndex((t) => t.symbol === sym);
  }

  async function add(symbol, name, group) {
    const sym = normalizeSymbol(symbol);
    if (!isValidSymbol(sym)) throw new Error('invalid symbol');
    const list = await root.QTStorage.getWatchlist();
    if (findIndex(list, sym) !== -1) return list;
    const targetGroup = group || (list[0] && list[0].group) || 'Watchlist';
    const next = list.concat([makeTicker(sym, name, targetGroup)]);
    reindex(next);
    await root.QTStorage.setWatchlist(next);
    return next;
  }

  async function remove(symbol) {
    const sym = normalizeSymbol(symbol);
    const list = await root.QTStorage.getWatchlist();
    const next = list.filter((t) => t.symbol !== sym);
    reindex(next);
    await root.QTStorage.setWatchlist(next);
    return next;
  }

  async function setShares(symbol, shares) {
    const sym = normalizeSymbol(symbol);
    const n = Number(shares);
    const safe = isFinite(n) && n >= 0 ? n : 0;
    const list = await root.QTStorage.getWatchlist();
    const i = findIndex(list, sym);
    if (i === -1) return list;
    list[i] = Object.assign({}, list[i], { shares: safe });
    await root.QTStorage.setWatchlist(list);
    return list;
  }

  async function setGroup(symbol, group) {
    const sym = normalizeSymbol(symbol);
    const list = await root.QTStorage.getWatchlist();
    const i = findIndex(list, sym);
    if (i === -1) return list;
    list[i] = Object.assign({}, list[i], { group: String(group || 'Watchlist').slice(0, 60) });
    reindex(list);
    await root.QTStorage.setWatchlist(list);
    return list;
  }

  async function move(symbol, direction) {
    const sym = normalizeSymbol(symbol);
    const list = await root.QTStorage.getWatchlist();
    const i = findIndex(list, sym);
    if (i === -1) return list;
    const target = list[i];
    // Move within the same group only.
    const groupIndices = list
      .map((t, idx) => ({ t, idx }))
      .filter((x) => x.t.group === target.group)
      .map((x) => x.idx);
    const posInGroup = groupIndices.indexOf(i);
    const swapWithGroupPos = direction === 'up' ? posInGroup - 1 : posInGroup + 1;
    if (swapWithGroupPos < 0 || swapWithGroupPos >= groupIndices.length) return list;
    const j = groupIndices[swapWithGroupPos];
    [list[i], list[j]] = [list[j], list[i]];
    reindex(list);
    await root.QTStorage.setWatchlist(list);
    return list;
  }

  function reindex(list) {
    for (let i = 0; i < list.length; i++) list[i].order = i;
    return list;
  }

  function groupBy(list, groups) {
    // Returns [{ name, tickers }] in the order defined by `groups`,
    // followed by any unknown groups found in the list.
    const map = new Map();
    for (const g of groups || []) map.set(g, []);
    for (const t of list) {
      const g = t.group || 'Watchlist';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(t);
    }
    const out = [];
    for (const [name, tickers] of map.entries()) {
      out.push({ name, tickers });
    }
    return out;
  }

  root.QTTickers = {
    SYMBOL_RE,
    CRYPTO_BASES,
    isCryptoSymbol,
    normalizeSymbol,
    isValidSymbol,
    makeTicker,
    add,
    remove,
    setShares,
    setGroup,
    move,
    groupBy
  };
})(typeof window !== 'undefined' ? window : globalThis);
