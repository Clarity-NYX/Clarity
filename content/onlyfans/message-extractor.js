// ============================================================
// MESSAGE EXTRACTOR - Extracts and monitors chat messages
// ============================================================

import { SELECTORS, INTERVALS } from './constants.js';

// Message monitoring state
let messages = [];
let observer = null;
let lastMessageCount = 0;
let pollingInterval = null;
let sentMessageIds = new Set(); // Track which messages we've already sent

// ============================================================
// MESSAGE EXTRACTION
// ============================================================

export function extractAllMessages() {
  const container = document.querySelector(SELECTORS.chatContainer);
  if (!container) return [];
  
  const result = [];
  
  // Extract ALL messages in DOM order - no deduplication here
  // DOM order IS chronological order on OnlyFans (oldest at top)
  container.querySelectorAll(SELECTORS.messageElement).forEach((el, index) => {
    const data = extractMessageData(el, index);
    if (!data?.text) return;
    result.push(data);
  });
  
  return result;
}

function extractMessageData(el, index) {
  const isFromMe = el.classList.contains('m-from-me') || 
                   el.classList.contains('m-own') ||
                   !!el.closest('.m-from-me');
  
  // Try to get message ID from OnlyFans DOM (data attributes)
  const messageId = el.getAttribute('data-id') || 
                    el.getAttribute('data-message-id') ||
                    el.id ||
                    null;
  
  // ── Detect media types ──
  let mediaType = null;
  let mediaUrl = null;
  let mediaThumbnail = null;
  
  // Check for media wrapper (covers images, videos, PPV)
  const hasMedia = el.classList.contains('m-has-media') || 
                   el.querySelector('.b-chat__message__media-wrapper, .b-chat__message__media, .b-chat__message-media');
  
  // Check for video (look for video class/element or play button)
  const videoContainer = el.querySelector('.m-only-video, .m-video, [class*="video-wrapper"], video');
  const isVideo = !!videoContainer || el.querySelector('.vjs-big-play-button');
  
  // Get thumbnail image (works for both images and video previews)
  const thumbEl = el.querySelector(
    '.b-post__media-bg img, ' +
    '.b-chat__message__media img, ' +
    '.b-chat__message-media img, ' +
    '.b-placeholder-preview img, ' +
    '.post_media img, ' +
    'img[src*="cdn"]'
  );
  if (thumbEl) {
    // Convert to base64 data URL so sidepanel can display it (CDN URLs need auth cookies)
    mediaThumbnail = imgToBase64(thumbEl);
    if (!mediaThumbnail) {
      // Fallback to original URL
      mediaThumbnail = thumbEl.src || thumbEl.getAttribute('data-src');
    }
  }
  
  if (isVideo) {
    mediaType = 'video';
    const videoEl = el.querySelector('video source, video');
    mediaUrl = videoEl?.src || videoEl?.querySelector('source')?.src || null;
  } else if (thumbEl && hasMedia) {
    mediaType = 'image';
    mediaUrl = mediaThumbnail;
  }
  
  // Check for PPV/locked content
  const ppvEl = el.querySelector('.b-chat__message-ppv, [class*="ppv"], [class*="locked"], .b-paidPostLock');
  if (ppvEl && !mediaType) {
    mediaType = 'ppv';
  }
  
  // Fallback media detection
  if (hasMedia && !mediaType) {
    mediaType = 'media';
  }
  
  // ── Extract payment status ──
  let paymentStatus = null;  // null = not a paid message
  let paymentAmount = null;
  
  const paymentEl = el.querySelector('.b-chat__message__payment-state, [at-attr="payment_state"]');
  if (paymentEl) {
    const paymentText = (paymentEl.innerText || paymentEl.textContent || '').trim();
    
    // Extract dollar amount
    const amountMatch = paymentText.match(/\$[\d,.]+/);
    if (amountMatch) {
      paymentAmount = amountMatch[0];
    }
    
    // Determine paid/unpaid status
    if (paymentText.toLowerCase().includes('not paid')) {
      paymentStatus = 'unpaid';
    } else if (paymentText.toLowerCase().includes('paid') || paymentText.toLowerCase().includes('unlocked') || paymentText.toLowerCase().includes('purchased')) {
      paymentStatus = 'paid';
    } else if (amountMatch) {
      // Has amount but status unclear — check for "not paid" vs just amount shown
      paymentStatus = 'unpaid';
    }
  }
  
  // Also check message classes for payment hints
  if (!paymentStatus && el.classList.contains('m-not-paid-yet')) {
    paymentStatus = 'unpaid';
  }
  
  // ── Detect tips ──
  let tipAmount = null;
  const tipEl = el.querySelector('.b-chat__message__tip-text, [at-attr="msg_tip"]');
  if (tipEl) {
    const tipText = tipEl.innerText || tipEl.textContent || '';
    const tipMatch = tipText.match(/\$[\d,.]+/);
    if (tipMatch) {
      tipAmount = tipMatch[0];
    }
  }
  // Also check for tip in parent wrapper (tip text can be in different spots)
  if (!tipAmount) {
    const tipWrapper = el.querySelector('[class*="tip-text"], [class*="tip_text"]');
    if (tipWrapper) {
      const tipText = tipWrapper.innerText || tipWrapper.textContent || '';
      const tipMatch = tipText.match(/\$[\d,.]+/);
      if (tipMatch) {
        tipAmount = tipMatch[0];
      }
    }
  }
  
  // ── Extract text ──
  let text = '';
  const textEl = el.querySelector(SELECTORS.messageText);
  
  if (textEl) {
    text = textEl.innerText || textEl.textContent;
  }
  
  if (!text?.trim()) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('time, [class*="time"], [class*="media"], [class*="tip"], [class*="payment"]')
      .forEach(e => e.remove());
    text = clone.innerText || clone.textContent;
  }
  
  text = text?.trim() || '';
  
  // If no text but has media, use placeholder
  if (!text && mediaType) {
    switch (mediaType) {
      case 'image':
        text = '[📷 Image]';
        break;
      case 'video':
        text = '[🎬 Video]';
        break;
      case 'ppv':
        text = '[💰 PPV Content]';
        break;
      default:
        text = '[📎 Media]';
    }
  }
  
  // Skip if still no content
  if (!text && !mediaType) return null;
  
  // Extract time - try datetime attribute first (more reliable)
  const timeEl = el.querySelector(SELECTORS.messageTime);
  const datetime = timeEl?.getAttribute('datetime') || '';
  const timeDisplay = timeEl?.innerText || timeEl?.textContent || '';
  
  return {
    id: messageId,
    text: text || '',
    isFromMe,
    time: timeDisplay.trim(),
    datetime: datetime,
    order: index,
    mediaType,                  // 'image', 'video', 'ppv', 'media', or null
    mediaUrl,                   // Direct media URL if available
    mediaThumbnail,             // Thumbnail image URL (for video frames too)
    paymentStatus,              // 'paid', 'unpaid', or null
    paymentAmount,              // '$25' etc, or null
    tipAmount                   // '$80.00' etc, or null
  };
}

