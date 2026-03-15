// ============================================================
// AUTO-CHAT ONLYFANS - Background Script
// Separate from Telegram - handles OF-specific auto-chat logic
// ============================================================

import { API } from './api.js';

// ============================================================
// STATE
// ============================================================

export const OFAutoChatState = {
  enabled: false,
  autoSendEnabled: false,    // false = queue-only (pre-generate but don't auto-send)
  maxActiveChats: 5,
  waitTimeMinutes: 1,        // Wait 1 minute after their last message
  pollIntervalMs: 1000,      // Poll chat list every 1 second for fast detection
  
  // Active pool of chats being processed
  activePool: new Map(),     // peerId -> ChatState
  
  // Message cache for context (Feature 3)
  messageCache: new Map(),   // peerId -> { messages, lastFetched }
  messageCacheTTL: 30000,    // 30 seconds cache TTL
  
  // Response history for smart wait (Feature 4)
  responseHistory: new Map(), // peerId -> { avgResponseTime, messageCount, lastResponseTime }
  
  // Error tracking (Feature 6)
  errorLog: [],              // Array of { peerId, error, timestamp }
  maxErrorLogSize: 50,
  
  // Alarm settings (Feature 7)
  alarmMuted: false,
  alarmIntervalMs: 10000,    // Alarm every 10 seconds when there are ready responses
  lastAlarmTime: 0,
  
  // Stats
  stats: {
    today: { generated: 0, sent: 0, errors: 0, retries: 0 }
  },
  
  // Profile context
  currentProfileId: null,
  blockedUsers: [],
  
  // Track chats we've already responded to (prevents re-generating for read messages)
  // Cleared for a peerId only when a genuinely NEW message arrives
  respondedChats: new Set()   // Set of peerIds we've sent responses to
};

// Alarm interval reference
let alarmInterval = null;

// Retry configuration (Feature 6)
const RETRY_CONFIG = {
  maxRetries: 3,
  delays: [5000, 15000, 30000], // 5s, 15s, 30s
  retryingChats: new Map()      // peerId -> { attempts, lastAttempt }
};

// Sending lock - prevent processing next chat while one is actively sending
let sendingLock = {
  isLocked: false,
  lockedPeerId: null,
  lockedAt: null,
  maxLockTimeMs: 60000 // Auto-release lock after 60 seconds (safety)
};

// Lock the sending process
function acquireSendingLock(peerId) {
  // Check if lock is stale (> 60 seconds)
  if (sendingLock.isLocked && sendingLock.lockedAt) {
    const lockAge = Date.now() - sendingLock.lockedAt;
    if (lockAge > sendingLock.maxLockTimeMs) {
      console.log(`[OF-AutoChat] 🔓 Force releasing stale sending lock (${Math.round(lockAge / 1000)}s old)`);
      sendingLock.isLocked = false;
      sendingLock.lockedPeerId = null;
    }
  }
  
  if (sendingLock.isLocked) {
    console.log(`[OF-AutoChat] 🔒 Sending lock held by ${sendingLock.lockedPeerId}, cannot acquire`);
    return false;
  }
  
  sendingLock.isLocked = true;
  sendingLock.lockedPeerId = peerId;
  sendingLock.lockedAt = Date.now();
  console.log(`[OF-AutoChat] 🔐 Sending lock acquired for ${peerId}`);
  return true;
}

// Release the sending lock
function releaseSendingLock(peerId) {
  if (sendingLock.lockedPeerId === peerId || !sendingLock.lockedPeerId) {
    sendingLock.isLocked = false;
    sendingLock.lockedPeerId = null;
    sendingLock.lockedAt = null;
    console.log(`[OF-AutoChat] 🔓 Sending lock released`);
    return true;
  }
  console.log(`[OF-AutoChat] ⚠️ Cannot release lock - held by different peer`);
  return false;
}

// Chat state structure
function createChatState(peerId, subscriberName) {
  return {
    peerId,
    subscriberName,
    status: 'waiting',       // waiting | generating | ready | sending | sent | error
    lastTheirMessageAt: null,
    lastOurMessageAt: null,
    waitingUntil: null,      // Timestamp when we can generate (1 min after their msg)
    generatedResponse: null,
    scriptId: null,
    scriptProgress: null,
    error: null,
    addedAt: Date.now(),
    // Message buffer - accumulates new messages during wait period
    messageBuffer: [],       // Array of { text, timestamp } - all messages since last response
    messageCount: 0          // Total count of messages accumulated
  };
}

// ============================================================
// POLLING & MONITORING
// ============================================================

let pollInterval = null;

// Start monitoring OnlyFans chats
export function startOFAutoChat() {
  if (pollInterval) return;
  
  console.log('[OF-AutoChat] Starting monitoring...');
  OFAutoChatState.enabled = true;
  
  // Initial scan
  scanAndUpdatePool();
  
  // Start polling
  pollInterval = setInterval(() => {
    if (OFAutoChatState.enabled) {
      scanAndUpdatePool();
      processTimers();
    }
  }, OFAutoChatState.pollIntervalMs);
  
  notifyStateChange();
}

// Stop monitoring
export function stopOFAutoChat() {
  console.log('[OF-AutoChat] Stopping monitoring...');
  OFAutoChatState.enabled = false;
  
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  
  notifyStateChange();
}

