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

// Verification state
let verificationRetries = 0;
const MAX_VERIFICATION_RETRIES = 1; // PERFORMANCE: Reduced from 3 — one retry is sufficient
const VERIFY_TAIL_COUNT = 8; // Compare last N messages
let pendingVerifyTimer = null; // Debounce timer for incoming message verification
let lastVerificationTime = 0; // PERFORMANCE: Cooldown to prevent excessive verification
const VERIFY_COOLDOWN_MS = 30000; // 30 seconds between verifications

// PERFORMANCE: Debounce for detectAndSyncChat — tab events fire in rapid bursts
let _detectSyncDebounceTimer = null;
const DETECT_SYNC_DEBOUNCE_MS = 500;

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
  
  // ALWAYS merge live page messages with DB history
  // Live messages are ground truth for CURRENT state; DB provides HISTORICAL messages
  // OnlyFans only shows recent visible messages, so page always has fewer than DB — that's normal
  let finalMessages;
  
  if (existingMessages.length > 0 && scannedMessages.length > 0) {
    // Merge: prepend historical DB messages + use live page as current truth
    finalMessages = mergeMessagesWithHistory(scannedMessages, existingMessages);
    console.log('[Chat] ✅ Merged live+stored:', finalMessages.length, 'total messages');
  } else if (scannedMessages.length > 0) {
    finalMessages = scannedMessages;
    console.log('[Chat] Using scanned messages only:', finalMessages.length);
  } else {
    finalMessages = existingMessages;
    console.log('[Chat] No scanned messages, keeping existing:', finalMessages.length);
  }
  
  // Only re-render if messages actually changed (Store tracks fingerprint)
  const versionBefore = Store.get('messageVersion');
  Store.set('messages', finalMessages);
  const versionAfter = Store.get('messageVersion');
  
  if (versionAfter !== versionBefore) {
    renderChatMessages();
    
    // Save merged result to database if we have a profile
    if (currentProfile && currentSubscriberId && finalMessages.length > 0) {
      saveFullChatReplacement(finalMessages);
    }
  } else {
    console.log('[Chat] Messages unchanged — skipping re-render and save');
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
  
  // Debounced verification after incoming messages settle
  // This catches scrambling caused by scroll-up loading older messages
  if (pendingVerifyTimer) clearTimeout(pendingVerifyTimer);
  pendingVerifyTimer = setTimeout(() => {
    pendingVerifyTimer = null;
    if (!Store.get('isSyncing') && Store.get('currentSubscriberId')) {
      console.log('[Chat] Running debounced post-incoming verification...');
      verifyAndCorrectChat();
    }
  }, 4000); // Wait 4s after last incoming batch to let scrolling settle
};

// ============================================================
// MESSAGE MERGE - Combine live page messages with DB history
// ============================================================

// Get a parseable timestamp from a message (tries all available fields)
const getMsgTimestamp = (msg) => {
  // Priority 1: ISO datetime from OnlyFans DOM (most reliable)
  if (msg.datetime) {
    const ts = new Date(msg.datetime).getTime();
    if (!isNaN(ts) && ts > 0) return ts;
  }
  // Priority 2: Explicit timestamp field
  if (msg.timestamp) {
    const ts = typeof msg.timestamp === 'number' ? msg.timestamp : new Date(msg.timestamp).getTime();
    if (!isNaN(ts) && ts > 0) return ts;
  }
  // Priority 3: lastMessageAt or similar
  if (msg.lastMessageAt) {
    const ts = typeof msg.lastMessageAt === 'number' ? msg.lastMessageAt : new Date(msg.lastMessageAt).getTime();
    if (!isNaN(ts) && ts > 0) return ts;
  }
  // No parseable timestamp
  return 0;
};

// Create a unique key for a message (for deduplication during merge)
const createMessageKey = (msg) => {
  const sender = msg.isFromMe ? 'me' : 'them';
  const text = (msg.text || '').substring(0, 50).toLowerCase().trim();
  
  // Use datetime if available for precision
  const ts = getMsgTimestamp(msg);
  const roundedTs = ts > 0 ? Math.floor(ts / 60000) * 60000 : 0; // Round to nearest minute
  
  // If we have a real OnlyFans ID, use that (most reliable)
  if (msg.id && !msg.id.startsWith('temp-')) {
    return `id:${msg.id}`;
  }
  
  // If we have a good timestamp, use sender+text+time
  if (roundedTs > 0) {
    return `${sender}:${text}:${roundedTs}`;
  }
  
  // Fallback: sender + full text (less reliable but still useful)
  return `${sender}:${text}`;
};

