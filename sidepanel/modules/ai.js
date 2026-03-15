// ============================================================
// AI MODULE
// ============================================================

import Store from '../state/store.js';
import { $, hide, show, escapeHtml } from '../utils/dom.js';
import { showNotification, showError, hideError, showLoading } from '../utils/notify.js';
import API, { detectPlatform } from '../utils/api.js';
import { checkGoalCompletion, renderScriptStages, getCurrentIncompleteAction, isActionCompleted, getSubscriberScriptStats, autoSkipSatisfiedGoals, getActionForGeneration } from './scripts/index.js';
import { markActionCompleted } from './scripts/goalDetection.js';
import { getProfileNow } from './scripts/timing.js';
import { checkSituationalTriggerWithAI } from './settings.js';
import { getImageById } from './imagePool.js';
import { updateCreditsFromResponse } from './credits.js';

// ============================================================
// HELPER FUNCTIONS
// ============================================================

// Convert blob to base64 data URL
const blobToBase64 = (blob) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

// Helper to extract subscriber ID from URL (similar to getSubscriberIdFromTab)
const getSubscriberIdFromTabUrl = (url) => {
  if (!url) return null;
  
  const platform = detectPlatform(url);
  
  if (platform === 'onlyfans') {
    // OnlyFans: /my/chats/chat/{id}
    const match = url.match(/\/chat\/(\d+)/);
    const id = match?.[1] || null;
    return id ? { platform: 'onlyfans', id, fullId: `of:${id}` } : null;
  } else if (platform === 'telegram') {
    // Telegram Web A: #@username or #-123456789 or #123456789
    const hash = new URL(url).hash;
    let id = null;
    
    if (hash.startsWith('#@')) {
      id = hash.substring(2); // Remove #@
    } else if (hash.startsWith('#-')) {
      id = hash.substring(1); // Keep minus sign
    } else {
      const match = hash.match(/^#(\d+)/);
      if (match) id = match[1];
    }
    
    return id ? { platform: 'telegram', id, fullId: `tg:${id}` } : null;
  }
  
  return null;
};

// ============================================================
// GREEN PREVIEW MESSAGE - Display response in chat as preview
// ============================================================

// Show loading animation in chat
const showLoadingInChat = () => {
  const chatMessages = $('chatMessages');
  if (!chatMessages) return;
  
  // Remove any existing loading/preview message
  removePreviewMessage();
  removeLoadingMessage();
  
  // Create loading message element
  const loadingEl = document.createElement('div');
  loadingEl.className = 'message from-me message-loading';
  loadingEl.id = 'loadingMessage';
  loadingEl.innerHTML = `
    <div class="loading-dots">
      <span></span>
      <span></span>
      <span></span>
    </div>
  `;
  
  chatMessages.appendChild(loadingEl);
  
  // Scroll to show the loading
  setTimeout(() => {
    loadingEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, 100);
  
  // Make response section compact
  const responseSection = document.querySelector('.response-section');
  if (responseSection) {
    responseSection.classList.add('compact');
  }
};

// Remove loading message from chat
const removeLoadingMessage = () => {
  const existingLoading = document.getElementById('loadingMessage');
  if (existingLoading) {
    existingLoading.remove();
  }
};

// Store multi-message data for sending
let pendingMultiMessages = [];

// Show a green preview message in the chat (instead of separate response section)
// Now supports multiple message bubbles for multi-message responses
const showPreviewInChat = (responseText, mediaInfo = null) => {
  const chatMessages = $('chatMessages');
  if (!chatMessages) {
    console.warn('[Preview] chatMessages container not found');
    return;
  }
  
  // Remove any existing preview/loading messages
  removePreviewMessage();
  removeLoadingMessage();
  
  // Check if it's a multi-message response
  const parsed = parseAIResponse(responseText);
  const isMulti = parsed.type === 'multi' && parsed.messages.length > 1;
  const messages = parsed.messages.length > 0 ? parsed.messages : [responseText];
  
  // Store messages for sending
  pendingMultiMessages = messages;
  
  // Create a container for all preview messages
  const previewContainer = document.createElement('div');
  previewContainer.id = 'previewMessage';
  previewContainer.className = 'preview-message-container';
  
  // Create separate bubbles for each message
  messages.forEach((msg, index) => {
    const previewEl = document.createElement('div');
    previewEl.className = 'message from-me message-preview';
    previewEl.dataset.messageIndex = index;
    
    // Build preview HTML
    let previewHTML = '';
    
    // Add media preview only to first message if present
    if (index === 0 && mediaInfo && (mediaInfo.thumbnail || mediaInfo.imageUrl)) {
      previewHTML += `
        <div class="preview-media">
          <img class="preview-media-thumb" src="${mediaInfo.thumbnail || mediaInfo.imageUrl}" alt="Media">
          <div class="preview-media-info">
            <span class="preview-media-badge">${mediaInfo.isVideo ? '🎥 Video' : '📸 Photo'}</span>
            ${mediaInfo.price > 0 ? `<span class="preview-media-price">$${mediaInfo.price}</span>` : ''}
          </div>
        </div>
      `;
    }
    
    // Add message text
    previewHTML += `<div class="message-text">${escapeHtml(msg.trim())}</div>`;
    
    // Only add time to last message
    if (index === messages.length - 1) {
      previewHTML += `<span class="message-time">Preview</span>`;
    }
    
    previewEl.innerHTML = previewHTML;
    previewContainer.appendChild(previewEl);
  });
  
  // Add action buttons after all messages
  const actionsEl = document.createElement('div');
  actionsEl.className = 'preview-actions-floating';
  actionsEl.innerHTML = `
    <button class="btn-preview-action btn-copy" id="previewCopyBtn" title="Copy">📋 Copy</button>
    <button class="btn-preview-action btn-regen" id="previewRegenBtn" title="Regenerate">🔄 Regen</button>
    <button class="btn-preview-action btn-send" id="previewSendBtn">📤 Send${isMulti ? ` (${messages.length})` : ''}</button>
  `;
  previewContainer.appendChild(actionsEl);
  
  // Append to chat
  chatMessages.appendChild(previewContainer);
  
  // Scroll so the last real message stays visible above the preview
  setTimeout(() => {
    const allMessages = chatMessages.querySelectorAll('.message:not(.message-preview)');
    const lastRealMsg = allMessages.length > 0 ? allMessages[allMessages.length - 1] : null;
    if (lastRealMsg) {
      lastRealMsg.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }, 100);
  
  // Attach event listeners to preview buttons
  setupPreviewButtonListeners();
  
  // Make the response section compact (hide old response area)
  const responseSection = document.querySelector('.response-section');
  if (responseSection) {
    responseSection.classList.add('compact');
  }
  
  console.log('[Preview] ✅ Green preview message(s) added to chat:', messages.length, 'bubbles');
};

// Remove the preview message from chat
const removePreviewMessage = () => {
  const existingPreview = document.getElementById('previewMessage');
  if (existingPreview) {
    existingPreview.remove();
  }
  
  // Remove compact mode from response section
  const responseSection = document.querySelector('.response-section');
  if (responseSection) {
    responseSection.classList.remove('compact');
  }
};

// Setup event listeners for preview action buttons
const setupPreviewButtonListeners = () => {
  // Copy button
  const copyBtn = document.getElementById('previewCopyBtn');
  if (copyBtn) {
    copyBtn.onclick = async () => {
      const previewText = document.querySelector('#previewMessage .message-text')?.textContent;
      if (previewText) {
        await navigator.clipboard.writeText(previewText);
        showNotification('📋 Copied!');
      }
    };
  }
  
  // Regenerate button
  const regenBtn = document.getElementById('previewRegenBtn');
  if (regenBtn) {
    regenBtn.onclick = () => {
      removePreviewMessage();
      generateResponse(); // Regenerate
    };
  }
  
  // Send button
  const sendBtn = document.getElementById('previewSendBtn');
  if (sendBtn) {
    sendBtn.onclick = async () => {
      await sendPreviewMessage();
    };
  }
};

// Send the preview message (called from preview's send button)
// Now supports sending multiple messages separately
const sendPreviewMessage = async () => {
  const previewContainer = document.getElementById('previewMessage');
  const sendBtn = document.getElementById('previewSendBtn');
  
  if (!previewContainer || !sendBtn) return;
  
  // Get all messages to send (use stored array or fallback to single text)
  const messagesToSend = pendingMultiMessages.length > 0 
    ? pendingMultiMessages 
    : [previewContainer.querySelector('.message-text')?.textContent?.trim()].filter(Boolean);
  
  if (messagesToSend.length === 0) {
    showNotification('❌ No text to send');
    return;
  }
  
  // Update button state
  sendBtn.disabled = true;
  const isMulti = messagesToSend.length > 1;
  sendBtn.textContent = isMulti ? `⏳ Sending 1/${messagesToSend.length}...` : '⏳ Sending...';
  
  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab?.id) {
      throw new Error('No active tab found');
    }
    
    // Get current action for progress tracking
    const currentAction = await getCurrentAction();
    
    // Get all preview bubbles
    const previewBubbles = previewContainer.querySelectorAll('.message-preview');
    
    // Send each message separately with delay
    for (let i = 0; i < messagesToSend.length; i++) {
      const text = messagesToSend[i];
      
      // Update button status
      if (isMulti) {
        sendBtn.textContent = `⏳ Sending ${i + 1}/${messagesToSend.length}...`;
      }
      
      // Send the message
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'SEND_MESSAGE',
        text: text
      });
      
      if (!response?.success) {
        throw new Error(`Failed to send message ${i + 1}: ${response?.error || 'Unknown error'}`);
      }
      
      // Convert this bubble from preview to sent
      if (previewBubbles[i]) {
        previewBubbles[i].classList.remove('message-preview');
        const timeEl = previewBubbles[i].querySelector('.message-time');
        if (timeEl) {
          timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
      }
      
      // Add to store
      const messages = Store.get('messages') || [];
      messages.push({
        text: text,
        isFromMe: true,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        datetime: new Date().toISOString()
      });
      Store.set('messages', messages);
      
      console.log(`[Preview] ✅ Sent message ${i + 1}/${messagesToSend.length}`);
      
      // Add delay between messages (except after the last one)
      if (i < messagesToSend.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Remove the floating action buttons
    const actionsEl = previewContainer.querySelector('.preview-actions-floating');
    if (actionsEl) actionsEl.remove();
    
    // Remove preview container ID
    previewContainer.id = '';
    
    // Clear pending messages
    pendingMultiMessages = [];
    
    // Mark action complete if applicable
    if (currentAction) {
      await markActionCompleted(currentAction.stageIndex, currentAction.actionIndex);
      renderScriptStages();
      showNotification(`✅ Step ${currentAction.stageIndex + 1}.${currentAction.actionIndex + 1} completed!`);
    } else {
      showNotification(isMulti ? `✅ ${messagesToSend.length} messages sent!` : '✅ Message sent!');
    }
    
    // Remove compact mode from response section
    const responseSection = document.querySelector('.response-section');
    if (responseSection) {
      responseSection.classList.remove('compact');
    }
    
  } catch (error) {
    console.error('[Preview] Send failed:', error);
    sendBtn.disabled = false;
    sendBtn.textContent = `📤 Send${pendingMultiMessages.length > 1 ? ` (${pendingMultiMessages.length})` : ''}`;
    showNotification('❌ ' + (error.message || 'Send failed'));
  }
};

// Parse AI response - handles both single messages and JSON array multi-messages
const parseAIResponse = (responseText) => {
  if (!responseText) return { type: 'single', messages: [] };
  
  // Trim the response
  responseText = responseText.trim();
  
  // Check if it's a JSON array format: ["msg1", "msg2", ...]
  if (responseText.startsWith('[') && responseText.endsWith(']')) {
    try {
      // Parse the JSON array
      const parsed = JSON.parse(responseText);
      
      // Validate it's an array
      if (Array.isArray(parsed)) {
        console.log('[AI MultiMessage] ✅ Detected JSON array format:', parsed.length, 'messages');
        
        // Clean and validate each message
        const cleanedMessages = parsed
          .filter((msg, index) => {
            if (typeof msg !== 'string') {
              console.warn(`[AI MultiMessage] Message ${index + 1} is not a string, skipping`);
              return false;
            }
            if (msg.trim().length === 0) {
              console.warn(`[AI MultiMessage] Message ${index + 1} is empty, skipping`);
              return false;
            }
            return true;
          })
          .map(msg => msg.trim())
          .slice(0, 4); // Max 4 messages
        
        if (cleanedMessages.length >= 1) {
          return {
            type: cleanedMessages.length > 1 ? 'multi' : 'single',
            messages: cleanedMessages,
            validated: true
          };
        } else {
          console.warn('[AI MultiMessage] No valid messages after filtering');
        }
      }
    } catch (e) {
      console.log('[AI MultiMessage] Failed to parse JSON array:', e.message);
      console.log('[AI MultiMessage] Raw response:', responseText.substring(0, 200));
    }
  }
  
  // Also check for old format with "type": "multi_message" (backward compatibility)
  if (responseText.startsWith('{') && responseText.includes('"multi_message"')) {
    try {
      const parsed = JSON.parse(responseText);
      if (parsed.type === 'multi_message' && Array.isArray(parsed.messages)) {
        console.log('[AI MultiMessage] ✅ Detected old multi_message format:', parsed.messages.length, 'messages');
        const cleanedMessages = parsed.messages
          .filter(msg => typeof msg === 'string' && msg.trim().length > 0)
          .map(msg => msg.trim())
          .slice(0, 4);
        
        if (cleanedMessages.length >= 1) {
          return {
            type: cleanedMessages.length > 1 ? 'multi' : 'single',
            messages: cleanedMessages
          };
        }
      }
    } catch (e) {
      console.log('[AI MultiMessage] Failed to parse old format:', e.message);
    }
  }
  
  // Not JSON or parsing failed - treat as single message
  console.log('[AI MultiMessage] Single message format detected');
  return {
    type: 'single',
    messages: [responseText]
  };
};

// Bot accusation tracking per subscriber
const botAccusationTracker = new Map();

// Different excuse responses for repeated bot accusations (escalating)
const BOT_EXCUSE_RESPONSES = [
  "haha no im real, just sometimes i type weird cause im on my phone lol",
  "lol i promise im not a bot, im just multitasking rn sorry if i seem distracted",
  "omg no im real!! i just type fast sometimes and autocorrect messes me up 😅",
  "babe im real, i literally just woke up thats why im being weird lol"
];

// Final warning before blocking
const BOT_FINAL_WARNING = "okay well if you think im a bot then idk what to tell you... maybe we should just stop talking then 🤷‍♀️";

// Maximum accusations before auto-block
const MAX_BOT_ACCUSATIONS = 3;

// Get/increment bot accusation count for subscriber
const trackBotAccusation = (subscriberId) => {
  const currentCount = botAccusationTracker.get(subscriberId) || 0;
  const newCount = currentCount + 1;
  botAccusationTracker.set(subscriberId, newCount);
  return newCount;
};

// Check if subscriber should be blocked for bot accusations
const shouldBlockForBotAccusation = (subscriberId) => {
  const count = botAccusationTracker.get(subscriberId) || 0;
  return count >= MAX_BOT_ACCUSATIONS;
};

// Get appropriate response for bot accusation count
const getBotAccusationResponse = (accusationCount) => {
  if (accusationCount >= MAX_BOT_ACCUSATIONS) {
    return { response: BOT_FINAL_WARNING, shouldBlock: true };
  }
  
  // Cycle through excuses
  const responseIndex = Math.min(accusationCount - 1, BOT_EXCUSE_RESPONSES.length - 1);
  return { response: BOT_EXCUSE_RESPONSES[responseIndex], shouldBlock: false };
};

// Block subscriber via API
const blockSubscriberForBotAccusation = async (subscriberId, subscriberName) => {
  try {
    const profileId = Store.get('currentProfileId');
    if (!profileId) return false;
    
    await API.blockSubscriber(profileId, subscriberId, subscriberName, 'bot_accusation');
    console.log(`[Bot Detection] 🚫 Blocked ${subscriberName || subscriberId} for repeated bot accusations`);
    return true;
  } catch (error) {
    console.error('[Bot Detection] Failed to block subscriber:', error);
    return false;
  }
};

// Countdown timer interval reference
let countdownInterval = null;

// Check if script is complete (all actions done) - uses per-subscriber progress
const isScriptComplete = () => {
  const stats = getSubscriberScriptStats();
  return stats.total > 0 && stats.completed === stats.total;
};

// Check timing rules and return remaining wait time in ms (or 0 if can proceed)
const checkTimingRules = () => {
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
const getDefaultDelay = (messages, minMinutes) => {
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
const formatTimeRemaining = (ms) => {
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
const showTimeoutMessage = (remainingMs) => {
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
const clearTimeoutMessage = () => {
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

// Get current incomplete action from script - uses per-subscriber progress
// NOW with smart pre-check: skips already-satisfied actions before returning
const getCurrentAction = async () => {
  const currentScript = Store.get('currentScript');
  console.log('[AI Debug] currentScript:', currentScript?.name, 'stages:', currentScript?.stages?.length);
  
  if (!currentScript?.stages) {
    console.log('[AI Debug] No currentScript or stages - returning null');
    return null;
  }
  
  // Use the NEW smart pre-generation check
  // This checks if current action is satisfied and auto-advances if needed
  const incomplete = await getActionForGeneration();
  console.log('[AI Debug] getActionForGeneration result:', incomplete);
  
  if (!incomplete) {
    console.log('[AI Debug] No incomplete action found - all completed or error');
    return null;
  }
  
  // Use stageIdx/actionIdx (new names from ProgressManager)
  const stageIdx = incomplete.stageIdx ?? incomplete.stageIndex ?? 0;
  const actionIdx = incomplete.actionIdx ?? incomplete.actionIndex ?? 0;
  
  // Enrich with script context
  const stage = currentScript.stages[stageIdx];
  const result = {
    ...incomplete.action,
    stageIndex: stageIdx,
    actionIndex: actionIdx,
    stageName: stage?.name || incomplete.stageName || '',
    totalStages: currentScript.stages.length,
    scriptName: currentScript.name,
    goal: incomplete.goal
  };
  
  console.log('[AI Debug] Current action goal:', result.goal);
  return result;
};

// Get completed actions context - uses per-subscriber progress
const getCompletedActionsContext = () => {
  const currentScript = Store.get('currentScript');
  if (!currentScript?.stages) return '';
  
  const completed = [];
  
  currentScript.stages.forEach((stage, stageIdx) => {
    const actions = stage.actions || stage.messages || [];
    actions.forEach((action, actionIdx) => {
      // Check per-subscriber progress instead of action.completed
      if (isActionCompleted(stageIdx, actionIdx)) {
        completed.push(action.goal || action.text || '');
      }
    });
  });
  
  if (completed.length === 0) return '';
  return completed.slice(-5).join(', '); // Last 5 completed goals
};

// Get subscriber notes context
const getNotesContext = () => {
  // Try currentNotes first (from database), then storedChat.notes as fallback
  const notes = Store.get('currentNotes') || Store.get('storedChat')?.notes || {};
  
  const parts = [];
  if (notes.name) parts.push(`Name: ${notes.name}`);
  if (notes.age) parts.push(`Age: ${notes.age}`);
  if (notes.location) parts.push(`Location: ${notes.location}`);
  if (notes.job) parts.push(`Job: ${notes.job}`);
  if (notes.hobbies) parts.push(`Likes: ${notes.hobbies}`);
  if (notes.kinks) parts.push(`Kinks: ${notes.kinks}`);
  if (notes.other) parts.push(`Notes: ${notes.other}`);
  
  return parts.join(', ');
};

// Get profile context (YOUR persona info - ALL settings sent to AI)
const getProfileContext = () => {
  const profile = Store.get('currentProfile');
  if (!profile) return null;
  
  // Build a complete profile info object with ALL available data
  const profileInfo = {};
  
  // Identity
  if (profile.name) profileInfo.name = profile.name;
  if (profile.modelName) profileInfo.modelName = profile.modelName;
  if (profile.age) profileInfo.age = profile.age;
  
  // Location
  if (profile.country) profileInfo.country = profile.country;
  if (profile.city) profileInfo.city = profile.city;
  if (profile.matchSubscriberLocation) profileInfo.matchSubscriberLocation = profile.matchSubscriberLocation;
  if (profile.timezone) profileInfo.timezone = profile.timezone;
  
  // Appearance
  if (profile.bodyType) profileInfo.bodyType = profile.bodyType;
  if (profile.appearance?.hair) profileInfo.hairColor = profile.appearance.hair;
  if (profile.appearance?.eyes) profileInfo.eyeColor = profile.appearance.eyes;
  if (profile.relationshipStatus) profileInfo.relationshipStatus = profile.relationshipStatus;
  
  // Personality & Style
  if (profile.personality) profileInfo.personality = profile.personality;
  if (profile.defaultTone) profileInfo.tone = profile.defaultTone;
  if (profile.styleRules) profileInfo.style = profile.styleRules;
  
  // Kinks & Boundaries — critical for AI to know what's allowed
  if (profile.kinks?.length) profileInfo.kinks = profile.kinks;
  if (profile.boundaries?.length) profileInfo.boundaries = profile.boundaries;
  
  // Schedule — helps AI answer "when are you free?" naturally
  if (profile.schedule?.wakeUpTime) profileInfo.wakeUpTime = profile.schedule.wakeUpTime;
  if (profile.schedule?.sleepTime) profileInfo.sleepTime = profile.schedule.sleepTime;
  
  // CRITICAL: Include language setting for forced language response
  if (profile.language) {
    profileInfo.language = profile.language;
  }
  
  // Check if there's any actual data
  if (Object.keys(profileInfo).length === 0) return null;
  
  console.log('[AI] getProfileContext:', Object.keys(profileInfo).join(', '));
  return profileInfo;
};

// Update conversation summary
const updateSummary = async () => {
  const messages = Store.get('messages');
  const lastSummaryCount = Store.get('lastSummaryCount');
  const summary = Store.get('summary');
  
  const needsUpdate = messages.length >= 5 && 
    (messages.length - lastSummaryCount >= 10 || !summary);
  
  if (!needsUpdate) return;
  
  try {
    const response = await API.summarize({ messages });
    
    if (response.success && response.summary) {
      Store.set('summary', response.summary);
      Store.set('lastSummaryCount', messages.length);
    }
  } catch (error) {
    console.error('Summary generation failed:', error);
  }
};

// Generate response
export const generateResponse = async () => {
  const messages = Store.get('messages');
  
  if (!messages.length) {
    showError('No conversation loaded. Please open a chat first.');
    return;
  }
  
  // ============================================================
  // SITUATIONAL REACTIONS - Check if subscriber triggers a preset
  // ============================================================
  const subscriberMessages = messages.filter(m => !m.isFromMe);
  const lastSubscriberMsg = subscriberMessages[subscriberMessages.length - 1];
  
  // Track if we have a situational context to pass to AI
  let situationalContext = null;
  
  if (lastSubscriberMsg?.text) {
    const situationalMatch = await checkSituationalTriggerWithAI(lastSubscriberMsg.text);
    
    if (situationalMatch) {
      console.log(`[Situational] 🎯 Matched: "${situationalMatch.name}"`);
      
      // ============================================================
      // BOT ACCUSATION - Special handling with tracking & auto-block
      // ============================================================
      if (situationalMatch.trackAccusations) {
        // Get subscriber ID for tracking
        const subscriberId = Store.get('currentSubscriberId') || Store.get('storedChat')?.subscriberId || 'unknown';
        const subscriberName = Store.get('subscriberName') || Store.get('storedChat')?.username || '';
        
        // Check if already blocked
        if (shouldBlockForBotAccusation(subscriberId)) {
          console.log(`[Bot Detection] 🚫 Subscriber ${subscriberId} already blocked - ignoring`);
          showError('🚫 This subscriber has been blocked for repeated bot accusations');
          return;
        }
        
        // Track this accusation
        const accusationCount = trackBotAccusation(subscriberId);
        console.log(`[Bot Detection] 🤖 Bot accusation #${accusationCount} from ${subscriberName || subscriberId}`);
        
        // Get appropriate response for this accusation count
        const { response: botResponse, shouldBlock } = getBotAccusationResponse(accusationCount);
        
        const responseText = $('responseText');
        if (responseText) responseText.textContent = botResponse;
        
        // Hide media preview
        const previewContainer = $('mediaPreview');
        if (previewContainer) previewContainer.classList.add('hidden');
        
        show('generatedResponse');
        
        if (shouldBlock) {
          // This is the final warning - auto-block after sending
          showNotification(`🚫 Final warning sent - subscriber will be blocked!`);
          
          // Block the subscriber after a short delay (so response can be sent first)
          setTimeout(async () => {
            const blocked = await blockSubscriberForBotAccusation(subscriberId, subscriberName);
            if (blocked) {
              showNotification(`🚫 ${subscriberName || 'Subscriber'} has been blocked for bot accusations`);
            }
          }, 2000);
        } else {
          showNotification(`🤖 Bot accusation #${accusationCount}/${MAX_BOT_ACCUSATIONS} - excuse sent`);
        }
        
        return;
      }
      
      // ============================================================
      // ALL situational responses now use AI with preset as "inspiration"
      // The preset is passed as context, AI generates a natural response
      // ============================================================
      
      // Build situational context for AI
      situationalContext = {
        type: situationalMatch.id,
        name: situationalMatch.name,
        suggestedResponse: situationalMatch.response,
        continueScript: situationalMatch.continueScript || false,
        sendImage: situationalMatch.sendImage || false
      };
      
      // Set instruction based on whether to continue script or focus on situation
      if (situationalMatch.continueScript) {
        situationalContext.instruction = 'Briefly acknowledge this naturally, then continue with your script goal';
        console.log(`[Situational] 📝 AI will incorporate + continue script: ${situationalMatch.name}`);
        showNotification(`📷 Received media - AI generating response + script`);
      } else if (situationalMatch.sendImage) {
        // Special instruction for askImages - generate a flirty caption to accompany the image
        situationalContext.instruction = 'You are sending them a photo. Generate a SHORT flirty caption/follow-up message to go with the image. Examples: "like it?", "you like that?", "hope this makes your day better", "enjoy", "just for you". Keep it 2-6 words, teasing and confident.';
        console.log(`[Situational] 📸 AI will generate image caption for: ${situationalMatch.name}`);
        showNotification(`📸 Generating image + caption...`);
      } else {
        situationalContext.instruction = 'Generate a natural response for this situation. Use the suggested response as inspiration for tone/direction, but make it your own and sound human. Keep it short and flirty.';
        console.log(`[Situational] 🎯 AI will generate inspired response for: ${situationalMatch.name}`);
        showNotification(`🎭 Situational: ${situationalMatch.name} - generating AI response...`);
      }
      
      // ============================================================
      // SEND IMAGE from pool if sendImage flag is true (askImages preset)
      // ============================================================
      if (situationalMatch.sendImage) {
        console.log(`[Situational] 📸 sendImage flag detected - selecting image from pool`);
        
        try {
          // Get images from pool (stored in profile)
          const profile = Store.get('currentProfile');
          const imagePool = profile?.imagePool || [];
          
          if (imagePool.length > 0) {
            // Use AI to select best image based on user message
            const selectResponse = await API.selectImage({
              userMessage: lastSubscriberMsg.text,
              imageList: imagePool.map(img => ({
                id: img.id,
                name: img.name,
                description: img.description || '',
                category: img.category || 'other',
                tags: img.tags || []
              }))
            });
            
            if (selectResponse.success && selectResponse.selectedIndex !== null) {
              const selectedImage = imagePool[selectResponse.selectedIndex];
              console.log(`[Situational] 📸 Selected image: ${selectedImage.name} (${selectResponse.reason})`);
              
              // Store selected image for sending (both in context and in Store for sendToChat)
              situationalContext.selectedImage = selectedImage;
              Store.set('pendingSituationalImage', selectedImage);
              showNotification(`📸 Selected: ${selectedImage.name}`);
            } else {
              // Fallback: pick random image
              const randomImage = imagePool[Math.floor(Math.random() * imagePool.length)];
              situationalContext.selectedImage = randomImage;
              console.log(`[Situational] 📸 Random fallback image: ${randomImage.name}`);
            }
          } else {
            console.log(`[Situational] ⚠️ No images in pool - cannot send image`);
            showNotification(`⚠️ No images in pool to send`);
          }
        } catch (imgError) {
          console.error('[Situational] Image selection error:', imgError);
        }
      }
      
      // Continue to normal AI generation with situationalContext set
      // (removed the early return - AI will handle it)
    }
  }
  
  // ============================================================
  // Normal AI generation continues below...
  // ============================================================
  
  // Get current action from script first to check if it's media-only
  const currentAction = await getCurrentAction();
  
  // Debug logging for media actions
  console.log('[AI] ═══════════════════════════════════════════');
  console.log('[AI] Generate Response - Current Action Check');
  console.log('[AI] currentAction:', currentAction);
  console.log('[AI] currentAction.type:', currentAction?.type);
  console.log('[AI] currentAction.poolImage:', currentAction?.poolImage);
  console.log('[AI] currentAction.vaultItem:', currentAction?.vaultItem);
  console.log('[AI] ═══════════════════════════════════════════');
  
  // Check if current action is a media type with poolImage (Telegram/any platform)
  // If so, skip AI generation and auto-send the image
  const isMediaWithPoolImage = currentAction?.type === 'media' && currentAction?.poolImage;
  const isMediaWithVault = currentAction?.type === 'media' && currentAction?.vaultItem;
  
  console.log('[AI] isMediaWithPoolImage:', isMediaWithPoolImage);
  console.log('[AI] isMediaWithVault:', isMediaWithVault);
  
  // For media actions with pool image (Telegram or OnlyFans), auto-send the image
  if (isMediaWithPoolImage && !isMediaWithVault) {
    console.log('[AI] 📸 MEDIA ACTION with pool image detected!');
    console.log('[AI] 📸 Pool image:', currentAction.poolImage.name || currentAction.poolImage.id);
    
    // Show media preview
    updateMediaPreview(currentAction);
    
    // Set a simple caption instead of AI-generated text
    const responseTextEl = $('responseText');
    if (responseTextEl) {
      responseTextEl.textContent = ''; // No text for media-only actions
    }
    
    show('generatedResponse');
    
    // Auto-send the image
    await sendMediaOnly(currentAction);
    return;
  }
  
  // Check if script is complete AND timing rules are active
  if (isScriptComplete()) {
    const waitTime = checkTimingRules();
    if (waitTime > 0) {
      showTimeoutMessage(waitTime);
      showNotification(`Script complete! Wait ${formatTimeRemaining(waitTime)} before next response.`);
      return;
    }
  }
  
  // Clear any existing timeout message
  clearTimeoutMessage();
  
  // For OnlyFans, show loading in chat. For other platforms, use old loading
  const platform = Store.get('currentPlatform');
  if (platform === 'onlyfans') {
    showLoadingInChat();
  } else {
    showLoading(true);
  }
  hideError();
  hide('generatedResponse');
  
  try {
    updateSummary();
    
    // Get current action from script (with smart pre-check that skips satisfied actions)
    const currentAction = await getCurrentAction();
    
    // Re-render script stages in case actions were auto-skipped
    renderScriptStages();
    
    // Get context data
    const notesContext = getNotesContext();
    const completedContext = getCompletedActionsContext();
    
    // Determine tone - action tone overrides default
    const tone = currentAction?.tone || Store.get('tone');
    
    // Get script timing info for "when are you back?" questions
    const currentScript = Store.get('currentScript');
    const timingInfo = currentScript?.timingSettings?.minMinutes 
      ? `${currentScript.timingSettings.minMinutes} minutes` 
      : null;
    
    // Get profile info (YOUR persona's name, age, location, etc.)
    const profileInfo = getProfileContext();
    
    // DEBUG: Log what goal is being sent to the AI
    console.log('[AI] ═══════════════════════════════════════════');
    console.log('[AI] 🎯 SENDING TO API:');
    console.log('[AI]   actionGoal:', currentAction?.goal || '❌ NONE (freestyle mode)');
    console.log('[AI]   stage:', currentAction?.stageName || 'N/A');
    console.log('[AI]   tone:', tone);
    console.log('[AI] ═══════════════════════════════════════════');
    
    const response = await API.generateResponse({
      summary: Store.get('summary'),
      recentMessages: messages.slice(-5),
      currentStage: Store.get('currentStage'),
      tone: tone,
      persona: Store.get('persona'),
      // NEW: Profile data (YOUR persona info - name, age, etc.)
      profile: profileInfo,
      subscriberName: Store.get('subscriberName'),
      // Script integration data
      actionGoal: currentAction?.goal || null,
      actionType: currentAction?.type || 'text',
      actionTone: currentAction?.tone || null,
      scriptProgress: currentAction ? {
        scriptName: currentAction.scriptName,
        stageName: currentAction.stageName,
        stageIndex: currentAction.stageIndex + 1,
        totalStages: currentAction.totalStages
      } : null,
      completedGoals: completedContext,
      subscriberNotes: notesContext,
      // Script timing for "when back" questions
      replyDelay: timingInfo,
      // Situational context - e.g., they sent a photo
      situationalContext: situationalContext
    });
    
    showLoading(false);
    
    // Update credits from API response (shows toast with usage)
    updateCreditsFromResponse(response, true);
    
    if (response.success) {
      // Build media info if this is a media action
      let mediaInfo = null;
      if (currentAction?.type === 'media') {
        if (currentAction.vaultItem) {
          mediaInfo = {
            thumbnail: currentAction.vaultItem.thumbnail,
            isVideo: currentAction.vaultItem.mediaType === 'video',
            price: currentAction.price || 0
          };
        } else if (currentAction.poolImage) {
          mediaInfo = {
            imageUrl: currentAction.poolImage.downloadURL || currentAction.poolImage.imageData,
            isVideo: false,
            price: 0
          };
        }
      }
      
      // ✨ NEW: Show response as green preview message in chat (OnlyFans only for now)
      const platform = Store.get('currentPlatform');
      if (platform === 'onlyfans') {
        showPreviewInChat(response.response, mediaInfo);
        
        // Also update the old response section as backup (hidden in compact mode)
        const responseText = $('responseText');
        if (responseText) {
          const parsed = parseAIResponse(response.response);
          if (parsed.type === 'multi' && parsed.messages.length > 1) {
            responseText.innerHTML = parsed.messages.map((msg, i) => 
              `<div class="ai-message-part">${escapeHtml(msg.trim())}</div>`
            ).join('');
            responseText.classList.add('multi-message');
          } else {
            const singleMessage = parsed.messages[0] || response.response;
            responseText.textContent = singleMessage;
            responseText.classList.remove('multi-message');
          }
        }
        updateMediaPreview(currentAction);
        // Note: generatedResponse is hidden in compact mode when preview is shown
      } else {
        // Telegram/other platforms: use old behavior for now
        const responseText = $('responseText');
        if (responseText) {
          const parsed = parseAIResponse(response.response);
          
          if (parsed.type === 'multi' && parsed.messages.length > 1) {
            responseText.innerHTML = parsed.messages.map((msg, i) => 
              `<div class="ai-message-part">${escapeHtml(msg.trim())}</div>`
            ).join('');
            responseText.classList.add('multi-message');
            console.log('[AI] Displaying multi-message:', parsed.messages);
          } else {
            const singleMessage = parsed.messages[0] || response.response;
            responseText.textContent = singleMessage;
            responseText.classList.remove('multi-message');
          }
        }
        
        updateMediaPreview(currentAction);
        show('generatedResponse');
      }
    } else {
      showError(response.error || 'Failed to generate response');
    }
  } catch (error) {
    showLoading(false);
    showError('Failed to connect to AI service');
  }
};

// Send media only (no text) - for Telegram image actions
const sendMediaOnly = async (currentAction) => {
  const generateBtn = $('generateBtn');
  if (!generateBtn) return;
  
  // Update button to show sending state
  const originalHTML = generateBtn.innerHTML;
  generateBtn.disabled = true;
  generateBtn.innerHTML = '⏳ Sending Image...';
  
  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab?.id) {
      throw new Error('No active tab found');
    }
    
    const poolImageRef = currentAction.poolImage;
    
    console.log('[AI] poolImage reference:', poolImageRef);
    
    // Look up the actual image from the image pool using the ID
    // The image pool stores images with base64 data in localStorage
    let imageData = poolImageRef.imageData; // Try direct imageData first
    
    if (!imageData && poolImageRef.id) {
      // Lookup from image pool by ID
      const fullImage = getImageById(poolImageRef.id);
      console.log('[AI] Looked up image from pool:', fullImage?.name);
      if (fullImage && fullImage.imageData) {
        imageData = fullImage.imageData;
      }
    }
    
    // If no base64 data, try to fetch from URL and convert
    let finalImageData = imageData;
    
    if (!finalImageData && (poolImageRef.downloadURL || poolImageRef.url)) {
      const imageUrlToFetch = poolImageRef.downloadURL || poolImageRef.url;
      console.log('[AI] Fetching image from URL:', imageUrlToFetch.substring(0, 50) + '...');
      
      try {
        const response = await fetch(imageUrlToFetch);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const blob = await response.blob();
        finalImageData = await blobToBase64(blob);
        console.log('[AI] Converted URL to base64, size:', finalImageData.length);
      } catch (fetchError) {
        console.error('[AI] Failed to fetch image:', fetchError);
        throw new Error('Failed to download image. Please re-add it to the pool.');
      }
    }
    
    if (!finalImageData) {
      console.error('[AI] No image data found. Pool ref:', Object.keys(poolImageRef));
      throw new Error('No image data found. Please re-add the image to the pool.');
    }
    
    console.log('[AI] Sending image to Telegram:', poolImageRef.name);
    
    // Always send as base64 data for maximum compatibility
    const messagePayload = {
      type: 'SEND_IMAGE',
      imageUrl: finalImageData,
      isUrl: false,
      data: {
        imageData: finalImageData
      }
    };
    
    const imageResponse = await chrome.tabs.sendMessage(tab.id, messagePayload);
    
    if (!imageResponse?.success) {
      throw new Error(imageResponse?.error || 'Failed to send image');
    }
    
    console.log('[AI] Image sent successfully');
    
    generateBtn.innerHTML = '✅ Sent!';
    showNotification('📸 Image sent!');
    
    // Mark action as complete
    if (currentAction) {
      console.log('[AI] 🚀 Marking media action complete');
      await markActionCompleted(currentAction.stageIndex, currentAction.actionIndex);
      renderScriptStages();
      showNotification(`✅ Step ${currentAction.stageIndex + 1}.${currentAction.actionIndex + 1} completed!`);
    }
    
    // Reset button after 1 second
    setTimeout(() => {
      generateBtn.disabled = false;
      generateBtn.innerHTML = originalHTML;
      hide('generatedResponse');
    }, 1000);
    
  } catch (error) {
    console.error('[AI] Media send failed:', error);
    generateBtn.innerHTML = '❌ Failed';
    showError(error.message || 'Failed to send image');
    
    // Reset button after 2 seconds
    setTimeout(() => {
      generateBtn.disabled = false;
      generateBtn.innerHTML = originalHTML;
    }, 2000);
  }
};

// Update media preview in the response area
const updateMediaPreview = (currentAction) => {
  const previewContainer = $('mediaPreview');
  if (!previewContainer) return;
  
  const isPPV = currentAction?.type === 'media' && currentAction?.vaultItem;
  const isTelegramImage = currentAction?.type === 'media' && currentAction?.poolImage;
  
  if (isPPV) {
    const vaultItem = currentAction.vaultItem;
    const price = currentAction.price || 0;
    
    // Update preview elements
    const previewThumb = $('mediaPreviewThumb');
    const previewType = $('mediaPreviewType');
    const previewPrice = $('mediaPreviewPrice');
    const previewIcon = $('mediaPreviewIcon');
    const previewLabel = $('mediaPreviewLabel');
    
    // Set thumbnail
    if (previewThumb && vaultItem.thumbnail) {
      previewThumb.src = vaultItem.thumbnail;
      previewThumb.style.display = 'block';
    } else if (previewThumb) {
      previewThumb.style.display = 'none';
    }
    
    // Set media type badge
    if (previewType) {
      const isVideo = vaultItem.mediaType === 'video' || vaultItem.duration;
      previewType.textContent = isVideo ? '🎥 Video' : '📸 Photo';
      previewType.className = `media-type-badge ${isVideo ? 'video' : 'photo'}`;
    }
    
    // Set price badge
    if (previewPrice) {
      if (price > 0) {
        previewPrice.textContent = `$${price}`;
        previewPrice.classList.remove('hidden');
      } else {
        previewPrice.textContent = 'Free';
        previewPrice.classList.remove('hidden');
      }
    }
    
    // Set icon and label
    if (previewIcon) {
      previewIcon.textContent = vaultItem.mediaType === 'video' ? '🎥' : '📸';
    }
    if (previewLabel) {
      previewLabel.textContent = price > 0 ? `PPV $${price}` : 'Media Attached';
    }
    
    // Show the preview container
    previewContainer.classList.remove('hidden');
  } else if (isTelegramImage) {
    // Telegram pool image preview
    const poolImage = currentAction.poolImage;
    
    // Update preview elements
    const previewThumb = $('mediaPreviewThumb');
    const previewType = $('mediaPreviewType');
    const previewPrice = $('mediaPreviewPrice');
    const previewIcon = $('mediaPreviewIcon');
    const previewLabel = $('mediaPreviewLabel');
    
    // Set thumbnail - support both downloadURL (Firebase) and imageData (legacy)
    const imageUrl = poolImage.downloadURL || poolImage.imageData;
    if (previewThumb && imageUrl) {
      previewThumb.src = imageUrl;
      previewThumb.style.display = 'block';
    } else if (previewThumb) {
      previewThumb.style.display = 'none';
    }
    
    // Set media type badge
    if (previewType) {
      previewType.textContent = '📸 Image';
      previewType.className = 'media-type-badge photo';
    }
    
    // Hide price for Telegram
    if (previewPrice) {
      previewPrice.classList.add('hidden');
    }
    
    // Set icon and label
    if (previewIcon) {
      previewIcon.textContent = '📸';
    }
    if (previewLabel) {
      previewLabel.textContent = poolImage.name || 'Image Attached';
    }
    
    // Show the preview container
    previewContainer.classList.remove('hidden');
  } else {
    // Hide the preview container for text-only messages
    previewContainer.classList.add('hidden');
  }
};

// Handle quick actions
export const handleQuickAction = async (action) => {
  const prompts = {
    ppv: 'Offer PPV content seductively',
    greeting: 'Send warm flirty greeting',
    tease: 'Send playful teasing message',
    goodbye: 'Sweet goodbye, leave wanting more'
  };
  
  const messages = Store.get('messages');
  
  showLoading(true);
  hideError();
  hide('generatedResponse');
  
  const recentMsgs = [...messages.slice(-3), { text: `[${prompts[action]}]`, isFromMe: false }];
  
  try {
    const response = await API.generateResponse({
      summary: Store.get('summary'),
      recentMessages: recentMsgs,
      currentStage: action === 'ppv' ? 5 : Store.get('currentStage'),
      tone: Store.get('tone'),
      persona: Store.get('persona'),
      subscriberName: Store.get('subscriberName')
    });
    
    showLoading(false);
    
    if (response.success) {
      const responseText = $('responseText');
      if (responseText) responseText.textContent = response.response;
      show('generatedResponse');
    } else {
      showError(response.error || 'Failed to generate response');
    }
  } catch (error) {
    showLoading(false);
    showError('Failed to connect to AI service');
  }
};

// Copy response
export const copyResponse = async () => {
  const responseText = $('responseText');
  if (!responseText) return;
  
  try {
    // Check if it's a multi-message response
    const isMultiMessage = responseText.classList.contains('multi-message');
    let textToCopy;
    
    if (isMultiMessage) {
      // Get all message parts and join with newlines
      const messageParts = responseText.querySelectorAll('.ai-message-part');
      textToCopy = Array.from(messageParts)
        .map(part => part.textContent.trim())
        .join('\n\n');
    } else {
      // Single message
      textToCopy = responseText.textContent;
    }
    
    await navigator.clipboard.writeText(textToCopy);
    showNotification('Copied to clipboard!');
  } catch (error) {
    console.error('Failed to copy:', error);
  }
};

// Send response to chat (auto-send to OnlyFans/Telegram)
// Detects if current action is PPV with vault item (OnlyFans) or poolImage (Telegram) and routes accordingly
export const sendToChat = async () => {
  const responseText = $('responseText');
  const sendBtn = $('sendBtn');
  if (!responseText || !sendBtn) return;
  
  const text = responseText.textContent?.trim();
  if (!text) {
    showError('No response to send');
    return;
  }
  
  // Check if current action is a PPV with linked vault item (OnlyFans)
  const currentAction = await getCurrentAction();
  const isPPV = currentAction?.type === 'media' && currentAction?.vaultItem;
  // Check if current action is a media action with pool image (any platform)
  const isPoolImage = currentAction?.type === 'media' && currentAction?.poolImage && !currentAction?.vaultItem;
  
  // Update button to show sending state
  const originalHTML = sendBtn.innerHTML;
  sendBtn.disabled = true;
  sendBtn.innerHTML = isPPV ? '⏳ Sending PPV...' : (isPoolImage ? '⏳ Sending Image...' : '⏳ Sending...');
  
  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab?.id) {
      throw new Error('No active tab found');
    }
    
    // CRITICAL: Verify we're sending to the correct chat
    const storedSubscriberId = Store.get('currentSubscriberId');
    const storedPlatform = Store.get('currentPlatform');
    
    if (!storedSubscriberId) {
      throw new Error('No chat selected. Please open a chat first.');
    }
    
    // Extract current chat from tab URL
    const currentChatInfo = await getSubscriberIdFromTabUrl(tab.url);
    
    console.log('[Chat Verification] Stored:', storedSubscriberId, 'Current tab:', currentChatInfo?.fullId);
    
    // Verify the tab is showing the same chat
    if (!currentChatInfo || currentChatInfo.fullId !== storedSubscriberId) {
      throw new Error(
        `⚠️ Wrong chat! You loaded ${Store.get('subscriberName') || storedSubscriberId} ` +
        `but the current tab shows ${currentChatInfo?.id || 'a different chat'}. ` +
        `Please go back to the correct chat.`
      );
    }
    
    // Additional platform check
    if (currentChatInfo.platform !== storedPlatform) {
      throw new Error(
        `⚠️ Platform mismatch! Extension shows ${storedPlatform} ` +
        `but current tab is ${currentChatInfo.platform}.`
      );
    }
    
    // Check if we're on the vault page
    const isOnVaultPage = tab.url?.includes('/my/vault');
    
    console.log('[Clarity AI] Send button clicked');
    console.log('[Clarity AI] isPPV:', isPPV);
    console.log('[Clarity AI] isOnVaultPage:', isOnVaultPage);
    console.log('[Clarity AI] currentAction:', currentAction);
    console.log('[Clarity AI] Tab URL:', tab.url);
    
    let response;
    
    if (isPPV && isOnVaultPage) {
      // Full vault PPV flow: select item → add to message → select user → send
      console.log('[Clarity AI] Using SEND_PPV_VIA_VAULT flow');
      console.log('[Clarity AI] Vault item:', currentAction.vaultItem);
      console.log('[Clarity AI] Subscriber:', Store.get('subscriberName'));
      
      response = await chrome.tabs.sendMessage(tab.id, {
        type: 'SEND_PPV_VIA_VAULT',
        data: {
          vaultItem: currentAction.vaultItem,
          subscriberName: Store.get('subscriberName'),
          price: currentAction.price || 0,
          text: text
        }
      });
      
      // Handle step-by-step errors for debugging
      if (!response?.success && response?.step) {
        console.log(`[Clarity AI] PPV flow failed at step: ${response.step}`, response.error);
        showError(`Failed at step "${response.step}": ${response.error}`);
      }
      
    } else if (isPoolImage) {
      // Pool image flow: send image first (for both Telegram and OnlyFans), then optionally send text
      console.log('[Clarity AI] Pool image action detected');
      const poolImage = currentAction.poolImage;
      
      // Get the image data - prefer base64 for reliability
      let imageData = poolImage.imageData;
      
      // If no base64 data, try to fetch from URL and convert
      if (!imageData && poolImage.downloadURL) {
        console.log('[Clarity AI] Fetching image from Firebase URL...');
        try {
          const fetchResponse = await fetch(poolImage.downloadURL);
          if (fetchResponse.ok) {
            const blob = await fetchResponse.blob();
            imageData = await blobToBase64(blob);
            console.log('[Clarity AI] ✅ Converted to base64');
          } else {
            throw new Error('Failed to fetch image');
          }
        } catch (fetchError) {
          console.error('[Clarity AI] Failed to fetch image:', fetchError);
          showNotification('⚠️ Image failed to load, sending text only');
        }
      }
      
      if (imageData) {
        console.log('[Clarity AI] Sending image:', poolImage.name);
        sendBtn.innerHTML = '⏳ Uploading image...';
        
        // Send the image first
        const imageResponse = await chrome.tabs.sendMessage(tab.id, {
          type: 'SEND_IMAGE',
          imageUrl: imageData,
          isUrl: false
        });
        
        if (!imageResponse?.success) {
          console.error('[Clarity AI] Failed to send image:', imageResponse?.error);
          // Continue with text even if image fails
          showNotification('⚠️ Image failed, sending text only');
        } else {
          console.log('[Clarity AI] Image sent successfully');
          showNotification('📸 Image sent!');
          // Wait a bit for image to be processed
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      // For OnlyFans pool images, we typically don't send additional text
      // For Telegram, we might send accompanying text
      // Check if there's meaningful text to send (not empty)
      if (text && text.trim().length > 0) {
        sendBtn.innerHTML = '⏳ Sending text...';
        response = await chrome.tabs.sendMessage(tab.id, {
          type: 'SEND_MESSAGE',
          text: text
        });
      } else {
        // No text, just mark as success since image was sent
        response = { success: true };
      }
      
    } else if (isPPV) {
      // On chat page - need to click vault button and navigate to vault
      console.log('[Clarity AI] On chat page with PPV action, starting vault flow...');
      
      // Get subscriber name - try multiple sources
      let subscriberName = Store.get('subscriberName');
      
      // If empty, try to extract from current chat URL or header
      if (!subscriberName) {
        // The tab URL might have the user ID like /my/chats/chat/182066329/
        const urlMatch = tab.url?.match(/\/chat\/(\d+)/);
        if (urlMatch) {
          subscriberName = urlMatch[1]; // Use the numeric ID as identifier
        }
      }
      
      // Also check storedChat for username
      if (!subscriberName) {
        const storedChat = Store.get('storedChat');
        subscriberName = storedChat?.username || storedChat?.name || '';
      }
      
      console.log('[Clarity AI] Subscriber name for PPV:', subscriberName);
      
      // Store pending PPV data for continuation on vault page
      const pendingPPV = {
        vaultItem: currentAction.vaultItem,
        subscriberName: subscriberName,
        price: currentAction.price || 0,
        text: text
      };
      
      await chrome.storage.local.set({ pendingPPV });
      console.log('[Clarity AI] Stored pending PPV data:', pendingPPV);
      
      // Tell content script to click the vault button (which navigates to vault)
      response = await chrome.tabs.sendMessage(tab.id, {
        type: 'CLICK_VAULT_BUTTON'
      });
      
      if (response?.success) {
        // Button clicked, navigation happening
        sendBtn.innerHTML = '🔄 Opening vault...';
        showNotification('Opening vault to select media...');
        
        // Reset button after a delay (vault page will complete the flow)
        setTimeout(() => {
          sendBtn.disabled = false;
          sendBtn.innerHTML = originalHTML;
        }, 3000);
        return; // Don't throw error, flow continues on vault page
      } else if (response?.error === 'vault_button_not_found') {
        // Fallback: just send the message without vault selection
        console.log('[Clarity AI] Vault button not found, sending text only');
        response = await chrome.tabs.sendMessage(tab.id, {
          type: 'SEND_MESSAGE',
          text: text
        });
      } else {
        throw new Error(response?.error || 'Could not start vault flow');
      }
    } else {
      // ============================================================
      // CHECK FOR PENDING SITUATIONAL IMAGE (from askImages trigger)
      // ============================================================
      const pendingImage = Store.get('pendingSituationalImage');
      if (pendingImage) {
        console.log('[Clarity AI] 📸 Pending situational image found:', pendingImage.name);
        
        // Send the image first
        const imageUrl = pendingImage.downloadURL || pendingImage.imageData;
        if (imageUrl) {
          try {
            const imageResponse = await chrome.tabs.sendMessage(tab.id, {
              type: 'SEND_IMAGE',
              imageUrl: imageUrl,
              isUrl: !!pendingImage.downloadURL
            });
            
            if (imageResponse?.success) {
              console.log('[Clarity AI] 📸 Situational image sent successfully');
              showNotification('📸 Image sent!');
              // Wait a bit before sending text
              await new Promise(resolve => setTimeout(resolve, 1000));
            } else {
              console.error('[Clarity AI] Failed to send situational image:', imageResponse?.error);
            }
          } catch (imgError) {
            console.error('[Clarity AI] Image send error:', imgError);
          }
        }
        
        // Clear the pending image
        Store.set('pendingSituationalImage', null);
      }
      
      // Check if it's a multi-message response
      const isMultiMessage = responseText.classList.contains('multi-message');
      
      if (isMultiMessage) {
        // Send multiple messages separately
        const messageParts = responseText.querySelectorAll('.ai-message-part');
        const messages = Array.from(messageParts).map(part => part.textContent.trim());
        
        console.log('[Clarity AI] Sending multiple messages:', messages.length);
        
        // Send each message with a small delay between them
        for (let i = 0; i < messages.length; i++) {
          const messageResponse = await chrome.tabs.sendMessage(tab.id, {
            type: 'SEND_MESSAGE',
            text: messages[i]
          });
          
          if (!messageResponse?.success) {
            throw new Error(`Failed to send message ${i + 1}: ${messageResponse?.error || 'Unknown error'}`);
          }
          
          // Add delay between messages (except after the last one)
          if (i < messages.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
          }
        }
        
        response = { success: true };
      } else {
        // Send single message
        response = await chrome.tabs.sendMessage(tab.id, {
          type: 'SEND_MESSAGE',
          text: text
        });
      }
    }
    
    if (response?.success) {
      sendBtn.innerHTML = '✅ Sent!';
      showNotification(isPPV ? 'PPV sent!' : 'Message sent to chat!');
      
      console.log('[Clarity AI] Message sent successfully!');
      
      // Add the sent message to local messages list
      const messages = Store.get('messages') || [];
      messages.push({
        text: text,
        isFromMe: true,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        datetime: new Date().toISOString()
      });
      Store.set('messages', messages);
      
      // ============================================================
      // OPTIMISTIC PROGRESSION - Mark action complete IMMEDIATELY
      // This makes progress feel instant instead of waiting for AI
      // ============================================================
      if (currentAction) {
        console.log('[Clarity AI] 🚀 Optimistic progression - marking action complete immediately');
        await markActionCompleted(currentAction.stageIndex, currentAction.actionIndex);
        renderScriptStages();
        showNotification(`✅ Step ${currentAction.stageIndex + 1}.${currentAction.actionIndex + 1} completed!`);
      }
      
      // Reset button after 1 second (faster since we're not waiting for AI)
      setTimeout(() => {
        sendBtn.disabled = false;
        sendBtn.innerHTML = originalHTML;
      }, 1000);
    } else {
      throw new Error(response?.error || 'Failed to send message');
    }
  } catch (error) {
    console.error('Send to chat failed:', error);
    sendBtn.innerHTML = '❌ Failed';
    showError(error.message || 'Failed to send message to chat');
    
    // Reset button after 2 seconds
    setTimeout(() => {
      sendBtn.disabled = false;
      sendBtn.innerHTML = originalHTML;
    }, 2000);
  }
};

// ============================================================
// TEST MEDIA PANEL - For OnlyFans image sending testing
// ============================================================

// Currently selected image for sending
let selectedTestMediaImage = null;

// Load and render images in the test media grid
const loadTestMediaGrid = () => {
  const grid = $('testMediaGrid');
  if (!grid) return;
  
  const profile = Store.get('currentProfile');
  const currentScript = Store.get('currentScript');
  
  // Get images from script pool first, then profile pool
  const scriptImages = currentScript?.imagePool || [];
  const profileImages = profile?.imagePool || [];
  const imagePool = scriptImages.length > 0 ? scriptImages : profileImages;
  
  if (!imagePool || imagePool.length === 0) {
    grid.innerHTML = '<div class="test-media-empty">No images in pool. Add images in Scripts → Image Pool</div>';
    const sendBtn = $('testSendSelectedBtn');
    if (sendBtn) sendBtn.disabled = true;
    return;
  }
  
  console.log('[Test Media] 📸 Found', imagePool.length, 'images in pool');
  
  // Render image grid - escape user-controlled names to prevent XSS
  grid.innerHTML = imagePool.map((img, index) => {
    const imageUrl = img.downloadURL || img.imageData;
    const safeName = escapeHtml(img.name || 'Image ' + (index + 1));
    const safeAlt = escapeHtml(img.name || 'Image');
    return `
      <div class="test-media-item" data-index="${index}" data-id="${img.id || index}">
        <img src="${imageUrl}" alt="${safeAlt}">
        <div class="test-media-item-name">${safeName}</div>
      </div>
    `;
  }).join('');
  
  // Add click handlers for selection
  grid.querySelectorAll('.test-media-item').forEach(item => {
    item.addEventListener('click', () => {
      // Remove selection from all items
      grid.querySelectorAll('.test-media-item').forEach(i => i.classList.remove('selected'));
      
      // Select this item
      item.classList.add('selected');
      
      const index = parseInt(item.dataset.index);
      selectedTestMediaImage = imagePool[index];
      
      console.log('[Test Media] Selected:', selectedTestMediaImage.name);
      
      // Enable send button
      const sendBtn = $('testSendSelectedBtn');
      if (sendBtn) sendBtn.disabled = false;
    });
  });
};

// Toggle the test media panel
const toggleTestMediaPanel = () => {
  const panel = $('testMediaPanel');
  const body = $('testMediaBody');
  const arrow = $('testMediaArrow');
  
  if (!panel || !body) return;
  
  const isCollapsed = panel.classList.contains('collapsed');
  
  if (isCollapsed) {
    panel.classList.remove('collapsed');
    body.classList.remove('hidden');
    if (arrow) arrow.textContent = '▼';
    
    // Load images when panel opens
    loadTestMediaGrid();
  } else {
    panel.classList.add('collapsed');
    body.classList.add('hidden');
    if (arrow) arrow.textContent = '▶';
  }
};

// Test send media from image pool (for OnlyFans testing)
export const testSendMedia = async () => {
  if (!selectedTestMediaImage) {
    showError('Please select an image first!');
    return;
  }
  
  const imageToSend = selectedTestMediaImage;
  console.log('[Test Media] 📸 Sending image:', imageToSend.name);
  
  // Get image data
  let imageData = imageToSend.imageData;
  
  if (!imageData && imageToSend.downloadURL) {
    console.log('[Test Media] 📸 Fetching from Firebase URL...');
    try {
      const response = await fetch(imageToSend.downloadURL);
      if (response.ok) {
        const blob = await response.blob();
        imageData = await blobToBase64(blob);
        console.log('[Test Media] ✅ Converted to base64');
      } else {
        throw new Error('Failed to fetch image');
      }
    } catch (err) {
      showError('Failed to load image: ' + err.message);
      return;
    }
  }
  
  if (!imageData) {
    showError('No image data found for: ' + imageToSend.name);
    return;
  }
  
  // Send to OnlyFans via content script
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab?.id || !tab.url?.includes('onlyfans.com')) {
      showError('Please open an OnlyFans chat first!');
      return;
    }
    
    showNotification('📸 Sending test image: ' + imageToSend.name);
    
    const sendBtn = $('testSendSelectedBtn');
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.textContent = '⏳ Sending...';
    }
    
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'SEND_IMAGE',
      imageUrl: imageData,
      caption: null
    });
    
    console.log('[Test Media] Result:', result);
    
    if (result?.success) {
      showNotification('✅ Image sent successfully!');
      if (sendBtn) sendBtn.textContent = '✅ Sent!';
      
      // Reset after 2 seconds
      setTimeout(() => {
        if (sendBtn) {
          sendBtn.textContent = '📤 Send Selected';
          sendBtn.disabled = !selectedTestMediaImage;
        }
      }, 2000);
    } else {
      showError('Failed: ' + (result?.error || 'Unknown error'));
      if (sendBtn) {
        sendBtn.textContent = '❌ Failed';
        setTimeout(() => {
          sendBtn.textContent = '📤 Send Selected';
          sendBtn.disabled = false;
        }, 2000);
      }
    }
  } catch (err) {
    console.error('[Test Media] Error:', err);
    showError('Send failed: ' + err.message);
    
    const sendBtn = $('testSendSelectedBtn');
    if (sendBtn) {
      sendBtn.textContent = '📤 Send Selected';
      sendBtn.disabled = false;
    }
  }
};