// Scan chat list and update active pool
async function scanAndUpdatePool() {
  const tabs = await chrome.tabs.query({ url: '*://onlyfans.com/*' });
  if (tabs.length === 0) {
    console.log('[OF-AutoChat] No OnlyFans tab found');
    return;
  }
  
  try {
    // Request chat list from content script
    const result = await chrome.tabs.sendMessage(tabs[0].id, { 
      type: 'GET_CHAT_LIST_WITH_TIMESTAMPS' 
    });
    
    if (!result?.success || !result.chats) {
      console.log('[OF-AutoChat] No chats received');
      return;
    }
    
    const chats = result.chats;
    console.log(`[OF-AutoChat] Scanned ${chats.length} chats`);
    
    // Filter: Only UNREAD chats where their message is last AND we haven't already responded
    const needsReply = chats.filter(chat => {
      const peerId = `of:${chat.rawId}`;
      // Must have unread indicator in DOM (primary signal)
      if (!chat.hasUnread) return false;
      // Must be their message last (not ours)
      if (!chat.isTheirMessageLast) return false;
      // Must not be blocked
      if (isUserBlocked(chat.rawId)) return false;
      // Must not be a chat we already responded to (unless new message clears it)
      if (OFAutoChatState.respondedChats.has(peerId)) return false;
      return true;
    });
    
    console.log(`[OF-AutoChat] ${needsReply.length} unread chats need reply`);
    
    // Take top N based on slider setting
    const topN = needsReply.slice(0, OFAutoChatState.maxActiveChats);
    
    // Update active pool
    for (const chat of topN) {
      const peerId = `of:${chat.rawId}`;
      
      if (OFAutoChatState.activePool.has(peerId)) {
        // Update existing
        const existing = OFAutoChatState.activePool.get(peerId);
        
        // Check if new message came in
        if (chat.lastMessageTimestamp && chat.lastMessageTimestamp > existing.lastTheirMessageAt) {
          existing.lastTheirMessageAt = chat.lastMessageTimestamp;
          existing.waitingUntil = chat.lastMessageTimestamp + (OFAutoChatState.waitTimeMinutes * 60 * 1000);
          existing.status = 'waiting';
          existing.generatedResponse = null; // Clear old response
          // New message = clear responded flag
          OFAutoChatState.respondedChats.delete(peerId);
          console.log(`[OF-AutoChat] New message from ${chat.subscriberName}, resetting timer`);
        }
      } else {
        // Add new
        const newChat = createChatState(peerId, chat.subscriberName);
        newChat.lastTheirMessageAt = chat.lastMessageTimestamp || Date.now();
        newChat.waitingUntil = newChat.lastTheirMessageAt + (OFAutoChatState.waitTimeMinutes * 60 * 1000);
        OFAutoChatState.activePool.set(peerId, newChat);
        console.log(`[OF-AutoChat] Added ${chat.subscriberName} to pool, waiting until ${new Date(newChat.waitingUntil).toLocaleTimeString()}`);
      }
    }
    
    // Remove chats that are no longer in top N or don't need reply
    const currentPeerIds = new Set(topN.map(c => `of:${c.rawId}`));
    for (const [peerId, chat] of OFAutoChatState.activePool) {
      if (!currentPeerIds.has(peerId) && chat.status !== 'ready' && chat.status !== 'generating') {
        OFAutoChatState.activePool.delete(peerId);
        console.log(`[OF-AutoChat] Removed ${chat.subscriberName} from pool (no longer needs reply)`);
      }
    }
    
    notifyStateChange();
    
  } catch (error) {
    console.error('[OF-AutoChat] Error scanning chats:', error);
  }
}

// Process timers - trigger pre-generation early + handle timer expiry
function processTimers() {
  const now = Date.now();
  
  for (const [peerId, chat] of OFAutoChatState.activePool) {
    // Skip non-waiting chats
    if (chat.status !== 'waiting') continue;
    if (!chat.waitingUntil) continue;
    
    const totalWaitMs = OFAutoChatState.waitTimeMinutes * 60 * 1000;
    const elapsed = now - (chat.waitingUntil - totalWaitMs);
    const halfWay = totalWaitMs * 0.5;
    
    // === EARLY PRE-GENERATION: Start at 50% of wait time ===
    // Generate in background so response is ready when timer expires
    if (elapsed >= halfWay && !chat.generatedResponse && chat.status === 'waiting') {
      startEarlyGeneration(peerId);
    }
    
    // === TIMER EXPIRED: Response should be ready now ===
    if (now >= chat.waitingUntil) {
      if (chat.generatedResponse) {
        // Response already pre-generated — mark as ready
        chat.status = 'ready';
        console.log(`[OF-AutoChat] ✅ Timer expired + response ready for ${chat.subscriberName}`);
        
        // Auto-send only if autoSendEnabled
        if (OFAutoChatState.autoSendEnabled) {
          console.log(`[OF-AutoChat] 📤 Auto-sending to ${chat.subscriberName}...`);
          sendMessage(peerId);
        }
      } else if (chat.status === 'waiting') {
        // Timer expired but no response yet — generate now
        console.log(`[OF-AutoChat] Timer expired for ${chat.subscriberName}, generating now`);
        triggerGeneration(peerId);
      }
    }
  }
  
  // Also: transition pre-generated chats to 'ready' when their timer expires
  for (const [peerId, chat] of OFAutoChatState.activePool) {
    if (chat.status === 'ready' && chat.generatedResponse && OFAutoChatState.autoSendEnabled) {
      // Auto-send if autoSend is on and not already sending
      if (chat.status === 'ready') {
        // Already handled above, but double-check
      }
    }
  }
  
  // Process retry queue (Feature 6)
  processRetryQueue();
}

