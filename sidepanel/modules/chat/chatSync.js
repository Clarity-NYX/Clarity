// ============================================================
// CHAT SYNC MODULE - Handles chat loading and synchronization
// ============================================================

import Store from '../../state/store.js';
import API, { getSubscriberIdFromTab, requestChatFromPage } from '../../utils/api.js';
import { showNotification } from '../../utils/notify.js';
import { onChatLoaded, autoScanIfEnabled } from '../notes.js';
import { autoSelectScript, renderScriptStages, autoSkipSatisfiedGoals, Progress } from '../scripts/index.js';
import { saveFullChatReplacement, forceFlushPendingSaves, loadTelegramChatLocal } from './chatStorage.js';
import { renderChatMessages, populateNotesFromChat } from './chatRenderer.js';
import { showChatListView, showConversationView } from './chatList.js';

// Track message count for auto-scan
let lastAutoScanMessageCount = 0;

// Handle incoming messages
// Smart handling to prevent data loss
export const handleIncomingMessages = (scannedMessages) => {
  const currentProfile = Store.get('currentProfile');
  const currentSubscriberId = Store.get('currentSubscriberId');
  
  // CRITICAL: Skip if loadAndSyncChat is in progress (prevents race condition)
  // When switching chats, storedChat is cleared before DB fetch starts.
  // Content script autoLoadChat fires at 500ms with only ~20 visible DOM messages.
  // Without this guard, those 20 messages would overwrite the full DB history.
  if (Store.get('isSyncing')) {
    console.log('[Chat] ⏳ Database sync in progress - skipping incoming page messages to prevent data loss');
    return;
  }
  
  // Get existing stored messages - check BOTH storedChat AND current messages display
  // This provides defense even if storedChat was temporarily cleared during chat switch
  const storedChat = Store.get('storedChat') || {};
  const storedMessages = storedChat.messages || [];
  const currentMessages = Store.get('messages') || [];
  const existingMessages = storedMessages.length >= currentMessages.length ? storedMessages : currentMessages;
  const hasLoadedFromDatabase = Store.get('hasLoadedFromDatabase');
  
  console.log('[Chat] handleIncomingMessages: received', scannedMessages.length, 'messages from page');
  console.log('[Chat] Currently have', existingMessages.length, 'messages stored (db:', storedMessages.length, 'display:', currentMessages.length, ')');
  console.log('[Chat] Loaded from database?', hasLoadedFromDatabase);
  
  // CRITICAL: Don't replace if we have MORE messages stored
  // OnlyFans only shows recent messages until you scroll up
  if (existingMessages.length > scannedMessages.length) {
    console.log('[Chat] ⚠️ WARNING: Page has fewer messages than stored - NOT saving to prevent data loss');
    console.log('[Chat] Keeping existing', existingMessages.length, 'messages in database AND display');
    
    // KEEP displaying the full history from database!
    // Don't let partial page data override our complete history
    console.log('[Chat] Displaying full history:', existingMessages.length, 'messages');
    Store.set('messages', existingMessages);
    renderChatMessages();
    
    // Update the auto-scan counter based on full history
    lastAutoScanMessageCount = existingMessages.length;
    
    // Don't save partial data to database!
    return;
  }
  
  // Only save if we have equal or more messages
  console.log('[Chat] Page has equal/more messages - safe to update');
  Store.set('messages', scannedMessages);
  renderChatMessages();
  
  // Save to database if we have a profile
  if (currentProfile && currentSubscriberId && scannedMessages.length > 0) {
    saveFullChatReplacement(scannedMessages);
  }
  
  // Check if we should auto-scan notes (every 10-15 new messages)
  const newMessageCount = scannedMessages.length - lastAutoScanMessageCount;
  if (newMessageCount >= 10) {
    console.log('[Chat] Auto-scan threshold reached:', newMessageCount, 'new messages');
    lastAutoScanMessageCount = scannedMessages.length;
    
    // Trigger auto-scan after a short delay
    setTimeout(() => {
      autoScanIfEnabled();
    }, 1000);
  }
};

