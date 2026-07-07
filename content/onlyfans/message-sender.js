// ============================================================
// MESSAGE SENDER - Handles message typing and sending
// ============================================================

import { TYPING_SPEED_BASE, TYPO_CONFIG, ADJACENT_KEYS } from './constants.js';

// Typing speed multiplier (1.0 = 100% normal speed)
let typingSpeedMultiplier = 1.0;

// ============================================================
// TYPING SPEED MANAGEMENT
// ============================================================

// Get adjusted typing speed values
export const getTypingSpeed = () => ({
  baseDelay: TYPING_SPEED_BASE.baseDelay / typingSpeedMultiplier,
  variation: TYPING_SPEED_BASE.variation / typingSpeedMultiplier,
  pauseAfterPunctuation: TYPING_SPEED_BASE.pauseAfterPunctuation / typingSpeedMultiplier,
  pauseAfterWord: TYPING_SPEED_BASE.pauseAfterWord / typingSpeedMultiplier
});

// Load typing speed from settings
export async function loadTypingSpeed() {
  try {
    const result = await chrome.storage.local.get(['typingSpeedPercent']);
    const speedPercent = result.typingSpeedPercent ?? 100;
    typingSpeedMultiplier = speedPercent / 100;
    console.log('[Clarity] Typing speed loaded:', speedPercent + '% (multiplier:', typingSpeedMultiplier + ')');
  } catch (e) {
    console.log('[Clarity] Could not load typing speed, using default');
  }
}

// Listen for typing speed changes
export function setupTypingSpeedListener() {
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.typingSpeedPercent) {
      const newSpeed = changes.typingSpeedPercent.newValue ?? 100;
      typingSpeedMultiplier = newSpeed / 100;
      console.log('[Clarity] Typing speed changed:', newSpeed + '%');
    }
  });
}

// ============================================================
// TYPO GENERATION
// ============================================================

// Generate a typo for a word
function generateTypo(word) {
  if (word.length < 3) return null; // Too short for typo
  
  const typoType = TYPO_CONFIG.types[Math.floor(Math.random() * TYPO_CONFIG.types.length)];
  const pos = Math.floor(Math.random() * (word.length - 1)) + 1; // Not first char
  
  let typo = word;
  
  switch (typoType) {
    case 'missing':
      // Remove a letter: "babe" -> "bab"
      typo = word.slice(0, pos) + word.slice(pos + 1);
      break;
      
    case 'double':
      // Double a letter: "hello" -> "helllo"
      typo = word.slice(0, pos) + word[pos] + word.slice(pos);
      break;
      
    case 'adjacent':
      // Replace with adjacent key: "what" -> "wjat"
      const char = word[pos].toLowerCase();
      const adjacent = ADJACENT_KEYS[char];
      if (adjacent && adjacent.length > 0) {
        const replacement = adjacent[Math.floor(Math.random() * adjacent.length)];
        typo = word.slice(0, pos) + replacement + word.slice(pos + 1);
      }
      break;
      
    case 'transposed':
      // Swap two adjacent letters: "the" -> "teh"
      if (pos < word.length - 1) {
        typo = word.slice(0, pos) + word[pos + 1] + word[pos] + word.slice(pos + 2);
      }
      break;
  }
  
  // Only return if typo is different from original
  return typo !== word ? typo : null;
}

// ============================================================
// MESSAGE SEGMENTATION
// ============================================================

// Split text into natural message segments
export function splitIntoNaturalSegments(text) {
  if (!text || !text.trim()) return [];
  
  text = text.trim();
  
  // Short messages (under 80 chars) - send as one message
  if (text.length <= 80) {
    return [text];
  }
  
  // Split ONLY on sentence endings (. ! ?) - not on commas
  const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim());
  
  // If we only have one sentence (even if long), send it as one
  if (sentences.length <= 1) {
    // Only split very long single sentences (150+ chars)
    if (text.length > 150) {
      // Find a natural midpoint to split
      const midpoint = Math.floor(text.length / 2);
      
      // Look for a good split point near the midpoint
      const searchRange = text.substring(midpoint - 30, midpoint + 30);
      const commaMatch = searchRange.match(/,\s*/);
      const conjunctionMatch = searchRange.match(/\s+(and|but|so|or|because)\s+/i);
      
      if (conjunctionMatch) {
        const splitIndex = midpoint - 30 + searchRange.indexOf(conjunctionMatch[0]) + conjunctionMatch[0].length;
        return [text.substring(0, splitIndex).trim(), text.substring(splitIndex).trim()];
      } else if (commaMatch) {
        const splitIndex = midpoint - 30 + searchRange.indexOf(commaMatch[0]) + commaMatch[0].length;
        return [text.substring(0, splitIndex).trim(), text.substring(splitIndex).trim()];
      }
      
      // Fallback: split at a space near the midpoint
      const spaceIndex = text.indexOf(' ', midpoint);
      if (spaceIndex > 0) {
        return [text.substring(0, spaceIndex).trim(), text.substring(spaceIndex + 1).trim()];
      }
    }
    
    return [text];
  }
  
  // Multiple sentences - group them naturally
  const segments = [];
  let currentSegment = '';
  
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    
    // If adding this sentence would make segment too long (100+ chars)
    // or the sentence itself is long (80+ chars), start a new segment
    if (currentSegment && (currentSegment.length + trimmed.length > 100 || trimmed.length > 80)) {
      segments.push(currentSegment.trim());
      currentSegment = trimmed;
    } else {
      // Group short sentences together
      currentSegment = currentSegment ? `${currentSegment} ${trimmed}` : trimmed;
    }
  }
  
  // Don't forget the last segment
  if (currentSegment.trim()) {
    segments.push(currentSegment.trim());
  }
  
  return segments;
}

