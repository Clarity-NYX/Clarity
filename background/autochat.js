// ============================================================
// AUTO-CHAT STATE & LOGIC - SIMPLIFIED EVENT-DRIVEN SYSTEM
// ============================================================
// Simple logic:
// 1. User has unreads + not blocked = add to pool and chat
// 2. Timeout = just remove from pool (can return anytime)
// 3. Reply detected = add back to pool and continue

import { AUTOCHAT_CONFIG } from './config.js';
import { API } from './api.js';

// ============================================================
// STATE
// ============================================================

export const AutoChatState = {
  enabled: false,
  autoSendEnabled: false,
  prioritizeByProgress: true, // Prioritize chats by script advancement
  
  // Simplified pool - all chats with unreads
  activePool: new Map(),   // Map<peerId, {peerId, name, status, lastSent, unreadCount, scriptProgress}>
  currentlyProcessing: null, // The chat currently being processed
  
  // Stats
  stats: {
    today: { completed: 0, interrupted: 0, inProgress: 0 },
    allTime: { completed: 0, interrupted: 0 }
  },
  
  // Blocked users
  blockedUsers: [],
  currentProfileId: null,
  
  // Script progress cache
  scriptProgressCache: new Map(), // Map<peerId, {completed, total, percent}>
  
  // Monitor state
  monitorTabId: null,
  lastChatList: [],
  
  // Legacy properties still in use
  previousChats: new Map(), // Track users we've already chatted with
  waitingQueue: [],         // Legacy - kept for compatibility
  maxActiveChats: null,     // No limit anymore
  skipTimeoutMinutes: 10    // Default timeout minutes
};

// ============================================================
// BLOCKED USERS MANAGEMENT
// ============================================================

export async function loadBlockedUsers(profileId) {
  if (!profileId) return [];
  
  try {
    console.log(`[AutoChat] Loading blocked users for profile: ${profileId}`);
    const result = await API.getBlockedUsers(profileId);
    
    if (result.success) {
      AutoChatState.blockedUsers = result.blockedIds || [];
      AutoChatState.currentProfileId = profileId;
      console.log(`[AutoChat] ✅ Loaded ${AutoChatState.blockedUsers.length} blocked users`);
      return AutoChatState.blockedUsers;
    }
  } catch (error) {
    console.error('[AutoChat] Error loading blocked users:', error);
  }
  
  // Fallback to local storage
  const key = `blocklist_${profileId}`;
  const result = await chrome.storage.local.get([key]);
  AutoChatState.blockedUsers = result[key] || [];
  return AutoChatState.blockedUsers;
}

// Check if user is blocked (handles ID format mismatch)
export function isUserBlocked(peerId) {
  if (!peerId) return false;
  
  const peerIdStr = peerId?.toString();
  const rawId = peerIdStr.replace(/^tg:/, '');
  const prefixedId = peerIdStr.startsWith('tg:') ? peerIdStr : `tg:${peerIdStr}`;
  
  for (const blocked of AutoChatState.blockedUsers) {
    const blockedStr = blocked?.toString();
    const blockedRaw = blockedStr?.replace(/^tg:/, '');
    
    if (blockedRaw === rawId || blockedStr === rawId || blockedStr === prefixedId) {
      return true;
    }
  }
  
  return false;
}

// Add user to block list
export async function blockUser(profileId, subscriberId, subscriberName) {
  try {
    await API.addBlockedUser(profileId, subscriberId, subscriberName, 'script_complete');
    
    const subId = subscriberId?.toString();
    if (subId && !AutoChatState.blockedUsers.includes(subId)) {
      AutoChatState.blockedUsers.push(subId);
    }
    
    console.log(`[AutoChat] ✅ Blocked user ${subscriberName || subscriberId}`);
    return true;
  } catch (error) {
    console.error('[AutoChat] Error blocking user:', error);
    return false;
  }
}

// ============================================================
// ACTIVE POOL & QUEUE MANAGEMENT
// ============================================================

// Minimum time after sending before accepting a "reply" (prevents false positives)
const MIN_REPLY_DETECTION_MS = 5000; // 5 seconds

// Human-like delay settings
const HUMAN_DELAY_MIN_MS = 8000;   // 8 seconds minimum
const HUMAN_DELAY_MAX_MS = 25000;  // 25 seconds maximum

function getHumanLikeDelay() {
  return Math.floor(Math.random() * (HUMAN_DELAY_MAX_MS - HUMAN_DELAY_MIN_MS)) + HUMAN_DELAY_MIN_MS;
}

