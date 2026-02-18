// ============================================================
// CHAT RENDERER MODULE - Handles message display and UI
// ============================================================

import Store from '../../state/store.js';
import { $, escapeHtml } from '../../utils/dom.js';

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

// Render chat messages
export const renderChatMessages = () => {
  const rawMessages = Store.get('messages');
  // Deduplicate messages for display to avoid visual duplicates
  let messages = deduplicateForDisplay(rawMessages);
  
  // CRITICAL: Sort messages by order/datetime to ensure chronological display
  messages = sortMessagesChronologically(messages);
  
  const messageCount = $('messageCount');
  const chatMessages = $('chatMessages');
  const subscriberInfoBar = $('subscriberInfoBar');
  
  if (messageCount) messageCount.textContent = `${messages.length} messages`;
  
  // Show/hide subscriber info bar
  if (subscriberInfoBar) {
    subscriberInfoBar.classList.toggle('hidden', !messages.length);
  }
  
  if (!messages.length) {
    chatMessages.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">💬</div>
        <p>No conversation loaded</p>
        <small>Open a chat on OnlyFans or Telegram</small>
      </div>`;
    return;
  }
  
  chatMessages.innerHTML = messages.map(msg => `
    <div class="message ${msg.isFromMe ? 'from-me' : 'from-them'}">
      <div class="message-text">${escapeHtml(msg.text)}</div>
      ${msg.time ? `<div class="message-time">${msg.time}</div>` : ''}
    </div>`
  ).join('');
  
  chatMessages.scrollTop = chatMessages.scrollHeight;
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
      if (notes.subscribedSince) {
        const since = new Date(notes.subscribedSince);
        const now = new Date();
        const diffDays = Math.floor((now - since) / (1000 * 60 * 60 * 24));
        
        let displayText = '';
        if (diffDays === 0) displayText = 'Day 1 ✨';
        else if (diffDays < 7) displayText = `${diffDays + 1} day${diffDays !== 0 ? 's' : ''}`;
        else if (diffDays < 30) displayText = `${Math.floor(diffDays / 7)} week${Math.floor(diffDays / 7) !== 1 ? 's' : ''}`;
        else if (diffDays < 365) displayText = `${Math.floor(diffDays / 30)} month${Math.floor(diffDays / 30) !== 1 ? 's' : ''}`;
        else displayText = `${Math.floor(diffDays / 365)} year${Math.floor(diffDays / 365) !== 1 ? 's' : ''}`;
        
        subscribedFor.textContent = displayText;
      } else {
        // New subscriber - no subscription date yet means Day 1
        subscribedFor.textContent = 'Day 1 ✨';
      }
    }
    
    const totalSpent = $('totalSpent');
    if (totalSpent) {
      totalSpent.textContent = notes.totalSpent || '$0';
    }
  }
};