// options.js — Settings page logic.
// All prefs auto-save immediately on any change; there is no Save button.
// Reads/writes prefs via QTStorage. Uses chrome.tabs.create for any
// outbound link, never inline href navigation.

(function () {
  'use strict';

  const Storage = window.QTStorage;

  const els = {};
  const ids = [
    'opt-enableGrouping',
    'opt-showGroupAverages',
    'opt-personalValue',
    'opt-aiSummaries',
    'opt-ai-deactivated-msg',
    'opt-showCrypto',
    'opt-defaultViewSidepanel',
    'opt-darkMode',
    'opt-backupSourcesEnabled',
    'opt-finnhubKey',
    'opt-alphaVantageKey',
    'opt-coinGeckoKey',
    'opt-coinGeckoUseFreeTier',
    'opt-backupCards',
    'opt-coingecko-card',
    'opt-add-source',
    'opt-groups-list',
    'opt-new-group',
    'opt-add-group',
    'opt-export',
    'opt-import',
    'opt-import-file',
    'opt-clear',
    'opt-status',
    'opt-modal',
    'opt-modal-title',
    'opt-modal-body',
    'opt-modal-cancel',
    'opt-modal-confirm',
    'opt-link-finnhub',
    'opt-link-av'
  ];

  function $(id) { return document.getElementById(id); }

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    for (const id of ids) els[id] = $(id);

    const prefs = await Storage.getPrefs();
    paintPrefs(prefs);
    applyDarkMode(prefs.darkMode !== false);
    await renderGroups();

    bindHandlers();
  }

  function paintPrefs(prefs) {
    els['opt-enableGrouping'].checked = !!prefs.enableGrouping;
    els['opt-showGroupAverages'].checked = !!prefs.showGroupAverages;
    els['opt-personalValue'].checked = !!prefs.personalValue;
    els['opt-aiSummaries'].checked = !!prefs.aiSummaries;
    els['opt-ai-deactivated-msg'].hidden = !!prefs.aiSummaries;
    els['opt-showCrypto'].checked = !!prefs.showCrypto;
    els['opt-defaultViewSidepanel'].checked = prefs.defaultView === 'sidepanel';
    els['opt-darkMode'].checked = prefs.darkMode !== false;
    els['opt-backupSourcesEnabled'].checked = !!prefs.backupSourcesEnabled;
    els['opt-finnhubKey'].value = prefs.finnhubKey || '';
    els['opt-alphaVantageKey'].value = prefs.alphaVantageKey || '';
    els['opt-coinGeckoKey'].value = prefs.coinGeckoKey || '';
    els['opt-coinGeckoUseFreeTier'].checked = prefs.coinGeckoUseFreeTier !== false;
    els['opt-coinGeckoKey'].disabled = els['opt-coinGeckoUseFreeTier'].checked;
    syncBackupVisibility();
    syncCryptoVisibility();
  }

  // Apply/remove the light-mode class on <body> so options.css overrides
  // take effect immediately. The sidebar/popup read the same pref on their
  // own init + storage-change listeners.
  function applyDarkMode(isDark) {
    if (isDark) document.body.classList.remove('qt-light');
    else document.body.classList.add('qt-light');
  }

  // Every input in the prefs form auto-saves on change. Text inputs
  // (API keys) also save on blur/input for instant feedback.
  function bindHandlers() {
    const autoSaveTargets = [
      'opt-enableGrouping',
      'opt-showGroupAverages',
      'opt-personalValue',
      'opt-aiSummaries',
      'opt-showCrypto',
      'opt-defaultViewSidepanel',
      'opt-darkMode',
      'opt-backupSourcesEnabled',
      'opt-coinGeckoUseFreeTier'
    ];
    for (const id of autoSaveTargets) {
      els[id].addEventListener('change', autoSave);
    }

    // AI summaries: show an inline "deactivated" message under the toggle
    // when switched off, and hide it when switched back on.
    els['opt-aiSummaries'].addEventListener('change', () => {
      els['opt-ai-deactivated-msg'].hidden = els['opt-aiSummaries'].checked;
    });

    // Dark mode: apply/remove the light class on the options page itself
    // so the toggle has instant visual feedback.
    els['opt-darkMode'].addEventListener('change', () => {
      applyDarkMode(els['opt-darkMode'].checked);
    });

    // Debounce text-input auto-save so we're not thrashing storage on
    // every keystroke while the user pastes a long API key.
    const textInputs = ['opt-finnhubKey', 'opt-alphaVantageKey', 'opt-coinGeckoKey'];
    let textTimer = null;
    for (const id of textInputs) {
      els[id].addEventListener('input', () => {
        if (textTimer) clearTimeout(textTimer);
        textTimer = setTimeout(autoSave, 400);
      });
      els[id].addEventListener('blur', autoSave);
    }

    els['opt-backupSourcesEnabled'].addEventListener('change', syncBackupVisibility);
    els['opt-showCrypto'].addEventListener('change', syncCryptoVisibility);
    els['opt-coinGeckoUseFreeTier'].addEventListener('change', () => {
      els['opt-coinGeckoKey'].disabled = els['opt-coinGeckoUseFreeTier'].checked;
    });

    // External links — open via chrome.tabs.create, never inline.
    els['opt-link-finnhub'].addEventListener('click', (ev) => {
      ev.preventDefault();
      chrome.tabs.create({ url: 'https://finnhub.io/register' });
    });
    els['opt-link-av'].addEventListener('click', (ev) => {
      ev.preventDefault();
      chrome.tabs.create({ url: 'https://www.alphavantage.co/support/#api-key' });
    });

    els['opt-add-source'].addEventListener('click', () => {
      openModal({
        title: 'Coming soon',
        body: 'More data sources are on the way. Got a request? Let us know via the GitHub issues page.',
        confirmText: 'OK',
        destructive: false,
        onConfirm: closeModal
      });
    });

    els['opt-add-group'].addEventListener('click', addGroup);
    els['opt-new-group'].addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); addGroup(); }
    });

    els['opt-export'].addEventListener('click', exportData);
    els['opt-import'].addEventListener('click', () => els['opt-import-file'].click());
    els['opt-import-file'].addEventListener('change', importData);
    els['opt-clear'].addEventListener('click', confirmClearAll);

    els['opt-modal-cancel'].addEventListener('click', closeModal);
  }

  function syncBackupVisibility() {
    const on = els['opt-backupSourcesEnabled'].checked;
    els['opt-backupCards'].hidden = !on;
  }

  function syncCryptoVisibility() {
    const on = els['opt-showCrypto'].checked;
    els['opt-coingecko-card'].hidden = !on;
  }

  // ---------- Groups ----------

  async function renderGroups() {
    const prefs = await Storage.getPrefs();
    const list = els['opt-groups-list'];
    list.textContent = '';
    for (let i = 0; i < (prefs.groups || []).length; i++) {
      const name = prefs.groups[i];
      const row = document.createElement('div');
      row.className = 'qt-opt-group-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = name;
      input.maxLength = 60;
      input.dataset.idx = String(i);
      input.addEventListener('change', renameGroup);
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '✕';
      del.title = 'Delete group';
      del.addEventListener('click', () => deleteGroup(i));
      row.appendChild(input);
      row.appendChild(del);
      list.appendChild(row);
    }
  }

  async function addGroup() {
    const input = els['opt-new-group'];
    const name = input.value.trim();
    if (!name) return;
    const prefs = await Storage.getPrefs();
    const groups = (prefs.groups || []).slice();
    if (groups.includes(name)) {
      flashStatus('Group already exists');
      return;
    }
    groups.push(name);
    await Storage.setPrefs({ groups });
    input.value = '';
    await renderGroups();
    flashStatus('Saved');
  }

  async function renameGroup(ev) {
    const idx = Number(ev.target.dataset.idx);
    const newName = ev.target.value.trim();
    if (!newName) return;
    const prefs = await Storage.getPrefs();
    const groups = (prefs.groups || []).slice();
    const oldName = groups[idx];
    if (oldName === newName) return;
    if (groups.includes(newName)) {
      flashStatus('Group already exists', true);
      ev.target.value = oldName;
      return;
    }
    groups[idx] = newName;
    await Storage.setPrefs({ groups });
    // Migrate any tickers in the renamed group
    const watchlist = await Storage.getWatchlist();
    let dirty = false;
    for (const t of watchlist) {
      if (t.group === oldName) { t.group = newName; dirty = true; }
    }
    if (dirty) await Storage.setWatchlist(watchlist);
    flashStatus('Saved');
  }

  async function deleteGroup(idx) {
    const prefs = await Storage.getPrefs();
    const groups = (prefs.groups || []).slice();
    if (groups.length <= 1) {
      flashStatus('You must have at least one group', true);
      return;
    }
    const removed = groups[idx];
    const remaining = groups.filter((_, i) => i !== idx);

    // Count tickers in the group being removed so we can label accurately.
    const watchlist = await Storage.getWatchlist();
    const affected = watchlist.filter((t) => t.group === removed);
    const affectedCount = affected.length;

    openDeleteGroupModal({
      removed,
      remaining,
      affectedCount,
      onConfirm: async ({ target, deleteAll }) => {
        const nextWatchlist = deleteAll
          ? watchlist.filter((t) => t.group !== removed)
          : watchlist.map((t) => (t.group === removed ? Object.assign({}, t, { group: target }) : t));
        await Storage.setPrefs({ groups: remaining });
        await Storage.setWatchlist(nextWatchlist);
        await renderGroups();
        closeModal();
        flashStatus('Saved');
      }
    });
  }

  // ---------- Export / import / clear ----------

  async function exportData() {
    try {
      const payload = await Storage.exportAll();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `quicker-ticker-${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      flashStatus('Exported');
    } catch (err) {
      flashStatus('Export failed: ' + (err && err.message), true);
    }
  }

  async function importData(ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      await Storage.importAll(payload);
      flashStatus('Imported');
      const prefs = await Storage.getPrefs();
      paintPrefs(prefs);
      await renderGroups();
    } catch (err) {
      flashStatus('Import failed: ' + (err && err.message), true);
    } finally {
      ev.target.value = '';
    }
  }

  function confirmClearAll() {
    openModal({
      title: 'Clear all data?',
      body: 'This permanently deletes your watchlist, settings, and all cached prices. This cannot be undone.',
      confirmText: 'Delete everything',
      destructive: true,
      onConfirm: async () => {
        await Storage.clearAll();
        const prefs = await Storage.getPrefs();
        paintPrefs(prefs);
        await renderGroups();
        closeModal();
        flashStatus('Cleared');
      }
    });
  }

  // ---------- Auto-save ----------

  async function autoSave() {
    const prefs = {
      enableGrouping: els['opt-enableGrouping'].checked,
      showGroupAverages: els['opt-showGroupAverages'].checked,
      personalValue: els['opt-personalValue'].checked,
      aiSummaries: els['opt-aiSummaries'].checked,
      showCrypto: els['opt-showCrypto'].checked,
      defaultView: els['opt-defaultViewSidepanel'].checked ? 'sidepanel' : 'popup',
      darkMode: els['opt-darkMode'].checked,
      backupSourcesEnabled: els['opt-backupSourcesEnabled'].checked,
      finnhubKey: els['opt-finnhubKey'].value.trim().slice(0, 200),
      alphaVantageKey: els['opt-alphaVantageKey'].value.trim().slice(0, 200),
      coinGeckoKey: els['opt-coinGeckoKey'].value.trim().slice(0, 200),
      coinGeckoUseFreeTier: els['opt-coinGeckoUseFreeTier'].checked
    };
    await Storage.setPrefs(prefs);
    flashStatus('Saved');
  }

  function flashStatus(text, isError) {
    const s = els['opt-status'];
    s.textContent = text;
    s.style.color = isError ? '#ff1744' : '#00c853';
    setTimeout(() => { s.textContent = ''; }, 2000);
  }

  // ---------- Modal ----------

  let modalOnConfirm = null;
  function openModal(opts) {
    els['opt-modal-title'].textContent = opts.title || '';
    els['opt-modal-body'].textContent = opts.body || '';
    // Reset any custom body content from previous openDeleteGroupModal calls.
    els['opt-modal-body'].className = '';
    els['opt-modal-confirm'].textContent = opts.confirmText || 'OK';
    els['opt-modal-confirm'].classList.toggle('destructive', !!opts.destructive);
    modalOnConfirm = opts.onConfirm || closeModal;
    els['opt-modal'].hidden = false;
    // Re-bind once to avoid stacking listeners
    els['opt-modal-confirm'].onclick = () => { if (modalOnConfirm) modalOnConfirm(); };
  }

  // A richer modal that lets the user choose what to do with tickers
  // when a group is deleted: move them to another group or delete them.
  function openDeleteGroupModal({ removed, remaining, affectedCount, onConfirm }) {
    els['opt-modal-title'].textContent = `Delete "${removed}"?`;

    const body = els['opt-modal-body'];
    body.textContent = '';
    body.className = 'qt-opt-delete-body';

    if (affectedCount === 0) {
      const p = document.createElement('p');
      p.textContent = 'This group is empty. It will be removed.';
      body.appendChild(p);
    } else {
      const p = document.createElement('p');
      p.textContent = `${affectedCount} ticker${affectedCount === 1 ? '' : 's'} currently live in this group. What should happen to them?`;
      body.appendChild(p);

      // Radio: move to another group
      const moveWrap = document.createElement('label');
      moveWrap.className = 'qt-opt-delete-choice';
      const moveRadio = document.createElement('input');
      moveRadio.type = 'radio';
      moveRadio.name = 'qt-opt-delete-action';
      moveRadio.value = 'move';
      moveRadio.checked = true;
      moveWrap.appendChild(moveRadio);
      const moveLabel = document.createElement('span');
      moveLabel.textContent = 'Move to ';
      moveWrap.appendChild(moveLabel);

      const select = document.createElement('select');
      select.className = 'qt-opt-delete-select';
      for (const g of remaining) {
        const opt = document.createElement('option');
        opt.value = g;
        opt.textContent = g;
        select.appendChild(opt);
      }
      select.addEventListener('focus', () => { moveRadio.checked = true; });
      moveWrap.appendChild(select);
      body.appendChild(moveWrap);

      // Radio: delete all tickers in the group
      const delWrap = document.createElement('label');
      delWrap.className = 'qt-opt-delete-choice';
      const delRadio = document.createElement('input');
      delRadio.type = 'radio';
      delRadio.name = 'qt-opt-delete-action';
      delRadio.value = 'delete';
      delWrap.appendChild(delRadio);
      const delLabel = document.createElement('span');
      delLabel.textContent = `Delete all ${affectedCount} ticker${affectedCount === 1 ? '' : 's'}`;
      delWrap.appendChild(delLabel);
      body.appendChild(delWrap);
    }

    els['opt-modal-confirm'].textContent = 'Delete group';
    els['opt-modal-confirm'].classList.add('destructive');
    els['opt-modal'].hidden = false;

    modalOnConfirm = () => {
      let target = remaining[0];
      let deleteAll = false;
      if (affectedCount > 0) {
        const action = body.querySelector('input[name="qt-opt-delete-action"]:checked');
        if (action && action.value === 'delete') {
          deleteAll = true;
        } else {
          const sel = body.querySelector('.qt-opt-delete-select');
          if (sel) target = sel.value;
        }
      }
      onConfirm({ target, deleteAll });
    };
    els['opt-modal-confirm'].onclick = () => { if (modalOnConfirm) modalOnConfirm(); };
  }

  function closeModal() {
    els['opt-modal'].hidden = true;
    modalOnConfirm = null;
  }
})();
