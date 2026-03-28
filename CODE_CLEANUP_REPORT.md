# 🧹 CLARITY — CODE CLEANUP & RESTRUCTURE REPORT

**Date:** 2026-03-25  
**Scope:** Full codebase — 57,837 lines across JS, HTML, CSS  
**Goal:** Identify files that are too large, duplicated code, dead code, and structural improvements

---

## EXECUTIVE SUMMARY

The codebase has **16 files over 1,000 lines** and **3,098 lines of completely dead CSS**. Several modules are "God objects" doing 5-10 different things. There's duplicated utility functions, a dead backup file, and 991 console.log statements that should use a proper logger. The `styles/` folder is well-organized but the original `sidepanel.css` it replaced was never deleted.

**Overall Code Health: 5.5/10**

| Issue | Files Affected | Estimated Savings |
|-------|---------------|-------------------|
| Dead files (sidepanel.css, ai-old-prompt-backup.js) | 2 | ~3,543 lines deleted |
| God modules needing split | 6 | Better maintainability |
| Duplicate functions | 3 | ~40 lines saved |
| Console.log → Logger | 991 calls | Proper log levels |
| Inline AI prompts → separate files | 1 | ~500 lines moved |
| CSS file too large (\_chat.css) | 1 | Split into 3 files |

---

## 🔴 CRITICAL — Dead Code & Dead Files

### 1. `sidepanel/sidepanel.css` — 3,098 Lines of DEAD CSS
**Status:** 🗑️ DELETE IMMEDIATELY

This file is **not referenced anywhere** in the codebase. The HTML only loads `styles/main.css`:
```html
<link rel="stylesheet" href="styles/main.css">
```

The modular `styles/` folder (11,958 lines across 16 files) completely replaced this monolithic file, but the old file was never removed.

**Action:** Delete `sidepanel/sidepanel.css`

---

### 2. `server/routes/ai-old-prompt-backup.js` — 445 Lines of Dead Code
**Status:** 🗑️ DELETE

Old prompt backup file sitting in the routes folder. Not imported or used anywhere.

**Action:** Delete `server/routes/ai-old-prompt-backup.js`

---

## 🟠 HIGH — God Modules That Need Splitting

### 3. `sidepanel/modules/ai.js` — 2,165 Lines (Should be ~400 each)
**Status:** 🔨 SPLIT INTO 5 MODULES

This is the worst offender. A single file handling:
- AI response generation & prompt building (lines 883-1247)
- Media sending logic (lines 1248-1461)
- Preview message system (lines 255-553)
- Bot accusation blocking (lines 554-731)
- Quick actions, copy, send-to-chat (lines 1462-1958)
- Event listener setup (lines 2064-2165)

**Proposed Split:**
```
sidepanel/modules/ai/
├── index.js              (~50 lines)  — exports, setup
├── generate.js           (~400 lines) — generateResponse, generateResponseText, prompt building
├── media.js              (~250 lines) — sendMediaOnly, media selection logic
├── preview.js            (~300 lines) — sendPreviewMessage, preview flow
├── actions.js            (~300 lines) — handleQuickAction, copyResponse, sendToChat
└── blocking.js           (~200 lines) — blockSubscriberForBotAccusation
```

---

### 4. `server/routes/ai.js` — 1,761 Lines (Should be ~300 each)
**Status:** 🔨 SPLIT INTO 4 FILES + PROMPTS FOLDER

This server route file contains 12 endpoints plus ~500 lines of inline AI prompt templates. The prompts are the main bloat.

**Proposed Split:**
```
server/routes/ai/
├── index.js              (~50 lines)  — mount sub-routers
├── generate.js           (~400 lines) — /generate, /summarize, /validate-response
├── extract.js            (~200 lines) — /extract, /check-goal
├── scripts.js            (~300 lines) — /generate-script, /script-categories
├── classify.js           (~200 lines) — /classify-situational
├── media.js              (~200 lines) — /generate-image-caption, /select-image
├── blocklist.js          (~150 lines) — /blocked-users CRUD
└── prompts/
    ├── generate.js        — main generation prompt template
    ├── summarize.js       — summarize prompt
    ├── classify.js        — classification prompt
    ├── scripts.js         — script generation prompts + category configs
    └── media.js           — image caption/selection prompts
```

