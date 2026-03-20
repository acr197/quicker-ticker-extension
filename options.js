/* Quicker Ticker Preferences */
const $ = (sel) => document.querySelector(sel);

const STORE_DEFAULTS = {
  // Default token is only for faster local testing.
  // Users can overwrite this in Preferences.
  finnhubToken: "",
  groupsEnabled: false,
  groupAveraging: true,
  groups: [
    { id: "g1", name: "Group 1" },
    { id: "g2", name: "Group 2" }
  ],
  groupTickers: { g1: [], g2: [] },
  tickers: [],
  sortKey: "manual",
  sortDir: "asc",
  columnOrder: null,

  personalValueEnabled: false,

  aiEnabled: true,
  aiProxyUrl: "https://quicker-ticker-ai-proxy.acr197.workers.dev/summarize",
};

function uniqId() {
  return "g" + Math.random().toString(16).slice(2, 10);
}

async function getStore() {
  const s = await chrome.storage.local.get(null);
  return { ...STORE_DEFAULTS, ...s };
}

async function setStore(patch) {
  await chrome.storage.local.set(patch);
}

function setToggle(el, on) {
  el.classList.toggle("on", !!on);
}

function toggleValue(el) {
  return el.classList.contains("on");
}

function rebuildGroupList(store, onDirty) {
  const box = $("#groupList");
  while (box.firstChild) box.removeChild(box.firstChild);

  const maxGroups = 5;
  $("#groupCount").textContent = String(store.groups.length);

  store.groups.forEach((g) => {
    const row = document.createElement("div");
    row.className = "groupRow";

    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = g.name || "";
    inp.placeholder = "Group name";

    inp.addEventListener("input", () => {
      g.name = inp.value;
      if (onDirty) onDirty();
    });

    const del = document.createElement("button");
    del.className = "mini";
    del.textContent = "−";
    del.title = "Remove group";
    del.disabled = store.groups.length <= 1;

    del.addEventListener("click", () => {
      if (store.groups.length <= 1) return;
      const idx = store.groups.findIndex((x) => x.id === g.id);
      if (idx >= 0) store.groups.splice(idx, 1);

      // Remove tickers in that group
      const gt = { ...store.groupTickers };
      delete gt[g.id];
      store.groupTickers = gt;

      // Ensure any removed tickers still exist somewhere? (We just drop them.)
      rebuildGroupList(store, onDirty);
      if (onDirty) onDirty();
    });

    row.appendChild(inp);
    row.appendChild(del);
    box.appendChild(row);
  });

  $("#addGroup").disabled = store.groups.length >= maxGroups;
}