// Merge live page messages with database history (no duplicates)
const mergeMessagesWithHistory = (liveMessages, dbMessages) => {
  if (!dbMessages || dbMessages.length === 0) {
    return liveMessages;
  }
  
  if (!liveMessages || liveMessages.length === 0) {
    return dbMessages;
  }
  
  console.log(`[Chat] Merging ${liveMessages.length} live messages with ${dbMessages.length} DB messages`);
  
  // Create a Set of unique message identifiers from live messages
  // Use a combination of sender + text (first 50 chars) + approximate timestamp
  const liveMessageKeys = new Set();
  liveMessages.forEach(msg => {
    const key = createMessageKey(msg);
    liveMessageKeys.add(key);
  });
  
  // Find oldest live message timestamp to know what's "historical"
  const oldestLiveTimestamp = liveMessages.reduce((oldest, msg) => {
    const ts = new Date(msg.timestamp || msg.time || 0).getTime();
    return ts > 0 && ts < oldest ? ts : oldest;
  }, Date.now());
  
  console.log(`[Chat] Oldest live message timestamp: ${new Date(oldestLiveTimestamp).toISOString()}`);
  
  // Get historical messages from DB that are older than oldest live message
  // AND are not duplicates
  const historicalMessages = dbMessages.filter(msg => {
    const msgTimestamp = new Date(msg.timestamp || msg.time || 0).getTime();
    const key = createMessageKey(msg);
    
    // Only include if: older than oldest live message AND not a duplicate
    const isOlder = msgTimestamp < oldestLiveTimestamp;
    const isDuplicate = liveMessageKeys.has(key);
    
    return isOlder && !isDuplicate;
  });
  
  console.log(`[Chat] Found ${historicalMessages.length} historical messages to prepend`);
  
  // Merge: historical (oldest) + live (newest)
  const merged = [...historicalMessages, ...liveMessages];
  
  // Sort by timestamp (oldest first)
  merged.sort((a, b) => {
    const tsA = new Date(a.timestamp || a.time || 0).getTime();
    const tsB = new Date(b.timestamp || b.time || 0).getTime();
    return tsA - tsB;
  });
  
  console.log(`[Chat] Final merged count: ${merged.length} messages`);
  return merged;
};

// Create a unique key for a message (for deduplication)
const createMessageKey = (msg) => {
  const sender = msg.sender || msg.from || 'unknown';
  const text = (msg.text || msg.content || '').substring(0, 50).toLowerCase().trim();
  // Round timestamp to nearest minute to handle slight variations
  const ts = new Date(msg.timestamp || msg.time || 0).getTime();
  const roundedTs = Math.floor(ts / 60000) * 60000;
  return `${sender}:${text}:${roundedTs}`;
};