Moving prompts to separate files alone saves ~500 lines from the main route file and makes prompts version-controllable independently.

---

### 5. `content/telegram/monitor.js` — 1,932 Lines
**Status:** 🔨 SPLIT INTO 4 MODULES

Single IIFE with 30+ functions handling:
- Chat list scanning & scroll detection
- Change detection & reporting
- Mutation observer setup
- Image/file sending (4 different methods!)
- Chat info extraction
- Message reading

**Proposed Split:**
```
content/telegram/
├── monitor/
│   ├── index.js          (~100 lines) — init, exports
│   ├── scanner.js        (~400 lines) — scanChatList, scanVisibleChats, scrollToTopAndScanUnreads
│   ├── observer.js       (~200 lines) — setupMutationObserver, change detection
│   ├── media.js          (~400 lines) — sendImageToChat, tryAttachMenuMethod, trySetFileDirectly, etc.
│   ├── extraction.js     (~300 lines) — getCurrentChatInfo, getLastMessages, extractChatsFromItems
│   └── navigation.js     (~200 lines) — openFirstNChats, getFirstNPeerIds
```

---

### 6. `content/telegram/index.js` — 1,610 Lines
**Status:** 🔨 SPLIT INTO 4 MODULES

Another single IIFE with 25+ functions:
- Message listener & polling
- Message sending (realistic typing, segmented messages)
- Image/file sending (duplicate of monitor.js methods!)
- Message extraction
- Chat navigation

**Proposed Split:**
```
content/telegram/
├── index.js              (~100 lines) — init, message router
├── messaging/
│   ├── sender.js         (~400 lines) — sendMessageToChat, typeRealistic, sendSegmentedMessage
│   ├── media.js          (~300 lines) — sendImageToChat, tryFileInput, tryClipboardPaste, tryDragAndDrop
│   ├── extractor.js      (~200 lines) — extractAllMessages, extractMessageData
│   └── polling.js        (~200 lines) — startPolling, checkForNewMessages, startMessageObserver
├── navigation.js         (~150 lines) — openChatById, autoLoadChat
```

⚠️ **DUPLICATION ALERT:** `telegram/index.js` and `telegram/monitor.js` BOTH have image sending functions (`sendImageToChat`, `tryFileInput`, etc.). These should be extracted into a shared `telegram/shared/media.js`.

---

### 7. `sidepanel/modules/chat/chatSync.js` — 1,056 Lines
**Status:** 🔨 SPLIT INTO 3 MODULES

**Proposed Split:**
```
sidepanel/modules/chat/
├── chatSync.js           (~300 lines) — core sync logic
├── chatExport.js         (~300 lines) — export/import functions
├── chatMerge.js          (~200 lines) — merge & conflict resolution
```

---

### 8. `background/autochat.js` — 1,221 Lines + `background/autochat-onlyfans.js` — 1,156 Lines
**Status:** 🔨 EXTRACT SHARED LOGIC

Both files likely share significant logic (queue management, timing, state). Combined with `sidepanel/modules/autochat-onlyfans.js` (704 lines) and the `sidepanel/modules/autochat/` folder (2,130 lines), the autochat system totals **5,211 lines across 8 files in 3 directories**.

**Proposed Restructure:**
```
background/autochat/
├── index.js              — entry point
├── core.js               — shared queue/timing/state logic
├── onlyfans.js           — OF-specific handler
├── telegram.js           — Telegram-specific handler (if exists)
```

---

## 🟡 MEDIUM — Code Duplication

