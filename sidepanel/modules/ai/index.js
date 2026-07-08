// ============================================================
// AI MODULE - Core (generateResponse, preview, actions)
// Split modules: helpers.js, timing.js, context.js, testMedia.js
// ============================================================

import Store from '../../state/store.js';
import { $, hide, show, escapeHtml } from '../../utils/dom.js';
import { showNotification, showError, hideError, showLoading } from '../../utils/notify.js';
import API, { detectPlatform } from '../../utils/api.js';
import { checkGoalCompletion, renderScriptStages, getCurrentIncompleteAction, isActionCompleted, getSubscriberScriptStats, autoSkipSatisfiedGoals, getActionForGeneration } from '../scripts/index.js';
import { markActionCompleted } from '../scripts/goalDetection.js';
import { getProfileNow } from '../scripts/timing.js';
import { checkSituationalTriggerWithAI } from '../settings.js';
import { getImageById } from '../imagePool.js';
import { updateCreditsFromResponse } from '../credits.js';

// Imports from extracted AI sub-modules
import { blobToBase64, getSubscriberIdFromTabUrl, parseAIResponse, trackBotAccusation, shouldBlockForBotAccusation, getBotAccusationResponse, blockSubscriberForBotAccusation, MAX_BOT_ACCUSATIONS } from './helpers.js';
import { isScriptComplete, checkTimingRules, getDefaultDelay, formatTimeRemaining, showTimeoutMessage, clearTimeoutMessage } from './timing.js';
import { getCurrentAction, getCompletedActionsContext, getNotesContext, getProfileContext, updateSummary } from './context.js';
import { testSendMedia, setupTestMediaListeners } from './testMedia.js';

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
    
    // ========== SEND MEDIA FIRST (if media action with pool image) ==========
    const isMediaAction = currentAction?.type === 'media' && currentAction?.poolImage && !currentAction?.vaultItem;
    
    if (isMediaAction) {
      sendBtn.textContent = '⏳ Sending media...';
      console.log('[Preview] 📸 Media action detected - sending image first');
      
      const poolImage = currentAction.poolImage;
      let imageData = poolImage.imageData;
      
      // If no base64 data, try to fetch from URL and convert
      if (!imageData && (poolImage.downloadURL || poolImage.url)) {
        const imageUrl = poolImage.downloadURL || poolImage.url;
        console.log('[Preview] 📸 Fetching image from URL...');
        try {
          const fetchResp = await fetch(imageUrl);
          if (fetchResp.ok) {
            const blob = await fetchResp.blob();
            imageData = await blobToBase64(blob);
            console.log('[Preview] 📸 ✅ Converted to base64');
          }
        } catch (fetchErr) {
          console.error('[Preview] 📸 Failed to fetch image:', fetchErr);
        }
      }
      
      // Also try looking up by ID from image pool
      if (!imageData && poolImage.id) {
        const fullImage = getImageById(poolImage.id);
        if (fullImage?.imageData) {
          imageData = fullImage.imageData;
          console.log('[Preview] 📸 Got image data from pool by ID');
        }
      }
      
      if (imageData) {
        const imgResult = await chrome.tabs.sendMessage(tab.id, {
          type: 'SEND_IMAGE',
          imageUrl: imageData,
          isUrl: false,
          price: currentAction.price || 0
        });
        
        if (!imgResult?.success) {
          console.error('[Preview] 📸 Image send failed:', imgResult?.error);
          showNotification('⚠️ Image failed, sending text only');
        } else {
          console.log('[Preview] 📸 ✅ Image sent!' + (currentAction.price > 0 ? ` (PPV $${currentAction.price})` : ''));
          showNotification(`📸 Media sent!${currentAction.price > 0 ? ` ($${currentAction.price})` : ''}`);
          // Wait for image upload/processing before sending text
          await new Promise(r => setTimeout(r, 2500));
        }
      } else {
        console.error('[Preview] 📸 No image data available');
        showNotification('⚠️ Could not load image, sending text only');
      }
      
      // Update button for text sending phase
      sendBtn.textContent = isMulti ? `⏳ Sending text 1/${messagesToSend.length}...` : '⏳ Sending text...';
    }
    
    // ========== SEND TEXT MESSAGES ==========
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

