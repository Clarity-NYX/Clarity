// ============================================================
// CHAT STORAGE MODULE - Handles chat persistence and saving
// Platform-aware: Telegram uses local storage, OnlyFans uses Firebase
// ============================================================

import Store from '../../state/store.js';
import API from '../../utils/api.js';

// ============================================================
// TELEGRAM LOCAL STORAGE HELPERS
// ============================================================

// Get local storage key for Telegram chat
const getTelegramChatKey = (profileId, subscriberId) => {
  return `tg_chat_${profileId}_${subscriberId}`;
};

// Save Telegram chat to local storage
const saveTelegramChatLocal = async (profileId, subscriberId, data) => {
  const key = getTelegramChatKey(profileId, subscriberId);
  const chatData = {
    ...data,
    lastUpdated: Date.now()
  };
  
  await chrome.storage.local.set({ [key]: chatData });
  console.log(`[Chat] 💾 Telegram chat saved locally: ${subscriberId} (${data.messages?.length || 0} msgs)`);
  return { success: true };
};

// Load Telegram chat from local storage
export const loadTelegramChatLocal = async (profileId, subscriberId) => {
  const key = getTelegramChatKey(profileId, subscriberId);
  const result = await chrome.storage.local.get([key]);
  
  if (result[key]) {
    console.log(`[Chat] 📂 Telegram chat loaded from local: ${subscriberId}`);
    return { success: true, chat: result[key] };
  }
  
  return { success: false, chat: null };
};

// Check if current platform is Telegram
const isTelegramPlatform = () => {
  return Store.get('currentPlatform') === 'telegram';
};

// ============================================================
// DEBOUNCING & RATE LIMITING - Prevent API spam
// ============================================================

// Debounce timers per chat
const saveChatDebounce = new Map();
const SAVE_DEBOUNCE_MS = 2000; // Wait 2 seconds before saving (reduced for better UX)

// Rate limiting - track last save time per chat
const lastSaveTime = new Map();
const MIN_SAVE_INTERVAL_MS = 5000; // Min 5 seconds between saves

// Last saved hash per chat - only save if data changed
const lastSavedHash = new Map();

// Generate a simple hash of message data to detect changes
export function hashMessages(messages) {
  if (!messages || messages.length === 0) return '0';
  const str = messages.map(m => `${m.text}|${m.isFromMe}`).join('||');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return `${messages.length}:${hash.toString(36)}`;
}

// Save full chat replacement - Immediate save option for reliability
// Platform-aware: Telegram uses local storage, OnlyFans uses Firebase
export const saveFullChatReplacement = async (messages, forceImmediate = false) => {
  const currentProfile = Store.get('currentProfile');
  const currentSubscriberId = Store.get('currentSubscriberId');
  
  if (!currentProfile || !currentSubscriberId || !messages.length) {
    console.log('[Chat] Cannot save - missing profile/subscriber/messages');
    return;
  }
  
  // Only check hash if not forcing immediate save
  if (!forceImmediate) {
    const currentHash = hashMessages(messages);
    const lastHash = lastSavedHash.get(currentSubscriberId);
    
    if (currentHash === lastHash) {
      console.log('[Chat] Skip save - messages unchanged');
      return;
    }
  }
  
  // Clear any existing timer
  const existingTimer = saveChatDebounce.get(currentSubscriberId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    saveChatDebounce.delete(currentSubscriberId);
  }
  
  // Save function - PLATFORM AWARE
  const performSave = async () => {
    try {
      console.log(`[Chat] Saving ${currentSubscriberId} (${messages.length} msgs)`);
      
      let response;
      
      // TELEGRAM: Use local storage (no Firebase)
      if (isTelegramPlatform()) {
        const storedChat = Store.get('storedChat') || {};
        response = await saveTelegramChatLocal(currentProfile.id, currentSubscriberId, {
          messages: messages,
          notes: storedChat.notes || {},
          scriptProgress: storedChat.scriptProgress || {},
          subscriberName: Store.get('subscriberName') || 'Unknown',
          summary: Store.get('summary') || ''
        });
      } else {
        // ONLYFANS: Use Firebase API (existing behavior)
        response = await API.saveChat({
          profileId: currentProfile.id,
          subscriberId: currentSubscriberId,
          subscriberName: Store.get('subscriberName') || 'Unknown',
          messages: messages,
          summary: Store.get('summary')
        });
      }
      
      if (response.success) {
        // Update tracking
        lastSaveTime.set(currentSubscriberId, Date.now());
        lastSavedHash.set(currentSubscriberId, hashMessages(messages));
        
        const storedChat = Store.get('storedChat') || { messages: [] };
        storedChat.messages = messages;
        Store.set('storedChat', storedChat);
        
        console.log(`[Chat] ✅ Saved successfully: ${currentSubscriberId}`);
      } else {
        console.error('[Chat] ❌ Save failed:', response);
      }
    } catch (error) {
      console.error('[Chat] ❌ Save error:', error);
    }
  };
  
  // If forcing immediate save or it's been long enough since last save, save now
  if (forceImmediate || Date.now() - (lastSaveTime.get(currentSubscriberId) || 0) >= MIN_SAVE_INTERVAL_MS) {
    await performSave();
  } else {
    // Otherwise, debounce but with shorter delay
    const timer = setTimeout(performSave, SAVE_DEBOUNCE_MS);
    saveChatDebounce.set(currentSubscriberId, timer);
  }
};

