// ============================================================
// CHAT ALARM MODULE - Manages unread chat notifications
// ============================================================

import { showNotification } from '../../utils/notify.js';

// Audio context for alarm
let audioContext = null;
let alarmInterval = null;
let isAlarmMuted = false; // Default to unmuted - alarm is active by default
let currentUnreadChats = [];
let alarmEnabled = true; // Default enabled - ring for unreads

// Initialize alarm state
export const initAlarmState = async () => {
  try {
    // Check BOTH alarm settings (either can mute)
    const result = await chrome.storage.local.get(['alarmMuted', 'notificationsMuted']);
    // Mute if either setting is true
    isAlarmMuted = result.alarmMuted === true || result.notificationsMuted === true;
    alarmEnabled = true; // Always enabled - use mute toggle to silence
    console.log('[Chat] Alarm state loaded:', isAlarmMuted ? 'muted' : 'active');
  } catch (e) {
    console.warn('[Chat] Could not load alarm state');
  }
};

// Play single alarm sound
const playUnreadAlarm = () => {
  // Don't play if muted OR if alarm feature is disabled
  if (isAlarmMuted || !alarmEnabled) return;
  
  try {
    // Create audio context if not exists
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    // Resume if suspended
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
    
    // Create a pleasant notification sound (two-tone chime)
    const playTone = (freq, startTime, duration) => {
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      oscillator.frequency.value = freq;
      oscillator.type = 'sine';
      
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(0.3, startTime + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
      
      oscillator.start(startTime);
      oscillator.stop(startTime + duration);
    };
    
    const now = audioContext.currentTime;
    
    // Play a pleasant two-tone notification
    playTone(880, now, 0.15);       // A5
    playTone(1100, now + 0.12, 0.2); // C#6 (higher)
    
  } catch (error) {
    console.error('[Chat] Error playing alarm:', error);
  }
};

// Start continuous alarm (plays every 10 seconds while unread chats exist)
const startContinuousAlarm = (unreadChats) => {
  currentUnreadChats = unreadChats || [];
  
  // Don't start if muted or no unreads
  if (isAlarmMuted || currentUnreadChats.length === 0) {
    stopContinuousAlarm();
    return;
  }
  
  // Don't start if already running
  if (alarmInterval) return;
  
  console.log('[Chat] 🔔 Starting continuous alarm for', currentUnreadChats.length, 'unread chats');
  
  // Play immediately
  playUnreadAlarm();
  
  // Then every 10 seconds
  alarmInterval = setInterval(() => {
    if (isAlarmMuted || currentUnreadChats.length === 0) {
      stopContinuousAlarm();
      return;
    }
    playUnreadAlarm();
  }, 10000); // Every 10 seconds
};

// Stop continuous alarm
const stopContinuousAlarm = () => {
  if (alarmInterval) {
    console.log('[Chat] 🔇 Stopping continuous alarm');
    clearInterval(alarmInterval);
    alarmInterval = null;
  }
  currentUnreadChats = [];
};

// Update unread chats (called from chat list updates)
// Only trigger alarm for chats with actual unread badge - NOT just "their message is last"
export const updateUnreadChats = (chats) => {
  // Filter to ONLY chats with the unread indicator badge
  // hasUnread means there's an actual unread notification badge on the chat
  const unreadChats = (chats || []).filter(c => c.hasUnread);
  
  // Debug: show which chats have unreads
  if (chats && chats.length > 0) {
    const unreadNames = unreadChats.map(c => c.subscriberName).join(', ');
    console.log('[Chat] Unread check:', unreadChats.length, 'of', chats.length, 'chats have unread badge:', unreadNames || 'none');
  }
  
  // Only update if the count changed
  const hadUnreads = currentUnreadChats.length > 0;
  const hasUnreads = unreadChats.length > 0;
  
  currentUnreadChats = unreadChats;
  
  if (hasUnreads && !isAlarmMuted) {
    startContinuousAlarm(unreadChats);
  } else if (!hasUnreads && hadUnreads) {
    // Only stop if we previously had unreads
    stopContinuousAlarm();
  } else if (!hasUnreads) {
    // Make sure alarm is stopped if no unreads
    stopContinuousAlarm();
  }
};

// Handle new unread detection
export const handleNewUnreadDetected = (data) => {
  console.log('[Chat] 🔔 New unread detected!', data.count, 'chats');
  // Update continuous alarm with new unread chats
  updateUnreadChats(data.chats || []);
  // Show notification (one time)
  const names = data.chats?.map(c => c.name).join(', ') || 'New messages';
  showNotification(`🔔 ${data.count} unread: ${names}`);
};

// Toggle alarm mute
export const toggleAlarmMute = async (muted) => {
  isAlarmMuted = muted;
  await chrome.storage.local.set({ alarmMuted: muted });
  
  if (muted) {
    stopContinuousAlarm();
  } else if (currentUnreadChats.length > 0) {
    startContinuousAlarm(currentUnreadChats);
  }
  
  return isAlarmMuted;
};

// Initialize on module load
initAlarmState();