// ============================================================
// GENERATE RESPONSE
// ============================================================

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
          const profile = Store.get('currentProfile');
          const imagePool = profile?.imagePool || [];
          
          if (imagePool.length > 0) {
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
              situationalContext.selectedImage = selectedImage;
              Store.set('pendingSituationalImage', selectedImage);
              showNotification(`📸 Selected: ${selectedImage.name}`);
            } else {
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
  const isMediaWithPoolImage = currentAction?.type === 'media' && currentAction?.poolImage;
  const isMediaWithVault = currentAction?.type === 'media' && currentAction?.vaultItem;
  
  console.log('[AI] isMediaWithPoolImage:', isMediaWithPoolImage);
  console.log('[AI] isMediaWithVault:', isMediaWithVault);
  
  // For Telegram media actions with pool image, auto-send (existing behavior)
  // For OnlyFans, fall through to generate text + show preview with media
  if (isMediaWithPoolImage && !isMediaWithVault) {
    const currentPlatform = Store.get('currentPlatform');
    
    if (currentPlatform !== 'onlyfans') {
      console.log('[AI] 📸 MEDIA ACTION with pool image (Telegram) - auto-sending');
      updateMediaPreview(currentAction);
      const responseTextEl = $('responseText');
      if (responseTextEl) responseTextEl.textContent = '';
      show('generatedResponse');
      await sendMediaOnly(currentAction);
      return;
    }
    
    console.log('[AI] 📸 MEDIA ACTION with pool image (OnlyFans) - generating text from action goal');
    console.log('[AI] 📸 Pool image:', currentAction.poolImage.name || currentAction.poolImage.id);
    console.log('[AI] 📸 Action goal:', currentAction.goal);
    console.log('[AI] 📸 Price:', currentAction.price || 0);
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
    
    // Read AI mode (standard vs learned) from storage
    const aiModeData = await chrome.storage.local.get('aiMode');
    const aiMode = aiModeData.aiMode || 'standard';

    const response = await API.generateResponse({
      summary: Store.get('summary'),
      recentMessages: messages.slice(-15),
      currentStage: Store.get('currentStage'),
      tone: tone,
      persona: Store.get('persona'),
      profile: profileInfo,
      subscriberName: Store.get('subscriberName'),
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
      replyDelay: timingInfo,
      situationalContext: situationalContext,
      aiMode: aiMode
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
          const imgUrl = currentAction.poolImage.downloadURL || currentAction.poolImage.imageData;
          const isVid = currentAction.poolImage.mediaType === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(imgUrl || '');
          mediaInfo = {
            imageUrl: imgUrl,
            thumbnail: imgUrl,
            isVideo: isVid,
            price: currentAction.price || 0
          };
        }
      }
      
      // ✨ Show response as green preview message in chat (OnlyFans only for now)
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

// ============================================================
// MEDIA SENDING
// ============================================================

// Send media only (no text) - for Telegram image actions
const sendMediaOnly = async (currentAction) => {
  showNotification('⏳ Sending image...');

  try {

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab?.id) {
      throw new Error('No active tab found');
    }
    
    const poolImageRef = currentAction.poolImage;
    
    console.log('[AI] poolImage reference:', poolImageRef);
    
    let imageData = poolImageRef.imageData;
    
    if (!imageData && poolImageRef.id) {
      const fullImage = getImageById(poolImageRef.id);
      console.log('[AI] Looked up image from pool:', fullImage?.name);
      if (fullImage && fullImage.imageData) {
        imageData = fullImage.imageData;
      }
    }
    
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
    
    const messagePayload = {
      type: 'SEND_IMAGE',
      imageUrl: finalImageData,
      isUrl: false,
      price: currentAction.price || 0,
      data: {
        imageData: finalImageData
      }
    };
    
    const imageResponse = await chrome.tabs.sendMessage(tab.id, messagePayload);
    
    if (!imageResponse?.success) {
      throw new Error(imageResponse?.error || 'Failed to send image');
    }
    
    console.log('[AI] Image sent successfully');
    
    showNotification('📸 Image sent!');
    
    if (currentAction) {
      console.log('[AI] 🚀 Marking media action complete');
      await markActionCompleted(currentAction.stageIndex, currentAction.actionIndex);
      renderScriptStages();
      showNotification(`✅ Step ${currentAction.stageIndex + 1}.${currentAction.actionIndex + 1} completed!`);
    }
    
    setTimeout(() => {
      hide('generatedResponse');
    }, 1000);
    
  } catch (error) {
    console.error('[AI] Media send failed:', error);
    showError(error.message || 'Failed to send image');
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
    
    const previewThumb = $('mediaPreviewThumb');
    const previewType = $('mediaPreviewType');
    const previewPrice = $('mediaPreviewPrice');
    const previewIcon = $('mediaPreviewIcon');
    const previewLabel = $('mediaPreviewLabel');
    
    if (previewThumb && vaultItem.thumbnail) {
      previewThumb.src = vaultItem.thumbnail;
      previewThumb.style.display = 'block';
    } else if (previewThumb) {
      previewThumb.style.display = 'none';
    }
    
    if (previewType) {
      const isVideo = vaultItem.mediaType === 'video' || vaultItem.duration;
      previewType.textContent = isVideo ? '🎥 Video' : '📸 Photo';
      previewType.className = `media-type-badge ${isVideo ? 'video' : 'photo'}`;
    }
    
    if (previewPrice) {
      if (price > 0) {
        previewPrice.textContent = `$${price}`;
        previewPrice.classList.remove('hidden');
      } else {
        previewPrice.textContent = 'Free';
        previewPrice.classList.remove('hidden');
      }
    }
    
    if (previewIcon) {
      previewIcon.textContent = vaultItem.mediaType === 'video' ? '🎥' : '📸';
    }
    if (previewLabel) {
      previewLabel.textContent = price > 0 ? `PPV $${price}` : 'Media Attached';
    }
    
    previewContainer.classList.remove('hidden');
  } else if (isTelegramImage) {
    const poolImage = currentAction.poolImage;
    
    const previewThumb = $('mediaPreviewThumb');
    const previewType = $('mediaPreviewType');
    const previewPrice = $('mediaPreviewPrice');
    const previewIcon = $('mediaPreviewIcon');
    const previewLabel = $('mediaPreviewLabel');
    
    const imageUrl = poolImage.downloadURL || poolImage.imageData;
    if (previewThumb && imageUrl) {
      previewThumb.src = imageUrl;
      previewThumb.style.display = 'block';
    } else if (previewThumb) {
      previewThumb.style.display = 'none';
    }
    
    if (previewType) {
      previewType.textContent = '📸 Image';
      previewType.className = 'media-type-badge photo';
    }
    
    if (previewPrice) {
      previewPrice.classList.add('hidden');
    }
    
    if (previewIcon) {
      previewIcon.textContent = '📸';
    }
    if (previewLabel) {
      previewLabel.textContent = poolImage.name || 'Image Attached';
    }
    
    previewContainer.classList.remove('hidden');
  } else {
    previewContainer.classList.add('hidden');
  }
};

// ============================================================
// QUICK ACTIONS & CLIPBOARD
// ============================================================

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
    const isMultiMessage = responseText.classList.contains('multi-message');
    let textToCopy;
    
    if (isMultiMessage) {
      const messageParts = responseText.querySelectorAll('.ai-message-part');
      textToCopy = Array.from(messageParts)
        .map(part => part.textContent.trim())
        .join('\n\n');
    } else {
      textToCopy = responseText.textContent;
    }
    
    await navigator.clipboard.writeText(textToCopy);
    showNotification('Copied to clipboard!');
  } catch (error) {
    console.error('Failed to copy:', error);
  }
};

