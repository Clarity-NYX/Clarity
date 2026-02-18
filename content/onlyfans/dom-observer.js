// ============================================================
// DOM OBSERVER - Monitors DOM changes for chat list and messages
// ============================================================

import { scrapeChatListWithTimestamps } from './chat-list-extractor.js';
import { SELECTORS, INTERVALS, SMART_INTERVALS } from './constants.js';

// Chat list observer state
let chatListObserver = null;
let lastChatListHash = '';
let chatListDebounceTimer = null;
let chatListPollInterval = null;

// Activity tracking for smart intervals
let lastActivityTime = Date.now();
let currentPollInterval = INTERVALS.chatListPolling;
let isAutoChatActive = false;

// ============================================================
// CHAT LIST OBSERVER - Push updates when chat list changes
// ============================================================

// Start observing the chat list sidebar for changes
export function startChatListObserver() {
  if (chatListObserver) return; // Already observing
  
  // Find the chat list container
  const chatListContainer = document.querySelector(SELECTORS.chatListContainer);
  if (!chatListContainer) {
    console.log('[Clarity] Chat list container not found, will retry...');
    setTimeout(startChatListObserver, 2000);
    return;
  }
  
  console.log('[Clarity] Starting chat list observer...');
  
  chatListObserver = new MutationObserver((mutations) => {
    // Debounce to avoid excessive updates
    if (chatListDebounceTimer) clearTimeout(chatListDebounceTimer);
    
    chatListDebounceTimer = setTimeout(() => {
      const result = scrapeChatListWithTimestamps();
      if (!result.success || !result.chats) return;
      
      // Create hash to detect actual changes
      const newHash = result.chats.map(c => `${c.rawId}:${c.isTheirMessageLast}:${c.hasUnread}`).join('|');
      
      if (newHash !== lastChatListHash) {
        lastChatListHash = newHash;
        console.log('[Clarity] Chat list changed, pushing update...');
        
        // Push to background script
        chrome.runtime.sendMessage({
          type: 'OF_CHAT_LIST_UPDATED',
          data: result.chats
        }).catch(() => {});
      }
    }, 200); // 200ms debounce for faster detection
  });
  
  chatListObserver.observe(chatListContainer, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class'] // Watch for class changes (unread indicators)
  });
  
  // Initial push
  setTimeout(() => {
    const result = scrapeChatListWithTimestamps();
    if (result.success && result.chats) {
      lastChatListHash = result.chats.map(c => `${c.rawId}:${c.isTheirMessageLast}:${c.hasUnread}`).join('|');
      chrome.runtime.sendMessage({
        type: 'OF_CHAT_LIST_UPDATED',
        data: result.chats
      }).catch(() => {});
    }
  }, 1000);
}

// Stop observing
export function stopChatListObserver() {
  if (chatListObserver) {
    chatListObserver.disconnect();
    chatListObserver = null;
  }
  if (chatListDebounceTimer) {
    clearTimeout(chatListDebounceTimer);
    chatListDebounceTimer = null;
  }
}

// ============================================================
// ACTIVITY & SMART INTERVALS
// ============================================================

// Update activity time and adjust polling interval
export function updateActivity(isAutoChat = false) {
  lastActivityTime = Date.now();
  isAutoChatActive = isAutoChat;
  
  // Determine new interval based on activity
  let newInterval;
  if (isAutoChatActive) {
    newInterval = SMART_INTERVALS.active;
  } else {
    newInterval = SMART_INTERVALS.normal;
  }
  
  // If interval changed, restart polling with new interval
  if (newInterval !== currentPollInterval) {
    currentPollInterval = newInterval;
    console.log(`[Clarity] Adjusting poll interval to ${currentPollInterval}ms (${isAutoChatActive ? 'auto-chat active' : 'normal'})`);
    
    if (chatListPollInterval) {
      stopChatListPolling();
      startChatListPolling();
    }
  }
}

// Check if idle (no activity for 2 minutes)
function checkIdleState() {
  const idleTime = Date.now() - lastActivityTime;
  if (idleTime > 120000 && currentPollInterval !== SMART_INTERVALS.idle) {
    currentPollInterval = SMART_INTERVALS.idle;
    console.log('[Clarity] Switching to idle polling (30s)');
    
    if (chatListPollInterval) {
      stopChatListPolling();
      startChatListPolling();
    }
  }
}

// ============================================================
// CHAT LIST POLLING - Smart intervals based on activity
// ============================================================

export function startChatListPolling() {
  if (chatListPollInterval) return; // Already running
  
  console.log(`[Clarity] Starting chat list polling (every ${currentPollInterval}ms)...`);
  
  const pollFunction = () => {
    // Only poll if on OnlyFans
    if (!window.location.href.includes('onlyfans.com')) {
      stopChatListPolling();
      return;
    }
    
    // Check for idle state
    checkIdleState();
    
    const result = scrapeChatListWithTimestamps();
    if (!result.success || !result.chats) return;
    
    // Create hash to detect actual changes
    const newHash = result.chats.map(c => `${c.rawId}:${c.isTheirMessageLast}:${c.hasUnread}:${c.lastMessagePreview?.substring(0,20)}`).join('|');
    
    if (newHash !== lastChatListHash) {
      lastChatListHash = newHash;
      console.log('[Clarity] Chat list changed (polling), pushing update...');
      
      // Update activity on chat list change
      updateActivity(false);
      
      // Push to background script
      chrome.runtime.sendMessage({
        type: 'OF_CHAT_LIST_UPDATED',
        data: result.chats
      }).catch(() => {});
    }
  };
  
  // Initial poll
  pollFunction();
  
  // Set up interval with current interval
  chatListPollInterval = setInterval(pollFunction, currentPollInterval);
}

export function stopChatListPolling() {
  if (chatListPollInterval) {
    console.log('[Clarity] Stopping chat list polling');
    clearInterval(chatListPollInterval);
    chatListPollInterval = null;
  }
}

// ============================================================
// PAGE WATCHING - Monitor URL changes and DOM mutations
// ============================================================

export function startPageWatching(onChatPageEntered) {
  let lastUrl = window.location.href;
  
  // URL change detection
  setInterval(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      const previousUrl = lastUrl;
      lastUrl = currentUrl;
      
      console.log('[Clarity] URL changed:', previousUrl, '->', currentUrl);
      
      // Notify callback if chat page entered
      if (onChatPageEntered) {
        onChatPageEntered(currentUrl);
      }
    }
  }, INTERVALS.urlCheck);
  
  // DOM mutation observer for dynamic content
  new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type !== 'childList' || !mutation.addedNodes.length) continue;
      
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        
        // Check if chat container loaded
        if (node.classList?.contains('b-chat__messages-wrapper') ||
            node.querySelector?.('.b-chat__messages-wrapper') ||
            node.classList?.contains('b-chat__message')) {
          if (onChatPageEntered) {
            setTimeout(() => onChatPageEntered(window.location.href), 500);
          }
          return;
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}