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
  
  // Detect media types FIRST
  let mediaType = null;
  let mediaUrl = null;
  
  // Check for images
  const imgEl = el.querySelector('.b-chat__message-media img, .b-chat__message__media img, img[src*="cdn"], .m-media img');
  if (imgEl) {
    mediaType = 'image';
    mediaUrl = imgEl.src || imgEl.getAttribute('data-src');
  }
  
  // Check for videos
  const videoEl = el.querySelector('video, .b-chat__message-media video, [class*="video"]');
  if (videoEl && !mediaType) {
    mediaType = 'video';
    mediaUrl = videoEl.src || videoEl.querySelector('source')?.src;
  }
  
  // Check for PPV/locked content
  const ppvEl = el.querySelector('.b-chat__message-ppv, [class*="ppv"], [class*="locked"], .b-paidPostLock');
  if (ppvEl && !mediaType) {
    mediaType = 'ppv';
  }
  
  // Check for media containers (generic)
  const mediaContainer = el.querySelector('.b-chat__message-media, .b-chat__message__media, .m-media, [class*="media-wrapper"]');
  if (mediaContainer && !mediaType) {
    // Try to determine type from container
    if (mediaContainer.querySelector('img')) {
      mediaType = 'image';
    } else if (mediaContainer.querySelector('video')) {
      mediaType = 'video';
    } else {
      mediaType = 'media';
    }
  }
  
  // Extract text
  let text = '';
  const textEl = el.querySelector(SELECTORS.messageText);
  
  if (textEl) {
    text = textEl.innerText || textEl.textContent;
  }
  
  if (!text?.trim()) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('time, [class*="time"], [class*="media"], [class*="tip"]')
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
  if (!text) return null;
  
  // Extract time - try datetime attribute first (more reliable)
  const timeEl = el.querySelector(SELECTORS.messageTime);
  const datetime = timeEl?.getAttribute('datetime') || '';  // ISO format if available
  const timeDisplay = timeEl?.innerText || timeEl?.textContent || '';
  
  return {
    id: messageId,              // OnlyFans message ID if available
    text,
    isFromMe,
    time: timeDisplay.trim(),   // Display time (e.g., "2:30 PM")
    datetime: datetime,         // ISO datetime if available
    order: index,               // DOM position = chronological order
    mediaType: mediaType,       // 'image', 'video', 'ppv', 'media', or null
    mediaUrl: mediaUrl          // URL if available
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
    
    for (const mutation of mutations) {
      if (mutation.type !== 'childList' || !mutation.addedNodes.length) continue;
      
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && 
            (node.classList?.contains('b-chat__message') || 
             node.querySelector?.('.b-chat__message'))) {
          hasNewContent = true;
          break;
        }
      }
      if (hasNewContent) break;
    }
    
    if (hasNewContent) {
      // Debounce - wait a bit for all DOM updates to finish
      clearTimeout(observer.debounceTimer);
      observer.debounceTimer = setTimeout(() => {
        const newMessages = extractAllMessages();
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
  
  observer.observe(chatContainer, { childList: true, subtree: true });
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