// ============================================================
// SEND TO CHAT
// ============================================================

// Send response to chat (auto-send to OnlyFans/Telegram)
export const sendToChat = async () => {
  const responseText = $('responseText');
  const sendBtn = $('sendBtn');
  if (!responseText || !sendBtn) return;
  
  const text = responseText.textContent?.trim();
  if (!text) {
    showError('No response to send');
    return;
  }
  
  const currentAction = await getCurrentAction();
  const isPPV = currentAction?.type === 'media' && currentAction?.vaultItem;
  const isPoolImage = currentAction?.type === 'media' && currentAction?.poolImage && !currentAction?.vaultItem;
  
  const originalHTML = sendBtn.innerHTML;
  sendBtn.disabled = true;
  sendBtn.innerHTML = isPPV ? '⏳ Sending PPV...' : (isPoolImage ? '⏳ Sending Image...' : '⏳ Sending...');
  
  try {
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
    
    const currentChatInfo = await getSubscriberIdFromTabUrl(tab.url);
    
    console.log('[Chat Verification] Stored:', storedSubscriberId, 'Current tab:', currentChatInfo?.fullId);
    
    if (!currentChatInfo || currentChatInfo.fullId !== storedSubscriberId) {
      throw new Error(
        `⚠️ Wrong chat! You loaded ${Store.get('subscriberName') || storedSubscriberId} ` +
        `but the current tab shows ${currentChatInfo?.id || 'a different chat'}. ` +
        `Please go back to the correct chat.`
      );
    }
    
    if (currentChatInfo.platform !== storedPlatform) {
      throw new Error(
        `⚠️ Platform mismatch! Extension shows ${storedPlatform} ` +
        `but current tab is ${currentChatInfo.platform}.`
      );
    }
    
    const isOnVaultPage = tab.url?.includes('/my/vault');
    
    console.log('[Clarity AI] Send button clicked');
    console.log('[Clarity AI] isPPV:', isPPV);
    console.log('[Clarity AI] isOnVaultPage:', isOnVaultPage);
    console.log('[Clarity AI] currentAction:', currentAction);
    console.log('[Clarity AI] Tab URL:', tab.url);
    
    let response;
    
    if (isPPV && isOnVaultPage) {
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
      
      if (!response?.success && response?.step) {
        console.log(`[Clarity AI] PPV flow failed at step: ${response.step}`, response.error);
        showError(`Failed at step "${response.step}": ${response.error}`);
      }
      
    } else if (isPoolImage) {
      console.log('[Clarity AI] Pool image action detected');
      const poolImage = currentAction.poolImage;
      
      let imageData = poolImage.imageData;
      
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
        
        const imageResponse = await chrome.tabs.sendMessage(tab.id, {
          type: 'SEND_IMAGE',
          imageUrl: imageData,
          isUrl: false,
          price: currentAction.price || 0
        });
        
        if (!imageResponse?.success) {
          console.error('[Clarity AI] Failed to send image:', imageResponse?.error);
          showNotification('⚠️ Image failed, sending text only');
        } else {
          console.log('[Clarity AI] Image sent successfully');
          showNotification('📸 Image sent!');
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      if (text && text.trim().length > 0) {
        sendBtn.innerHTML = '⏳ Sending text...';
        response = await chrome.tabs.sendMessage(tab.id, {
          type: 'SEND_MESSAGE',
          text: text
        });
      } else {
        response = { success: true };
      }
      
    } else if (isPPV) {
      console.log('[Clarity AI] On chat page with PPV action, starting vault flow...');
      
      let subscriberName = Store.get('subscriberName');
      
      if (!subscriberName) {
        const urlMatch = tab.url?.match(/\/chat\/(\d+)/);
        if (urlMatch) {
          subscriberName = urlMatch[1];
        }
      }
      
      if (!subscriberName) {
        const storedChat = Store.get('storedChat');
        subscriberName = storedChat?.username || storedChat?.name || '';
      }
      
      console.log('[Clarity AI] Subscriber name for PPV:', subscriberName);
      
      const pendingPPV = {
        vaultItem: currentAction.vaultItem,
        subscriberName: subscriberName,
        price: currentAction.price || 0,
        text: text
      };
      
      await chrome.storage.local.set({ pendingPPV });
      console.log('[Clarity AI] Stored pending PPV data:', pendingPPV);
      
      response = await chrome.tabs.sendMessage(tab.id, {
        type: 'CLICK_VAULT_BUTTON'
      });
      
      if (response?.success) {
        sendBtn.innerHTML = '🔄 Opening vault...';
        showNotification('Opening vault to select media...');
        
        setTimeout(() => {
          sendBtn.disabled = false;
          sendBtn.innerHTML = originalHTML;
        }, 3000);
        return;
      } else if (response?.error === 'vault_button_not_found') {
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
      // CHECK FOR PENDING SITUATIONAL IMAGE
      // ============================================================
      const pendingImage = Store.get('pendingSituationalImage');
      if (pendingImage) {
        console.log('[Clarity AI] 📸 Pending situational image found:', pendingImage.name);
        
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
              await new Promise(resolve => setTimeout(resolve, 1000));
            } else {
              console.error('[Clarity AI] Failed to send situational image:', imageResponse?.error);
            }
          } catch (imgError) {
            console.error('[Clarity AI] Image send error:', imgError);
          }
        }
        
        Store.set('pendingSituationalImage', null);
      }
      
      // Check if it's a multi-message response
      const isMultiMessage = responseText.classList.contains('multi-message');
      
      if (isMultiMessage) {
        const messageParts = responseText.querySelectorAll('.ai-message-part');
        const messages = Array.from(messageParts).map(part => part.textContent.trim());
        
        console.log('[Clarity AI] Sending multiple messages:', messages.length);
        
        for (let i = 0; i < messages.length; i++) {
          const messageResponse = await chrome.tabs.sendMessage(tab.id, {
            type: 'SEND_MESSAGE',
            text: messages[i]
          });
          
          if (!messageResponse?.success) {
            throw new Error(`Failed to send message ${i + 1}: ${messageResponse?.error || 'Unknown error'}`);
          }
          
          if (i < messages.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
        
        response = { success: true };
      } else {
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
      
      const messages = Store.get('messages') || [];
      messages.push({
        text: text,
        isFromMe: true,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        datetime: new Date().toISOString()
      });
      Store.set('messages', messages);
      
      // OPTIMISTIC PROGRESSION - Mark action complete IMMEDIATELY
      if (currentAction) {
        console.log('[Clarity AI] 🚀 Optimistic progression - marking action complete immediately');
        await markActionCompleted(currentAction.stageIndex, currentAction.actionIndex);
        renderScriptStages();
        showNotification(`✅ Step ${currentAction.stageIndex + 1}.${currentAction.actionIndex + 1} completed!`);
      }
      
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
    
    setTimeout(() => {
      sendBtn.disabled = false;
      sendBtn.innerHTML = originalHTML;
    }, 2000);
  }
};

// ============================================================
// EVENT LISTENERS
// ============================================================

// Setup event listeners
// ============================================================
// TRANSLATE MESSAGE - Type in another language, get natural English
// ============================================================
export const translateMessage = async () => {
  const input = $('translateInput');
  const langSelect = $('translateLangSelect');
  const translateBtn = $('translateBtn');
  const loading = $('translateLoading');
  const resultBox = $('translateResult');
  const output = $('translateOutput');
  const errorBox = $('translateError');
  const errorMsg = $('translateErrorMessage');

  if (!input || !translateBtn) return;

  const text = input.value.trim();

  // Input validation
  if (!text) {
    if (errorMsg) errorMsg.textContent = 'Please type a message to translate';
    if (errorBox) show(errorBox);
    return;
  }
  if (text.length > 2000) {
    if (errorMsg) errorMsg.textContent = 'Message is too long (max 2000 characters)';
    if (errorBox) show(errorBox);
    return;
  }

  const sourceLang = langSelect?.value || 'es';

  // Reset UI state
  if (errorBox) hide(errorBox);
  if (resultBox) hide(resultBox);
  if (loading) show(loading);
  translateBtn.disabled = true;

  try {
    const response = await API.translateText({ text, sourceLang });

    if (response?.success && response.translation) {
      if (output) output.textContent = response.translation;
      if (resultBox) show(resultBox);
      updateCreditsFromResponse(response, true);
    } else {
      throw new Error(response?.error || 'Translation failed');
    }
  } catch (error) {
    if (errorMsg) errorMsg.textContent = error.message || 'Translation failed. Please try again.';
    if (errorBox) show(errorBox);
  } finally {
    if (loading) hide(loading);
    translateBtn.disabled = false;
  }
};

// Copy translated text to clipboard
const copyTranslation = async () => {
  const output = $('translateOutput');
  const text = output?.textContent?.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showNotification('Copied to clipboard');
  } catch (error) {
    showError('Failed to copy');
  }
};

// Reset the translate box back to a clean state, ready for the next entry
const resetTranslateBox = () => {
  const input = $('translateInput');
  const output = $('translateOutput');
  const resultBox = $('translateResult');
  const errorBox = $('translateError');

  if (input) {
    input.value = '';
    input.style.height = 'auto';
  }
  if (output) output.textContent = '';
  if (resultBox) hide(resultBox);
  if (errorBox) hide(errorBox);
};

// Push translated text into the response box and send it to chat
const sendTranslation = async () => {
  const output = $('translateOutput');
  const responseText = $('responseText');
  const generatedResponse = $('generatedResponse');
  const text = output?.textContent?.trim();
  if (!text || !responseText) return;

  responseText.textContent = text;
  if (generatedResponse) show(generatedResponse);
  await sendToChat();

  // Clear the translate frame so the UI is ready for the next translation
  resetTranslateBox();
};


export const setupAIListeners = () => {
  $('regenerateBtn')?.addEventListener('click', generateResponse);

  $('copyBtn')?.addEventListener('click', copyResponse);
  $('sendBtn')?.addEventListener('click', sendToChat);
  $('testMediaBtn')?.addEventListener('click', testSendMedia);

  // Translate box listeners
  $('translateBtn')?.addEventListener('click', translateMessage);
  // Auto-grow translate textarea responsively as content changes
  const translateInputEl = $('translateInput');
  if (translateInputEl) {
    const autoGrow = () => {
      translateInputEl.style.height = 'auto';
      translateInputEl.style.height = `${Math.min(translateInputEl.scrollHeight, 160)}px`;
    };
    translateInputEl.addEventListener('input', autoGrow);
    autoGrow();
  }

  $('translateCopyBtn')?.addEventListener('click', copyTranslation);
  $('translateSendBtn')?.addEventListener('click', sendTranslation);
  
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
    await updateSummary();
    
    const currentAction = await getCurrentAction();
    console.log('[AI generateResponseText] currentAction:', currentAction);
    
    const notesContext = getNotesContext();
    const completedContext = getCompletedActionsContext();
    
    const tone = currentAction?.tone || Store.get('tone');
    
    const currentScript = Store.get('currentScript');
    const timingInfo = currentScript?.timingSettings?.minMinutes 
      ? `${currentScript.timingSettings.minMinutes} minutes` 
      : null;
    
    console.log('[AI generateResponseText] actionGoal:', currentAction?.goal);
    console.log('[AI generateResponseText] scriptName:', currentAction?.scriptName);
    
    const profileInfo = getProfileContext();
    
    const goalToUse = overrideGoal || currentAction?.goal || null;
    
    if (overrideGoal) {
      console.log('[AI generateResponseText] Using overrideGoal:', overrideGoal);
    }
    
    // Read AI mode for autochat too
    const aiModeData = await chrome.storage.local.get('aiMode');
    const aiMode = aiModeData.aiMode || 'standard';

    const response = await API.generateResponse({
      summary: Store.get('summary'),
      recentMessages: messages.slice(-15),
      currentStage: Store.get('currentStage'),
      tone: tone,
      persona: Store.get('persona'),
      profile: profileInfo,
      subscriberName: Store.get('subscriberName'),
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
      replyDelay: timingInfo,
      aiMode: aiMode
    });
    
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
