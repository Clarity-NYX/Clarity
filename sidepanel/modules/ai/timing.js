// AI Timing - Script completion checks, timing rules, delay calculations
import Store from '../../state/store.js';
import { $ } from '../../utils/dom.js';
import { showNotification } from '../../utils/notify.js';
import { getSubscriberScriptStats } from '../scripts/index.js';
import { getProfileNow } from '../scripts/timing.js';

// Countdown timer interval reference
let countdownInterval = null;

// Check if all script actions are complete
export const isScriptComplete = () => {
  const stats = getSubscriberScriptStats();
  return stats.total > 0 && stats.completed === stats.total;
};

// Check timing rules and return remaining wait time in ms (or 0 if can proceed)
export const checkTimingRules = () => {
  const currentScript = Store.get('currentScript');
  const messages = Store.get('messages');

  if (!currentScript?.timingSettings) {
    // Default: 30 minute delay if no settings
    return getDefaultDelay(messages, 30);
  }

  const settings = currentScript.timingSettings;

  // Use timezone-aware time from timing module (imported at top)
  // Uses profile's timezone setting instead of browser local time
  const profileNow = getProfileNow();
  const nowHour = profileNow.getHours();
  const nowMin = profileNow.getMinutes();
  const nowTotalMin = nowHour * 60 + nowMin;

  // Check "scheduled" mode - not before specific time (timezone-aware)
  if (settings.mode === 'scheduled' && settings.notBeforeTime) {
    const [hours, minutes] = settings.notBeforeTime.split(':').map(Number);
    const notBeforeTotalMin = hours * 60 + minutes;

    if (nowTotalMin < notBeforeTotalMin) {
      // Return remaining ms until notBefore time
      return (notBeforeTotalMin - nowTotalMin) * 60 * 1000;
    }
  }

  // Check "delay" mode - minimum time since last message
  const minMinutes = settings.minMinutes || 30; // Default 30 min if not set
  return getDefaultDelay(messages, minMinutes);
};

// Helper to calculate delay based on last message time
export const getDefaultDelay = (messages, minMinutes) => {
  if (!minMinutes || minMinutes <= 0) return 0;

  const now = new Date();

  // Find last message from "me" (creator)
  const myMessages = messages.filter(m => m.isFromMe);
  if (myMessages.length > 0) {
    const lastMyMessage = myMessages[myMessages.length - 1];
    let lastMsgTime = null;

    // Try parsing datetime
    if (lastMyMessage.datetime) {
      lastMsgTime = new Date(lastMyMessage.datetime);
    } else if (lastMyMessage.time) {
      // Parse time like "20:30" - assume today
      const [h, m] = lastMyMessage.time.split(':').map(Number);
      lastMsgTime = new Date();
      lastMsgTime.setHours(h, m, 0, 0);
    }

    if (lastMsgTime && !isNaN(lastMsgTime.getTime())) {
      const minWait = minMinutes * 60 * 1000;
      const canReplyAt = lastMsgTime.getTime() + minWait;
      const remaining = canReplyAt - now.getTime();

      if (remaining > 0) {
        return remaining;
      }
    }
  }

  return 0; // No wait required
};

// Format milliseconds to readable time
export const formatTimeRemaining = (ms) => {
  if (ms <= 0) return 'Ready!';

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  } else {
    return `${seconds}s`;
  }
};

// Show script complete / timeout message - timer in button
export const showTimeoutMessage = (remainingMs) => {
  // Clear existing countdown if any
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  if (remainingMs <= 0) return; // No timeout needed

  const generateBtn = $('generateBtn');
  if (!generateBtn) return;

  // Store original button content
  const originalHTML = generateBtn.innerHTML;

  // Disable and gray out button, show timer inside
  generateBtn.disabled = true;
  generateBtn.classList.add('btn-timeout');
  generateBtn.innerHTML = `
    <span class="btn-icon">⏰</span>
    <span class="btn-text">✅ Script Complete! <span id="timeoutCounter">${formatTimeRemaining(remainingMs)}</span></span>
  `;

  // Start countdown
  let remaining = remainingMs;
  countdownInterval = setInterval(() => {
    remaining -= 1000;
    const counter = document.getElementById('timeoutCounter');

    if (remaining <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;

      // Restore button
      generateBtn.disabled = false;
      generateBtn.classList.remove('btn-timeout');
      generateBtn.innerHTML = originalHTML;

      showNotification('Ready to respond!');
    } else if (counter) {
      counter.textContent = formatTimeRemaining(remaining);
    }
  }, 1000);
};

// Clear timeout message and restore button
export const clearTimeoutMessage = () => {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  const generateBtn = $('generateBtn');
  if (generateBtn && generateBtn.classList.contains('btn-timeout')) {
    generateBtn.disabled = false;
    generateBtn.classList.remove('btn-timeout');
    generateBtn.innerHTML = `
      <span class="btn-icon">🤖</span>
      <span class="btn-text">Generate Response</span>
    `;
  }
};
