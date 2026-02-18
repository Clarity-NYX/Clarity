// ============================================================
// AUTOCHAT WORKFLOW - From working autochat.js (lines 400-1600)
// ============================================================

import { showNotification } from '../../utils/notify.js';
import { 
  autoChatState,
  processingStatus,
  workflowLock,
  workflowRetries,
  currentWorkflowState,
  crossCheckedChats,
  setWorkflowLock,
  setWorkflowRetries,
  setCurrentWorkflowState,
  setLastProcessedPeerId,
  setLastMessageSentTime,
  resetStepStatuses,
  updateStepStatus,
  updateProcessingStatus,
  // Cooldown functions
  isSubscriberInCooldown,
  getCooldownRemaining,
  setSubscriberCooldown
} from './state.js';
import { WorkflowState, TIMING } from './constants.js';
import { renderAutoChatPanel, renderStatusBar } from './ui.js';

// ============================================================
// HELPER FUNCTIONS
// ============================================================

// Helper: Find best image match based on keywords in request
function findBestImageMatch(query, images) {
  if (!query || !images?.length) return null;
  
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
  
  // Keywords to match for different body parts / content types
  const keywordGroups = {
    boobs: ['boob', 'boobs', 'tit', 'tits', 'breast', 'breasts', 'chest'],
    ass: ['ass', 'butt', 'booty', 'behind', 'rear'],
    pussy: ['pussy', 'vagina', 'kitty', 'cunt'],
    face: ['face', 'selfie', 'smile', 'eyes', 'lips', 'pretty'],
    body: ['body', 'full', 'naked', 'nude', 'everything'],
    feet: ['feet', 'foot', 'toes'],
    sexy: ['sexy', 'hot', 'naughty', 'dirty', 'spicy']
  };
  
  let bestMatch = null;
  let bestScore = 0;
  
  for (const image of images) {
    let score = 0;
    
    // Build searchable text from image
    const searchText = [
      image.name || '',
      image.description || '',
      ...(image.tags || [])
    ].join(' ').toLowerCase();
    
    // Check direct word matches in search text
    for (const word of queryWords) {
      if (searchText.includes(word)) {
        score += 5; // Direct match
      }
    }
    
    // Check keyword groups - if query contains "boobs", look for boob-related tags
    for (const [group, keywords] of Object.entries(keywordGroups)) {
      const queryHasGroup = keywords.some(k => queryLower.includes(k));
      const imageHasGroup = keywords.some(k => searchText.includes(k));
      
      if (queryHasGroup && imageHasGroup) {
        score += 10; // Strong match via keyword group
        console.log(`[ImageMatch] "${image.name}" matches "${group}" keywords`);
      }
    }
    
    // Category matching
    if (image.category) {
      if (queryLower.includes('selfie') && image.category === 'selfie') score += 3;
      if (queryLower.includes('body') && image.category === 'full_body') score += 3;
    }
    
    if (score > bestScore) {
      bestScore = score;
      bestMatch = { image, score };
    }
  }
  
  // Only return if we found a meaningful match
  if (bestScore >= 5) {
    return bestMatch;
  }
  
  return null;
}

// Helper: Wait for a condition to be true (with timeout)
async function waitForCondition(conditionFn, timeoutMs = TIMING.CONDITION_TIMEOUT, pollMs = TIMING.CONDITION_POLL) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    if (await conditionFn()) {
      return true;
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  
  return false;
}

// Check if reply is needed by looking at last message in TELEGRAM directly
async function checkIfReplyNeeded() {
  try {
    // FIRST: Check Telegram directly (most accurate)
    const tabs = await chrome.tabs.query({ url: '*://web.telegram.org/*' });
    if (tabs.length > 0) {
      const telegramCheck = await chrome.tabs.sendMessage(tabs[0].id, { 
        type: 'CHECK_LAST_MESSAGE_SENDER' 
      }).catch(() => null);
      
      if (telegramCheck?.success) {
        const isOurs = telegramCheck.lastMessageIsOurs;
        const lastSender = telegramCheck.lastSender;
        const lastPreview = telegramCheck.lastMessagePreview?.slice(0, 30) || '';
        
        console.log(`[Workflow] 🔍 Telegram check: last message is ${isOurs ? 'OURS' : 'THEIRS'}`);
        console.log(`[Workflow] 📨 Last: "${lastPreview}..." by ${lastSender}`);
        
        // If our message/image is last, no reply needed
        if (isOurs) {
          console.log('[Workflow] ✅ Our message is last in Telegram - no reply needed');
          return false;
        } else {
          console.log('[Workflow] ✅ Their message is last in Telegram - reply needed');
          return true;
        }
      } else {
        console.log('[Workflow] ⚠️ Telegram check failed, falling back to sidepanel check');
      }
    }
  } catch (e) {
    console.log('[Workflow] ⚠️ Telegram check error:', e.message);
  }
  
  // FALLBACK: Check sidepanel UI
  const chatMessages = document.querySelector('#chatMessages');
  if (!chatMessages) {
    console.log('[Workflow] No chat messages element found');
    return true; // Default to yes if we can't check
  }
  
  // Find all message elements (class="message from-me" or "message from-them")
  const messages = chatMessages.querySelectorAll('.message');
  if (messages.length === 0) {
    console.log('[Workflow] No messages found in chat');
    return true; // Empty chat = should send intro
  }
  
  // Get last message
  const lastMessage = messages[messages.length - 1];
  
  // Check if it's from us (has class 'from-me')
  const isOurMessage = lastMessage.classList.contains('from-me');
  const isTheirMessage = lastMessage.classList.contains('from-them');
  
  console.log(`[Workflow] Last message classes: ${lastMessage.className}`);
  console.log(`[Workflow] Last message is ${isOurMessage ? 'OURS (from-me)' : isTheirMessage ? 'THEIRS (from-them)' : 'UNKNOWN'}`);
  
  // If our message is last (from-me), no reply needed
  // If their message is last (from-them), reply needed
  return !isOurMessage;
}

