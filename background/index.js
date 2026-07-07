// ============================================================
// CLARITY NOTES - BACKGROUND SERVICE WORKER
// Main entry point - imports all modules
// ============================================================

import { DEFAULT_SCRIPTS } from './config.js';
import { handlers } from './handlers.js';
import { AutoChatState, handleChatListUpdate, handleNewUnreads, handleNewMessages, startAutoChatMonitoring } from './autochat.js';
import { setupTabMonitoring } from './tabs.js';
import { initNyxCrmBridge, ensureBridgeAlive, handleCrmChatMessage, syncFanProfile } from './nyx-crm-bridge.js';

// ============================================================
// MESSAGE HANDLER
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message.type];
  
  if (handler) {
    const result = handler(message.data, sendResponse);
    if (result instanceof Promise) {
      result
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;
    }
    return result;
  }
  
  // Auto-chat monitor messages
  if (message.type === 'AUTOCHAT_MONITOR_READY') {
    console.log('[AutoChat] Monitor ready on tab:', sender.tab?.id);
    AutoChatState.monitorTabId = sender.tab?.id;
    if (AutoChatState.enabled) {
      chrome.tabs.sendMessage(sender.tab.id, { type: 'AUTOCHAT_START_MONITORING' }).catch(() => {});
    }
    return false;
  }
  
  if (message.type === 'AUTOCHAT_CHAT_LIST') {
    handleChatListUpdate(message.data);
    return false;
  }
  
  if (message.type === 'AUTOCHAT_NEW_UNREADS') {
    handleNewUnreads(message.data);
    return false;
  }
  
  if (message.type === 'AUTOCHAT_NEW_MESSAGES') {
    handleNewMessages(message.data);
    return false;
  }
  
  // ── CHAT_MESSAGES / NEW_MESSAGE — Route to CRM bridge for Firestore sync ──
  // These come from the OF content script. We handle them HERE (not in a separate
  // listener) so that `return true` is guaranteed — Chrome MV3 needs the PRIMARY
  // listener to keep the SW alive for async Firestore writes.
  if (sender?.tab?.url?.includes('onlyfans.com') &&
      (message.type === 'CHAT_MESSAGES' || message.type === 'NEW_MESSAGE')) {
    const urlMatch = sender.tab.url.match(/\/my\/chats\/chat\/(\d+)/);
    if (urlMatch) {
      const fanId = urlMatch[1];
      handleCrmChatMessage(message.type, fanId, message.data)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ synced: false, error: err.message }));
    } else {
      sendResponse({ synced: false, reason: 'not on chat page' });
    }
    return true; // ← CRITICAL: keeps SW alive for async Firestore writes
  }

  // ── SYNC_FAN_STATS — sidepanel sends real-time stats (subscribedDays, totalSpent) ──
  // Fired when notes are saved and contain metadata fields.
  // Routes to syncFanProfile which writes directly to the conversation doc in Firestore.
  if (message.type === 'SYNC_FAN_STATS') {
    const { subscriberId, stats } = message;
    if (subscriberId && stats) {
      syncFanProfile(subscriberId, stats)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // async
    }
    return false;
  }

  // CHAT_DRAFT_STATE is a no-op at background level.
  if (message.type === 'CHAT_DRAFT_STATE') {
    return false;
  }
});

// ============================================================
// EXTENSION ICON CLICK
// ============================================================

chrome.action.onClicked.addListener(async (tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ============================================================
// CHROME ALARMS — SW KEEPALIVE FOR NYX CRM
// ============================================================

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'nyx-crm-keepalive') {
    ensureBridgeAlive().catch(() => {});
  }
});

// ============================================================
// INITIALIZATION
// ============================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  console.log('Clarity Notes installed');
  
  chrome.storage.local.get(['defaultTone', 'scripts'], (result) => {
    if (!result.defaultTone) {
      chrome.storage.local.set({ defaultTone: 'sweet' });
    }
    if (!result.scripts) {
      chrome.storage.local.set({ scripts: DEFAULT_SCRIPTS });
    }
  });
});

// Setup tab monitoring
setupTabMonitoring();

// Initialize NYX CRM bridge (fire-and-forget — failure never breaks Clarity)
initNyxCrmBridge().catch(() => {});

console.log('[Background] Service worker initialized');
