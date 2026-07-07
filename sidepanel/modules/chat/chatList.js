// ============================================================
// CHAT LIST MODULE - Handles chat list display and navigation
// ============================================================

import { $, escapeHtml } from '../../utils/dom.js';
import { showNotification } from '../../utils/notify.js';
import Store from '../../state/store.js';
import API from '../../utils/api.js';

// ============================================================
// SPENDING TIER SYSTEM
// Color-coded tiers based on total subscriber spending
// ============================================================

const SPENDING_TIERS = [
  { min: 0,      max: 0,        tier: 'free',     label: 'Free',       color: '#6b7280', glow: 'none' },
  { min: 0.01,   max: 50,       tier: 'starter',  label: 'Starter',    color: '#4ade80', glow: 'rgba(74,222,128,0.15)' },
  { min: 50.01,  max: 200,      tier: 'fan',      label: 'Fan',        color: '#2dd4bf', glow: 'rgba(45,212,191,0.18)' },
  { min: 200.01, max: 500,      tier: 'loyal',    label: 'Loyal',      color: '#38bdf8', glow: 'rgba(56,189,248,0.20)' },
  { min: 500.01, max: 1000,     tier: 'vip',      label: 'VIP',        color: '#818cf8', glow: 'rgba(129,140,248,0.22)' },
  { min: 1000.01, max: 3000,    tier: 'elite',    label: 'Elite',      color: '#a855f7', glow: 'rgba(168,85,247,0.25)' },
  { min: 3000.01, max: Infinity, tier: 'whale',   label: '🐋 Whale',  color: '#ec4899', glow: 'rgba(236,72,153,0.30)' }
];

/**
 * Parse a spent string like "$1,234.56" to a number
 */
const parseSpentAmount = (spentStr) => {
  if (!spentStr) return 0;
  const cleaned = spentStr.toString().replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
};

/**
 * Get the spending tier for a given amount
 */
const getSpendingTier = (amount) => {
  if (!amount || amount <= 0) return SPENDING_TIERS[0]; // free
  for (const tier of SPENDING_TIERS) {
    if (amount >= tier.min && amount <= tier.max) return tier;
  }
  return SPENDING_TIERS[SPENDING_TIERS.length - 1]; // whale fallback
};

// Cached spending data map: subscriberId -> { totalSpent, tier }
let spendingDataCache = new Map();

/**
 * Load spending data for all chats from stored notes,
 * then batch-sync to NYX CRM Firestore so the CRM dashboard shows spending badges.
 */
const loadSpendingData = async () => {
  const profile = Store.get('currentProfile');
  if (!profile?.id) return;
  
  try {
    const result = await API.getChats(profile.id);
    if (result.success && result.chats) {
      spendingDataCache.clear();
      for (const chat of result.chats) {
        // chat.id is the Firestore doc ID (e.g., "of:123456")
        // chat.notes.totalSpent is the scraped spending value (e.g., "$150.00")
        const chatId = chat.id || chat.subscriberOFId;
        if (chatId && chat.notes?.totalSpent) {
          const amount = parseSpentAmount(chat.notes.totalSpent);
          // Store with raw numeric ID (strip "of:" prefix) to match scraped chat list rawId
          spendingDataCache.set(
            chatId.replace(/^of:/, ''),
            { totalSpent: chat.notes.totalSpent, amount, tier: getSpendingTier(amount) }
          );
        }
      }
      console.log(`[ChatList] Loaded spending data for ${spendingDataCache.size} subscribers`);

      // ── Batch-sync spending to NYX CRM Firestore ──
      // The CRM dashboard reads totalSpent from Firestore, but it was never
      // being written there during normal chat list sync. Push it now.
      if (spendingDataCache.size > 0) {
        let synced = 0;
        for (const [rawId, data] of spendingDataCache) {
          if (data.amount > 0) {
            try {
              await chrome.runtime.sendMessage({
                type: 'NYX_CRM_SYNC_SPENDING',
                data: { subscriberId: rawId, totalSpent: data.totalSpent },
              });
              synced++;
            } catch (e) {
              // Silent — CRM bridge may not be connected, that's fine
            }
          }
        }
        if (synced > 0) {
          console.log(`[ChatList] ✅ Synced spending to NYX CRM for ${synced} subscribers`);
        }
      }
    }
  } catch (e) {
    console.warn('[ChatList] Could not load spending data:', e.message);
  }
};

