// ============================================================
// MESSAGE LISTENER MODULE - Handles incoming messages
// ============================================================

import Store from '../../state/store.js';
import { hideError, showNotification } from '../../utils/notify.js';
import { checkGoalCompletion } from '../scripts/index.js';
import { handleIncomingMessages } from './chatSync.js';
import { saveFullChatReplacement } from './chatStorage.js';
import { renderChatMessages, displaySubscriberStats, renderDraftBar } from './chatRenderer.js';
import { translateNewMessages } from './displayTranslation.js';

import { updateUnreadChats, handleNewUnreadDetected } from './chatAlarm.js';
import { loadChatList, renderChatList, updateAutoChatState } from './chatList.js';
import { saveNotesToDB } from '../notes.js';
import { $ } from '../../utils/dom.js';

// Track payment statuses to detect unpaid → paid transitions
let previousPaymentStatuses = new Map(); // msgKey → 'unpaid' | 'paid'

// ============================================================
// DRAFT STATE POLLING — Pull-based real-time draft detection
// ============================================================
// The push-based MutationObserver in the content script is unreliable
// (depends on correct DOM selectors, observer attaching, etc.).
// This pull-based approach directly queries the content script every 500ms
// via chrome.tabs.sendMessage → GET_DRAFT_STATE. It works as long as
// the content script is loaded — no observer needed.
// ============================================================

let draftPollInterval = null;
let lastDraftPollKey = '';

const startDraftPolling = () => {
  if (draftPollInterval) return; // Already polling
  
  console.log('[Chat] 📝 Starting draft state polling (500ms pull from content script)');
  
  draftPollInterval = setInterval(async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url?.includes('onlyfans.com')) return;
      
      chrome.tabs.sendMessage(tab.id, { type: 'GET_DRAFT_STATE' }, (response) => {
        if (chrome.runtime.lastError) return; // Tab not ready or content script not loaded
        
        const draft = response?.draft || null;
        const draftKey = draft ? `${draft.text || ''}|${(draft.media || []).length}` : '';
        
        // Only update UI if draft actually changed (avoid unnecessary re-renders)
        if (draftKey !== lastDraftPollKey) {
          lastDraftPollKey = draftKey;
          console.log(`[Chat] 📝 Draft poll: ${draft ? `"${(draft.text || '').substring(0, 40)}" + ${(draft.media || []).length} media` : 'empty'}`);
          Store.set('currentDraft', draft);
          renderDraftBar(draft);
        }
      });
    } catch (e) {
      // Silently ignore — tab might not be ready
    }
  }, 500);
};

const stopDraftPolling = () => {
  if (draftPollInterval) {
    clearInterval(draftPollInterval);
    draftPollInterval = null;
    lastDraftPollKey = '';
    console.log('[Chat] 📝 Stopped draft state polling');
  }
};

// Setup message listener
export const setupMessageListener = () => {
  console.log('[Chat] Setting up message listener...');
  
  // ── Start draft state polling immediately ──
  // This runs in the background and polls the content script for compose box state.
  // It self-checks that we're on an OF tab, so it's safe to start unconditionally.
  startDraftPolling();
  
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
    
    // ── Draft State: content script sends this when compose box text/media changes ──
    if (message.type === 'CHAT_DRAFT_STATE') {
      console.log(`[ DRAFT-DEBUG SP] Received CHAT_DRAFT_STATE:`, message.data ? `text="${(message.data.text || '').substring(0, 30)}", media=${(message.data.media || []).length}` : 'null');
      Store.set('currentDraft', message.data || null);
      renderDraftBar(message.data);
      return;
    }

    if (message.type === 'CHAT_MESSAGES') {
      // CRITICAL: Skip ALL message processing if delete is in progress
      if (Store.get('_deleteInProgress')) {
        console.log('[Chat] 🗑️ Delete in progress — ignoring CHAT_MESSAGES');
        return;
      }
      
      const newMessages = message.data || [];
      console.log('[Chat] CHAT_MESSAGES received:', newMessages.length, 'messages, platform:', message.platform);
      
      // ── Track payment status transitions (unpaid → paid) ──
      checkPaymentTransitions(newMessages);
      
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
      // CRITICAL: Skip individual new messages if delete is in progress
      if (Store.get('_deleteInProgress')) {
        console.log('[Chat] 🗑️ Delete in progress — ignoring NEW_MESSAGE');
        return;
      }
      
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
      
      // Auto-translate the new message if a display language is active
      // (no-op otherwise). Runs async, persists + re-renders when done.
      translateNewMessages();
      
      if (Store.get('currentProfile') && Store.get('currentSubscriberId')) {

        // Force immediate save — new messages must not be lost to debounce
        saveFullChatReplacement(messages, true);
        
        // If this is OUR message, check if goal was achieved
        if (newMsg.isFromMe) {
          setTimeout(() => checkGoalCompletion(), 500);
        }
      }
    }
  });
};

// ============================================================
// PAYMENT TRACKING - Detect unpaid → paid transitions
// ============================================================

const checkPaymentTransitions = (messages) => {
  if (!messages || !Array.isArray(messages)) return;
  
  let newlyPaidAmount = 0;
  
  for (const msg of messages) {
    if (!msg.paymentStatus || !msg.paymentAmount) continue;
    
    // Create a stable key for this message
    const key = msg.id || `${msg.order}|${msg.isFromMe ? '1' : '0'}|${msg.paymentAmount}`;
    const prevStatus = previousPaymentStatuses.get(key);
    
    // Detect unpaid → paid transition
    if (prevStatus === 'unpaid' && msg.paymentStatus === 'paid') {
      const amount = parseFloat(msg.paymentAmount.replace(/[$,]/g, '')) || 0;
      if (amount > 0) {
        newlyPaidAmount += amount;
        console.log(`[Payment] 💰 PPV paid! ${msg.paymentAmount} (message: ${key})`);
      }
    }
    
    // Update tracking map
    previousPaymentStatuses.set(key, msg.paymentStatus);
  }
  
  // If any payments came through, update totalSpent
  if (newlyPaidAmount > 0) {
    addToTotalSpent(newlyPaidAmount);
  }
};

// Add amount to the subscriber's totalSpent
const addToTotalSpent = (amount) => {
  const notes = Store.get('currentNotes') || {};
  
  // Parse current totalSpent (e.g., "$150.00" → 150.00)
  const currentSpent = parseFloat((notes.totalSpent || '$0').replace(/[$,]/g, '')) || 0;
  const newTotal = currentSpent + amount;
  const newTotalStr = `$${newTotal.toFixed(2)}`;
  
  console.log(`[Payment] 💰 Updating totalSpent: ${notes.totalSpent || '$0'} + $${amount.toFixed(2)} = ${newTotalStr}`);
  
  // Update notes in store
  notes.totalSpent = newTotalStr;
  Store.set('currentNotes', notes);
  
  // Update the UI display immediately
  displaySubscriberStats(notes);
  
  // Update the totalSpent element directly for instant feedback
  const totalSpentEl = $('totalSpent');
  if (totalSpentEl) totalSpentEl.textContent = newTotalStr;
  
  // Persist to database
  if (Store.get('currentProfile') && Store.get('currentSubscriberId')) {
    saveNotesToDB(notes);
  }
  
  showNotification(`💰 PPV Paid! +$${amount.toFixed(2)} → Total: ${newTotalStr}`);
};
