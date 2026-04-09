// shared/ui.js — UI logic shared between sidepanel.js and popup.js.
// The HTML structures are identical; only the CSS sizing differs.
//
// Public entry point:
//   QTUI.init({ root: HTMLElement })
//
// This module assumes QTStorage, QTTickers, QTConfig, and QTChart are
// already loaded as classic scripts on the page.

(function (root) {
  'use strict';

  const Storage  = root.QTStorage;
  const Tickers  = root.QTTickers;
  const Config   = root.QTConfig;
  const Chart    = root.QTChart;

  const RANGES = ['1D', '1W', '1M', '3M', '6M', '1Y'];

  // Per-instance state.
  function createState() {
    return {
      el: null,
      prefs: null,
      watchlist: [],
      quotes: {},
      expandedSymbol: null,
      expandedRange: '1D',
      searchTimer: null
    };
  }

  // ---------- Public init ----------

  async function init(opts) {
    const state = createState();
    state.el = opts.root || document.body;
    bindStaticHandlers(state);
    await reload(state);
    listenStorageChanges(state);
    return state;
  }

  function listenStorageChanges(state) {
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area === 'sync' && (changes.enableGrouping || changes.showGroupAverages || changes.personalValue || changes.showCrypto || changes.groups)) {
        state.prefs = await Storage.getPrefs();
        renderWatchlist(state);
      }
      if (area === 'local' && changes.watchlist) {
        state.watchlist = changes.watchlist.newValue || [];
        renderWatchlist(state);
      }
    });
  }

  // ---------- Static handlers (header buttons, search, bonuses) ----------

  function bindStaticHandlers(state) {
    const r = state.el;
    qs(r, '#qt-refresh').addEventListener('click', () => refreshAll(state));
    qs(r, '#qt-settings').addEventListener('click', () => {
      chrome.runtime.sendMessage({ target: 'background', type: 'openOptions' });
    });
    const search = qs(r, '#qt-search');
    search.addEventListener('input', () => onSearchInput(state, search.value));
    search.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const sym = search.value.trim().toUpperCase();
        if (sym) addSymbol(state, sym, '');
      }
    });
    document.addEventListener('click', (ev) => {
      const dropdown = qs(r, '#qt-search-dropdown');
      if (!dropdown) return;
      if (ev.target === search) return;
      if (dropdown.contains(ev.target)) return;
      dropdown.classList.remove('open');
    });
    const bonusesBtn = qs(r, '#qt-bonuses-toggle');
    bonusesBtn.addEventListener('click', () => toggleBonuses(state));

    // Today's date
    const dateEl = qs(r, '#qt-date');
    dateEl.textContent = formatToday();

    // Version
    const ver = chrome.runtime.getManifest && chrome.runtime.getManifest();
    const verEl = qs(r, '#qt-version');
    if (verEl && ver) verEl.textContent = `v${ver.version}`;
  }

  // ---------- Reload pipeline ----------

  async function reload(state) {
    state.prefs = await Storage.getPrefs();
    state.watchlist = await Storage.getWatchlist();
    const symbols = state.watchlist.map((t) => t.symbol);

    // Render cached quotes immediately for fast paint.
    const cached = await Storage.getCachedQuotes(symbols);
    state.quotes = cached;
    renderWatchlist(state);

    // Then fetch fresh data in the background.
    if (symbols.length === 0) return;
    try {
      const fresh = await callOffscreen('fetchQuotes', { symbols });
      if (fresh && typeof fresh === 'object') {
        state.quotes = Object.assign({}, state.quotes, fresh);
        await Storage.mergeQuoteCache(fresh);
        // Persist any newly-discovered names back into the watchlist.
        let dirty = false;
        for (const t of state.watchlist) {
          const q = fresh[t.symbol];
          if (q && q.name && !t.name) { t.name = q.name; dirty = true; }
        }
        if (dirty) await Storage.setWatchlist(state.watchlist);
        renderWatchlist(state);
      }
    } catch (err) {
      // Show stale data as-is. The "stale" indicator handles this.
      // eslint-disable-next-line no-console
      console.warn('[QuickerTicker] quote fetch failed', err && err.message);
    }
  }

  async function refreshAll(state) {
    const btn = qs(state.el, '#qt-refresh');
    btn.classList.add('spinning');
    try {
      await reload(state);
    } finally {
      setTimeout(() => btn.classList.remove('spinning'), 400);
    }
  }

  // ---------- Watchlist rendering ----------

  function renderWatchlist(state) {
    const list = qs(state.el, '#qt-list');
    list.textContent = '';

    if (!state.watchlist || state.watchlist.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'qt-empty';
      empty.textContent = 'No tickers yet. Search above to add one.';
      list.appendChild(empty);
      renderTotalRow(state);
      return;
    }

    const grouping = !!(state.prefs && state.prefs.enableGrouping);
    const groups = grouping
      ? Tickers.groupBy(state.watchlist, state.prefs.groups || ['Watchlist'])
      : [{ name: '', tickers: state.watchlist }];

    for (const group of groups) {
      if (group.tickers.length === 0 && !grouping) continue;
      if (group.tickers.length === 0) continue;
      if (grouping && group.name) {
        list.appendChild(renderGroupHeader(state, group));
      }
      for (let i = 0; i < group.tickers.length; i++) {
        const t = group.tickers[i];
        const isExpanded = state.expandedSymbol === t.symbol;
        list.appendChild(renderTickerRow(state, t, group, i, isExpanded));
        if (isExpanded) list.appendChild(renderExpansion(state, t));
      }
    }

    renderTotalRow(state);
  }

  function renderGroupHeader(state, group) {
    const row = document.createElement('div');
    row.className = 'qt-group';

    const name = document.createElement('div');
    name.className = 'qt-group-name';
    name.textContent = group.name;
    row.appendChild(name);

    if (state.prefs && state.prefs.showGroupAverages) {
      const avg = computeGroupAverage(state, group.tickers);
      if (avg !== null) {
        const pill = document.createElement('div');
        pill.className = 'qt-pill ' + (avg >= 0 ? 'pos' : 'neg');
        pill.textContent = (avg >= 0 ? '+' : '') + avg.toFixed(2) + '%';
        row.appendChild(pill);
      }
    }
    return row;
  }

  function computeGroupAverage(state, tickers) {
    let sum = 0, n = 0;
    for (const t of tickers) {
      const q = state.quotes[t.symbol];
      if (q && typeof q.changePct === 'number') { sum += q.changePct; n++; }
    }
    if (n === 0) return null;
    return sum / n;
  }

  function renderTickerRow(state, ticker, group, indexInGroup, isExpanded) {
    const row = document.createElement('div');
    row.className = 'qt-row' + (isExpanded ? ' expanded' : '');
    row.setAttribute('data-symbol', ticker.symbol);
    row.setAttribute('role', 'button');
    row.tabIndex = 0;

    // Up/down arrows column (only when grouping enabled and group has 2+)
    if (state.prefs && state.prefs.enableGrouping && group.tickers.length > 1) {
      const arrows = document.createElement('div');
      arrows.className = 'qt-arrows';
      const up = makeArrowBtn('▲', indexInGroup === 0, async (ev) => {
        ev.stopPropagation();
        await Tickers.move(ticker.symbol, 'up');
      });
      const down = makeArrowBtn('▼', indexInGroup === group.tickers.length - 1, async (ev) => {
        ev.stopPropagation();
        await Tickers.move(ticker.symbol, 'down');
      });
      arrows.appendChild(up);
      arrows.appendChild(down);
      row.appendChild(arrows);
    }

    // Symbol + name
    const left = document.createElement('div');
    left.className = 'qt-row-left';
    const sym = document.createElement('div');
    sym.className = 'qt-sym';
    sym.textContent = ticker.symbol;
    left.appendChild(sym);
    const nm = document.createElement('div');
    nm.className = 'qt-name';
    nm.textContent = (ticker.name || '').slice(0, 24);
    left.appendChild(nm);
    row.appendChild(left);

    // Sparkline
    const spark = document.createElement('div');
    spark.className = 'qt-spark-cell';
    const q = state.quotes[ticker.symbol];
    const sparkPoints = synthesizeSparkPoints(q);
    if (sparkPoints) {
      const positive = (q && typeof q.changePct === 'number') ? q.changePct >= 0 : true;
      spark.appendChild(Chart.sparkline(sparkPoints, { positive }));
    }
    row.appendChild(spark);

    // Right: price + pct pill (and value if personalValue on)
    const right = document.createElement('div');
    right.className = 'qt-row-right';
    const priceLine = document.createElement('div');
    priceLine.className = 'qt-price';
    if (q && q.price != null) {
      priceLine.textContent = formatPrice(q.price) + ' ' + (q.currency || 'USD');
    } else {
      priceLine.textContent = '— —';
      priceLine.classList.add('stale');
    }
    right.appendChild(priceLine);

    if (q && typeof q.changePct === 'number') {
      const pill = document.createElement('div');
      pill.className = 'qt-pill ' + (q.changePct >= 0 ? 'pos' : 'neg');
      pill.textContent = (q.changePct >= 0 ? '+' : '') + q.changePct.toFixed(2) + '%';
      right.appendChild(pill);
    }

    if (state.prefs && state.prefs.personalValue) {
      const sharesWrap = document.createElement('div');
      sharesWrap.className = 'qt-shares-wrap';
      const sharesInput = document.createElement('input');
      sharesInput.type = 'number';
      sharesInput.min = '0';
      sharesInput.step = 'any';
      sharesInput.className = 'qt-shares';
      sharesInput.placeholder = 'Sha';
      sharesInput.value = ticker.shares ? String(ticker.shares) : '';
      sharesInput.addEventListener('click', (ev) => ev.stopPropagation());
      sharesInput.addEventListener('change', async () => {
        await Tickers.setShares(ticker.symbol, parseFloat(sharesInput.value || '0'));
      });
      sharesWrap.appendChild(sharesInput);
      right.appendChild(sharesWrap);
    }

    row.appendChild(right);

    // Click + keyboard expand
    row.addEventListener('click', () => toggleExpand(state, ticker.symbol));
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        toggleExpand(state, ticker.symbol);
      }
    });

    return row;
  }

  function makeArrowBtn(label, disabled, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qt-arrow';
    btn.textContent = label;
    if (disabled) btn.disabled = true;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function synthesizeSparkPoints(q) {
    // We don't have intraday points for the collapsed row; build a tiny
    // 2-point line from prevClose -> price so the row still shows direction.
    if (!q || q.price == null || q.prevClose == null) return null;
    return [{ t: 0, p: q.prevClose }, { t: 1, p: q.price }];
  }

  // ---------- Expansion ----------

  async function toggleExpand(state, symbol) {
    if (state.expandedSymbol === symbol) {
      state.expandedSymbol = null;
    } else {
      state.expandedSymbol = symbol;
      state.expandedRange = '1D';
    }
    renderWatchlist(state);
    if (state.expandedSymbol) {
      await loadExpansionData(state, symbol, '1D');
    }
  }

  function renderExpansion(state, ticker) {
    const wrap = document.createElement('div');
    wrap.className = 'qt-expansion';

    const chartBox = document.createElement('div');
    chartBox.className = 'qt-chart-box';
    chartBox.setAttribute('data-chart-for', ticker.symbol);
    chartBox.textContent = 'Loading chart…';
    wrap.appendChild(chartBox);

    const ranges = document.createElement('div');
    ranges.className = 'qt-ranges';
    const isCrypto = Tickers.isCryptoSymbol(ticker.symbol);
    for (const r of RANGES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      // Crypto trades 24/7, so the "1D" window is really a rolling 24h.
      btn.textContent = (r === '1D' && isCrypto) ? '24H' : r;
      btn.className = 'qt-range' + (r === state.expandedRange ? ' active' : '');
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        state.expandedRange = r;
        // Update active state
        const all = ranges.querySelectorAll('.qt-range');
        all.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        await loadExpansionData(state, ticker.symbol, r);
      });
      ranges.appendChild(btn);
    }
    wrap.appendChild(ranges);

    const stats = document.createElement('div');
    stats.className = 'qt-stats';
    stats.setAttribute('data-stats-for', ticker.symbol);
    stats.appendChild(makeStat('Change', ''));
    stats.appendChild(makeStat('Prev Close', ''));
    stats.appendChild(makeStat('Open', ''));
    stats.appendChild(makeStat('Market Cap', ''));
    wrap.appendChild(stats);

    fillStats(state, stats, ticker.symbol);

    const newsHeader = document.createElement('div');
    newsHeader.className = 'qt-news-header';
    newsHeader.textContent = 'News';
    wrap.appendChild(newsHeader);

    const news = document.createElement('div');
    news.className = 'qt-news';
    news.setAttribute('data-news-for', ticker.symbol);
    news.textContent = 'Loading…';
    wrap.appendChild(news);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'qt-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      state.expandedSymbol = null;
      await Tickers.remove(ticker.symbol);
    });
    wrap.appendChild(removeBtn);

    return wrap;
  }

  function makeStat(label, value) {
    const cell = document.createElement('div');
    cell.className = 'qt-stat';
    const l = document.createElement('div');
    l.className = 'qt-stat-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'qt-stat-value';
    v.textContent = value || '—';
    cell.appendChild(l);
    cell.appendChild(v);
    return cell;
  }

  function fillStats(state, statsEl, symbol) {
    const q = state.quotes[symbol];
    const cells = statsEl.querySelectorAll('.qt-stat .qt-stat-value');
    if (!q) return;
    if (cells[0]) cells[0].textContent = (q.change != null)
      ? (q.change >= 0 ? '+' : '') + q.change.toFixed(2) + ' (' + (q.changePct >= 0 ? '+' : '') + q.changePct.toFixed(2) + '%)'
      : '—';
    if (cells[1]) cells[1].textContent = q.prevClose != null ? formatPrice(q.prevClose) : '—';
    if (cells[2]) cells[2].textContent = q.open != null ? formatPrice(q.open) : '—';
    if (cells[3]) cells[3].textContent = q.marketCap != null ? formatMarketCap(q.marketCap) : '—';

    if (q.change != null) {
      cells[0].classList.add(q.change >= 0 ? 'pos' : 'neg');
    }
  }

  function fadeOut(el) {
    el.classList.add('qt-chart-loading');
  }
  function fadeIn(el) {
    // Double rAF ensures the browser has painted the opacity:0 frame
    // before we remove the class, triggering the CSS transition to opacity:1.
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('qt-chart-loading')));
  }

  async function loadExpansionData(state, symbol, range) {
    // Chart
    const chartBox = qs(state.el, `[data-chart-for="${cssEscape(symbol)}"]`);
    if (chartBox) {
      fadeOut(chartBox);
      const cached = await Storage.getCachedChart(symbol, range);
      if (cached && Storage.isChartFresh(cached, range)) {
        renderExpansionChart(state, chartBox, cached.points, symbol);
        fadeIn(chartBox);
      } else {
        chartBox.textContent = 'Loading chart…';
        fadeIn(chartBox);
      }
      try {
        const fresh = await callOffscreen('fetchChart', { symbol, range });
        if (fresh && fresh.points) {
          await Storage.setCachedChart(symbol, range, fresh);
          // Only render if we're still expanded on the same symbol + range
          if (state.expandedSymbol === symbol && state.expandedRange === range) {
            fadeOut(chartBox);
            // Let the fade-out frame render before swapping content
            await new Promise((r) => requestAnimationFrame(r));
            renderExpansionChart(state, chartBox, fresh.points, symbol);
            fadeIn(chartBox);
          }
        }
      } catch (err) {
        if (!cached) {
          chartBox.textContent = 'Could not load chart.';
          fadeIn(chartBox);
        }
      }
    }

    // News
    const newsBox = qs(state.el, `[data-news-for="${cssEscape(symbol)}"]`);
    if (newsBox && range === '1D') {
      // Load news once per expansion (not per range). Pass the asset name
      // so offscreen can filter out articles that only coincidentally
      // contain the ticker as a substring.
      const q = state.quotes[symbol];
      const ticker = state.watchlist.find((t) => t.symbol === symbol);
      const name = (q && q.name) || (ticker && ticker.name) || '';
      const cachedNews = await Storage.getCachedNews(symbol);
      if (cachedNews && Storage.isNewsFresh(cachedNews)) {
        renderNews(newsBox, cachedNews.headlines || []);
      }
      try {
        const freshNews = await callOffscreen('fetchNews', { symbol, name });
        if (freshNews && freshNews.headlines) {
          await Storage.setCachedNews(symbol, freshNews);
          if (state.expandedSymbol === symbol) {
            renderNews(newsBox, freshNews.headlines || []);
          }
        }
      } catch {
        if (!cachedNews) newsBox.textContent = 'Could not load news.';
      }
    }
  }

  function renderExpansionChart(state, container, points, symbol) {
    const q = state.quotes[symbol];
    const positive = q && typeof q.changePct === 'number' ? q.changePct >= 0 : true;
    Chart.lineChart(container, points, { positive });
  }

  function renderNews(container, headlines) {
    container.textContent = '';
    if (!headlines || headlines.length === 0) {
      container.textContent = 'No recent news.';
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'qt-news-list';
    for (const h of headlines.slice(0, 5)) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#';
      a.title = h.title;
      const dateStr = formatNewsDate(h.providerPublishTime);
      if (dateStr) {
        const dateEl = document.createElement('span');
        dateEl.className = 'qt-news-date';
        dateEl.textContent = dateStr + ' ';
        a.appendChild(dateEl);
      }
      a.appendChild(document.createTextNode(h.title));
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        Config.safeOpen(h.link);
      });
      li.appendChild(a);
      ul.appendChild(li);
    }
    container.appendChild(ul);
  }

  function formatNewsDate(ts) {
    if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}.${m}.${day}`;
  }

  // ---------- Total row ----------

  function renderTotalRow(state) {
    const totalRow = qs(state.el, '#qt-total');
    if (!state.prefs || !state.prefs.personalValue) {
      totalRow.style.display = 'none';
      return;
    }
    let total = 0, hasAny = false;
    for (const t of state.watchlist) {
      const q = state.quotes[t.symbol];
      if (q && q.price != null && t.shares > 0) {
        total += q.price * t.shares;
        hasAny = true;
      }
    }
    if (!hasAny) {
      totalRow.style.display = 'none';
      return;
    }
    totalRow.style.display = '';
    qs(totalRow, '.qt-total-value').textContent = formatPrice(total) + ' USD';
  }

  // ---------- Search & autocomplete ----------

  function onSearchInput(state, raw) {
    if (state.searchTimer) clearTimeout(state.searchTimer);
    const q = raw.trim();
    if (q.length < 1) {
      const dd = qs(state.el, '#qt-search-dropdown');
      dd.classList.remove('open');
      dd.textContent = '';
      return;
    }
    state.searchTimer = setTimeout(() => doSearch(state, q), 300);
  }

  async function doSearch(state, query) {
    try {
      const results = await callOffscreen('searchSymbols', { query });
      const filtered = filterSearchResults(state, results || []);
      renderSearchDropdown(state, filtered);
    } catch (err) {
      // Show nothing on failure; user can still press Enter to add raw symbol.
    }
  }

  function filterSearchResults(state, results) {
    const showCrypto = !!(state.prefs && state.prefs.showCrypto);
    return results.filter((r) => {
      if (!r || !r.symbol) return false;
      if (!showCrypto && r.type === 'CRYPTOCURRENCY') return false;
      return true;
    }).slice(0, 8);
  }

  function renderSearchDropdown(state, results) {
    const dd = qs(state.el, '#qt-search-dropdown');
    dd.textContent = '';
    if (!results || results.length === 0) {
      dd.classList.remove('open');
      return;
    }
    for (const r of results) {
      const item = document.createElement('div');
      item.className = 'qt-search-item';
      const sym = document.createElement('div');
      sym.className = 'qt-search-sym';
      sym.textContent = r.symbol;
      const name = document.createElement('div');
      name.className = 'qt-search-name';
      name.textContent = r.name + (r.exchange ? ' · ' + r.exchange : '');
      item.appendChild(sym);
      item.appendChild(name);
      item.addEventListener('click', () => {
        addSymbol(state, r.symbol, r.name);
      });
      dd.appendChild(item);
    }
    dd.classList.add('open');
  }

  async function addSymbol(state, symbol, name) {
    try {
      await Tickers.add(symbol, name);
      const search = qs(state.el, '#qt-search');
      search.value = '';
      const dd = qs(state.el, '#qt-search-dropdown');
      dd.classList.remove('open');
      dd.textContent = '';
      // Trigger fresh quote fetch
      try {
        const fresh = await callOffscreen('fetchQuotes', { symbols: [symbol] });
        if (fresh) {
          state.quotes = Object.assign({}, state.quotes, fresh);
          await Storage.mergeQuoteCache(fresh);
          renderWatchlist(state);
        }
      } catch {
        // ignore
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[QuickerTicker] add failed', err && err.message);
    }
  }

  // ---------- Bonuses panel ----------

  function toggleBonuses(state) {
    const panel = qs(state.el, '#qt-bonuses-panel');
    const btn = qs(state.el, '#qt-bonuses-toggle');
    const isOpen = panel.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(isOpen));
    if (isOpen && panel.children.length === 0) {
      buildBonusesPanel(state, panel);
    }
  }

  function buildBonusesPanel(state, panel) {
    panel.textContent = '';

    const disclosure = document.createElement('div');
    disclosure.className = 'qt-disclosure';
    disclosure.textContent = Config.DISCLOSURE;
    panel.appendChild(disclosure);

    panel.appendChild(buildOfferSection('Brokerages', Config.BROKERAGE_OFFERS));
    panel.appendChild(buildOfferSection('Research tools', Config.RESEARCH_OFFERS));

    if (state.prefs && state.prefs.showCrypto) {
      panel.appendChild(buildOfferSection('Crypto exchanges', Config.CRYPTO_OFFERS));
    }
  }

  function buildOfferSection(title, offers) {
    const wrap = document.createElement('div');
    wrap.className = 'qt-offer-section';
    const h = document.createElement('div');
    h.className = 'qt-offer-section-title';
    h.textContent = title;
    wrap.appendChild(h);
    for (const o of offers) {
      wrap.appendChild(buildOfferCard(o));
    }
    return wrap;
  }

  function buildOfferCard(offer) {
    const card = document.createElement('div');
    card.className = 'qt-offer-card';

    const logo = document.createElement('div');
    logo.className = 'qt-offer-logo';
    logo.textContent = offer.name.charAt(0);
    logo.style.backgroundColor = offer.accent || '#2a2a2a';
    card.appendChild(logo);

    const body = document.createElement('div');
    body.className = 'qt-offer-body';
    const name = document.createElement('div');
    name.className = 'qt-offer-name';
    name.textContent = offer.name;
    const blurb = document.createElement('div');
    blurb.className = 'qt-offer-blurb';
    blurb.textContent = offer.blurb;
    const terms = document.createElement('div');
    terms.className = 'qt-offer-terms';
    terms.textContent = 'Rewards vary. See current terms at their site.';
    body.appendChild(name);
    body.appendChild(blurb);
    body.appendChild(terms);
    card.appendChild(body);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qt-offer-btn';
    btn.textContent = 'Open offer →';
    btn.addEventListener('click', () => Config.safeOpen(offer.url));
    card.appendChild(btn);

    return card;
  }

  // ---------- Helpers ----------

  function callOffscreen(subtype, payload) {
    return new Promise((resolve, reject) => {
      const msg = Object.assign({ target: 'background', type: 'forwardToOffscreen', subtype }, payload || {});
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp) {
          reject(new Error('no response'));
          return;
        }
        if (resp.ok) resolve(resp.data);
        else reject(new Error(resp.error || 'unknown error'));
      });
    });
  }

  function qs(scope, sel) {
    return scope.querySelector(sel);
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function formatPrice(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    if (n >= 1000) return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (n >= 1)    return n.toFixed(2);
    return n.toFixed(4);
  }

  function formatMarketCap(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    const absN = Math.abs(n);
    if (absN >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (absN >= 1e9)  return (n / 1e9).toFixed(2)  + 'B';
    if (absN >= 1e6)  return (n / 1e6).toFixed(2)  + 'M';
    return n.toLocaleString();
  }

  function formatToday() {
    const d = new Date();
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  root.QTUI = { init };
})(typeof window !== 'undefined' ? window : globalThis);
