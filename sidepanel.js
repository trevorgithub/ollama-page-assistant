'use strict';

/**
 * Side-panel script.
 *
 * Architecture notes:
 *  - All fetch calls to Ollama happen here (extension pages can reach localhost).
 *  - Messages TO the content script go via chrome.tabs.sendMessage(tabId, ...).
 *  - Messages FROM the content script arrive via chrome.runtime.onMessage after
 *    the background service-worker relays them (see background.js).
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_ENDPOINT = 'http://localhost:11434';
const MAX_CONTEXT_CHARS = 60_000; // soft cap to avoid overwhelming the model

// ─── DOM helpers ──────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const el = {
  pageTitle: $('page-title'),
  pageUrl: $('page-url'),
  noSelection: $('state-no-selection'),
  hasSelection: $('state-has-selection'),
  pickerActive: $('state-picker-active'),
  selectorMissWarn: $('selector-miss-warning'),
  selectionLabel: $('selection-label'),
  pickElementBtn: $('pick-element-btn'),
  changeSelectionBtn: $('change-selection-btn'),
  clearSelectionBtn: $('clear-selection-btn'),
  summarizeBtn: $('summarize-btn'),
  stopBtn: $('stop-btn'),
  staleBanner: $('stale-banner'),
  staleFrom: $('stale-from'),
  staleClearBtn: $('stale-clear-btn'),
  responseSection: $('response-section'),
  responseContent: $('response-content'),
  copyResponseBtn: $('copy-response-btn'),
  clearResponseBtn: $('clear-response-btn'),
  qaInput: $('qa-input'),
  qaSendBtn: $('qa-send-btn'),
  qaResponse: $('qa-response'),
  statusText: $('status-text'),
  settingsBtn: $('settings-btn'),
  modelSelect: $('model-select'),
};

// ─── Module state ─────────────────────────────────────────────────────────────

let currentTabId = null;
let currentUrl = null;
let abortController = null;
/** @type {{ selector: string, label: string } | null} */
let currentSelection = null;

/**
 * In-memory per-tab UI state cache.
 * Keyed by tabId; holds a snapshot of all result content so switching tabs
 * (or accidentally leaving a tab) never loses generated output.
 *
 * @type {Map<number, {
 *   url:               string,
 *   title:             string,
 *   responseVisible:   boolean,
 *   responseContent:   string,
 *   qaInput:           string,
 *   qaResponse:        string,
 *   qaResponseVisible: boolean,
 * }>}
 */
const tabStateCache = new Map();

// ─── Storage helpers ──────────────────────────────────────────────────────────

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

async function getSettings() {
  const d = await chrome.storage.local.get([
    'endpoint',
    'apiKey',
    'defaultModel',
    'models',
    'pageSelections',
    'pageModels',
    'summaryDetail',
  ]);
  return {
    endpoint: d.endpoint ?? DEFAULT_ENDPOINT,
    apiKey: d.apiKey ?? '',
    defaultModel: d.defaultModel ?? '',
    models: d.models ?? [],
    pageSelections: d.pageSelections ?? {},
    pageModels: d.pageModels ?? {},
    summaryDetail: d.summaryDetail ?? 'standard',
  };
}

/** Maps a summaryDetail value to its prompt instruction. */
function summaryDetailInstruction(detail) {
  switch (detail) {
    case 'brief':
      return 'Respond with a brief 2–3 sentence overview covering only the most essential points.';
    case 'detailed':
      return (
        'Respond with a detailed summary covering all major topics, key facts, and conclusions. ' +
        'Use short paragraphs and include bullet points where helpful.'
      );
    default: // 'standard'
      return 'Respond with a clear summary in 3–5 short paragraphs covering the main points.';
  }
}

async function savePageSelection(url, selection) {
  const { pageSelections } = await chrome.storage.local.get('pageSelections');
  const map = pageSelections ?? {};
  const key = normalizeUrl(url);
  if (selection === null) {
    delete map[key];
  } else {
    map[key] = { ...selection, savedAt: Date.now() };
  }
  await chrome.storage.local.set({ pageSelections: map });
}

async function savePageModel(url, model) {
  const { pageModels } = await chrome.storage.local.get('pageModels');
  const map = pageModels ?? {};
  const key = normalizeUrl(url);
  if (model) {
    map[key] = model;
  } else {
    delete map[key];
  }
  await chrome.storage.local.set({ pageModels: map });
}

// ─── Ollama API ───────────────────────────────────────────────────────────────

