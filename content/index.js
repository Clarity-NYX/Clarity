// ============================================================
// CONTENT SCRIPT - Main entry point
// Clean, modular structure for OnlyFans content script
// ============================================================

import { scrapeChatList, scrapeChatListWithTimestamps } from './onlyfans/chat-list-extractor.js';
import { startChatListObserver, startChatListPolling, startPageWatching } from './onlyfans/dom-observer.js';
import { sendMessageToChat, sendImageToChat, loadTypingSpeed, setupTypingSpeedListener, findChatInput } from './onlyfans/message-sender.js';
import { 
  extractAllMessages, 
  autoLoadChat, 
  scrapeProfileStats,
  isOnProfilePage 
} from './onlyfans/message-extractor.js';
// Vault scanner functionality removed - media sending no longer supported

(function() {
  'use strict';
  
  // ============================================================
  // INITIALIZATION
  // ============================================================
  
  function init() {
    console.log('[Clarity] Content script loaded');
    setupMessageListener();
    startWatching();
    
    // Load typing speed setting
    loadTypingSpeed();
    setupTypingSpeedListener();
    
    // Start chat list observer and polling for auto-chat push updates
    if (window.location.href.includes('onlyfans.com')) {
      setTimeout(startChatListObserver, 2000);
      setTimeout(startChatListPolling, 1500); // Start 1-second polling
    }
    
    // Vault scanner functionality removed
  }
  
  // ============================================================
  // MESSAGE LISTENER
  // ============================================================
  
  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'GET_MESSAGES') {
        if (!isOnChatPage()) {
          sendChatMessages([]);
          sendResponse({ success: false, error: 'Not on a chat page' });
          return true;
        }
        
        const extracted = extractAllMessages();
        sendChatMessages(extracted);
        sendResponse({ success: true, count: extracted.length });
        return true;
      }
      
      // Handle chat list scraping request
      if (message.type === 'GET_CHAT_LIST') {
        console.log('[Content] GET_CHAT_LIST requested');
        const result = scrapeChatList();
        sendResponse(result);
        return true;
      }
      
      // Handle chat list with timestamps for auto-chat
      if (message.type === 'GET_CHAT_LIST_WITH_TIMESTAMPS') {
        console.log('[Content] GET_CHAT_LIST_WITH_TIMESTAMPS requested');
        const result = scrapeChatListWithTimestamps();
        sendResponse(result);
        return true;
      }
      
      // Handle auto-send message request
      if (message.type === 'SEND_MESSAGE') {
        console.log('[Clarity] Auto-send message requested');
        sendMessageToChat(message.text)
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // Keep channel open for async response
      }
      
      // Handle image sending request (for OnlyFans)
      if (message.type === 'SEND_IMAGE') {
        console.log('[Clarity] 📸 Image send requested');
        sendImageToChat(message.imageUrl, message.caption, message.price || 0)
          .then(result => {
            console.log('[Clarity] 📸 Image send result:', result);
            sendResponse(result);
          })
          .catch(err => {
            console.error('[Clarity] 📸 Image send error:', err);
            sendResponse({ success: false, error: err.message });
          });
        return true; // Keep channel open for async response
      }
      
      // Handle profile stats scraping request
      if (message.type === 'SCRAPE_PROFILE_STATS') {
        console.log('[Clarity] Scraping profile stats...');
        
        // Wait a bit for page to fully load
        setTimeout(() => {
          const stats = scrapeProfileStats();
          console.log('[Clarity] Scraped stats:', stats);
          sendResponse({ success: true, stats });
        }, 1500);
        
        return true; // Keep channel open for async response
      }
      
      // ============================================================
      // CHAT READINESS CHECKS (for reliable auto-chat sending)
      // ============================================================
      
      // Check if chat page is fully loaded and ready
      if (message.type === 'IS_CHAT_READY') {
        const isReady = isChatFullyLoaded();
        console.log(`[Clarity] IS_CHAT_READY check: ${isReady ? '✅ Ready' : '⏳ Not ready'}`);
        sendResponse({ ready: isReady });
        return true;
      }
      
      // Check if chat input field is available
      if (message.type === 'CHECK_CHAT_INPUT') {
        const input = findChatInput();
        const found = !!input;
        console.log(`[Clarity] CHECK_CHAT_INPUT: ${found ? '✅ Found' : '❌ Not found'}`);
        sendResponse({ found, inputType: input?.tagName || null });
        return true;
      }
    });
  }
  
  function sendChatMessages(data) {
    chrome.runtime.sendMessage({ type: 'CHAT_MESSAGES', data }).catch(() => {});
  }
  
  // ============================================================
  // PAGE WATCHING
  // ============================================================
  
  function startWatching() {
    let lastUrl = window.location.href;
    
    // Set up page watching with callback for chat page detection
    startPageWatching((currentUrl) => {
      if (isOnChatPage()) {
        // Multiple attempts to ensure messages load
        console.log('[Clarity] Entered chat page, scheduling message extraction...');
        setTimeout(autoLoadChat, 500);   // Quick first attempt
        setTimeout(autoLoadChat, 1500);  // Second attempt
        setTimeout(autoLoadChat, 3000);  // Third attempt (for slow loads)
      }
      
    });
    
    // Initial load
    if (isOnChatPage()) {
      setTimeout(autoLoadChat, 1500);
    }
  }
  
  // ============================================================
  // HELPERS
  // ============================================================
  
  function isOnChatPage() {
    const url = window.location.href;
    const isChatUrl = url.includes('/my/chats/chat/') || url.includes('/messages/');
    const hasChat = !!document.querySelector('.b-chat__messages-wrapper, .b-chat__content');
    return isChatUrl || hasChat;
  }
  
  // Check if chat page is fully loaded (for reliable message sending)
  function isChatFullyLoaded() {
    // Check 1: URL must be a chat page
    const url = window.location.href;
    if (!url.includes('/my/chats/chat/')) {
      return false;
    }
    
    // Check 2: Chat messages container must exist
    const messagesContainer = document.querySelector(
      '.b-chat__messages-wrapper, ' +
      '.b-chat__content, ' +
      '[class*="chat__messages"], ' +
      '.m-native-custom-scrollbar'
    );
    if (!messagesContainer) {
      return false;
    }
    
    // Check 3: Chat input field must exist and be visible
    const chatInput = findChatInput();
    if (!chatInput) {
      return false;
    }
    
    // Check 4: Input must be interactable (not disabled, has some dimensions)
    if (chatInput.disabled) {
      return false;
    }
    
    // Check 5: Chat header with name should exist (indicates chat fully loaded)
    const chatHeader = document.querySelector(
      '.b-chat__header, ' +
      '.g-user-name, ' +
      '[class*="chat-header"], ' +
      '.b-username'
    );
    if (!chatHeader) {
      return false;
    }
    
    // All checks passed - chat is ready!
    return true;
  }
  
  // ============================================================
  // START
  // ============================================================
  
  init();
})();