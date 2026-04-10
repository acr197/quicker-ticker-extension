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
      searchTimer: null,
      dragFrom: null,       // symbol of ticker row being dragged
      dragFromGroup: null,  // group name of group header being dragged
      renderGen: 0,         // incremented on every renderWatchlist, used to
                             // discard stale async sparkline updates so the
                             // chart doesn't briefly revert to a flat line
      renderScheduled: false // coalesces rapid-fire storage events into
                             // a single render per animation frame
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
      let dirty = false;
      if (area === 'sync' && (changes.enableGrouping || changes.showGroupAverages || changes.personalValue || changes.showCrypto || changes.groups)) {
        state.prefs = await Storage.getPrefs();
        dirty = true;
      }
      if (area === 'local' && changes.watchlist) {
        state.watchlist = changes.watchlist.newValue || [];
        dirty = true;
      }
      if (dirty) scheduleRender(state);
    });
  }

  // Coalesce rapid storage events (e.g. prefs + watchlist updated together
  // when a group is deleted) into a single render frame. Prevents stale
  // async sparkline loaders from racing two consecutive renders and
  // leaving one ticker on its synthetic 2-point fallback.
  function scheduleRender(state) {
    if (state.renderScheduled) return;
    state.renderScheduled = true;
    requestAnimationFrame(() => {
      state.renderScheduled = false;
      renderWatchlist(state);
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
    state.renderGen++;
    const gen = state.renderGen;

    const list = qs(state.el, '#qt-list');
    list.textContent = '';

    const grouping = !!(state.prefs && state.prefs.enableGrouping);

    if (!state.watchlist || state.watchlist.length === 0) {
      // When grouping is on we still want to show the (empty) groups so
      // the user can see them configured and eventually drop into them.
      if (grouping) {
        renderGroupedSections(state, list, []);
      } else {
        const empty = document.createElement('div');
        empty.className = 'qt-empty';
        empty.textContent = 'No tickers yet. Search above to add one.';
        list.appendChild(empty);
      }
      renderTotalRow(state);
      return;
    }

    if (grouping) {
      renderGroupedSections(state, list, state.watchlist);
    } else {
      // Flat list: keep the watchlist array order.
      for (const t of state.watchlist) {
        const isExpanded = state.expandedSymbol === t.symbol;
        list.appendChild(renderTickerRow(state, t, { name: '' }, isExpanded));
        if (isExpanded) list.appendChild(renderExpansion(state, t));
      }
    }

    renderTotalRow(state);
    // Asynchronously replace synthetic sparklines with real intraday data.
    // Tagged with the current generation so stale fetches can't overwrite
    // a newer render's sparkline with the previous group's data.
    loadSparklines(state, gen);
  }

  // Render the list as an ordered sequence of group sections. Empty groups
  // are still shown (as a drop target) so the user can drop tickers into
  // them and the toggle visibly does something even before tickers move.
  function renderGroupedSections(state, list, watchlist) {
    const groupNames = (state.prefs && state.prefs.groups && state.prefs.groups.length)
      ? state.prefs.groups.slice()
      : ['Watchlist'];

    // Pick up any orphan group name referenced by a ticker but missing
    // from prefs — can happen after an import or corrupted prefs.
    for (const t of watchlist) {
      const g = t.group || 'Watchlist';
      if (!groupNames.includes(g)) groupNames.push(g);
    }

    // Bucket tickers by group, preserving their watchlist array order.
    const buckets = new Map();
    for (const g of groupNames) buckets.set(g, []);
    for (const t of watchlist) {
      const g = t.group || 'Watchlist';
      if (!buckets.has(g)) buckets.set(g, []);
      buckets.get(g).push(t);
    }

    for (const groupName of groupNames) {
      const tickers = buckets.get(groupName) || [];
      list.appendChild(renderGroupHeader(state, { name: groupName, tickers }));
      if (tickers.length === 0) {
        list.appendChild(renderEmptyGroupDropzone(state, groupName));
        continue;
      }
      for (const t of tickers) {
        const isExpanded = state.expandedSymbol === t.symbol;
        list.appendChild(renderTickerRow(state, t, { name: groupName }, isExpanded));
        if (isExpanded) list.appendChild(renderExpansion(state, t));
      }
    }
  }

  // Visible drop target for groups with no tickers. Mirrors the hit
  // behavior of a ticker row so tickers can be dragged into it.
  function renderEmptyGroupDropzone(state, groupName) {
    const dz = document.createElement('div');
    dz.className = 'qt-group-empty';
    dz.setAttribute('data-empty-group', groupName);
    dz.textContent = 'Drop tickers here';

    dz.addEventListener('dragover', (ev) => {
      if (!state.dragFrom) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      dz.classList.add('qt-group-empty-over');
      const list = qs(state.el, '#qt-list');
      const dragged = list.querySelector('.qt-row.qt-dragging');
      if (!dragged) return;
      // Park the dragged row right before this dropzone so the
      // subsequent dragend commit picks up the group change.
      list.insertBefore(dragged, dz);
    });
    dz.addEventListener('dragleave', () => dz.classList.remove('qt-group-empty-over'));
    dz.addEventListener('drop', (ev) => {
      ev.preventDefault();
      dz.classList.remove('qt-group-empty-over');
    });
    return dz;
  }

  // ---------- Sparkline data loading ----------

  // Fetches real 1-D chart data for every visible symbol and updates the
  // sparkline SVGs in place without triggering a full list re-render.
  // Crypto automatically gets a rolling 24 h window (handled by offscreen.js).
  // `gen` is the render generation this load belongs to — any update that
  // arrives after a newer render is silently dropped.
  function loadSparklines(state, gen) {
    const symbols = state.watchlist.map((t) => t.symbol);
    for (const sym of symbols) {
      loadSymbolSparkline(state, sym, gen);
    }
  }

  async function loadSymbolSparkline(state, symbol, gen) {
    try {
      const cached = await Storage.getCachedChart(symbol, '1D');
      if (cached && Storage.isChartFresh(cached, '1D') && cached.points && cached.points.length >= 2) {
        updateSparkline(state, symbol, cached.points, gen);
        return;
      }
      const fresh = await callOffscreen('fetchChart', { symbol, range: '1D' });
      if (fresh && fresh.points && fresh.points.length >= 2) {
        await Storage.setCachedChart(symbol, '1D', fresh);
        updateSparkline(state, symbol, fresh.points, gen);
      }
    } catch {
      // Keep the synthetic sparkline on error.
    }
  }

  function updateSparkline(state, symbol, points, gen) {
    // Drop stale updates from previous renders so a late cache hit can't
    // overwrite a newer render's sparkline with old-generation data.
    if (typeof gen === 'number' && gen !== state.renderGen) return;
    const cell = state.el.querySelector(`[data-spark-for="${cssEscape(symbol)}"]`);
    if (!cell) return;
    cell.textContent = '';
    const q = state.quotes[symbol];
    const positive = q && typeof q.changePct === 'number' ? q.changePct >= 0 : true;
    cell.appendChild(Chart.sparkline(points, { positive }));
  }

  function renderGroupHeader(state, group) {
    const row = document.createElement('div');
    row.className = 'qt-group';
    row.setAttribute('data-group', group.name);
    row.draggable = true;

    const handle = makeDragHandle();
    handle.classList.add('qt-group-handle');
    handle.title = 'Drag to reorder group';
    row.appendChild(handle);

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

    // ---------- Group-level drag-and-drop ----------
    // Dragging a group header moves all of its tickers as a unit.
    row.addEventListener('dragstart', (ev) => {
      state.dragFromGroup = group.name;
      state.dragFrom = null;
      ev.dataTransfer.effectAllowed = 'move';
      try { ev.dataTransfer.setData('text/plain', 'group:' + group.name); } catch {}
      // Collapse any expanded card inline (do NOT re-render — that would
      // destroy the header being dragged and kill the drag operation).
      if (state.expandedSymbol) {
        state.expandedSymbol = null;
        const listEl = qs(state.el, '#qt-list');
        const exp = listEl.querySelector('.qt-expansion');
        if (exp) exp.remove();
        listEl.querySelectorAll('.qt-row.expanded')
          .forEach((el) => el.classList.remove('expanded'));
      }
      setTimeout(() => row.classList.add('qt-group-dragging'), 0);
    });

    row.addEventListener('dragend', async () => {
      row.classList.remove('qt-group-dragging');
      const fromGroup = state.dragFromGroup;
      state.dragFromGroup = null;
      if (!fromGroup) return;
      await commitGroupOrderFromDom(state);
    });

    row.addEventListener('dragover', (ev) => {
      const list = qs(state.el, '#qt-list');

      // Case 1: a whole group is being dragged → move the entire block.
      if (state.dragFromGroup && state.dragFromGroup !== group.name) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        const draggedHeader = list.querySelector('.qt-group.qt-group-dragging');
        if (!draggedHeader || draggedHeader === row) return;
        const draggedBlock = collectGroupBlock(list, draggedHeader);
        const rect = row.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const insertBefore = ev.clientY < midY ? row : nextGroupBoundary(row);
        for (const node of draggedBlock) {
          list.insertBefore(node, insertBefore);
        }
        return;
      }

      // Case 2: a single ticker is being dragged over this header →
      // dropping here places it at the top of this group.
      if (state.dragFrom) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        const dragged = list.querySelector('.qt-row.qt-dragging');
        if (!dragged) return;
        // Insert the dragged row right after this header so commitDomOrder
        // reads its new group from this header's data-group attribute.
        list.insertBefore(dragged, row.nextSibling);
      }
    });

    row.addEventListener('drop', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });

    return row;
  }

  // Collect every sibling that belongs to `header` (the header itself
  // followed by all ticker rows / expansions / empty dropzones until the
  // next group header).
  function collectGroupBlock(list, header) {
    const out = [header];
    let node = header.nextSibling;
    while (node && !(node.classList && node.classList.contains('qt-group'))) {
      out.push(node);
      node = node.nextSibling;
    }
    return out;
  }

  // Returns the element that marks the end of `header`'s block — either
  // the next group header or null for the last group.
  function nextGroupBoundary(header) {
    let node = header.nextSibling;
    while (node && !(node.classList && node.classList.contains('qt-group'))) {
      node = node.nextSibling;
    }
    return node; // null ⇒ end of list, insertBefore(null) appends
  }

  // Walk the current DOM, harvest the group order from the .qt-group
  // headers, reorder both prefs.groups and the watchlist so its rows
  // are contiguous per group in the new order, then persist.
  async function commitGroupOrderFromDom(state) {
    const list = qs(state.el, '#qt-list');
    if (!list) return;
    const domGroups = [];
    for (const el of list.children) {
      if (el.classList && el.classList.contains('qt-group')) {
        const g = el.getAttribute('data-group');
        if (g && !domGroups.includes(g)) domGroups.push(g);
      }
    }
    const prefsGroups = (state.prefs && state.prefs.groups) || [];
    const beforeGroups = prefsGroups.join('|');
    // Append any prefs group that wasn't in the DOM (shouldn't happen).
    for (const g of prefsGroups) {
      if (!domGroups.includes(g)) domGroups.push(g);
    }
    if (domGroups.join('|') !== beforeGroups) {
      await Storage.setPrefs({ groups: domGroups });
      state.prefs = Object.assign({}, state.prefs, { groups: domGroups });
    }
    // Reorder watchlist so tickers are contiguous per group in domGroups
    // order, preserving relative order within each group.
    const byGroup = new Map();
    for (const g of domGroups) byGroup.set(g, []);
    for (const t of state.watchlist) {
      const g = t.group || 'Watchlist';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(t);
    }
    const newList = [];
    for (const g of domGroups) {
      for (const t of (byGroup.get(g) || [])) newList.push(t);
    }
    // Any orphan groups not in domGroups (belt-and-suspenders)
    for (const [g, arr] of byGroup.entries()) {
      if (!domGroups.includes(g)) for (const t of arr) newList.push(t);
    }
    for (let i = 0; i < newList.length; i++) newList[i].order = i;
    state.watchlist = newList;
    await Storage.setWatchlist(newList);
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

  function renderTickerRow(state, ticker, group, isExpanded) {
    const row = document.createElement('div');
    row.className = 'qt-row' + (isExpanded ? ' expanded' : '');
    row.setAttribute('data-symbol', ticker.symbol);
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.draggable = true;

    // Drag handle
    const handle = makeDragHandle();
    handle.addEventListener('click', (ev) => ev.stopPropagation());
    row.appendChild(handle);

    // Drag-and-drop events.
    // The dragged row is physically moved in the DOM on dragover so the other
    // rows visibly shift around it and the user can see exactly where the
    // drop will land. The browser-generated drag ghost follows the cursor.
    // Tickers can be dragged within their own group _or_ into another
    // group — dragend resolves each row's new group from its DOM position.
    row.addEventListener('dragstart', (ev) => {
      state.dragFrom = ticker.symbol;
      state.dragFromGroup = null;
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', ticker.symbol);
      // Collapse any expanded card so the DOM is stable while we reorder.
      if (state.expandedSymbol) {
        state.expandedSymbol = null;
        const exp = qs(state.el, '#qt-list').querySelector('.qt-expansion');
        if (exp) exp.remove();
        qs(state.el, '#qt-list').querySelectorAll('.qt-row.expanded')
          .forEach((el) => el.classList.remove('expanded'));
      }
      // Delay so the browser snapshot is taken before we dim the row.
      setTimeout(() => row.classList.add('qt-dragging'), 0);
    });

    row.addEventListener('dragend', async () => {
      row.classList.remove('qt-dragging');
      const fromSymbol = state.dragFrom;
      state.dragFrom = null;
      if (!fromSymbol) return;
      // Commit the new order + group from the current DOM arrangement.
      await commitDomOrder(state);
    });

    row.addEventListener('dragover', (ev) => {
      if (!state.dragFrom || state.dragFrom === ticker.symbol) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      const list = qs(state.el, '#qt-list');
      const dragged = list.querySelector('.qt-row.qt-dragging');
      if (!dragged || dragged === row) return;
      // Insert dragged before or after `row` based on cursor Y midpoint.
      const rect = row.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (ev.clientY < midY) {
        list.insertBefore(dragged, row);
      } else {
        list.insertBefore(dragged, row.nextSibling);
      }
    });

    row.addEventListener('drop', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      // The actual reorder already happened in dragover; dragend commits it.
    });

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

    // Sparkline — seeded with a synthetic 2-point line immediately;
    // loadSparklines() will replace this with real intraday data.
    const spark = document.createElement('div');
    spark.className = 'qt-spark-cell';
    spark.setAttribute('data-spark-for', ticker.symbol);
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

  // Walk the current DOM order and persist the resulting watchlist order.
  // Each row's group is inferred from the nearest preceding .qt-group
  // header (if grouping is enabled), so a row dropped into a different
  // group picks up that group's name automatically.
  async function commitDomOrder(state) {
    const list = qs(state.el, '#qt-list');
    if (!list) return;
    const grouping = !!(state.prefs && state.prefs.enableGrouping);

    const bySymbol = {};
    for (const t of state.watchlist) bySymbol[t.symbol] = t;

    const newList = [];
    const seen = new Set();
    let currentGroup = grouping
      ? ((state.prefs.groups && state.prefs.groups[0]) || 'Watchlist')
      : null;

    for (const child of list.children) {
      if (grouping && child.classList && child.classList.contains('qt-group')) {
        currentGroup = child.getAttribute('data-group') || currentGroup;
        continue;
      }
      if (child.classList && child.classList.contains('qt-row')) {
        const sym = child.getAttribute('data-symbol');
        if (sym && bySymbol[sym] && !seen.has(sym)) {
          const t = bySymbol[sym];
          if (grouping && currentGroup && t.group !== currentGroup) {
            // Clone so change is observable via === compare on persist.
            bySymbol[sym] = Object.assign({}, t, { group: currentGroup });
          }
          newList.push(bySymbol[sym]);
          seen.add(sym);
        }
      }
    }
    // Keep any rows that weren't in the DOM (shouldn't happen normally).
    for (const t of state.watchlist) {
      if (!seen.has(t.symbol)) newList.push(t);
    }

    // Only persist if something actually changed (order or group).
    const before = state.watchlist.map((t) => t.symbol + '@' + (t.group || '')).join(',');
    const after  = newList.map((t) => t.symbol + '@' + (t.group || '')).join(',');
    if (before === after) return;
    for (let i = 0; i < newList.length; i++) newList[i].order = i;
    state.watchlist = newList;
    await Storage.setWatchlist(newList);
  }

  function makeDragHandle() {
    const div = document.createElement('div');
    div.className = 'qt-drag-handle';
    // 2 × 3 dot grid — universally recognised drag affordance
    div.innerHTML = '<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">'
      + '<circle cx="3" cy="2.5" r="1.2"/><circle cx="7" cy="2.5" r="1.2"/>'
      + '<circle cx="3" cy="7"   r="1.2"/><circle cx="7" cy="7"   r="1.2"/>'
      + '<circle cx="3" cy="11.5" r="1.2"/><circle cx="7" cy="11.5" r="1.2"/>'
      + '</svg>';
    return div;
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

    // Footer: AI placeholder (left) + Remove (right)
    const footer = document.createElement('div');
    footer.className = 'qt-expansion-footer';

    const aiBtn = document.createElement('button');
    aiBtn.type = 'button';
    aiBtn.className = 'qt-ai-btn';
    aiBtn.title = 'AI Insights';
    aiBtn.setAttribute('aria-label', 'AI Insights');
    // Star icon
    aiBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
    aiBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openAiInsightsModal(state, ticker);
    });
    footer.appendChild(aiBtn);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'qt-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      state.expandedSymbol = null;
      await Tickers.remove(ticker.symbol);
    });
    footer.appendChild(removeBtn);

    wrap.appendChild(footer);

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
      if (h.publisher) {
        const src = document.createElement('span');
        src.className = 'qt-news-source';
        src.textContent = ' (' + h.publisher + ')';
        a.appendChild(src);
      }
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

  // ---------- AI Insights modal ----------

  const AI_DISCLAIMER = 'This is not financial advice. Quicker Ticker is not a broker-dealer, investment adviser, or fiduciary. AI-generated content may be inaccurate, outdated, or incomplete and should not be relied upon for investment decisions. Always do your own research and consult a licensed financial professional before making any investment.';

  async function openAiInsightsModal(state, ticker) {
    // Remove any existing modal first.
    const existing = document.querySelector('.qt-ai-modal-backdrop');
    if (existing) existing.remove();

    const q = state.quotes[ticker.symbol];
    const name = (q && q.name) || ticker.name || '';

    const backdrop = document.createElement('div');
    backdrop.className = 'qt-ai-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'qt-ai-modal';
    // Prevent clicks inside the card from dismissing the modal.
    modal.addEventListener('click', (ev) => ev.stopPropagation());

    // Header
    const header = document.createElement('div');
    header.className = 'qt-ai-modal-header';
    const title = document.createElement('div');
    title.className = 'qt-ai-modal-title';
    title.innerHTML = '<span class="qt-ai-star">★</span> AI Insights · ' + escapeHtml(ticker.symbol);
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'qt-ai-modal-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => backdrop.remove());
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // Body — starts in loading state
    const body = document.createElement('div');
    body.className = 'qt-ai-modal-body';
    body.appendChild(makeAiLoading());
    modal.appendChild(body);

    // Disclaimer
    const disclaimer = document.createElement('div');
    disclaimer.className = 'qt-ai-modal-disclaimer';
    disclaimer.textContent = AI_DISCLAIMER;
    modal.appendChild(disclaimer);

    backdrop.appendChild(modal);
    // Click outside the card closes the modal.
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) backdrop.remove();
    });
    // Escape key closes the modal.
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(backdrop);

    // Kick off the fetch.
    try {
      const data = await callOffscreen('fetchAiInsights', { symbol: ticker.symbol, name });
      body.textContent = '';
      body.appendChild(renderAiResponse(data && data.text || ''));
    } catch (err) {
      body.textContent = '';
      const errEl = document.createElement('div');
      errEl.className = 'qt-ai-error';
      errEl.textContent = 'Could not load AI insights. ' + (err && err.message || '');
      body.appendChild(errEl);
    }
  }

  function makeAiLoading() {
    const wrap = document.createElement('div');
    wrap.className = 'qt-ai-loading';
    wrap.textContent = 'Analyzing with AI…';
    return wrap;
  }

  // Parse the structured response from the AI into labeled sections.
  // Expected markers: "PAST PERFORMANCE:", "FUTURE OUTLOOK:", "ADVICE:"
  function renderAiResponse(text) {
    const container = document.createElement('div');
    container.className = 'qt-ai-response';

    const sections = parseAiSections(text);
    const labels = [
      { key: 'past',    title: 'Past performance' },
      { key: 'future',  title: 'Future outlook' },
      { key: 'advice',  title: 'Consideration' }
    ];

    let rendered = 0;
    for (const { key, title } of labels) {
      const content = sections[key];
      if (!content) continue;
      rendered++;
      const sec = document.createElement('div');
      sec.className = 'qt-ai-section';
      const h = document.createElement('div');
      h.className = 'qt-ai-section-title';
      h.textContent = title;
      const p = document.createElement('div');
      p.className = 'qt-ai-section-body';
      p.textContent = content;
      sec.appendChild(h);
      sec.appendChild(p);
      container.appendChild(sec);
    }

    // Fallback: if no markers were found, render the raw text.
    if (rendered === 0) {
      const p = document.createElement('div');
      p.className = 'qt-ai-section-body';
      p.textContent = text || 'No response.';
      container.appendChild(p);
    }
    return container;
  }

  function parseAiSections(text) {
    const out = { past: '', future: '', advice: '' };
    if (!text || typeof text !== 'string') return out;
    // Split on known section headings. Case-insensitive, tolerant of bold.
    const re = /\b(PAST PERFORMANCE|FUTURE OUTLOOK|ADVICE)\s*:\s*/gi;
    const matches = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      matches.push({ key: m[1].toUpperCase(), start: m.index, end: re.lastIndex });
    }
    for (let i = 0; i < matches.length; i++) {
      const { key, end } = matches[i];
      const nextStart = i + 1 < matches.length ? matches[i + 1].start : text.length;
      const body = text.slice(end, nextStart).replace(/\*\*/g, '').trim();
      if (key === 'PAST PERFORMANCE') out.past = body;
      else if (key === 'FUTURE OUTLOOK') out.future = body;
      else if (key === 'ADVICE') out.advice = body;
    }
    return out;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
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
