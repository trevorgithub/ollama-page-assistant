'use strict';

const DEFAULT_ENDPOINT = 'http://localhost:11434';

// ─── DOM ──────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = {
  endpointInput: $('endpoint-input'),
  apiKeyInput: $('api-key-input'),
  apiKeyToggle: $('api-key-toggle'),
  testBtn: $('test-btn'),
  connectionStatus: $('connection-status'),
  modelsLoading: $('models-loading'),
  modelsError: $('models-error'),
  modelsContent: $('models-content'),
  defaultModelSelect: $('default-model-select'),
  refreshModelsBtn: $('refresh-models-btn'),
  pageModelsEmpty: $('page-models-empty'),
  pageModelsTable: $('page-models-table'),
  pageModelsBody: $('page-models-body'),
  selectionsEmpty: $('selections-empty'),
  selectionsTable: $('selections-table'),
  selectionsBody: $('selections-body'),
  saveBtn: $('save-btn'),
  saveStatus: $('save-status'),
};

// ─── Storage helpers ──────────────────────────────────────────────────────────

async function loadSettings() {
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

async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

// ─── Ollama API ───────────────────────────────────────────────────────────────

function ollamaError(status) {
  if (status === 401) {
    return new Error('Ollama rejected the request (401 Unauthorized). Check the API key.');
  }
  if (status === 403) {
    return new Error(
      'Ollama blocked the request (403 Forbidden). ' +
        'Set the environment variable OLLAMA_ORIGINS=chrome-extension://* on the ' +
        'machine running Ollama and restart it.',
    );
  }
  return new Error(`HTTP ${status}`);
}

/** Returns an Authorization header object when an API key is configured. */
function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function fetchModels(endpoint, apiKey = '') {
  const res = await fetch(`${endpoint}/api/tags`, {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) throw ollamaError(res.status);
  const json = await res.json();
  return (json.models ?? []).map((m) => m.name).sort();
}

// ─── Model select ─────────────────────────────────────────────────────────────

function populateDefaultModelSelect(models, activeModel) {
  el.defaultModelSelect.innerHTML = '';

  if (!models.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— fetch models first —';
    el.defaultModelSelect.appendChild(opt);
    return;
  }

  // Allow "no default" option
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '— none —';
  el.defaultModelSelect.appendChild(noneOpt);

  for (const name of models) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    el.defaultModelSelect.appendChild(opt);
  }

  el.defaultModelSelect.value = activeModel ?? '';
}

// ─── Per-page overrides tables ────────────────────────────────────────────────

function renderPageModels(pageModels) {
  const entries = Object.entries(pageModels);

  if (!entries.length) {
    el.pageModelsEmpty.hidden = false;
    el.pageModelsTable.hidden = true;
    return;
  }

  el.pageModelsEmpty.hidden = true;
  el.pageModelsTable.hidden = false;
  el.pageModelsBody.innerHTML = '';

  for (const [url, model] of entries.toSorted(([a], [b]) => a.localeCompare(b))) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="url-cell" title="${escHtml(url)}">${escHtml(url)}</td>
      <td class="mono">${escHtml(model)}</td>
      <td>
        <button class="btn btn-ghost btn-sm" data-action="delete-page-model" data-url="${escAttr(url)}" title="Remove override">✕</button>
      </td>`;
    el.pageModelsBody.appendChild(tr);
  }
}

function renderSelections(pageSelections) {
  const entries = Object.entries(pageSelections);

  if (!entries.length) {
    el.selectionsEmpty.hidden = false;
    el.selectionsTable.hidden = true;
    return;
  }

  el.selectionsEmpty.hidden = true;
  el.selectionsTable.hidden = false;
  el.selectionsBody.innerHTML = '';

  for (const [url, sel] of entries.toSorted(([a], [b]) => a.localeCompare(b))) {
    const date = sel.savedAt
      ? new Date(sel.savedAt).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="url-cell" title="${escHtml(url)}">${escHtml(url)}</td>
      <td class="mono" title="${escHtml(sel.selector)}">${escHtml(truncate(sel.label || sel.selector, 40))}</td>
      <td class="date-cell">${escHtml(date)}</td>
      <td>
        <button class="btn btn-ghost btn-sm" data-action="delete-selection" data-url="${escAttr(url)}" title="Remove selection">✕</button>
      </td>`;
    el.selectionsBody.appendChild(tr);
  }
}

// ─── Status helpers ───────────────────────────────────────────────────────────

function setConnectionStatus(msg, type = '') {
  el.connectionStatus.textContent = msg;
  el.connectionStatus.className = type ? `field-hint inline-msg msg-${type}` : 'field-hint';
}

function showModelsLoading(on) {
  el.modelsLoading.hidden = !on;
}

function showModelsError(msg) {
  el.modelsError.textContent = msg;
  el.modelsError.hidden = !msg;
}

