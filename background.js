'use strict';

// ─── Message relay ───────────────────────────────────────────────────────────
// IMPORTANT: This listener must be registered synchronously (before any await)
// so Chrome's MV3 service worker guarantees it is active the moment the worker
// wakes from sleep.  Registering after an await can cause the worker to receive
// a wakeup event, start executing, hit the await, and then have the message
// delivered before the listener is registered — silently dropping it.
//
// Content scripts cannot message extension pages (e.g. the side panel) directly;
// they can only reach the service worker.  This relay re-broadcasts the message
// so the side panel can receive it.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.tab && !message._relayed) {
    chrome.runtime
      .sendMessage({
        ...message,
        tabId: message.tabId ?? sender.tab.id,
        _relayed: true,
      })
      .catch(() => {
        // Side panel may not be open — that is fine.
      });
  }
  // Return false: we never call sendResponse here.
  return false;
});

// ─── Side Panel ──────────────────────────────────────────────────────────────
// Open the side panel whenever the toolbar icon is clicked.
// .catch() is intentional: Chrome service workers disallow top-level await,
// so this cannot be written as `await …` even though Sonar prefers it.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error); // NOSONAR
