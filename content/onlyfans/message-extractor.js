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

// High-quality capture flag (toggled during full/cleanup scans)
let highQualityCapture = false;

// Reusable canvas for thumbnail generation (Fix A: avoids creating thousands of canvases during scans)
let _reusableCanvas = null;
let _reusableCtx = null;

// Draft observer state
let draftObserver = null;

// ============================================================
// OF API INTERCEPTOR — captures auth headers for API fallback
// ============================================================
// Content scripts run in an isolated world. We inject a page-level
// script that wraps window.fetch/XHR to capture the auth headers
// OF adds to its own API calls (app-token, x-bc, user-id, etc.).
// We then reuse those headers when making our own API calls.
// ============================================================

let _apiInterceptorReady = false;

function setupApiInterceptor() {
  if (_apiInterceptorReady) return;
  _apiInterceptorReady = true;

  // Use script.src with chrome.runtime.getURL to bypass OnlyFans CSP
  // (inline scripts are blocked by CSP, but extension-hosted files are allowed)
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject/api-interceptor.js');
  script.onload = () => {
    script.remove();
    console.log('[Clarity] 🔑 API interceptor loaded into page context');
  };
  script.onerror = (e) => {
    script.remove();
    console.warn('[Clarity] 🔑 API interceptor failed to load:', e);
  };
  (document.head || document.documentElement).appendChild(script);
}

