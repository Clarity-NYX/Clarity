// ============================================================
// CHAT RENDERER MODULE - Handles message display and UI
// ============================================================

import Store from '../../state/store.js';
import { $, escapeHtml } from '../../utils/dom.js';
import { renderTaskDays } from './taskDays.js';

// Generate unique key for message deduplication
// Only dedupe if we have a REAL ID - don't dedupe based on content
export const getMessageKey = (msg, index) => {
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
    // Skip cross-check if a delete operation is in progress
    if (Store.get('_deleteInProgress')) return;
    
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
  const draftBar = document.getElementById('draftBar');
  const savedPreview = previewMessage ? previewMessage.parentNode.removeChild(previewMessage) : null;
  const savedLoading = loadingMessage ? loadingMessage.parentNode.removeChild(loadingMessage) : null;
  const savedDraft = draftBar ? draftBar.parentNode.removeChild(draftBar) : null;
  
  if (!messages.length) {
    chatMessages.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">💬</div>
        <p>No conversation loaded</p>
        <small>Open a chat on OnlyFans or Telegram</small>
      </div>`;
    // Re-attach draft/preview/loading even on empty state
    if (savedDraft) chatMessages.appendChild(savedDraft);
    if (savedLoading) chatMessages.appendChild(savedLoading);
    if (savedPreview) chatMessages.appendChild(savedPreview);
    return;
  }
  
  // Displayed-chat translation: if a display language is active, substitute
  // each message's text with its native-sounding translation (keyed by msg key)
  const displayLang = Store.get('chatDisplayLang');
  const translations = Store.get('chatTranslations');

  chatMessages.innerHTML = messages.map((msg, idx) => {
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
    
    // Build reply quote HTML (for messages that are replies to another message)
    let replyHtml = '';
    if (msg.replyTo && (msg.replyTo.text || msg.replyTo.author)) {
      const replyAuthor = msg.replyTo.author ? `<span class="reply-author">${escapeHtml(msg.replyTo.author)}</span>` : '';
      const replyText = msg.replyTo.text ? `<span class="reply-text">${escapeHtml(msg.replyTo.text)}</span>` : '';
      replyHtml = `<div class="message-reply-quote">${replyAuthor}${replyText}</div>`;
    }
    
    // Only show text if it's not just a media placeholder
    const isMediaOnly = msg.mediaType && /^\[.+\]$/.test(msg.text);
    // Deduplicate: if msg.text is identical to msg.replyTo.text, don't show it twice
    let displayText = msg.text;
    // If a display language is active, substitute the translated text (keyed by
    // message key so translations stay attached to the right bubble on re-render)
    if (displayLang && translations) {
      const translated = translations[getMessageKey(msg, idx)];
      if (translated) displayText = translated;
    }
    if (msg.replyTo?.text && displayText) {
      const clean = (s) => s.replace(/^[""\u201C\u201D]\s*/, '').replace(/\s*[""\u201C\u201D]$/, '').trim();
      if (clean(displayText) === clean(msg.replyTo.text)) {
        displayText = '';
      }
    }
    const textHtml = (!isMediaOnly && displayText) 
      ? `<div class="message-text">${escapeHtml(displayText)}</div>` 
      : '';
    
    return `
      <div class="message ${msg.isFromMe ? 'from-me' : 'from-them'}${msg.paymentStatus ? ' has-payment' : ''}${msg.mediaType ? ' has-media' : ''}${msg.replyTo ? ' has-reply' : ''}" ${msg.id ? `data-msg-id="${msg.id}"` : ''}>
        ${replyHtml}
        ${mediaHtml}
        ${textHtml}
        ${paymentHtml}
        ${msg.time ? `<div class="message-time">${escapeHtml(msg.time)}</div>` : ''}
      </div>`;
  }).join('');
  
  // Re-attach draft/preview/loading elements after rendering messages
  if (savedDraft) chatMessages.appendChild(savedDraft);
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

// ============================================================
// LIVE DRAFT PREVIEW — Real-time green preview bubble for OF compose box
// Uses the SAME green .message-preview styling as AI-generated responses
// Updates text IN-PLACE (no DOM recreation) for smooth real-time typing
// ============================================================

// Helper: Delete a specific media attachment from the OF compose area
// Sends a message to the content script to click the Nth delete button
const deleteDraftMedia = async (index) => {
  console.log(`[Draft] 🗑️ Deleting media at index ${index}`);
  try {
    // EXACT same tab lookup as AI module — NO url filter (fails from sidepanel context)
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      console.warn('[Draft] No active tab found — cannot delete media');
      return;
    }
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'DELETE_DRAFT_MEDIA', index });
    console.log(`[Draft] 🗑️ Delete response:`, response);
  } catch (err) {
    console.error(`[Draft] 🗑️ Failed to delete media at index ${index}:`, err);
  }
};

export const renderDraftBar = (draft) => {
  console.log(`[🔍 DRAFT-DEBUG RENDER] renderDraftBar called:`, draft ? `text="${(draft.text || '').substring(0, 30)}", media=${(draft.media || []).length}` : 'null/empty');
  
  const chatMessages = $('chatMessages');
  if (!chatMessages) {
    console.log(`[🔍 DRAFT-DEBUG RENDER] chatMessages element NOT FOUND — cannot render`);
    return;
  }

  const existing = document.getElementById('draftBar');

  // If no draft data, remove the bubble and we're done
  if (!draft || (!draft.text && (!draft.media || draft.media.length === 0))) {
    if (existing) existing.remove();
    console.log(`[🔍 DRAFT-DEBUG RENDER] No draft data — removed bubble`);
    return;
  }
  
  console.log(`[🔍 DRAFT-DEBUG RENDER] Will ${existing ? 'UPDATE' : 'CREATE'} draft bubble`);

  // ── UPDATE IN-PLACE if bubble already exists (avoids flashing on every keystroke) ──
  if (existing) {
    // Update text content in-place
    const textEl = existing.querySelector('.message-text');
    const newText = draft.text || '';
    if (textEl) {
      if (textEl.textContent !== newText) textEl.textContent = newText;
      textEl.style.display = newText ? '' : 'none';
    } else if (newText) {
      // Text appeared — insert before actions
      const actionsEl = existing.querySelector('.preview-actions');
      const newTextEl = document.createElement('div');
      newTextEl.className = 'message-text';
      newTextEl.textContent = newText;
      existing.insertBefore(newTextEl, actionsEl);
    }

    // Update media thumbnails
    const mediaEl = existing.querySelector('.preview-media');
    const hasMedia = draft.media && draft.media.length > 0;
    if (hasMedia) {
      const mediaHtml = draft.media.map((item, idx) =>
        `<div class="preview-media-item" data-media-index="${idx}">` +
        `<img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.alt || 'Media')}" class="preview-media-thumb">` +
        `<button class="preview-media-delete" data-media-index="${idx}" title="Remove media">✕</button>` +
        `</div>`
      ).join('');
      if (mediaEl) {
        mediaEl.innerHTML = mediaHtml;
      } else {
        const newMediaEl = document.createElement('div');
        newMediaEl.className = 'preview-media';
        newMediaEl.innerHTML = mediaHtml;
        existing.insertBefore(newMediaEl, existing.firstChild);
      }
      // Wire up delete buttons
      existing.querySelectorAll('.preview-media-delete').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          deleteDraftMedia(parseInt(btn.dataset.mediaIndex, 10));
        };
      });
    } else if (mediaEl) {
      mediaEl.remove();
    }

    // Show/hide copy button based on whether there's text
    const copyBtn = existing.querySelector('.btn-copy');
    if (copyBtn) copyBtn.style.display = newText ? '' : 'none';

    // Scroll to keep it in view
    existing.scrollIntoView({ behavior: 'instant', block: 'end' });
    return;
  }

  // ── FIRST TIME: Create the green preview bubble from scratch ──
  const draftEl = document.createElement('div');
  draftEl.id = 'draftBar';
  // Uses exact same classes as AI preview — gets all green styling for free
  draftEl.className = 'message message-preview draft-live from-me';

  let html = '';

  // Media thumbnails with delete buttons (same structure as update-in-place path)
  if (draft.media && draft.media.length > 0) {
    html += '<div class="preview-media">';
    draft.media.forEach((item, idx) => {
      html += `<div class="preview-media-item" data-media-index="${idx}">` +
        `<img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.alt || 'Media')}" class="preview-media-thumb">` +
        `<button class="preview-media-delete" data-media-index="${idx}" title="Remove media">✕</button>` +
        `</div>`;
    });
    html += '</div>';
  }

  // Draft text
  if (draft.text) {
    html += `<div class="message-text">${escapeHtml(draft.text)}</div>`;
  }

  // Action buttons — same pattern as AI preview
  html += '<div class="preview-actions">';
  if (draft.text) {
    html += '<button class="btn-preview-action btn-copy" title="Copy text">📋 Copy</button>';
  }
  html += '<button class="btn-preview-action btn-send" title="Send this message">✅ Send</button>';
  html += '</div>';

  draftEl.innerHTML = html;

  // Wire up media delete buttons
  draftEl.querySelectorAll('.preview-media-delete').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      deleteDraftMedia(parseInt(btn.dataset.mediaIndex, 10));
    };
  });

  // Wire up action buttons
  const copyBtn = draftEl.querySelector('.btn-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const currentText = draftEl.querySelector('.message-text')?.textContent || '';
      navigator.clipboard.writeText(currentText).then(() => {
        copyBtn.textContent = '✅ Copied';
        setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 1500);
      }).catch(() => {});
    });
  }

  const sendBtn = draftEl.querySelector('.btn-send');
  if (sendBtn) {
    sendBtn.addEventListener('click', async () => {
      const draftText = draftEl.querySelector('.message-text')?.textContent || '';
      if (!draftText.trim()) {
        sendBtn.textContent = '❌ Empty';
        setTimeout(() => { sendBtn.textContent = '✅ Send'; }, 2000);
        return;
      }
      sendBtn.textContent = '⏳ Sending…';
      sendBtn.disabled = true;
      try {
        // EXACT same path as AI module's sendPreviewMessage — proven to work.
        // Uses SEND_MESSAGE which calls sendMessageToChat() in content script
        // (types the text + clicks send in one proven operation).
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          sendBtn.textContent = '❌ No tab';
        } else {
          const response = await chrome.tabs.sendMessage(tab.id, {
            type: 'SEND_MESSAGE',
            text: draftText,
          });
          if (response?.success) {
            sendBtn.textContent = '✅ Sent!';
            console.log('[Draft] ✅ SEND_MESSAGE succeeded (same path as AI module)');
          } else {
            console.warn('[Draft] SEND_MESSAGE failed:', response?.error);
            sendBtn.textContent = '❌ Failed';
          }
        }
      } catch (err) {
        console.error('[Draft] Send failed:', err);
        sendBtn.textContent = '❌ Failed';
      }
      setTimeout(() => {
        sendBtn.textContent = '✅ Send';
        sendBtn.disabled = false;
      }, 3000);
    });
  }

  // Insert before AI preview/loading messages (those are appended at the very end)
  const previewMessage = document.getElementById('previewMessage');
  const loadingMessage = document.getElementById('loadingMessage');
  const insertBefore = loadingMessage || previewMessage || null;

  if (insertBefore) {
    chatMessages.insertBefore(draftEl, insertBefore);
  } else {
    chatMessages.appendChild(draftEl);
  }

  // Scroll to show the new bubble
  draftEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
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
