// ============================================================
// CHAT RENDERER MODULE - Handles message display and UI
// ============================================================

import Store from '../../state/store.js';
import { $, escapeHtml } from '../../utils/dom.js';
import { renderTaskDays } from './taskDays.js';

// Generate unique key for message deduplication
// Only dedupe if we have a REAL ID - don't dedupe based on content
const getMessageKey = (msg, index) => {
  // If message has a real ID from OnlyFans, use it
  if (msg.id && !msg.id.startsWith('temp-')) return `id:${msg.id}`;
  // If it has a datetime, use datetime + sender + first 20 chars of text
  if (msg.datetime) return `dt:${msg.datetime}|${msg.isFromMe ? '1' : '0'}|${(msg.text || '').substring(0, 20)}`;
  // Fallback: use position index (don't dedupe by content)
  return `idx:${index}`;
};

// Deduplicate messages for display - ONLY exact duplicates
export const deduplicateForDisplay = (messages) => {
  if (!messages || messages.length === 0) return [];
  
  const seen = new Set();
  return messages.filter((msg, index) => {
    const key = getMessageKey(msg, index);
    // Only skip if we have a REAL id collision
    if (key.startsWith('id:') && seen.has(key)) {
      console.log('[Chat] Skipping duplicate message:', key);
      return false;
    }
    seen.add(key);
    return true;
  });
};

// Sort messages chronologically (oldest first)
export const sortMessagesChronologically = (messages) => {
  if (!messages || messages.length === 0) return [];
  
  return [...messages].sort((a, b) => {
    // First priority: Use order field if available (DOM position)
    if (a.order !== undefined && b.order !== undefined) {
      return a.order - b.order;
    }
    
    // Second priority: Use datetime if available (ISO format)
    if (a.datetime && b.datetime) {
      return new Date(a.datetime).getTime() - new Date(b.datetime).getTime();
    }
    
    // Third priority: Parse time strings (e.g., "2:30 PM", "Yesterday 3:45 PM")
    if (a.time && b.time) {
      const timeA = parseMessageTime(a.time);
      const timeB = parseMessageTime(b.time);
      if (timeA && timeB) {
        return timeA.getTime() - timeB.getTime();
      }
    }
    
    // Fallback: Keep original order
    return 0;
  });
};

// Helper to parse time strings into dates
const parseMessageTime = (timeStr) => {
  if (!timeStr) return null;
  
  try {
    // Handle relative times
    const now = new Date();
    const lower = timeStr.toLowerCase();
    
    if (lower.includes('yesterday')) {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      // Extract time from string like "Yesterday 3:45 PM"
      const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (timeMatch) {
        let hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);
        const isPM = timeMatch[3].toUpperCase() === 'PM';
        if (isPM && hours !== 12) hours += 12;
        if (!isPM && hours === 12) hours = 0;
        yesterday.setHours(hours, minutes, 0, 0);
      }
      return yesterday;
    }
    
    // Handle times like "2:30 PM" (assume today)
    const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (timeMatch) {
      const today = new Date(now);
      let hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2]);
      const isPM = timeMatch[3].toUpperCase() === 'PM';
      if (isPM && hours !== 12) hours += 12;
      if (!isPM && hours === 12) hours = 0;
      today.setHours(hours, minutes, 0, 0);
      return today;
    }
    
    // Try direct date parse
    const parsed = new Date(timeStr);
    return isNaN(parsed.getTime()) ? null : parsed;
    
  } catch (e) {
    return null;
  }
};

// ============================================================
// DISPLAY CROSS-CHECK - Periodic check for stale display
// ============================================================

let crossCheckInterval = null;

// Start periodic cross-check (call once on init)
export const startDisplayCrossCheck = () => {
  if (crossCheckInterval) return; // Already running
  
  crossCheckInterval = setInterval(() => {
    // Skip cross-check if a preview or loading message is showing
    // — user is actively reviewing AI output, don't disrupt
    const hasPreview = document.getElementById('previewMessage');
    const hasLoading = document.getElementById('loadingMessage');
    if (hasPreview || hasLoading) return;
    
    if (Store.isDisplayStale()) {
      console.log('[Chat] ⚠️ Display stale detected by cross-check — re-rendering');
      renderChatMessages();
    }
  }, 5000); // Check every 5 seconds (reduced from 3s to minimize flashing)
  
  console.log('[Chat] Display cross-check started (every 5s)');
};