// ============================================================
// PUSH UPDATE HANDLER - Receive updates from content script
// ============================================================

export function handleChatListPush(chats) {
  if (!chats || !Array.isArray(chats)) {
    return;
  }
  
  // Always update global notification count (even if auto-chat is disabled)
  const unreadCount = chats.filter(chat => chat.hasUnread).length;
  chrome.runtime.sendMessage({
    type: 'UNREAD_COUNT_UPDATE',
    data: { count: unreadCount }
  }).catch(() => {});
  
  // Only process for auto-chat if enabled
  if (!OFAutoChatState.enabled) return;
  
  console.log(`[OF-AutoChat] 📥 Push update received: ${chats.length} chats`);
  
  // Filter: Only UNREAD chats where their message is last AND we haven't already responded
  const needsReply = chats.filter(chat => {
    const peerId = `of:${chat.rawId}`;
    if (!chat.hasUnread) return false;
    if (!chat.isTheirMessageLast) return false;
    if (isUserBlocked(chat.rawId)) return false;
    if (OFAutoChatState.respondedChats.has(peerId)) return false;
    return true;
  });
  
  console.log(`[OF-AutoChat] ${needsReply.length} unread chats need reply`);
  
  // Take top N based on slider setting
  const topN = needsReply.slice(0, OFAutoChatState.maxActiveChats);
  
  // Update active pool
  for (const chat of topN) {
    const peerId = `of:${chat.rawId}`;
    const now = Date.now();
    
    if (OFAutoChatState.activePool.has(peerId)) {
      // Update existing
      const existing = OFAutoChatState.activePool.get(peerId);
      
      // Check if new message came in (timestamp is newer than last known)
      if (chat.lastMessageTimestamp && chat.lastMessageTimestamp > existing.lastTheirMessageAt) {
        // Update response history for smart wait (Feature 4)
        updateResponseHistory(peerId, existing.lastOurMessageAt, chat.lastMessageTimestamp);
        
        // ===== MESSAGE ACCUMULATION =====
        // Add the new message to the buffer
        existing.messageBuffer.push({
          text: chat.lastMessagePreview || '',
          timestamp: chat.lastMessageTimestamp
        });
        existing.messageCount++;
        
        // Update last message timestamp
        existing.lastTheirMessageAt = chat.lastMessageTimestamp;
        
        // ALWAYS reset the timer on each new message (wait 1 min from NOW)
        const waitMs = OFAutoChatState.waitTimeMinutes * 60 * 1000;
        existing.waitingUntil = now + waitMs;
        
        // If we were generating/ready, go back to waiting (new message invalidates old response)
        if (existing.status === 'generating' || existing.status === 'pre_generating' || existing.status === 'ready') {
          existing.generatedResponse = null; // Clear old response - need to regenerate
        }
        existing.status = 'waiting';
        
        // New message = clear responded flag so we can re-generate
        OFAutoChatState.respondedChats.delete(peerId);
        
        // Invalidate message cache (Feature 3)
        OFAutoChatState.messageCache.delete(peerId);
        
        const timeUntil = new Date(existing.waitingUntil).toLocaleTimeString();
        console.log(`[OF-AutoChat] 📨 New message #${existing.messageCount} from ${chat.subscriberName}, timer reset → ${timeUntil}`);
      }
    } else {
      // Add new chat to pool
      const newChat = createChatState(peerId, chat.subscriberName);
      newChat.lastTheirMessageAt = chat.lastMessageTimestamp || now;
      
      // Start waiting from NOW (not from message timestamp - they may have sent it a while ago)
      const waitMs = OFAutoChatState.waitTimeMinutes * 60 * 1000;
      newChat.waitingUntil = now + waitMs;
      
      // Add first message to buffer
      if (chat.lastMessagePreview) {
        newChat.messageBuffer.push({
          text: chat.lastMessagePreview,
          timestamp: chat.lastMessageTimestamp || now
        });
        newChat.messageCount = 1;
      }
      
      OFAutoChatState.activePool.set(peerId, newChat);
      console.log(`[OF-AutoChat] ➕ Added ${chat.subscriberName} to pool, waiting until ${new Date(newChat.waitingUntil).toLocaleTimeString()}`);
    }
  }
  
  // Remove chats that are no longer in top N or don't need reply
  const currentPeerIds = new Set(topN.map(c => `of:${c.rawId}`));
  for (const [peerId, chat] of OFAutoChatState.activePool) {
    if (!currentPeerIds.has(peerId) && chat.status !== 'ready' && chat.status !== 'generating' && chat.status !== 'pre_generating') {
      OFAutoChatState.activePool.delete(peerId);
      console.log(`[OF-AutoChat] ➖ Removed ${chat.subscriberName} from pool (no longer needs reply)`);
    }
  }
  
  notifyStateChange();
}

