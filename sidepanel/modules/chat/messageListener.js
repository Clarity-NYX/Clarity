// ============================================================
// MESSAGE LISTENER MODULE - Handles incoming messages
// ============================================================

import Store from '../../state/store.js';
import { hideError } from '../../utils/notify.js';
import { checkGoalCompletion } from '../scripts/index.js';
import { handleIncomingMessages } from './chatSync.js';
import { syncNewMessagesToDatabase } from './chatStorage.js';
import { renderChatMessages } from './chatRenderer.js';
import { updateUnreadChats, handleNewUnreadDetected } from './chatAlarm.js';
import { loadChatList, renderChatList, updateAutoChatState } from './chatList.js';
import { $ } from '../../utils/dom.js';

// Setup message listener
export const setupMessageListener = () => {
  console.log('[Chat] Setting up message listener...');
  
  chrome.runtime.onMessage.addListener((message) => {
    console.log('[Chat] Received message:', message.type, message.platform || '', message.data?.length || 0, 'items');
    
    // Handle chat list refresh from content script polling (every 1 second)
    if (message.type === 'CHAT_LIST_REFRESH') {
      console.log('[Chat] 🔄 Chat list refresh triggered with', message.data?.length || 0, 'chats');
      
      // Update unread alarm tracking (for continuous alarm)
      if (message.data && Array.isArray(message.data)) {
        updateUnreadChats(message.data);
      }
      
      // Render the chat list directly from pushed data if we're viewing it
      const chatListView = $('chatListView');
      if (chatListView && !chatListView.classList.contains('hidden')) {
        if (message.data && Array.isArray(message.data) && message.data.length > 0) {
          // Render directly from pushed data (faster than re-scraping)
          renderChatList(message.data);
          const chatListCount = $('chatListCount');
          if (chatListCount) chatListCount.textContent = `${message.data.length} chats`;
        } else {
          // Fallback to scraping if no data
          loadChatList();
        }
      }
      return;
    }
    
    // Handle new unread message detection - start/update continuous alarm
    if (message.type === 'NEW_UNREAD_DETECTED') {
      handleNewUnreadDetected(message);
      return;
    }
    
    // Handle auto-chat opening a chat - trigger chat detection/sync
    if (message.type === 'AUTOCHAT_CHAT_OPENED') {
      console.log('[Chat] 🤖 Auto-chat opened a chat:', message.data?.chatName);
      // Import and call detectAndSyncChat to load the newly opened chat
      import('./chatSync.js').then(module => {
        setTimeout(() => {
          module.detectAndSyncChat();
        }, 500); // Small delay to ensure chat is fully loaded
      });
      return;
    }
    
    // Handle auto-chat state changes - update cache and re-render chat list
    if (message.type === 'OF_AUTOCHAT_STATE_CHANGED') {
      console.log('[Chat] 🤖 Auto-chat state updated');
      updateAutoChatState({
        enabled: message.data?.enabled || false,
        activePool: message.data?.activePool || []
      });
      // Re-render chat list if visible to show updated response previews
      const chatListView = $('chatListView');
      if (chatListView && !chatListView.classList.contains('hidden')) {
        loadChatList();
      }
      return;
    }
    
    if (message.type === 'CHAT_MESSAGES') {
      const newMessages = message.data || [];
      console.log('[Chat] CHAT_MESSAGES received:', newMessages.length, 'messages, platform:', message.platform);
      
      if (Store.get('currentProfile') && Store.get('currentSubscriberId')) {
        handleIncomingMessages(newMessages);
      } else {
        console.log('[Chat] No profile/subscriber, storing messages directly');
        Store.set('messages', newMessages);
        renderChatMessages();
      }
      hideError();
    }
    
    if (message.type === 'NEW_MESSAGE') {
      const messages = Store.get('messages') || [];
      const newMsg = message.data;
      
      // CRITICAL: Check for duplicates before adding
      // Check by text, sender, and approximate time
      const isDuplicate = messages.some(existing => 
        existing.text === newMsg.text && 
        existing.isFromMe === newMsg.isFromMe &&
        // If both have times, check if they're the same
        ((!existing.time && !newMsg.time) || 
         (existing.time === newMsg.time) ||
         // Also check datetime if available
         (existing.datetime && newMsg.datetime && existing.datetime === newMsg.datetime))
      );
      
      if (isDuplicate) {
        console.log('[Chat] ⚠️ Duplicate message detected, ignoring:', newMsg.text?.substring(0, 50));
        return;
      }
      
      console.log('[Chat] Adding new message:', newMsg.text?.substring(0, 50));
      messages.push(newMsg);
      Store.set('messages', messages);
      renderChatMessages();
      
      if (Store.get('currentProfile') && Store.get('currentSubscriberId')) {
        syncNewMessagesToDatabase([newMsg]);
        
        // If this is OUR message, check if goal was achieved
        if (newMsg.isFromMe) {
          setTimeout(() => checkGoalCompletion(), 500);
        }
      }
    }
  });
};