// Add or update chat in pool (simplified - no limits)
function addToPool(chat) {
  const peerId = chat.peerId || chat.chatId || chat.rawId;
  const peerIdStr = peerId?.toString();
  
  // Skip if no unreads
  if (!chat.unreadCount || chat.unreadCount <= 0) {
    return false;
  }
  
  // Skip if blocked
  if (isUserBlocked(peerIdStr)) {
    return false;
  }
  
  // Update existing or add new
  const existingChat = AutoChatState.activePool.get(peerIdStr);
  if (existingChat) {
    // If unreads went to 0, remove from pool
    if (!chat.unreadCount || chat.unreadCount <= 0) {
      AutoChatState.activePool.delete(peerIdStr);
      notifyStateChange();
      return false;
    }
    
    // Update unread count
    existingChat.unreadCount = chat.unreadCount;
    
    // If waiting for reply and has unreads, mark as ready
    if (existingChat.status === 'waiting_for_reply' && chat.unreadCount > 0) {
      const timeSinceSent = Date.now() - (existingChat.lastSent || 0);
      if (timeSinceSent >= MIN_REPLY_DETECTION_MS) {
        console.log(`[AutoChat] 🔔 "${chat.name}" REPLIED! Marking ready.`);
        existingChat.status = 'ready';
        
        // Process if nothing else is being processed
        if (!processingLock && !AutoChatState.currentlyProcessing) {
          processNextPriorityChat();
        }
      }
    }
  } else {
    // Add new chat to pool
    AutoChatState.activePool.set(peerIdStr, {
      peerId: peerIdStr,
      name: chat.name || 'Unknown',
      status: 'ready',
      addedAt: Date.now(),
      lastSent: null,
      unreadCount: chat.unreadCount || 1,
      scriptProgress: AutoChatState.scriptProgressCache.get(peerIdStr) || { completed: 0, total: 0, percent: 0 },
      listPosition: chat.listPosition ?? 999, // Position in chat list (lower = higher priority)
      fromTopScan: chat.fromTopScan || false   // Flag if this came from a top-of-list scan
    });
    
    console.log(`[AutoChat] ✅ Added to pool: "${chat.name}" (pool size: ${AutoChatState.activePool.size})`);
    
    // Process if nothing else is being processed
    if (!processingLock && !AutoChatState.currentlyProcessing) {
      processNextPriorityChat();
    }
  }
  
  notifyStateChange();
  return true;
}

// Process next chat based on priority (script progress)
async function processNextPriorityChat() {
  if (!AutoChatState.enabled || processingLock || AutoChatState.currentlyProcessing) {
    return;
  }
  
  // Get all ready chats
  const readyChats = [];
  for (const [peerId, chat] of AutoChatState.activePool) {
    if (chat.status === 'ready' && !isUserBlocked(peerId)) {
      readyChats.push({ peerId, ...chat });
    }
  }
  
  if (readyChats.length === 0) {
    console.log('[AutoChat] 💤 No ready chats to process');
    return;
  }
  
  // Sort by priority:
  // 1. Chats that replied (have lastSent)
  // 2. If prioritizeByProgress is enabled, sort by script progress (highest percent first)
  // 3. Otherwise, process in order they were added
  readyChats.sort((a, b) => {
    // Replies get priority
    if (a.lastSent && !b.lastSent) return -1;
    if (!a.lastSent && b.lastSent) return 1;
    
    // If both are replies or both are new, use script progress
    if (AutoChatState.prioritizeByProgress) {
      const aProgress = a.scriptProgress?.percent || 0;
      const bProgress = b.scriptProgress?.percent || 0;
      
      // Higher progress gets priority
      if (aProgress !== bProgress) {
        return bProgress - aProgress;
      }
    }
    
    // Fall back to order added
    return a.addedAt - b.addedAt;
  });
  
  const nextChat = readyChats[0];
  console.log(`[AutoChat] 📊 Next priority chat: "${nextChat.name}" (${nextChat.scriptProgress?.percent || 0}% complete)`);
  
  // Add human-like delay for replies
  const delay = nextChat.lastSent ? getHumanLikeDelay() : 500;
  setTimeout(() => processChat(nextChat.peerId), delay);
}

// Update script progress for a chat
export async function updateChatScriptProgress(peerId, progress) {
  const peerIdStr = peerId?.toString();
  
  // Update cache
  AutoChatState.scriptProgressCache.set(peerIdStr, progress);
  
  // Update in pool if exists
  const chat = AutoChatState.activePool.get(peerIdStr);
  if (chat) {
    chat.scriptProgress = progress;
  }
}

// Remove from active pool (only for blocks/script complete)
function removeFromActivePool(peerId, reason = 'unknown') {
  const peerIdStr = peerId?.toString();
  const chat = AutoChatState.activePool.get(peerIdStr);
  
  if (chat) {
    // Only remove if blocked or script complete - not for timeouts
    if (reason === 'blocked' || reason === 'script_complete' || reason === 'user_blocked' || reason === 'all_actions_complete') {
      AutoChatState.activePool.delete(peerIdStr);
      console.log(`[AutoChat] ❌ Removed from pool: "${chat.name}" (reason: ${reason})`);
      
      notifyStateChange();
      return true;
    } else if (reason === 'timeout') {
      // Just mark as ready again for timeouts - they can continue anytime
      console.log(`[AutoChat] ⏰ Timeout for "${chat.name}" - marking as ready again`);
      chat.status = 'ready';
      chat.lastSent = null; // Reset so they get normal priority
      notifyStateChange();
      return false;
    }
  }
  return false;
}

// ============================================================
// CORE PROCESSING LOGIC
// ============================================================

let processingLock = false;
let timeoutCheckInterval = null;