// ============================================================
// SMART WAIT TIME (Feature 4)
// ============================================================

function calculateSmartWaitTime(peerId, chat) {
  const baseWaitMs = OFAutoChatState.waitTimeMinutes * 60 * 1000;
  let multiplier = 1.0;
  
  // Check response history
  const history = OFAutoChatState.responseHistory.get(peerId);
  if (history && history.avgResponseTime) {
    // Fast responder (< 60s avg) = shorter wait
    if (history.avgResponseTime < 60000) {
      multiplier = 0.5;
      console.log(`[OF-AutoChat] Fast responder detected for ${chat?.subscriberName}, reducing wait`);
    }
    // Slow responder (> 5min avg) = longer wait
    else if (history.avgResponseTime > 300000) {
      multiplier = 1.5;
    }
  }
  
  // Check message length (longer message = more "reading" time)
  if (chat?.lastMessagePreview && chat.lastMessagePreview.length > 200) {
    multiplier += 0.3;
  }
  
  // Late night check (11pm - 7am) = longer wait
  const hour = new Date().getHours();
  if (hour >= 23 || hour < 7) {
    multiplier += 0.5;
    console.log(`[OF-AutoChat] Late night, increasing wait time`);
  }
  
  return Math.round(baseWaitMs * multiplier);
}

function updateResponseHistory(peerId, ourMessageTime, theirResponseTime) {
  if (!ourMessageTime || !theirResponseTime) return;
  
  const responseTime = theirResponseTime - ourMessageTime;
  if (responseTime < 0 || responseTime > 24 * 60 * 60 * 1000) return; // Invalid or > 24h
  
  const history = OFAutoChatState.responseHistory.get(peerId) || {
    avgResponseTime: 0,
    messageCount: 0,
    lastResponseTime: 0
  };
  
  // Rolling average
  history.avgResponseTime = history.messageCount > 0
    ? (history.avgResponseTime * history.messageCount + responseTime) / (history.messageCount + 1)
    : responseTime;
  history.messageCount++;
  history.lastResponseTime = theirResponseTime;
  
  OFAutoChatState.responseHistory.set(peerId, history);
  console.log(`[OF-AutoChat] Updated response history for ${peerId}: avg ${Math.round(history.avgResponseTime / 1000)}s`);
}

// ============================================================
// BATCH PRE-GENERATION (Feature 2)
// ============================================================

function startEarlyGeneration(peerId) {
  const chat = OFAutoChatState.activePool.get(peerId);
  if (!chat || chat.status !== 'waiting') return;
  
  // Don't start if already has a response or is generating
  if (chat.generatedResponse || chat.status === 'generating' || chat.status === 'pre_generating') {
    return;
  }
  
  console.log(`[OF-AutoChat] 🚀 Starting early generation for ${chat.subscriberName}`);
  chat.status = 'pre_generating';
  notifyStateChange();
  
  // Trigger generation in background
  chrome.runtime.sendMessage({
    type: 'OF_AUTOCHAT_TRIGGER_GENERATION',
    data: {
      peerId,
      subscriberName: chat.subscriberName,
      isEarlyGeneration: true
    }
  }).catch(() => {});
}

// Modified generation result handler to support pre-generation and action tracking
export function handleGenerationResult(peerId, success, response, error, actionInfo = null) {
  const chat = OFAutoChatState.activePool.get(peerId);
  if (!chat) return;
  
  if (success && response) {
    chat.generatedResponse = response;
    chat.actionInfo = actionInfo; // Store action info for progress marking after send
    chat.error = null;
    OFAutoChatState.stats.today.generated++;
    
    // Check if timer has already expired
    const now = Date.now();
    if (chat.waitingUntil && now >= chat.waitingUntil) {
      chat.status = 'ready';
      console.log(`[OF-AutoChat] ✅ Response ready (timer already expired) for ${chat.subscriberName}`);
    } else {
      // Response is ready but timer hasn't expired yet
      chat.status = 'waiting'; // Stay in waiting, but with response cached
      const timeLeft = Math.round((chat.waitingUntil - now) / 1000);
      console.log(`[OF-AutoChat] 📦 Response pre-generated for ${chat.subscriberName}, ${timeLeft}s until ready`);
    }
    
    if (actionInfo) {
      console.log(`[OF-AutoChat] 📋 Action info stored: stage ${actionInfo.stageIdx}, action ${actionInfo.actionIdx}`);
    }
    
    // Clear retry state on success
    RETRY_CONFIG.retryingChats.delete(peerId);
  } else {
    // Handle error with retry logic (Feature 6)
    handleGenerationError(peerId, error || 'Generation failed');
  }
  
  notifyStateChange();
}

// ============================================================
// ERROR RECOVERY WITH RETRY (Feature 6)
// ============================================================