// Force flush any pending saves immediately (used when switching chats)
// Platform-aware: Telegram uses local storage, OnlyFans uses Firebase
export const forceFlushPendingSaves = async () => {
  const currentSubscriberId = Store.get('currentSubscriberId');
  const messages = Store.get('messages');
  
  if (!currentSubscriberId || !messages || messages.length === 0) {
    return;
  }
  
  // Clear any pending timer
  const pendingTimer = saveChatDebounce.get(currentSubscriberId);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    saveChatDebounce.delete(currentSubscriberId);
  }
  
  // Save immediately if we have messages
  const currentProfile = Store.get('currentProfile');
  if (currentProfile && messages.length > 0) {
    try {
      console.log(`[Chat] Force saving ${currentSubscriberId} (${messages.length} msgs) before switching`);
      
      let response;
      
      // TELEGRAM: Use local storage (no Firebase)
      if (isTelegramPlatform()) {
        const storedChat = Store.get('storedChat') || {};
        response = await saveTelegramChatLocal(currentProfile.id, currentSubscriberId, {
          messages: messages,
          notes: storedChat.notes || {},
          scriptProgress: storedChat.scriptProgress || {},
          subscriberName: Store.get('subscriberName') || 'Unknown',
          summary: Store.get('summary') || ''
        });
      } else {
        // ONLYFANS: Use Firebase API (existing behavior)
        response = await API.saveChat({
          profileId: currentProfile.id,
          subscriberId: currentSubscriberId,
          subscriberName: Store.get('subscriberName') || 'Unknown',
          messages: messages,
          summary: Store.get('summary')
        });
      }
      
      if (response.success) {
        // Update tracking
        lastSaveTime.set(currentSubscriberId, Date.now());
        lastSavedHash.set(currentSubscriberId, hashMessages(messages));
        
        console.log(`[Chat] Force save completed for ${currentSubscriberId}`);
      }
    } catch (error) {
      console.error('Failed to force save chat:', error);
    }
  }
};

// Sync new messages
export const syncNewMessagesToDatabase = async (newMessages) => {
  const currentProfile = Store.get('currentProfile');
  const currentSubscriberId = Store.get('currentSubscriberId');
  
  if (!currentProfile || !currentSubscriberId || !newMessages.length) return;
  
  try {
    const response = await API.syncChat({
      profileId: currentProfile.id,
      subscriberId: currentSubscriberId,
      newMessages: newMessages,
      subscriberName: Store.get('subscriberName') || 'Unknown'
    });
    
    if (response.success) {
      const storedChat = Store.get('storedChat') || { messages: [] };
      storedChat.messages = [...(storedChat.messages || []), ...newMessages];
      Store.set('storedChat', storedChat);
    }
  } catch (error) {
    console.error('Failed to sync messages:', error);
  }
};

// Setup window close handlers
export const setupWindowCloseHandlers = () => {
  // Save when extension window is closed
  window.addEventListener('beforeunload', async (e) => {
    console.log('[Chat] Window closing - saving pending chats...');
    await forceFlushPendingSaves();
  });
  
  // Also save when sidepanel visibility changes (Chrome API)
  if (chrome.runtime?.onSuspend) {
    chrome.runtime.onSuspend.addListener(async () => {
      console.log('[Chat] Extension suspending - saving pending chats...');
      await forceFlushPendingSaves();
    });
  }
  
  // Save when tab is closed or navigated away
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) {
      console.log('[Chat] Page hidden - saving pending chats...');
      await forceFlushPendingSaves();
    }
  });
};

// Clear all debounce timers
export const clearAllPendingSaves = () => {
  saveChatDebounce.forEach((timer) => clearTimeout(timer));
  saveChatDebounce.clear();
};

// Reset storage tracking for a chat
export const resetChatTracking = (subscriberId) => {
  lastSaveTime.delete(subscriberId);
  lastSavedHash.delete(subscriberId);
  const timer = saveChatDebounce.get(subscriberId);
  if (timer) {
    clearTimeout(timer);
    saveChatDebounce.delete(subscriberId);
  }
};