'use strict';

// ─── Side Panel ──────────────────────────────────────────────────────────────
// Open the side panel whenever the toolbar icon is clicked.
try {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
} catch (err) {
  console.error(err);
}

// ─── Message relay ───────────────────────────────────────────────────────────
// Content scripts cannot send messages directly to specific extension pages
// (side panel, options).  We relay here: when a message arrives from a content
// script (sender.tab is set) we re-broadcast it with the originating tabId so
// the side panel can filter by tab.  The `_relayed` flag prevents infinite
// looping if the background's own onMessage fires again.

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