// Process a specific chat - WITH VERIFICATION
async function processChat(peerId) {
  const peerIdStr = peerId?.toString();
  
  if (!AutoChatState.enabled) {
    console.log('[AutoChat] Disabled, not processing');
    return;
  }
  
  if (processingLock) {
    console.log('[AutoChat] Already processing, skipping');
    return;
  }
  
  if (AutoChatState.currentlyProcessing) {
    console.log('[AutoChat] Already processing a chat');
    return;
  }
  
  const chat = AutoChatState.activePool.get(peerIdStr);
  if (!chat) {
    console.log(`[AutoChat] Chat ${peerIdStr} not found in pool`);
    return;
  }
  
  if (isUserBlocked(peerIdStr)) {
    removeFromActivePool(peerIdStr, 'blocked');
    return;
  }
  
  processingLock = true;
  
  try {
    chat.status = 'processing';
    AutoChatState.currentlyProcessing = chat;
    AutoChatState.stats.today.inProgress = 1;
    notifyStateChange();
    
    console.log(`[AutoChat] 🚀 Processing: "${chat.name}" (${chat.peerId})`);
    
    // Navigate with verification and retry
    const navResult = await navigateAndVerify(chat.peerId, chat.name);
    
    if (!navResult.success) {
      console.log(`[AutoChat] ❌ Failed to open chat "${chat.name}" after ${navResult.attempts} attempts: ${navResult.error}`);
      
      // Mark as failed but keep in pool for next scan
      chat.status = 'ready';
      AutoChatState.currentlyProcessing = null;
      AutoChatState.stats.today.inProgress = 0;
      AutoChatState.stats.today.interrupted++;
      processingLock = false;
      notifyStateChange();
      
      // Notify sidepanel of failure
      chrome.runtime.sendMessage({
        type: 'AUTOCHAT_STEP_UPDATE',
        data: {
          chatName: chat.name,
          chatIndex: AutoChatState.activePool.size,
          totalChats: AutoChatState.activePool.size,
          step: 'openingChat',
          status: 'failed',
          error: navResult.error
        }
      }).catch(() => {});
      
      // Move to next chat after a delay
      setTimeout(() => {
        if (!processingLock && !AutoChatState.currentlyProcessing) {
          for (const [pid, poolChat] of AutoChatState.activePool) {
            if (poolChat.status === 'ready' && pid !== peerIdStr) {
              processChat(pid);
              return;
            }
          }
        }
      }, 2000);
      
      return;
    }
    
    console.log(`[AutoChat] ✅ Chat "${chat.name}" opened and verified (${navResult.attempts} attempt(s))`);
    
    // Notify step complete
    chrome.runtime.sendMessage({
      type: 'AUTOCHAT_STEP_UPDATE',
      data: {
        chatName: chat.name,
        chatIndex: AutoChatState.activePool.size,
        totalChats: AutoChatState.activePool.size,
        step: 'openingChat',
        status: 'done'
      }
    }).catch(() => {});
    
    // IMPORTANT: Notify sidepanel to detect the newly opened chat
    chrome.runtime.sendMessage({
      type: 'AUTOCHAT_CHAT_OPENED',
      data: {
        peerId: chat.peerId,
        chatName: chat.name
      }
    }).catch(() => {});
    
    // Small delay for UI to settle before triggering generation
    await new Promise(r => setTimeout(r, 1000));
    
    // Final verification before triggering generation
    const finalCheck = await verifyOpenChat(chat.peerId, chat.name);
    if (!finalCheck.success) {
      console.log(`[AutoChat] ⚠️ Final verification failed! Chat may have changed. Aborting generation.`);
      chat.status = 'ready';
      AutoChatState.currentlyProcessing = null;
      AutoChatState.stats.today.inProgress = 0;
      processingLock = false;
      notifyStateChange();
      return;
    }
    
    console.log(`[AutoChat] 🤖 Triggering AI generation for: ${chat.name}`);
    
    chrome.runtime.sendMessage({
      type: 'AUTOCHAT_TRIGGER_GENERATION',
      data: {
        peerId: chat.peerId,
        autoSend: AutoChatState.autoSendEnabled,
        chatName: chat.name,
        chatIndex: AutoChatState.activePool.size,
        totalChats: AutoChatState.activePool.size,
        verified: true  // Flag indicating we verified the chat is open
      }
    }).catch(() => {});
    
  } catch (error) {
    console.error('[AutoChat] Error processing:', error);
    if (chat) chat.status = 'ready';
    AutoChatState.currentlyProcessing = null;
    AutoChatState.stats.today.inProgress = 0;
    processingLock = false;
    notifyStateChange();
  }
}

