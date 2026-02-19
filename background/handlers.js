// ============================================================
// MESSAGE HANDLERS
// ============================================================

import { API } from './api.js';
import { AutoChatState, startAutoChatMonitoring, stopAutoChatMonitoring, loadBlockedUsers, blockUser, handleUserBlocked, onMessageSent, handleNewUnreads, handleChatListUpdate, notifyStateChange, updateChatScriptProgress, handleUnreadsAtTop } from './autochat.js';
import { handleOFAutoChatMessage, handleChatListPush, retryChat, setAlarmMuted, OFAutoChatState, handleGenerationResult } from './autochat-onlyfans.js';

// ============================================================
// INPUT VALIDATION HELPERS
// ============================================================

/**
 * Validate that a value is a non-empty string
 */
const isValidString = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * Validate that a value is a valid ID (string or number, non-empty)
 */
const isValidId = (value) => {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return !isNaN(value) && isFinite(value);
  return false;
};

/**
 * Validate that a value is an object
 */
const isValidObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Validate that a value is an array
 */
const isValidArray = (value) => Array.isArray(value);

/**
 * Sanitize string input - remove potential XSS vectors
 */
const sanitizeString = (value) => {
  if (typeof value !== 'string') return '';
  // Remove potential script tags and event handlers
  return value
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim();
};

/**
 * Validate profile ID
 */
const validateProfileId = (data) => {
  if (!data || !isValidId(data.profileId)) {
    return { valid: false, error: 'Invalid or missing profile ID' };
  }
  return { valid: true };
};

/**
 * Validate script ID
 */
const validateScriptId = (data) => {
  if (!data || !isValidId(data.scriptId)) {
    return { valid: false, error: 'Invalid or missing script ID' };
  }
  return { valid: true };
};

/**
 * Validate subscriber ID
 */
const validateSubscriberId = (data) => {
  if (!data || !isValidId(data.subscriberId)) {
    return { valid: false, error: 'Invalid or missing subscriber ID' };
  }
  return { valid: true };
};

