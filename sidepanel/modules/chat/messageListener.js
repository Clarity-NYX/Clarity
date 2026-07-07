// ============================================================
// MESSAGE LISTENER MODULE - Handles incoming messages
// ============================================================

import Store from '../../state/store.js';
import { hideError, showNotification } from '../../utils/notify.js';
import { checkGoalCompletion } from '../scripts/index.js';
import { handleIncomingMessages } from './chatSync.js';
import { syncNewMessagesToDatabase, saveFullChatReplacement } from './chatStorage.js';
import { renderChatMessages, displaySubscriberStats, renderDraftBar } from './chatRenderer.js';
import { translateNewMessages } from './displayTranslation.js';

import { updateUnreadChats, handleNewUnreadDetected } from './chatAlarm.js';
import { loadChatList, renderChatList, updateAutoChatState } from './chatList.js';
import { renderTaskDays } from './taskDays.js';
import { saveNotesToDB, displayNotes } from '../notes.js';
import { $ } from '../../utils/dom.js';
import { notifyNyxCrmVaultChanged, forceNyxCrmVaultSync, refreshDownloadURLs } from '../imagePool.js';

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

    // ── CRM_CLEANUP_COMPLETE: cleanup just finished — refresh sidepanel's chat data ──
    // After CRM cleanup re-scans all messages and writes to Firestore, the sidepanel
    // still has stale in-memory data (old 283 messages vs new 70). Trigger detectAndSyncChat
    // which re-extracts from the DOM → SAVE_CHAT → API.saveChat() (updates Heroku backend)
    // → Store update → renderChatMessages() → correct message count in sidepanel.
    if (message.type === 'CRM_CLEANUP_COMPLETE') {
      console.log('[Chat] 🧹 CRM_CLEANUP_COMPLETE — refreshing chat data for fan', message.fanId);
      import('./chatSync.js').then(module => {
        setTimeout(() => {
          module.detectAndSyncChat();
        }, 1000); // Delay to ensure cleanup lock is fully released
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
    
    // ── CRM Trigger Vault Sync: background bridge asks sidepanel to push vault data ──
    if (message.type === 'CRM_TRIGGER_VAULT_SYNC') {
      console.log('[Chat] 📦 CRM_TRIGGER_VAULT_SYNC — force-pushing vault data to Firestore');
      forceNyxCrmVaultSync();
      return;
    }

    // ── CRM Refresh Vault URLs: CRM detected expired signed URLs, asks Clarity to refresh ──
    if (message.type === 'CRM_REFRESH_VAULT_URLS') {
      console.log('[Chat] 🔄 CRM_REFRESH_VAULT_URLS — refreshing signed URLs then syncing to Firestore');
      (async () => {
        try {
          await refreshDownloadURLs();
          notifyNyxCrmVaultChanged();
          console.log('[Chat] ✅ CRM_REFRESH_VAULT_URLS complete — fresh URLs synced');
        } catch (e) {
          console.error('[Chat] ❌ CRM_REFRESH_VAULT_URLS failed:', e);
        }
      })();
      return;
    }

    // ── CRM Task Days update: background bridge sends this when CRM sets task days ──
    if (message.type === 'CRM_TASK_DAYS_UPDATE') {
      const { fanId, taskDays, taskDeadline } = message;
      const currentSubId = String(Store.get('currentSubscriberId') || '').replace(/^of:/i, '');
      const incomingFanId = String(fanId || '').replace(/^of:/i, '');

      console.log(`[Chat] 🎯 CRM_TASK_DAYS_UPDATE: fan=${incomingFanId}, days=${taskDays}, deadline=${taskDeadline}, current=${currentSubId}`);

      // Only update if this fan is currently open in the sidepanel
      if (currentSubId && incomingFanId && currentSubId === incomingFanId) {
        const notes = Store.get('currentNotes') || {};

        if (taskDeadline) {
          notes.taskDeadline = taskDeadline;
          notes.taskDaysAdded = taskDays;
          notes.taskAddedAt = new Date().toISOString();
        } else {
          // taskDays === 0 means remove deadline
          delete notes.taskDeadline;
          delete notes.taskDaysAdded;
          delete notes.taskAddedAt;
        }

        Store.set('currentNotes', notes);
        renderTaskDays(notes);

        // Persist to local DB
        if (Store.get('currentProfile') && currentSubId) {
          saveNotesToDB(notes);
        }

        showNotification(`⏰ Task ${taskDeadline ? `set: ${taskDays} day${taskDays > 1 ? 's' : ''}` : 'removed'} (from CRM)`);
      }
      return;
    }

    // ── CRM Notes update: background bridge sends this when CRM saves notes ──
    if (message.type === 'CRM_NOTES_UPDATE') {
      const { fanId, notes: incomingNotes } = message;
      const currentSubId = String(Store.get('currentSubscriberId') || '').replace(/^of:/i, '');
      const incomingFanId = String(fanId || '').replace(/^of:/i, '');

      console.log(`[Chat] 📝 CRM_NOTES_UPDATE: fan=${incomingFanId}, current=${currentSubId}, fields=${Object.keys(incomingNotes || {}).join(',')}`);

      // Only update if this fan is currently open in the sidepanel
      if (currentSubId && incomingFanId && currentSubId === incomingFanId && incomingNotes) {
        // Merge incoming notes fields into existing notes (preserve metadata like taskDeadline, subscribedSince, totalSpent)
        const existing = Store.get('currentNotes') || {};
        const merged = { ...existing, ...incomingNotes };

        Store.set('currentNotes', merged);
        displayNotes(merged);

        // Persist to Clarity's local DB (Firebase API)
        if (Store.get('currentProfile') && currentSubId) {
          saveNotesToDB(merged);
        }

        showNotification('📝 Notes updated (from CRM)');
      }
      return;
    }

    // ── CRM Refresh Stats: background bridge sends this when CRM clicks the refresh button ──
    // Triggers the same forceRefreshSubscriberStats() as the manual refresh button in the sidepanel.
    if (message.type === 'CRM_REFRESH_STATS') {
      const { fanId } = message;
      const currentSubId = String(Store.get('currentSubscriberId') || '').replace(/^of:/i, '');
      const incomingFanId = String(fanId || '').replace(/^of:/i, '');

      console.log(`[Chat] 🔄 CRM_REFRESH_STATS: fan=${incomingFanId}, current=${currentSubId}`);

      if (currentSubId && incomingFanId && currentSubId === incomingFanId) {
        // Dynamic import to avoid circular dependency — forceRefreshSubscriberStats
        // is the exact same function wired to the manual refresh button
        import('./chatSync.js').then(async (module) => {
          try {
            await module.forceRefreshSubscriberStats();
            console.log(`[Chat] 🔄 CRM_REFRESH_STATS completed for fan ${incomingFanId}`);

            // ── Sync updated stats back to CRM Firestore ──
            // forceRefreshSubscriberStats updates Store currentNotes with
            // subscribedSince, subscribedDays (calculated), and totalSpent.
            // Send all three back so the CRM header refreshes.
            const notes = Store.get('currentNotes') || {};
            const subscriberId = Store.get('currentSubscriberId');
            if (subscriberId) {
              const stats = {};
              if (notes.subscribedSince) stats.subscribedSince = notes.subscribedSince;
              if (notes.totalSpent)      stats.totalSpent = notes.totalSpent;
              // Calculate subscribedDays from subscribedSince
              if (notes.subscribedSince) {
                const since = new Date(notes.subscribedSince);
                if (!isNaN(since.getTime())) {
                  stats.subscribedDays = Math.floor((Date.now() - since.getTime()) / 86400000);
                }
              }
              chrome.runtime.sendMessage({
                type: 'NYX_CRM_SYNC_FAN_PROFILE',
                data: { subscriberId, stats }
              }).catch(() => {});
              console.log(`[Chat] 🔄 Sent NYX_CRM_SYNC_FAN_PROFILE for fan ${incomingFanId}:`, stats);
            }
          } catch (e) {
            console.error(`[Chat] 🔄 CRM_REFRESH_STATS failed:`, e);
          }
        });
      } else {
        console.log(`[Chat] 🔄 CRM_REFRESH_STATS: fan ${incomingFanId} not currently open — ignoring`);
      }
      return;
    }

    // ── CRM Send Media: background sends this when CRM clicks "Send" on a vault item ──
    // Uses the EXACT same SEND_IMAGE flow as chatVault.js sendMediaToChat()
    if (message.type === 'CRM_SEND_MEDIA') {
      const { fanId, mediaId, downloadURL } = message;
      console.log(`[Chat] 📷 CRM_SEND_MEDIA: media=${mediaId}, fan=${fanId}`);

      import('../imagePool.js').then(async (pool) => {
        try {
          // Find the media item in the pool
          const allMedia = pool.getImages ? pool.getImages() : (pool.getImagePool ? pool.getImagePool() : []);
          const item = allMedia.find(m => m.id === mediaId);
          if (!item) {
            console.warn(`[Chat] 📷 CRM_SEND_MEDIA: media ${mediaId} not found in pool`);
            return;
          }

          // Get base64 data — fetch from Firebase Storage URL if needed
          // (Content script can't fetch Firebase URLs due to CORS, sidepanel can)
          let finalImageData = item.imageData;

          if (!finalImageData && (item.downloadURL || downloadURL)) {
            const url = item.downloadURL || downloadURL;
            console.log('[Chat] 📷 Fetching media from Firebase URL...');
            try {
              const response = await fetch(url);
              if (response.ok) {
                const blob = await response.blob();
                finalImageData = await new Promise((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onloadend = () => resolve(reader.result);
                  reader.onerror = reject;
                  reader.readAsDataURL(blob);
                });
                console.log('[Chat] 📷 Converted to base64, size:', Math.round(finalImageData.length / 1024), 'KB');
              } else {
                throw new Error(`Fetch failed: ${response.status}`);
              }
            } catch (fetchErr) {
              console.error('[Chat] 📷 Failed to fetch media from URL:', fetchErr);
              return;
            }
          }

          if (!finalImageData) {
            console.warn(`[Chat] 📷 CRM_SEND_MEDIA: no data for media ${mediaId}`);
            return;
          }

          // Send SEND_IMAGE to the active OF tab — same as chatVault.js sendMediaToChat()
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tabs[0]?.id) {
            console.warn('[Chat] 📷 CRM_SEND_MEDIA: no active tab found');
            return;
          }

          const result = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tabs[0].id, {
              type: 'SEND_IMAGE',
              imageUrl: finalImageData,
              caption: null,
              price: 0,
              autoSend: false
            }, (response) => {
              if (chrome.runtime.lastError) {
                resolve({ success: false, error: chrome.runtime.lastError.message });
              } else {
                resolve(response || { success: false, error: 'No response' });
              }
            });
          });

          if (result.success) {
            // Mark as sent + used — same as chatVault.js
            const subscriberId = Store.get('currentSubscriberId');
            if (subscriberId) {
              pool.markImageSentToSubscriber(subscriberId, item.id);
            }
            pool.markImageUsed(item.id);
            console.log(`[Chat] 📷 CRM_SEND_MEDIA: sent successfully, marked as sent`);
            showNotification(result.staged ? 'Media ready — click Send in chat ✅' : 'Media sent! ✅');
          } else {
            console.error(`[Chat] 📷 CRM_SEND_MEDIA: send failed:`, result.error);
            showNotification('Send failed: ' + (result.error || 'Unknown error'));
          }
        } catch (e) {
          console.error(`[Chat] 📷 CRM_SEND_MEDIA error:`, e);
        }
      });
      return;
    }

    // ── CRM Vault Mark Sent: background sends this when CRM marks a media item as sent ──
    if (message.type === 'CRM_VAULT_MARK_SENT') {
      const { fanId, mediaId } = message;
      console.log(`[Chat] ✅ CRM_VAULT_MARK_SENT: media=${mediaId}, fan=${fanId}`);

      import('../imagePool.js').then((pool) => {
        try {
          const subscriberId = `of:${String(fanId).replace(/^of:/i, '')}`;
          pool.markImageSentToSubscriber(subscriberId, mediaId);
          console.log(`[Chat] ✅ Marked media ${mediaId} as sent to ${subscriberId}`);
        } catch (e) {
          console.error(`[Chat] ✅ CRM_VAULT_MARK_SENT error:`, e);
        }
      });
      return;
    }

    // ── CRM Vault Unmark Sent: background sends this when CRM unmarks sent status ──
    if (message.type === 'CRM_VAULT_UNMARK_SENT') {
      const { fanId, mediaId } = message;
      console.log(`[Chat] ↩️ CRM_VAULT_UNMARK_SENT: media=${mediaId}, fan=${fanId}`);

      import('../imagePool.js').then((pool) => {
        try {
          const subscriberId = `of:${String(fanId).replace(/^of:/i, '')}`;
          pool.unmarkImageSentToSubscriber(subscriberId, mediaId);
          console.log(`[Chat] ↩️ Unmarked media ${mediaId} as sent to ${subscriberId}`);
        } catch (e) {
          console.error(`[Chat] ↩️ CRM_VAULT_UNMARK_SENT error:`, e);
        }
      });
      return;
    }

    // ── CRM Vault Move Media: background sends this when CRM moves media to another vault ──
    if (message.type === 'CRM_VAULT_MOVE_MEDIA') {
      const { mediaId, vaultId } = message;
      console.log(`[Chat] 📦 CRM_VAULT_MOVE_MEDIA: media=${mediaId} → vault=${vaultId}`);

      import('../imagePool.js').then((pool) => {
        try {
          pool.moveMediaToVault(mediaId, vaultId || 'default');
          console.log(`[Chat] 📦 Moved media ${mediaId} to vault ${vaultId}`);
        } catch (e) {
          console.error(`[Chat] 📦 CRM_VAULT_MOVE_MEDIA error:`, e);
        }
      });
      return;
    }

    // ── CRM Vault Create: background sends this when CRM creates a new vault folder ──
    if (message.type === 'CRM_VAULT_CREATE') {
      const { vaultName } = message;
      console.log(`[Chat] 📁 CRM_VAULT_CREATE: "${vaultName}"`);

      import('../imagePool.js').then((pool) => {
        try {
          pool.createVault(vaultName);
          console.log(`[Chat] 📁 Created vault "${vaultName}"`);
        } catch (e) {
          console.error(`[Chat] 📁 CRM_VAULT_CREATE error:`, e);
        }
      });
      return;
    }

    // ── CRM Vault Rename: background sends this when CRM renames a vault folder ──
    if (message.type === 'CRM_VAULT_RENAME') {
      const { vaultId, newName } = message;
      console.log(`[Chat] ✏️ CRM_VAULT_RENAME: vault=${vaultId} → "${newName}"`);

      import('../imagePool.js').then((pool) => {
        try {
          pool.renameVault(vaultId, newName);
          console.log(`[Chat] ✏️ Renamed vault ${vaultId} to "${newName}"`);
        } catch (e) {
          console.error(`[Chat] ✏️ CRM_VAULT_RENAME error:`, e);
        }
      });
      return;
    }

    // ── CRM Vault Delete: background sends this when CRM deletes a vault folder ──
    if (message.type === 'CRM_VAULT_DELETE') {
      const { vaultId } = message;
      console.log(`[Chat] 🗑️ CRM_VAULT_DELETE: vault=${vaultId}`);

      import('../imagePool.js').then((pool) => {
        try {
          pool.deleteVault(vaultId);
          console.log(`[Chat] 🗑️ Deleted vault ${vaultId}`);
        } catch (e) {
          console.error(`[Chat] 🗑️ CRM_VAULT_DELETE error:`, e);
        }
      });
      return;
    }

    // ── CRM Vault Delete Media: background sends this when CRM deletes a media item ──
    if (message.type === 'CRM_VAULT_DELETE_MEDIA') {
      const { mediaId } = message;
      console.log(`[Chat] 🗑️ CRM_VAULT_DELETE_MEDIA: media=${mediaId}`);

      import('../imagePool.js').then(async (pool) => {
        try {
          await pool.deleteImage(mediaId);
          console.log(`[Chat] 🗑️ Deleted media ${mediaId} from pool`);
        } catch (e) {
          console.error(`[Chat] 🗑️ CRM_VAULT_DELETE_MEDIA error:`, e);
        }
      });
      return;
    }

    // ── CRM Sync Profile On Open: background sends this after OPEN_CHAT completes ──
    // Reads the currently loaded notes and pushes subscribedSince/subscribedDays/totalSpent
    // to Firestore so the CRM header shows up-to-date stats without a manual refresh.
    if (message.type === 'CRM_SYNC_PROFILE_ON_OPEN') {
      const { fanId } = message;
      const currentSubId = String(Store.get('currentSubscriberId') || '').replace(/^of:/i, '');
      const incomingFanId = String(fanId || '').replace(/^of:/i, '');

      console.log(`[Chat] 📊 CRM_SYNC_PROFILE_ON_OPEN: fan=${incomingFanId}, current=${currentSubId}`);

      if (currentSubId && incomingFanId && currentSubId === incomingFanId) {
        const notes = Store.get('currentNotes') || {};
        const subscriberId = Store.get('currentSubscriberId');
        if (subscriberId && (notes.subscribedSince || notes.totalSpent)) {
          const stats = {};
          if (notes.subscribedSince) stats.subscribedSince = notes.subscribedSince;
          if (notes.totalSpent)      stats.totalSpent = notes.totalSpent;
          if (notes.subscribedSince) {
            const since = new Date(notes.subscribedSince);
            if (!isNaN(since.getTime())) {
              stats.subscribedDays = Math.floor((Date.now() - since.getTime()) / 86400000);
            }
          }
          chrome.runtime.sendMessage({
            type: 'NYX_CRM_SYNC_FAN_PROFILE',
            data: { subscriberId, stats }
          }).catch(() => {});
          console.log(`[Chat] 📊 Sent profile stats on chat open for fan ${incomingFanId}:`, stats);
        } else {
          console.log(`[Chat] 📊 No profile stats available yet for fan ${incomingFanId}`);
        }
      }
      return;
    }

    // ── Draft State: content script sends this when compose box text/media changes ──
    if (message.type === 'CHAT_DRAFT_STATE') {
      console.log(`[🔍 DRAFT-DEBUG SP] Received CHAT_DRAFT_STATE:`, message.data ? `text="${(message.data.text || '').substring(0, 30)}", media=${(message.data.media || []).length}` : 'null');
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
        
        // NYX CRM sync is handled by the background's handleCrmChatMessage path
        // which uses the tab URL for correct fan routing. DO NOT sync from sidepanel
        // because Store.get('currentSubscriberId') can be stale during chat switches,
        // causing cross-fan contamination (Fan A's messages written to Fan B's subcollection).
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
        
        // NYX CRM sync is handled by the background's handleCrmChatMessage path
        // (content script → NEW_MESSAGE → index.js → handleCrmChatMessage with tab URL).
        // DO NOT sync from sidepanel — Store.get('currentSubscriberId') can be stale.
        
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
