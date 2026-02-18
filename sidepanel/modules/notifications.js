// ============================================================
// GLOBAL NOTIFICATIONS MODULE
// Monitors unread messages across all chats (not just auto-chat)
// ============================================================

import { $, show, hide } from '../utils/dom.js';
import Store from '../state/store.js';

// ============================================================
// STATE
// ============================================================

let notificationState = {
  unreadCount: 0,
  alarmMuted: false,
  lastAlarmTime: 0,
  alarmInterval: null,
  audioContext: null,
  alarmPlaying: false
};

// ============================================================
// AUDIO FUNCTIONS
// ============================================================

// Play notification sound using Web Audio API
function playNotificationSound() {
  if (notificationState.alarmMuted || notificationState.alarmPlaying) return;
  
  try {
    notificationState.alarmPlaying = true;
    
    // Create audio context if not exists
    if (!notificationState.audioContext) {
      notificationState.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    // Resume if suspended
    if (notificationState.audioContext.state === 'suspended') {
      notificationState.audioContext.resume();
    }
    
    // Create a pleasant notification sound (two-tone chime)
    const now = notificationState.audioContext.currentTime;
    const duration = 0.15;
    
    // First tone (higher)
    const osc1 = notificationState.audioContext.createOscillator();
    const gain1 = notificationState.audioContext.createGain();
    osc1.connect(gain1);
    gain1.connect(notificationState.audioContext.destination);
    osc1.frequency.value = 880; // A5
    osc1.type = 'sine';
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + duration);
    osc1.start(now);
    osc1.stop(now + duration);
    
    // Second tone (lower, slightly delayed)
    const osc2 = notificationState.audioContext.createOscillator();
    const gain2 = notificationState.audioContext.createGain();
    osc2.connect(gain2);
    gain2.connect(notificationState.audioContext.destination);
    osc2.frequency.value = 660; // E5
    osc2.type = 'sine';
    gain2.gain.setValueAtTime(0.3, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.1 + duration);
    osc2.start(now + 0.1);
    osc2.stop(now + 0.1 + duration);
    
    // Third tone (even lower)
    const osc3 = notificationState.audioContext.createOscillator();
    const gain3 = notificationState.audioContext.createGain();
    osc3.connect(gain3);
    gain3.connect(notificationState.audioContext.destination);
    osc3.frequency.value = 550; // C#5
    osc3.type = 'sine';
    gain3.gain.setValueAtTime(0.25, now + 0.2);
    gain3.gain.exponentialRampToValueAtTime(0.01, now + 0.2 + duration * 1.5);
    osc3.start(now + 0.2);
    osc3.stop(now + 0.2 + duration * 1.5);
    
    // Reset flag after sound completes
    setTimeout(() => {
      notificationState.alarmPlaying = false;
    }, 500);
    
  } catch (e) {
    console.error('[Notifications] Error playing sound:', e);
    notificationState.alarmPlaying = false;
  }
}

// ============================================================
// NOTIFICATION MANAGEMENT
// ============================================================

// Update notification bell UI
function updateNotificationBell() {
  const bellBtn = $('notificationBellBtn');
  const badge = $('notificationBadge');
  
  if (!bellBtn) return;
  
  // Update mute state
  bellBtn.classList.toggle('muted', notificationState.alarmMuted);
  bellBtn.title = notificationState.alarmMuted ? 'Unmute notifications' : 'Mute notifications';
  
  // Update badge
  if (badge) {
    if (notificationState.unreadCount > 0) {
      badge.textContent = notificationState.unreadCount > 99 ? '99+' : notificationState.unreadCount;
      badge.classList.remove('hidden');
      bellBtn.classList.add('has-unread');
    } else {
      badge.classList.add('hidden');
      bellBtn.classList.remove('has-unread');
    }
  }
}