// Sort merged messages by timestamp ONLY (never by 'order' across sources)
// 'order' values from different scrapes/sources are in different index spaces
const sortByTimestampOnly = (messages) => {
  messages.sort((a, b) => {
    const tsA = getMsgTimestamp(a);
    const tsB = getMsgTimestamp(b);
    if (tsA > 0 && tsB > 0) return tsA - tsB;
    // If only one has a timestamp, the one without stays in place
    return 0;
  });
};

// Re-index the 'order' field sequentially after merging
// This ensures a clean 0, 1, 2... sequence regardless of source
const reindexOrder = (messages) => {
  messages.forEach((msg, i) => {
    msg.order = i;
  });
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
  
  // REPAIR: Sort DB messages by timestamp to fix any previously corrupted ordering
  // Previous merges may have scrambled the order; timestamps are the source of truth
  const dbWithTs = dbMessages.filter(m => getMsgTimestamp(m) > 0).length;
  if (dbWithTs > dbMessages.length * 0.5) {
    // Most DB messages have timestamps — safe to sort-repair
    dbMessages = [...dbMessages].sort((a, b) => {
      const tsA = getMsgTimestamp(a);
      const tsB = getMsgTimestamp(b);
      if (tsA > 0 && tsB > 0) return tsA - tsB;
      // Keep non-timestamped messages in their relative position
      if (tsA > 0) return -1; // Timestamped goes before non-timestamped
      if (tsB > 0) return 1;
      return 0;
    });
    console.log(`[Chat] Repaired DB message order (${dbWithTs}/${dbMessages.length} have timestamps)`);
  }
  
  // Build a Set of live message keys for dedup
  const liveMessageKeys = new Set();
  liveMessages.forEach(msg => {
    liveMessageKeys.add(createMessageKey(msg));
  });
  
  // Find oldest live message timestamp
  let oldestLiveTs = Infinity;
  liveMessages.forEach(msg => {
    const ts = getMsgTimestamp(msg);
    if (ts > 0 && ts < oldestLiveTs) oldestLiveTs = ts;
  });
  
  // If no parseable timestamps on live messages, use order-based merge instead
  const hasTimestamps = oldestLiveTs < Infinity;
  
  if (hasTimestamps) {
    console.log(`[Chat] Oldest live message: ${new Date(oldestLiveTs).toISOString()}`);
  } else {
    console.log(`[Chat] No parseable timestamps on live messages — using order-based merge`);
  }
  
  // Get historical DB messages that are NOT duplicates of live messages
  let historicalMessages;
  
  if (hasTimestamps) {
    // Timestamp-based: keep DB messages older than oldest live message
    historicalMessages = dbMessages.filter(msg => {
      const key = createMessageKey(msg);
      if (liveMessageKeys.has(key)) return false; // Duplicate
      
      const ts = getMsgTimestamp(msg);
      // If DB message has a timestamp, it must be older than oldest live
      // If DB message has NO timestamp, include it only if it has a lower order
      if (ts > 0) return ts < oldestLiveTs;
      // No timestamp: include if it's in the first part of DB (likely historical)
      return true; // Include — better to have duplicates than lose history
    });
  } else {
    // No timestamps available — use text-based dedup only
    // Keep all DB messages that aren't exact text+sender matches to live messages
    historicalMessages = dbMessages.filter(msg => {
      const key = createMessageKey(msg);
      return !liveMessageKeys.has(key);
    });
  }
  
  console.log(`[Chat] Found ${historicalMessages.length} historical messages to prepend`);
  
  // CRITICAL SAFETY: If historical count is suspiciously low compared to DB,
  // it might mean dedup is too aggressive. Prefer DB count.
  if (dbMessages.length > 50 && historicalMessages.length < dbMessages.length * 0.3) {
    console.warn(`[Chat] ⚠️ Only ${historicalMessages.length}/${dbMessages.length} DB messages survived merge — suspicious!`);
    console.warn(`[Chat] ⚠️ Falling back to DB-first strategy to protect history`);
    
    // Safe strategy: use ALL DB messages + append any truly new live messages
    const dbKeys = new Set(dbMessages.map(m => createMessageKey(m)));
    const newLiveOnly = liveMessages.filter(m => !dbKeys.has(createMessageKey(m)));
    
    console.log(`[Chat] DB-first: ${dbMessages.length} DB + ${newLiveOnly.length} new live messages`);
    const merged = [...dbMessages, ...newLiveOnly];
    
    // ONLY sort by timestamp — never by 'order' across sources
    // 'order' values from different scrapes are in different index spaces
    // and mixing them causes scrambled message ordering
    sortByTimestampOnly(merged);
    
    // Re-index order field so it's sequential after merge
    reindexOrder(merged);
    
    console.log(`[Chat] Final merged count: ${merged.length} messages`);
    return merged;
  }
  
  // Normal merge: historical (oldest) first, then live (newest)
  // DO NOT sort — the concat order IS already correct:
  //   - Historical messages are filtered to be OLDER than oldest live message
  //   - Within each group, messages are already in chronological order
  //     (DB messages in their stored array order, live messages in DOM order)
  //   - Sorting would BREAK ordering when some messages lack timestamps
  const merged = [...historicalMessages, ...liveMessages];
  
  // Re-index order field so it's sequential after merge
  reindexOrder(merged);
  
  console.log(`[Chat] Final merged count: ${merged.length} messages`);
  return merged;
};