export const handlers = {
  // AI Handlers
  async GENERATE_RESPONSE(data) {
    const result = await API.generateResponse(data);
    return { success: true, response: result.response, creditsRemaining: result.creditsRemaining };
  },

  async SUMMARIZE_CONVERSATION(data) {
    const result = await API.summarizeConversation(data.messages);
    return { success: true, summary: result.summary, creditsRemaining: result.creditsRemaining };
  },

  async EXTRACT_INFO(data) {
    const result = await API.extractInfo(data.messages);
    return { success: true, info: result.info, creditsRemaining: result.creditsRemaining };
  },

  async CHECK_GOAL(data) {
    const result = await API.checkGoal(data);
    return { success: true, achieved: result.achieved, confidence: result.confidence, reason: result.reason, creditsRemaining: result.creditsRemaining };
  },

  async VALIDATE_RESPONSE(data) {
    const result = await API.validateResponse(data);
    return { success: true, valid: result.valid, reason: result.reason, creditsRemaining: result.creditsRemaining };
  },

  async GENERATE_IMAGE_CAPTION(data) {
    const result = await API.generateImageCaption(data);
    return { success: true, caption: result.caption, creditsRemaining: result.creditsRemaining };
  },

  async GENERATE_SCRIPT(data) {
    const result = await API.generateScript(data);
    return { success: true, ...result };
  },

  async GET_SCRIPT_CATEGORIES() {
    const result = await API.getScriptCategories();
    return { success: true, ...result };
  },

  // Credits Handlers
  async GET_CREDITS() {
    const result = await API.getCredits();
    return { success: true, ...result };
  },

  async GET_PACKAGES() {
    const result = await API.getPackages();
    return { success: true, packages: result.packages };
  },

  async MOCK_PURCHASE(data) {
    const result = await API.mockPurchase(data.packageId);
    return { success: true, ...result };
  },

  // Settings Handlers
  GET_SETTINGS(_, sendResponse) {
    chrome.storage.local.get(['defaultTone', 'persona'], sendResponse);
    return true;
  },

  SAVE_SETTINGS(data, sendResponse) {
    chrome.storage.local.set(data, () => sendResponse({ success: true }));
    return true;
  },

  // Profile Handlers
  async GET_PROFILES() {
    const result = await API.getProfiles();
    return { success: true, profiles: result.profiles };
  },

  async GET_PROFILE(data) {
    const result = await API.getProfile(data.profileId);
    return { success: true, profile: result.profile };
  },

  async CREATE_PROFILE(data) {
    const result = await API.createProfile(data);
    return { success: true, profile: result.profile, message: result.message };
  },

  async UPDATE_PROFILE(data) {
    const { profileId, ...updateData } = data;
    const result = await API.updateProfile(profileId, updateData);
    return { success: true, profile: result.profile, message: result.message };
  },

  async DELETE_PROFILE(data) {
    const result = await API.deleteProfile(data.profileId);
    return { success: true, message: result.message };
  },

  // Chat Storage Handlers
  async GET_CHAT(data) {
    const result = await API.getChat(data.profileId, data.subscriberId);
    return { success: true, chat: result.chat, isNew: result.isNew };
  },

  async SAVE_CHAT(data) {
    const { profileId, subscriberId, ...chatData } = data;
    const result = await API.saveChat(profileId, subscriberId, chatData);
    return { success: true, messageCount: result.messageCount, message: result.message };
  },

  async SYNC_CHAT(data) {
    const { profileId, subscriberId, newMessages, subscriberName } = data;
    const result = await API.syncChat(profileId, subscriberId, { newMessages, subscriberName });
    return { success: true, added: result.added, totalMessages: result.totalMessages, message: result.message };
  },

  async GET_CHAT_NOTES(data) {
    const result = await API.getChatNotes(data.profileId, data.subscriberId);
    return { success: true, notes: result.notes };
  },

  async SAVE_CHAT_NOTES(data) {
    const result = await API.saveChatNotes(data.profileId, data.subscriberId, data.notes);
    return { success: true, message: result.message };
  },

  async GET_CHATS(data) {
    const result = await API.getChats(data.profileId);
    return { success: true, chats: result.chats };
  },

  // Scripts Handlers
  async GET_GLOBAL_SCRIPTS() {
    const result = await API.getGlobalScripts();
    return { success: true, scripts: result.scripts, isGlobal: true };
  },

  async GET_PROFILE_SCRIPTS(data) {
    if (!data.profileId) return { success: false, error: 'Profile ID required' };
    try {
      const result = await API.getProfileScripts(data.profileId);
      if (result && result.success !== false) {
        return { success: true, scripts: result.scripts || [], profileId: data.profileId };
      } else {
        console.warn('[Handler] GET_PROFILE_SCRIPTS failed:', result?.error || 'Unknown error');
        return { success: false, error: result?.error || 'Failed to load scripts', scripts: [] };
      }
    } catch (error) {
      console.error('[Handler] GET_PROFILE_SCRIPTS error:', error);
      return { success: false, error: error.message, scripts: [] };
    }
  },

  async CREATE_GLOBAL_SCRIPT(data) {
    const result = await API.createGlobalScript(data);
    return { success: true, script: result.script, message: result.message };
  },

  async CREATE_PROFILE_SCRIPT(data) {
    const { profileId, ...scriptData } = data;
    if (!profileId) return { success: false, error: 'Profile ID required' };
    const result = await API.createProfileScript(profileId, scriptData);
    return { success: true, script: result.script, message: result.message };
  },

  async UPDATE_GLOBAL_SCRIPT(data) {
    const { scriptId, ...updateData } = data;
    const result = await API.updateGlobalScript(scriptId, updateData);
    return { success: true, script: result.script, message: result.message };
  },

  async UPDATE_PROFILE_SCRIPT(data) {
    console.log('[Handler] 📥 UPDATE_PROFILE_SCRIPT received');
    console.log('[Handler] - Data keys:', Object.keys(data));
    console.log('[Handler] - Profile ID:', data.profileId);
    console.log('[Handler] - Script ID:', data.scriptId);
    console.log('[Handler] - Has imagePool:', !!data.imagePool);
    console.log('[Handler] - imagePool length:', data.imagePool?.length || 0);
    
    const { profileId, scriptId, ...updateData } = data;
    if (!profileId) {
      console.error('[Handler] ❌ No profile ID');
      return { success: false, error: 'Profile ID required' };
    }
    
    console.log('[Handler] - Update data keys:', Object.keys(updateData));
    console.log('[Handler] - Payload size:', (JSON.stringify(updateData).length / 1024).toFixed(2), 'KB');
    
    try {
      const result = await API.updateProfileScript(profileId, scriptId, updateData);
      console.log('[Handler] ✅ API call successful');
      return { success: true, script: result.script, message: result.message };
    } catch (error) {
      console.error('[Handler] ❌ API call failed:', error.message);
      return { success: false, error: error.message };
    }
  },

  async DELETE_GLOBAL_SCRIPT(data) {
    const result = await API.deleteGlobalScript(data.scriptId);
    return { success: true, message: result.message };
  },

  async DELETE_PROFILE_SCRIPT(data) {
    if (!data.profileId) return { success: false, error: 'Profile ID required' };
    const result = await API.deleteProfileScript(data.profileId, data.scriptId);
    return { success: true, message: result.message };
  },

  async COPY_SCRIPT_TO_PROFILE(data) {
    if (!data.scriptId || !data.profileId) return { success: false, error: 'Script ID and Profile ID required' };
    const result = await API.copyScriptToProfile(data.scriptId, data.profileId);
    return { success: true, script: result.script, message: result.message };
  },

  async COPY_SCRIPT_TO_TEMPLATES(data) {
    if (!data.scriptId || !data.profileId) return { success: false, error: 'Script ID and Profile ID required' };
    const result = await API.copyScriptToTemplates(data.scriptId, data.profileId);
    return { success: true, script: result.script, message: result.message };
  },

  async COPY_ALL_TEMPLATES_TO_PROFILE(data) {
    if (!data.profileId) return { success: false, error: 'Profile ID required' };
    const result = await API.copyAllTemplatesToProfile(data.profileId);
    return { success: true, copied: result.copied, message: result.message };
  },

  // Usage Handlers
  async GET_TOTAL_USAGE() {
    const result = await API.getTotalUsage();
    return { success: true, ...result };
  },

  async RESET_USAGE() {
    const result = await API.resetUsage();
    return { success: true, ...result };
  },

  // Auto-Chat Handlers - Pool-Based Event-Driven System
  AUTOCHAT_GET_STATE(_, sendResponse) {
    // Count ready/waiting in pool
    let readyCount = 0;
    let waitingForReplyCount = 0;
    if (AutoChatState.activePool) {
      for (const chat of AutoChatState.activePool.values()) {
        if (chat.status === 'ready') readyCount++;
        if (chat.status === 'waiting_for_reply') waitingForReplyCount++;
      }
    }
    
    sendResponse({
      success: true,
      state: {
        enabled: AutoChatState.enabled,
        autoSendEnabled: AutoChatState.autoSendEnabled,
        prioritizeByProgress: AutoChatState.prioritizeByProgress, // NEW: Include priority mode
        
        // Pool-based state (no limits)
        activePoolSize: AutoChatState.activePool?.size || 0,
        activePoolReadyCount: readyCount,
        activePoolWaitingCount: waitingForReplyCount,
        currentlyProcessing: AutoChatState.currentlyProcessing,
        
        stats: AutoChatState.stats
      }
    });
    return true;
  },

  AUTOCHAT_SET_ENABLED(data, sendResponse) {
    AutoChatState.enabled = data.enabled;
    
    // Store profile ID for block list functionality
    if (data.profileId) {
      AutoChatState.currentProfileId = data.profileId;
      console.log('[AutoChat] Profile ID set:', data.profileId);
    }
    
    console.log('[AutoChat] Enabled:', data.enabled);
    data.enabled ? startAutoChatMonitoring() : stopAutoChatMonitoring();
    sendResponse({ success: true, enabled: AutoChatState.enabled });
    return true;
  },

  async AUTOCHAT_SET_MAX_CHATS(data, sendResponse) {
    const newMax = Math.max(1, Math.min(10, data.maxChats));
    const oldMax = AutoChatState.maxActiveChats;
    AutoChatState.maxActiveChats = newMax;
    
    console.log(`[AutoChat] Max chats changed: ${oldMax} -> ${newMax}`);
    
    // Notify state change (pool will auto-fill on next message)
    notifyStateChange();
    
    sendResponse({ success: true, maxChats: AutoChatState.maxActiveChats });
    return true;
  },

  AUTOCHAT_SET_AUTO_SEND(data, sendResponse) {
    AutoChatState.autoSendEnabled = data.enabled;
    sendResponse({ success: true, autoSendEnabled: AutoChatState.autoSendEnabled });
    return true;
  },

  AUTOCHAT_SET_SKIP_TIMEOUT(data, sendResponse) {
    const minutes = Math.max(1, Math.min(30, data.minutes || 5));
    AutoChatState.skipTimeoutMinutes = minutes;
    console.log(`[AutoChat] Skip timeout set to ${minutes} minutes`);
    sendResponse({ success: true, skipTimeoutMinutes: minutes });
    return true;
  },

  // Set cooldown time (minutes between responses to same chat)
  AUTOCHAT_SET_COOLDOWN(data, sendResponse) {
    const minutes = Math.max(1, Math.min(30, data.minutes || 5));
    AutoChatState.cooldownMinutes = minutes;
    console.log(`[AutoChat] Cooldown set to ${minutes} minutes`);
    notifyStateChange();
    sendResponse({ success: true, cooldownMinutes: minutes });
    return true;
  },

  // Handle new unreads from monitor (event-driven)
  AUTOCHAT_NEW_UNREADS(data, sendResponse) {
    handleNewUnreads(data);
    sendResponse({ success: true });
    return true;
  },

  // Handle full chat list update from monitor
  AUTOCHAT_CHAT_LIST(data, sendResponse) {
    console.log('[AutoChat] 📋 Received chat list update from monitor');
    handleChatListUpdate(data);
    sendResponse({ success: true });
    return true;
  },

  // Handle unreads found at top of list (high priority - from scroll-to-top scan)
  AUTOCHAT_UNREADS_AT_TOP(data, sendResponse) {
    handleUnreadsAtTop(data);
    sendResponse({ success: true });
    return true;
  },

  AUTOCHAT_GET_CHATS(_, sendResponse) {
    sendResponse({
      success: true,
      chats: {
        active: Array.from(AutoChatState.activePool.values()),
        waiting: AutoChatState.waitingQueue,
        cooldown: Array.from(AutoChatState.cooldownPool.values()),
        completed: Array.from(AutoChatState.completedPool.values())
      }
    });
    return true;
  },

  AUTOCHAT_GET_PENDING_RESPONSE(data, sendResponse) {
    const pending = AutoChatState.pendingResponses.get(data.chatId);
    sendResponse({ success: true, hasPending: !!pending, response: pending || null });
    return true;
  },

  // Message sent confirmation from workflow - uses event-driven onMessageSent
  async AUTOCHAT_MESSAGE_SENT(data, sendResponse) {
    console.log(`[AutoChat] ✅ Message sent confirmation for #${data.peerId}:`, data.success ? 'SUCCESS' : 'FAILED');
    
    // Use the new event-driven onMessageSent function
    // This handles: clearing currentlyProcessing, adding to cooldown, processing next in queue
    await onMessageSent(data.peerId, data.success, data.reason || null);
    
    sendResponse({ success: true });
    return true;
  },

  // ============================================================
  // BLOCKED USERS HANDLERS
  // ============================================================
  async GET_BLOCKED_USERS(data) {
    if (!data.profileId) return { success: false, error: 'Profile ID required' };
    const result = await API.getBlockedUsers(data.profileId);
    return { success: true, blockedUsers: result.blockedUsers, blockedIds: result.blockedIds };
  },

  async ADD_BLOCKED_USER(data) {
    if (!data.profileId || !data.subscriberId) {
      return { success: false, error: 'Profile ID and Subscriber ID required' };
    }
    const result = await API.addBlockedUser(data.profileId, data.subscriberId, data.subscriberName, data.reason);
    return { success: true, message: result.message };
  },

  async REMOVE_BLOCKED_USER(data) {
    if (!data.profileId || !data.subscriberId) {
      return { success: false, error: 'Profile ID and Subscriber ID required' };
    }
    const result = await API.removeBlockedUser(data.profileId, data.subscriberId);
    return { success: true, message: result.message };
  },

  // Load blocked users into AutoChat cache (call when starting AutoChat)
  async AUTOCHAT_LOAD_BLOCKED_USERS(data, sendResponse) {
    if (!data.profileId) {
      sendResponse({ success: false, error: 'Profile ID required' });
      return true;
    }
    
    try {
      const blockedIds = await loadBlockedUsers(data.profileId);
      console.log(`[AutoChat] Loaded ${blockedIds.length} blocked users for AutoChat`);
      sendResponse({ success: true, count: blockedIds.length });
    } catch (error) {
      console.error('[AutoChat] Error loading blocked users:', error);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  },

  // Notify background that a user was blocked (updates cache immediately)
  async AUTOCHAT_USER_BLOCKED(data, sendResponse) {
    const { profileId, subscriberId, subscriberName } = data;
    
    if (!profileId || !subscriberId) {
      sendResponse({ success: false, error: 'Profile ID and Subscriber ID required' });
      return true;
    }
    
    try {
      // Add to background cache and Firebase
      await blockUser(profileId, subscriberId, subscriberName);
      console.log(`[AutoChat] 🚫 User blocked: ${subscriberName || subscriberId}`);
      
      // Use new handleUserBlocked function - removes from pool, adds replacement, moves to next chat
      await handleUserBlocked(subscriberId);
      
      sendResponse({ success: true });
    } catch (error) {
      console.error('[AutoChat] Error blocking user:', error);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  },

  // Subscriber Stats Handler
  async FETCH_SUBSCRIBER_STATS(data) {
    if (!data.subscriberId) return { success: false, error: 'No subscriber ID provided' };
    
    try {
      // Strip 'of:' prefix if present (subscriber IDs come as 'of:123456')
      const cleanSubscriberId = data.subscriberId.toString().replace(/^of:/i, '');
      const profileUrl = `https://onlyfans.com/u${cleanSubscriberId}`;
      console.log('[Handler] Opening profile URL:', profileUrl);
      const tab = await chrome.tabs.create({ url: profileUrl, active: false });
      
      await new Promise(resolve => {
        const listener = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 15000);
      });
      
      await new Promise(r => setTimeout(r, 2000));
      
      let stats = null;
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_PROFILE_STATS' });
        if (response?.success) stats = response.stats;
      } catch (err) {}
      
      await chrome.tabs.remove(tab.id);
      return stats ? { success: true, stats } : { success: false, error: 'Could not scrape stats' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  // AI Situational Classification Handler
  async CLASSIFY_SITUATIONAL(data) {
    try {
      const result = await API.classifySituational(data.message, data.enabledPresets);
      return { success: true, match: result.match, confidence: result.confidence, reason: result.reason };
    } catch (error) {
      console.error('[Handler] CLASSIFY_SITUATIONAL error:', error);
      return { success: false, error: error.message };
    }
  },

  // AI-powered image selection from pool
  async SELECT_BEST_IMAGE(data) {
    try {
      const result = await API.selectBestImage(data.userMessage, data.imageList);
      return { 
        success: true, 
        selectedIndex: result.selectedIndex, 
        reason: result.reason 
      };
    } catch (error) {
      console.error('[Handler] SELECT_BEST_IMAGE error:', error);
      return { success: false, error: error.message };
    }
  },

  // ============================================================
  // ONLYFANS AUTO-CHAT HANDLERS
  // ============================================================
  OF_AUTOCHAT_SET_ENABLED(data, sendResponse) {
    const result = handleOFAutoChatMessage('OF_AUTOCHAT_SET_ENABLED', data);
    sendResponse(result);
    return true;
  },

  OF_AUTOCHAT_SET_MAX_CHATS(data, sendResponse) {
    const result = handleOFAutoChatMessage('OF_AUTOCHAT_SET_MAX_CHATS', data);
    sendResponse(result);
    return true;
  },

  OF_AUTOCHAT_SET_WAIT_TIME(data, sendResponse) {
    const result = handleOFAutoChatMessage('OF_AUTOCHAT_SET_WAIT_TIME', data);
    sendResponse(result);
    return true;
  },

  OF_AUTOCHAT_GET_STATE(data, sendResponse) {
    const result = handleOFAutoChatMessage('OF_AUTOCHAT_GET_STATE', data);
    sendResponse(result);
    return true;
  },

  OF_AUTOCHAT_GENERATION_RESULT(data, sendResponse) {
    // Pass actionInfo to handleGenerationResult (imported at top of file)
    handleGenerationResult(data.peerId, data.success, data.response, data.error, data.actionInfo);
    sendResponse({ success: true });
    return true;
  },

  async OF_AUTOCHAT_SEND_MESSAGE(data, sendResponse) {
    const result = await handleOFAutoChatMessage('OF_AUTOCHAT_SEND_MESSAGE', data);
    sendResponse(result);
    return true;
  },

  OF_AUTOCHAT_REGENERATE(data, sendResponse) {
    const result = handleOFAutoChatMessage('OF_AUTOCHAT_REGENERATE', data);
    sendResponse(result);
    return true;
  },

  OF_AUTOCHAT_UPDATE_RESPONSE(data, sendResponse) {
    const result = handleOFAutoChatMessage('OF_AUTOCHAT_UPDATE_RESPONSE', data);
    sendResponse(result);
    return true;
  },

  // Handle push update from content script (MutationObserver detected chat list change)
  OF_CHAT_LIST_UPDATED(data, sendResponse) {
    console.log('[Handler] 📥 OF_CHAT_LIST_UPDATED from content script');
    handleChatListPush(data);
    
    // Check for new unreads and trigger alarm (only if alarm is not muted)
    const chatsWithUnread = (data || []).filter(c => c.hasUnread);
    if (chatsWithUnread.length > 0 && !OFAutoChatState.alarmMuted) {
      // Store last known unread count
      chrome.storage.local.get(['lastUnreadCount'], (result) => {
        const lastCount = result.lastUnreadCount || 0;
        if (chatsWithUnread.length > lastCount) {
          console.log('[Handler] 🔔 New unread messages detected!', chatsWithUnread.length);
          // Forward alarm trigger to sidepanel (plays alarm if not muted)
          chrome.runtime.sendMessage({ 
            type: 'NEW_UNREAD_DETECTED',
            count: chatsWithUnread.length,
            chats: chatsWithUnread.map(c => ({ name: c.subscriberName, id: c.rawId }))
          }).catch(() => {});
        }
        chrome.storage.local.set({ lastUnreadCount: chatsWithUnread.length });
      });
    } else if (chatsWithUnread.length === 0) {
      // No unreads - reset count
      chrome.storage.local.set({ lastUnreadCount: 0 });
    } else {
      // Alarm is muted - still update count but don't trigger alarm
      chrome.storage.local.set({ lastUnreadCount: chatsWithUnread.length });
      console.log('[Handler] 🔇 Alarm muted - skipping unread notification');
    }
    
    // Forward to sidepanel to refresh the chat list UI
    chrome.runtime.sendMessage({ 
      type: 'CHAT_LIST_REFRESH',
      data: data
    }).catch(() => {}); // Ignore if sidepanel not open
    
    sendResponse({ success: true });
    return true;
  },

  // Manual retry for failed chat
  OF_AUTOCHAT_RETRY(data, sendResponse) {
    const result = retryChat(data.peerId);
    sendResponse(result);
    return true;
  },

  // Toggle alarm mute/unmute
  OF_AUTOCHAT_SET_ALARM_MUTED(data, sendResponse) {
    const muted = setAlarmMuted(data.muted);
    sendResponse({ success: true, alarmMuted: muted });
    return true;
  },

  // Get alarm state
  OF_AUTOCHAT_GET_ALARM_STATE(_, sendResponse) {
    sendResponse({ 
      success: true, 
      alarmMuted: OFAutoChatState.alarmMuted 
    });
    return true;
  },

  // Update script progress for a chat (used for priority sorting)
  async AUTOCHAT_UPDATE_SCRIPT_PROGRESS(data, sendResponse) {
    if (!data.peerId || !data.progress) {
      sendResponse({ success: false, error: 'Peer ID and progress required' });
      return true;
    }
    
    await updateChatScriptProgress(data.peerId, data.progress);
    console.log(`[AutoChat] Updated script progress for ${data.peerId}: ${data.progress.percent}% (${data.progress.completed}/${data.progress.total})`);
    sendResponse({ success: true });
    return true;
  },
  
  // Set priority mode (prioritize by script progress)
  AUTOCHAT_SET_PRIORITY_MODE(data, sendResponse) {
    AutoChatState.prioritizeByProgress = data.enabled;
    console.log(`[AutoChat] Priority mode: ${data.enabled ? 'Script Progress' : 'Order Added'}`);
    notifyStateChange();
    sendResponse({ success: true });
    return true;
  }
};