function handleGenerationError(peerId, error) {
  const chat = OFAutoChatState.activePool.get(peerId);
  if (!chat) return;
  
  // Log the error
  logError(peerId, error);
  
  // Get or create retry state
  let retryState = RETRY_CONFIG.retryingChats.get(peerId);
  if (!retryState) {
    retryState = { attempts: 0, lastAttempt: 0 };
    RETRY_CONFIG.retryingChats.set(peerId, retryState);
  }
  
  retryState.attempts++;
  retryState.lastAttempt = Date.now();
  
  if (retryState.attempts <= RETRY_CONFIG.maxRetries) {
    const delay = RETRY_CONFIG.delays[retryState.attempts - 1] || RETRY_CONFIG.delays[RETRY_CONFIG.delays.length - 1];
    chat.status = 'retrying';
    chat.error = `Retry ${retryState.attempts}/${RETRY_CONFIG.maxRetries} in ${delay / 1000}s`;
    OFAutoChatState.stats.today.retries++;
    
    console.log(`[OF-AutoChat] ⚠️ Error for ${chat.subscriberName}, scheduling retry ${retryState.attempts}/${RETRY_CONFIG.maxRetries} in ${delay / 1000}s`);
    
    // Schedule retry
    retryState.nextRetryAt = Date.now() + delay;
  } else {
    // Max retries reached
    chat.status = 'error';
    chat.error = `Failed after ${RETRY_CONFIG.maxRetries} retries: ${error}`;
    OFAutoChatState.stats.today.errors++;
    
    console.error(`[OF-AutoChat] ❌ Max retries reached for ${chat.subscriberName}:`, error);
    RETRY_CONFIG.retryingChats.delete(peerId);
  }
}

function processRetryQueue() {
  const now = Date.now();
  
  for (const [peerId, retryState] of RETRY_CONFIG.retryingChats) {
    if (retryState.nextRetryAt && now >= retryState.nextRetryAt) {
      const chat = OFAutoChatState.activePool.get(peerId);
      if (chat && (chat.status === 'retrying' || chat.status === 'error')) {
        console.log(`[OF-AutoChat] 🔄 Retrying generation for ${chat.subscriberName}`);
        retryState.nextRetryAt = null;
        triggerGeneration(peerId);
      }
    }
  }
}

function logError(peerId, error) {
  OFAutoChatState.errorLog.push({
    peerId,
    error,
    timestamp: Date.now()
  });
  
  // Keep log size bounded
  if (OFAutoChatState.errorLog.length > OFAutoChatState.maxErrorLogSize) {
    OFAutoChatState.errorLog.shift();
  }
}

// Manual retry function (exposed to UI)
export function retryChat(peerId) {
  const chat = OFAutoChatState.activePool.get(peerId);
  if (!chat) return { success: false, error: 'Chat not found' };
  
  // Reset retry state
  RETRY_CONFIG.retryingChats.delete(peerId);
  
  // Clear error and trigger generation
  chat.status = 'generating';
  chat.error = null;
  notifyStateChange();
  
  triggerGeneration(peerId);
  return { success: true };
}

// ============================================================
// MESSAGE CACHE (Feature 3)
// ============================================================

export function getCachedMessages(peerId) {
  const cached = OFAutoChatState.messageCache.get(peerId);
  if (cached && (Date.now() - cached.lastFetched) < OFAutoChatState.messageCacheTTL) {
    return cached.messages;
  }
  return null;
}

export function setCachedMessages(peerId, messages) {
  OFAutoChatState.messageCache.set(peerId, {
    messages,
    lastFetched: Date.now()
  });
}

export function invalidateMessageCache(peerId) {
  OFAutoChatState.messageCache.delete(peerId);
}

// ============================================================
// AI GENERATION
// ============================================================

async function triggerGeneration(peerId) {
  const chat = OFAutoChatState.activePool.get(peerId);
  if (!chat) return;
  
  // Update status
  chat.status = 'generating';
  notifyStateChange();
  
  // Prepare message buffer context for AI
  const recentMessages = chat.messageBuffer || [];
  const messageCount = chat.messageCount || 0;
  
  console.log(`[OF-AutoChat] Triggering generation for ${chat.subscriberName} with ${messageCount} accumulated messages`);
  
  // Send message to sidepanel to trigger generation
  chrome.runtime.sendMessage({
    type: 'OF_AUTOCHAT_TRIGGER_GENERATION',
    data: {
      peerId,
      subscriberName: chat.subscriberName,
      // Pass accumulated messages for comprehensive response
      messageBuffer: recentMessages,
      messageCount: messageCount
    }
  }).catch(() => {});
}

// ============================================================
// SEND MESSAGE
// ============================================================

// Send retry configuration
const SEND_RETRY_CONFIG = {
  maxRetries: 3,
  retryDelayMs: 2000,
  chatLoadTimeoutMs: 15000,  // Max 15 seconds to wait for chat load
  chatLoadPollMs: 500        // Poll every 500ms
};