// Called when message is sent
export async function onMessageSent(peerId, success, reason = null) {
  console.log(`[AutoChat] 📬 MESSAGE SENT: peerId=${peerId}, success=${success}, reason=${reason}`);
  
  processingLock = false;
  
  const peerIdStr = peerId?.toString();
  const chat = AutoChatState.activePool.get(peerIdStr);
  
  AutoChatState.currentlyProcessing = null;
  AutoChatState.stats.today.inProgress = 0;
  
  if (success) {
    if (reason === 'script_complete' || reason === 'user_blocked' || reason === 'all_actions_complete') {
      console.log(`[AutoChat] 🏁 Script complete, removing: "${chat?.name}"`);
      AutoChatState.stats.today.completed++;
      removeFromActivePool(peerIdStr, reason);
    } else if (reason === 'waiting_for_reply') {
      // Skipped because our message is last (we're already waiting for their reply)
      // DON'T update lastSent - keep the original timestamp for timeout calculation
      if (chat) {
        chat.status = 'waiting_for_reply';
        // chat.lastSent stays the same - don't reset timeout!
      }
      console.log(`[AutoChat] ⏭️ Skipped (our msg is last, waiting for their reply): "${chat?.name}"`);
    } else if (chat) {
      // Normal success - actually sent a message
      chat.status = 'waiting_for_reply';
      chat.lastSent = Date.now();  // Only set when we actually SENT something
      AutoChatState.stats.today.completed++;
      console.log(`[AutoChat] ✅ Sent! Now waiting for reply from: "${chat.name}"`);
    }
  } else {
    AutoChatState.stats.today.interrupted++;
    if (chat) {
      chat.status = 'ready';
    }
    console.log(`[AutoChat] ❌ Failed: "${chat?.name}"`);
  }
  
  notifyStateChange();
  
  // IMPORTANT: After sending, scroll to top of chat list to find new unreads
  // New messages appear at the TOP of the list in Telegram
  console.log('[AutoChat] ⬆️ Triggering scroll-to-top scan for new unreads...');
  await triggerScrollToTopScan();
  
  // Wait a bit for the scan to complete and update pool
  await new Promise(r => setTimeout(r, 1500));
  
  // Process next ready chat with priority given to TOP chats (newest unreads)
  if (!processingLock && !AutoChatState.currentlyProcessing) {
    // Sort pool by priority: fromTopScan=true first, then listPosition (lower = higher priority)
    const readyChats = [];
    for (const [pid, poolChat] of AutoChatState.activePool) {
      if (poolChat.status === 'ready') {
        readyChats.push({ pid, ...poolChat });
      }
    }
    
    // Sort by priority
    readyChats.sort((a, b) => {
      // Chats from top scan get highest priority
      if (a.fromTopScan && !b.fromTopScan) return -1;
      if (!a.fromTopScan && b.fromTopScan) return 1;
      
      // Then by list position (lower = higher in list = newer)
      const posA = a.listPosition ?? 999;
      const posB = b.listPosition ?? 999;
      if (posA !== posB) return posA - posB;
      
      // Then replies over new chats
      if (a.lastSent && !b.lastSent) return -1;
      if (!a.lastSent && b.lastSent) return 1;
      
      return 0;
    });
    
    if (readyChats.length > 0) {
      const nextChat = readyChats[0];
      console.log(`[AutoChat] 📬 Processing PRIORITY chat: "${nextChat.name}" (fromTop: ${nextChat.fromTopScan}, pos: ${nextChat.listPosition})`);
      processChat(nextChat.pid);
    } else {
      console.log('[AutoChat] 💤 All processed - waiting for replies...');
    }
  }
}

// Trigger a scroll-to-top scan on the Telegram tab
async function triggerScrollToTopScan() {
  try {
    const tabs = await chrome.tabs.query({ url: '*://web.telegram.org/*' });
    if (!tabs.length) {
      console.log('[AutoChat] No Telegram tab found for scroll-to-top scan');
      return;
    }
    
    console.log('[AutoChat] ⬆️ Sending SCROLL_TO_TOP_AND_SCAN to content script...');
    const result = await chrome.tabs.sendMessage(tabs[0].id, { 
      type: 'AUTOCHAT_SCROLL_TO_TOP_AND_SCAN' 
    });
    
    if (result?.success) {
      console.log(`[AutoChat] ✅ Scroll-to-top scan found ${result.count} unreads at top`);
    }
  } catch (error) {
    console.log('[AutoChat] ⚠️ Scroll-to-top scan error:', error.message);
  }
}

// Check for timeouts - just mark as ready again (they can return anytime)
function checkForTimeouts() {
  if (!AutoChatState.enabled) return;
  
  const now = Date.now();
  const timeoutMs = AutoChatState.skipTimeoutMinutes * 60 * 1000;
  
  for (const [peerId, chat] of AutoChatState.activePool) {
    if (chat.status === 'waiting_for_reply' && chat.lastSent) {
      const elapsed = now - chat.lastSent;
      
      if (elapsed >= timeoutMs) {
        console.log(`[AutoChat] ⏰ Timeout: "${chat.name}" - marking as ready again`);
        chat.status = 'ready';
        chat.lastSent = null; // Reset so they don't get priority
      }
    }
  }
}

// ============================================================
// NAVIGATION - WITH VERIFICATION & RETRY
// ============================================================

const MAX_NAVIGATION_RETRIES = 3;
const NAVIGATION_TIMEOUT_MS = 2000;
const VERIFICATION_DELAY_MS = 1500;