### 9. Duplicate `escapeHtml` Function — 3 Implementations
| Location | Lines |
|----------|-------|
| `sidepanel/utils/sanitize.js` | `escapeHtml()` + `escapeHtmlFast()` (proper, exported) |
| `sidepanel/modules/learning.js:512` | Local `escapeHtml()` copy (should import) |
| `server/training/index.html:983` | Inline (acceptable — standalone page) |

**Fix:** In `learning.js`, delete the local `escapeHtml` and import from `utils/sanitize.js`:
```javascript
import { escapeHtml } from '../utils/sanitize.js';
```

---

### 10. Telegram Image Sending — Duplicated Across 2 Files
Both `content/telegram/index.js` and `content/telegram/monitor.js` implement:
- `sendImageToChat()`
- `tryFileInput()`
- `tryClipboardPaste()` / `tryComposerPaste()`
- `tryDragAndDrop()` / `tryComposerDrop()`

These are slightly different implementations of the same thing. **~600 lines of near-duplicate code.**

**Fix:** Extract into `content/telegram/shared/media.js` and import from both files.

---

## 🟡 MEDIUM — CSS Issues

### 11. `styles/features/_chat.css` — 3,231 Lines (Largest Single CSS File)
**Status:** 🔨 SPLIT

A single CSS file for the entire chat feature is too large to maintain.

**Proposed Split:**
```
styles/features/chat/
├── _chat-core.css        (~800 lines)  — base chat layout, messages
├── _chat-actions.css     (~600 lines)  — action buttons, quick replies
├── _chat-media.css       (~500 lines)  — media previews, image display
├── _chat-vault.css       (~400 lines)  — vault-specific styles
├── _chat-sync.css        (~300 lines)  — sync indicators, status
└── _chat-responsive.css  (~300 lines)  — media queries
```

Update `main.css` to import the individual files.

---

### 12. Other Large CSS Files
| File | Lines | Recommendation |
|------|-------|----------------|
| `_scripts.css` | 1,685 | Split into `_scripts-editor.css`, `_scripts-calendar.css`, `_scripts-list.css` |
| `_autochat.css` | 1,532 | Split into `_autochat-core.css`, `_autochat-queue.css` |
| `_broadcast.css` | 1,164 | Acceptable if growing, consider split at 1,500 |

---

## 🟢 LOW — Code Hygiene

### 13. 991 `console.log` Statements — No Log Levels
| Area | Count |
|------|-------|
| `sidepanel/` | 577 |
| `content/` | 183 |
| `background/` | 149 |
| `server/` | 82 |
| **Total** | **991** |

**Problem:** No way to:
- Filter log levels (debug vs error vs info)
- Disable logging in production
- Search for specific log categories

**Fix Option A (Quick):** Create `utils/logger.js`:
```javascript
const LOG_LEVEL = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const currentLevel = process.env.NODE_ENV === 'production' ? LOG_LEVEL.WARN : LOG_LEVEL.DEBUG;

export const logger = {
  debug: (...args) => currentLevel <= LOG_LEVEL.DEBUG && console.log('[DEBUG]', ...args),
  info: (...args) => currentLevel <= LOG_LEVEL.INFO && console.log('[INFO]', ...args),
  warn: (...args) => currentLevel <= LOG_LEVEL.WARN && console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};
```

**Fix Option B (Gradual):** Replace `console.log` with tagged prefixes first (`[Chat]`, `[AI]`, `[Sync]`), then migrate to logger later. Many files already use prefixes like `[Chat]` which is good.

---

### 14. Webpack Only Bundles Content Scripts
The `webpack.config.js` only bundles `content/index.js`. The sidepanel modules use native ES modules (`import`/`export`). This is fine for Chrome Extensions (Manifest V3 supports ES modules), but means:
- No tree-shaking for sidepanel
- No dead code elimination
- No minification for sidepanel JS

**Recommendation:** Consider adding sidepanel entry point to webpack for production builds. Low priority — Chrome extensions don't have the same perf requirements as web apps.