// Setup test media panel listeners
const setupTestMediaListeners = () => {
  // Panel toggle
  $('testMediaHeaderToggle')?.addEventListener('click', toggleTestMediaPanel);
  
  // Send button
  $('testSendSelectedBtn')?.addEventListener('click', testSendMedia);
  
  // Refresh button
  $('testRefreshPoolBtn')?.addEventListener('click', loadTestMediaGrid);
};

// Setup event listeners
export const setupAIListeners = () => {
  $('generateBtn')?.addEventListener('click', generateResponse);
  $('regenerateBtn')?.addEventListener('click', generateResponse);
  $('copyBtn')?.addEventListener('click', copyResponse);
  $('sendBtn')?.addEventListener('click', sendToChat);
  $('testMediaBtn')?.addEventListener('click', testSendMedia); // Test media button (in response actions)
  
  document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => handleQuickAction(btn.dataset.action));
  });
  
  // Setup test media panel listeners
  setupTestMediaListeners();
};

// ============================================================
// GENERATE RESPONSE TEXT (for auto-chat - no UI interaction)
// Returns the response text directly instead of writing to UI
// ============================================================
export const generateResponseText = async (options = {}) => {
  const { overrideGoal } = options;
  const messages = Store.get('messages');
  
  if (!messages || messages.length === 0) {
    console.error('[AI] No messages for generation');
    return null;
  }
  
  try {
    // Update summary if needed
    await updateSummary();
    
    // Get current action from script (with smart pre-check that skips satisfied actions)
    const currentAction = await getCurrentAction();
    console.log('[AI generateResponseText] currentAction:', currentAction);
    
    // Get context data
    const notesContext = getNotesContext();
    const completedContext = getCompletedActionsContext();
    
    // Determine tone - action tone overrides default
    const tone = currentAction?.tone || Store.get('tone');
    
    // Get script timing info
    const currentScript = Store.get('currentScript');
    const timingInfo = currentScript?.timingSettings?.minMinutes 
      ? `${currentScript.timingSettings.minMinutes} minutes` 
      : null;
    
    console.log('[AI generateResponseText] actionGoal:', currentAction?.goal);
    console.log('[AI generateResponseText] scriptName:', currentAction?.scriptName);
    
    // Get profile info (YOUR persona's name, age, location, etc.)
    const profileInfo = getProfileContext();
    
    // Use overrideGoal if provided (for media actions that need accompanying text)
    const goalToUse = overrideGoal || currentAction?.goal || null;
    
    if (overrideGoal) {
      console.log('[AI generateResponseText] Using overrideGoal:', overrideGoal);
    }
    
    const response = await API.generateResponse({
      summary: Store.get('summary'),
      recentMessages: messages.slice(-5),
      currentStage: Store.get('currentStage'),
      tone: tone,
      persona: Store.get('persona'),
      // Profile data (YOUR persona info - name, age, etc.)
      profile: profileInfo,
      subscriberName: Store.get('subscriberName'),
      // Script integration data - use overrideGoal if provided
      actionGoal: goalToUse,
      actionType: currentAction?.type || 'text',
      actionTone: currentAction?.tone || null,
      scriptProgress: currentAction ? {
        scriptName: currentAction.scriptName,
        stageName: currentAction.stageName,
        stageIndex: currentAction.stageIndex + 1,
        totalStages: currentAction.totalStages
      } : null,
      completedGoals: completedContext,
      subscriberNotes: notesContext,
      replyDelay: timingInfo
    });
    
    // Update credits from API response (shows toast with usage for auto-chat too)
    updateCreditsFromResponse(response, true);
    
    if (response.success && response.response) {
      return response.response;
    } else {
      console.error('[AI] Generation failed:', response.error);
      return null;
    }
  } catch (error) {
    console.error('[AI] Generation error:', error);
    return null;
  }
};

export default { generateResponse, generateResponseText, handleQuickAction, copyResponse, sendToChat, setupAIListeners };