// Set unread count and trigger notification if increased
export function setUnreadCount(count) {
  const previousCount = notificationState.unreadCount;
  notificationState.unreadCount = Math.max(0, count);
  
  updateNotificationBell();
  
  // If count increased and not muted, play sound
  if (count > previousCount && !notificationState.alarmMuted) {
    const now = Date.now();
    
    // Prevent alarm spam (minimum 5s between alarms)
    if (now - notificationState.lastAlarmTime >= 5000) {
      notificationState.lastAlarmTime = now;
      playNotificationSound();
      
      // Flash the bell
      const bellBtn = $('notificationBellBtn');
      if (bellBtn) {
        bellBtn.classList.add('notification-flash');
        setTimeout(() => {
          bellBtn.classList.remove('notification-flash');
        }, 2000);
      }
    }
  }
}

// Toggle mute state
export async function toggleMute() {
  notificationState.alarmMuted = !notificationState.alarmMuted;
  
  // Save preference for BOTH notification systems
  try {
    await chrome.storage.local.set({ 
      notificationsMuted: notificationState.alarmMuted,
      alarmMuted: notificationState.alarmMuted  // Also mute the continuous chat alarm
    });
  } catch (e) {
    console.error('[Notifications] Error saving mute preference:', e);
  }
  
  updateNotificationBell();
  
  // Also update the chat module's alarm state
  if (window.chatModule && window.chatModule.toggleAlarmMute) {
    window.chatModule.toggleAlarmMute(notificationState.alarmMuted);
  }
  
  return notificationState.alarmMuted;
}

// Load saved preferences
export async function loadPreferences() {
  try {
    const result = await chrome.storage.local.get('notificationsMuted');
    notificationState.alarmMuted = result.notificationsMuted === true;
    console.log('[Notifications] Preference loaded:', notificationState.alarmMuted ? 'muted' : 'unmuted');
    updateNotificationBell();
  } catch (e) {
    console.error('[Notifications] Error loading preferences:', e);
  }
}

// ============================================================
// MESSAGE MONITORING
// ============================================================

// Listen for unread count updates from background or content scripts
export function setupMessageListeners() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'UNREAD_COUNT_UPDATE') {
      setUnreadCount(message.data.count);
    }
    
    // Also listen for OF chat list updates to count unread
    if (message.type === 'OF_CHAT_LIST_UPDATED' && message.data) {
      const unreadCount = message.data.filter(chat => chat.hasUnread).length;
      setUnreadCount(unreadCount);
    }
  });
}

// ============================================================
// UI SETUP
// ============================================================

// Add notification bell to header
export function addNotificationBell() {
  const headerActions = document.querySelector('.header-actions');
  if (!headerActions) return;
  
  // Check if already added
  if ($('notificationBellBtn')) return;
  
  // Check current platform - hide bell for Telegram
  const currentPlatform = Store.get('platform') || Store.get('selectedPlatform');
  const isTelegram = currentPlatform === 'telegram';
  
  // Create bell button with badge
  const bellHTML = `
    <button id="notificationBellBtn" class="notification-bell" title="Mute notifications" style="${isTelegram ? 'display: none;' : ''}">
      <span class="bell-icon">🔔</span>
      <span id="notificationBadge" class="notification-badge hidden">0</span>
    </button>
  `;
  
  // Insert before credits button
  const creditsBtn = $('creditsBtn');
  if (creditsBtn) {
    creditsBtn.insertAdjacentHTML('beforebegin', bellHTML);
  } else {
    headerActions.insertAdjacentHTML('afterbegin', bellHTML);
  }
  
  // Add click handler
  const bellBtn = $('notificationBellBtn');
  bellBtn?.addEventListener('click', async () => {
    const muted = await toggleMute();
    const icon = bellBtn.querySelector('.bell-icon');
    if (icon) {
      icon.textContent = muted ? '🔇' : '🔔';
    }
  });
  
  // Hide immediately if Telegram
  if (isTelegram && bellBtn) {
    bellBtn.classList.add('hidden');
    bellBtn.style.display = 'none';
  }
  
  // Initial update
  updateNotificationBell();
}

// ============================================================
// INITIALIZATION
// ============================================================

export function initNotifications() {
  console.log('[Notifications] Initializing global notification system...');
  
  // Add bell to header
  addNotificationBell();
  
  // Load preferences
  loadPreferences();
  
  // Setup listeners
  setupMessageListeners();
}

// ============================================================
// EXPORTS
// ============================================================

export default {
  initNotifications,
  setUnreadCount,
  toggleMute,
  loadPreferences
};