// Load and sync chat - ALWAYS load from live page first, then merge with DB
export const loadAndSyncChat = async () => {
  const currentProfile = Store.get('currentProfile');
  if (!currentProfile) return;
  
  const subscriberData = await getSubscriberIdFromTab();
  if (!subscriberData) return;
  
  // Store the fullId string (e.g., "tg:123456"), not the object
  Store.set('currentSubscriberId', subscriberData.fullId);
  Store.set('currentPlatform', subscriberData.platform);
  
  // Add platform class to body for CSS targeting
  document.body.classList.remove('onlyfans-platform', 'telegram-platform');
  document.body.classList.add(`${subscriberData.platform}-platform`);
  Store.set('isSyncing', true);
  
  try {
    console.log('[Chat] === LIVE-FIRST CHAT LOADING ===');
    
    // STEP 1: ALWAYS request live messages from the page FIRST
    console.log('[Chat] Step 1: Fetching LIVE messages from page...');
    let liveMessages = [];
    try {
      const pageResponse = await requestChatFromPageDirect();
      if (pageResponse && pageResponse.length > 0) {
        liveMessages = pageResponse;
        console.log(`[Chat] Got ${liveMessages.length} LIVE messages from page`);
      } else {
        console.log('[Chat] No live messages from page (empty response)');
      }
    } catch (pageError) {
      console.log('[Chat] Could not get live messages from page:', pageError.message);
    }
    
    // STEP 2: Load stored history for merging
    // PLATFORM AWARE: Telegram uses local storage, OnlyFans uses Firebase
    console.log('[Chat] Step 2: Loading stored history for merge...');
    let dbMessages = [];
    let storedChat = null;
    
    let response;
    
    // TELEGRAM: Load from local storage (no Firebase)
    if (subscriberData.platform === 'telegram') {
      console.log('[Chat] 📂 Loading Telegram chat from LOCAL storage...');
      response = await loadTelegramChatLocal(currentProfile.id, subscriberData.fullId);
    } else {
      // ONLYFANS: Load from Firebase API (existing behavior)
      console.log('[Chat] 🔥 Loading OnlyFans chat from Firebase...');
      response = await API.getChat(currentProfile.id, subscriberData.fullId);
    }
    
    if (response.success && response.chat) {
      storedChat = response.chat;
      dbMessages = response.chat.messages || [];
      console.log(`[Chat] Loaded ${dbMessages.length} messages from ${subscriberData.platform === 'telegram' ? 'local storage' : 'Firebase'}`);
      
      // Copy scriptProgress from notes to root level
      if (response.chat.notes?.scriptProgress) {
        response.chat.scriptProgress = response.chat.notes.scriptProgress;
        console.log('[Chat] Loaded script progress');
      }
      
      // Store chat metadata and notes
      Store.set('storedChat', response.chat);
      Store.set('summary', response.chat.summary || '');
      
      if (response.chat.notes) {
        populateNotesFromChat(response.chat.notes);
      }
    }
    
    // STEP 3: Merge live messages with database history
    console.log('[Chat] Step 3: Merging live + database messages...');
    let finalMessages;
    
    if (liveMessages.length > 0) {
      // We have live messages - merge with DB history
      finalMessages = mergeMessagesWithHistory(liveMessages, dbMessages);
      console.log(`[Chat] ✅ Using merged messages: ${finalMessages.length} total`);
    } else if (dbMessages.length > 0) {
      // No live messages, fall back to DB
      finalMessages = dbMessages;
      console.log(`[Chat] ⚠️ Fallback to DB messages: ${finalMessages.length} total`);
    } else {
      // No messages at all
      finalMessages = [];
      console.log('[Chat] No messages available');
    }
    
    // STEP 4: Display the merged messages
    Store.set('messages', finalMessages);
    renderChatMessages();
    
    // Update auto-scan counter
    lastAutoScanMessageCount = finalMessages.length;
    Store.set('hasLoadedFromDatabase', true);
    
    console.log('[Chat] === CHAT LOADING COMPLETE ===');
    console.log(`[Chat] Final message count: ${finalMessages.length}`);
    
    // Save merged messages back to database (preserves history + adds new)
    if (currentProfile && subscriberData.fullId && finalMessages.length > 0) {
      saveFullChatReplacement(finalMessages);
    }
    
    // Fetch stats
    setTimeout(() => fetchSubscriberStats(), 1000);
    
    // Trigger notes auto-scan (if enabled)
    setTimeout(() => onChatLoaded(), 1500);
    
  } catch (error) {
    console.error('Chat sync error:', error);
    // Fallback to page fetch
    await requestChatFromPage();
  } finally {
    Store.set('isSyncing', false);
  }
};

// Direct page request that returns messages (doesn't go through handleIncomingMessages)
const requestChatFromPageDirect = async () => {
  return new Promise(async (resolve, reject) => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]?.id) {
        return resolve([]);
      }
      
      chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_MESSAGES' }, (response) => {
        if (chrome.runtime.lastError) {
          console.log('[Chat] Direct page request error:', chrome.runtime.lastError.message);
          return resolve([]);
        }
        
        // Wait for the CHAT_MESSAGES message with actual data
        // Set a timeout and listen for the message
        let resolved = false;
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve([]);
          }
        }, 5000);
        
        // Listen for CHAT_MESSAGES response
        const listener = (message) => {
          if (message.type === 'CHAT_MESSAGES' && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            chrome.runtime.onMessage.removeListener(listener);
            resolve(message.data || []);
          }
        };
        chrome.runtime.onMessage.addListener(listener);
      });
    } catch (error) {
      console.error('[Chat] requestChatFromPageDirect error:', error);
      resolve([]);
    }
  });
};

