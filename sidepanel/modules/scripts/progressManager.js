// ============================================================
// PROGRESS MANAGER V2 - PROFESSIONAL SCRIPT PROGRESS TRACKING
// ============================================================
// KEY IMPROVEMENTS:
// 1. Immediate dual-write (local + Firebase on EVERY change)
// 2. Auto-init on context change (subscriber/script change)
// 3. Defensive merge (never lose progress)
// 4. Visibility-based reload (handles extension open/close)
// 5. Proper version tracking
// ============================================================

import Store from '../../state/store.js';
import API from '../../utils/api.js';

// ============================================================
// STATE
// ============================================================

// Current progress state (in-memory mirror of persisted data)
let currentProgress = {
  profileId: null,
  subscriberId: null,
  scriptId: null,
  scriptName: null,
  completed: [],       // Array of "stageIdx:actionIdx" strings
  version: 0,
  lastUpdated: null,
  isLoaded: false
};

// Track context to detect changes
let lastContext = {
  profileId: null,
  subscriberId: null,
  scriptId: null
};

// Save queue for retry logic
let saveRetryQueue = [];
let isProcessingRetry = false;

// Remote sync polling
let syncInterval = null;
const SYNC_INTERVAL_MS = 15000; // Poll Firebase every 15 seconds
let _onRemoteUpdate = null; // Callback when remote has new progress (triggers re-render)

// ============================================================
// LOGGING
// ============================================================

const log = (...args) => console.log('[Progress]', ...args);
const logError = (...args) => console.error('[Progress]', ...args);

// ============================================================
// CONTEXT HELPERS
// ============================================================

const getContext = () => {
  const profileId = Store.get('currentProfile')?.id;
  const subscriberId = Store.get('currentSubscriberId');
  const scriptId = Store.get('currentScript')?.id;
  const scriptName = Store.get('currentScript')?.name;
  return { profileId, subscriberId, scriptId, scriptName };
};

const getLocalStorageKey = (profileId, subscriberId, scriptId) => {
  return `progress_v2_${profileId}_${subscriberId}_${scriptId}`;
};

const hasContextChanged = () => {
  const ctx = getContext();
  return (
    ctx.profileId !== lastContext.profileId ||
    ctx.subscriberId !== lastContext.subscriberId ||
    ctx.scriptId !== lastContext.scriptId
  );
};

// ============================================================
// LOCAL STORAGE (Immediate persistence)
// ============================================================

const saveToLocal = async () => {
  const { profileId, subscriberId, scriptId } = currentProgress;
  if (!profileId || !subscriberId || !scriptId) return false;
  
  const key = getLocalStorageKey(profileId, subscriberId, scriptId);
  
  try {
    await chrome.storage.local.set({
      [key]: {
        completed: currentProgress.completed,
        version: currentProgress.version,
        lastUpdated: Date.now(),
        scriptName: currentProgress.scriptName
      }
    });
    log('✅ Saved to local storage:', currentProgress.completed.length, 'completed');
    return true;
  } catch (error) {
    logError('❌ Local storage save error:', error);
    return false;
  }
};

const loadFromLocal = async (profileId, subscriberId, scriptId) => {
  const key = getLocalStorageKey(profileId, subscriberId, scriptId);
  
  try {
    const result = await chrome.storage.local.get([key]);
    const stored = result[key];
    
    if (stored && Array.isArray(stored.completed)) {
      log('📂 Loaded from local:', stored.completed.length, 'completed');
      return {
        completed: stored.completed,
        version: stored.version || 0,
        lastUpdated: stored.lastUpdated || null
      };
    }
  } catch (error) {
    logError('❌ Local storage load error:', error);
  }
  
  return null;
};

// ============================================================
// FIREBASE (Immediate persistence with retry)
// ============================================================

const saveToFirebase = async () => {
  const { profileId, subscriberId, scriptId, completed, scriptName } = currentProgress;
  if (!profileId || !subscriberId || !scriptId) return false;
  
  try {
    const result = await API.saveScriptProgress({
      profileId,
      subscriberId,
      scriptId,
      completed,
      scriptName
    });
    
    if (result.success) {
      // Update version from server response
      if (result.progress?.version) {
        currentProgress.version = result.progress.version;
      }
      log('✅ Saved to Firebase:', completed.length, 'completed, version:', currentProgress.version);
      return true;
    } else {
      logError('❌ Firebase save failed:', result.error);
      queueRetry();
      return false;
    }
  } catch (error) {
    logError('❌ Firebase save error:', error);
    queueRetry();
    return false;
  }
};