// Set up interceptor early so headers are captured by the time we need them
try { setupApiInterceptor(); } catch (e) { console.warn('[Clarity] API interceptor setup failed:', e); }

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
  
  // ── Fill missing timestamps from neighboring messages ──
  // OF groups messages sent within the same minute and only shows a <time>
  // element on the first/last in the group. Messages without a <time> element
  // get empty datetime/time strings. Without this fix, the bridge falls back
  // to new Date() (scan time) — giving wildly wrong timestamps (e.g. 9:13 am
  // for a message actually sent at 3:16 pm).
  // Strategy: forward-fill from the nearest preceding message that has a datetime.
  // If the very first messages lack datetime, back-fill from the first one that has it.
  let lastKnownDatetime = '';
  let lastKnownTime = '';
  for (let i = 0; i < result.length; i++) {
    if (result[i].datetime) {
      lastKnownDatetime = result[i].datetime;
      lastKnownTime = result[i].time || lastKnownTime;
    } else if (lastKnownDatetime) {
      result[i].datetime = lastKnownDatetime;
      if (!result[i].time) result[i].time = lastKnownTime;
    }
  }
  // Back-fill: if the first N messages had no datetime, fill from the first one that does
  if (result.length > 0 && !result[0].datetime) {
    const firstWithTime = result.find(m => m.datetime);
    if (firstWithTime) {
      for (let i = 0; i < result.length; i++) {
        if (result[i].datetime) break;
        result[i].datetime = firstWithTime.datetime;
        if (!result[i].time) result[i].time = firstWithTime.time;
      }
    }
  }
  
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
  
  // ── Detect reply/quoted message ──
  // OF DOM: replied messages have class .m-replied on the outer element,
  // and the quote is inside .b-chat__replied-message
  let replyTo = null;
  const isReplied = el.classList.contains('m-replied');
  const replyEl = el.querySelector('.b-chat__replied-message');
  if (replyEl) {
    // Extract quoted author — inside .b-username within the reply block
    const replyAuthorEl = replyEl.querySelector(
      '.b-username, .b-username__name, .g-user-name'
    );
    // Extract quoted text — inside .m-reply-text or .b-chat__message__text within the reply block
    const replyTextEl = replyEl.querySelector(
      '.b-chat__message__text.m-reply-text, ' +
      '.b-chat__message__text'
    );
    const replyAuthor = (replyAuthorEl?.innerText || replyAuthorEl?.textContent || '').trim();
    let replyText = (replyTextEl?.innerText || replyTextEl?.textContent || '').trim();
    // Strip leading quote character " that OF adds
    replyText = replyText.replace(/^["\u201C\u201D]\s*/, '').trim();
    
    if (replyText || replyAuthor) {
      replyTo = {
        text: replyText || null,
        author: replyAuthor || null
      };
    }
  }
  
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
    // Try multiple sources — OF's video.js loads URLs dynamically, so DOM <video> src
    // is usually empty until playback starts. Check all possible attribute sources.
    const videoEl = el.querySelector('video');
    const sourceEl = videoEl?.querySelector('source');
    mediaUrl = videoEl?.src || videoEl?.currentSrc ||
               sourceEl?.src || sourceEl?.getAttribute('data-src') ||
               videoEl?.getAttribute('data-src') ||
               el.querySelector('[data-video-src]')?.getAttribute('data-video-src') ||
               null;
    // Filter out blob: URLs (not useful outside this page)
    if (mediaUrl && mediaUrl.startsWith('blob:')) mediaUrl = null;
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
  // For replied messages, the first .b-chat__message__text is INSIDE the reply quote
  // (.b-chat__replied-message). We need the one OUTSIDE it — the actual reply text.
  let text = '';
  
  if (replyEl) {
    // Message has a reply quote — find text elements NOT inside the quote
    const allTextEls = el.querySelectorAll(SELECTORS.messageText);
    for (const te of allTextEls) {
      if (!te.closest('.b-chat__replied-message')) {
        text = te.innerText || te.textContent;
        break;
      }
    }
  } else {
    const textEl = el.querySelector(SELECTORS.messageText);
    if (textEl) {
      text = textEl.innerText || textEl.textContent;
    }
  }
  
  if (!text?.trim()) {
    const clone = el.cloneNode(true);
    // Remove reply quote from clone so it doesn't contaminate the text
    clone.querySelectorAll('.b-chat__replied-message')
      .forEach(e => e.remove());
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
    tipAmount,                  // '$80.00' etc, or null
    replyTo                     // { text, author } or null
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
      observer.debounceTimer = setTimeout(async () => {
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
          
          // Convert CDN URL thumbnails to base64 before sending to bridge
          // (imgToBase64 fails on cross-origin OF CDN images — canvas tainted)
          // fetchImageAsBase64 uses fetch+blob approach which works in content script
          const msgsWithMedia = actuallyNewMessages.filter(m => m.mediaThumbnail && m.mediaThumbnail.startsWith('http'));
          if (msgsWithMedia.length > 0) {
            console.log(`[Clarity] 🖼️ Converting ${msgsWithMedia.length} new message thumbnail(s) to base64...`);
            await convertNewMessageThumbnails(msgsWithMedia);
          }
          
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

async function checkForNewMessages() {
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
    
    // Convert CDN URL thumbnails to base64 for new messages before sending
    const msgsWithMedia = newMessages.filter(m => m.mediaThumbnail && m.mediaThumbnail.startsWith('http'));
    if (msgsWithMedia.length > 0) {
      await convertNewMessageThumbnails(msgsWithMedia);
    }
    
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
    // REMOVED: startPolling() — observer is sufficient for incremental detection.
    // Polling re-scraped ALL messages every 1.5s and sent full CHAT_MESSAGES batches,
    // causing redundant writes. The MutationObserver handles new messages incrementally.
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
    const statsItems = document.querySelectorAll('.b-fans__item__list__item');
    console.log('[Clarity] Found', statsItems.length, 'fan stats items');
    
    for (const item of statsItems) {
      const labelEl = item.querySelector('.b-fans__item__list__label');
      const labelText = (labelEl?.innerText || labelEl?.textContent || '').toLowerCase().trim();
      const fullText = (item.innerText || item.textContent || '').trim();
      
      console.log('[Clarity] Stats item label:', labelText, '| Full text:', fullText);
      
      if (labelText.includes('subscribed')) {
        const match = fullText.match(/(\d+)\s*(day|days|week|weeks|month|months|year|years)/i);
        if (match) {
          stats.subscribedFor = `${match[1]} ${match[2]}`;
          stats.subscribedSince = calculateSubscribedSince(parseInt(match[1]), match[2].toLowerCase());
          console.log('[Clarity] Found subscribedFor:', stats.subscribedFor);
        }
      }
      
      if (labelText.includes('spent')) {
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
        
        if (!stats.subscribedFor && (lowerText.includes('subscribed for') || lowerText.includes('subscribed'))) {
          const match = text.match(/(\d+)\s*(day|days|week|weeks|month|months|year|years)/i);
          if (match) {
            stats.subscribedFor = `${match[1]} ${match[2]}`;
            stats.subscribedSince = calculateSubscribedSince(parseInt(match[1]), match[2].toLowerCase());
            console.log('[Clarity] Fallback found subscribedFor:', stats.subscribedFor);
          }
        }
        
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

// FIX D: Clear accumulated state when switching to a new chat
// Prevents messages/thumbnails from previous chats lingering in memory
export function resetForNewChat() {
  messages = [];
  lastMessageCount = 0;
  sentMessageIds.clear();
  stopPolling();
  stopMessageObserver();
}

// ============================================================
// HIGH-QUALITY CAPTURE TOGGLE
// ============================================================

export function setHighQualityCapture(enabled) {
  highQualityCapture = !!enabled;
  console.log(`[Clarity] High-quality capture: ${highQualityCapture ? 'ON (400px)' : 'OFF (120px)'}`);
}

// ============================================================
// FULL SCAN CHAT — scroll through entire chat history
// Uses improved scroll detection + API fallback.
// ============================================================

export async function fullScanChat(progressCallback) {
  // Ensure API interceptor is ready
  setupApiInterceptor();

  const container = findScrollableChat();
  const scrollWorks = container && container.__clarityScrollConfirmed;

  // If scroll detection confirmed a working container, use scroll approach
  if (scrollWorks) {
    console.log('[Clarity] 🔍 fullScanChat: Using SCROLL approach (confirmed scrollable container)');
    return await _scrollBasedScan(container, progressCallback, 'fullScan');
  }

  // Otherwise, try API approach first
  const chatId = getChatIdFromUrl();
  if (chatId) {
    console.log(`[Clarity] 🔍 fullScanChat: Using API approach (chatId=${chatId})`);
    try {
      const apiMessages = await fetchAllMessagesViaAPI(chatId, progressCallback);
      if (apiMessages.length > 0) {
        console.log(`[Clarity] 🔍 fullScanChat: API returned ${apiMessages.length} messages`);
        return apiMessages;
      }
      console.log('[Clarity] 🔍 API returned 0 messages, falling back to scroll...');
    } catch (err) {
      console.warn('[Clarity] 🔍 API approach failed:', err.message, '— falling back to scroll...');
    }
  }

  // Fallback: scroll approach even without confirmed container
  if (container) {
    console.log('[Clarity] 🔍 fullScanChat: Falling back to scroll approach');
    return await _scrollBasedScan(container, progressCallback, 'fullScan');
  }

  // Last resort: just return whatever is in the DOM
  console.warn('[Clarity] 🔍 fullScanChat: No container and no API — returning DOM messages only');
  return extractAllMessages();
}

// ============================================================
// CLEANUP SCAN CHAT — scroll through entire chat, scrape all messages
// Two-phase approach:
//   1. Try OF API to fetch ALL messages directly (fast, reliable)
//   2. Fall back to DOM scrolling if API fails
// ============================================================

export async function cleanupScanChat(progressCallback) {
  // Ensure API interceptor is ready
  setupApiInterceptor();

  // FIX B: Removed verbose diagnostic block (getComputedStyle reflows + console spam)

  // ── Phase 1: Try API approach (fastest, most reliable) ──
  const chatId = getChatIdFromUrl();
  if (chatId) {
    console.log(`[Clarity] 🧹 Phase 1: Trying API approach (chatId=${chatId})...`);
    
    // Wait a moment to ensure OF has made at least one API call (so we have headers)
    await sleep(1000);
    
    try {
      const apiMessages = await fetchAllMessagesViaAPI(chatId, progressCallback);
      if (apiMessages.length > 0) {
        console.log(`[Clarity] 🧹 API approach succeeded: ${apiMessages.length} messages`);
        return apiMessages;
      }
      console.log('[Clarity] 🧹 API returned 0 messages, falling back to scroll...');
    } catch (err) {
      console.warn('[Clarity] 🧹 API approach failed:', err.message, '— falling back to scroll...');
    }
  } else {
    console.log('[Clarity] 🧹 Could not extract chat ID from URL, skipping API approach');
  }

  // ── Phase 2: Fall back to scroll-based approach ──
  const container = findScrollableChat();
  if (!container) {
    console.warn('[Clarity] 🧹 cleanupScanChat: No scrollable chat container found and API failed');
    return extractAllMessages();
  }

  console.log(`[Clarity] 🧹 Phase 2: Using scroll approach — container: <${container.tagName}.${[...container.classList].join('.')}>`);
  console.log(`[Clarity] 🧹 scrollHeight=${container.scrollHeight} clientHeight=${container.clientHeight} scrollTop=${container.scrollTop} confirmed=${!!container.__clarityScrollConfirmed}`);

  return await _scrollBasedScan(container, progressCallback, 'cleanup');
}

// ============================================================
// SCROLL-BASED SCAN — shared logic for fullScan and cleanup
// ============================================================

async function _scrollBasedScan(container, progressCallback, label) {
  const allMessages = new Map();
  const MAX_NO_GROWTH = 3;
  let noGrowthCount = 0;
  let prevSize = 0;
  let iteration = 0;

  // ── Scroll to bottom first ──
  console.log(`[Clarity] 🧹 [${label}] Scrolling to BOTTOM first...`);
  container.scrollTop = container.scrollHeight;
  container.dispatchEvent(new Event('scroll', { bubbles: true }));
  await sleep(1000);

  // ── Phase A: Scroll UP ──
  console.log(`[Clarity] 🧹 [${label}] Phase A — scrolling UP to load older messages...`);

  while (noGrowthCount < MAX_NO_GROWTH) {
    iteration++;

    const domMsgCount = document.querySelectorAll(SELECTORS.messageElement).length;
    const current = extractAllMessages();
    for (const msg of current) {
      const key = `${msg.text}|${msg.isFromMe}|${msg.datetime || msg.time}`;
      if (!allMessages.has(key)) allMessages.set(key, msg);
    }

    if (progressCallback) {
      progressCallback({
        phase: 'scrolling-to-top',
        messagesFound: allMessages.size,
        scrollTop: container.scrollTop,
        iteration,
      });
    }

    if (allMessages.size > prevSize) {
      console.log(`[Clarity] 🧹 ↑ iter ${iteration}: ${allMessages.size} msgs (+${allMessages.size - prevSize} new) DOM=${domMsgCount} scrollTop=${container.scrollTop}`);
      noGrowthCount = 0;
      prevSize = allMessages.size;
    } else {
      noGrowthCount++;
      console.log(`[Clarity] 🧹 ↑ iter ${iteration}: ${allMessages.size} msgs (no growth ${noGrowthCount}/${MAX_NO_GROWTH}) DOM=${domMsgCount} scrollTop=${container.scrollTop}`);
    }

    // Strategy A: scrollIntoView on the FIRST message element
    const firstMsg = document.querySelector(SELECTORS.messageElement);
    if (firstMsg) {
      firstMsg.scrollIntoView({ behavior: 'smooth', block: 'start' });
      await sleep(800);
    }

    // Strategy B: scrollBy / scrollTop
    const scrollBefore = container.scrollTop;
    if (container.scrollTop > 5) {
      const step = Math.max(300, container.clientHeight);
      container.scrollBy({ top: -step, behavior: 'smooth' });
    } else {
      container.scrollTop = 0;
    }

    // Strategy C: Dispatch wheel + scroll events
    simulateWheelUp(container);

    // Strategy D: Look for loading spinner
    const spinner = container.querySelector(
      '.b-spinner, [class*="spinner"], [class*="loader"], [class*="loading"], .b-chat__loading'
    );
    if (spinner) {
      console.log(`[Clarity] 🧹 Found loading spinner — waiting 3s...`);
      spinner.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(3000);
      continue;
    }

    await sleep(1500);

    // ── BOUNCE strategy: If stuck at scrollTop ≈ 0, scroll DOWN then UP ──
    // OF's IntersectionObserver fires on visibility TRANSITIONS. If we're
    // already at the top, the sentinel is visible but the observer won't
    // re-fire. We need to scroll DOWN (sentinel exits viewport) then back
    // UP (sentinel re-enters) to trigger another batch load.
    if (Math.abs(container.scrollTop - scrollBefore) < 2 && container.scrollTop < 5) {
      console.log(`[Clarity] 🧹 BOUNCE: At top with no scroll change — bouncing down then up...`);
      
      // Bounce DOWN: scroll to ~60% of current scrollHeight
      const bounceTarget = Math.floor(container.scrollHeight * 0.6);
      container.scrollTop = bounceTarget;
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(800);
      
      // Bounce UP: scroll back to top to re-trigger IntersectionObserver
      container.scrollTop = 0;
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
      simulateWheelUp(container);
      await sleep(2000); // Wait for OF to load new batch
      
      // Also try parent scrolling as additional trigger
      let parent = container.parentElement;
      for (let i = 0; i < 3 && parent && parent !== document.body; i++) {
        const ps = window.getComputedStyle(parent);
        if (ps.overflowY === 'auto' || ps.overflowY === 'scroll') {
          parent.scrollTop = 0;
          simulateWheelUp(parent);
        }
        parent = parent.parentElement;
      }
      await sleep(500);
    }
  }

  console.log(`[Clarity] 🧹 [${label}] Phase A done: ${allMessages.size} messages. Scrolling DOWN...`);

  // ── Phase B: Scroll DOWN ──
  noGrowthCount = 0;
  prevSize = allMessages.size;

  while (noGrowthCount < MAX_NO_GROWTH) {
    iteration++;
    const current = extractAllMessages();
    for (const msg of current) {
      const key = `${msg.text}|${msg.isFromMe}|${msg.datetime || msg.time}`;
      if (!allMessages.has(key)) allMessages.set(key, msg);
    }

    if (progressCallback) {
      progressCallback({
        phase: 'scanning-down',
        messagesFound: allMessages.size,
        scrollTop: container.scrollTop,
        iteration,
      });
    }

    if (allMessages.size > prevSize) {
      noGrowthCount = 0;
      prevSize = allMessages.size;
    } else {
      noGrowthCount++;
    }

    const scrollBefore = container.scrollTop;
    const lastMsgEls = document.querySelectorAll(SELECTORS.messageElement);
    if (lastMsgEls.length > 0) {
      lastMsgEls[lastMsgEls.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
    container.scrollBy({ top: container.clientHeight, behavior: 'smooth' });
    container.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(1200);

    if (Math.abs(container.scrollTop - scrollBefore) < 2) {
      noGrowthCount += 3;
    }
  }

  // ── Final capture — DOM order is the single source of truth ──
  // The OF page DOM order (top to bottom) IS the canonical conversation order.
  // We use it directly instead of trying to re-sort by datetime/batch-order.
  const finalMessages = extractAllMessages();

  // If the current DOM has ALL our collected messages, use pure DOM order
  if (finalMessages.length >= allMessages.size) {
    finalMessages.forEach((msg, i) => { msg.order = i; });
    console.log(`[Clarity] 🧹 [${label}] complete: ${finalMessages.length} messages (pure DOM order) across ${iteration} iterations`);
    // Convert any remaining CDN URL thumbnails to base64 before returning
    await convertUrlThumbnailsToBase64(finalMessages);
    return finalMessages;
  }

  // For longer chats where DOM is virtualized (not all msgs visible at once),
  // build a position map from the current DOM view and use it to anchor sorting.
  const domPositionMap = new Map();
  finalMessages.forEach((msg, idx) => {
    const key = `${msg.text}|${msg.isFromMe}|${msg.datetime || msg.time}`;
    domPositionMap.set(key, idx);
    // Update our collection with the fresh DOM-ordered version
    if (allMessages.has(key)) allMessages.set(key, msg);
  });
  for (const msg of finalMessages) {
    const key = `${msg.text}|${msg.isFromMe}|${msg.datetime || msg.time}`;
    if (!allMessages.has(key)) allMessages.set(key, msg);
  }

  const result = Array.from(allMessages.values());
  result.sort((a, b) => {
    const keyA = `${a.text}|${a.isFromMe}|${a.datetime || a.time}`;
    const keyB = `${b.text}|${b.isFromMe}|${b.datetime || b.time}`;
    const posA = domPositionMap.get(keyA);
    const posB = domPositionMap.get(keyB);
    // Both in current DOM → use DOM position (definitive)
    if (posA !== undefined && posB !== undefined) return posA - posB;
    // Only one in DOM → the non-DOM message is older (from earlier scroll), place it before
    if (posA !== undefined && posB === undefined) return 1;
    if (posA === undefined && posB !== undefined) return -1;
    // Neither in current DOM → use datetime as last resort
    if (a.datetime && b.datetime) return a.datetime.localeCompare(b.datetime);
    return 0; // preserve insertion order (stable sort)
  });

  result.forEach((msg, i) => { msg.order = i; });

  console.log(`[Clarity] 🧹 [${label}] complete: ${result.length} messages collected across ${iteration} iterations`);
  // Convert any remaining CDN URL thumbnails to base64 before returning
  await convertUrlThumbnailsToBase64(result);
  return result;
}

// ============================================================
// FIND SCROLLABLE CHAT CONTAINER — improved with nudge test
// ============================================================
// Instead of just checking CSS overflowY, we ACTUALLY test if
// setting scrollTop changes it. This confirms the element is
// truly scrollable by the browser's layout engine.
// ============================================================

function findScrollableChat() {
  const firstMsg = document.querySelector(SELECTORS.messageElement);

  // ── Strategy 1: Walk UP from first message, nudge-test each parent ──
  if (firstMsg) {
    let el = firstMsg.parentElement;
    let depth = 0;
    while (el && el !== document.documentElement && depth < 20) {
      if (el.scrollHeight > el.clientHeight + 2) {
        const saved = el.scrollTop;

        // Test A: Try scrolling down by 1px
        el.scrollTop = saved + 1;
        if (el.scrollTop !== saved) {
          el.scrollTop = saved; // restore
          el.__clarityScrollConfirmed = true;
          console.log(`[Clarity] 🧹 findScrollableChat: CONFIRMED via scrollTop+1 nudge at depth ${depth}: <${el.tagName}.${[...el.classList].slice(0,3).join('.')}> scrollH=${el.scrollHeight} clientH=${el.clientHeight}`);
          return el;
        }

        // Test B: Try scrolling to midpoint (in case we're already at bottom)
        const mid = Math.floor(el.scrollHeight / 2);
        el.scrollTop = mid;
        if (el.scrollTop > 0 && el.scrollTop !== saved) {
          el.scrollTop = saved; // restore
          el.__clarityScrollConfirmed = true;
          console.log(`[Clarity] 🧹 findScrollableChat: CONFIRMED via midpoint nudge at depth ${depth}: <${el.tagName}.${[...el.classList].slice(0,3).join('.')}>`);
          return el;
        }
        el.scrollTop = saved; // always restore
      }
      depth++;
      el = el.parentElement;
    }
    console.log(`[Clarity] 🧹 findScrollableChat: No parent passed nudge test (checked ${depth} parents)`);
  }

  // ── Strategy 2: Check broader selectors with nudge test ──
  const candidates = document.querySelectorAll(
    '.b-chat__messages-wrapper, .b-chat__content, .m-native-custom-scrollbar, ' +
    '[class*="chat__messages"], .b-chats__body, .l-chat__body, ' +
    '[class*="chat-body"], [class*="messages-list"], [class*="message-list"]'
  );
  for (const el of candidates) {
    if (el.scrollHeight > el.clientHeight + 2) {
      const saved = el.scrollTop;
      el.scrollTop = saved + 1;
      if (el.scrollTop !== saved) {
        el.scrollTop = saved;
        el.__clarityScrollConfirmed = true;
        console.log(`[Clarity] 🧹 findScrollableChat: CONFIRMED via candidate nudge: <${el.tagName}.${[...el.classList].join('.')}>`);
        return el;
      }
      el.scrollTop = saved;
    }
  }

  // ── Strategy 3: elementFromPoint — find what's under the cursor where chat would be ──
  try {
    const centerX = window.innerWidth * 0.5;
    const centerY = window.innerHeight * 0.5;
    let el = document.elementFromPoint(centerX, centerY);
    let depth = 0;
    while (el && el !== document.documentElement && depth < 20) {
      if (el.scrollHeight > el.clientHeight + 2) {
        const saved = el.scrollTop;
        el.scrollTop = saved + 1;
        if (el.scrollTop !== saved) {
          el.scrollTop = saved;
          el.__clarityScrollConfirmed = true;
          console.log(`[Clarity] 🧹 findScrollableChat: CONFIRMED via elementFromPoint at depth ${depth}: <${el.tagName}.${[...el.classList].slice(0,3).join('.')}>`);
          return el;
        }
        el.scrollTop = saved;
      }
      depth++;
      el = el.parentElement;
    }
  } catch (e) {
    // elementFromPoint might fail in some contexts
  }

  // ── Strategy 4: Last resort — return the chat container (unconfirmed) ──
  const fallback = document.querySelector(SELECTORS.chatContainer);
  if (fallback) {
    console.log(`[Clarity] 🧹 findScrollableChat: Using UNCONFIRMED fallback: <${fallback.tagName}.${[...fallback.classList].join('.')}>`);
  } else {
    console.log('[Clarity] 🧹 findScrollableChat: No container found at all');
  }
  return fallback;
}

// ── Helper: dispatch a synthetic WheelEvent scrolling UP ──
function simulateWheelUp(el) {
  el.dispatchEvent(new WheelEvent('wheel', {
    deltaY: -800,
    deltaX: 0,
    bubbles: true,
    cancelable: true,
  }));
  el.dispatchEvent(new Event('scroll', { bubbles: true }));
}

// ============================================================
// OF API — Direct message fetching (bypasses DOM scrolling)
// ============================================================

function getChatIdFromUrl() {
  // URL pattern: /my/chats/chat/{userId}
  const match = window.location.href.match(/\/my\/chats\/chat\/(\d+)/);
  return match ? match[1] : null;
}

function getCurrentUserId() {
  // Try auth_id cookie first
  const cookieMatch = document.cookie.match(/(?:^|;\s*)auth_id=(\d+)/);
  if (cookieMatch) return cookieMatch[1];
  // Fallback: look for user-id in meta tags
  const meta = document.querySelector('meta[name="user-id"]');
  if (meta) return meta.content;
  return null;
}

// Make an API call via the page context (uses OF's captured auth headers)
function fetchViaPageContext(url) {
  return new Promise((resolve, reject) => {
    const callbackId = '__clarity_' + Math.random().toString(36).slice(2) + Date.now();

    const handler = function(e) {
      if (e.data?.type === '__clarity_api_response' && e.data.callbackId === callbackId) {
        window.removeEventListener('message', handler);
        clearTimeout(timeout);
        if (e.data.error) {
          reject(new Error(e.data.error));
        } else {
          resolve(e.data.data);
        }
      }
    };

    window.addEventListener('message', handler);

    // Timeout after 15 seconds
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('API request timed out (15s)'));
    }, 15000);

    window.postMessage({
      type: '__clarity_api_request',
      callbackId,
      url
    }, '*');
  });
}

// Paginate through all messages via OF's REST API
async function fetchAllMessagesViaAPI(chatId, progressCallback) {
  console.log(`[Clarity] 🌐 API: Fetching all messages for chat ${chatId}...`);

  const currentUserId = getCurrentUserId();
  console.log(`[Clarity] 🌐 API: Current user ID: ${currentUserId || 'unknown'}`);

  const allMessages = [];
  let offsetId = null;
  let page = 0;
  const LIMIT = 50;

  while (true) {
    page++;

    // OF API: /api2/v2/chats/{chatId}/messages?limit=N&order=desc&skip_users=all
    // Pagination: &id=<lastId> gets messages BEFORE that ID
    let apiUrl = `https://onlyfans.com/api2/v2/chats/${chatId}/messages?limit=${LIMIT}&order=desc&skip_users=all`;
    if (offsetId) {
      apiUrl += `&id=${offsetId}`;
    }

    try {
      const data = await fetchViaPageContext(apiUrl);

      // Handle response — could be array or { list: [...] }
      const msgList = Array.isArray(data) ? data : (data?.list || data?.messages || []);

      if (!msgList || msgList.length === 0) {
        console.log(`[Clarity] 🌐 API: No more messages on page ${page}`);
        break;
      }

      for (const apiMsg of msgList) {
        const converted = convertApiMessage(apiMsg, currentUserId);
        if (converted && converted.text) {
          allMessages.push(converted);
        }
      }

      if (progressCallback) {
        progressCallback({
          phase: 'api-fetch',
          messagesFound: allMessages.length,
          iteration: page,
          scrollTop: 0
        });
      }

      console.log(`[Clarity] 🌐 API: Page ${page} — got ${msgList.length} msgs, total: ${allMessages.length}`);

      // Cursor for next page
      const lastMsg = msgList[msgList.length - 1];
      if (!lastMsg?.id || lastMsg.id === offsetId) break;
      offsetId = lastMsg.id;

      // Fewer than limit means we reached the beginning
      if (msgList.length < LIMIT) {
        console.log(`[Clarity] 🌐 API: Got ${msgList.length} < ${LIMIT} — reached beginning`);
        break;
      }

      // Rate limit: 300ms between requests
      await sleep(300);

      // Safety: max 500 pages = 25,000 messages
      if (page >= 500) {
        console.warn(`[Clarity] 🌐 API: Hit page cap (${page})`);
        break;
      }

    } catch (err) {
      console.error(`[Clarity] 🌐 API: Error on page ${page}:`, err.message);
      if (page === 1) {
        throw new Error('API failed on first page: ' + err.message);
      }
      break; // Return what we have
    }
  }

  // Sort chronologically (API returns newest first, we want oldest first)
  allMessages.reverse();

  // Reassign order indices
  allMessages.forEach((msg, i) => { msg.order = i; });

  console.log(`[Clarity] 🌐 API: Complete — ${allMessages.length} total messages`);

  // ── Convert CDN URL thumbnails to permanent base64 ──
  // OF CDN signed URLs expire after ~4 hours. Convert them NOW
  // while they're still valid, so they persist in Firestore forever.
  if (allMessages.some(m => m.mediaThumbnail && m.mediaThumbnail.startsWith('http'))) {
    console.log(`[Clarity] 🌐 API: Converting CDN thumbnails to base64 before returning...`);
    await convertUrlThumbnailsToBase64(allMessages);
  }

  return allMessages;
}

// Convert an OF API message object to our internal format
function convertApiMessage(apiMsg, currentUserId) {
  if (!apiMsg) return null;

  // ── Determine sender ──
  let isFromMe = false;
  if (currentUserId && apiMsg.fromUser?.id) {
    isFromMe = String(apiMsg.fromUser.id) === String(currentUserId);
  } else if (apiMsg.isAuthor !== undefined) {
    // Some OF API responses have this field
    isFromMe = !!apiMsg.isAuthor;
  }

  // ── Extract text ──
  let text = '';
  if (apiMsg.text) {
    // OF API text might contain HTML — strip it
    const tmp = document.createElement('div');
    tmp.innerHTML = apiMsg.text;
    text = (tmp.textContent || tmp.innerText || '').trim();
  }

  // ── Extract media ──
  let mediaType = null;
  let mediaUrl = null;
  let mediaThumbnail = null;

  if (apiMsg.media && apiMsg.media.length > 0) {
    const m = apiMsg.media[0];
    const mType = (m.type || '').toLowerCase();

    if (mType === 'video' || mType === 'gif') {
      mediaType = 'video';
    } else if (mType === 'photo' || mType === 'image') {
      mediaType = 'image';
    } else if (mType) {
      mediaType = 'media';
    } else {
      mediaType = 'media';
    }

    // Try to get URLs from various possible field structures
    mediaThumbnail = m.preview || m.thumb || m.squarePreview ||
                     m.files?.preview?.url || m.files?.thumb?.url || null;
    mediaUrl = m.src || m.full || m.files?.source?.url || m.files?.full?.url || null;
  }

  // ── PPV / Payment ──
  let paymentStatus = null;
  let paymentAmount = null;

  if (apiMsg.price && parseFloat(apiMsg.price) > 0) {
    paymentAmount = `$${apiMsg.price}`;
    paymentStatus = apiMsg.isOpened ? 'paid' : 'unpaid';
    if (!mediaType) mediaType = 'ppv';
  }

  // ── Tips ──
  let tipAmount = null;
  if (apiMsg.isTip && apiMsg.tipAmount) {
    tipAmount = `$${apiMsg.tipAmount}`;
  }

  // ── Generate placeholder text for media-only messages ──
  if (!text && mediaType) {
    switch (mediaType) {
      case 'image': text = '[📷 Image]'; break;
      case 'video': text = '[🎬 Video]'; break;
      case 'ppv': text = '[💰 PPV Content]'; break;
      default: text = '[📎 Media]'; break;
    }
  }
  if (!text && tipAmount) {
    text = `[💎 Tip ${tipAmount}]`;
  }

  // Skip empty messages
  if (!text && !mediaType && !tipAmount) return null;

  // ── Extract reply/quoted message ──
  let replyTo = null;
  // OF API uses various fields for reply data
  const replyMsg = apiMsg.replyMessage || apiMsg.reply || apiMsg.quotedMessage || null;
  if (replyMsg) {
    let replyText = '';
    if (replyMsg.text) {
      const tmp2 = document.createElement('div');
      tmp2.innerHTML = replyMsg.text;
      replyText = (tmp2.textContent || tmp2.innerText || '').trim();
    }
    const replyAuthor = replyMsg.fromUser?.name || replyMsg.fromUser?.username || null;
    if (replyText || replyAuthor) {
      replyTo = { text: replyText || null, author: replyAuthor || null };
    }
  }
  // Fallback: if there's a replyId but no embedded reply object, note it
  if (!replyTo && (apiMsg.replyId || apiMsg.replyMessageId)) {
    replyTo = { text: null, author: null, replyId: String(apiMsg.replyId || apiMsg.replyMessageId) };
  }

  // ── Build datetime ──
  let datetime = apiMsg.createdAt || apiMsg.postedAt || '';
  // Ensure ISO format
  if (datetime && !datetime.includes('T')) {
    try { datetime = new Date(datetime).toISOString(); } catch (e) {}
  }

  return {
    id: apiMsg.id ? String(apiMsg.id) : null,
    text: text || '',
    isFromMe,
    time: '',
    datetime,
    order: 0,
    mediaType,
    mediaUrl,
    mediaThumbnail,
    paymentStatus,
    paymentAmount,
    tipAmount,
    replyTo,
  };
}

// ============================================================
// DRAFT STATE EXTRACTION
// ============================================================

export function extractDraftState() {
  try {
    const editor = document.querySelector(
      '.tiptap.ProseMirror.b-text-editor, ' +
      '[contenteditable="true"].b-text-editor, ' +
      '.b-chat__message-input [contenteditable="true"], ' +
      '.b-make-post__main-wrapper [contenteditable="true"]'
    );

    if (!editor) return null;

    const text = (editor.innerText || editor.textContent || '').trim();

    const composeArea = editor.closest('.b-chat__message-input, .b-make-post__main-wrapper, .b-chat__footer');
    const media = [];

    if (composeArea) {
      const previews = composeArea.querySelectorAll(
        '.b-dropzone__preview, .b-make-post__media-preview, [class*="preview-item"], [class*="media-preview"]'
      );
      previews.forEach((preview, idx) => {
        const img = preview.querySelector('img');
        const video = preview.querySelector('video');
        const isVideo = !!video;
        let thumbnail = null;
        if (img) {
          thumbnail = imgToBase64(img);
          if (!thumbnail) thumbnail = img.src || img.getAttribute('data-src');
        }
        media.push({ index: idx, type: isVideo ? 'video' : 'image', thumbnail });
      });
    }

    let price = null;
    const priceLabelEl = document.querySelector('.b-make-post__price-free-labels');
    if (priceLabelEl) {
      const priceDiv = priceLabelEl.querySelector('.b-make-post__price-free-label__price, [at-attr="msg_price"]');
      if (priceDiv) {
        const priceText = (priceDiv.textContent || '').replace(/[^0-9.]/g, '').trim();
        if (priceText) price = parseFloat(priceText) || null;
      }
    }
    if (!price) {
      const allPriceEls = document.querySelectorAll('.b-make-post__price-free-label__price, [at-attr="msg_price"]');
      for (const el of allPriceEls) {
        const pt = (el.textContent || '').replace(/[^0-9.]/g, '').trim();
        if (pt) { price = parseFloat(pt) || null; break; }
      }
    }

    if (!text && media.length === 0 && !price) return null;
    return { text, media, price };
  } catch (err) {
    console.error('[Clarity] extractDraftState error:', err);
    return null;
  }
}

// ============================================================
// DRAFT OBSERVER — watches compose area for changes
// ============================================================

export function startDraftObserver() {
  if (draftObserver) return;

  const composeArea = document.querySelector(
    '.b-chat__message-input, .b-make-post__main-wrapper, .b-chat__footer'
  );
  if (!composeArea) return;

  console.log('[Clarity] 📝 Starting draft observer');

  let debounceTimer = null;

  draftObserver = new MutationObserver(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const draft = extractDraftState();
      chrome.runtime.sendMessage({ type: 'CHAT_DRAFT_STATE', data: draft }).catch(() => {});
    }, 300);
  });

  draftObserver.observe(composeArea, {
    childList: true, subtree: true, characterData: true, attributes: true
  });
}

export function stopDraftObserver() {
  if (draftObserver) {
    console.log('[Clarity] 📝 Stopping draft observer');
    draftObserver.disconnect();
    draftObserver = null;
  }
}

// ============================================================
// UTILITY
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// FETCH IMAGE AS BASE64 — converts CDN URLs to permanent base64
// ============================================================
// OF CDN uses CloudFront signed URLs that expire after ~4 hours.
// We fetch them while still valid and convert to base64 data URLs
// that can be stored permanently in Firestore.
// ============================================================

// FIX H: Also reuses singleton canvas (same as Fix A) instead of creating new ones per fetch
async function fetchImageAsBase64(url, maxSize = 400) {
  try {
    if (!url || !url.startsWith('http')) return null;

    const resp = await fetch(url);
    if (!resp.ok) return null;

    const blob = await resp.blob();
    if (!blob || blob.size === 0) return null;

    // Convert blob → object URL → Image → Canvas → base64
    const objUrl = URL.createObjectURL(blob);
    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          let w = img.naturalWidth || img.width;
          let h = img.naturalHeight || img.height;
          if (w > maxSize || h > maxSize) {
            const ratio = Math.min(maxSize / w, maxSize / h);
            w = Math.round(w * ratio);
            h = Math.round(h * ratio);
          }
          // Reuse singleton canvas (avoids creating/GC'ing canvases during batch conversions)
          if (!_reusableCanvas) {
            _reusableCanvas = document.createElement('canvas');
            _reusableCtx = _reusableCanvas.getContext('2d');
          }
          _reusableCanvas.width = w;
          _reusableCanvas.height = h;
          _reusableCtx.drawImage(img, 0, 0, w, h);
          const dataUrl = _reusableCanvas.toDataURL('image/jpeg', 0.6);
          URL.revokeObjectURL(objUrl);
          img.src = ''; // Help GC release the image
          resolve(dataUrl);
        } catch (e) {
          URL.revokeObjectURL(objUrl);
          resolve(null);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        resolve(null);
      };
      img.src = objUrl;
    });
  } catch (e) {
    return null;
  }
}

// Quick conversion for a small batch of new messages (real-time observer/polling path)
// Unlike the full batch converter below, this handles 1-5 messages at a time
// and is called BEFORE sending to the bridge, so CRM always gets base64 thumbnails.
async function convertNewMessageThumbnails(msgs) {
  for (const msg of msgs) {
    if (msg.mediaThumbnail && typeof msg.mediaThumbnail === 'string' && msg.mediaThumbnail.startsWith('http')) {
      try {
        const base64 = await fetchImageAsBase64(msg.mediaThumbnail, 200);
        if (base64) msg.mediaThumbnail = base64;
      } catch (e) { /* keep CDN URL as fallback */ }
    }
  }
}

// Batch-convert all CDN URL thumbnails in a message array to base64
// Processes in parallel batches to avoid overwhelming the network
async function convertUrlThumbnailsToBase64(messages) {
  const BATCH_SIZE = 6;
  let converted = 0;
  let failed = 0;

  // Collect indices of messages with CDN URL thumbnails
  const toConvert = [];
  for (let i = 0; i < messages.length; i++) {
    const t = messages[i].mediaThumbnail;
    if (t && typeof t === 'string' && t.startsWith('http')) {
      toConvert.push(i);
    }
  }

  if (toConvert.length === 0) return messages;

  console.log(`[Clarity] 🖼️ Converting ${toConvert.length} CDN URL thumbnails to base64...`);

  for (let b = 0; b < toConvert.length; b += BATCH_SIZE) {
    const batchIndices = toConvert.slice(b, b + BATCH_SIZE);
    const results = await Promise.allSettled(
      batchIndices.map(async (idx) => {
        const maxSz = highQualityCapture ? 400 : 200;
        const base64 = await fetchImageAsBase64(messages[idx].mediaThumbnail, maxSz);
        if (base64) {
          messages[idx].mediaThumbnail = base64;
          converted++;
        } else {
          // Keep the CDN URL as fallback (works for ~4h) — better than nothing
          failed++;
        }
      })
    );
    // Small pause between batches to avoid hammering the CDN
    if (b + BATCH_SIZE < toConvert.length) await sleep(100);
  }

  console.log(`[Clarity] 🖼️ Thumbnail conversion done: ${converted} converted, ${failed} kept as CDN URLs`);
  return messages;
}

// ============================================================
// VIDEO URL ENRICHMENT — fetches video CDN URLs via OF API
// ============================================================
// DOM scraping can't get video URLs because OF's video.js loads
// them dynamically only on play. This function calls the OF API
// to get the actual video CDN URLs for a given chat.
// Used by the bridge after syncMessages writes video messages.
// ============================================================

export async function fetchVideoUrlsForChat(chatId) {
  if (!chatId) return {};

  console.log(`[Clarity] 🎬 Fetching video URLs for chat ${chatId} via API...`);

  // Ensure API interceptor is ready
  setupApiInterceptor();
  await new Promise(r => setTimeout(r, 500)); // Brief wait for headers

  const videoUrls = {};
  let offsetId = null;
  let page = 0;
  const LIMIT = 50;
  const MAX_PAGES = 10; // Only scan last 500 messages for videos

  try {
    while (page < MAX_PAGES) {
      page++;
      let apiUrl = `https://onlyfans.com/api2/v2/chats/${chatId}/messages?limit=${LIMIT}&order=desc&skip_users=all`;
      if (offsetId) apiUrl += `&id=${offsetId}`;

      const data = await fetchViaPageContext(apiUrl);
      const msgList = Array.isArray(data) ? data : (data?.list || data?.messages || []);

      if (!msgList || msgList.length === 0) break;

      for (const apiMsg of msgList) {
        if (!apiMsg.media || apiMsg.media.length === 0) continue;

        const m = apiMsg.media[0];
        const mType = (m.type || '').toLowerCase();

        if (mType === 'video' || mType === 'gif') {
          const mediaUrl = m.src || m.full || m.files?.source?.url || m.files?.full?.url || null;
          if (mediaUrl && apiMsg.id) {
            videoUrls[String(apiMsg.id)] = mediaUrl;
          }
        }
      }

      // Cursor for next page
      const lastMsg = msgList[msgList.length - 1];
      if (!lastMsg?.id || lastMsg.id === offsetId) break;
      offsetId = lastMsg.id;

      if (msgList.length < LIMIT) break;
      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`[Clarity] 🎬 Found ${Object.keys(videoUrls).length} video URLs from API (${page} pages scanned)`);
  } catch (err) {
    console.warn(`[Clarity] 🎬 Failed to fetch video URLs:`, err.message);
  }

  return videoUrls;
}

// Convert an already-loaded img element to a small base64 data URL
// This allows the sidepanel to display thumbnails without needing OnlyFans CDN auth
// FIX A: Reuses a single canvas element instead of creating thousands during scans
function imgToBase64(imgEl) {
  try {
    if (!imgEl || !imgEl.naturalWidth || !imgEl.complete) return null;
    
    // Use larger size for high-quality capture (CRM full/cleanup scans)
    const maxSize = highQualityCapture ? 400 : 120;
    let width = imgEl.naturalWidth;
    let height = imgEl.naturalHeight;
    
    if (width > maxSize || height > maxSize) {
      const ratio = Math.min(maxSize / width, maxSize / height);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }
    
    // Reuse singleton canvas (avoids creating/GC'ing thousands of canvases during scroll scans)
    if (!_reusableCanvas) {
      _reusableCanvas = document.createElement('canvas');
      _reusableCtx = _reusableCanvas.getContext('2d');
    }
    _reusableCanvas.width = width;
    _reusableCanvas.height = height;
    _reusableCtx.drawImage(imgEl, 0, 0, width, height);
    
    return _reusableCanvas.toDataURL('image/jpeg', 0.6);
  } catch (e) {
    // Canvas tainted by cross-origin image - can't convert
    return null;
  }
}