// ============================================================
// MESSAGE OBSERVER
// ============================================================

export function startMessageObserver() {
  const chatContainer = document.querySelector(SELECTORS.chatContainer);
  if (!chatContainer) return;
  
  observer?.disconnect();
  
  observer = new MutationObserver(mutations => {
    let hasNewContent = false;
    let hasPaymentChange = false;
    
    for (const mutation of mutations) {
      // Check for new messages (childList changes)
      if (mutation.type === 'childList' && mutation.addedNodes.length) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && 
              (node.classList?.contains('b-chat__message') || 
               node.querySelector?.('.b-chat__message'))) {
            hasNewContent = true;
            break;
          }
        }
      }
      
      // Check for payment status changes (class or text changes on payment elements)
      if (mutation.type === 'characterData' || mutation.type === 'attributes') {
        const target = mutation.target?.closest?.('.b-chat__message') || mutation.target?.parentElement?.closest?.('.b-chat__message');
        if (target) {
          const paymentEl = target.querySelector('.b-chat__message__payment-state, [at-attr="payment_state"]');
          if (paymentEl || mutation.target.classList?.contains('m-not-paid-yet')) {
            hasPaymentChange = true;
          }
        }
      }
    }
    
    if (hasNewContent || hasPaymentChange) {
      // Debounce - wait a bit for all DOM updates to finish
      clearTimeout(observer.debounceTimer);
      observer.debounceTimer = setTimeout(() => {
        const newMessages = extractAllMessages();
        
        if (hasPaymentChange) {
          // Payment status changed — re-send all messages to update UI
          messages = newMessages;
          sendChatMessages(newMessages);
          console.log('[Clarity] 💰 Payment status change detected, refreshing chat');
        }
        
        if (newMessages.length > messages.length) {
          // Find actually new messages
          const actuallyNewMessages = newMessages.slice(messages.length);
          messages = newMessages;
          
          // Send each new message only once
          actuallyNewMessages.forEach(msg => {
            const msgKey = `${msg.text}|${msg.isFromMe}|${msg.time || ''}|${msg.order}`;
            if (!sentMessageIds.has(msgKey)) {
              sentMessageIds.add(msgKey);
              sendNewMessage(msg);
              
              // Clean up old message IDs to prevent memory leak
              if (sentMessageIds.size > 500) {
                const idsArray = Array.from(sentMessageIds);
                sentMessageIds = new Set(idsArray.slice(-300));
              }
            }
          });
        }
      }, 100); // Wait 100ms for DOM to stabilize
    }
  });
  
  observer.observe(chatContainer, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
}