// Navigate to chat and return success/failure
async function navigateToChatByPeerId(peerId, chatName = null) {
  const tabs = await chrome.tabs.query({ url: '*://web.telegram.org/*' });
  if (tabs.length === 0) {
    console.log('[AutoChat] No Telegram tab found');
    return { success: false, error: 'no_telegram_tab' };
  }
  
  const tab = tabs[0];
  
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (peerId, chatName) => {
        console.log(`[AutoChat-Nav] Looking for chat: "${chatName}" (${peerId})`);
        
        // First ensure chat list is visible and loaded
        const chatList = document.querySelector('.chat-list, #LeftColumn-main .chat-list');
        if (!chatList) {
          console.log('[AutoChat-Nav] Chat list not found!');
          return { success: false, error: 'chat_list_not_found' };
        }
        
        let chatItem = null;
        let foundMethod = null;
        let actualPeerId = null;
        
        // Get ALL chat items
        const allItems = chatList.querySelectorAll('.ListItem.chat-item-clickable, .ListItem[class*="chat"]');
        console.log(`[AutoChat-Nav] Found ${allItems.length} chat items`);
        
        // Method 1: Exact peer ID match
        if (peerId && !peerId.startsWith('name:')) {
          for (const item of allItems) {
            // Check data-peer-id in any descendant
            const peerIdEl = item.querySelector('[data-peer-id]');
            if (peerIdEl) {
              const itemPeerId = peerIdEl.getAttribute('data-peer-id');
              if (itemPeerId === peerId || itemPeerId === peerId.replace(/^tg:/, '')) {
                chatItem = item;
                actualPeerId = itemPeerId;
                foundMethod = 'exact-peer-id';
                console.log(`[AutoChat-Nav] Found by exact peer ID: ${itemPeerId}`);
                break;
              }
            }
            
            // Check href
            const anchor = item.querySelector('a[href^="#"]');
            if (anchor) {
              const href = anchor.getAttribute('href');
              const hrefId = href?.substring(1);
              if (hrefId === peerId || hrefId === peerId.replace(/^tg:/, '')) {
                chatItem = item;
                actualPeerId = hrefId;
                foundMethod = 'href-match';
                console.log(`[AutoChat-Nav] Found by href: ${hrefId}`);
                break;
              }
            }
          }
        }
        
        // Method 2: Name match (exact first, then partial)
        if (!chatItem && chatName) {
          // First try exact match
          for (const item of allItems) {
            const nameEl = item.querySelector('.fullName, .title, h3, .peer-title, .ListItem-title');
            const itemName = nameEl?.textContent?.trim();
            
            if (itemName === chatName) {
              chatItem = item;
              foundMethod = 'exact-name-match';
              
              // Get peer ID for this item
              const peerIdEl = item.querySelector('[data-peer-id]');
              if (peerIdEl) {
                actualPeerId = peerIdEl.getAttribute('data-peer-id');
              } else {
                const anchor = item.querySelector('a[href^="#"]');
                if (anchor) {
                  actualPeerId = anchor.getAttribute('href')?.substring(1);
                }
              }
              
              console.log(`[AutoChat-Nav] Found by exact name: "${itemName}" (${actualPeerId})`);
              break;
            }
          }
          
          // If no exact match, try partial
          if (!chatItem) {
            for (const item of allItems) {
              const nameEl = item.querySelector('.fullName, .title, h3, .peer-title, .ListItem-title');
              const itemName = nameEl?.textContent?.trim();
              
              if (itemName && chatName && (
                itemName.toLowerCase().includes(chatName.toLowerCase()) ||
                chatName.toLowerCase().includes(itemName.toLowerCase())
              )) {
                chatItem = item;
                foundMethod = 'partial-name-match';
                
                // Get peer ID
                const peerIdEl = item.querySelector('[data-peer-id]');
                if (peerIdEl) {
                  actualPeerId = peerIdEl.getAttribute('data-peer-id');
                } else {
                  const anchor = item.querySelector('a[href^="#"]');
                  if (anchor) {
                    actualPeerId = anchor.getAttribute('href')?.substring(1);
                  }
                }
                
                console.log(`[AutoChat-Nav] Found by partial name: "${itemName}" (${actualPeerId})`);
                break;
              }
            }
          }
        }
        
        if (!chatItem) {
          console.log(`[AutoChat-Nav] Chat not found! Tried: peerId="${peerId}", name="${chatName}"`);
          return { success: false, error: 'chat_not_found', peerId, chatName };
        }
        
        // Make sure the item is visible by scrolling it into view
        chatItem.scrollIntoView({ behavior: 'instant', block: 'center' });
        
        // Wait a bit for scroll to complete
        setTimeout(() => {
          // Find the best click target
          const clickTarget = chatItem.querySelector('a.ListItem-button') || 
                             chatItem.querySelector('a[href^="#"]') ||
                             chatItem;
          
          // Simulate natural click
          const rect = clickTarget.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          
          console.log(`[AutoChat-Nav] Clicking at (${x}, ${y})`);
          
          // Dispatch mouse events
          clickTarget.dispatchEvent(new MouseEvent('mousedown', { 
            bubbles: true, 
            cancelable: true,
            clientX: x, 
            clientY: y,
            view: window
          }));
          
          clickTarget.dispatchEvent(new MouseEvent('mouseup', { 
            bubbles: true,
            cancelable: true, 
            clientX: x, 
            clientY: y,
            view: window
          }));
          
          clickTarget.dispatchEvent(new MouseEvent('click', { 
            bubbles: true,
            cancelable: true,
            clientX: x, 
            clientY: y,
            view: window
          }));
        }, 100);
        
        return { success: true, foundMethod, peerId: actualPeerId || peerId, chatName };
      },
      args: [peerId, chatName]
    });
    
    // Result is an array with one item
    return result[0]?.result || { success: false, error: 'no_result' };
    
  } catch (err) {
    console.error('[AutoChat] Error navigating:', err);
    return { success: false, error: err.message };
  }
}