let saveStatusTimer = null;
function setSaveStatus(msg) {
  el.saveStatus.textContent = msg;
  clearTimeout(saveStatusTimer);
  if (msg)
    saveStatusTimer = setTimeout(() => {
      el.saveStatus.textContent = '';
    }, 3_000);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
function escAttr(s) {
  return escHtml(s);
}
function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ─── Main actions ─────────────────────────────────────────────────────────────

async function testConnection() {
  const endpoint = el.endpointInput.value.trim() || DEFAULT_ENDPOINT;
  const apiKey = el.apiKeyInput.value.trim();
  el.testBtn.disabled = true;
  setConnectionStatus('Testing…');
  try {
    const models = await fetchModels(endpoint, apiKey);
    setConnectionStatus(
      `✓ Connected — ${models.length} model${models.length === 1 ? '' : 's'} available`,
      'success',
    );
  } catch (err) {
    setConnectionStatus(`✗ ${err.message}`, 'error');
  } finally {
    el.testBtn.disabled = false;
  }
}

async function refreshModels() {
  const endpoint = el.endpointInput.value.trim() || DEFAULT_ENDPOINT;
  const apiKey = el.apiKeyInput.value.trim();
  el.refreshModelsBtn.disabled = true;
  showModelsLoading(true);
  showModelsError('');
  try {
    const models = await fetchModels(endpoint, apiKey);
    const currentDefault = el.defaultModelSelect.value;
    await saveSettings({ models });
    populateDefaultModelSelect(models, currentDefault);
    setConnectionStatus(
      `✓ ${models.length} model${models.length === 1 ? '' : 's'} loaded`,
      'success',
    );
  } catch (err) {
    showModelsError(`Could not fetch models: ${err.message}`);
  } finally {
    showModelsLoading(false);
    el.refreshModelsBtn.disabled = false;
  }
}

async function saveAll() {
  const endpoint = el.endpointInput.value.trim() || DEFAULT_ENDPOINT;
  const apiKey = el.apiKeyInput.value.trim();
  const defaultModel = el.defaultModelSelect.value;
  const summaryDetail =
    document.querySelector('[name="summary-detail"]:checked')?.value ?? 'standard';

  await saveSettings({ endpoint, apiKey, defaultModel, summaryDetail });
  setSaveStatus('✓ Saved');
}

// ─── Delegation for delete buttons ───────────────────────────────────────────

async function handleTableActions(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const { action, url } = btn.dataset;

  if (action === 'delete-page-model') {
    const { pageModels } = await chrome.storage.local.get('pageModels');
    const map = pageModels ?? {};
    delete map[url];
    await chrome.storage.local.set({ pageModels: map });
    renderPageModels(map);
  }

  if (action === 'delete-selection') {
    const { pageSelections } = await chrome.storage.local.get('pageSelections');
    const map = pageSelections ?? {};
    delete map[url];
    await chrome.storage.local.set({ pageSelections: map });
    renderSelections(map);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const settings = await loadSettings();

  el.endpointInput.value = settings.endpoint;
  el.apiKeyInput.value = settings.apiKey;

  // Summary detail level
  const detailRadio = document.querySelector(
    `[name="summary-detail"][value="${settings.summaryDetail}"]`,
  );
  if (detailRadio) detailRadio.checked = true;

  showModelsLoading(true);

  // Try to refresh models from Ollama; fall back to cached list
  let models = settings.models;
  try {
    models = await fetchModels(settings.endpoint, settings.apiKey);
    await saveSettings({ models });
    setConnectionStatus(
      `✓ Connected — ${models.length} model${models.length === 1 ? '' : 's'} available`,
      'success',
    );
  } catch {
    if (settings.models.length) {
      setConnectionStatus('Using cached model list (Ollama unreachable?)', 'warn');
    } else {
      setConnectionStatus('Cannot reach Ollama. Enter the endpoint and click Test.', 'warn');
    }
  } finally {
    showModelsLoading(false);
  }

  populateDefaultModelSelect(models, settings.defaultModel);
  renderPageModels(settings.pageModels);
  renderSelections(settings.pageSelections);

  // ── Event listeners ──────────────────────────────────────────────────────
  el.testBtn.addEventListener('click', testConnection);
  el.refreshModelsBtn.addEventListener('click', refreshModels);
  el.saveBtn.addEventListener('click', saveAll);

  el.apiKeyToggle.addEventListener('click', () => {
    const isHidden = el.apiKeyInput.type === 'password';
    el.apiKeyInput.type = isHidden ? 'text' : 'password';
    el.apiKeyToggle.textContent = isHidden ? 'Hide' : 'Show';
    el.apiKeyToggle.setAttribute('aria-pressed', String(isHidden));
  });

  // Delegate table delete buttons
  document.addEventListener('click', handleTableActions);
}

document.addEventListener('DOMContentLoaded', init);
