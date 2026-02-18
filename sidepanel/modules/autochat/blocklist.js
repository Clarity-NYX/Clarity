// ============================================================
// AUTOCHAT BLOCKLIST - Block List Management from working autochat.js
// ============================================================

import { showNotification } from '../../utils/notify.js';
import { 
  blockedUsers, 
  blockListCollapsed,
  setBlockListCollapsed,
  setBlockedUsers,
  addBlockedUser,
  removeBlockedUser
} from './state.js';

// ============================================================
// RENDER FUNCTIONS
// ============================================================

// Render the block list panel
export function renderBlockListPanel() {
  const container = document.getElementById('blockListPanel');
  if (!container) return;
  
  container.className = `blocklist-panel ${blockListCollapsed ? 'collapsed' : 'expanded'}`;
  
  // Update count badge
  const countBadge = document.getElementById('blockListCount');
  if (countBadge) {
    countBadge.textContent = `${blockedUsers.length} blocked`;
  }
  
  // Update arrow
  const arrow = document.getElementById('blockListArrow');
  if (arrow) {
    arrow.textContent = blockListCollapsed ? '▶' : '▼';
  }
  
  // Render blocked users list
  renderBlockedUsersList();
}

// Render the list of blocked users
function renderBlockedUsersList() {
  const listContainer = document.getElementById('blockedUsersList');
  if (!listContainer) return;
  
  if (blockedUsers.length === 0) {
    listContainer.innerHTML = `
      <div class="blocklist-empty">
        <span class="blocklist-empty-icon">✅</span>
        <p>No blocked users</p>
        <small>Users you block will appear here</small>
      </div>
    `;
    return;
  }
  
  listContainer.innerHTML = blockedUsers.map(user => `
    <div class="blocked-user-item" data-id="${user.subscriberId || user.id}">
      <div class="blocked-user-info">
        <span class="blocked-user-name">${user.subscriberName || user.name || 'Unknown'}</span>
        <span class="blocked-user-id">ID: ${user.subscriberId || user.id}</span>
        ${user.reason ? `<span class="blocked-user-reason">${user.reason}</span>` : ''}
      </div>
      <div class="blocked-user-actions">
        <button class="unblock-btn" data-id="${user.subscriberId || user.id}" title="Unblock user">
          ✓ Unblock
        </button>
      </div>
    </div>
  `).join('');
  
  // Attach unblock event listeners
  listContainer.querySelectorAll('.unblock-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const userId = btn.dataset.id;
      await unblockUser(userId);
    });
  });
}

// ============================================================
// API FUNCTIONS
// ============================================================

// Load blocked users from API
export async function loadBlockedUsers() {
  try {
    const Store = (await import('../../state/store.js')).default;
    const profileId = Store.get('currentProfile')?.id;
    
    if (!profileId) {
      console.log('[BlockList] No profile selected');
      return;
    }
    
    console.log('[BlockList] Loading blocked users...');
    
    const response = await chrome.runtime.sendMessage({
      type: 'GET_BLOCKED_USERS',
      data: { profileId }
    });
    
    if (response.success) {
      setBlockedUsers(response.blockedUsers || []);
      console.log(`[BlockList] Loaded ${blockedUsers.length} blocked users`);
      renderBlockListPanel();
    }
  } catch (error) {
    console.error('[BlockList] Error loading blocked users:', error);
  }
}