// Verify which chat is currently open - ENHANCED VERSION
async function verifyOpenChat(expectedPeerId, expectedName) {
  const tabs = await chrome.tabs.query({ url: '*://web.telegram.org/*' });
  if (tabs.length === 0) {
    return { success: false, error: 'no_telegram_tab' };
  }
  
  const tab = tabs[0];
  
  // Wait a bit for chat to fully load
  await new Promise(r => setTimeout(r, 300));
  
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (expectedPeerId, expectedName) => {
        console.log(`[AutoChat-Verify] Checking if we're in correct chat: "${expectedName}" (${expectedPeerId})`);
        
        // Multiple methods to find current chat info
        let currentPeerId = null;
        let currentName = null;
        
        // Method 1: URL Hash (most reliable)
        const hash = window.location.hash;
        if (hash && hash.startsWith('#')) {
          currentPeerId = hash.substring(1);
          console.log('[AutoChat-Verify] Found peer ID from URL:', currentPeerId);
        }
        
        // Method 2: Middle column data attributes
        const middleColumn = document.querySelector('#MiddleColumn, .MiddleColumn, [class*="middle-column"]');
        if (middleColumn) {
          // Check for data-peer-id anywhere in middle column
          const peerIdEl = middleColumn.querySelector('[data-peer-id]');
          if (peerIdEl) {
            const dataPeerId = peerIdEl.getAttribute('data-peer-id');
            if (!currentPeerId) currentPeerId = dataPeerId;
            console.log('[AutoChat-Verify] Found peer ID from middle column:', dataPeerId);
          }
        }
        
        // Method 3: Chat header elements
        const headerSelectors = [
          '.ChatInfo .fullName',
          '.chat-info .title',
          '.TopicPeer .peer-title',
          '.ChatHeader h3',
          '[class*="ChatInfo"] .fullName',
          '.peer-title',
          '.chat-header .chat-title'
        ];
        
        for (const selector of headerSelectors) {
          const nameEl = document.querySelector(selector);
          if (nameEl?.textContent?.trim()) {
            currentName = nameEl.textContent.trim();
            console.log(`[AutoChat-Verify] Found name from ${selector}:`, currentName);
            break;
          }
        }
        
        // Method 4: Check message composer for peer info
        const composer = document.querySelector('.Composer, .ComposerWrapper, [class*="composer"]');
        if (composer && !currentPeerId) {
          const composerPeer = composer.closest('[data-peer-id]');
          if (composerPeer) {
            currentPeerId = composerPeer.getAttribute('data-peer-id');
            console.log('[AutoChat-Verify] Found peer ID from composer:', currentPeerId);
          }
        }
        
        // Clean up peer IDs for comparison
        const cleanPeerId = (id) => id?.toString().replace(/^tg:/, '');
        const expectedClean = cleanPeerId(expectedPeerId);
        const currentClean = cleanPeerId(currentPeerId);
        
        // Check if IDs match
        const peerIdMatches = !!(currentClean && expectedClean && currentClean === expectedClean);
        
        // Check if names match (exact or partial)
        const nameMatches = !!(currentName && expectedName && (
          currentName === expectedName ||
          currentName.toLowerCase() === expectedName.toLowerCase() ||
          currentName.includes(expectedName) ||
          expectedName.includes(currentName)
        ));
        
        // Success if either matches
        const success = peerIdMatches || nameMatches;
        
        console.log('[AutoChat-Verify] Result:', {
          success,
          currentPeerId: currentClean,
          expectedPeerId: expectedClean,
          peerIdMatches,
          currentName,
          expectedName,
          nameMatches
        });
        
        return {
          success,
          currentPeerId: currentClean,
          currentName,
          expectedPeerId: expectedClean,
          expectedName,
          peerIdMatches,
          nameMatches,
          hash
        };
      },
      args: [expectedPeerId, expectedName]
    });
    
    return result[0]?.result || { success: false, error: 'no_result' };
    
  } catch (err) {
    console.error('[AutoChat] Error verifying chat:', err);
    return { success: false, error: err.message };
  }
}