// Wait for chat to be ready by polling content script
async function waitForChatLoad(tabId, timeoutMs = SEND_RETRY_CONFIG.chatLoadTimeoutMs) {
  const startTime = Date.now();
  const pollInterval = SEND_RETRY_CONFIG.chatLoadPollMs;
  
  console.log(`[OF-AutoChat] ⏳ Waiting for chat to load (max ${timeoutMs / 1000}s)...`);
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      // Ask content script if chat is ready
      const result = await chrome.tabs.sendMessage(tabId, { type: 'IS_CHAT_READY' });
      
      if (result?.ready) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`[OF-AutoChat] ✅ Chat loaded in ${elapsed}s`);
        return { success: true, elapsed };
      }
      
      // Log progress every 2 seconds
      const elapsed = Date.now() - startTime;
      if (elapsed > 0 && elapsed % 2000 < pollInterval) {
        console.log(`[OF-AutoChat] ⏳ Still waiting... (${Math.round(elapsed / 1000)}s)`);
      }
    } catch (error) {
      // Content script might not be ready yet, keep polling
      console.log(`[OF-AutoChat] ⏳ Content script not ready yet...`);
    }
    
    await new Promise(r => setTimeout(r, pollInterval));
  }
  
  console.log(`[OF-AutoChat] ⚠️ Chat load timeout after ${timeoutMs / 1000}s`);
  return { success: false, error: 'Timeout waiting for chat to load' };
}

export async function sendMessage(peerId) {
  const chat = OFAutoChatState.activePool.get(peerId);
  if (!chat || !chat.generatedResponse) {
    console.error('[OF-AutoChat] No response to send for', peerId);
    return { success: false, error: 'No response ready' };
  }
  
  // Acquire sending lock to prevent concurrent sends
  if (!acquireSendingLock(peerId)) {
    console.log(`[OF-AutoChat] ⏳ Another send in progress, queuing ${chat.subscriberName}`);
    return { success: false, error: 'Another send in progress' };
  }
  
  chat.status = 'sending';
  notifyStateChange();
  
  const tabs = await chrome.tabs.query({ url: '*://onlyfans.com/*' });
  if (tabs.length === 0) {
    releaseSendingLock(peerId);
    chat.status = 'error';
    chat.error = 'No OnlyFans tab found';
    notifyStateChange();
    return { success: false, error: 'No OnlyFans tab found' };
  }
  
  const tabId = tabs[0].id;
  let lastError = null;
  
  // Retry loop for sending
  for (let attempt = 1; attempt <= SEND_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      // Extract raw ID from peerId (remove "of:" prefix)
      const rawId = peerId.replace(/^of:/, '');
      
      // Step 1: Navigate to the chat
      console.log(`[OF-AutoChat] 📂 Opening chat for ${chat.subscriberName} (attempt ${attempt}/${SEND_RETRY_CONFIG.maxRetries})...`);
      await chrome.tabs.update(tabId, { 
        url: `https://onlyfans.com/my/chats/chat/${rawId}`,
        active: true 
      });
      
      // Step 2: Initial delay for navigation
      await new Promise(r => setTimeout(r, 2000));
      
      // Step 3: Wait for chat to actually load (polling)
      const loadResult = await waitForChatLoad(tabId);
      
      if (!loadResult.success) {
        // Try a fallback: just wait a bit longer
        console.log(`[OF-AutoChat] ⚠️ Chat load check failed, using fallback wait...`);
        await new Promise(r => setTimeout(r, 5000));
      }
      
      // Step 4: Verify chat input is available before sending
      const inputCheck = await chrome.tabs.sendMessage(tabId, { type: 'CHECK_CHAT_INPUT' }).catch(() => null);
      if (!inputCheck?.found) {
        console.log(`[OF-AutoChat] ⚠️ Chat input not found, waiting more...`);
        await new Promise(r => setTimeout(r, 3000));
      }
      
      // Step 5: Send the message
      console.log(`[OF-AutoChat] 📤 Sending message to ${chat.subscriberName}...`);
      const sendResult = await chrome.tabs.sendMessage(tabId, {
        type: 'SEND_MESSAGE',
        text: chat.generatedResponse
      });
      
      if (sendResult?.success) {
        // SUCCESS!
        chat.status = 'sent';
        chat.lastOurMessageAt = Date.now();
        OFAutoChatState.stats.today.sent++;
        
        // Clear message buffer after successful send
        chat.messageBuffer = [];
        chat.messageCount = 0;
        
        // Track this chat as responded — prevents re-generating until a new message arrives
        OFAutoChatState.respondedChats.add(peerId);
        
        console.log(`[OF-AutoChat] ✅ Message sent to ${chat.subscriberName}!`);
        
        // Mark script progress after successful send
        if (chat.actionInfo && chat.actionInfo.stageIdx !== undefined && chat.actionInfo.actionIdx !== undefined) {
          console.log(`[OF-AutoChat] 📋 Marking progress: stage ${chat.actionInfo.stageIdx}, action ${chat.actionInfo.actionIdx}`);
          
          chrome.runtime.sendMessage({
            type: 'OF_AUTOCHAT_MARK_PROGRESS',
            data: {
              peerId,
              subscriberName: chat.subscriberName,
              profileId: OFAutoChatState.currentProfileId,
              stageIdx: chat.actionInfo.stageIdx,
              actionIdx: chat.actionInfo.actionIdx,
              goal: chat.actionInfo.goal
            }
          }).catch((err) => {
            console.error('[OF-AutoChat] Error sending progress mark message:', err);
          });
        }
        
        // Release lock immediately
        releaseSendingLock(peerId);
        
        // Remove from pool after a delay
        setTimeout(() => {
          OFAutoChatState.activePool.delete(peerId);
          notifyStateChange();
        }, 3000);
        
        return { success: true };
      } else {
        lastError = sendResult?.error || 'Send failed';
        console.log(`[OF-AutoChat] ⚠️ Send attempt ${attempt} failed: ${lastError}`);
      }
      
    } catch (error) {
      lastError = error.message;
      console.error(`[OF-AutoChat] ❌ Send attempt ${attempt} error:`, error);
    }
    
    // Wait before retry (except after last attempt)
    if (attempt < SEND_RETRY_CONFIG.maxRetries) {
      console.log(`[OF-AutoChat] 🔄 Retrying in ${SEND_RETRY_CONFIG.retryDelayMs / 1000}s...`);
      await new Promise(r => setTimeout(r, SEND_RETRY_CONFIG.retryDelayMs));
    }
  }
  
  // All retries failed
  console.error(`[OF-AutoChat] ❌ All ${SEND_RETRY_CONFIG.maxRetries} send attempts failed for ${chat.subscriberName}`);
  releaseSendingLock(peerId);
  chat.status = 'error';
  chat.error = `Send failed after ${SEND_RETRY_CONFIG.maxRetries} retries: ${lastError}`;
  OFAutoChatState.stats.today.errors++;
  notifyStateChange();
  return { success: false, error: chat.error };
}