// Force refresh subscriber stats (manual button click - opens profile tab to scrape)
export const forceRefreshSubscriberStats = async () => {
  const currentSubscriberId = Store.get('currentSubscriberId');
  if (!currentSubscriberId) {
    showNotification('No subscriber loaded');
    return;
  }
  
  const currentPlatform = Store.get('currentPlatform');
  if (currentPlatform === 'telegram') {
    showNotification('Stats not available for Telegram');
    return;
  }
  
  // Add spinning animation to button
  const btn = $('refreshSubInfoBtn');
  btn?.classList.add('spinning');
  
  try {
    console.log('[Chat] Force refreshing subscriber stats...');
    
    // Call the API directly (bypasses all cache guards)
    const response = await API.fetchSubscriberStats(currentSubscriberId);
    
    const existingNotes = Store.get('storedChat')?.notes || {};
    const updatedNotes = {
      ...existingNotes,
      statsFetchAttempted: true,
      statsFetchedAt: new Date().toISOString()
    };
    
    if (response.success && response.stats) {
      if (response.stats.subscribedSince) {
        updatedNotes.subscribedSince = response.stats.subscribedSince;
      }
      if (response.stats.totalSpent) {
        updatedNotes.totalSpent = response.stats.totalSpent;
      }
      showNotification('Subscriber info refreshed!');
    } else {
      showNotification('Could not scrape stats from profile page');
    }
    
    // Update UI
    displaySubscriberStats(updatedNotes);
    
    // Save updated notes
    const currentProfile = Store.get('currentProfile');
    if (currentProfile && currentSubscriberId) {
      await API.saveChatNotes({
        profileId: currentProfile.id,
        subscriberId: currentSubscriberId,
        notes: updatedNotes
      });
      
      const storedChat = Store.get('storedChat') || {};
      storedChat.notes = updatedNotes;
      Store.set('storedChat', storedChat);
      Store.set('currentNotes', updatedNotes);
    }
  } catch (e) {
    console.error('[Chat] Force refresh error:', e);
    showNotification('Failed to refresh stats');
  } finally {
    btn?.classList.remove('spinning');
  }
};

// Fetch subscriber stats
export const fetchSubscriberStats = async () => {
  const currentSubscriberId = Store.get('currentSubscriberId');
  const currentPlatform = Store.get('currentPlatform');
  
  if (!currentSubscriberId) return;
  
  // SKIP stats fetching for Telegram - it's OnlyFans-specific
  if (currentPlatform === 'telegram') {
    console.log('[Chat] Skipping stats fetch for Telegram - not applicable');
    const existingNotes = Store.get('storedChat')?.notes || {};
    displaySubscriberStats(existingNotes);
    // Only auto-select if not in manual mode
    if (!existingNotes.manualScriptMode) {
      autoSelectScript(null);
    }
    return;
  }
  
  const existingNotes = Store.get('storedChat')?.notes || {};
  
  // If we already have stats OR already tried fetching, use what we have
  if (existingNotes.subscribedSince || existingNotes.statsFetchAttempted) {
    displaySubscriberStats(existingNotes);
    // Only auto-select if not in manual mode
    if (!existingNotes.manualScriptMode) {
      autoSelectScript(existingNotes.subscribedSince);
    }
    return;
  }
  
  console.log('[Chat] Fetching subscriber stats for:', currentSubscriberId);
  
  try {
    const response = await API.fetchSubscriberStats(currentSubscriberId);
    
    // Mark that we attempted to fetch (even if failed/no data)
    const updatedNotes = {
      ...existingNotes,
      statsFetchAttempted: true,
      statsFetchedAt: new Date().toISOString()
    };
    
    if (response.success && response.stats) {
      // Add scraped data if we got any
      if (response.stats.subscribedSince) {
        updatedNotes.subscribedSince = response.stats.subscribedSince;
      }
      if (response.stats.totalSpent) {
        updatedNotes.totalSpent = response.stats.totalSpent;
      }
      showNotification('Subscriber stats loaded!');
    } else {
      console.log('Could not scrape stats - showing Day 1 for new subscriber');
    }
    
    displaySubscriberStats(updatedNotes);
    
    // Only auto-select if not in manual mode
    if (!updatedNotes.manualScriptMode) {
      autoSelectScript(updatedNotes.subscribedSince);
    }
    
    // Save to database so we don't fetch again
    const currentProfile = Store.get('currentProfile');
    if (currentProfile && currentSubscriberId) {
      await API.saveChatNotes({
        profileId: currentProfile.id,
        subscriberId: currentSubscriberId,
        notes: updatedNotes
      });
      
      const storedChat = Store.get('storedChat') || {};
      storedChat.notes = updatedNotes;
      Store.set('storedChat', storedChat);
      Store.set('currentNotes', updatedNotes);
    }
    
  } catch (error) {
    console.error('Error fetching subscriber stats:', error);
    // Still display with what we have (will show Day 1)
    displaySubscriberStats(existingNotes);
  }
};

