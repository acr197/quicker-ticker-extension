// background.js — Service worker.
// Responsibilities:
//   * Routing messages from sidepanel/popup to the offscreen document
//   * Managing the offscreen document lifecycle
//   * Opening the side panel when the toolbar action is clicked
//     (when the user has chosen sidepanel as default view)
//   * Lightweight idle teardown of the offscreen document

const OFFSCREEN_URL = 'offscreen.html';
const IDLE_CLOSE_MS = 30 * 1000;

let creating = null;
let idleTimer = null;

async function ensureOffscreen() {
  if (creating) return creating;
  // hasDocument may not be present in older Chromes; guard it.
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    const exists = await chrome.offscreen.hasDocument();
    if (exists) return;
  }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['DOM_SCRAPING'],
    justification: 'Fetch Yahoo Finance data to avoid service worker fetch limits'
  }).catch((err) => {
    // If a doc was created concurrently, ignore the duplicate error.
    if (!String(err && err.message || '').includes('Only a single offscreen document')) {
      throw err;
    }
  }).finally(() => {
    creating = null;
  });
  return creating;
}

async function closeOffscreen() {
  try {
    if (chrome.offscreen && chrome.offscreen.hasDocument) {
      const exists = await chrome.offscreen.hasDocument();
      if (exists) await chrome.offscreen.closeDocument();
    }
  } catch {
    // ignore
  }
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    closeOffscreen();
    idleTimer = null;
  }, IDLE_CLOSE_MS);
}

// ---------- Message routing ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'background') return false;

  (async () => {
    try {
      if (msg.type === 'forwardToOffscreen') {
        await ensureOffscreen();
        scheduleIdleClose();
        const resp = await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: msg.subtype,
          symbols: msg.symbols,
          symbol: msg.symbol,
          range: msg.range,
          query: msg.query
        });
        sendResponse(resp);
        return;
      }

      if (msg.type === 'openOptions') {
        await chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'openSidePanel') {
        // Cannot open side panel from background without a tab/window context.
        // The action click handler does this.
        sendResponse({ ok: false, error: 'must be triggered by user gesture' });
        return;
      }

      sendResponse({ ok: false, error: `unknown background message: ${msg.type}` });
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message || err) });
    }
  })();

  return true; // async
});

// ---------- Toolbar action ----------

// Respect the user's "default view" preference. If they prefer the sidepanel,
// open it on click. Otherwise the default popup (declared in manifest) opens.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const prefs = await chrome.storage.sync.get({ defaultView: 'sidepanel' });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: prefs.defaultView === 'sidepanel' });
  } catch {
    // ignore
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    const prefs = await chrome.storage.sync.get({ defaultView: 'sidepanel' });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: prefs.defaultView === 'sidepanel' });
  } catch {
    // ignore
  }
});

// React to live preference changes from the options page.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync') return;
  if (changes.defaultView) {
    try {
      await chrome.sidePanel.setPanelBehavior({
        openPanelOnActionClick: changes.defaultView.newValue === 'sidepanel'
      });
    } catch {
      // ignore
    }
  }
});