// ============================================================
// REALISTIC TYPING
// ============================================================

// Realistic typing simulation
export async function typeRealistic(input, text) {
  const isTextarea = input.tagName === 'TEXTAREA' || input.tagName === 'INPUT';
  let currentText = '';
  
  // Get current typing speed (adjusted by user's speed setting)
  const TYPING_SPEED = getTypingSpeed();
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    currentText += char;
    
    // Update the input value (cumulative, not append)
    if (isTextarea) {
      input.value = currentText;
    } else {
      input.textContent = currentText;
    }
    
    // Dispatch only the essential input event for React/Vue to detect changes
    input.dispatchEvent(new Event('input', { bubbles: true }));
    
    // Calculate delay with natural variation
    let delay = TYPING_SPEED.baseDelay + (Math.random() * TYPING_SPEED.variation * 2 - TYPING_SPEED.variation);
    
    // Add extra pause after punctuation
    if (['.', ',', '!', '?', ';', ':'].includes(char)) {
      delay += TYPING_SPEED.pauseAfterPunctuation;
    }
    // Add small pause after space (word boundary)
    else if (char === ' ') {
      delay += TYPING_SPEED.pauseAfterWord;
    }
    
    await sleep(delay);
  }
  
  // Final event to ensure UI is updated
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// ============================================================
// MESSAGE SENDING
// ============================================================

// Send message with segmentation and optional typos
export async function sendSegmentedMessage(text) {
  const segments = splitIntoNaturalSegments(text);
  console.log('[Clarity] Splitting message into segments:', segments);
  
  if (segments.length === 0) {
    return { success: false, error: 'No valid segments' };
  }
  
  // Find the chat input once
  const input = findChatInput();
  if (!input) {
    return { success: false, error: 'Chat input field not found' };
  }
  
  const results = [];
  
  for (let i = 0; i < segments.length; i++) {
    let segment = segments[i];
    let typoCorrection = null;
    
    // Check for typo opportunity (2.5% per word in segment)
    const words = segment.split(/\s+/);
    for (let w = 0; w < words.length; w++) {
      if (Math.random() < TYPO_CONFIG.rate) {
        const typo = generateTypo(words[w]);
        if (typo) {
          // Create typo version
          const typoWords = [...words];
          typoWords[w] = typo;
          const typoSegment = typoWords.join(' ');
          
          // Create correction
          typoCorrection = words[w] + '*';
          
          // Send typo first
          console.log('[Clarity] Introducing typo:', typoSegment, '-> correction:', typoCorrection);
          const typoResult = await sendSingleMessage(input, typoSegment);
          if (!typoResult.success) {
            results.push(typoResult);
            continue;
          }
          results.push(typoResult);
          
          // Small delay before correction
          await sleep(500 + Math.random() * 500);
          
          // Send correction
          const correctionResult = await sendSingleMessage(input, typoCorrection);
          results.push(correctionResult);
          
          // Mark that we've done the typo for this segment
          segment = null;
          break;
        }
      }
    }
    
    // If no typo was introduced, send the normal segment
    if (segment) {
      const result = await sendSingleMessage(input, segment);
      results.push(result);
    }
    
    // Delay between segments (1-3 seconds) - only if not last segment
    if (i < segments.length - 1) {
      const delay = 1000 + Math.random() * 2000;
      console.log(`[Clarity] Waiting ${Math.round(delay)}ms before next segment...`);
      await sleep(delay);
    }
  }
  
  // Return success if at least one message was sent
  const anySuccess = results.some(r => r.success);
  return { 
    success: anySuccess, 
    segmentsSent: results.filter(r => r.success).length,
    totalSegments: results.length
  };
}