// ============================================================
// AUTO-CHAT STATE CACHE (for response previews)
// ============================================================

let autoChatState = {
  enabled: false,
  activePool: []
};

// Get auto-chat info for a specific chat by rawId
export const getAutoChatInfo = (rawId) => {
  if (!autoChatState.enabled || !autoChatState.activePool) return null;
  
  const peerId = `of:${rawId}`;
  return autoChatState.activePool.find(c => c.peerId === peerId);
};

// Update auto-chat state
export const updateAutoChatState = (state) => {
  autoChatState = state || { enabled: false, activePool: [] };
};

// ============================================================
// CHAT LIST VIEW - Show/Hide Logic
// ============================================================

// Show chat list view (when no chat is open)
export const showChatListView = () => {
  const chatListView = $('chatListView');
  const chatConversationView = $('chatConversationView');
  const subscriberInfoBar = $('subscriberInfoBar');
  const autoChatPanelOF = $('autoChatPanelOF');
  
  // Check platform FIRST
  const isTelegram = document.body.classList.contains('telegram-platform');
  
  // TELEGRAM: Don't use chat list - show conversation view with empty state
  if (isTelegram) {
    console.log('[ChatList] Telegram: showing conversation view with empty state');
    if (chatListView) chatListView.classList.add('hidden');
    if (chatConversationView) chatConversationView.classList.remove('hidden');
    if (subscriberInfoBar) subscriberInfoBar.classList.add('hidden');
    
    // Clear messages and show empty state
    const chatMessages = $('chatMessages');
    if (chatMessages) {
      chatMessages.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">💬</div>
          <p>No conversation loaded</p>
          <small>Click on a chat in Telegram to see messages</small>
        </div>
      `;
    }
    
    // Keep OF panel hidden
    if (autoChatPanelOF) {
      autoChatPanelOF.style.display = 'none';
      autoChatPanelOF.classList.add('hidden');
    }
    return; // Don't try to load chat list for Telegram
  }
  
  // ONLYFANS: Show the chat list
  if (chatListView) chatListView.classList.remove('hidden');
  if (chatConversationView) chatConversationView.classList.add('hidden');
  if (subscriberInfoBar) subscriberInfoBar.classList.add('hidden');
  
  // Show OnlyFans auto-chat panel in list view
  if (autoChatPanelOF) {
    autoChatPanelOF.style.display = '';
    autoChatPanelOF.classList.remove('hidden');
  }
  
  // Load the chat list (OnlyFans only)
  loadChatList();
};

// Show conversation view (when a chat is open)
export const showConversationView = () => {
  const chatListView = $('chatListView');
  const chatConversationView = $('chatConversationView');
  const autoChatPanelOF = $('autoChatPanelOF');
  
  if (chatListView) chatListView.classList.add('hidden');
  if (chatConversationView) chatConversationView.classList.remove('hidden');
  
  // Hide OnlyFans auto-chat panel in conversation view
  if (autoChatPanelOF) autoChatPanelOF.style.display = 'none';
};

// ============================================================
// CHAT LIST - Load and Render
// ============================================================

// Load all chats by scraping from OnlyFans page
export const loadChatList = async () => {
  const chatListLoading = $('chatListLoading');
  const chatListEmpty = $('chatListEmpty');
  const chatListItems = $('chatListItems');
  const chatListCount = $('chatListCount');
  
  // Show loading state
  if (chatListLoading) chatListLoading.classList.remove('hidden');
  if (chatListEmpty) chatListEmpty.classList.add('hidden');
  if (chatListItems) chatListItems.innerHTML = '';
  
  try {
    // Load spending data from stored notes (parallel with chat list scrape)
    const spendingPromise = loadSpendingData();
    
    // Request chat list from content script (scrapes from OnlyFans page)
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]?.id || !tabs[0]?.url?.includes('onlyfans.com')) {
      console.log('[ChatList] Not on OnlyFans tab');
      if (chatListLoading) chatListLoading.classList.add('hidden');
      renderChatListEmpty('Open OnlyFans to see chats');
      return;
    }
    
    const response = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_CHAT_LIST' }, (res) => {
        if (chrome.runtime.lastError) {
          console.error('[ChatList] Error:', chrome.runtime.lastError?.message || 'Content script not responding');
          resolve({ success: false, error: chrome.runtime.lastError?.message || 'Content script error' });
          return;
        }
        console.log('[ChatList] Got response:', res?.success, res?.chats?.length || 0, 'chats');
        resolve(res || { success: false });
      });
    });
    
    // Wait for spending data before rendering
    await spendingPromise;
    
    console.log('[ChatList] Response from content script:', response);
    
    if (chatListLoading) chatListLoading.classList.add('hidden');
    
    if (response.success && response.chats && response.chats.length > 0) {
      renderChatList(response.chats);
      if (chatListCount) chatListCount.textContent = `${response.chats.length} chats`;

      // ── NYX CRM: Sync chat list on the PULL path ──
      // The push path (OF_CHAT_LIST_UPDATED via MutationObserver) only fires on DOM changes.
      // This pull path fires every time the sidepanel opens/refreshes the chat list,
      // ensuring Firestore timestamps + spending stay fresh even if MutationObserver is silent.
      try {
        const enrichedChats = response.chats.map(chat => {
          const rawId = chat.rawId || chat.id?.replace(/^of:/, '') || '';
          const spendData = spendingDataCache.get(rawId);
          return {
            ...chat,
            totalSpent: spendData?.totalSpent || null,
          };
        });
        console.log(`[ChatList] 📋 Sending ${enrichedChats.length} enriched chats to NYX CRM...`);
        chrome.runtime.sendMessage({
          type: 'NYX_CRM_SYNC_CHAT_LIST',
          data: { chatList: enrichedChats },
        }).catch(() => {});
      } catch (e) {
        // Silent — CRM sync failure should never break the sidepanel
      }
    } else {
      renderChatListEmpty('No chats visible on page');
      if (chatListCount) chatListCount.textContent = '0 chats';
    }
  } catch (error) {
    console.error('[ChatList] Error loading chats:', error);
    if (chatListLoading) chatListLoading.classList.add('hidden');
    renderChatListEmpty('Error loading chats');
  }
};

// Render the chat list
export const renderChatList = (chats) => {
  const chatListItems = $('chatListItems');
  const chatListEmpty = $('chatListEmpty');
  
  if (!chatListItems) return;
  
  if (chatListEmpty) chatListEmpty.classList.add('hidden');
  
  chatListItems.innerHTML = chats.map(chat => {
    const subscriberName = chat.subscriberName || 'Unknown';
    const handle = chat.handle || '';
    const preview = chat.lastMessagePreview || '';
    const timeText = chat.timeText || '';
    const isOnline = chat.isOnline || false;
    const hasUnread = chat.hasUnread || false;
    
    // Use rawId from scraped data or extract from id
    const rawId = chat.rawId || chat.id.replace(/^(of:|tg:)/, '');
    
    // Get auto-chat info for this chat
    const autoChatInfo = getAutoChatInfo(rawId);
    
    // Get spending data for this subscriber
    const spendData = spendingDataCache.get(rawId);
    const tier = spendData?.tier || null;
    
    // Build classes
    const itemClasses = ['chat-list-item'];
    if (hasUnread) itemClasses.push('unread');
    if (autoChatInfo) itemClasses.push('has-autochat');
    if (autoChatInfo?.status === 'ready') itemClasses.push('autochat-ready');
    if (tier && tier.tier !== 'free') itemClasses.push(`tier-${tier.tier}`);
    
    // Build auto-chat preview HTML
    let autoChatPreviewHtml = '';
    if (autoChatInfo) {
      const status = autoChatInfo.status;
      let statusIcon = '';
      let statusText = '';
      
      switch (status) {
        case 'waiting':
        case 'pre_generating':
          const timeLeft = autoChatInfo.waitingUntil ? Math.max(0, Math.round((autoChatInfo.waitingUntil - Date.now()) / 1000)) : 0;
          statusIcon = '⏳';
          statusText = timeLeft > 0 ? `Waiting ${timeLeft}s` : 'Processing...';
          break;
        case 'generating':
          statusIcon = '🔄';
          statusText = 'Generating...';
          break;
        case 'ready':
          statusIcon = '✅';
          statusText = 'Ready to send';
          break;
        case 'sending':
          statusIcon = '📤';
          statusText = 'Sending...';
          break;
        case 'retrying':
          statusIcon = '🔄';
          statusText = autoChatInfo.error || 'Retrying...';
          break;
        case 'error':
          statusIcon = '❌';
          statusText = 'Error';
          break;
        default:
          statusIcon = '🤖';
          statusText = status;
      }
      
      autoChatPreviewHtml = `
        <div class="autochat-preview" data-peer-id="of:${escapeHtml(rawId)}">
          <div class="autochat-status">
            <span class="autochat-status-icon">${statusIcon}</span>
            <span class="autochat-status-text">${escapeHtml(statusText)}</span>
          </div>
          ${autoChatInfo.generatedResponse ? `
            <div class="autochat-response">${escapeHtml(autoChatInfo.generatedResponse.substring(0, 100))}${autoChatInfo.generatedResponse.length > 100 ? '...' : ''}</div>
            ${status === 'ready' ? `
              <div class="autochat-actions">
                <button class="btn btn-xs btn-send autochat-send-btn" data-peer-id="of:${escapeHtml(rawId)}">Send</button>
                <button class="btn btn-xs btn-secondary autochat-regen-btn" data-peer-id="of:${escapeHtml(rawId)}">🔄</button>
              </div>
            ` : ''}
          ` : ''}
        </div>
      `;
    }
    
    // Build spent badge HTML
    let spentBadgeHtml = '';
    if (spendData && spendData.amount > 0) {
      spentBadgeHtml = `<span class="spent-badge tier-${tier.tier}" style="--tier-color: ${tier.color}; --tier-glow: ${tier.glow}">${escapeHtml(spendData.totalSpent)}</span>`;
    }
    
    // Inline border style for tier color
    const tierStyle = (tier && tier.tier !== 'free') 
      ? `style="border-left: 3px solid ${tier.color}; background: linear-gradient(135deg, ${tier.glow}, transparent);"` 
      : '';
    
    return `
      <div class="${itemClasses.join(' ')}" data-chat-id="${escapeHtml(chat.id)}" data-raw-id="${escapeHtml(rawId)}" ${tierStyle}>
        <div class="chat-list-avatar ${isOnline ? 'online' : ''}">👤</div>
        <div class="chat-list-content">
          <div class="chat-list-top">
            <span class="chat-list-name">${escapeHtml(subscriberName)}</span>
            <div class="chat-list-top-right">
              ${spentBadgeHtml}
              <span class="chat-list-time">${escapeHtml(timeText)}</span>
            </div>
          </div>
          ${handle ? `<div class="chat-list-handle">${escapeHtml(handle)}</div>` : ''}
          <div class="chat-list-preview">${escapeHtml(preview)}</div>
          ${autoChatPreviewHtml}
        </div>
      </div>
    `;
  }).join('');
  
  // Add click handlers to navigate to chat on OnlyFans
  chatListItems.querySelectorAll('.chat-list-item').forEach(item => {
    // Navigate only when clicking the main content (not the action buttons)
    item.addEventListener('click', (e) => {
      // Don't navigate if clicking action buttons
      if (e.target.closest('.autochat-actions')) return;
      
      const rawId = item.dataset.rawId;
      const chatId = item.dataset.chatId;
      
      if (rawId) {
        navigateToChat(rawId, chatId);
      }
    });
  });
  
  // Add auto-chat action button handlers
  chatListItems.querySelectorAll('.autochat-send-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const peerId = btn.dataset.peerId;
      if (peerId) {
        console.log('[Chat] Send auto-chat response for:', peerId);
        chrome.runtime.sendMessage({ 
          type: 'OF_AUTOCHAT_SEND_MESSAGE', 
          data: { peerId } 
        }).catch(console.error);
      }
    });
  });
  
  chatListItems.querySelectorAll('.autochat-regen-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const peerId = btn.dataset.peerId;
      if (peerId) {
        console.log('[Chat] Regenerate auto-chat response for:', peerId);
        chrome.runtime.sendMessage({ 
          type: 'OF_AUTOCHAT_REGENERATE', 
          data: { peerId } 
        }).catch(console.error);
      }
    });
  });
};

// Render empty state for chat list
const renderChatListEmpty = (message = null) => {
  const chatListEmpty = $('chatListEmpty');
  const chatListItems = $('chatListItems');
  
  if (chatListItems) chatListItems.innerHTML = '';
  
  if (chatListEmpty) {
    chatListEmpty.classList.remove('hidden');
    if (message) {
      chatListEmpty.innerHTML = `
        <div class="empty-icon">💬</div>
        <p>${escapeHtml(message)}</p>
        <small>Open a chat on OnlyFans to get started</small>
      `;
    }
  }
};

// Navigate to a specific chat on OnlyFans
const navigateToChat = async (rawSubscriberId, fullChatId) => {
  try {
    // Determine platform from the chatId prefix
    const isOnlyFans = fullChatId.startsWith('of:') || !fullChatId.includes(':');
    const isTelegram = fullChatId.startsWith('tg:');
    
    let targetUrl;
    if (isOnlyFans) {
      targetUrl = `https://onlyfans.com/my/chats/chat/${rawSubscriberId}`;
    } else if (isTelegram) {
      targetUrl = `https://web.telegram.org/a/#${rawSubscriberId}`;
    } else {
      console.error('[ChatList] Unknown platform for chat:', fullChatId);
      return;
    }
    
    console.log('[ChatList] Navigating to:', targetUrl);
    
    // Find or create a tab for this platform
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const platformTab = tabs.find(tab => {
      if (isOnlyFans) return tab.url?.includes('onlyfans.com');
      if (isTelegram) return tab.url?.includes('web.telegram.org');
      return false;
    });
    
    if (platformTab) {
      // Update existing tab
      await chrome.tabs.update(platformTab.id, { url: targetUrl, active: true });
    } else {
      // Create new tab
      await chrome.tabs.create({ url: targetUrl, active: true });
    }
    
    showNotification('Opening chat...');
  } catch (error) {
    console.error('[ChatList] Error navigating to chat:', error);
    showNotification('Failed to open chat');
  }
};

// Format timestamp to "time ago" string
export const formatTimeAgo = (timestamp) => {
  if (!timestamp) return '';
  
  const now = Date.now();
  const time = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
  const diff = now - time;
  
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
};

// Setup refresh button listener
export const setupChatListListeners = () => {
  const refreshBtn = $('refreshChatsBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadChatList();
    });
  }
};