// Import displaySubscriberStats from renderer
import { displaySubscriberStats } from './chatRenderer.js';

// Import script functions
import { populateChatScriptDropdown, isManualModeActive, getManualScriptId } from '../scripts/core.js';
import { $ } from '../../utils/dom.js';

// Check if URL is a supported chat page (with a specific chat open)
const isSupportedChatUrl = (url) => {
  if (!url) return false;
  // OnlyFans chat
  if (url.includes('onlyfans.com/my/chats/chat/')) return true;
  // Telegram Web A with a chat open (has hash with @ or number)
  if (url.includes('web.telegram.org/a/')) {
    const hash = new URL(url).hash;
    return hash && (hash.startsWith('#@') || hash.startsWith('#-') || /^#\d+/.test(hash));
  }
  return false;
};

// Check if URL is on a supported platform (may or may not have chat open)
const isSupportedPlatformUrl = (url) => {
  if (!url) return false;
  return url.includes('onlyfans.com') || url.includes('web.telegram.org');
};

// Setup tab watcher (supports both OnlyFans and Telegram)
export const setupTabWatcher = () => {
  detectAndSyncChat();
  
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Check for URL changes on supported platforms (not just chat URLs)
    // This ensures we switch to chat list when navigating away from a chat
    if (changeInfo.url && tab.active && isSupportedPlatformUrl(changeInfo.url)) {
      console.log('[Chat] Tab URL changed on platform:', changeInfo.url);
      detectAndSyncChat();
    }
  });
  
  chrome.tabs.onActivated.addListener((activeInfo) => {
    chrome.tabs.get(activeInfo.tabId, (tab) => {
      // Trigger for any supported platform URL
      if (isSupportedPlatformUrl(tab.url)) {
        console.log('[Chat] Switched to tab with supported platform:', tab.url);
        detectAndSyncChat();
      }
    });
  });
};