const loadFromFirebase = async (profileId, subscriberId, scriptId) => {
  try {
    const result = await API.getScriptProgress({
      profileId,
      subscriberId,
      scriptId
    });
    
    if (result.success && result.progress) {
      log('☁️ Loaded from Firebase:', result.progress.completed?.length || 0, 'completed');
      return {
        completed: result.progress.completed || [],
        version: result.progress.version || 0,
        lastUpdated: result.progress.lastUpdated || null
      };
    }
  } catch (error) {
    logError('❌ Firebase load error:', error);
  }
  
  return null;
};

// ============================================================
// RETRY QUEUE (Handle offline/failed saves)
// ============================================================

const queueRetry = () => {
  const snapshot = {
    profileId: currentProgress.profileId,
    subscriberId: currentProgress.subscriberId,
    scriptId: currentProgress.scriptId,
    completed: [...currentProgress.completed],
    scriptName: currentProgress.scriptName,
    timestamp: Date.now()
  };
  
  saveRetryQueue.push(snapshot);
  log('📋 Queued for retry, queue size:', saveRetryQueue.length);
  
  // Process queue after delay
  if (!isProcessingRetry) {
    setTimeout(processRetryQueue, 5000);
  }
};

const processRetryQueue = async () => {
  if (isProcessingRetry || saveRetryQueue.length === 0) return;
  
  // Check if user is authenticated before processing
  const currentProfile = Store.get('currentProfile');
  if (!currentProfile?.id) {
    // Only log once every 5 minutes to avoid console spam
    if (!processRetryQueue.lastWarning || Date.now() - processRetryQueue.lastWarning > 300000) {
      log('⏳ Retry queue: No profile selected, will retry later');
      processRetryQueue.lastWarning = Date.now();
    }
    setTimeout(processRetryQueue, 60000); // Check again in 60s
    return;
  }
  
  isProcessingRetry = true;
  log('🔄 Processing retry queue:', saveRetryQueue.length, 'items');
  
  while (saveRetryQueue.length > 0) {
    const item = saveRetryQueue[0];
    
    // Skip old items (more than 10 minutes old)
    if (Date.now() - item.timestamp > 10 * 60 * 1000) {
      log('⏭️ Skipping stale retry item (> 10 min old)');
      saveRetryQueue.shift();
      continue;
    }
    
    try {
      const result = await API.saveScriptProgress({
        profileId: item.profileId,
        subscriberId: item.subscriberId,
        scriptId: item.scriptId,
        completed: item.completed,
        scriptName: item.scriptName
      });
      
      if (result.success) {
        saveRetryQueue.shift(); // Remove successful item
        log('✅ Retry succeeded, remaining:', saveRetryQueue.length);
      } else if (result.error?.includes('Unauthorized') || result.error?.includes('401')) {
        // Auth error - stop processing, will retry later when auth is restored
        log('🔒 Auth error in retry, will try again later');
        break;
      } else {
        log('⏳ Retry failed:', result.error, '- will try again later');
        break;
      }
    } catch (error) {
      if (error.message?.includes('Unauthorized') || error.message?.includes('401')) {
        log('🔒 Auth error in retry, will try again later');
      } else {
        logError('❌ Retry error:', error.message);
      }
      break;
    }
    
    // Small delay between retries
    await new Promise(r => setTimeout(r, 1000));
  }
  
  isProcessingRetry = false;
  
  // Schedule next retry if queue not empty
  if (saveRetryQueue.length > 0) {
    setTimeout(processRetryQueue, 30000); // Retry in 30 seconds
  }
};

// ============================================================
// CORE FUNCTIONS
// ============================================================