// Block a user by ID or username
export async function blockUser(userIdOrName, userName = null) {
  try {
    const Store = (await import('../../state/store.js')).default;
    const profileId = Store.get('currentProfile')?.id;
    
    if (!profileId) {
      showNotification('❌ No profile selected');
      return false;
    }
    
    if (!userIdOrName?.trim()) {
      showNotification('❌ Please enter a username or ID');
      return false;
    }
    
    const subscriberId = userIdOrName.trim();
    const subscriberName = userName || subscriberId;
    
    console.log(`[BlockList] Blocking user: ${subscriberName} (${subscriberId})`);
    
    const response = await chrome.runtime.sendMessage({
      type: 'ADD_BLOCKED_USER',
      data: { 
        profileId, 
        subscriberId, 
        subscriberName,
        reason: 'manual_block'
      }
    });
    
    if (response.success) {
      // Add to local list
      addBlockedUser({ subscriberId, subscriberName, reason: 'manual_block' });
      
      // Notify background to update cache
      await chrome.runtime.sendMessage({
        type: 'AUTOCHAT_USER_BLOCKED',
        data: { profileId, subscriberId, subscriberName }
      }).catch(() => {});
      
      renderBlockListPanel();
      showNotification(`🚫 Blocked: ${subscriberName}`);
      return true;
    } else {
      showNotification('❌ Failed to block user');
      return false;
    }
  } catch (error) {
    console.error('[BlockList] Error blocking user:', error);
    showNotification('❌ Error blocking user');
    return false;
  }
}

// Unblock a user
export async function unblockUser(userId) {
  try {
    const Store = (await import('../../state/store.js')).default;
    const profileId = Store.get('currentProfile')?.id;
    
    if (!profileId || !userId) return false;
    
    const user = blockedUsers.find(u => (u.subscriberId || u.id) === userId);
    const userName = user?.subscriberName || user?.name || userId;
    
    console.log(`[BlockList] Unblocking user: ${userName} (${userId})`);
    
    const response = await chrome.runtime.sendMessage({
      type: 'REMOVE_BLOCKED_USER',
      data: { profileId, subscriberId: userId }
    });
    
    if (response.success) {
      // Remove from local list
      removeBlockedUser(userId);
      
      renderBlockListPanel();
      showNotification(`✅ Unblocked: ${userName}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('[BlockList] Error unblocking user:', error);
    return false;
  }
}

// Block the current chat
export async function blockCurrentChat() {
  try {
    const Store = (await import('../../state/store.js')).default;
    const subscriberId = Store.get('currentSubscriberId');
    const subscriberName = Store.get('storedChat')?.subscriberName;
    
    if (!subscriberId) {
      showNotification('❌ No chat currently open');
      return false;
    }
    
    return await blockUser(subscriberId, subscriberName);
  } catch (error) {
    console.error('[BlockList] Error blocking current chat:', error);
    return false;
  }
}

// ============================================================
// EVENT LISTENERS
// ============================================================

// Setup block list event listeners
export function setupBlockListListeners() {
  // Toggle collapse/expand
  const headerToggle = document.getElementById('blockListHeaderToggle');
  headerToggle?.addEventListener('click', (e) => {
    // Don't toggle if clicking the settings button
    if (e.target.closest('#blockListSettingsBtn')) return;
    
    setBlockListCollapsed(!blockListCollapsed);
    const body = document.getElementById('blockListBody');
    if (body) {
      body.classList.toggle('hidden', blockListCollapsed);
    }
    renderBlockListPanel();
  });
  
  // Block user button
  const blockUserBtn = document.getElementById('blockUserBtn');
  blockUserBtn?.addEventListener('click', async () => {
    const input = document.getElementById('blockUserInput');
    const value = input?.value?.trim();
    
    if (value) {
      const success = await blockUser(value);
      if (success && input) {
        input.value = '';
      }
    }
  });
  
  // Block user on Enter key
  const blockUserInput = document.getElementById('blockUserInput');
  blockUserInput?.addEventListener('keypress', async (e) => {
    if (e.key === 'Enter') {
      const value = blockUserInput.value?.trim();
      if (value) {
        const success = await blockUser(value);
        if (success) {
          blockUserInput.value = '';
        }
      }
    }
  });
  
  // Block current chat button
  const blockCurrentBtn = document.getElementById('blockCurrentChatBtn');
  blockCurrentBtn?.addEventListener('click', blockCurrentChat);
  
  // Refresh button
  const refreshBtn = document.getElementById('refreshBlockListBtn');
  refreshBtn?.addEventListener('click', loadBlockedUsers);
}
