# Ollama Page Assistant

A Chrome extension (Manifest V3) that lets you summarize and chat with any web page using a local [Ollama](https://ollama.com) instance — no cloud, no intermediary server.

---

## Features

- **Summarize any page** — extracts clean article text via [Mozilla Readability](https://github.com/mozilla/readability), then streams a summary from Ollama
- **Pick a page section** — click an element on the page to scope all actions to just that section
- **Saved selections** — your element pick is remembered per URL and surfaced on future visits
- **Q&A** — ask free-form questions about the page (or selected section) with Ctrl+Enter
- **Per-page model overrides** — set a different model for a specific site without touching your global default
- **Zero external dependencies at runtime** — Readability is bundled; Ollama runs locally

---

## Setup

### 1. Prerequisites

- [Node.js](https://nodejs.org) ≥ 18
- [Ollama](https://ollama.com) running locally (default: `http://localhost:11434`)
- At least one model pulled: `ollama pull llama3.2`

### 2. Install dependencies & generate assets

```bash
cd ollama-page-assistant
npm install       # installs @mozilla/readability
node scripts/setup.js  # copies Readability.js → lib/ and generates icons/
```

> `npm audit` will show **0 vulnerabilities** after install.

### 3. Load in Chrome

1. Navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `ollama-page-assistant/` folder

The ◈ icon will appear in your toolbar.

---

## Usage

| Action                  | How                                                        |
| ----------------------- | ---------------------------------------------------------- |
| Open panel              | Click the ◈ icon in the Chrome toolbar                     |
| Summarize full page     | Click **✦ Summarize**                                      |
| Scope to a section      | Click **Pick element**, then click any element on the page |
| Clear a saved selection | Click **Clear** next to the element chip                   |
| Ask a question          | Type in the Q&A area and press **Ask** or Ctrl+Enter       |
| Stop generation         | Click **■ Stop**                                           |
| Change model            | Use the model dropdown in the panel header                 |
| Open Settings           | Click ⚙ in the panel header                                |

---

## Settings

Accessible via ⚙ in the side panel or `chrome://extensions` → Details → Extension options.

| Setting                      | Description                                             |
| ---------------------------- | ------------------------------------------------------- |
| **Server endpoint**          | Ollama API base URL (default: `http://localhost:11434`) |
| **Default model**            | Used for all pages unless a per-page override is set    |
| **Per-page model overrides** | View and delete models saved for individual pages       |
| **Saved element selections** | View and delete remembered element picks                |

---

## Updating Readability

To update to a newer Readability version:

```bash
npm update @mozilla/readability
node scripts/setup.js
npm audit             # should still show 0 vulnerabilities
```

Commit both `package-lock.json` and `lib/Readability.js`.

---

## Architecture

```
manifest.json          MV3 manifest — permissions, content scripts, side panel
background.js          Service worker — opens side panel on icon click; relays
                       content-script → side-panel messages
content.js             Injected into every page — element picker, text extraction
lib/Readability.js     Bundled Mozilla Readability (copied from node_modules)
sidepanel.{html,js,css}  Main UI — summary, Q&A, model selector
settings.{html,js,css}   Settings page — endpoint, models, overrides
scripts/setup.js       Post-install: copies Readability, generates PNG icons
```

### Message flow

```
Side panel  ──chrome.tabs.sendMessage(tabId)──►  Content script
Content script  ──chrome.runtime.sendMessage──►  Background (relayed)
Background  ──chrome.runtime.sendMessage──►  Side panel (filtered by tabId)
Side panel  ──fetch──►  Ollama (localhost:11434)
```

### Storage schema (`chrome.storage.local`)

```jsonc
{
  "endpoint": "http://localhost:11434",
  "defaultModel": "llama3.2",
  "models": ["llama3.2", "mistral", "..."], // cached from /api/tags
  "pageSelections": {
    "https://example.com/article": {
      "selector": "article.story-body",
      "label": "article.story-body",
      "savedAt": 1716300000000,
    },
  },
  "pageModels": {
    "https://docs.example.com": "mistral",
  },
}
```
