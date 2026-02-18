// ============================================================
// CLARITY NOTES - BACKGROUND SERVICE WORKER
// Main entry point - imports all modules
// ============================================================

import { DEFAULT_SCRIPTS } from './config.js';
import { handlers } from './handlers.js';
import { AutoChatState, handleChatListUpdate, handleNewUnreads, handleNewMessages, startAutoChatMonitoring } from './autochat.js';
import { setupTabMonitoring } from './tabs.js';

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
  
  // Forward chat messages (no response needed)
  if (message.type === 'CHAT_MESSAGES' || message.type === 'NEW_MESSAGE') {
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

console.log('[Background] Service worker initialized');