/**
 * Produce a human-readable error for common Ollama HTTP status codes.
 * The 403 in particular means Ollama's origin check blocked the request —
 * the user needs to set OLLAMA_ORIGINS=chrome-extension://* on the host
 * running Ollama and restart it.
 */
function ollamaError(status, body = '') {
  if (status === 401) {
    return new Error(
      'Ollama rejected the request (401 Unauthorized). Check the API key in Settings.',
    );
  }
  if (status === 403) {
    return new Error(
      'Ollama blocked this request (403). ' +
        'Set OLLAMA_ORIGINS=chrome-extension://* on the machine running Ollama, then restart it.',
    );
  }
  if (status === 404) {
    return new Error('Ollama 404 — model not found. Is it pulled? Run: ollama pull <model>');
  }
  const detail = body ? `: ${body.slice(0, 120)}` : '';
  return new Error(`Ollama ${status}${detail}`);
}

/** Returns an Authorization header object when an API key is configured. */
function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function fetchModels(endpoint, apiKey = '') {
  const res = await fetch(`${endpoint}/api/tags`, {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw ollamaError(res.status);
  const json = await res.json();
  return (json.models ?? []).map((m) => m.name).sort();
}

/**
 * Parses a ReadableStream as NDJSON and yields each parsed object.
 * Releases the reader lock when done or on error.
 *
 * @param {ReadableStreamDefaultReader} reader
 */
async function* readNDJSONStream(reader) {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep the incomplete trailing fragment

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed);
        } catch {
          /* skip malformed NDJSON lines */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Calls /api/chat with stream:true and yields each token string as it arrives.
 * Throws on network error or non-2xx response; AbortError is propagated.
 */
async function* streamChat(endpoint, model, messages, apiKey = '') {
  abortController = new AbortController();

  let res;
  try {
    res = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: abortController.signal,
    });
  } catch (err) {
    abortController = null;
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    abortController = null;
    throw ollamaError(res.status, body);
  }

  try {
    for await (const obj of readNDJSONStream(res.body.getReader())) {
      if (obj.message?.content) yield obj.message.content;
      if (obj.done) return;
    }
  } finally {
    abortController = null;
  }
}

// ─── Content-script communication ────────────────────────────────────────────

function msgContentScript(payload) {
  return chrome.tabs.sendMessage(currentTabId, {
    ...payload,
    tabId: currentTabId,
  });
}

/**
 * Extracts text from the active tab.
 * If `selector` is provided, targets that element; otherwise uses full page.
 * Returns { text, url, title, selectorMiss? }.
 */