// Initialize progress for current context
export const init = async (forceReload = false) => {
  const ctx = getContext();
  
  if (!ctx.profileId || !ctx.subscriberId || !ctx.scriptId) {
    log('⚠️ Cannot init - missing context:', ctx);
    currentProgress = {
      profileId: null,
      subscriberId: null,
      scriptId: null,
      scriptName: null,
      completed: [],
      version: 0,
      lastUpdated: null,
      isLoaded: false
    };
    return;
  }
  
  // Skip if already loaded for same context (unless forced)
  if (!forceReload && currentProgress.isLoaded &&
      ctx.profileId === currentProgress.profileId &&
      ctx.subscriberId === currentProgress.subscriberId &&
      ctx.scriptId === currentProgress.scriptId) {
    log('⏭️ Already loaded for this context');
    return;
  }
  
  log('═══════════════════════════════════════════');
  log('🔄 INITIALIZING PROGRESS');
  log('═══════════════════════════════════════════');
  log('Profile:', ctx.profileId);
  log('Subscriber:', ctx.subscriberId);
  log('Script:', ctx.scriptId, `(${ctx.scriptName})`);
  
  // Update tracking
  lastContext = { ...ctx };
  
  // Load from BOTH sources
  const [localData, firebaseData] = await Promise.all([
    loadFromLocal(ctx.profileId, ctx.subscriberId, ctx.scriptId),
    loadFromFirebase(ctx.profileId, ctx.subscriberId, ctx.scriptId)
  ]);
  
  // DEFENSIVE MERGE - use whichever has MORE progress (never lose data)
  let finalCompleted = [];
  let finalVersion = 0;
  
  const localCount = localData?.completed?.length || 0;
  const firebaseCount = firebaseData?.completed?.length || 0;
  
  if (localCount === 0 && firebaseCount === 0) {
    log('📭 No existing progress found - starting fresh');
    finalCompleted = [];
    finalVersion = 0;
  } else if (localCount >= firebaseCount) {
    log(`📂 Using LOCAL (${localCount} >= Firebase ${firebaseCount})`);
    finalCompleted = localData.completed;
    finalVersion = localData.version || 0;
    
    // If local has more than Firebase, sync to Firebase
    if (localCount > firebaseCount) {
      log('☁️ Syncing local→Firebase (local has more)');
      // Will sync after we set currentProgress
    }
  } else {
    log(`☁️ Using FIREBASE (${firebaseCount} > Local ${localCount})`);
    finalCompleted = firebaseData.completed;
    finalVersion = firebaseData.version || 0;
  }
  
  // MERGE both sets (union) to never lose anything
  if (localData?.completed && firebaseData?.completed) {
    const merged = [...new Set([...(localData.completed || []), ...(firebaseData.completed || [])])];
    if (merged.length > finalCompleted.length) {
      log(`🔀 MERGED: ${finalCompleted.length} → ${merged.length} (union of both)`);
      finalCompleted = merged;
    }
  }
  
  // Set current progress
  currentProgress = {
    profileId: ctx.profileId,
    subscriberId: ctx.subscriberId,
    scriptId: ctx.scriptId,
    scriptName: ctx.scriptName,
    completed: finalCompleted,
    version: finalVersion,
    lastUpdated: Date.now(),
    isLoaded: true
  };
  
  log('✅ Loaded:', finalCompleted.length, 'completed actions');
  log('═══════════════════════════════════════════');
  
  // Ensure both storage locations have the same data
  await saveToLocal();
  if (localCount !== firebaseCount || localCount !== finalCompleted.length) {
    await saveToFirebase();
  }
  
  // Start remote sync polling (auto-pauses when panel is hidden)
  startSync();
};

// Check if an action is completed
export const isComplete = (stageIdx, actionIdx) => {
  const actionKey = `${stageIdx}:${actionIdx}`;
  return currentProgress.completed.includes(actionKey);
};

