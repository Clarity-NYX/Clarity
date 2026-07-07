// ============================================================
// DISPLAYED-CHAT TRANSLATION MODULE
// Translates the visible conversation into a chosen language with
// native-sounding output (not word-for-word). Translations are keyed
// by message key so they survive re-renders, persisted per-subscriber,
// and auto-applied to newly arriving messages.
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

// Per-subscriber storage keys
const langStorageKey = (subId) => `chatDisplayLang_${subId}`;
const transStorageKey = (subId) => `chatTranslations_${subId}`;

// Persist the active display language + translation map for a subscriber
const persistDisplayState = async (subId, lang, translations) => {
  if (!subId) return;
  try {
    await chrome.storage.local.set({
      [langStorageKey(subId)]: lang || '',
      [transStorageKey(subId)]: translations || {}
    });
  } catch (err) {
    console.error('[Chat] Failed to persist display translation state:', err);
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

  // Empty value → revert to original text
  if (!targetLang) {
    Store.set('chatDisplayLang', '');
    Store.set('chatTranslations', null);
    await persistDisplayState(subId, '', {});
    renderChatMessages();
    return;
  }

  const items = collectItems({}, false);
  if (!items.length) {
    showNotification('No text messages to translate');
    if (select) select.value = '';
    return;
  }

  if (select) select.disabled = true;
  showNotification('🌐 Translating chat…');

  try {
    const map = await translateItems(items, targetLang, {});
    Store.set('chatDisplayLang', targetLang);
    Store.set('chatTranslations', map);
    await persistDisplayState(subId, targetLang, map);
    renderChatMessages();
    showNotification('✅ Chat translated');
  } catch (err) {
    console.error('[Chat] Translate chat error:', err);
    showError('Failed to translate chat: ' + (err.message || 'unknown error'));
    if (select) select.value = Store.get('chatDisplayLang') || '';
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

  if (!subId) {
    Store.set('chatDisplayLang', '');
    Store.set('chatTranslations', null);
    if (select) select.value = '';
    return;
  }

  try {
    const data = await chrome.storage.local.get([langStorageKey(subId), transStorageKey(subId)]);
    const lang = data[langStorageKey(subId)] || '';
    const translations = data[transStorageKey(subId)] || null;

    Store.set('chatDisplayLang', lang);
    Store.set('chatTranslations', translations);
    if (select) select.value = lang;

    if (lang) {
      // Fill in any messages that don't yet have a translation (new history, etc.)
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
    await persistDisplayState(subId, targetLang, map);
    renderChatMessages();
  } catch (err) {
    console.error('[Chat] Auto-translate new messages error:', err);
  } finally {
    autoTranslateInFlight = false;
  }
};