---

### 15. Inconsistent Module Patterns
| Pattern | Where Used |
|---------|-----------|
| ES Modules (`import`/`export`) | `sidepanel/` |
| IIFE (Immediately Invoked) | `content/telegram/` |
| CommonJS (`require`/`module.exports`) | `server/`, `background/` |

This is partially dictated by Chrome Extension architecture (content scripts need IIFE/bundling, service worker uses importScripts), but the telegram content scripts could be cleaner.

---

## PRIORITY MATRIX

| Priority | Item | Effort | Impact | Lines Affected |
|----------|------|--------|--------|----------------|
| **P0 — Quick Wins** | Delete `sidepanel.css` | 🟢 None | Delete 3,098 lines | 3,098 |
| **P0 — Quick Wins** | Delete `ai-old-prompt-backup.js` | 🟢 None | Delete 445 lines | 445 |
| **P0 — Quick Wins** | Fix `escapeHtml` duplicate in learning.js | 🟢 5 min | Remove duplication | 15 |
| **P1 — This Sprint** | Split `sidepanel/modules/ai.js` (2,165 lines) | 🟡 2-3 hrs | Major maintainability gain | 2,165 |
| **P1 — This Sprint** | Split `server/routes/ai.js` (1,761 lines) — at minimum extract prompts | 🟡 1-2 hrs | Prompts become manageable | 1,761 |
| **P1 — This Sprint** | Extract shared Telegram media utils | 🟡 1-2 hrs | Eliminate ~600 lines duplication | 600 |
| **P2 — Next Sprint** | Split `telegram/monitor.js` (1,932 lines) | 🟡 2-3 hrs | Maintainability | 1,932 |
| **P2 — Next Sprint** | Split `telegram/index.js` (1,610 lines) | 🟡 2-3 hrs | Maintainability | 1,610 |
| **P2 — Next Sprint** | Split `_chat.css` (3,231 lines) | 🟡 1-2 hrs | CSS maintainability | 3,231 |
| **P2 — Next Sprint** | Split `chatSync.js` (1,056 lines) | 🟡 1-2 hrs | Maintainability | 1,056 |
| **P3 — Backlog** | Logger utility + gradual migration | 🔴 Ongoing | Production debugging | 991 calls |
| **P3 — Backlog** | Background autochat restructure | 🔴 3-4 hrs | Architecture | 5,211 |
| **P3 — Backlog** | Additional CSS splits | 🟡 1-2 hrs | CSS maintainability | 3,217 |
| **P3 — Backlog** | Webpack sidepanel bundling | 🔴 4-6 hrs | Optimization | — |

---

## IDEAL FILE SIZE GUIDELINES

| File Type | Max Lines | Reasoning |
|-----------|-----------|-----------|
| **Route file** (server) | 300 | One concern per file |
| **Module** (JS) | 400 | Fits in one mental model |
| **Utility** (JS) | 200 | Single-purpose helpers |
| **CSS feature file** | 500 | One visual component |
| **Component** (JS) | 300 | Single UI component |
| **Index/entry** | 100 | Orchestration only |

Files over 500 lines should be split. Files over 1,000 lines are a **code smell**. Files over 2,000 lines are **unmaintainable**.

---

## BEFORE vs AFTER (Projected)

| Metric | Current | After P0+P1 | After All |
|--------|---------|-------------|-----------|
| Dead code lines | 3,543 | 0 | 0 |
| Files over 1,000 lines | 16 | 10 | 3-4 |
| Files over 2,000 lines | 3 | 0 | 0 |
| Duplicate functions | 3 | 0 | 0 |
| Duplicate utility code | ~600 lines | 0 | 0 |
| Code Health Rating | 5.5/10 | 7.0/10 | 8.5/10 |

---

*This is an analysis report. No code changes were made. Ready to implement on approval — recommended starting with P0 quick wins.*