// Mark action as completed - IMMEDIATE DUAL WRITE
export const markComplete = async (stageIdx, actionIdx) => {
  // Auto-init if context changed
  if (hasContextChanged() || !currentProgress.isLoaded) {
    log('🔄 Context changed, re-initializing...');
    await init();
  }
  
  if (!currentProgress.profileId || !currentProgress.subscriberId || !currentProgress.scriptId) {
    logError('❌ Cannot mark complete - no valid context');
    return false;
  }
  
  const actionKey = `${stageIdx}:${actionIdx}`;
  
  // Already completed?
  if (currentProgress.completed.includes(actionKey)) {
    log('⏭️ Already completed:', actionKey);
    return true;
  }
  
  // Add to completed
  currentProgress.completed.push(actionKey);
  currentProgress.version++;
  currentProgress.lastUpdated = Date.now();
  
  log('═══════════════════════════════════════════');
  log(`✅ MARKED COMPLETE: ${actionKey}`);
  log(`📊 Total: ${currentProgress.completed.length} completed`);
  
  // IMMEDIATE DUAL WRITE - Save to BOTH immediately
  const [localResult, firebaseResult] = await Promise.all([
    saveToLocal(),
    saveToFirebase()
  ]);
  
  log('💾 Local:', localResult ? '✅' : '❌', '| Firebase:', firebaseResult ? '✅' : '❌');
  log('═══════════════════════════════════════════');
  
  // AUTO-CHECK: Is script now 100% complete?
  // SAFEGUARD: Only auto-block if at least 3 actions completed
  const stats = getStats();
  const MINIMUM_ACTIONS_FOR_COMPLETE = 3;
  if (stats.total > 0 && 
      stats.completed >= stats.total && 
      stats.completed >= MINIMUM_ACTIONS_FOR_COMPLETE && 
      stats.total >= MINIMUM_ACTIONS_FOR_COMPLETE) {
    log('🎉 SCRIPT 100% COMPLETE!');
    log(`✅ Safeguard passed: ${stats.completed}/${stats.total} >= ${MINIMUM_ACTIONS_FOR_COMPLETE}`);
    setTimeout(() => markScriptFinished(), 500);
  } else if (stats.total > 0 && stats.completed >= stats.total) {
    log(`⚠️ Script appears complete (${stats.completed}/${stats.total}) but SAFEGUARD BLOCKED`);
    log(`🔄 Not auto-blocking because completed < ${MINIMUM_ACTIONS_FOR_COMPLETE}`);
  }
  
  return true;
};

// Mark action as incomplete (manual uncheck only)
export const markIncomplete = async (stageIdx, actionIdx) => {
  const actionKey = `${stageIdx}:${actionIdx}`;
  
  const idx = currentProgress.completed.indexOf(actionKey);
  if (idx === -1) {
    log('⚠️ Not in completed list:', actionKey);
    return false;
  }
  
  currentProgress.completed.splice(idx, 1);
  currentProgress.version++;
  currentProgress.lastUpdated = Date.now();
  
  log(`❌ Marked incomplete: ${actionKey} | Total: ${currentProgress.completed.length}`);
  
  // Immediate dual write
  await Promise.all([saveToLocal(), saveToFirebase()]);
  
  return true;
};

// Toggle action completion
export const toggle = async (stageIdx, actionIdx) => {
  if (isComplete(stageIdx, actionIdx)) {
    return markIncomplete(stageIdx, actionIdx);
  } else {
    return markComplete(stageIdx, actionIdx);
  }
};

// Get progress stats
export const getStats = () => {
  const currentScript = Store.get('currentScript');
  if (!currentScript?.stages) return { completed: 0, total: 0, percent: 0 };
  
  let total = 0;
  currentScript.stages.forEach(stage => {
    const actions = stage.actions || stage.messages || [];
    total += actions.length;
  });
  
  const completed = currentProgress.completed?.length || 0;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  
  return { completed, total, percent };
};

// Get all completed actions
export const getCompleted = () => [...currentProgress.completed];

// Get current incomplete action
export const getCurrentAction = () => {
  const currentScript = Store.get('currentScript');
  if (!currentScript?.stages) return null;
  
  for (let stageIdx = 0; stageIdx < currentScript.stages.length; stageIdx++) {
    const stage = currentScript.stages[stageIdx];
    const actions = stage.actions || stage.messages || [];
    
    for (let actionIdx = 0; actionIdx < actions.length; actionIdx++) {
      if (!isComplete(stageIdx, actionIdx)) {
        return {
          stageIdx,
          actionIdx,
          action: actions[actionIdx],
          goal: actions[actionIdx].goal || actions[actionIdx].text || '',
          stageName: stage.name
        };
      }
    }
  }
  
  return null; // All complete
};

// Check if script is 100% complete
export const isScriptComplete = () => {
  const stats = getStats();
  return stats.total > 0 && stats.completed === stats.total;
};

// Get current section index (for renderer)
export const getCurrentSectionIndex = () => {
  const currentScript = Store.get('currentScript');
  if (!currentScript?.stages) return 0;
  
  for (let stageIdx = 0; stageIdx < currentScript.stages.length; stageIdx++) {
    const stage = currentScript.stages[stageIdx];
    const actions = stage.actions || stage.messages || [];
    
    for (let actionIdx = 0; actionIdx < actions.length; actionIdx++) {
      if (!isComplete(stageIdx, actionIdx)) {
        return stageIdx;
      }
    }
  }
  
  return currentScript.stages.length - 1;
};

// ============================================================
// BLOCK LIST FUNCTIONS
// ============================================================

let blockListCache = {
  profileId: null,
  blockedIds: [],
  lastFetch: 0
};
const CACHE_TTL = 60000;