async function load() {
  const store = await getStore();

  let saveTimer = null;

  function flashSaved() {
    $("#savedMsg").style.display = "block";
    clearTimeout(flashSaved._t);
    flashSaved._t = setTimeout(() => { $("#savedMsg").style.display = "none"; }, 900);
  }

  async function persistPreferences() {
    // IMPORTANT: only write preference keys here.
    // Writing the whole store can accidentally wipe the user's watchlist.
    const current = await chrome.storage.local.get(null);

    const finnhubToken = ($("#finnhub").value || "").trim();
    const groupsEnabled = toggleValue(tGroups);
    const groupAveraging = toggleValue(tAvg);
    const personalValueEnabled = toggleValue(tPV);
    const aiEnabled = toggleValue(tAI);

    // Groups edited in-place via the UI (mutates `store.groups` and `store.groupTickers`)
    const groups = store.groups;

    // Preserve existing tickers within groups, even if groups were renamed/reordered.
    // If a group was removed, move its tickers into the first remaining group.
    const curGt = current.groupTickers || {};
    const nextGt = { ...curGt };
    const keepIds = new Set(groups.map((g) => g.id));
    const removedIds = Object.keys(nextGt).filter((id) => !keepIds.has(id));
    const fallbackId = groups && groups.length ? groups[0].id : null;

    const wasGrouping = !!current.groupsEnabled;

    if (fallbackId && removedIds.length) {
      const bucket = Array.isArray(nextGt[fallbackId]) ? [...nextGt[fallbackId]] : [];
      for (const rid of removedIds) {
        const moved = Array.isArray(nextGt[rid]) ? nextGt[rid] : [];
        for (const sym of moved) if (!bucket.includes(sym)) bucket.push(sym);
        delete nextGt[rid];
      }
      nextGt[fallbackId] = bucket;
    } else {
      for (const rid of removedIds) delete nextGt[rid];
    }

    // Ensure every group has an array
    for (const g of groups) {
      if (!Array.isArray(nextGt[g.id])) nextGt[g.id] = [];
    }

    // Watchlist migration so toggling Groups never "empties" the main view:
    // - Turning grouping ON: move existing ungrouped tickers into the first group
    // - Turning grouping OFF: flatten grouped tickers back into the ungrouped list
    let migratedTickers = null;

    if (!wasGrouping && groupsEnabled && fallbackId) {
      const ungrouped = Array.isArray(current.tickers) ? current.tickers : [];
      if (ungrouped.length) {
        const bucket = Array.isArray(nextGt[fallbackId]) ? [...nextGt[fallbackId]] : [];
        for (const sym of ungrouped) if (!bucket.includes(sym)) bucket.push(sym);
        nextGt[fallbackId] = bucket;
        migratedTickers = [];
      }
    }

    if (wasGrouping && !groupsEnabled) {
      const flat = [];
      for (const g of groups) {
        const arr = Array.isArray(nextGt[g.id]) ? nextGt[g.id] : [];
        for (const sym of arr) if (!flat.includes(sym)) flat.push(sym);
      }
      migratedTickers = flat;
    }

    const patch = {
      finnhubToken,
      groupsEnabled,
      groupAveraging,
      personalValueEnabled,
      aiEnabled,
      groups,
      groupTickers: nextGt,
    };

    if (migratedTickers !== null) patch.tickers = migratedTickers;

    await setStore(patch);
    flashSaved();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      persistPreferences().catch(() => {});
    }, 250);
  }

  $("#finnhub").value = store.finnhubToken || "";

  // Toggles
  const tGroups = $("#tGroups");
  const tAvg = $("#tAvg");
  const tPV = $("#tPV");
  const tAI = $("#tAI");

  setToggle(tGroups, store.groupsEnabled);
  setToggle(tAvg, store.groupAveraging);
  setToggle(tPV, store.personalValueEnabled);
  setToggle(tAI, store.aiEnabled);

  $("#groupsBox").classList.toggle("on", !!store.groupsEnabled);
  rebuildGroupList(store, scheduleSave);

  // Toggle listeners
  tGroups.addEventListener("click", () => {
    setToggle(tGroups, !toggleValue(tGroups));
    $("#groupsBox").classList.toggle("on", toggleValue(tGroups));
    scheduleSave();
  });

  tAvg.addEventListener("click", () => { setToggle(tAvg, !toggleValue(tAvg)); scheduleSave(); });
  tPV.addEventListener("click", () => { setToggle(tPV, !toggleValue(tPV)); scheduleSave(); });

  tAI.addEventListener("click", () => {
    setToggle(tAI, !toggleValue(tAI));
    scheduleSave();
  });

  $("#finnhub").addEventListener("input", scheduleSave);

  $("#addGroup").addEventListener("click", () => {
    if (store.groups.length >= 5) return;
    const id = uniqId();
    store.groups.push({ id, name: `Group ${store.groups.length + 1}` });

    const gt = { ...store.groupTickers };
    gt[id] = [];
    store.groupTickers = gt;

    rebuildGroupList(store, scheduleSave);
    scheduleSave();
  });
}

document.addEventListener("DOMContentLoaded", load);
