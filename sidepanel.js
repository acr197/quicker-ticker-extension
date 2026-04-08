// sidepanel.js — Thin entrypoint. All logic lives in shared/ui.js.

(function () {
  'use strict';
  document.addEventListener('DOMContentLoaded', () => {
    window.QTUI.init({ root: document.body });
  });
})();