// ============================================================
// VERIFICATION SYSTEM - Cross-check displayed msgs vs live page
// ============================================================

// Create a lightweight fingerprint for a message (for comparison)
const msgFingerprint = (msg) => {
  const sender = msg.isFromMe ? 'me' : 'them';
  const text = (msg.text || '').substring(0, 40).toLowerCase().trim();
  return `${sender}|${text}`;
};

// Compare tail of displayed messages against live page messages
// Returns { match: true/false, details: string }
const compareTails = (displayedMessages, liveMessages) => {
  if (!liveMessages || liveMessages.length === 0) {
    return { match: true, details: 'No live messages to compare' };
  }
  if (!displayedMessages || displayedMessages.length === 0) {
    return { match: false, details: 'No displayed messages but live page has messages' };
  }
  
  // Get the last N messages from live page (these are the most recent visible ones)
  const liveCount = Math.min(VERIFY_TAIL_COUNT, liveMessages.length);
  const liveTail = liveMessages.slice(-liveCount);
  const liveTailFingerprints = liveTail.map(msgFingerprint);
  
  // Get the last N messages from displayed (should match live tail)
  const displayedTail = displayedMessages.slice(-liveCount);
  const displayedTailFingerprints = displayedTail.map(msgFingerprint);
  
  // Compare: every live tail message should appear in displayed tail
  let matchCount = 0;
  let mismatchDetails = [];
  
  for (let i = 0; i < liveTailFingerprints.length; i++) {
    if (i < displayedTailFingerprints.length && liveTailFingerprints[i] === displayedTailFingerprints[i]) {
      matchCount++;
    } else {
      mismatchDetails.push({
        position: i,
        live: liveTailFingerprints[i] || '(none)',
        displayed: displayedTailFingerprints[i] || '(none)'
      });
    }
  }
  
  const matchRatio = matchCount / liveTailFingerprints.length;
  const isMatch = matchRatio >= 0.75; // Allow 25% tolerance (media placeholders, etc.)
  
  return {
    match: isMatch,
    matchRatio,
    matchCount,
    total: liveTailFingerprints.length,
    details: isMatch 
      ? `✅ ${matchCount}/${liveTailFingerprints.length} tail messages match`
      : `❌ Only ${matchCount}/${liveTailFingerprints.length} tail messages match`,
    mismatches: mismatchDetails
  };
};

// Perform corrective merge: live page is absolute truth for recent messages
// DB messages are only used for historical (older) messages
const correctiveMerge = (liveMessages, dbMessages) => {
  console.log(`[Verify] Corrective merge: ${liveMessages.length} live + ${dbMessages.length} DB`);
  
  if (!liveMessages || liveMessages.length === 0) return dbMessages || [];
  if (!dbMessages || dbMessages.length === 0) return liveMessages;
  
  // Live messages ARE the truth for the recent portion of the chat
  // Only prepend DB messages that are OLDER than ALL live messages
  
  // Build fingerprint set of all live messages for dedup
  const liveFPs = new Set(liveMessages.map(msgFingerprint));
  const liveKeys = new Set(liveMessages.map(createMessageKey));
  
  // Find the oldest live message timestamp
  let oldestLiveTs = Infinity;
  liveMessages.forEach(msg => {
    const ts = getMsgTimestamp(msg);
    if (ts > 0 && ts < oldestLiveTs) oldestLiveTs = ts;
  });
  
  // Filter DB messages: only keep ones that are strictly historical
  const historical = dbMessages.filter(msg => {
    // Skip if it's a duplicate of a live message
    if (liveKeys.has(createMessageKey(msg))) return false;
    if (liveFPs.has(msgFingerprint(msg))) return false;
    
    // Must be older than oldest live message
    const ts = getMsgTimestamp(msg);
    if (ts > 0 && oldestLiveTs < Infinity) {
      return ts < oldestLiveTs;
    }
    
    // No timestamp comparison possible — skip to avoid disorder
    return false;
  });
  
  // Sort historical by timestamp
  historical.sort((a, b) => {
    const tsA = getMsgTimestamp(a);
    const tsB = getMsgTimestamp(b);
    if (tsA > 0 && tsB > 0) return tsA - tsB;
    return 0;
  });
  
  const result = [...historical, ...liveMessages];
  reindexOrder(result);
  
  console.log(`[Verify] Corrective result: ${historical.length} historical + ${liveMessages.length} live = ${result.length} total`);
  return result;
};