export function stopMessageObserver() {
  observer?.disconnect();
  observer = null;
}

// ============================================================
// MESSAGE POLLING (Backup system)
// ============================================================

export function startPolling() {
  if (pollingInterval) return; // Already polling
  
  console.log('[Clarity] Starting message polling (every 1.5s)');
  pollingInterval = setInterval(() => {
    if (!isOnChatPage()) {
      stopPolling();
      return;
    }
    
    checkForNewMessages();
  }, INTERVALS.messagePolling);
}

export function stopPolling() {
  if (pollingInterval) {
    console.log('[Clarity] Stopping message polling');
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

function checkForNewMessages() {
  const extracted = extractAllMessages();
  const newCount = extracted.length;
  
  // Only update if we have more messages than before
  if (newCount > lastMessageCount) {
    console.log(`[Clarity] Polling found ${newCount - lastMessageCount} new message(s)`);
    
    // Find actually new messages
    const newMessages = extracted.slice(lastMessageCount);
    
    // Update state
    messages = extracted;
    lastMessageCount = newCount;
    
    // Send all messages to sidepanel
    sendChatMessages(extracted);
    
    // Also send notification for newest message
    if (newMessages.length > 0) {
      const latestMessage = newMessages[newMessages.length - 1];
      sendNewMessage(latestMessage);
    }
  }
}

// ============================================================
// AUTO-LOAD CHAT
// ============================================================

export function autoLoadChat() {
  if (!isOnChatPage()) {
    stopPolling();
    return;
  }
  
  const extracted = extractAllMessages();
  if (extracted.length) {
    messages = extracted;
    lastMessageCount = extracted.length;
    sendChatMessages(extracted);
    startMessageObserver();
    startPolling(); // Start polling as backup
  }
}

// ============================================================
// PROFILE STATS SCRAPING
// ============================================================

export function scrapeProfileStats() {
  const stats = {
    subscribedFor: null,
    totalSpent: null,
    subscribedSince: null
  };
  
  try {
    console.log('[Clarity] Scraping profile stats...');
    
    // METHOD 1: Look for the specific fan stats list items
    // Structure: <li class="b-fans__item__list__item">
    //              <span class="b-fans__item__list__label">subscribed for</span>
    //              <span>10 days</span>
    //            </li>
    const statsItems = document.querySelectorAll('.b-fans__item__list__item');
    console.log('[Clarity] Found', statsItems.length, 'fan stats items');
    
    for (const item of statsItems) {
      const labelEl = item.querySelector('.b-fans__item__list__label');
      const labelText = (labelEl?.innerText || labelEl?.textContent || '').toLowerCase().trim();
      const fullText = (item.innerText || item.textContent || '').trim();
      
      console.log('[Clarity] Stats item label:', labelText, '| Full text:', fullText);
      
      // Check for "subscribed for"
      if (labelText.includes('subscribed')) {
        // Extract duration from full text (e.g., "subscribed for 10 days")
        const match = fullText.match(/(\d+)\s*(day|days|week|weeks|month|months|year|years)/i);
        if (match) {
          stats.subscribedFor = `${match[1]} ${match[2]}`;
          stats.subscribedSince = calculateSubscribedSince(parseInt(match[1]), match[2].toLowerCase());
          console.log('[Clarity] Found subscribedFor:', stats.subscribedFor);
        }
      }
      
      // Check for "Spent"
      if (labelText.includes('spent')) {
        // Extract dollar amount (e.g., "$2.88")
        const match = fullText.match(/\$[\d,]+\.?\d*/);
        if (match) {
          stats.totalSpent = match[0];
          console.log('[Clarity] Found totalSpent:', stats.totalSpent);
        }
      }
    }
    
    // METHOD 2: Look in generic stats elements if Method 1 didn't find everything
    if (!stats.subscribedFor || !stats.totalSpent) {
      const statsElements = document.querySelectorAll(SELECTORS.profileStats);
      console.log('[Clarity] Fallback: Found', statsElements.length, 'generic stats elements');
      
      for (const el of statsElements) {
        const text = el.innerText || el.textContent || '';
        const lowerText = text.toLowerCase();
        
        // Look for "subscribed for" pattern
        if (!stats.subscribedFor && (lowerText.includes('subscribed for') || lowerText.includes('subscribed'))) {
          const match = text.match(/(\d+)\s*(day|days|week|weeks|month|months|year|years)/i);
          if (match) {
            stats.subscribedFor = `${match[1]} ${match[2]}`;
            stats.subscribedSince = calculateSubscribedSince(parseInt(match[1]), match[2].toLowerCase());
            console.log('[Clarity] Fallback found subscribedFor:', stats.subscribedFor);
          }
        }
        
        // Look for "Spent" pattern
        if (!stats.totalSpent && lowerText.includes('spent')) {
          const match = text.match(/\$[\d,]+\.?\d*/);
          if (match) {
            stats.totalSpent = match[0];
            console.log('[Clarity] Fallback found totalSpent:', stats.totalSpent);
          }
        }
      }
    }
    
    // METHOD 3: Last resort - search entire page for patterns
    if (!stats.subscribedFor || !stats.totalSpent) {
      console.log('[Clarity] Using full page search as last resort...');
      const allText = document.body.innerText;
      
      if (!stats.subscribedFor) {
        const subMatch = allText.match(/subscribed\s*(?:for)?\s*(\d+)\s*(day|days|week|weeks|month|months|year|years)/i);
        if (subMatch) {
          stats.subscribedFor = `${subMatch[1]} ${subMatch[2]}`;
          stats.subscribedSince = calculateSubscribedSince(parseInt(subMatch[1]), subMatch[2].toLowerCase());
          console.log('[Clarity] Full page found subscribedFor:', stats.subscribedFor);
        }
      }
      
      if (!stats.totalSpent) {
        // More specific pattern to avoid false positives
        const spentMatch = allText.match(/spent[:\s]*\$?([\d,]+\.?\d*)/i);
        if (spentMatch) {
          const amount = spentMatch[1].startsWith('$') ? spentMatch[1] : `$${spentMatch[1]}`;
          stats.totalSpent = amount;
          console.log('[Clarity] Full page found totalSpent:', stats.totalSpent);
        }
      }
    }
    
    console.log('[Clarity] Final stats result:', stats);
    
  } catch (error) {
    console.error('[Clarity] Error scraping profile stats:', error);
  }
  
  return stats;
}

function calculateSubscribedSince(amount, unit) {
  const now = new Date();
  let ms = 0;
  
  unit = unit.replace(/s$/, ''); // Remove plural 's'
  
  switch (unit) {
    case 'day':
      ms = amount * 24 * 60 * 60 * 1000;
      break;
    case 'week':
      ms = amount * 7 * 24 * 60 * 60 * 1000;
      break;
    case 'month':
      ms = amount * 30 * 24 * 60 * 60 * 1000;
      break;
    case 'year':
      ms = amount * 365 * 24 * 60 * 60 * 1000;
      break;
  }
  
  return new Date(now.getTime() - ms).toISOString();
}

// ============================================================
// MESSAGE SENDING TO EXTENSION
// ============================================================

function sendChatMessages(data) {
  chrome.runtime.sendMessage({ type: 'CHAT_MESSAGES', data }).catch(() => {});
}

function sendNewMessage(data) {
  chrome.runtime.sendMessage({ type: 'NEW_MESSAGE', data }).catch(() => {});
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function isOnChatPage() {
  const url = window.location.href;
  const isChatUrl = url.includes('/my/chats/chat/') || url.includes('/messages/');
  const hasChat = !!document.querySelector(SELECTORS.chatContainer);
  return isChatUrl || hasChat;
}

export function isOnProfilePage() {
  const url = window.location.href;
  return /onlyfans\.com\/u\d+/.test(url);
}

// Export current messages
export function getCurrentMessages() {
  return messages;
}

export function setMessages(newMessages) {
  messages = newMessages;
  lastMessageCount = newMessages.length;
}

// Convert an already-loaded img element to a small base64 data URL
// This allows the sidepanel to display thumbnails without needing OnlyFans CDN auth
function imgToBase64(imgEl) {
  try {
    if (!imgEl || !imgEl.naturalWidth || !imgEl.complete) return null;
    
    // Create a small canvas for the thumbnail (max 120px)
    const maxSize = 120;
    let width = imgEl.naturalWidth;
    let height = imgEl.naturalHeight;
    
    if (width > maxSize || height > maxSize) {
      const ratio = Math.min(maxSize / width, maxSize / height);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }
    
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, width, height);
    
    return canvas.toDataURL('image/jpeg', 0.6);
  } catch (e) {
    // Canvas tainted by cross-origin image - can't convert
    return null;
  }
}
