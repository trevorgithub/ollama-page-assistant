'use strict';

/**
 * Content script — injected into every page.
 *
 * Responsibilities:
 *  - Element picker: hover-highlight + click-to-select mode
 *  - CSS selector generation for stable future re-selection
 *  - Text extraction: Readability for full page, innerText for selections
 *  - Responds to messages from the side panel (via chrome.tabs.sendMessage)
 *  - Pushes ELEMENT_SELECTED / PICKER_CANCELLED back to the extension runtime
 */

// ─── State ───────────────────────────────────────────────────────────────────

let hoveredEl = null;
let savedOutline = '';
let currentTabId = null; // set from incoming messages so we can echo it back

// ─── CSS selector generation ─────────────────────────────────────────────────

/**
 * Produces a short, reasonably stable CSS selector for `el`.
 *
 * Priority:
 *  1. Element with a non-empty id                  →  #the-id
 *  2. Semantic landmark elements                   →  article, main, …
 *  3. Tag + first two stable classes + nth-of-type
 *
 * "Stable" classes exclude common utility/state tokens (active, hover, etc.)
 * that change between sessions.
 */
function generateSelector(el) {
  // Walk up the tree building path segments; stop at <body>
  const UNSTABLE =
    /^(is-|js-|has-|active|selected|hover|focus|visible|hidden|open|closed|disabled|loading)/;
  const LANDMARKS = new Set(['article', 'main', 'section', 'nav', 'header', 'footer', 'aside']);

  const segments = [];
  let node = el;

  while (node && node !== document.body && node.nodeType === Node.ELEMENT_NODE) {
    const tag = node.tagName.toLowerCase();

    // If it has an id, we can stop here — it's globally unique (in spec)
    if (node.id) {
      segments.unshift(`#${CSS.escape(node.id)}`);
      break;
    }

    let seg = tag;

    // Attach stable classes
    const stableClasses = Array.from(node.classList)
      .filter((c) => !UNSTABLE.test(c) && !/^\d/.test(c) && c.length < 30)
      .slice(0, 2);

    if (stableClasses.length) seg += `.${stableClasses.map(CSS.escape).join('.')}`;

    // Add nth-of-type for disambiguation among same-tag siblings
    if (node.parentElement) {
      const sameTag = Array.from(node.parentElement.children).filter(
        (c) => c.tagName === node.tagName,
      );
      if (sameTag.length > 1) seg += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }

    segments.unshift(seg);

    // Semantic landmarks are distinctive enough to stop at
    if (LANDMARKS.has(tag)) break;

    node = node.parentElement;
  }

  return segments.join(' > ') || el.tagName.toLowerCase();
}

// ─── Text extraction ─────────────────────────────────────────────────────────

const NOISE_TAGS = [
  'script',
  'style',
  'noscript',
  'svg',
  'img',
  'button',
  'nav',
  'header',
  'footer',
  'aside',
  'iframe',
  'form',
];

/**
 * Extract meaningful text from a specific element.
 * Strips noisy child tags, then returns innerText.
 */
function extractElementText(el) {
  const clone = el.cloneNode(true);
  NOISE_TAGS.forEach((tag) => {
    clone.querySelectorAll(tag).forEach((n) => {
      n.remove();
    });
  });
  return (clone.innerText || clone.textContent || '').trim();
}

/**
 * Extract full-page text using Mozilla Readability.
 * Falls back to document.body.innerText if Readability fails or finds nothing.
 */
function extractPageText() {
  try {
    // Readability mutates the document it receives — always clone first.
    const docClone = document.cloneNode(true);
    const article = new Readability(docClone).parse(); // Readability.js is loaded before content.js
    if (article?.textContent && article.textContent.trim().length > 100) {
      return article.textContent.trim();
    }
  } catch (err) {
    console.warn('[Ollama Assistant] Readability failed, using innerText fallback:', err);
  }
  // Fallback: strip obvious noise from body
  const clone = document.body.cloneNode(true);
  NOISE_TAGS.forEach((tag) => {
    clone.querySelectorAll(tag).forEach((n) => {
      n.remove();
    });
  });
  return (clone.innerText || clone.textContent || '').trim();
}

// ─── Element picker ───────────────────────────────────────────────────────────

const HIGHLIGHT_STYLE = '2px solid #6366f1';
const HIGHLIGHT_BG = 'rgba(99,102,241,0.08)';

function applyHighlight(el) {
  savedOutline = el.style.outline;
  el.style.outline = HIGHLIGHT_STYLE;
  el.style.backgroundColor = HIGHLIGHT_BG;
}

function removeHighlight(el) {
  if (!el) return;
  el.style.outline = savedOutline;
  el.style.backgroundColor = '';
}

function onMouseOver(e) {
  if (hoveredEl) removeHighlight(hoveredEl);
  hoveredEl = e.target;
  applyHighlight(hoveredEl);
  e.stopPropagation();
}

function onMouseOut() {
  // Don't remove on mouseout — we keep the last hovered element highlighted
  // until the next mouseover or a click, for a crisp UX.
}

function onPickerClick(e) {
  e.preventDefault();
  e.stopImmediatePropagation();

  const el = e.target;
  const selector = generateSelector(el);
  const text = extractElementText(el);
  const label = selector;

  exitPickerMode();

  chrome.runtime.sendMessage({
    type: 'ELEMENT_SELECTED',
    tabId: currentTabId,
    selector,
    label,
    text,
  });
}

function onPickerKeydown(e) {
  if (e.key === 'Escape') {
    exitPickerMode();
    chrome.runtime.sendMessage({
      type: 'PICKER_CANCELLED',
      tabId: currentTabId,
    });
  }
}

function enterPickerMode() {
  document.body.style.cursor = 'crosshair';
  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('mouseout', onMouseOut, true);
  document.addEventListener('click', onPickerClick, true);
  document.addEventListener('keydown', onPickerKeydown, true);
}

function exitPickerMode() {
  document.body.style.cursor = '';
  removeHighlight(hoveredEl);
  hoveredEl = null;
  document.removeEventListener('mouseover', onMouseOver, true);
  document.removeEventListener('mouseout', onMouseOut, true);
  document.removeEventListener('click', onPickerClick, true);
  document.removeEventListener('keydown', onPickerKeydown, true);
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Track the tab id sent by the side panel so we can echo it back.
  if (message.tabId != null) currentTabId = message.tabId;

  switch (message.type) {
    case 'ENTER_PICKER_MODE':
      enterPickerMode();
      sendResponse({ ok: true });
      break;

    case 'EXIT_PICKER_MODE':
      exitPickerMode();
      sendResponse({ ok: true });
      break;

    case 'EXTRACT_FULL_PAGE':
      sendResponse({
        text: extractPageText(),
        url: location.href,
        title: document.title,
      });
      break;

    case 'EXTRACT_ELEMENT': {
      const target = document.querySelector(message.selector);
      if (target) {
        sendResponse({
          text: extractElementText(target),
          url: location.href,
          title: document.title,
        });
      } else {
        // Selector no longer matches — return full page and let the caller decide
        sendResponse({
          text: extractPageText(),
          url: location.href,
          title: document.title,
          selectorMiss: true,
        });
      }
      break;
    }

    case 'GET_PAGE_INFO':
      sendResponse({ url: location.href, title: document.title });
      break;

    default:
      break;
  }

  // Return true to indicate we may respond asynchronously
  return true;
});
