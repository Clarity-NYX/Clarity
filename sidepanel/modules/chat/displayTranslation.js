// ============================================================
// DISPLAYED-CHAT TRANSLATION MODULE
// Translates the visible conversation into a chosen language with
// native-sounding output (not word-for-word). The chosen language is a
// GLOBAL preference — set it once and every chat opens already translated
// into that language. Translation caches are keyed by message and stored
// per-subscriber so they survive re-renders and avoid re-paying to
// translate the same text twice.
// ============================================================

import Store from '../../state/store.js';
import API from '../../utils/api.js';
import { $ } from '../../utils/dom.js';
import { showNotification, showError } from '../../utils/notify.js';
import { updateCreditsFromResponse } from '../credits.js';
import { getMessageKey, deduplicateForDisplay, renderChatMessages } from './chatRenderer.js';

// Cap batch requests to avoid oversized payloads / excessive credit spend
const MAX_TRANSLATE_MESSAGES = 200;

// Guard against overlapping auto-translate passes for new messages
let autoTranslateInFlight = false;

// GLOBAL display-language preference (applies to every chat)
const GLOBAL_LANG_KEY = 'chatDisplayLang_global';

// Per-subscriber translation cache key (translations are chat-specific)
const transStorageKey = (subId) => `chatTranslations_${subId}`;

// Read the global display-language preference
const getGlobalLang = async () => {
  try {
    const data = await chrome.storage.local.get(GLOBAL_LANG_KEY);
    return data[GLOBAL_LANG_KEY] || '';
  } catch (err) {
    console.error('[Chat] Failed to read global display language:', err);
    return '';
  }
};

// Persist the global display language (shared across all chats)
const persistGlobalLang = async (lang) => {
  try {
    await chrome.storage.local.set({ [GLOBAL_LANG_KEY]: lang || '' });
  } catch (err) {
    console.error('[Chat] Failed to persist global display language:', err);
  }
};

// Persist the per-subscriber translation cache
const persistTranslations = async (subId, translations) => {
  if (!subId) return;
  try {
    await chrome.storage.local.set({ [transStorageKey(subId)]: translations || {} });
  } catch (err) {
    console.error('[Chat] Failed to persist chat translations:', err);
  }
};


// Collect translatable items (skip empty / media-only messages).
// If onlyMissing is true, skip messages that already have a translation.
const collectItems = (translations, onlyMissing) => {
  const rawMessages = Store.get('messages') || [];
  const messages = deduplicateForDisplay(rawMessages);
  const items = [];
  messages.forEach((msg, idx) => {
    const text = (msg.text || '').trim();
    const isMediaOnly = msg.mediaType && /^\[.+\]$/.test(msg.text || '');
    if (!text || isMediaOnly) return;
    const key = getMessageKey(msg, idx);
    if (onlyMissing && translations[key]) return;
    items.push({ key, text });
  });
  return items;
};

// Translate a batch of items into targetLang, merge into translations map.
// Returns the (possibly updated) translations map, or null on failure.
const translateItems = async (items, targetLang, baseTranslations) => {
  const capped = items.slice(-MAX_TRANSLATE_MESSAGES);
  const result = await API.translateChat({
    messages: capped.map((i) => i.text),
    targetLang
  });

  if (!result?.success || !Array.isArray(result.translations)) {
    throw new Error(result?.error || 'Translation failed');
  }

  const map = { ...baseTranslations };
  capped.forEach((item, i) => {
    map[item.key] = result.translations[i] || item.text;
  });

  updateCreditsFromResponse(result);
  return map;
};

// ============================================================
// DROPDOWN HANDLER — user picked a language (or reverted to Original)
// ============================================================
export const handleDisplayLangChange = async (targetLang) => {
  const select = $('chatDisplayLangSelect');
  const subId = Store.get('currentSubscriberId');

  // Empty value → revert to original text (globally)
  if (!targetLang) {
    Store.set('chatDisplayLang', '');
    Store.set('chatTranslations', null);
    await persistGlobalLang('');
    renderChatMessages();
    return;
  }

  // Save the global language preference immediately so it applies to every
  // chat, even if the current one has no translatable messages.
  Store.set('chatDisplayLang', targetLang);
  await persistGlobalLang(targetLang);

  const items = collectItems({}, false);
  if (!items.length) {
    showNotification(`🌐 Language set — chats will show in ${targetLang.toUpperCase()}`);
    return;
  }

  if (select) select.disabled = true;
  showNotification('🌐 Translating chat…');

  try {
    const map = await translateItems(items, targetLang, {});
    Store.set('chatTranslations', map);
    await persistTranslations(subId, map);
    renderChatMessages();
    showNotification('✅ Chat translated');
  } catch (err) {
    console.error('[Chat] Translate chat error:', err);
    showError('Failed to translate chat: ' + (err.message || 'unknown error'));
  } finally {
    if (select) select.disabled = false;
  }
};


// ============================================================
// RESTORE — called when a chat opens: reload the saved language +
// translations for this subscriber, then fill any gaps.
// ============================================================
export const restoreDisplayLang = async () => {
  const subId = Store.get('currentSubscriberId');
  const select = $('chatDisplayLangSelect');

  // The language is a GLOBAL preference, so read it regardless of which
  // chat is open. Reflect it in the dropdown immediately.
  const lang = await getGlobalLang();
  Store.set('chatDisplayLang', lang);
  if (select) select.value = lang;

  if (!subId) {
    Store.set('chatTranslations', null);
    return;
  }

  try {
    const data = await chrome.storage.local.get(transStorageKey(subId));
    const translations = data[transStorageKey(subId)] || null;
    Store.set('chatTranslations', translations);

    if (lang) {
      // Auto-translate this chat into the global language, filling any gaps
      // (cached translations are reused, only new messages cost credits).
      await translateNewMessages();
    } else {
      renderChatMessages();
    }
  } catch (err) {
    console.error('[Chat] Failed to restore display translation state:', err);
  }
};


// ============================================================
// AUTO-TRANSLATE NEW MESSAGES — called after incoming messages render.
// No-op if no display language is active. Only translates untranslated
// messages, then persists and re-renders.
// ============================================================
export const translateNewMessages = async () => {
  const targetLang = Store.get('chatDisplayLang');
  if (!targetLang) return; // Display language not active

  if (autoTranslateInFlight) return; // Avoid overlapping passes
  autoTranslateInFlight = true;

  const subId = Store.get('currentSubscriberId');
  const existing = Store.get('chatTranslations') || {};

  try {
    const missing = collectItems(existing, true);
    if (!missing.length) return;

    const map = await translateItems(missing, targetLang, existing);

    // Bail if the user switched chats while we were translating
    if (Store.get('currentSubscriberId') !== subId) return;

    Store.set('chatTranslations', map);
    await persistTranslations(subId, map);
    renderChatMessages();
  } catch (err) {
    console.error('[Chat] Auto-translate new messages error:', err);

  } finally {
    autoTranslateInFlight = false;
  }
};