export const detectAndSyncChat = async () => {
  const subscriberData = await getSubscriberIdFromTab();
  
  console.log('[Chat] detectAndSyncChat - subscriberData:', subscriberData);
  
  if (!subscriberData) {
    console.log('[Chat] No subscriber detected on current tab - showing chat list');
    
    // IMPORTANT: Force save any pending messages before switching away
    await forceFlushPendingSaves();
    
    // No chat open - show the chat list view
    showChatListView();
    return;
  }
  
  // Chat detected - show conversation view
  showConversationView();
  
  // Use fullId for comparison (includes platform prefix)
  const fullId = subscriberData.fullId;
  const currentFullId = Store.get('currentSubscriberId');
  
  console.log('[Chat] Comparing IDs - new:', fullId, 'current:', currentFullId);
  
  // Check if this is the same chat or a new one
  const isNewChat = fullId && fullId !== currentFullId;
  
  if (isNewChat) {
    // Switching to a different chat
    // CRITICAL: Set syncing flag BEFORE clearing data to prevent race condition
    // Content script's autoLoadChat fires at 500ms with only ~20 DOM messages.
    // Without this flag, handleIncomingMessages would overwrite DB history.
    Store.set('isSyncing', true);
    
    // IMPORTANT: Force save current chat before switching
    if (currentFullId) {
      await forceFlushPendingSaves();
    }
    // CRITICAL: Flush and reset ProgressManager for previous subscriber
    await Progress.reset();
    
    // Increment operation version to invalidate any pending operations
    const newOpVersion = Store.newOperation();
    console.log(`🔄 New ${subscriberData.platform} chat detected (${subscriberData.id}) - operation v${newOpVersion}`);
    
    // Reset Store state (but NOT progress - that's in ProgressManager now)
    // Note: Store.reset() does NOT clear isSyncing, so our guard stays active
    Store.reset();
    
    // CRITICAL: Clear stored chat to prevent cross-chat contamination
    Store.set('storedChat', null);
    Store.set('messages', []);
    Store.set('hasLoadedFromDatabase', false);
    
    // Reset message count for auto-scan
    lastAutoScanMessageCount = 0;
  } else if (fullId === currentFullId) {
    // Re-entering the SAME chat - need to reload from database!
    console.log('[Chat] Re-entering same chat - reloading from database');
    
    // Don't reset Store, but do reset message count for auto-scan
    lastAutoScanMessageCount = Store.get('messages')?.length || 0;
  }
  
  // Always set/update subscriber info
  Store.set('currentSubscriberId', subscriberData.fullId);
  Store.set('currentPlatform', subscriberData.platform);
  
  // Add platform class to body for CSS targeting
  document.body.classList.remove('onlyfans-platform', 'telegram-platform');
  document.body.classList.add(`${subscriberData.platform}-platform`);
  
  // For Telegram, try to get chat info (subscriber name)
  if (subscriberData.platform === 'telegram') {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_CHAT_INFO' }, (response) => {
          if (response?.success && response.info?.displayName) {
            console.log('[Chat] Telegram chat name:', response.info.displayName);
            Store.set('subscriberName', response.info.displayName);
          }
        });
      }
    } catch (e) {
      console.log('[Chat] Could not get Telegram chat info:', e);
    }
  }
  
  // Clear stored script selection for fresh auto-selection only on NEW chat
  if (isNewChat) {
    chrome.storage.local.remove(['currentScriptId']);
    
    // Immediately re-render scripts with fresh (empty) state for new subscriber
    console.log('[Chat] Re-rendering scripts for new subscriber...');
    renderScriptStages();
  }
  
  // ALWAYS load from database if we have a profile (for both new and same chat)
  if (Store.get('currentProfile')) {
    // Load from database FIRST to preserve stored messages
    await loadAndSyncChat();
      
      // After loading chat, handle script selection
      const storedChat = Store.get('storedChat') || {};
      const storedNotes = storedChat.notes || {};
      
      // Populate chat script dropdown
      populateChatScriptDropdown();
      
      // Check if manual mode is active (stored in notes)
      if (storedNotes.manualScriptMode && storedNotes.manualScriptId) {
        console.log('[Chat] Manual script mode active, selecting:', storedNotes.manualScriptId);
        
        // Select the manual script
        const scripts = Store.get('scripts') || [];
        const manualScript = scripts.find(s => s.id === storedNotes.manualScriptId);
        if (manualScript) {
          Store.set('currentScript', manualScript);
          chrome.storage.local.set({ currentScriptId: manualScript.id });
          renderScriptStages();
          
          // Update UI
          const scriptSelectChat = $('scriptSelectChat');
          if (scriptSelectChat) scriptSelectChat.value = manualScript.id;
          
          $('scriptManualModeBtn')?.classList.add('hidden');
          $('scriptAutoModeBtn')?.classList.remove('hidden');
          $('scriptModeIndicator')?.classList.remove('hidden');
        } else {
          // Manual script not found, fallback to auto
          console.warn('[Chat] Manual script not found, falling back to auto');
          autoSelectScript(storedNotes.subscribedSince);
        }
      } else {
        // Auto-select script based on subscriber day
        autoSelectScript(storedNotes.subscribedSince);
        
        // Update UI for auto mode
        $('scriptAutoModeBtn')?.classList.add('hidden');
        $('scriptManualModeBtn')?.classList.remove('hidden');
        $('scriptModeIndicator')?.classList.add('hidden');
      }
      
      // Update dropdown after selection
      populateChatScriptDropdown();
      
      // Mark loading complete - progress is ready
      Store.finishLoading();
      
      // Auto-skip goals that are already satisfied based on conversation/notes
      // This runs after script is selected and messages are loaded
      setTimeout(() => {
        console.log('[Chat] Running auto-skip detection...');
        autoSkipSatisfiedGoals(renderScriptStages);
      }, 500);
  } else {
    // Only request from page if no profile (no database to load from)
    console.log('[Chat] No profile - requesting messages from page...');
    try {
      const response = await requestChatFromPage();
      console.log('[Chat] requestChatFromPage result:', response);
    } catch (err) {
      console.error('[Chat] requestChatFromPage error:', err);
    }
    
    console.log('[Chat] No profile selected - messages will display but not sync to database');
    // Still auto-select a script for display, using no subscriber info (treats as Day 1)
    autoSelectScript(null);
    
    // Mark loading complete even without profile
    Store.finishLoading();
    
    // Also run auto-skip for display purposes
    setTimeout(() => {
      autoSkipSatisfiedGoals(renderScriptStages);
    }, 500);
    
    // IMPORTANT: Still trigger notes loading for Telegram even without profile sync
    // This ensures auto-notes work for Telegram chats
    if (subscriberData.platform === 'telegram') {
      console.log('[Chat] Telegram: Triggering onChatLoaded for notes...');
      setTimeout(() => onChatLoaded(), 1000);
    }
  }
};