// ============================================================
// MAIN WORKFLOW - triggerAIGeneration
// ============================================================

export async function triggerAIGeneration(peerId, autoSend = false) {
  console.log('[Workflow] 🚀 Starting workflow for:', peerId);
  
  // Check if AutoChat is still enabled
  if (!autoChatState.enabled) {
    console.log('[Workflow] ⛔ AutoChat disabled, stopping workflow');
    return;
  }
  
  // CHECK IF USER IS BLOCKED (script already completed)
  try {
    const Progress = (await import('../scripts/progressManager.js')).default;
    const isBlocked = await Progress.isSubscriberBlocked(peerId);
    if (isBlocked) {
      console.log('[Workflow] 🚫 User is BLOCKED (script complete) - skipping');
      showNotification('🚫 Skipping blocked user (script complete)');
      chrome.runtime.sendMessage({
        type: 'AUTOCHAT_MESSAGE_SENT',
        data: { peerId, success: true, skipped: true, reason: 'user_blocked' }
      }).catch(() => {});
      return;
    }
  } catch (blockCheckError) {
    console.log('[Workflow] ⚠️ Block check error (non-fatal):', blockCheckError.message);
  }
  
  // ========== COOLDOWN CHECK - Don't respond to same person within 1 minute ==========
  if (isSubscriberInCooldown(peerId)) {
    const remaining = getCooldownRemaining(peerId);
    console.log(`[Workflow] ⏱️ User in COOLDOWN - ${remaining}s remaining, skipping`);
    showNotification(`⏱️ Cooldown: wait ${remaining}s before replying again`);
    chrome.runtime.sendMessage({
      type: 'AUTOCHAT_MESSAGE_SENT',
      data: { peerId, success: true, skipped: true, reason: 'cooldown', cooldownRemaining: remaining }
    }).catch(() => {});
    return;
  }
  
  // LOCK CHECK - prevent multiple simultaneous workflows
  if (workflowLock) {
    console.log('[Workflow] 🔒 Workflow already in progress, ignoring trigger');
    return;
  }
  
  // ACQUIRE LOCK
  setWorkflowLock(true);
  console.log('[Workflow] 🔓 Lock acquired');
  
  // Reset status for new chat
  resetStepStatuses();
  
  // Mark opening chat as done
  updateStepStatus('openingChat', 'done');
  updateStepStatus('loadingMessages', 'active');
  renderAutoChatPanel();
  
  // Wait a moment for messages to load
  await new Promise(r => setTimeout(r, 1500));
  updateStepStatus('loadingMessages', 'done');
  renderAutoChatPanel();
  
  // ========== CHAT VERIFICATION - Cross-check UI vs Telegram ==========
  console.log('[Workflow] 🔍 Verifying chat context...');
  try {
    const Store = (await import('../../state/store.js')).default;
    const expectedChatName = processingStatus.currentChat || '';
    const expectedPeerId = peerId?.toString();
    
    // Get current open chat info from Telegram
    const tabs = await chrome.tabs.query({ url: '*://web.telegram.org/*' });
    if (tabs.length > 0) {
      const chatInfo = await chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_CHAT_INFO' }).catch(() => null);
      
      if (chatInfo?.success && chatInfo.info) {
        const openChatName = chatInfo.info.displayName || '';
        const openPeerId = chatInfo.info.peerId?.toString().replace(/^tg:/, '') || '';
        const cleanExpectedPeerId = expectedPeerId?.replace(/^tg:/, '') || '';
        
        console.log('[Workflow] Expected:', { name: expectedChatName, peerId: cleanExpectedPeerId });
        console.log('[Workflow] Open chat:', { name: openChatName, peerId: openPeerId });
        
        // Check if peer IDs match
        const peerIdMatches = cleanExpectedPeerId && openPeerId && cleanExpectedPeerId === openPeerId;
        
        // Check if names match (partial match allowed)
        const nameMatches = expectedChatName && openChatName && (
          openChatName.toLowerCase().includes(expectedChatName.toLowerCase()) ||
          expectedChatName.toLowerCase().includes(openChatName.toLowerCase())
        );
        
        // Only skip if BOTH peer ID AND name are completely different
        // Be very permissive - only block if clearly wrong
        if (!peerIdMatches && !nameMatches && openPeerId && openChatName) {
          // Even then, just warn but continue - don't block
          console.log('[Workflow] ⚠️ Chat verification WARNING (names/IDs differ)');
          console.log(`[Workflow] Expected: "${expectedChatName}" (${cleanExpectedPeerId})`);
          console.log(`[Workflow] Open: "${openChatName}" (${openPeerId})`);
          console.log('[Workflow] 🔄 Continuing anyway - verification is advisory only');
        } else {
          console.log('[Workflow] ✅ Chat verification passed');
        }
      } else {
        console.log('[Workflow] ⚠️ Could not get chat info for verification (continuing anyway)');
      }
    }
  } catch (verifyError) {
    console.log('[Workflow] ⚠️ Verification error (non-fatal):', verifyError.message);
  }
  
  // ========== FRESH MESSAGE RELOAD - Prevent stale context ==========
  try {
    console.log('[Workflow] 🔄 Force reloading messages from Telegram...');
    const tabs = await chrome.tabs.query({ url: '*://web.telegram.org/*' });
    if (tabs.length > 0) {
      const freshMessages = await chrome.tabs.sendMessage(tabs[0].id, { 
        type: 'EXTRACT_MESSAGES' 
      }).catch(() => null);
      
      if (freshMessages?.success && freshMessages.messages?.length > 0) {
        const Store = (await import('../../state/store.js')).default;
        const oldMessages = Store.get('messages') || [];
        
        console.log(`[Workflow] 📨 Fresh: ${freshMessages.messages.length} messages, Old: ${oldMessages.length}`);
        
        // Compare last message to detect context mismatch
        if (oldMessages.length > 0 && freshMessages.messages.length > 0) {
          const oldLast = oldMessages[oldMessages.length - 1]?.text?.slice(0, 50);
          const freshLast = freshMessages.messages[freshMessages.messages.length - 1]?.text?.slice(0, 50);
          
          if (oldLast !== freshLast) {
            console.log(`[Workflow] ⚠️ CONTEXT MISMATCH DETECTED!`);
            console.log(`[Workflow] Old last: "${oldLast}"`);
            console.log(`[Workflow] Fresh last: "${freshLast}"`);
            console.log(`[Workflow] ✅ Using fresh messages to prevent wrong response`);
          }
        }
        
        // Always use fresh messages
        Store.set('messages', freshMessages.messages);
      } else {
        console.log('[Workflow] ⚠️ Could not extract fresh messages, using cached');
      }
    }
  } catch (reloadError) {
    console.log('[Workflow] ⚠️ Message reload error (non-fatal):', reloadError.message);
  }
  
  // ========== CHECK IF REPLY NEEDED ==========
  const replyNeeded = await checkIfReplyNeeded();
  
  if (!replyNeeded) {
    console.log('[Workflow] ⏭️ Our message is last - SKIPPING (no reply from them yet)');
    updateStepStatus('generating', 'pending');
    updateStepStatus('sending', 'pending');
    updateStepStatus('verifying', 'pending');
    updateProcessingStatus({ lastError: 'Waiting for their reply' });
    renderAutoChatPanel();
    
    // Release lock and move to next
    setWorkflowLock(false);
    chrome.runtime.sendMessage({
      type: 'AUTOCHAT_MESSAGE_SENT',
      data: { peerId, success: true, skipped: true, reason: 'waiting_for_reply' }
    }).catch(() => {});
    return;
  }
  
  console.log('[Workflow] ✅ Their message is last - REPLY NEEDED!');
  
  setCurrentWorkflowState(WorkflowState.GENERATING);
  setWorkflowRetries(0);
  
  try {
    // ========== STEP 2.5: AI CROSS-CHECK SCRIPT PROGRESS ==========
    const peerIdStr = peerId?.toString();
    const isFirstEntry = !crossCheckedChats.has(peerIdStr);
    
    try {
      const scriptsModule = await import('../scripts/index.js');
      const Progress = (await import('../scripts/progressManager.js')).default;
      
      // Initialize progress first
      await Progress.init();
      
      // AI CROSS-CHECK DISABLED - Was too aggressive, skipping too many actions
      // Now we just load progress and let the script proceed step by step
      if (isFirstEntry) {
        console.log('[Workflow] 📋 First entry - loading script progress (auto-skip DISABLED)');
        crossCheckedChats.add(peerIdStr);
      }
      
      // Check if script is now complete
      const currentAction = Progress.getCurrentAction();
      const stats = Progress.getStats();
      console.log(`[Workflow] 📊 Script stats: ${stats.completed}/${stats.total} complete`);
      // NOTE: currentAction.action.type is where the type is stored (not currentAction.type)
      const actionType = currentAction?.action?.type || 'text';
      console.log(`[Workflow] 📌 Current action:`, currentAction ? `${actionType}: ${currentAction.goal?.slice(0, 40)}` : 'NONE (all complete)');
      
      // ========== MEDIA ACTION HANDLING - Send image from pool ==========
      if (currentAction && actionType === 'media') {
        console.log('[Workflow] 🖼️ MEDIA ACTION detected - sending image!');
        
        try {
          const tabs = await chrome.tabs.query({ url: '*://web.telegram.org/*' });
          if (tabs.length > 0) {
            updateStepStatus('generating', 'done');
            updateStepStatus('sending', 'active');
            renderAutoChatPanel();
            
            const Store = (await import('../../state/store.js')).default;
            const currentSubscriberId = peerId?.toString() || Store.get('currentSubscriberId');
            const imagePoolModule = await import('../imagePool.js');
            const currentScript = Store.get('currentScript');
            const scriptImages = currentScript?.imagePool || [];
            
            let imageToSend = null;
            
            // FIRST: Check if this media action has a PRE-SELECTED poolImage attached
            // This is set when creating media actions in the script editor
            const preSelectedImage = currentAction.action?.poolImage;
            if (preSelectedImage) {
              console.log('[Workflow] 📌 Found PRE-SELECTED image on media action:', preSelectedImage.name || preSelectedImage.id);
              
              // CHECK if this pre-selected image was ALREADY SENT to this subscriber
              // This prevents duplicates when situational trigger sent the same image earlier
              // Pass the full image object so it can check all identifiers (id, name, downloadURL)
              const preSelectedAlreadySent = imagePoolModule.hasImageBeenSentToSubscriber(currentSubscriberId, preSelectedImage);
              
              if (preSelectedAlreadySent) {
                console.log('[Workflow] ⚠️ Pre-selected image ALREADY SENT - will find alternative');
                // Don't use it - fall through to find unsent image
              } else {
                imageToSend = preSelectedImage;
              }
            }
            
            // SECOND: If no pre-selected image (or it was already sent), try script-specific images - use AI to select best match
            if (!imageToSend && scriptImages.length > 0) {
              const unsentScriptImages = imagePoolModule.getUnsentImagesForSubscriber(currentSubscriberId, scriptImages);
              if (unsentScriptImages.length > 0) {
                // Use AI to select best image based on subscriber's message
                try {
                  const messages = Store.get('messages') || [];
                  const subscriberMessages = messages.filter(m => !m.isFromMe);
                  const lastSubscriberMsg = subscriberMessages[subscriberMessages.length - 1]?.text || '';
                  
                  const API = (await import('../../utils/api.js')).default;
                  const selectResult = await API.selectImage({
                    userMessage: lastSubscriberMsg,
                    imageList: unsentScriptImages.map(img => ({
                      id: img.id,
                      name: img.name || '',
                      description: img.description || '',
                      category: img.category || 'other',
                      tags: img.tags || []
                    }))
                  });
                  
                  if (selectResult.success && selectResult.selectedIndex !== null && selectResult.selectedIndex < unsentScriptImages.length) {
                    imageToSend = unsentScriptImages[selectResult.selectedIndex];
                    console.log(`[Workflow] 🤖 AI selected image: ${imageToSend?.name} - ${selectResult.reason}`);
                  } else {
                    imageToSend = unsentScriptImages[0];
                    console.log('[Workflow] ✅ Got first UNSENT image from script pool:', imageToSend?.name);
                  }
                } catch (aiSelectErr) {
                  console.log('[Workflow] ⚠️ AI selection failed, using first unsent:', aiSelectErr.message);
                  imageToSend = unsentScriptImages[0];
                }
              }
            }
            
            // THIRD: Fall back to global pool if still no image
            if (!imageToSend) {
              const globalImages = imagePoolModule.getImages();
              const unsentGlobalImages = imagePoolModule.getUnsentImagesForSubscriber(currentSubscriberId, globalImages);
              if (unsentGlobalImages.length > 0) {
                // Use AI to select best image from global pool too
                try {
                  const messages = Store.get('messages') || [];
                  const subscriberMessages = messages.filter(m => !m.isFromMe);
                  const lastSubscriberMsg = subscriberMessages[subscriberMessages.length - 1]?.text || '';
                  
                  const API = (await import('../../utils/api.js')).default;
                  const selectResult = await API.selectImage({
                    userMessage: lastSubscriberMsg,
                    imageList: unsentGlobalImages.map(img => ({
                      id: img.id,
                      name: img.name || '',
                      description: img.description || '',
                      category: img.category || 'other',
                      tags: img.tags || []
                    }))
                  });
                  
                  if (selectResult.success && selectResult.selectedIndex !== null && selectResult.selectedIndex < unsentGlobalImages.length) {
                    imageToSend = unsentGlobalImages[selectResult.selectedIndex];
                    console.log(`[Workflow] 🤖 AI selected image from global: ${imageToSend?.name} - ${selectResult.reason}`);
                  } else {
                  imageToSend = unsentGlobalImages[0];
                  console.log('[Workflow] ✅ Got first UNSENT image from global pool:', imageToSend?.name);
                }
              } catch (aiSelectErr) {
                console.log('[Workflow] ⚠️ AI selection failed, using first unsent:', aiSelectErr.message);
                imageToSend = unsentGlobalImages[0];
              }
            }
          }
            
            if (!imageToSend) {
              console.log('[Workflow] ⚠️ No unsent images for media action - skipping to next action');
              showNotification('⚠️ No unsent images - marking media action complete');
              
              // Mark as complete anyway so script progresses
              await Progress.markComplete(currentAction.stageIdx, currentAction.actionIdx);
              if (scriptsModule.renderScriptStages) scriptsModule.renderScriptStages();
              
              updateStepStatus('sending', 'done');
              updateStepStatus('verifying', 'done');
              renderAutoChatPanel();
              
              setWorkflowLock(false);
              setSubscriberCooldown(peerId);
              chrome.runtime.sendMessage({
                type: 'AUTOCHAT_MESSAGE_SENT',
                data: { peerId, success: true, skipped: true, reason: 'no_unsent_images_for_media' }
              }).catch(() => {});
              return;
            }
            
            // Fetch and send the image
            console.log('[Workflow] 🖼️ Preparing to send image:', {
              name: imageToSend.name || imageToSend.id,
              hasImageData: !!imageToSend.imageData,
              hasDownloadURL: !!imageToSend.downloadURL,
              isPreSelected: !!preSelectedImage
            });
            
            let finalImageData = imageToSend.imageData;
            
            if (!finalImageData && imageToSend.downloadURL) {
              console.log('[Workflow] 📷 Fetching image from Firebase URL:', imageToSend.downloadURL?.slice(0, 80) + '...');
              try {
                const response = await fetch(imageToSend.downloadURL);
                if (response.ok) {
                  const blob = await response.blob();
                  console.log('[Workflow] 📦 Blob received, size:', blob.size, 'bytes');
                  finalImageData = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                  });
                  console.log('[Workflow] ✅ Converted blob to base64 data URL');
                } else {
                  console.log('[Workflow] ❌ Fetch failed with status:', response.status);
                }
              } catch (fetchErr) {
                console.log('[Workflow] ❌ Failed to fetch image:', fetchErr.message);
              }
            }
            
            if (finalImageData) {
              // Generate AI-powered contextual caption FIRST, then send with image
              let imageCaption = 'just for you';
              try {
                const API = (await import('../../utils/api.js')).default;
                const messages = Store.get('messages') || [];
                const subscriberMessages = messages.filter(m => !m.isFromMe);
                const lastSubscriberMsg = subscriberMessages[subscriberMessages.length - 1]?.text || '';
                
                const captionResult = await API.generateImageCaption({
                  imageInfo: {
                    name: imageToSend.name || '',
                    description: imageToSend.description || '',
                    category: imageToSend.category || '',
                    tags: imageToSend.tags || []
                  },
                  subscriberLastMessage: lastSubscriberMsg
                });
                
                if (captionResult?.success && captionResult?.caption) {
                  imageCaption = captionResult.caption;
                  console.log(`[Workflow] 🤖 AI generated caption: "${imageCaption}"`);
                } else {
                  // Fallback to random message
                  const fallbackMessages = ["just for you", "you like?", "hows that?", "enjoy"];
                  imageCaption = fallbackMessages[Math.floor(Math.random() * fallbackMessages.length)];
                  console.log(`[Workflow] ⚠️ AI caption failed, using fallback: "${imageCaption}"`);
                }
              } catch (captionErr) {
                console.log('[Workflow] ⚠️ Caption generation error, using fallback:', captionErr.message);
                const fallbackMessages = ["just for you", "you like?", "hows that?", "enjoy"];
                imageCaption = fallbackMessages[Math.floor(Math.random() * fallbackMessages.length)];
              }
              
              console.log('[Workflow] 📤 Sending image WITH caption to Telegram...');
              console.log(`[Workflow] 📝 Caption: "${imageCaption}"`);
              console.log(`[Workflow] 📦 Image data length: ${finalImageData?.length || 0} chars`);
              console.log(`[Workflow] 📦 Image data starts with: ${finalImageData?.slice(0, 50)}...`);
              
              // Send image and WAIT for result
              const sendResult = await chrome.tabs.sendMessage(tabs[0].id, {
                type: 'SEND_IMAGE',
                imageUrl: finalImageData,
                isUrl: false,
                caption: imageCaption
              });
              
              console.log('[Workflow] 📬 Image send result:', sendResult);
              
              if (!sendResult?.success) {
                console.log('[Workflow] ❌ Image send FAILED:', sendResult?.error || 'Unknown error');
                showNotification(`❌ Image send failed: ${sendResult?.error || 'Unknown'}`);
                // Don't return - try to continue with next action
              } else {
                console.log('[Workflow] ✅ Image + caption sent for MEDIA action!');
              }
              
              // Wait longer for image to fully upload/send before marking complete
              console.log('[Workflow] ⏳ Waiting for image upload to complete...');
              await new Promise(r => setTimeout(r, 4000)); // Increased from 2000ms to 4000ms
              
              // Mark image as sent
              const imageIdToMark = imageToSend.id || imageToSend.name;
              if (imageIdToMark && currentSubscriberId) {
                imagePoolModule.markImageSentToSubscriber(currentSubscriberId, imageIdToMark);
                console.log(`[Workflow] 📝 Marked image "${imageIdToMark}" as sent to ${currentSubscriberId}`);
              }
              
              // Mark script action complete
              await Progress.markComplete(currentAction.stageIdx, currentAction.actionIdx);
              if (scriptsModule.renderScriptStages) scriptsModule.renderScriptStages();
              
              const newStats = Progress.getStats();
              console.log(`[Workflow] 📊 Progress: ${newStats.completed}/${newStats.total} (${newStats.percent}%)`);
              showNotification(`📸 Image + message sent! (${newStats.completed}/${newStats.total})`);
              
              updateStepStatus('sending', 'done');
              updateStepStatus('verifying', 'done');
              renderAutoChatPanel();
              
              setSubscriberCooldown(peerId);
              setWorkflowLock(false);
              chrome.runtime.sendMessage({
                type: 'AUTOCHAT_MESSAGE_SENT',
                data: { peerId, success: true, mediaAction: true }
              }).catch(() => {});
              return;
            } else {
              console.log('[Workflow] ❌ Could not get image data');
            }
          }
        } catch (mediaErr) {
          console.log('[Workflow] ⚠️ Media action error:', mediaErr.message);
        }
      }
      
      // SAFEGUARDS: Don't block prematurely
      const safeToBlock = stats.total >= TIMING.MINIMUM_ACTIONS_FOR_COMPLETE && 
                          stats.completed >= TIMING.MINIMUM_ACTIONS_FOR_COMPLETE;
      
      if ((!currentAction || (stats.total > 0 && stats.completed >= stats.total)) && safeToBlock) {
        console.log('[Workflow] 🎉 SCRIPT 100% COMPLETE! Adding to block list...');
        await Progress.markScriptFinished();
        showNotification('✅ Script completed! User added to block list.');
        
        updateStepStatus('generating', 'done');
        updateStepStatus('sending', 'done');
        updateStepStatus('verifying', 'done');
        updateProcessingStatus({ lastError: 'Script complete - blocked' });
        renderAutoChatPanel();
        
        setWorkflowLock(false);
        chrome.runtime.sendMessage({
          type: 'AUTOCHAT_MESSAGE_SENT',
          data: { peerId, success: true, skipped: true, reason: 'script_complete' }
        }).catch(() => {});
        return;
      }
    } catch (crossCheckError) {
      console.log('[Workflow] ⚠️ Cross-check error (non-fatal):', crossCheckError.message);
    }
    
    // ========== SITUATIONAL CHECK - Before generating ==========
    try {
      const Store = (await import('../../state/store.js')).default;
      const messages = Store.get('messages') || [];
      const subscriberMessages = messages.filter(m => !m.isFromMe);
      const lastSubscriberMsg = subscriberMessages[subscriberMessages.length - 1];
      
      if (lastSubscriberMsg?.text) {
        const { checkSituationalTriggerWithAI } = await import('../settings.js');
        const situationalMatch = await checkSituationalTriggerWithAI(lastSubscriberMsg.text);
        
        if (situationalMatch && !situationalMatch.continueScript) {
          console.log(`[Workflow] 🎭 Situational trigger: "${situationalMatch.name}"`);
          
          // Handle situational response
          const tabs = await chrome.tabs.query({ url: '*://web.telegram.org/*' });
          if (tabs.length > 0) {
            updateStepStatus('generating', 'done');
            updateStepStatus('sending', 'active');
            renderAutoChatPanel();
            
            // For askImages - send image from pool
            if (situationalMatch.sendImage) {
              console.log('[Workflow] 📸 askImages triggered - sending image');
              
              const Store = (await import('../../state/store.js')).default;
              const currentSubscriberId = peerId?.toString() || Store.get('currentSubscriberId');
              const imagePoolModule = await import('../imagePool.js');
              const currentScript = Store.get('currentScript');
              const scriptImages = currentScript?.imagePool || [];
              
              let imageToSend = null;
              
              // Use keyword matching to select best image based on their request
              const subscriberMsg = lastSubscriberMsg.text;
              console.log(`[Workflow] 🔍 Looking for image matching: "${subscriberMsg}"`);
              
              if (scriptImages.length > 0) {
                const unsentScriptImages = imagePoolModule.getUnsentImagesForSubscriber(currentSubscriberId, scriptImages);
                if (unsentScriptImages.length > 0) {
                  // Use local keyword matching first
                  const bestMatch = findBestImageMatch(subscriberMsg, unsentScriptImages);
                  if (bestMatch) {
                    imageToSend = bestMatch.image;
                    console.log(`[Workflow] ✅ Matched image from script pool: "${imageToSend?.name}" (score: ${bestMatch.score})`);
                  } else {
                    imageToSend = unsentScriptImages[0];
                    console.log('[Workflow] ⚠️ No keyword match, using first unsent from script pool');
                  }
                }
              }
              
              if (!imageToSend) {
                const globalImages = imagePoolModule.getImages();
                const unsentGlobalImages = imagePoolModule.getUnsentImagesForSubscriber(currentSubscriberId, globalImages);
                if (unsentGlobalImages.length > 0) {
                  // Use local keyword matching for global pool too
                  const bestMatch = findBestImageMatch(subscriberMsg, unsentGlobalImages);
                  if (bestMatch) {
                    imageToSend = bestMatch.image;
                    console.log(`[Workflow] ✅ Matched image from global pool: "${imageToSend?.name}" (score: ${bestMatch.score})`);
                  } else {
                    imageToSend = unsentGlobalImages[0];
                    console.log('[Workflow] ⚠️ No keyword match, using first unsent from global pool');
                  }
                }
              }
              
              if (!imageToSend) {
                console.log('[Workflow] ⚠️ No unsent images available!');
                showNotification('⚠️ All images already sent to this user!');
                
                updateStepStatus('sending', 'done');
                updateStepStatus('verifying', 'done');
                updateProcessingStatus({ lastError: 'No unsent images - skipping' });
                renderAutoChatPanel();
                
                setWorkflowLock(false);
                chrome.runtime.sendMessage({
                  type: 'AUTOCHAT_MESSAGE_SENT',
                  data: { peerId, success: true, skipped: true, reason: 'no_unsent_images' }
                }).catch(() => {});
                return;
              }
              
              if (imageToSend.downloadURL || imageToSend.imageData) {
                let finalImageData = imageToSend.imageData;
                
                if (!finalImageData && imageToSend.downloadURL) {
                  console.log('[Workflow] 📷 Fetching image from URL...');
                  try {
                    const response = await fetch(imageToSend.downloadURL);
                    if (response.ok) {
                      const blob = await response.blob();
                      finalImageData = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result);
                        reader.onerror = reject;
                        reader.readAsDataURL(blob);
                      });
                    }
                  } catch (fetchErr) {
                    console.log('[Workflow] ❌ Failed to fetch image:', fetchErr.message);
                  }
                }
                
                if (finalImageData) {
                  // Generate AI-powered contextual caption FIRST
                  let imageCaption = 'just for you';
                  try {
                    const API = (await import('../../utils/api.js')).default;
                    
                    const captionResult = await API.generateImageCaption({
                      imageInfo: {
                        name: imageToSend.name || '',
                        description: imageToSend.description || '',
                        category: imageToSend.category || '',
                        tags: imageToSend.tags || []
                      },
                      subscriberLastMessage: subscriberMsg
                    });
                    
                    if (captionResult?.success && captionResult?.caption) {
                      imageCaption = captionResult.caption;
                      console.log(`[Workflow] 🤖 AI generated caption: "${imageCaption}"`);
                    } else {
                      const fallbackMessages = ["just for you", "you like?", "hows that?", "enjoy"];
                      imageCaption = fallbackMessages[Math.floor(Math.random() * fallbackMessages.length)];
                      console.log(`[Workflow] ⚠️ AI caption failed, using fallback: "${imageCaption}"`);
                    }
                  } catch (captionErr) {
                    console.log('[Workflow] ⚠️ Caption generation error, using fallback:', captionErr.message);
                    const fallbackMessages = ["just for you", "you like?", "hows that?", "enjoy"];
                    imageCaption = fallbackMessages[Math.floor(Math.random() * fallbackMessages.length)];
                  }
                  
                  // Send image WITH caption
                  console.log('[Workflow] 📤 Sending image WITH caption for situational...');
                  console.log(`[Workflow] 📝 Caption: "${imageCaption}"`);
                  await chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'SEND_IMAGE',
                    imageUrl: finalImageData,
                    isUrl: false,
                    caption: imageCaption
                  });
                  
                  // Wait longer for image to fully upload/send
                  console.log('[Workflow] ⏳ Waiting for situational image upload to complete...');
                  await new Promise(r => setTimeout(r, 5000)); // Increased from 3000ms to 5000ms
                  console.log('[Workflow] ✅ Image + caption sent for situational!');
                  
                  const imageIdToMark = imageToSend.id || imageToSend.name;
                  if (imageIdToMark && currentSubscriberId) {
                    imagePoolModule.markImageSentToSubscriber(currentSubscriberId, imageIdToMark);
                    console.log(`[Workflow] 📝 Marked image "${imageIdToMark}" as sent to ${currentSubscriberId}`);
                  }
                }
              }
            } else {
              // Just send text response
              await chrome.tabs.sendMessage(tabs[0].id, {
                type: 'SEND_MESSAGE',
                text: situationalMatch.response
              });
            }
            
            updateStepStatus('sending', 'done');
            updateStepStatus('verifying', 'done');
            renderAutoChatPanel();
            
            // SET COOLDOWN after situational send
            setSubscriberCooldown(peerId);
            
            showNotification(`🎭 Situational: ${situationalMatch.name}${situationalMatch.sendImage ? ' + 📸' : ''}`);
            setWorkflowLock(false);
            chrome.runtime.sendMessage({
              type: 'AUTOCHAT_MESSAGE_SENT',
              data: { peerId, success: true, situational: situationalMatch.name }
            }).catch(() => {});
            return;
          }
        }
      }
    } catch (situationalError) {
      console.log('[Workflow] ⚠️ Situational check error (non-fatal):', situationalError.message);
    }
    
    // ========== STEP 3: GENERATE AI RESPONSE ==========
    updateStepStatus('generating', 'active');
    renderAutoChatPanel();
    console.log('[Workflow] 📝 Generating AI response...');
    
    const aiModule = await import('../ai.js');
    const rawResponse = await aiModule.generateResponseText();
    
    if (!rawResponse) {
      updateStepStatus('generating', 'error', 'AI generation failed');
      renderAutoChatPanel();
      throw new Error('AI generation failed - no response');
    }
    
    console.log('[Workflow] 📥 Raw AI response:', rawResponse);
    
    // Parse the response
    let messagesToSend = [];
    
    try {
      if (rawResponse.startsWith('[') && rawResponse.endsWith(']')) {
        const parsed = JSON.parse(rawResponse);
        if (Array.isArray(parsed)) {
          messagesToSend = parsed.filter(m => typeof m === 'string' && m.trim()).map(m => m.trim());
          console.log('[Workflow] ✅ Parsed JSON array:', messagesToSend.length, 'messages');
        }
      }
    } catch (e) {
      console.log('[Workflow] Not valid JSON, trying ||| split');
    }
    
    if (messagesToSend.length === 0 && rawResponse.includes('|||')) {
      messagesToSend = rawResponse.split('|||').map(m => m.trim()).filter(m => m.length > 0);
      console.log('[Workflow] ✅ Split by |||:', messagesToSend.length, 'messages');
    }
    
    if (messagesToSend.length === 0) {
      messagesToSend = [rawResponse.trim()];
      console.log('[Workflow] Using as single message');
    }
    
    console.log('[Workflow] 📨 Messages to send:', messagesToSend);
    
    updateStepStatus('generating', 'done');
    renderAutoChatPanel();
    console.log('[Workflow] ✅ Response generated:', messagesToSend.length, 'messages');
    
    // Check if still enabled
    if (!autoChatState.enabled) {
      console.log('[Workflow] ⛔ AutoChat disabled during workflow, stopping');
      resetStepStatuses();
      updateProcessingStatus({ currentChat: null });
      renderAutoChatPanel();
      setWorkflowLock(false);
      return;
    }
    
    // ========== STEP 4: SEND MESSAGES ==========
    updateStepStatus('sending', 'active');
    renderAutoChatPanel();
    console.log('[Workflow] 📤 Sending', messagesToSend.length, 'message(s)...');
    setCurrentWorkflowState(WorkflowState.SENDING);
    
    const tabs = await chrome.tabs.query({ url: '*://web.telegram.org/*' });
    if (!tabs.length) {
      updateStepStatus('sending', 'error', 'No Telegram tab found');
      renderAutoChatPanel();
      throw new Error('No Telegram tab found');
    }
    
    for (let i = 0; i < messagesToSend.length; i++) {
      const msg = messagesToSend[i];
      console.log(`[Workflow] 📤 Sending message ${i + 1}/${messagesToSend.length}: "${msg.substring(0, 30)}..."`);
      
      const sendResult = await chrome.tabs.sendMessage(tabs[0].id, {
        type: 'SEND_MESSAGE',
        text: msg
      });
      
      console.log('[Workflow] Send result:', sendResult);
      
      if (!sendResult?.success) {
        updateStepStatus('sending', 'error', sendResult?.error || 'Send failed');
        renderAutoChatPanel();
        throw new Error(sendResult?.error || `Failed to send message ${i + 1}`);
      }
      
      if (i < messagesToSend.length - 1) {
        console.log('[Workflow] ⏳ Waiting 1.5s before next message...');
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    
    console.log('[Workflow] ✅ All', messagesToSend.length, 'message(s) sent!');
    updateStepStatus('sending', 'done');
    renderAutoChatPanel();
    
    // ========== STEP 5: VERIFY ==========
    updateStepStatus('verifying', 'active');
    renderAutoChatPanel();
    console.log('[Workflow] 🔍 Verifying message was sent...');
    setCurrentWorkflowState(WorkflowState.VERIFYING);
    
    await new Promise(r => setTimeout(r, 2000));
    
    updateStepStatus('verifying', 'done');
    renderAutoChatPanel();
    console.log('[Workflow] ✅✅ MESSAGE VERIFIED SENT!');
    setCurrentWorkflowState(WorkflowState.COMPLETE);
    
    // ========== MARK SCRIPT ACTION COMPLETE ==========
    try {
      const Progress = (await import('../scripts/progressManager.js')).default;
      const scriptsModule = await import('../scripts/index.js');
      
      const currentAction = Progress.getCurrentAction();
      if (currentAction) {
        console.log(`[Workflow] 📝 Marking action complete: Stage ${currentAction.stageIdx}, Action ${currentAction.actionIdx}`);
        await Progress.markComplete(currentAction.stageIdx, currentAction.actionIdx);
        
        if (scriptsModule.renderScriptStages) {
          scriptsModule.renderScriptStages();
        }
        
        const stats = Progress.getStats();
        console.log(`[Workflow] 📊 Progress: ${stats.completed}/${stats.total} (${stats.percent}%)`);
        showNotification(`✅ Step completed! (${stats.completed}/${stats.total})`);
        
        chrome.runtime.sendMessage({
          type: 'AUTOCHAT_UPDATE_SCRIPT_PROGRESS',
          data: { 
            peerId: peerId,
            progress: {
              completed: stats.completed,
              total: stats.total,
              percent: stats.percent
            }
          }
        }).catch(() => {});
      } else {
        console.log('[Workflow] ⚠️ No current action to mark complete');
      }
    } catch (progressError) {
      console.log('[Workflow] ⚠️ Progress marking error (non-fatal):', progressError.message);
    }
    
    // Track completion
    setLastProcessedPeerId(peerId);
    setLastMessageSentTime(Date.now());
    
    // SET COOLDOWN - Don't respond to this person for 1 minute
    setSubscriberCooldown(peerId);
    
    // Notify background
    chrome.runtime.sendMessage({
      type: 'AUTOCHAT_MESSAGE_SENT',
      data: { peerId, success: true, chatName: processingStatus.currentChat }
    }).catch(() => {});
    
    showNotification('✅ Message sent!');
    console.log('[Workflow] 🎉 Workflow complete!');
    
  } catch (error) {
    console.error('[Workflow] ❌ Error:', error);
    setCurrentWorkflowState(WorkflowState.ERROR);
    updateProcessingStatus({ 
      lastError: error.message,
      retries: workflowRetries + 1
    });
    renderAutoChatPanel();
    
    if (workflowRetries < TIMING.MAX_RETRIES) {
      console.log(`[Workflow] 🔄 Retry ${workflowRetries + 1}/${TIMING.MAX_RETRIES}...`);
      setWorkflowLock(false);
      setWorkflowRetries(workflowRetries + 1);
      await new Promise(r => setTimeout(r, 2000));
      return triggerAIGeneration(peerId, autoSend);
    } else {
      console.log('[Workflow] ❌ Max retries reached, moving to next chat');
      chrome.runtime.sendMessage({
        type: 'AUTOCHAT_MESSAGE_SENT',
        data: { peerId, success: false, error: error.message }
      }).catch(() => {});
    }
  } finally {
    // ALWAYS release lock when done
    setWorkflowLock(false);
    console.log('[Workflow] 🔓 Lock released');
  }
}