export const getBlockList = async (forceRefresh = false) => {
  const profileId = Store.get('currentProfile')?.id;
  if (!profileId) return [];
  
  if (!forceRefresh && 
      blockListCache.profileId === profileId && 
      Date.now() - blockListCache.lastFetch < CACHE_TTL) {
    return blockListCache.blockedIds;
  }
  
  try {
    const result = await API.getBlockedUsers(profileId);
    if (result.success) {
      blockListCache = {
        profileId,
        blockedIds: result.blockedIds || [],
        lastFetch: Date.now()
      };
      return blockListCache.blockedIds;
    }
  } catch (error) {
    logError('Error fetching block list:', error);
  }
  
  return blockListCache.blockedIds;
};

export const isSubscriberBlocked = async (subscriberId) => {
  const blockList = await getBlockList();
  const subIdStr = subscriberId?.toString();
  const rawId = subIdStr?.replace(/^tg:/, '') || '';
  const prefixedId = subIdStr?.startsWith('tg:') ? subIdStr : `tg:${subIdStr}`;
  
  return blockList.includes(subIdStr) || 
         blockList.includes(rawId) || 
         blockList.includes(prefixedId);
};

export const addToBlockList = async (subscriberId, subscriberName = null) => {
  const profileId = Store.get('currentProfile')?.id;
  if (!profileId || !subscriberId) return false;
  
  try {
    const result = await API.addBlockedUser({
      profileId,
      subscriberId: subscriberId.toString(),
      subscriberName: subscriberName || 'Unknown',
      reason: 'script_complete'
    });
    
    if (result.success) {
      if (!blockListCache.blockedIds.includes(subscriberId.toString())) {
        blockListCache.blockedIds.push(subscriberId.toString());
      }
      log('✅ Added to block list:', subscriberName || subscriberId);
      return true;
    }
  } catch (error) {
    logError('Error adding to block list:', error);
  }
  return false;
};

export const removeFromBlockList = async (subscriberId) => {
  const profileId = Store.get('currentProfile')?.id;
  if (!profileId || !subscriberId) return false;
  
  try {
    const result = await API.removeBlockedUser({
      profileId,
      subscriberId: subscriberId.toString()
    });
    
    if (result.success) {
      const idx = blockListCache.blockedIds.indexOf(subscriberId.toString());
      if (idx !== -1) blockListCache.blockedIds.splice(idx, 1);
      return true;
    }
  } catch (error) {
    logError('Error removing from block list:', error);
  }
  return false;
};

export const markScriptFinished = async () => {
  if (!isScriptComplete()) return false;
  
  const subscriberId = Store.get('currentSubscriberId');
  const subscriberName = Store.get('storedChat')?.subscriberName;
  const profileId = Store.get('currentProfile')?.id;
  
  log('🏁 Script complete! Adding to block list...');
  await addToBlockList(subscriberId, subscriberName);
  
  // Notify background
  if (profileId && subscriberId) {
    try {
      await chrome.runtime.sendMessage({
        type: 'AUTOCHAT_USER_BLOCKED',
        data: { profileId, subscriberId: subscriberId.toString(), subscriberName }
      });
    } catch (e) { /* ignore */ }
  }
  
  return true;
};

// ============================================================
// REMOTE SYNC (Multi-user real-time progress sharing)
// Polls Firebase periodically and merges if the other user
// has made progress we don't have yet.
// ============================================================

// Set callback for when remote progress is detected (triggers UI re-render)
export const setOnRemoteUpdate = (callback) => {
  _onRemoteUpdate = callback;
};