// Send a single message segment
export async function sendSingleMessage(input, text) {
  try {
    // Focus the input
    input.focus();
    input.click();
    await sleep(100);
    
    // Clear existing content
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      input.value = '';
    } else {
      input.innerHTML = '';
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    
    // Type the message
    await typeRealistic(input, text);
    await sleep(200);
    
    // Find and click send
    const sendBtn = findSendButton(input);
    if (!sendBtn) {
      return { success: false, error: 'Send button not found' };
    }
    
    sendBtn.click();
    await sleep(300); // Wait for message to send
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Main entry point for sending messages — instant set + click send (no typing animation)
// 
// Options:
//   skipInjection (boolean) — when true, skip ALL text manipulation and only click the
//   send button. Used by the CRM bridge when text was already pushed into the compose
//   box via SET_DRAFT_TEXT (live typing). This prevents the visible "select-all + replace"
//   flash that the user sees as a "typing effect".
export async function sendMessageToChat(text, options = {}) {
  if (!text?.trim()) {
    return { success: false, error: 'No message text provided' };
  }
  
  if (!isOnChatPage()) {
    return { success: false, error: 'Not on a chat page' };
  }
  
  const { skipInjection = false } = options;
  console.log(`[Clarity] Sending message instantly (skipInjection=${skipInjection})...`);
  
  try {
    // Step 1: Find the ProseMirror editor (same selector as SET_DRAFT_TEXT)
    const editor = document.querySelector(
      '.tiptap.ProseMirror.b-text-editor, ' +
      '[contenteditable="true"].b-text-editor, ' +
      '.b-chat__message-input [contenteditable="true"], ' +
      '.b-make-post__main-wrapper [contenteditable="true"]'
    );
    
    if (skipInjection) {
      // CRM send path: text is already in the compose box from live typing.
      // Do NOT touch the editor content at all — just click the send button below.
      console.log('[Clarity] ✅ skipInjection=true — not touching editor, will only click send');
    } else {
      // Non-CRM path (e.g. auto-chat): check if text is already present, inject if not
      // Normalize comparison: strip \n, \u200B (zero-width space), and collapse whitespace
      const normalize = s => (s || '').replace(/[\n\r\u200B]/g, ' ').replace(/\s+/g, ' ').trim();
      const currentText = editor ? normalize(editor.innerText) : '';
      const targetText = normalize(text);
      const textAlreadyPresent = currentText === targetText;
      
      if (textAlreadyPresent) {
        console.log('[Clarity] ✅ Text already in compose box — skipping injection');
      } else if (!editor) {
        // Fallback: try textarea-based input
        const input = findChatInput();
        if (!input) return { success: false, error: 'Chat input not found' };
        input.focus();
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        // Use execCommand for proper ProseMirror state sync (same as SET_DRAFT_TEXT)
        editor.focus();
        const sel = window.getSelection();
        sel.selectAllChildren(editor);
        document.execCommand('insertText', false, text);
      }
    }
    
    // Step 2: Small delay for OF's framework to register the text change
    await sleep(200);
    
    // Step 3: Find and click the send button (poll for up to 1s if skipInjection)
    const input = editor || findChatInput();
    let sendBtn = findSendButton(input);
    
    // When skipInjection, the send button should already be enabled from SET_DRAFT_TEXT.
    // Poll for up to 2s in case ProseMirror needs a moment. No injection fallback exists.
    if (!sendBtn && skipInjection) {
      for (let i = 0; i < 20; i++) {
        await sleep(100);
        sendBtn = findSendButton(input);
        // Also try OF-specific selectors directly
        if (!sendBtn || sendBtn.disabled) {
          sendBtn = document.querySelector(
            'button[at-attr="send_btn"].b-chat__btn-submit:not([disabled]), ' +
            'button.b-chat__btn-submit:not([disabled]), ' +
            'button.g-btn.m-rounded.b-chat__btn-submit:not([disabled])'
          );
        }
        if (sendBtn && !sendBtn.disabled) break;
      }
    }
    
    if (!sendBtn) return { success: false, error: 'Send button not found' };
    
    sendBtn.click();
    await sleep(300);
    
    // ── Post-send verification: poll for compose box to be cleared ──
    // After clicking send, OF should clear the compose box within ~2s.
    // If it's still populated, the message likely wasn't sent (e.g. rate limit, error).
    const verifyEditor = document.querySelector(
      '.tiptap.ProseMirror.b-text-editor, ' +
      '[contenteditable="true"].b-text-editor, ' +
      '.b-chat__message-input [contenteditable="true"], ' +
      '.b-make-post__main-wrapper [contenteditable="true"]'
    );
    if (verifyEditor) {
      const VERIFY_POLLS = 20; // 20 × 150ms = 3s max
      let cleared = false;
      for (let v = 0; v < VERIFY_POLLS; v++) {
        const remaining = (verifyEditor.innerText || '').replace(/[\n\r\u200B]/g, '').trim();
        if (!remaining) {
          cleared = true;
          console.log(`[Clarity] ✅ Post-send verify: compose box cleared (poll ${v + 1}/${VERIFY_POLLS})`);
          break;
        }
        await sleep(150);
      }
      if (!cleared) {
        const leftover = (verifyEditor.innerText || '').substring(0, 60);
        console.warn(`[Clarity] ⚠️ Post-send verify: compose box NOT cleared after 3s — text: "${leftover}"`);
        return { success: false, error: 'Message may not have sent — compose box not cleared after 3s' };
      }
    }
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

// Find chat input field
export function findChatInput() {
  const selectors = [
    'textarea[placeholder*="message"]',
    'textarea[placeholder*="Message"]',
    '.b-chat__input textarea',
    '.b-chat-input textarea',
    'div[contenteditable="true"]',
    'textarea.form-control',
    'textarea'
  ];
  
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

// Find the send button
export function findSendButton(input) {
  // Strategy 1: Look for common send button selectors
  const sendSelectors = [
    'button[type="submit"]',
    '.b-chat__send-btn',
    'button.b-chat__btn-submit',
    '.b-chat-input__send',
    'button.g-btn-send',
    '[class*="send-btn"]',
    '[class*="send_btn"]',
    'button[class*="submit"]',
    '.b-chat__btn-submit',
    'button.g-btn.m-rounded'
  ];
  
  for (const selector of sendSelectors) {
    const btn = document.querySelector(selector);
    if (btn && !btn.disabled) return btn;
  }
  
  // Strategy 2: Find button inside the chat form/container
  const chatContainer = input.closest('.b-chat__input, .b-chat-input, form, .b-chat__footer');
  if (chatContainer) {
    const buttons = chatContainer.querySelectorAll('button');
    for (const btn of buttons) {
      // Skip disabled buttons
      if (btn.disabled) continue;
      // Look for send-like buttons
      const html = btn.innerHTML.toLowerCase();
      const classes = btn.className.toLowerCase();
      if (html.includes('send') || classes.includes('send') || classes.includes('submit')) {
        return btn;
      }
    }
    // Return the last enabled button in the container
    for (let i = buttons.length - 1; i >= 0; i--) {
      if (!buttons[i].disabled) return buttons[i];
    }
  }
  
  // Strategy 3: Look for SVG send icon
  const svgSend = document.querySelector('svg[class*="send"], svg[class*="Send"]');
  if (svgSend) {
    const btn = svgSend.closest('button');
    if (btn && !btn.disabled) return btn;
  }
  
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isOnChatPage() {
  const url = window.location.href;
  const isChatUrl = url.includes('/my/chats/chat/') || url.includes('/messages/');
  const hasChat = !!document.querySelector('.b-chat__messages-wrapper, .b-chat__content');
  return isChatUrl || hasChat;
}

// ============================================================
// IMAGE SENDING (Drag & Drop to Chat)
// ============================================================

// Wait for the OnlyFans Send button to become ready (enabled with "Send" text)
async function waitForSendButtonReady(maxWaitMs = 30000, checkIntervalMs = 500) {
  console.log('[Clarity] ⏳ Waiting for Send button to become ready...');
  
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitMs) {
    // Look for the specific OnlyFans send button
    const sendBtn = document.querySelector(
      'button[at-attr="send_btn"].b-chat__btn-submit, ' +
      'button.b-chat__btn-submit, ' +
      'button.g-btn.m-rounded.b-chat__btn-submit'
    );
    
    if (sendBtn) {
      // Check if button is enabled (not disabled) and has "Send" text
      const btnText = sendBtn.textContent?.trim().toLowerCase();
      const isEnabled = !sendBtn.disabled && !sendBtn.hasAttribute('disabled');
      const hasSendText = btnText === 'send';
      
      console.log('[Clarity] Button state: enabled=' + isEnabled + ', text="' + btnText + '"');
      
      if (isEnabled && hasSendText) {
        console.log('[Clarity] ✅ Send button is ready!');
        return sendBtn;
      }
    }
    
    // Wait before checking again
    await sleep(checkIntervalMs);
  }
  
  console.log('[Clarity] ⚠️ Timeout waiting for Send button to be ready');
  return null;
}

// Send image to chat via drag & drop (with optional price for PPV)
export async function sendImageToChat(imageData, caption = null, price = 0, autoSend = true) {
  console.log('[Clarity] 📸 Sending image to OnlyFans chat...', price > 0 ? `(PPV $${price})` : '(free)', autoSend ? '' : '(stage only)');
  
  if (!isOnChatPage()) {
    return { success: false, error: 'Not on a chat page' };
  }
  
  try {
    // Find the chat text editor (contenteditable div)
    const chatEditor = document.querySelector(
      '.b-text-editor.js-text-editor, ' +
      'div[contenteditable="true"].tiptap, ' +
      '.b-make-post__textarea-wrapper div[contenteditable="true"], ' +
      '.b-chat__input div[contenteditable="true"], ' +
      'div.ProseMirror[contenteditable="true"]'
    );
    
    if (!chatEditor) {
      console.log('[Clarity] ❌ Could not find chat editor');
      return { success: false, error: 'Chat editor not found' };
    }
    
    console.log('[Clarity] ✅ Found chat editor:', chatEditor.className);
    
    // Detect MIME type (supports base64 data URLs AND remote URLs)
    let mimeType = 'image/jpeg';
    let filename = 'image.jpg';
    
    if (imageData.startsWith('data:')) {
      const match = imageData.match(/^data:([^;,]+)[;,]/);
      if (match) {
        mimeType = match[1];
        if (mimeType.startsWith('video/')) {
          const ext = mimeType.split('/')[1] === 'quicktime' ? 'mov' : (mimeType.split('/')[1] || 'mp4');
          filename = `video.${ext}`;
          console.log('[Clarity] 🎥 Detected video file:', filename, mimeType);
        } else {
          const ext = mimeType.split('/')[1] || 'jpg';
          filename = `image.${ext}`;
        }
      }
    } else if (imageData.startsWith('http')) {
      // Remote URL (Firebase Storage, etc.) — detect type from URL path
      const urlPath = imageData.split('?')[0].toLowerCase();
      if (urlPath.match(/\.(mp4|webm|mov|avi)/) || urlPath.includes('video')) {
        mimeType = 'video/mp4';
        filename = 'video.mp4';
        console.log('[Clarity] 🎥 Detected video URL');
      } else if (urlPath.match(/\.(gif)/)) {
        mimeType = 'image/gif';
        filename = 'image.gif';
      } else if (urlPath.match(/\.(png)/)) {
        mimeType = 'image/png';
        filename = 'image.png';
      } else if (urlPath.match(/\.(webp)/)) {
        mimeType = 'image/webp';
        filename = 'image.webp';
      }
      // Note: base64ToFile will use actual content-type from fetch response
      console.log('[Clarity] 🌐 Remote URL detected, initial type guess:', mimeType);
    }
    
    // Convert base64 to File
    const file = await base64ToFile(imageData, filename, mimeType);
    if (!file) {
      return { success: false, error: 'Failed to create file from image data' };
    }
    
    console.log('[Clarity] 📦 Created file:', file.name, file.size, 'bytes');
    
    // Focus the editor first
    chatEditor.focus();
    chatEditor.click();
    await sleep(200);
    
    // Create drag & drop events
    const dropSuccess = await simulateDragDrop(chatEditor, file);
    
    if (!dropSuccess) {
      console.log('[Clarity] ⚠️ Drag & drop failed, trying clipboard paste...');
      const pasteSuccess = await simulatePaste(chatEditor, file);
      if (!pasteSuccess) {
        return { success: false, error: 'Could not add image via drag/drop or paste' };
      }
    }
    
    console.log('[Clarity] 📤 Image dropped, waiting for upload to complete...');
    
    // Wait for the Send button to become ready (image uploaded and processed)
    const sendBtn = await waitForSendButtonReady(30000, 500);
    
    if (!sendBtn) {
      console.log('[Clarity] ⚠️ Send button not ready after timeout');
      return { success: false, error: 'Image upload timed out or Send button not found' };
    }
    
    // If there's a caption, type it now that the image is ready
    if (caption) {
      console.log('[Clarity] 💬 Typing caption:', caption);
      
      // Check if image triggered a modal or the editor still accepts text
      const textInput = document.querySelector(
        '.b-make-post__textarea-wrapper div[contenteditable="true"], ' +
        '.b-chat__input textarea, ' +
        'div.ProseMirror[contenteditable="true"]'
      );
      
      if (textInput) {
        textInput.focus();
        await sleep(100);
        
        // Type caption - use textContent to prevent XSS
        if (textInput.tagName === 'TEXTAREA' || textInput.tagName === 'INPUT') {
          textInput.value = caption;
        } else {
          // For contenteditable divs, create a paragraph element safely
          const p = document.createElement('p');
          p.textContent = caption;
          textInput.innerHTML = '';
          textInput.appendChild(p);
        }
        textInput.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(200);
      }
    }
    
    // ============================================================
    // STAGE ONLY MODE - Don't auto-send, let user click send
    // ============================================================
    if (!autoSend) {
      console.log('[Clarity] 📋 Image staged in chat composer — user will send manually');
      return { success: true, staged: true, sent: false };
    }

    // ============================================================
    // SET PRICE (PPV) - If price > 0, set the price before sending
    // ============================================================
    if (price > 0) {
      console.log('[Clarity] 💰 Setting PPV price: $' + price);
      
      const priceSet = await setMediaPrice(price);
      if (priceSet) {
        console.log('[Clarity] ✅ Price set to $' + price);
      } else {
        console.log('[Clarity] ⚠️ Could not set price - sending as free');
      }
      
      // Re-find send button after price change (OnlyFans may re-render the button)
      const updatedSendBtn = await waitForSendButtonReady(5000, 300);
      if (updatedSendBtn) {
        console.log('[Clarity] 🚀 Clicking send button (after price set)...');
        updatedSendBtn.click();
        await sleep(1000);
        console.log('[Clarity] ✅ Image sent with price $' + price);
        return { success: true, sent: true, priceSet: priceSet };
      }
    }
    
    // Click the send button (free or price failed)
    console.log('[Clarity] 🚀 Clicking send button...');
    sendBtn.click();
    await sleep(1000);
    
    console.log('[Clarity] ✅ Image sent successfully!');
    return { success: true, sent: true };
    
  } catch (error) {
    console.error('[Clarity] ❌ Error sending image:', error);
    return { success: false, error: error.message };
  }
}

// Convert image data (base64 data URL or remote URL) to File object
async function base64ToFile(dataUrl, filename, mimeType) {
  try {
    // If it's a remote URL (Firebase Storage, etc.) — fetch it first
    if (dataUrl.startsWith('http://') || dataUrl.startsWith('https://')) {
      console.log('[Clarity] 🌐 Fetching remote media:', dataUrl.substring(0, 80) + '...');
      const response = await fetch(dataUrl);
      if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
      const blob = await response.blob();
      // Use the actual content type from the response if available
      const actualType = blob.type || mimeType;
      return new File([blob], filename, { type: actualType });
    }
    
    // Otherwise treat as base64 data URL
    let base64Data = dataUrl;
    if (dataUrl.includes(',')) {
      base64Data = dataUrl.split(',')[1];
    }
    
    const byteString = atob(base64Data);
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    
    for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }
    
    const blob = new Blob([ab], { type: mimeType });
    return new File([blob], filename, { type: mimeType });
  } catch (error) {
    console.error('[Clarity] Error converting data to file:', error);
    return null;
  }
}

// Simulate drag & drop
async function simulateDragDrop(target, file) {
  try {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    
    // Create the sequence of drag events
    const dragEnter = new DragEvent('dragenter', {
      bubbles: true,
      cancelable: true,
      dataTransfer: dataTransfer
    });
    
    const dragOver = new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      dataTransfer: dataTransfer
    });
    
    const drop = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: dataTransfer
    });
    
    console.log('[Clarity] 🎯 Dispatching drag events...');
    target.dispatchEvent(dragEnter);
    await sleep(50);
    target.dispatchEvent(dragOver);
    await sleep(50);
    target.dispatchEvent(drop);
    
    console.log('[Clarity] ✅ Drag & drop events dispatched');
    return true;
  } catch (error) {
    console.error('[Clarity] Drag & drop error:', error);
    return false;
  }
}