// ============================================================
// REGENERATE
// ============================================================

export function regenerateResponse(peerId) {
  const chat = OFAutoChatState.activePool.get(peerId);
  if (!chat) return;
  
  chat.status = 'generating';
  chat.generatedResponse = null;
  chat.error = null;
  notifyStateChange();
  
  triggerGeneration(peerId);
}

// ============================================================
// UPDATE RESPONSE (manual edit)
// ============================================================

export function updateResponse(peerId, newResponse) {
  const chat = OFAutoChatState.activePool.get(peerId);
  if (!chat) return;
  
  chat.generatedResponse = newResponse;
  chat.status = 'ready';
  notifyStateChange();
}

// ============================================================
// BLOCKED USERS
// ============================================================

export async function loadBlockedUsers(profileId) {
  if (!profileId) return;
  
  OFAutoChatState.currentProfileId = profileId;
  
  try {
    const result = await API.getBlockedUsers(profileId);
    if (result.success) {
      OFAutoChatState.blockedUsers = result.blockedIds || [];
      console.log(`[OF-AutoChat] Loaded ${OFAutoChatState.blockedUsers.length} blocked users`);
    }
  } catch (error) {
    console.error('[OF-AutoChat] Error loading blocked users:', error);
  }
}

function isUserBlocked(rawId) {
  if (!rawId) return false;
  
  const idStr = rawId.toString();
  const prefixed = `of:${idStr}`;
  
  return OFAutoChatState.blockedUsers.some(blocked => {
    const blockedStr = blocked?.toString();
    return blockedStr === idStr || blockedStr === prefixed || blockedStr?.replace(/^of:/, '') === idStr;
  });
}

// ============================================================
// STATE NOTIFICATIONS
// ============================================================

function notifyStateChange() {
  // Convert Map to array for transmission
  const poolArray = Array.from(OFAutoChatState.activePool.entries()).map(([peerId, chat]) => ({
    peerId,
    ...chat
  }));
  
  const readyCount = getReadyCount();
  
  chrome.runtime.sendMessage({
    type: 'OF_AUTOCHAT_STATE_CHANGED',
    data: {
      enabled: OFAutoChatState.enabled,
      autoSendEnabled: OFAutoChatState.autoSendEnabled,
      maxActiveChats: OFAutoChatState.maxActiveChats,
      activePool: poolArray,
      stats: OFAutoChatState.stats,
      alarmMuted: OFAutoChatState.alarmMuted,
      readyCount
    }
  }).catch(() => {});
  
  // Check if we should trigger alarm (Feature 7)
  checkAndTriggerAlarm();
}

// ============================================================
// SETTINGS
// ============================================================

export function setMaxActiveChats(count) {
  OFAutoChatState.maxActiveChats = Math.max(1, Math.min(10, count));
  console.log(`[OF-AutoChat] Max active chats set to ${OFAutoChatState.maxActiveChats}`);
  notifyStateChange();
  return OFAutoChatState.maxActiveChats;
}

export function setWaitTime(minutes) {
  OFAutoChatState.waitTimeMinutes = Math.max(0.5, Math.min(10, minutes));
  console.log(`[OF-AutoChat] Wait time set to ${OFAutoChatState.waitTimeMinutes} minutes`);
  return OFAutoChatState.waitTimeMinutes;
}

// ============================================================
// ALARM SYSTEM (Feature 7) - Alert for ready responses
// ============================================================

export function setAlarmMuted(muted) {
  OFAutoChatState.alarmMuted = muted;
  console.log(`[OF-AutoChat] Alarm ${muted ? 'muted 🔇' : 'unmuted 🔊'}`);
  
  // Save preference
  chrome.storage.local.set({ ofAutoChatAlarmMuted: muted }).catch(() => {});
  
  if (muted) {
    stopAlarmInterval();
  } else {
    startAlarmIntervalIfNeeded();
  }
  
  return muted;
}