// Stop cross-check (cleanup)
export const stopDisplayCrossCheck = () => {
  if (crossCheckInterval) {
    clearInterval(crossCheckInterval);
    crossCheckInterval = null;
  }
};

// Render chat messages
export const renderChatMessages = () => {
  const rawMessages = Store.get('messages');
  // Deduplicate messages for display to avoid visual duplicates
  let messages = deduplicateForDisplay(rawMessages);
  
  // DO NOT re-sort here — messages are already in correct order from the merge
  // Re-sorting by 'order' or 'datetime' across sources causes scrambling
  // The merge in chatSync.js is the single source of truth for ordering
  
  const messageCount = $('messageCount');
  const chatMessages = $('chatMessages');
  const subscriberInfoBar = $('subscriberInfoBar');
  
  if (messageCount) messageCount.textContent = `${messages.length} messages`;
  
  // Show/hide subscriber info bar
  if (subscriberInfoBar) {
    subscriberInfoBar.classList.toggle('hidden', !messages.length);
  }
  
  // PRESERVE preview/loading elements — these are dynamically added by AI module
  // and must survive re-renders. Detach them, re-render messages, then re-attach.
  const previewMessage = document.getElementById('previewMessage');
  const loadingMessage = document.getElementById('loadingMessage');
  const savedPreview = previewMessage ? previewMessage.parentNode.removeChild(previewMessage) : null;
  const savedLoading = loadingMessage ? loadingMessage.parentNode.removeChild(loadingMessage) : null;
  
  if (!messages.length) {
    chatMessages.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">💬</div>
        <p>No conversation loaded</p>
        <small>Open a chat on OnlyFans or Telegram</small>
      </div>`;
    // Re-attach preview/loading even on empty state
    if (savedLoading) chatMessages.appendChild(savedLoading);
    if (savedPreview) chatMessages.appendChild(savedPreview);
    return;
  }
  
  chatMessages.innerHTML = messages.map(msg => {
    // Build media preview HTML
    let mediaHtml = '';
    if (msg.mediaThumbnail || msg.mediaUrl) {
      const thumbSrc = msg.mediaThumbnail || msg.mediaUrl;
      const isVideo = msg.mediaType === 'video';
      mediaHtml = `
        <div class="message-media ${isVideo ? 'is-video' : ''}">
          <img src="${thumbSrc}" alt="${isVideo ? 'Video' : 'Image'}" loading="lazy" class="message-media-thumb">
          ${isVideo ? '<div class="message-media-play">▶</div>' : ''}
        </div>`;
    } else if (msg.mediaType === 'ppv' && !msg.mediaThumbnail) {
      mediaHtml = `<div class="message-media is-ppv"><div class="message-media-lock">🔒</div></div>`;
    }
    
    // Build payment badge HTML
    let paymentHtml = '';
    if (msg.paymentStatus) {
      const isPaid = msg.paymentStatus === 'paid';
      const badgeClass = isPaid ? 'payment-paid' : 'payment-unpaid';
      const badgeIcon = isPaid ? '✅' : '⏳';
      const badgeText = isPaid 
        ? `${badgeIcon} ${msg.paymentAmount || ''} Paid`
        : `${badgeIcon} ${msg.paymentAmount || ''} Not paid yet`;
      paymentHtml = `<div class="message-payment ${badgeClass}">${badgeText}</div>`;
    }
    
    // Only show text if it's not just a media placeholder
    const isMediaOnly = msg.mediaType && /^\[.+\]$/.test(msg.text);
    const textHtml = (!isMediaOnly && msg.text) 
      ? `<div class="message-text">${escapeHtml(msg.text)}</div>` 
      : '';
    
    return `
      <div class="message ${msg.isFromMe ? 'from-me' : 'from-them'}${msg.paymentStatus ? ' has-payment' : ''}${msg.mediaType ? ' has-media' : ''}" ${msg.id ? `data-msg-id="${msg.id}"` : ''}>
        ${mediaHtml}
        ${textHtml}
        ${paymentHtml}
        ${msg.time ? `<div class="message-time">${escapeHtml(msg.time)}</div>` : ''}
      </div>`;
  }).join('');
  
  // Re-attach preview/loading elements after rendering messages
  if (savedLoading) chatMessages.appendChild(savedLoading);
  if (savedPreview) chatMessages.appendChild(savedPreview);
  
  // Scroll: if preview is showing, scroll to show it; otherwise scroll to bottom
  if (savedPreview) {
    savedPreview.scrollIntoView({ behavior: 'instant', block: 'end' });
  } else {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  
  // Mark that we've rendered the current message version
  Store.markRendered();
};

// Populate notes from chat
export const populateNotesFromChat = (notes) => {
  if (!notes) return;
  
  const fields = ['noteName', 'noteAge', 'noteLocation', 'noteJob', 'noteHobbies', 'noteKinks', 'noteOther'];
  const keys = ['name', 'age', 'location', 'job', 'hobbies', 'kinks', 'other'];
  
  fields.forEach((field, i) => {
    const el = $(field);
    if (el && notes[keys[i]]) el.value = notes[keys[i]];
  });
  
  // Store notes for smart merge
  Store.set('currentNotes', notes);
  
  displaySubscriberStats(notes);
};

// ============================================================
// SUBSCRIPTION DURATION - Auto-counting from anchor date
// ============================================================

// Format subscription duration from stored anchor date
// subscribedSince is an ISO date stored ONCE on first detection — never overwritten
// Display auto-updates every time this renders (now - anchor = live duration)
const formatSubscriptionDuration = (subscribedSince) => {
  if (!subscribedSince) return 'Day 1 ✨';
  
  const since = new Date(subscribedSince);
  if (isNaN(since.getTime())) return 'Day 1 ✨';
  
  const now = new Date();
  const diffMs = now - since;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  // Calculate months more accurately using calendar math
  let months = (now.getFullYear() - since.getFullYear()) * 12 + (now.getMonth() - since.getMonth());
  if (now.getDate() < since.getDate()) months--; // Haven't reached the day yet this month
  
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  
  // Day 1 (same day)
  if (diffDays === 0) return 'Day 1 ✨';
  
  // Days 2-6: "Day X"
  if (diffDays < 7) return `Day ${diffDays + 1}`;
  
  // 1-3 weeks: "X weeks"
  if (diffDays < 28) {
    const weeks = Math.floor(diffDays / 7);
    return `${weeks} week${weeks > 1 ? 's' : ''}`;
  }
  
  // 1-11 months: "X month(s)"
  if (months > 0 && months < 12) {
    return `${months} month${months > 1 ? 's' : ''}`;
  }
  
  // 1+ years: "X year(s) Y month(s)" or just "X year(s)"
  if (years >= 1) {
    let text = `${years} year${years > 1 ? 's' : ''}`;
    if (remainingMonths > 0) {
      text += ` ${remainingMonths}mo`;
    }
    return text;
  }
  
  // Fallback for edge case (less than a month but >= 28 days)
  return `${diffDays} days`;
};

// Display subscriber stats
export const displaySubscriberStats = (notes) => {
  if (!notes) notes = {};
  
  // Get current platform to determine what to show
  const currentPlatform = Store.get('currentPlatform');
  const isTelegram = currentPlatform === 'telegram';
  
  // Get the stats container elements
  const subscribedForContainer = $('subscribedFor')?.closest('.stat-item') || $('subscribedFor')?.parentElement;
  const totalSpentContainer = $('totalSpent')?.closest('.stat-item') || $('totalSpent')?.parentElement;
  
  // Hide OnlyFans-specific stats for Telegram
  if (subscribedForContainer) {
    subscribedForContainer.style.display = isTelegram ? 'none' : '';
  }
  if (totalSpentContainer) {
    totalSpentContainer.style.display = isTelegram ? 'none' : '';
  }
  
  // Only update stats if NOT Telegram
  if (!isTelegram) {
    const subscribedFor = $('subscribedFor');
    if (subscribedFor) {
      subscribedFor.textContent = formatSubscriptionDuration(notes.subscribedSince);
    }
    
    const totalSpent = $('totalSpent');
    if (totalSpent) {
      totalSpent.textContent = notes.totalSpent || '$0';
    }
  }
  
  // Render task days countdown
  renderTaskDays(notes);
};