// Simulate paste
async function simulatePaste(target, file) {
  try {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    
    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer
    });
    
    target.dispatchEvent(pasteEvent);
    console.log('[Clarity] ✅ Paste event dispatched');
    return true;
  } catch (error) {
    console.error('[Clarity] Paste error:', error);
    return false;
  }
}

// ============================================================
// PRICE SETTING (PPV) - Set price on uploaded media
// ============================================================

// Set the price on uploaded media before sending
// OnlyFans flow: click lock/price button → price UI appears → type price → confirm
// Works for both chat compose area and post creation
export async function setMediaPrice(price) {
  try {
    console.log('[Clarity] 💰 setMediaPrice() called with price:', price);

    // ── Step 1: Find the compose area context ──
    const composeArea = document.querySelector(
      '.b-make-post__main-wrapper, ' +
      '.b-chat__message-input, ' +
      '.b-chat__footer, ' +
      '.b-chat__input-wrapper, ' +
      '.b-make-post'
    );
    console.log('[Clarity] 💰 Compose area:', composeArea ? composeArea.className : 'NOT FOUND');

    // ── Step 2: Find the price/lock toggle button ──
    // OnlyFans uses SVG icons with <use href="#icon-..."> pattern.
    // The lock/price button can be in the compose toolbar or footer.
    const priceToggleSelectors = [
      // SVG icon-based (most reliable for current OF)
      'use[href="#icon-lock-open"]',
      'use[href="#icon-lock-close"]',
      'use[href="#icon-lock"]',
      'use[href*="lock"]',
      'use[href*="price"]',
      'svg[data-icon-name="icon-lock"]',
      'svg[data-icon-name*="lock"]',
      // Class-based
      'button[class*="lock"]',
      'button[class*="price"]',
      '.b-make-post__lock-btn',
      '[class*="lock-btn"]',
      '[class*="price-btn"]',
      // Attribute-based
      'button[at-attr="price_btn"]',
      'button[at-attr="lock_btn"]',
      // Generic class patterns (OF uses b-make-post__actions for toolbar buttons)
      '.b-make-post__actions button',
    ];

    let priceToggle = null;
    let matchedSelector = null;

    // First try within compose area context
    if (composeArea) {
      for (const selector of priceToggleSelectors) {
        try {
          const el = composeArea.querySelector(selector);
          if (el) {
            priceToggle = el.closest('button') || el;
            matchedSelector = `[compose] ${selector}`;
            break;
          }
        } catch { /* invalid selector in this context */ }
      }
    }

    // Fallback: search globally
    if (!priceToggle) {
      for (const selector of priceToggleSelectors) {
        try {
          const el = document.querySelector(selector);
          if (el) {
            priceToggle = el.closest('button') || el;
            matchedSelector = `[global] ${selector}`;
            break;
          }
        } catch { /* invalid selector */ }
      }
    }

    // Last resort: scan ALL buttons in compose area for lock-related icons
    if (!priceToggle && composeArea) {
      const allBtns = composeArea.querySelectorAll('button');
      for (const btn of allBtns) {
        const html = btn.innerHTML.toLowerCase();
        if (html.includes('lock') || html.includes('price') || html.includes('tag')) {
          priceToggle = btn;
          matchedSelector = `[innerHTML scan] "${html.substring(0, 60)}"`;
          break;
        }
      }
    }

    if (!priceToggle) {
      // Log all buttons found in page for debugging
      const allPageBtns = document.querySelectorAll('button');
      const btnInfo = Array.from(allPageBtns).slice(0, 20).map(b => 
        `<${b.tagName} class="${b.className.substring(0, 50)}" at-attr="${b.getAttribute('at-attr') || ''}">`
      );
      console.warn('[Clarity] 💰 ❌ Price toggle NOT FOUND. Buttons on page:', btnInfo);
      console.warn('[Clarity] 💰 Make sure media is attached in the compose box before setting price.');
      return false;
    }

    console.log('[Clarity] 💰 ✅ Found price toggle via:', matchedSelector);
    priceToggle.click();
    await sleep(1500); // Wait for price UI to appear (modal or inline)

    // ── Step 3: Find the price input ──
    // OF may show: a modal with input, OR an inline price input in the compose area
    const priceInputSelectors = [
      // Modal-based (older OF / post creation)
      '#ModalPostPrice___BV_modal_body_ input',
      '.modal-body input[inputmode="decimal"]',
      '.modal-body input[placeholder="Free"]',
      '.modal-body input[type="text"]',
      // Inline compose area inputs
      'input[placeholder="Free"]',
      'input[autocomplete="price-input"]',
      'input[inputmode="decimal"]',
      'input[id^="priceInput"]',
      '.b-price-input input',
      // Generic: any visible input that appeared after clicking the toggle
      '.b-make-post__price input',
      '.b-chat__price input',
      'input[name="price"]',
      'input[type="number"]',
    ];

    let priceInput = null;

    for (let attempt = 0; attempt < 10; attempt++) {
      for (const selector of priceInputSelectors) {
        try {
          const el = document.querySelector(selector);
          if (el && el.offsetParent !== null) { // Must be visible
            priceInput = el;
            console.log('[Clarity] 💰 Found price input via:', selector, '(attempt', attempt + 1, ')');
            break;
          }
        } catch { /* invalid selector */ }
      }
      if (priceInput) break;

      // Also search within any open modal
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [class*="modal"][class*="active"], .b-modal');
      if (modal) {
        const inputs = modal.querySelectorAll('input');
        for (const inp of inputs) {
          if (inp.offsetParent !== null && (inp.type === 'text' || inp.type === 'number' || inp.inputMode === 'decimal')) {
            priceInput = inp;
            console.log('[Clarity] 💰 Found price input in modal (attempt', attempt + 1, ')');
            break;
          }
        }
      }
      if (priceInput) break;

      console.log('[Clarity] 💰 Price input not found yet, retrying... (attempt', attempt + 1, ')');
      await sleep(500);
    }

    if (!priceInput) {
      console.warn('[Clarity] 💰 ❌ Price input not found after 10 retries.');
      // Log what's visible on the page for debugging
      const visibleInputs = document.querySelectorAll('input');
      const inputInfo = Array.from(visibleInputs).map(i => 
        `<input type="${i.type}" placeholder="${i.placeholder}" inputmode="${i.inputMode}" class="${i.className.substring(0, 40)}">`
      );
      console.warn('[Clarity] 💰 Visible inputs:', inputInfo);
      return false;
    }

    // ── Step 4: Focus and set the price value ──
    priceInput.focus();
    priceInput.click();
    await sleep(200);

    // Clear existing value
    priceInput.select();
    await sleep(100);

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputValueSetter.call(priceInput, '');
    priceInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(100);

    // Type the price digit by digit for React/Vue to register each change
    const priceStr = String(price);
    for (let i = 0; i < priceStr.length; i++) {
      const currentValue = priceStr.substring(0, i + 1);
      nativeInputValueSetter.call(priceInput, currentValue);
      priceInput.dispatchEvent(new Event('input', { bubbles: true }));
      priceInput.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(80);
    }

    // Final events to ensure UI registers the value
    priceInput.dispatchEvent(new Event('change', { bubbles: true }));
    priceInput.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(500);

    console.log('[Clarity] 💰 Price input value after set:', priceInput.value);

    // ── Step 5: Find and click the confirm/save button ──
    // Could be "Save" in a modal footer, or a checkmark/confirm button inline
    let saveBtn = null;

    for (let attempt = 0; attempt < 8; attempt++) {
      // Strategy A: Modal footer with Save button
      const modalFooter = document.querySelector(
        '#ModalPostPrice___BV_modal_footer_, ' +
        '.modal-footer, ' +
        '.modal .b-modal__footer'
      );
      if (modalFooter) {
        const buttons = modalFooter.querySelectorAll('button');
        for (const btn of buttons) {
          const text = btn.textContent?.trim().toLowerCase();
          if ((text === 'save' || text === 'ok' || text === 'confirm' || text === 'apply' || text === 'set') && !btn.disabled) {
            saveBtn = btn;
            break;
          }
        }
      }
      if (saveBtn) break;

      // Strategy B: Any button with save/confirm text near the price input
      const priceContainer = priceInput.closest('.modal, .b-make-post__price, .b-price-input, [class*="price"], form');
      if (priceContainer) {
        const buttons = priceContainer.querySelectorAll('button:not([disabled])');
        for (const btn of buttons) {
          const text = btn.textContent?.trim().toLowerCase();
          if (text === 'save' || text === 'ok' || text === 'confirm' || text === 'apply' || text === 'set') {
            saveBtn = btn;
            break;
          }
        }
      }
      if (saveBtn) break;

      // Strategy C: Look for primary/submit button in any visible modal
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"]');
      if (modal) {
        const primaryBtn = modal.querySelector('button.btn-primary:not([disabled]), button[class*="primary"]:not([disabled]), button[type="submit"]:not([disabled])');
        if (primaryBtn) {
          saveBtn = primaryBtn;
          break;
        }
      }

      // Strategy D: Scan all visible buttons for save-like text
      const allBtns = document.querySelectorAll('button:not([disabled])');
      for (const btn of allBtns) {
        const text = btn.textContent?.trim().toLowerCase();
        const isVisible = btn.offsetParent !== null;
        if (isVisible && (text === 'save' || text === 'set price' || text === 'apply price')) {
          saveBtn = btn;
          break;
        }
      }
      if (saveBtn) break;

      console.log('[Clarity] 💰 Save/confirm button not found yet... (attempt', attempt + 1, ')');
      await sleep(500);
    }

    if (saveBtn) {
      console.log('[Clarity] 💰 Clicking Save/confirm button:', saveBtn.textContent?.trim());
      saveBtn.click();
      await sleep(1000); // Wait for modal to close / UI to update
      console.log('[Clarity] 💰 ✅ Price $' + price + ' saved!');
      return true;
    } else {
      console.warn('[Clarity] 💰 ⚠️ Save button not found after retries');
      // The price might have been set even without clicking Save (some inline UIs auto-save on blur)
      // Check if the price value stuck
      if (priceInput.value === priceStr) {
        console.log('[Clarity] 💰 ℹ️ Price value is set in input — may have auto-saved on blur');
        // Try pressing Enter as a fallback
        priceInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        priceInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        await sleep(500);
        return true;
      }
      // Try to close modal if one is open
      const cancelBtn = document.querySelector('.modal-footer button:first-child, .modal button[class*="cancel"], .modal button[class*="close"]');
      if (cancelBtn) cancelBtn.click();
      return false;
    }

  } catch (error) {
    console.error('[Clarity] 💰 setMediaPrice() error:', error);
    return false;
  }
}

// Find any send button on the page
function findAnySendButton() {
  const selectors = [
    'button[type="submit"]:not([disabled])',
    'button.g-btn.m-rounded:not([disabled])',
    '.b-chat__btn-submit:not([disabled])',
    'button[class*="send"]:not([disabled])',
    'button[class*="Submit"]:not([disabled])'
  ];
  
  for (const selector of selectors) {
    const btn = document.querySelector(selector);
    if (btn) {
      console.log('[Clarity] Found send button via:', selector);
      return btn;
    }
  }
  
  // Try to find button with send icon
  const allButtons = document.querySelectorAll('button:not([disabled])');
  for (const btn of allButtons) {
    const html = btn.innerHTML.toLowerCase();
    if (html.includes('send') || html.includes('submit') || html.includes('icon-send')) {
      return btn;
    }
  }
  
  return null;
}