// Fetch from Firebase and merge — returns true if new progress was found
const syncFromRemote = async () => {
  if (!currentProgress.isLoaded || !currentProgress.profileId) return false;
  
  const { profileId, subscriberId, scriptId } = currentProgress;
  if (!profileId || !subscriberId || !scriptId) return false;
  
  try {
    const remoteData = await loadFromFirebase(profileId, subscriberId, scriptId);
    if (!remoteData?.completed) return false;
    
    const localSet = new Set(currentProgress.completed);
    const remoteSet = new Set(remoteData.completed);
    
    // Find actions that exist in remote but not local
    const newFromRemote = remoteData.completed.filter(key => !localSet.has(key));
    
    if (newFromRemote.length === 0) return false; // No new progress
    
    // MERGE: union of both (never lose progress)
    const merged = [...new Set([...currentProgress.completed, ...remoteData.completed])];
    
    log('═══════════════════════════════════════════');
    log('🔄 REMOTE SYNC: Found', newFromRemote.length, 'new action(s) from another user');
    log('   New:', newFromRemote.join(', '));
    log('   Local:', currentProgress.completed.length, '→ Merged:', merged.length);
    log('═══════════════════════════════════════════');
    
    // Update in-memory state
    currentProgress.completed = merged;
    currentProgress.version = Math.max(currentProgress.version, remoteData.version || 0) + 1;
    currentProgress.lastUpdated = Date.now();
    
    // Save merged state to local storage (so it persists)
    await saveToLocal();
    
    // Notify UI to re-render
    if (_onRemoteUpdate) {
      log('🔔 Triggering UI re-render from remote sync');
      _onRemoteUpdate();
    }
    
    return true;
  } catch (error) {
    // Don't spam errors — sync failures are non-critical
    if (!syncFromRemote._lastErrorLog || Date.now() - syncFromRemote._lastErrorLog > 60000) {
      logError('Remote sync error:', error.message);
      syncFromRemote._lastErrorLog = Date.now();
    }
    return false;
  }
};

// Start periodic remote sync polling
export const startSync = () => {
  if (syncInterval) return; // Already running
  
  log('🔄 Starting remote sync (every', SYNC_INTERVAL_MS / 1000, 'seconds)');
  syncInterval = setInterval(syncFromRemote, SYNC_INTERVAL_MS);
  
  // Also do an immediate sync
  syncFromRemote();
};

// Stop periodic remote sync polling
export const stopSync = () => {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    log('⏹️ Stopped remote sync');
  }
};

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

// Force immediate save (call before page unload)
export const flush = async () => {
  if (!currentProgress.isLoaded) return;
  await Promise.all([saveToLocal(), saveToFirebase()]);
  log('💾 Flushed progress');
};

// Clear progress (manual reset)
export const clear = async () => {
  currentProgress.completed = [];
  currentProgress.version++;
  await Promise.all([saveToLocal(), saveToFirebase()]);
  log('🗑️ Progress cleared');
};

// Reset state (call on chat/script change)
export const reset = async () => {
  await flush();
  currentProgress = {
    profileId: null,
    subscriberId: null,
    scriptId: null,
    scriptName: null,
    completed: [],
    version: 0,
    lastUpdated: null,
    isLoaded: false
  };
  lastContext = { profileId: null, subscriberId: null, scriptId: null };
};

// ============================================================
// AUTO-INIT TRIGGERS
// ============================================================

// Watch for visibility changes (handles extension open/close)
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      log('👁️ Panel visible - checking for context changes');
      if (hasContextChanged()) {
        init(true); // Force reload
      }
      // Resume remote sync polling when panel is visible
      startSync();
    } else if (document.visibilityState === 'hidden') {
      log('👁️ Panel hidden - flushing & stopping sync...');
      flush();
      // Pause remote sync to save bandwidth when panel is hidden
      stopSync();
    }
  });
  
  // Handle beforeunload
  window.addEventListener('beforeunload', () => {
    log('⚠️ beforeunload - flushing...');
    // Can't await, but try sync save
    if (currentProgress.isLoaded && currentProgress.completed.length > 0) {
      const key = getLocalStorageKey(
        currentProgress.profileId,
        currentProgress.subscriberId,
        currentProgress.scriptId
      );
      chrome.storage.local.set({
        [key]: {
          completed: currentProgress.completed,
          version: currentProgress.version,
          lastUpdated: Date.now()
        }
      });
    }
  });
}

// Watch Store for context changes
Store.subscribe('currentSubscriberId', () => {
  log('📢 Subscriber changed, will re-init on next operation');
  currentProgress.isLoaded = false;
});

Store.subscribe('currentScript', () => {
  log('📢 Script changed, will re-init on next operation');
  currentProgress.isLoaded = false;
});

// ============================================================
// EXPORT
// ============================================================

export default {
  init,
  isComplete,
  markComplete,
  markIncomplete,
  toggle,
  getStats,
  getCompleted,
  getCurrentAction,
  getCurrentSectionIndex,
  flush,
  clear,
  reset,
  isScriptComplete,
  getBlockList,
  isSubscriberBlocked,
  addToBlockList,
  removeFromBlockList,
  markScriptFinished,
  // Multi-user sync
  setOnRemoteUpdate,
  startSync,
  stopSync
};
