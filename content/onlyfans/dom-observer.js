// ============================================================
// DOM OBSERVER - Monitors DOM changes for chat list and messages
// ============================================================
// PERFORMANCE-OPTIMIZED:
// - Targeted MutationObserver (not body-wide) with auto-disconnect
// - Event-driven URL detection via History API (no polling)
// - MutationObserver is primary; polling is fallback only
// - Smart activity-based intervals when polling is needed
// ============================================================

import { scrapeChatListWithTimestamps } from './chat-list-extractor.js';
import { SELECTORS, SMART_INTERVALS } from './constants.js';

// Chat list observer state
let chatListObserver = null;
let lastChatListHash = '';
let chatListDebounceTimer = null;
let chatListPollInterval = null;

// Page observer state (targeted, auto-disconnecting)
let pageObserver = null;
let pageObserverTimeout = null;

// Activity tracking for smart intervals
let lastActivityTime = Date.now();
let currentPollInterval = SMART_INTERVALS.normal;
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
    }, 200); // 200ms debounce
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
  
  // MutationObserver is primary — disable polling if it was running
  if (chatListPollInterval) {
    console.log('[Clarity] Observer active — stopping redundant polling');
    stopChatListPolling();
  }
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
// CHAT LIST POLLING - Fallback only (when MutationObserver can't attach)
// ============================================================

export function startChatListPolling() {
  if (chatListPollInterval) return; // Already running
  
  // If MutationObserver is active, don't start polling — observer is primary
  if (chatListObserver) {
    console.log('[Clarity] Observer is active — skipping polling start');
    return;
  }
  
  console.log(`[Clarity] Starting fallback chat list polling (every ${currentPollInterval}ms)...`);
  
  const pollFunction = () => {
    // Only poll if on OnlyFans
    if (!window.location.href.includes('onlyfans.com')) {
      stopChatListPolling();
      return;
    }
    
    // Check for idle state
    checkIdleState();
    
    // Try to upgrade to MutationObserver if container is now available
    const chatListContainer = document.querySelector(SELECTORS.chatListContainer);
    if (chatListContainer && !chatListObserver) {
      console.log('[Clarity] Chat list container found — upgrading to MutationObserver');
      stopChatListPolling();
      startChatListObserver();
      return;
    }
    
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
// PAGE WATCHING - Event-driven URL detection + targeted observer
// ============================================================
// PERFORMANCE: Replaces body-wide MutationObserver + 300ms polling
// with History API interception (zero-cost) + targeted observer
// that auto-disconnects after finding the chat container.
// ============================================================

export function startPageWatching(onChatPageEntered) {
  let lastUrl = window.location.href;
  
  // ----------------------------------------------------------
  // URL change detection via History API interception (zero polling)
  // ----------------------------------------------------------
  const handleUrlChange = () => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      const previousUrl = lastUrl;
      lastUrl = currentUrl;
      
      console.log('[Clarity] URL changed:', previousUrl, '->', currentUrl);
      
      if (onChatPageEntered) {
        onChatPageEntered(currentUrl);
      }
      
      // Re-observe for chat container on navigation
      observeForChatContainer(onChatPageEntered);
    }
  };
  
  // Intercept pushState (SPA navigations)
  const originalPushState = history.pushState;
  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    handleUrlChange();
  };
  
  // Intercept replaceState
  const originalReplaceState = history.replaceState;
  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    handleUrlChange();
  };
  
  // Handle browser back/forward
  window.addEventListener('popstate', handleUrlChange);
  
  // ----------------------------------------------------------
  // Targeted chat container observer (replaces body-wide observer)
  // ----------------------------------------------------------
  observeForChatContainer(onChatPageEntered);
}

// Observe for chat container appearance — targeted, auto-disconnecting
function observeForChatContainer(onChatPageEntered) {
  // Disconnect any existing page observer first
  disconnectPageObserver();
  
  // If chat container already exists, just notify and return
  const existing = document.querySelector('.b-chat__messages-wrapper, .b-chat__content, .b-chat__message');
  if (existing) {
    if (onChatPageEntered) {
      setTimeout(() => onChatPageEntered(window.location.href), 100);
    }
    return;
  }
  
  // Find the narrowest possible observation target
  // OnlyFans main content area — much narrower than document.body
  const observeTarget = document.querySelector(
    '#content, .l-wrapper__content, main, [role="main"]'
  ) || document.body;
  
  pageObserver = new MutationObserver((mutations, observer) => {
    for (const mutation of mutations) {
      if (mutation.type !== 'childList' || !mutation.addedNodes.length) continue;
      
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        
        // Check if chat container loaded
        if (node.classList?.contains('b-chat__messages-wrapper') ||
            node.classList?.contains('b-chat__content') ||
            node.classList?.contains('b-chat__message')) {
          // Found — disconnect immediately to stop observing
          disconnectPageObserver();
          if (onChatPageEntered) {
            setTimeout(() => onChatPageEntered(window.location.href), 500);
          }
          return;
        }
        
        // Also check first-level children (one level deep only, not full subtree query)
        if (node.children) {
          for (const child of node.children) {
            if (child.classList?.contains('b-chat__messages-wrapper') ||
                child.classList?.contains('b-chat__content') ||
                child.classList?.contains('b-chat__message')) {
              disconnectPageObserver();
              if (onChatPageEntered) {
                setTimeout(() => onChatPageEntered(window.location.href), 500);
              }
              return;
            }
          }
        }
      }
    }
  });
  
  pageObserver.observe(observeTarget, { childList: true, subtree: true });
  
  // Safety: auto-disconnect after 30 seconds to prevent indefinite observation
  pageObserverTimeout = setTimeout(() => {
    if (pageObserver) {
      console.log('[Clarity] Page observer timeout — disconnecting (chat container not found in 30s)');
      disconnectPageObserver();
    }
  }, 30000);
}

// Clean disconnect of page observer
function disconnectPageObserver() {
  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = null;
  }
  if (pageObserverTimeout) {
    clearTimeout(pageObserverTimeout);
    pageObserverTimeout = null;
  }
}