// Main verification: fetch fresh live messages, compare, correct if needed
const verifyAndCorrectChat = async () => {
  const currentSubscriberId = Store.get('currentSubscriberId');
  if (!currentSubscriberId) return;
  
  // PERFORMANCE: Cooldown to prevent excessive verification cascades
  const now = Date.now();
  if (now - lastVerificationTime < VERIFY_COOLDOWN_MS) {
    console.log(`[Verify] Skipping — cooldown active (${Math.round((VERIFY_COOLDOWN_MS - (now - lastVerificationTime)) / 1000)}s remaining)`);
    return;
  }
  lastVerificationTime = now;
  
  verificationRetries = 0;
  
  const runVerification = async () => {
    verificationRetries++;
    console.log(`[Verify] === Verification attempt ${verificationRetries}/${MAX_VERIFICATION_RETRIES} ===`);
    
    // Fetch fresh messages from the live page
    let freshLiveMessages = [];
    try {
      freshLiveMessages = await requestChatFromPageDirect();
    } catch (e) {
      console.log('[Verify] Could not fetch fresh live messages:', e.message);
      return; // Can't verify without live page — skip silently
    }
    
    if (!freshLiveMessages || freshLiveMessages.length === 0) {
      console.log('[Verify] No fresh live messages — skipping verification');
      return;
    }
    
    // Compare tail of currently displayed messages with fresh live
    const currentMessages = Store.get('messages') || [];
    const result = compareTails(currentMessages, freshLiveMessages);
    
    console.log(`[Verify] ${result.details}`);
    
    if (result.match) {
      console.log('[Verify] ✅ Chat verified — messages match live page');
      verificationRetries = 0;
      return;
    }
    
    // MISMATCH — need correction
    console.warn(`[Verify] ⚠️ Mismatch detected! ${result.details}`);
    if (result.mismatches?.length > 0) {
      result.mismatches.forEach(m => {
        console.warn(`[Verify]   Position ${m.position}: live="${m.live}" vs displayed="${m.displayed}"`);
      });
    }
    
    // Perform corrective merge using live page as ground truth
    const dbMessages = Store.get('storedChat')?.messages || [];
    const corrected = correctiveMerge(freshLiveMessages, dbMessages);
    
    // Update store and re-render
    Store.set('messages', corrected);
    renderChatMessages();
    
    // Save corrected version to DB
    const currentProfile = Store.get('currentProfile');
    if (currentProfile && currentSubscriberId && corrected.length > 0) {
      saveFullChatReplacement(corrected);
    }
    
    console.log(`[Verify] Applied corrective merge: ${corrected.length} messages`);
    
    // Re-verify if we haven't exceeded retries
    if (verificationRetries < MAX_VERIFICATION_RETRIES) {
      console.log(`[Verify] Re-verifying in 2s...`);
      setTimeout(async () => {
        // Check we're still on the same chat
        if (Store.get('currentSubscriberId') !== currentSubscriberId) {
          console.log('[Verify] Chat changed — aborting re-verification');
          return;
        }
        await runVerification();
      }, 2000);
    } else {
      console.log(`[Verify] Max retries reached — accepting current state`);
      verificationRetries = 0;
    }
  };
  
  await runVerification();
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
    
    // STEP 5: Verify displayed messages match live page
    // Run after a delay to let DOM settle and avoid racing with content script
    setTimeout(() => {
      // Ensure we're still on the same chat
      if (Store.get('currentSubscriberId') === subscriberData.fullId) {
        console.log('[Chat] Step 5: Running post-load verification...');
        verifyAndCorrectChat();
      }
    }, 3000);
    
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
      // PROTECT subscribedSince — once set, it's the permanent anchor date
      // Only set on FIRST detection. Re-scraping would shift the date due to
      // approximate back-calculation ("30 days" → now-30d recalculated each time)
      if (response.stats.subscribedSince && !updatedNotes.subscribedSince) {
        updatedNotes.subscribedSince = response.stats.subscribedSince;
        console.log('[Chat] Set subscribedSince anchor:', updatedNotes.subscribedSince);
      }
      // totalSpent CAN be refreshed — it's a cumulative value from the page
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

// PERFORMANCE: Debounced entry point — tab events (onUpdated, onActivated) fire
// in rapid bursts during navigation. This collapses them into a single call.
export const detectAndSyncChat = () => {
  if (_detectSyncDebounceTimer) clearTimeout(_detectSyncDebounceTimer);
  _detectSyncDebounceTimer = setTimeout(() => {
    _detectSyncDebounceTimer = null;
    _detectAndSyncChatImpl();
  }, DETECT_SYNC_DEBOUNCE_MS);
};

const _detectAndSyncChatImpl = async () => {
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