async function extractText(selector) {
  if (selector) {
    return msgContentScript({ type: 'EXTRACT_ELEMENT', selector });
  }
  return msgContentScript({ type: 'EXTRACT_FULL_PAGE' });
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

let statusTimer = null;
function setStatus(msg, type = '') {
  el.statusText.textContent = msg;
  el.statusText.className = type ? `status-text status-${type}` : 'status-text';
  clearTimeout(statusTimer);
  // 'error' and 'success' persist until the next action clears them.
  // Transient messages (no type, or 'warn') auto-clear after a few seconds.
  if (msg && type !== 'error' && type !== 'success') {
    statusTimer = setTimeout(() => {
      if (el.statusText.textContent === msg) el.statusText.textContent = '';
    }, 3_500);
  }
}

function setGenerating(on) {
  el.summarizeBtn.disabled = on;
  el.qaSendBtn.disabled = on;
  el.stopBtn.hidden = !on;
}

/** Format elapsed milliseconds as "Xs" or "Xm Ys". */
function formatElapsed(ms) {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function updateSelectionUI(selection) {
  currentSelection = selection ?? null;

  const has = !!selection;
  el.noSelection.hidden = has;
  el.hasSelection.hidden = !has;
  el.pickerActive.hidden = true;

  if (has) {
    const label = selection.label || selection.selector;
    el.selectionLabel.textContent = label;
    el.selectionLabel.title = label;
  }
  el.selectorMissWarn.hidden = true;
}

function enterPickerUI() {
  el.noSelection.hidden = true;
  el.hasSelection.hidden = true;
  el.pickerActive.hidden = false;
}

function exitPickerUI() {
  el.pickerActive.hidden = true;
}

function populateModelSelect(models, activeModel) {
  el.modelSelect.innerHTML = '';

  if (!models.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— no models —';
    el.modelSelect.appendChild(opt);
    return;
  }

  for (const name of models) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    el.modelSelect.appendChild(opt);
  }

  // Pick the active model, falling back to first in list
  el.modelSelect.value = activeModel && models.includes(activeModel) ? activeModel : models[0];
}

/**
 * Streams tokens from an async generator into a DOM element.
 * - Adds `.streaming` class while in progress (drives the blinking cursor).
 * - Ticks the status bar every second with a live elapsed counter.
 * - Returns { completed, elapsedMs } when finished.
 *
 * @param {AsyncGenerator} generator
 * @param {HTMLElement}    target      Element to stream text into.
 * @param {string}         liveLabel   Status prefix while streaming, e.g. "Generating summary".
 */
async function renderStream(generator, target, liveLabel) {
  target.textContent = '';
  target.hidden = false;
  target.classList.add('streaming');
  setGenerating(true);

  const startTime = Date.now();

  // Tick the status bar every second so the user sees time passing.
  const ticker = setInterval(() => {
    setStatus(`${liveLabel}… ${formatElapsed(Date.now() - startTime)}`);
  }, 1_000);

  let completed = false;
  try {
    for await (const token of generator) {
      target.textContent += token;
      target.scrollTop = target.scrollHeight;
    }
    completed = true;
  } catch (err) {
    if (err.name !== 'AbortError') {
      target.textContent += `\n\n⚠ ${err.message}`;
      setStatus(err.message, 'error');
    }
  } finally {
    clearInterval(ticker);
    target.classList.remove('streaming');
    setGenerating(false);
  }

  return { completed, elapsedMs: Date.now() - startTime };
}

// ─── Summarize ────────────────────────────────────────────────────────────────

async function summarize() {
  const settings = await getSettings();
  const model = el.modelSelect.value;

  if (!model) {
    setStatus('No model selected — open Settings to configure.', 'error');
    return;
  }

  clearStaleState();
  setStatus(''); // clear any previous ✓
  setStatus('Extracting page content…');

  let text, title;
  try {
    const result = await extractText(currentSelection?.selector ?? null);
    text = result.text;
    title = result.title ?? '';
    if (result.selectorMiss) {
      el.selectorMissWarn.hidden = false;
    }
    if (!text) throw new Error('No text content found on page.');
  } catch (err) {
    setStatus(`Extraction failed: ${err.message}`, 'error');
    return;
  }

  const truncated =
    text.length > MAX_CONTEXT_CHARS
      ? text.slice(0, MAX_CONTEXT_CHARS) + '\n\n[Content truncated to fit context window]'
      : text;

  const detailLevel =
    document.querySelector('[name="summary-detail"]:checked')?.value ?? settings.summaryDetail;

  const messages = [
    {
      role: 'system',
      content:
        'You are an accurate assistant that summarizes web page content. ' +
        summaryDetailInstruction(detailLevel) +
        ' ' +
        'Do not invent information not present in the provided text.',
    },
    {
      role: 'user',
      content:
        `Page title: ${title}\nURL: ${currentUrl}\n\n` +
        `Please summarize the following page content:\n\n---\n${truncated}`,
    },
  ];

  setStatus('Generating summary…');
  el.responseSection.hidden = false;

  const { completed, elapsedMs } = await renderStream(
    streamChat(settings.endpoint, model, messages, settings.apiKey),
    el.responseContent,
    'Generating summary',
  );

  if (completed) setStatus(`✓ Summary complete · ${formatElapsed(elapsedMs)}`, 'success');
}

// ─── Ask ──────────────────────────────────────────────────────────────────────

async function ask() {
  const question = el.qaInput.value.trim();
  if (!question) return;

  const settings = await getSettings();
  const model = el.modelSelect.value;

  if (!model) {
    setStatus('No model selected — open Settings to configure.', 'error');
    return;
  }

  clearStaleState();
  setStatus(''); // clear any previous ✓
  setStatus('Extracting page content…');

  let text, title;
  try {
    const result = await extractText(currentSelection?.selector ?? null);
    text = result.text;
    title = result.title ?? '';
    if (!text) throw new Error('No text content found on page.');
  } catch (err) {
    setStatus(`Extraction failed: ${err.message}`, 'error');
    return;
  }

  const truncated =
    text.length > MAX_CONTEXT_CHARS
      ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n\n[Content truncated]`
      : text;

  // Include the current summary as additional context if it exists
  const summaryContext = el.responseContent.textContent.trim()
    ? `\n\nFor reference, here is a summary of the page that was previously generated:\n${el.responseContent.textContent.trim()}`
    : '';

  const messages = [
    {
      role: 'system',
      content:
        'You are an accurate, helpful assistant that answers questions about web page content. ' +
        'Base your answers only on the provided page text. ' +
        'If the answer is not in the text, say so clearly.',
    },
    {
      role: 'user',
      content:
        `Page title: ${title}\nURL: ${currentUrl}${summaryContext}\n\n` +
        `Page content:\n---\n${truncated}\n---\n\n` +
        `Question: ${question}`,
    },
  ];

  setStatus('Thinking…');

  const { completed, elapsedMs } = await renderStream(
    streamChat(settings.endpoint, model, messages, settings.apiKey),
    el.qaResponse,
    'Thinking',
  );

  if (completed) {
    setStatus(`✓ Answer complete · ${formatElapsed(elapsedMs)}`, 'success');
    // Defer by one frame so the browser has finished laying out the newly-visible
    // #qa-response before we read scrollHeight.  Only the Q&A flow scrolls;
    // summarize intentionally does not (the user is looking at the top of the panel).
    setTimeout(() => {
      window.scrollTo({
        top: window.innerHeight + document.documentElement.scrollHeight,
        behavior: 'smooth',
      });
    }, 50);
  }
}

// ─── Tab state cache helpers ──────────────────────────────────────────────────

/** Snapshot the current panel content into the cache before switching away. */
function saveTabState() {
  if (currentTabId === null) return;
  tabStateCache.set(currentTabId, {
    url: currentUrl,
    title: el.pageTitle.textContent,
    responseVisible: !el.responseSection.hidden,
    responseContent: el.responseContent.textContent,
    qaInput: el.qaInput.value,
    qaResponse: el.qaResponse.textContent,
    qaResponseVisible: !el.qaResponse.hidden,
  });
}

/**
 * Restore panel content from a cached snapshot.
 * @param {{ url, title, responseVisible, responseContent, qaInput, qaResponse, qaResponseVisible }} cached
 * @param {boolean} isStale - true when the cached content belongs to a different URL than the current tab
 */
function restoreTabState(cached, isStale) {
  el.responseSection.hidden = !cached.responseVisible;
  el.responseContent.textContent = cached.responseContent ?? '';
  el.qaInput.value = cached.qaInput ?? '';
  el.qaResponse.textContent = cached.qaResponse ?? '';
  el.qaResponse.hidden = !cached.qaResponseVisible;
  el.selectorMissWarn.hidden = true;

  const hasContent = !!(cached.responseContent || cached.qaResponse);

  if (isStale && hasContent) {
    el.staleBanner.hidden = false;
    el.staleFrom.textContent = cached.title || cached.url || 'another page';
    el.staleFrom.title = cached.url ?? '';
    el.responseContent.classList.toggle('stale', !!cached.responseContent);
    el.qaResponse.classList.toggle('stale', !!cached.qaResponse);
  } else {
    el.staleBanner.hidden = true;
    el.responseContent.classList.remove('stale');
    el.qaResponse.classList.remove('stale');
  }
}

/** Remove stale styling — called at the start of any new generation. */
function clearStaleState() {
  el.staleBanner.hidden = true;
  el.responseContent.classList.remove('stale');
  el.qaResponse.classList.remove('stale');
}

// ─── Initialisation ───────────────────────────────────────────────────────────

async function loadForTab(tab) {
  // Snapshot outgoing tab before we touch the DOM
  saveTabState();

  currentTabId = tab.id;
  currentUrl = tab.url;

  el.pageTitle.textContent = tab.title ?? 'Untitled';
  el.pageTitle.title = tab.title ?? '';
  el.pageUrl.textContent = tab.url ?? '';
  el.pageUrl.title = tab.url ?? '';

  // Restore cached state for this tab, or clear the panel for a fresh tab
  const cached = tabStateCache.get(tab.id);
  if (cached) {
    const isStale = normalizeUrl(cached.url) !== normalizeUrl(tab.url);
    restoreTabState(cached, isStale);
  } else {
    el.responseSection.hidden = true;
    el.responseContent.textContent = '';
    el.qaResponse.hidden = true;
    el.qaResponse.textContent = '';
    el.qaInput.value = '';
    el.selectorMissWarn.hidden = true;
    el.staleBanner.hidden = true;
  }

  const settings = await getSettings();

  // Saved selection for this URL
  const savedSel = settings.pageSelections[normalizeUrl(tab.url)] ?? null;
  updateSelectionUI(savedSel);

  // Effective model for this URL
  const pageModel = settings.pageModels[normalizeUrl(tab.url)] ?? null;
  const effectiveModel = pageModel || settings.defaultModel;

  // Fetch/refresh models from Ollama
  let models = settings.models;
  try {
    models = await fetchModels(settings.endpoint, settings.apiKey);
    await chrome.storage.local.set({ models });
    setStatus(`Ollama ready · ${models.length} model${models.length === 1 ? '' : 's'}`, 'success');
  } catch {
    if (models.length) {
      setStatus('Using cached model list (Ollama unreachable?)', 'warn');
    } else {
      setStatus('Cannot reach Ollama — check Settings', 'error');
    }
  }

  populateModelSelect(models, effectiveModel);

  // Default detail-level toggle from stored setting
  const detailRadio = document.querySelector(
    `[name="summary-detail"][value="${settings.summaryDetail}"]`,
  );
  if (detailRadio) detailRadio.checked = true;
}

async function init() {
  // Get the currently active tab in this window
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (tab) await loadForTab(tab);

  // ── Tab switch: reload state for the new active tab ──────────────────────
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      await loadForTab(tab);
    } catch {
      /* tab may already be gone */
    }
  });

  // Also update title/url if the same tab navigates
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (tabId === currentTabId && changeInfo.status === 'complete') {
      await loadForTab(tab);
    }
  });

  // ── Messages from content script (relayed by background.js) ─────────────
  chrome.runtime.onMessage.addListener((message) => {
    if (message.tabId !== currentTabId) return; // not for this panel

    if (message.type === 'ELEMENT_SELECTED') {
      const sel = { selector: message.selector, label: message.label };
      savePageSelection(currentUrl, sel);
      updateSelectionUI(sel);
      exitPickerUI();
      setStatus(`Element locked: ${message.label}`, 'success');
    }

    if (message.type === 'PICKER_CANCELLED') {
      exitPickerUI();
      // Re-show whichever selection state was active before
      updateSelectionUI(currentSelection);
    }
  });

  // ── Event listeners ───────────────────────────────────────────────────────

  el.settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  el.pickElementBtn.addEventListener('click', async () => {
    enterPickerUI();
    try {
      await msgContentScript({ type: 'ENTER_PICKER_MODE' });
    } catch {
      exitPickerUI();
      updateSelectionUI(currentSelection);
      setStatus('Cannot activate picker on this page.', 'error');
    }
  });

  el.changeSelectionBtn.addEventListener('click', async () => {
    enterPickerUI();
    try {
      await msgContentScript({ type: 'ENTER_PICKER_MODE' });
    } catch {
      exitPickerUI();
      updateSelectionUI(currentSelection);
      setStatus('Cannot activate picker on this page.', 'error');
    }
  });

  el.clearSelectionBtn.addEventListener('click', async () => {
    await savePageSelection(currentUrl, null);
    updateSelectionUI(null);
    setStatus('Selection cleared.');
  });

  el.summarizeBtn.addEventListener('click', summarize);

  el.stopBtn.addEventListener('click', () => {
    abortController?.abort();
    setStatus('Stopped.');
  });

  el.copyResponseBtn.addEventListener('click', () => {
    const text = el.responseContent.textContent;
    if (text) navigator.clipboard.writeText(text).then(() => setStatus('Copied!', 'success'));
  });

  el.staleClearBtn.addEventListener('click', () => {
    clearStaleState();
    el.responseSection.hidden = true;
    el.responseContent.textContent = '';
    el.qaResponse.hidden = true;
    el.qaResponse.textContent = '';
  });

  el.clearResponseBtn.addEventListener('click', () => {
    el.responseSection.hidden = true;
    el.responseContent.textContent = '';
  });

  el.qaSendBtn.addEventListener('click', ask);

  el.qaInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      ask();
    }
  });

  // Persist detail-level changes back to storage so Settings stays in sync
  document.querySelectorAll('[name="summary-detail"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) chrome.storage.local.set({ summaryDetail: radio.value });
    });
  });

  // Saving a per-page model override whenever the user changes the selector
  el.modelSelect.addEventListener('change', async () => {
    if (!currentUrl) return;
    const settings = await getSettings();
    const chosen = el.modelSelect.value;
    const isDefault = chosen === settings.defaultModel;
    // Only store an override if it differs from the default
    await savePageModel(currentUrl, isDefault ? null : chosen);
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