// Navigate with verification and retry
async function navigateAndVerify(peerId, chatName, maxRetries = MAX_NAVIGATION_RETRIES) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[AutoChat] 🔄 Navigation attempt ${attempt}/${maxRetries} for "${chatName}" (${peerId})`);
    
    // Attempt navigation
    const navResult = await navigateToChatByPeerId(peerId, chatName);
    
    if (!navResult.success) {
      console.log(`[AutoChat] ❌ Navigation failed: ${navResult.error}`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000)); // Wait before retry
        continue;
      }
      return { success: false, error: navResult.error, attempts: attempt };
    }
    
    console.log(`[AutoChat] ✅ Click sent via ${navResult.foundMethod}`);
    
    // Wait for chat to open
    await new Promise(r => setTimeout(r, VERIFICATION_DELAY_MS));
    
    // Verify correct chat is open
    const verifyResult = await verifyOpenChat(peerId, chatName);
    
    if (verifyResult.success) {
      console.log(`[AutoChat] ✅ Verified: correct chat is open (peerId: ${verifyResult.peerIdMatches}, name: ${verifyResult.nameMatches})`);
      return { success: true, attempts: attempt, verification: verifyResult };
    }
    
    console.log(`[AutoChat] ⚠️ Verification failed - wrong chat open! Current: "${verifyResult.currentName}" (${verifyResult.currentPeerId}), Expected: "${chatName}" (${peerId})`);
    
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 500)); // Brief wait before retry
    }
  }
  
  return { success: false, error: 'verification_failed_after_retries', attempts: maxRetries };
}

// ============================================================
// REPLY DETECTION - SIMPLIFIED
// ============================================================

let replyScanInterval = null;
let scanCounter = 0;

async function scanForReplies() {
  scanCounter++;
  
  if (!AutoChatState.enabled || processingLock || AutoChatState.currentlyProcessing) {
    return;
  }
  
  const tabs = await chrome.tabs.query({ url: '*://web.telegram.org/*' });
  if (!tabs.length) return;
  
  try {
    const result = await chrome.tabs.sendMessage(tabs[0].id, { type: 'AUTOCHAT_GET_CHAT_LIST' });
    
    if (!result?.success || !result.chats) return;
    
    // Log pool status every 6 scans (30 seconds)
    if (scanCounter % 6 === 0) {
      const poolNames = [...AutoChatState.activePool.values()].map(c => `${c.name}(${c.status.slice(0,4)})`).join(', ');
      const readyCount = [...AutoChatState.activePool.values()].filter(c => c.status === 'ready').length;
      const waitingCount = [...AutoChatState.activePool.values()].filter(c => c.status === 'waiting_for_reply').length;
      console.log(`[AutoChat] 📊 Pool: ${AutoChatState.activePool.size}/${AutoChatState.maxActiveChats} [${readyCount} ready, ${waitingCount} waiting] | Queue: ${AutoChatState.waitingQueue.length}`);
      if (poolNames) console.log(`[AutoChat] 📋 In pool: ${poolNames}`);
    }
    
    // Check for chats with unreads
    for (const chat of result.chats) {
      if (chat.unreadCount <= 0) continue;
      
      const peerId = (chat.rawId || chat.chatId || '').toString().replace(/^tg:/, '');
      if (!peerId) continue;
      
      // Skip blocked users
      if (isUserBlocked(peerId)) continue;
      
      // Check if this user was previously chatted with (returning user)
      const previousChat = AutoChatState.previousChats.get(peerId);
      const isReturningUser = !!previousChat;
      
      // Add to pool (function handles duplicates)
      addToPool({
        peerId: peerId,
        name: chat.name,
        unreadCount: chat.unreadCount
      }, isReturningUser);
    }
    
  } catch (err) {
    if (scanCounter % 10 === 0) {
      console.log('[AutoChat] ❌ Scan error:', err.message);
    }
  }
}

// ============================================================
// EVENT HANDLERS
// ============================================================

export function handleNewUnreads(data) {
  if (!AutoChatState.enabled) return;
  
  for (const chat of (data.chats || [])) {
    const peerId = (chat.chatId || chat.peerId || chat.rawId || '').toString().replace(/^tg:/, '');
    const isReturning = AutoChatState.previousChats.has(peerId);
    
    addToPool({
      peerId: peerId,
      name: chat.name,
      unreadCount: chat.unreadCount,
      listPosition: chat.listPosition // Track position for priority
    }, isReturning);
  }
}

// Handle unreads found at top of list (high priority)
export function handleUnreadsAtTop(data) {
  if (!AutoChatState.enabled) return;
  
  for (const chat of (data.chats || [])) {
    const peerId = (chat.chatId || chat.peerId || chat.rawId || '').toString().replace(/^tg:/, '');
    
    // These chats are at top = highest priority
    addToPool({
      peerId: peerId,
      name: chat.name,
      unreadCount: chat.unreadCount,
      listPosition: chat.listPosition || 0, // Top position = 0
      fromTopScan: true // Flag that this came from a priority top scan
    });
  }
}

export function handleChatListUpdate(data) {
  AutoChatState.lastChatList = data.chats || [];
  
  if (AutoChatState.enabled && data.chats?.length > 0) {
    // Process ALL chats but only add those with unreads
    for (const chat of data.chats) {
      // Skip if no unreads
      if (!chat.unreadCount || chat.unreadCount <= 0) continue;
      
      const peerId = (chat.chatId || chat.rawId || '').toString().replace(/^tg:/, '');
      if (!peerId) continue;
      
      const isReturning = AutoChatState.previousChats.has(peerId);
      
      addToPool({
        peerId: peerId,
        name: chat.name,
        unreadCount: chat.unreadCount
      }, isReturning);
    }
  }
}

export async function handleUserBlocked(subscriberId) {
  console.log(`[AutoChat] 🚫 User blocked: ${subscriberId}`);
  
  const subIdStr = subscriberId?.toString();
  const rawId = subIdStr?.replace(/^tg:/, '');
  
  if (!AutoChatState.blockedUsers.includes(rawId)) {
    AutoChatState.blockedUsers.push(rawId);
  }
  
  removeFromActivePool(rawId, 'blocked');
  removeFromActivePool(subIdStr, 'blocked');
  
  if (AutoChatState.currentlyProcessing?.peerId?.toString() === rawId ||
      AutoChatState.currentlyProcessing?.peerId?.toString() === subIdStr) {
    AutoChatState.currentlyProcessing = null;
    processingLock = false;
  }
}

// ============================================================
// MONITORING CONTROL
// ============================================================

let monitoringInterval = null;

// Clean up pool - remove chats with no unreads
function cleanupPool() {
  const toRemove = [];
  for (const [peerId, chat] of AutoChatState.activePool) {
    if (!chat.unreadCount || chat.unreadCount <= 0) {
      toRemove.push(peerId);
    }
  }
  
  if (toRemove.length > 0) {
    console.log(`[AutoChat] 🧹 Cleaning pool - removing ${toRemove.length} chats with 0 unreads`);
    toRemove.forEach(peerId => {
      AutoChatState.activePool.delete(peerId);
    });
    notifyStateChange();
  }
}

export function startAutoChatMonitoring() {
  console.log('[AutoChat] 🚀 Starting simplified monitoring...');
  
  // Clean up any existing chats with 0 unreads
  cleanupPool();
  
  findAndStartMonitor();
  
  setTimeout(async () => {
    if (AutoChatState.currentProfileId) {
      await loadBlockedUsers(AutoChatState.currentProfileId);
    }
    
    // Clean up again after initial scan
    cleanupPool();
    
    console.log('[AutoChat] 📡 Initial scan...');
    performInitialScan();
  }, 2000);
  
  // Timeout check every 30 seconds
  if (timeoutCheckInterval) clearInterval(timeoutCheckInterval);
  timeoutCheckInterval = setInterval(() => {
    if (AutoChatState.enabled) checkForTimeouts();
  }, 30000);
  
  // Reply scan every 5 seconds
  if (replyScanInterval) clearInterval(replyScanInterval);
  replyScanInterval = setInterval(() => {
    if (AutoChatState.enabled) scanForReplies();
  }, 5000);
}

export function stopAutoChatMonitoring() {
  console.log('[AutoChat] 🛑 Stopping monitoring...');
  
  if (monitoringInterval) clearInterval(monitoringInterval);
  if (timeoutCheckInterval) clearInterval(timeoutCheckInterval);
  if (replyScanInterval) clearInterval(replyScanInterval);
  
  monitoringInterval = null;
  timeoutCheckInterval = null;
  replyScanInterval = null;
  
  AutoChatState.waitingQueue = [];
  AutoChatState.activePool.clear();
  AutoChatState.currentlyProcessing = null;
  processingLock = false;
  
  if (AutoChatState.monitorTabId) {
    chrome.tabs.sendMessage(AutoChatState.monitorTabId, { type: 'AUTOCHAT_STOP_MONITORING' }).catch(() => {});
  }
  
  notifyStateChange();
}

async function findAndStartMonitor() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://web.telegram.org/*' });
    if (tabs.length > 0) {
      AutoChatState.monitorTabId = tabs[0].id;
      chrome.tabs.sendMessage(tabs[0].id, { type: 'AUTOCHAT_START_MONITORING' }).catch(() => {});
    }
  } catch (error) {
    console.error('[AutoChat] Error finding Telegram tab:', error);
  }
}

async function performInitialScan() {
  const tabs = await chrome.tabs.query({ url: '*://web.telegram.org/*' });
  if (tabs.length === 0) return;
  
  try {
    const result = await chrome.tabs.sendMessage(tabs[0].id, { type: 'AUTOCHAT_GET_CHAT_LIST' });
    
    if (result?.success && result.chats) {
      console.log(`[AutoChat] 📋 Initial: ${result.chats.length} chats, ${result.totalUnread || 0} unreads`);
      handleChatListUpdate({ chats: result.chats });
    }
  } catch (err) {
    console.error('[AutoChat] Initial scan error:', err);
  }
}

// ============================================================
// NOTIFY SIDEPANEL
// ============================================================

export function notifyStateChange() {
  let readyCount = 0;
  let waitingCount = 0;
  
  for (const chat of AutoChatState.activePool.values()) {
    if (chat.status === 'ready') readyCount++;
    if (chat.status === 'waiting_for_reply') waitingCount++;
  }
  
  chrome.runtime.sendMessage({
    type: 'AUTOCHAT_STATE_CHANGED',
    data: {
      enabled: AutoChatState.enabled,
      autoSendEnabled: AutoChatState.autoSendEnabled,
      maxActiveChats: AutoChatState.maxActiveChats,
      skipTimeoutMinutes: AutoChatState.skipTimeoutMinutes,
      
      activePoolSize: AutoChatState.activePool.size,
      activePoolReadyCount: readyCount,
      activePoolWaitingCount: waitingCount,
      queueCount: AutoChatState.waitingQueue.length,
      currentlyProcessing: AutoChatState.currentlyProcessing,
      
      stats: AutoChatState.stats,
      
      // Legacy
      activeCount: AutoChatState.activePool.size,
      waitingCount: AutoChatState.waitingQueue.length
    }
  }).catch(() => {});
}

// ============================================================
// LEGACY EXPORTS
// ============================================================

export function moveToNextChat() {}
export function buildChatQueue() { performInitialScan(); }
export function removeFromQueue(peerId) { removeFromActivePool(peerId, 'manual'); }
export function openNextChat() {}
export function markChatSent(peerId, chatName) {}
export function clearChatSentStatus(peerId) { return false; }
export function createChatState(chatId, name) { return { chatId, name, status: 'waiting', addedAt: Date.now() }; }
export function activateChat(chat) { addToPool(chat); }
export function moveToCooldown(chatId) {}
export function markCompleted(chatId) { onMessageSent(chatId, true); }
export function handleNewMessages(data) { handleNewUnreads(data); }
export async function openChatById(chatId) { await navigateToChatByPeerId(chatId); }