export async function loadAlarmPreference() {
  try {
    const result = await chrome.storage.local.get('ofAutoChatAlarmMuted');
    OFAutoChatState.alarmMuted = result.ofAutoChatAlarmMuted === true;
    console.log(`[OF-AutoChat] Alarm preference loaded: ${OFAutoChatState.alarmMuted ? 'muted' : 'unmuted'}`);
  } catch (e) {
    // Ignore errors
  }
}

// Count chats with ready responses
function getReadyCount() {
  let count = 0;
  for (const chat of OFAutoChatState.activePool.values()) {
    if (chat.status === 'ready' && chat.generatedResponse) {
      count++;
    }
  }
  return count;
}

// Start alarm interval if there are ready responses
function startAlarmIntervalIfNeeded() {
  if (OFAutoChatState.alarmMuted) return;
  if (alarmInterval) return; // Already running
  
  const readyCount = getReadyCount();
  if (readyCount === 0) return;
  
  console.log(`[OF-AutoChat] 🔔 Starting alarm - ${readyCount} responses ready`);
  
  // Immediate first alarm
  triggerAlarm(readyCount);
  
  // Start interval
  alarmInterval = setInterval(() => {
    const count = getReadyCount();
    if (count > 0 && !OFAutoChatState.alarmMuted) {
      triggerAlarm(count);
    } else {
      stopAlarmInterval();
    }
  }, OFAutoChatState.alarmIntervalMs);
}

function stopAlarmInterval() {
  if (alarmInterval) {
    clearInterval(alarmInterval);
    alarmInterval = null;
    console.log('[OF-AutoChat] Alarm interval stopped');
  }
}

// Trigger the alarm notification - DISABLED (using global notification bell instead)
function triggerAlarm(readyCount) {
  // Alarm functionality moved to global notification system
  return;
}

// Check and trigger alarm when state changes
function checkAndTriggerAlarm() {
  if (OFAutoChatState.alarmMuted) return;
  
  const readyCount = getReadyCount();
  if (readyCount > 0) {
    startAlarmIntervalIfNeeded();
  } else {
    stopAlarmInterval();
  }
}

// ============================================================
// MESSAGE HANDLERS (called from handlers.js)
// ============================================================

export function handleOFAutoChatMessage(type, data) {
  switch (type) {
    case 'OF_AUTOCHAT_SET_ENABLED':
      if (data.enabled) {
        if (data.profileId) {
          loadBlockedUsers(data.profileId);
        }
        startOFAutoChat();
      } else {
        stopOFAutoChat();
      }
      return { success: true, enabled: OFAutoChatState.enabled };
      
    case 'OF_AUTOCHAT_SET_MAX_CHATS':
      return { success: true, maxChats: setMaxActiveChats(data.maxChats) };
      
    case 'OF_AUTOCHAT_SET_WAIT_TIME':
      return { success: true, waitTime: setWaitTime(data.minutes) };
      
    case 'OF_AUTOCHAT_GET_STATE':
      const poolArray = Array.from(OFAutoChatState.activePool.entries()).map(([peerId, chat]) => ({
        peerId,
        ...chat
      }));
      return { 
        success: true, 
        state: {
          enabled: OFAutoChatState.enabled,
          autoSendEnabled: OFAutoChatState.autoSendEnabled,
          maxActiveChats: OFAutoChatState.maxActiveChats,
          waitTimeMinutes: OFAutoChatState.waitTimeMinutes,
          activePool: poolArray,
          stats: OFAutoChatState.stats
        }
      };
    
    case 'OF_AUTOCHAT_SET_AUTO_SEND':
      OFAutoChatState.autoSendEnabled = !!data.autoSend;
      console.log(`[OF-AutoChat] Auto-send ${OFAutoChatState.autoSendEnabled ? 'ENABLED 📤' : 'DISABLED (queue-only) 📋'}`);
      notifyStateChange();
      return { success: true, autoSendEnabled: OFAutoChatState.autoSendEnabled };
    
    case 'OF_AUTOCHAT_GET_PREGENERATED': {
      // Get pre-generated response for a specific subscriber
      const peerId = data.peerId;
      const chatEntry = OFAutoChatState.activePool.get(peerId);
      if (chatEntry && chatEntry.generatedResponse) {
        return { success: true, response: chatEntry.generatedResponse, status: chatEntry.status };
      }
      return { success: false, error: 'No pre-generated response' };
    }
      
    case 'OF_AUTOCHAT_GENERATION_RESULT':
      handleGenerationResult(data.peerId, data.success, data.response, data.error);
      return { success: true };
      
    case 'OF_AUTOCHAT_SEND_MESSAGE':
      return sendMessage(data.peerId);
      
    case 'OF_AUTOCHAT_REGENERATE':
      regenerateResponse(data.peerId);
      return { success: true };
      
    case 'OF_AUTOCHAT_UPDATE_RESPONSE':
      updateResponse(data.peerId, data.response);
      return { success: true };
      
    case 'OF_AUTOCHAT_SET_ALARM_MUTED':
      // Alarm functionality moved to global notification system
      return { success: true, alarmMuted: false };
      
    default:
      return { success: false, error: 'Unknown message type' };
  }
}

export default {
  OFAutoChatState,
  startOFAutoChat,
  stopOFAutoChat,
  handleOFAutoChatMessage,
  loadBlockedUsers
};
