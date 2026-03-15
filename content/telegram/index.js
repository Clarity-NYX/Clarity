// Clarity Notes - Telegram Web A Content Script
// For web.telegram.org/a/

(function() {
  'use strict';
  
  // ============================================================
  // STATE
  // ============================================================
  
  let messages = [];
  let observer = null;
  let lastUrl = '';
  let currentChatId = null;
  let pollingInterval = null;
  let lastMessageCount = 0;
  
  // ============================================================
  // SELECTORS - Telegram Web A specific
  // ============================================================
  
  const SELECTORS = {
    // Chat container
    chatContainer: '.bubbles, .messages-container, #column-center .bubbles-inner',
    
    // Individual messages
    messageElement: '.bubble, .message',
    
    // Message text content
    messageText: '.message, .text-content, .translatable-message',
    
    // Message time
    messageTime: '.time, .time-inner, time',
    
    // Own messages (outgoing)
    ownMessage: '.is-out',
    
    // Chat header with username
    chatHeader: '.chat-info, .peer-title, .top .info',
    
    // Username in header
    usernameElement: '.peer-title, .chat-info .title, .info .title',
    
    // Chat input
    chatInput: '#editable-message-text, .input-message-input, [contenteditable="true"]',
    
    // Send button
    sendButton: '.btn-send, .send-btn, .button-send, button[class*="send"]'
  };
  
  // ============================================================
  // INITIALIZATION
  // ============================================================
  
  function init() {
    console.log('[Clarity-TG] Telegram content script loaded');
    setupMessageListener();
    startWatching();
  }
  
  // ============================================================
  // MESSAGE LISTENER
  // ============================================================
  
  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'GET_MESSAGES') {
        if (!isInChat()) {
          sendChatMessages([]);
          sendResponse({ success: false, error: 'Not in a Telegram chat' });
          return true;
        }
        
        const extracted = extractAllMessages();
        sendChatMessages(extracted);
        sendResponse({ success: true, count: extracted.length, platform: 'telegram' });
        return true;
      }
      
      // Handle auto-send message request
      if (message.type === 'SEND_MESSAGE') {
        console.log('[Clarity-TG] Auto-send message requested');
        sendMessageToChat(message.text)
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
      }
      
      // Handle image send request (for autochat media actions)
      if (message.type === 'SEND_IMAGE') {
        console.log('[Clarity-TG] Send image requested');
        console.log('[Clarity-TG] Image is URL:', message.isUrl);
        console.log('[Clarity-TG] Caption:', message.caption || '(none)');
        sendImageToChat(message.imageUrl, message.isUrl, message.caption)
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
      }
      
      // Handle getting chat info
      if (message.type === 'GET_CHAT_INFO') {
        const info = getChatInfo();
        sendResponse({ success: true, info, platform: 'telegram' });
        return true;
      }
      
      // Handle checking who sent the last message (for image reply detection)
      if (message.type === 'CHECK_LAST_MESSAGE_SENDER') {
        const result = checkLastMessageSender();
        sendResponse(result);
        return true;
      }
      
      // Handle auto-chat open request
      if (message.type === 'AUTOCHAT_OPEN_CHAT') {
        console.log('[Clarity-TG] Auto-chat open request for:', message.data?.chatId);
        openChatById(message.data?.chatId)
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
      }
      
      // Handle AI generation trigger from AutoChat
      if (message.type === 'AUTOCHAT_GENERATE_AI') {
        console.log('[Clarity-TG] AutoChat AI generation request for:', message.data?.peerId);
        // Relay to sidepanel to trigger AI generation
        chrome.runtime.sendMessage({
          type: 'AUTOCHAT_TRIGGER_GENERATION',
          data: { 
            peerId: message.data?.peerId,
            autoSend: message.data?.autoSend
          }
        }).catch(() => {});
        sendResponse({ success: true });
        return true;
      }
    });
  }
  
  // ============================================================
  // AUTO-CHAT: Open a specific chat by ID
  // ============================================================
  
  async function openChatById(chatId) {
    if (!chatId) {
      return { success: false, error: 'No chat ID provided' };
    }
    
    console.log('[Clarity-TG] Looking for chat:', chatId);
    
    // Find the chat item in the list
    const chatList = document.querySelector('.chat-list, .ChatList, [class*="chat-list"]');
    if (!chatList) {
      return { success: false, error: 'Chat list not found' };
    }
    
    // Try different selectors for chat items
    const chatSelectors = [
      `[data-chat-id="${chatId}"]`,
      `[data-peer-id="${chatId}"]`,
      `.chat-item[data-id="${chatId}"]`,
      `.ListItem[data-peer-id="${chatId}"]`,
      `.Chat[data-peer-id="${chatId}"]`
    ];
    
    let chatEl = null;
    for (const selector of chatSelectors) {
      chatEl = document.querySelector(selector);
      if (chatEl) break;
    }
    
    // If not found by ID, try finding by unread indicator and matching
    if (!chatEl) {
      console.log('[Clarity-TG] Chat not found by ID, searching in list...');
      const allChats = chatList.querySelectorAll('.ListItem, .chat-item, .Chat');
      for (const chat of allChats) {
        const peerId = chat.getAttribute('data-peer-id') || chat.getAttribute('data-chat-id');
        if (peerId === chatId || peerId === `-${chatId}` || `-${peerId}` === chatId) {
          chatEl = chat;
          break;
        }
      }
    }
    
    if (!chatEl) {
      return { success: false, error: `Chat ${chatId} not found in list` };
    }
    
    // Click on the chat to open it
    console.log('[Clarity-TG] Found chat, clicking...');
    chatEl.click();
    
    // Wait for chat to load
    await sleep(1000);
    
    return { success: true, chatId };
  }
  
  function sendChatMessages(data) {
    chrome.runtime.sendMessage({ type: 'CHAT_MESSAGES', data, platform: 'telegram' }).catch(() => {});
  }
  
  function sendNewMessage(data) {
    chrome.runtime.sendMessage({ type: 'NEW_MESSAGE', data, platform: 'telegram' }).catch(() => {});
  }
  
  // ============================================================
  // PAGE WATCHING
  // ============================================================
  
  function startWatching() {
    lastUrl = window.location.href;
    
    // URL/hash change detection (Telegram uses hash routing)
    const checkForChanges = () => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        const previousUrl = lastUrl;
        lastUrl = currentUrl;
        
        console.log('[Clarity-TG] URL changed:', previousUrl, '->', currentUrl);
        
        if (isInChat()) {
          setTimeout(autoLoadChat, 1000);
        }
      }
    };
    
    // Check periodically for hash changes
    setInterval(checkForChanges, 500);
    
    // Also listen for hashchange event
    window.addEventListener('hashchange', () => {
      console.log('[Clarity-TG] Hash changed');
      setTimeout(() => {
        if (isInChat()) {
          autoLoadChat();
        }
      }, 1000);
    });
    
    // DOM mutation observer for chat content
    new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type !== 'childList' || !mutation.addedNodes.length) continue;
        
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          
          // Check if chat bubbles were added
          if (node.classList?.contains('bubbles') ||
              node.classList?.contains('bubble') ||
              node.querySelector?.('.bubble')) {
            setTimeout(autoLoadChat, 500);
            return;
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
    
    // Initial load
    if (isInChat()) {
      setTimeout(autoLoadChat, 1500);
    }
  }
  
  function autoLoadChat() {
    if (!isInChat()) {
      stopPolling();
      return;
    }
    
    const chatId = getChatIdFromUrl();
    if (chatId !== currentChatId) {
      currentChatId = chatId;
      lastMessageCount = 0;
      console.log('[Clarity-TG] New chat detected:', chatId);
    }
    
    const extracted = extractAllMessages();
    if (extracted.length) {
      messages = extracted;
      sendChatMessages(extracted);
      startMessageObserver();
      startPolling(); // Start polling as backup
    }
  }
  
  // ============================================================
  // POLLING - Backup system for catching missed messages
  // ============================================================
  
  function startPolling() {
    if (pollingInterval) return; // Already polling
    
    console.log('[Clarity-TG] Starting message polling (every 2.5s)');
    pollingInterval = setInterval(() => {
      if (!isInChat()) {
        stopPolling();
        return;
      }
      
      checkForNewMessages();
    }, 2500); // Check every 2.5 seconds
  }
  
  function stopPolling() {
    if (pollingInterval) {
      console.log('[Clarity-TG] Stopping message polling');
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  }
  
  function checkForNewMessages() {
    const extracted = extractAllMessages();
    const newCount = extracted.length;
    
    // Only update if we have more messages than before
    if (newCount > lastMessageCount) {
      console.log(`[Clarity-TG] Polling found ${newCount - lastMessageCount} new message(s)`);
      
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
  // MESSAGE OBSERVER
  // ============================================================
  
  function startMessageObserver() {
    const chatContainer = document.querySelector(SELECTORS.chatContainer);
    if (!chatContainer) return;
    
    observer?.disconnect();
    
    observer = new MutationObserver(mutations => {
      let hasNewContent = false;
      
      for (const mutation of mutations) {
        if (mutation.type !== 'childList' || !mutation.addedNodes.length) continue;
        
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && 
              (node.classList?.contains('bubble') || 
               node.classList?.contains('message') ||
               node.querySelector?.('.bubble'))) {
            hasNewContent = true;
            break;
          }
        }
        if (hasNewContent) break;
      }
      
      if (hasNewContent) {
        const newMessages = extractAllMessages();
        if (newMessages.length > messages.length) {
          const latestMessage = newMessages[newMessages.length - 1];
          messages = newMessages;
          sendNewMessage(latestMessage);
        }
      }
    });
    
    observer.observe(chatContainer, { childList: true, subtree: true });
  }
  
  // ============================================================
  // AUTO-SEND MESSAGE WITH REALISTIC TYPING
  // ============================================================
  
  const TYPING_SPEED = {
    baseDelay: 80,
    variation: 60,
    pauseAfterPunctuation: 200,
    pauseAfterWord: 50
  };
  
  // Typo configuration - DISABLED (users find corrections annoying)
  const TYPO_CONFIG = {
    rate: 0,  // DISABLED - was 0.025, set to 0 to stop all corrections
    types: ['missing', 'double', 'adjacent', 'transposed']
  };
  
  const ADJACENT_KEYS = {
    'a': ['s', 'q', 'w', 'z'],
    'b': ['v', 'g', 'h', 'n'],
    'c': ['x', 'd', 'f', 'v'],
    'd': ['s', 'e', 'r', 'f', 'c', 'x'],
    'e': ['w', 's', 'd', 'r'],
    'f': ['d', 'r', 't', 'g', 'v', 'c'],
    'g': ['f', 't', 'y', 'h', 'b', 'v'],
    'h': ['g', 'y', 'u', 'j', 'n', 'b'],
    'i': ['u', 'j', 'k', 'o'],
    'j': ['h', 'u', 'i', 'k', 'm', 'n'],
    'k': ['j', 'i', 'o', 'l', 'm'],
    'l': ['k', 'o', 'p'],
    'm': ['n', 'j', 'k'],
    'n': ['b', 'h', 'j', 'm'],
    'o': ['i', 'k', 'l', 'p'],
    'p': ['o', 'l'],
    'q': ['w', 'a'],
    'r': ['e', 'd', 'f', 't'],
    's': ['a', 'w', 'e', 'd', 'x', 'z'],
    't': ['r', 'f', 'g', 'y'],
    'u': ['y', 'h', 'j', 'i'],
    'v': ['c', 'f', 'g', 'b'],
    'w': ['q', 'a', 's', 'e'],
    'x': ['z', 's', 'd', 'c'],
    'y': ['t', 'g', 'h', 'u'],
    'z': ['a', 's', 'x']
  };
  
  function generateTypo(word) {
    if (word.length < 3) return null;
    
    const typoType = TYPO_CONFIG.types[Math.floor(Math.random() * TYPO_CONFIG.types.length)];
    const pos = Math.floor(Math.random() * (word.length - 1)) + 1;
    
    let typo = word;
    
    switch (typoType) {
      case 'missing':
        typo = word.slice(0, pos) + word.slice(pos + 1);
        break;
      case 'double':
        typo = word.slice(0, pos) + word[pos] + word.slice(pos);
        break;
      case 'adjacent':
        const char = word[pos].toLowerCase();
        const adjacent = ADJACENT_KEYS[char];
        if (adjacent && adjacent.length > 0) {
          const replacement = adjacent[Math.floor(Math.random() * adjacent.length)];
          typo = word.slice(0, pos) + replacement + word.slice(pos + 1);
        }
        break;
      case 'transposed':
        if (pos < word.length - 1) {
          typo = word.slice(0, pos) + word[pos + 1] + word[pos] + word.slice(pos + 2);
        }
        break;
    }
    
    return typo !== word ? typo : null;
  }
  
  // Split text into natural message segments
  // More casual style - don't over-segment, keep messages natural
  function splitIntoNaturalSegments(text) {
    if (!text || !text.trim()) return [];
    
    text = text.trim();
    
    // Short messages (under 80 chars) - send as one message
    if (text.length <= 80) {
      return [text];
    }
    
    // Split ONLY on sentence endings (. ! ?) - not on commas
    // Use a regex that keeps the punctuation with the sentence
    const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim());
    
    // If we only have one sentence (even if long), send it as one
    if (sentences.length <= 1) {
      // Only split very long single sentences (150+ chars)
      if (text.length > 150) {
        // Find a natural midpoint to split (prefer after a comma or conjunction)
        const midpoint = Math.floor(text.length / 2);
        
        // Look for a good split point near the midpoint (comma, "and", "but", "so")
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
    // Short sentences can be grouped together, long ones stay alone
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
  
  async function sendSegmentedMessage(text) {
    const segments = splitIntoNaturalSegments(text);
    console.log('[Clarity-TG] Splitting message into segments:', segments);
    
    if (segments.length === 0) {
      return { success: false, error: 'No valid segments' };
    }
    
    const input = findChatInput();
    if (!input) {
      return { success: false, error: 'Chat input field not found' };
    }
    
    const results = [];
    
    for (let i = 0; i < segments.length; i++) {
      let segment = segments[i];
      
      const words = segment.split(/\s+/);
      for (let w = 0; w < words.length; w++) {
        if (Math.random() < TYPO_CONFIG.rate) {
          const typo = generateTypo(words[w]);
          if (typo) {
            const typoWords = [...words];
            typoWords[w] = typo;
            const typoSegment = typoWords.join(' ');
            const typoCorrection = words[w] + '*';
            
            console.log('[Clarity-TG] Introducing typo:', typoSegment, '-> correction:', typoCorrection);
            const typoResult = await sendSingleMessage(input, typoSegment);
            if (!typoResult.success) {
              results.push(typoResult);
              continue;
            }
            results.push(typoResult);
            
            await sleep(500 + Math.random() * 500);
            
            const correctionResult = await sendSingleMessage(input, typoCorrection);
            results.push(correctionResult);
            
            segment = null;
            break;
          }
        }
      }
      
      if (segment) {
        const result = await sendSingleMessage(input, segment);
        results.push(result);
      }
      
      if (i < segments.length - 1) {
        const delay = 1000 + Math.random() * 2000;
        console.log(`[Clarity-TG] Waiting ${Math.round(delay)}ms before next segment...`);
        await sleep(delay);
      }
    }
    
    const anySuccess = results.some(r => r.success);
    return { 
      success: anySuccess, 
      segmentsSent: results.filter(r => r.success).length,
      totalSegments: results.length
    };
  }
  
  async function sendSingleMessage(input, text) {
    try {
      input.focus();
      await sleep(100);
      
      // Clear existing content
      if (input.textContent !== undefined) {
        input.textContent = '';
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      
      await typeRealistic(input, text);
      await sleep(200);
      
      const sendBtn = findSendButton();
      if (!sendBtn) {
        // Try pressing Enter instead
        const enterEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true
        });
        input.dispatchEvent(enterEvent);
        await sleep(300);
        return { success: true };
      }
      
      sendBtn.click();
      await sleep(300);
      
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  async function sendMessageToChat(text) {
    if (!text?.trim()) {
      return { success: false, error: 'No message text provided' };
    }
    
    if (!isInChat()) {
      return { success: false, error: 'Not in a Telegram chat' };
    }
    
    console.log('[Clarity-TG] Sending message with natural segmentation...');
    return await sendSegmentedMessage(text);
  }
  
  // ============================================================
  // SEND IMAGE TO CHAT (for autochat media actions)
  // ============================================================
  
  async function sendImageToChat(imageUrl, isUrl = false, caption = '') {
    console.log('[Clarity-TG] ═══════════════════════════════════════');
    console.log('[Clarity-TG] 📸 sendImageToChat called');
    console.log('[Clarity-TG] isUrl:', isUrl);
    console.log('[Clarity-TG] caption:', caption || '(none)');
    console.log('[Clarity-TG] imageUrl length:', imageUrl?.length || 0);
    console.log('[Clarity-TG] imageUrl starts with:', imageUrl?.slice(0, 50));
    console.log('[Clarity-TG] ═══════════════════════════════════════');
    
    if (!imageUrl) {
      console.log('[Clarity-TG] ❌ No image URL/data provided');
      return { success: false, error: 'No image URL/data provided' };
    }
    
    if (!isInChat()) {
      console.log('[Clarity-TG] ❌ Not in a Telegram chat');
      return { success: false, error: 'Not in a Telegram chat' };
    }
    
    try {
      let blob;
      
      if (isUrl) {
        // Fetch image from Firebase Storage URL
        console.log('[Clarity-TG] Fetching image from URL...');
        const response = await fetch(imageUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.status}`);
        }
        blob = await response.blob();
        console.log('[Clarity-TG] Image fetched, size:', blob.size, 'bytes');
      } else {
        // Convert base64 to blob
        console.log('[Clarity-TG] Converting base64 to blob...');
        blob = base64ToBlob(imageUrl);
        console.log('[Clarity-TG] Blob created, size:', blob.size, 'bytes, type:', blob.type);
      }
      
      if (!blob || blob.size === 0) {
        console.log('[Clarity-TG] ❌ Blob is empty or null');
        return { success: false, error: 'Failed to create blob from image data' };
      }
      
      // Determine content type and file extension (supports images AND videos)
      const contentType = blob.type || 'image/jpeg';
      const isVideo = contentType.startsWith('video/');
      let extension = 'jpg';
      if (contentType.includes('png')) extension = 'png';
      else if (contentType.includes('gif')) extension = 'gif';
      else if (contentType.includes('webp')) extension = 'webp';
      else if (contentType.includes('mp4')) extension = 'mp4';
      else if (contentType.includes('webm')) extension = 'webm';
      else if (contentType.includes('quicktime') || contentType.includes('mov')) extension = 'mov';
      
      // Create file from blob with appropriate name
      const filePrefix = isVideo ? 'video' : 'image';
      const file = new File([blob], `${filePrefix}.${extension}`, { type: contentType });
      console.log(`[Clarity-TG] ${isVideo ? '🎬 Video' : '📸 Image'} file created:`, file.name, 'size:', file.size, 'type:', file.type);
      
      // Method 1: Try using file input (attachment button) with caption
      console.log('[Clarity-TG] 🔄 Trying method 1: File input...');
      const fileInputResult = await tryFileInput(file, caption);
      console.log('[Clarity-TG] Method 1 result:', fileInputResult);
      if (fileInputResult.success) {
        return fileInputResult;
      }
      
      // Method 2: Try clipboard paste with caption
      console.log('[Clarity-TG] 🔄 Trying method 2: Clipboard paste...');
      const clipboardResult = await tryClipboardPaste(blob, caption);
      console.log('[Clarity-TG] Method 2 result:', clipboardResult);
      if (clipboardResult.success) {
        return clipboardResult;
      }
      
      // Method 3: Try drag and drop simulation with caption
      console.log('[Clarity-TG] 🔄 Trying method 3: Drag and drop...');
      const dragDropResult = await tryDragAndDrop(file, caption);
      console.log('[Clarity-TG] Method 3 result:', dragDropResult);
      if (dragDropResult.success) {
        return dragDropResult;
      }
      
      console.log('[Clarity-TG] ❌ All image send methods failed');
      return { success: false, error: 'All image send methods failed' };
      
    } catch (error) {
      console.error('[Clarity-TG] ❌ Error sending image:', error);
      return { success: false, error: error.message };
    }
  }
  
  // Convert base64 to Blob
  function base64ToBlob(base64) {
    const parts = base64.split(';base64,');
    const contentType = parts[0]?.split(':')[1] || 'image/jpeg';
    const raw = atob(parts[1] || parts[0]);
    const rawLength = raw.length;
    const uInt8Array = new Uint8Array(rawLength);
    
    for (let i = 0; i < rawLength; ++i) {
      uInt8Array[i] = raw.charCodeAt(i);
    }
    
    return new Blob([uInt8Array], { type: contentType });
  }
  
  // Try method 1: File input (attachment button)
  async function tryFileInput(file, caption = '') {
    console.log('[Clarity-TG] Trying file input method...');
    
    // Find attachment button
    const attachmentSelectors = [
      '.btn-attach',
      'button[class*="attach"]',
      '.attachment-button',
      '.composer-attach-button',
      '[class*="AttachMenu"]'
    ];
    
    let attachBtn = null;
    for (const selector of attachmentSelectors) {
      attachBtn = document.querySelector(selector);
      if (attachBtn) break;
    }
    
    if (!attachBtn) {
      console.log('[Clarity-TG] Attachment button not found');
      return { success: false };
    }
    
    // Click attachment button
    attachBtn.click();
    await sleep(800); // Increased from 500ms to 800ms for menu to appear
    
    // Look for file input
    const fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) {
      console.log('[Clarity-TG] File input not found after clicking attach');
      return { success: false };
    }
    
    // Create DataTransfer and set files
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    fileInput.files = dataTransfer.files;
    
    // Dispatch change event
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    
    // CRITICAL: Wait longer for image to upload/process before modal is ready
    console.log('[Clarity-TG] ⏳ Waiting for image to upload/process...');
    await sleep(3000); // Increased from 1000ms to 3000ms for image upload
    
    // If caption provided, type it in the caption input
    if (caption) {
      await typeCaptionInModal(caption);
      await sleep(500); // Extra wait after caption
    }
    
    // Look for send button in media preview dialog
    console.log('[Clarity-TG] 🔍 Looking for send button...');
    const sendBtn = findSendButton();
    if (sendBtn) {
      console.log('[Clarity-TG] 📤 Clicking send button...');
      sendBtn.click();
      await sleep(1500); // Increased from 500ms to 1500ms for send to complete
      console.log('[Clarity-TG] ✅ Image sent via file input' + (caption ? ' with caption!' : '!'));
      return { success: true, method: 'file_input', hasCaption: !!caption };
    }
    
    // Try pressing Enter
    const confirmBtn = document.querySelector('.popup-send-button, .btn-confirm, button[class*="confirm"]');
    if (confirmBtn) {
      console.log('[Clarity-TG] 📤 Clicking confirm button...');
      confirmBtn.click();
      await sleep(1500); // Increased from 500ms to 1500ms for send to complete
      console.log('[Clarity-TG] ✅ Image sent via file input (confirm button)' + (caption ? ' with caption!' : '!'));
      return { success: true, method: 'file_input_confirm', hasCaption: !!caption };
    }
    
    return { success: false };
  }
  
  // Helper: Type caption in the media send modal
  async function typeCaptionInModal(caption) {
    if (!caption || !caption.trim()) return false;
    
    console.log('[Clarity-TG] Looking for caption input in modal...');
    
    // Wait a bit for the modal to fully load
    await sleep(500);
    
    // Selectors for caption input in Telegram Web media modal
    const captionSelectors = [
      '.popup-input-container [contenteditable="true"]',
      '.popup-input [contenteditable="true"]',
      '.popup-send-photo-input',
      '.popup-container [contenteditable="true"]',
      '.modal [contenteditable="true"]',
      '.popup-input-container .input-message-input',
      '[class*="caption"] [contenteditable="true"]',
      '.SendMessage .input-message-input',
      '.ComposerInput [contenteditable="true"]'
    ];
    
    let captionInput = null;
    for (const selector of captionSelectors) {
      captionInput = document.querySelector(selector);
      if (captionInput) {
        console.log('[Clarity-TG] Found caption input with:', selector);
        break;
      }
    }
    
    if (!captionInput) {
      console.log('[Clarity-TG] Caption input not found in modal, will send as follow-up');
      return false;
    }
    
    try {
      // Focus the caption input
      captionInput.focus();
      await sleep(100);
      
      // Clear any existing content
      if (captionInput.textContent !== undefined) {
        captionInput.textContent = '';
      }
      captionInput.dispatchEvent(new Event('input', { bubbles: true }));
      
      // Type the caption (faster than regular typing for captions)
      await typeCaptionFast(captionInput, caption);
      await sleep(200);
      
      console.log('[Clarity-TG] ✅ Caption typed in modal:', caption.slice(0, 30) + '...');
      return true;
      
    } catch (error) {
      console.log('[Clarity-TG] Error typing caption:', error.message);
      return false;
    }
  }
  
  // Type caption quickly (shorter delay than regular messages)
  async function typeCaptionFast(input, text) {
    let currentText = '';
    
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      currentText += char;
      
      if (input.textContent !== undefined) {
        input.textContent = currentText;
      } else if (input.value !== undefined) {
        input.value = currentText;
      } else {
        input.innerHTML = currentText;
      }
      
      input.dispatchEvent(new Event('input', { bubbles: true }));
      
      // Faster typing for captions (30-60ms per char)
      const delay = 30 + Math.random() * 30;
      await sleep(delay);
    }
    
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  
  // Try method 2: Clipboard paste
  async function tryClipboardPaste(blob, caption = '') {
    console.log('[Clarity-TG] Trying clipboard paste method...');
    
    const input = findChatInput();
    if (!input) {
      return { success: false };
    }
    
    try {
      // Focus the input
      input.focus();
      await sleep(300); // Increased from 200ms
      
      // Create clipboard item
      const clipboardItem = new ClipboardItem({
        'image/png': blob
      });
      
      // Write to clipboard
      await navigator.clipboard.write([clipboardItem]);
      console.log('[Clarity-TG] Image copied to clipboard');
      
      await sleep(300); // Increased from 200ms
      
      // Simulate paste event
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: new DataTransfer()
      });
      
      // Add the blob to the clipboard data
      pasteEvent.clipboardData.items.add(new File([blob], 'image.png', { type: 'image/png' }));
      
      input.dispatchEvent(pasteEvent);
      
      // Wait longer for image to upload/process
      console.log('[Clarity-TG] ⏳ Waiting for clipboard image to process...');
      await sleep(3000); // Increased from 1000ms to 3000ms
      
      // Check if image preview appeared and click send
      const sendBtn = findSendButton();
      if (sendBtn) {
        console.log('[Clarity-TG] 📤 Clicking send button...');
        sendBtn.click();
        await sleep(1500); // Increased from 500ms to 1500ms
        console.log('[Clarity-TG] ✅ Image sent via clipboard paste!');
        return { success: true, method: 'clipboard_paste' };
      }
      
    } catch (error) {
      console.log('[Clarity-TG] Clipboard method failed:', error.message);
    }
    
    return { success: false };
  }
  
  // Try method 3: Drag and drop simulation
  async function tryDragAndDrop(file) {
    console.log('[Clarity-TG] Trying drag and drop method...');
    
    const input = findChatInput();
    const chatArea = document.querySelector('.bubbles, .messages-container, .chat-input');
    const target = chatArea || input;
    
    if (!target) {
      return { success: false };
    }
    
    try {
      // Create DataTransfer with file
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      
      // Dispatch dragenter
      const dragEnterEvent = new DragEvent('dragenter', {
        bubbles: true,
        cancelable: true,
        dataTransfer
      });
      target.dispatchEvent(dragEnterEvent);
      await sleep(150); // Increased from 100ms
      
      // Dispatch dragover
      const dragOverEvent = new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer
      });
      target.dispatchEvent(dragOverEvent);
      await sleep(150); // Increased from 100ms
      
      // Dispatch drop
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer
      });
      target.dispatchEvent(dropEvent);
      
      // Wait longer for image to upload/process
      console.log('[Clarity-TG] ⏳ Waiting for dropped image to process...');
      await sleep(3000); // Increased from 1000ms to 3000ms
      
      // Check if upload started and send
      const sendBtn = findSendButton();
      if (sendBtn) {
        console.log('[Clarity-TG] 📤 Clicking send button...');
        sendBtn.click();
        await sleep(1500); // Increased from 500ms to 1500ms
        console.log('[Clarity-TG] ✅ Image sent via drag and drop!');
        return { success: true, method: 'drag_drop' };
      }
      
    } catch (error) {
      console.log('[Clarity-TG] Drag and drop method failed:', error.message);
    }
    
    return { success: false };
  }
  
  async function typeRealistic(input, text) {
    let currentText = '';
    
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      currentText += char;
      
      // Telegram uses contenteditable div
      if (input.textContent !== undefined) {
        input.textContent = currentText;
      } else if (input.value !== undefined) {
        input.value = currentText;
      } else {
        input.innerHTML = currentText;
      }
      
      input.dispatchEvent(new Event('input', { bubbles: true }));
      
      let delay = TYPING_SPEED.baseDelay + (Math.random() * TYPING_SPEED.variation * 2 - TYPING_SPEED.variation);
      
      if (['.', ',', '!', '?', ';', ':'].includes(char)) {
        delay += TYPING_SPEED.pauseAfterPunctuation;
      } else if (char === ' ') {
        delay += TYPING_SPEED.pauseAfterWord;
      }
      
      await sleep(delay);
    }
    
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  
  function findChatInput() {
    const selectors = [
      '#editable-message-text',
      '.input-message-input',
      '[contenteditable="true"].input-message-input',
      '.composer-input',
      '[data-peer-id] [contenteditable="true"]',
      '.chat-input [contenteditable="true"]'
    ];
    
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }
  
  function findSendButton() {
    const selectors = [
      '.btn-send',
      '.send-btn',
      '.button-send',
      'button[class*="send"]',
      '.btn-icon.send',
      '.composer-send-button'
    ];
    
    for (const selector of selectors) {
      const btn = document.querySelector(selector);
      if (btn && !btn.disabled) return btn;
    }
    return null;
  }
  
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  // ============================================================
  // MESSAGE EXTRACTION
  // ============================================================
  
  function extractAllMessages() {
    console.log('[Clarity-TG] extractAllMessages called');
    
    // Try multiple container selectors for Telegram Web A
    const containerSelectors = [
      '.bubbles',
      '.bubbles-inner',
      '#column-center .bubbles',
      '.messages-container',
      '[class*="MessageList"]',
      '.chat-content',
      '.Transition_slide-active .bubbles'
    ];
    
    let container = null;
    for (const selector of containerSelectors) {
      container = document.querySelector(selector);
      if (container) {
        console.log('[Clarity-TG] Found container with selector:', selector);
        break;
      }
    }
    
    if (!container) {
      console.log('[Clarity-TG] No chat container found. Trying document.body');
      container = document.body;
    }
    
    const result = [];
    
    // Try multiple bubble selectors for Telegram Web A
    const bubbleSelectors = [
      '.Message.message-list-item',
      '.Message',
      '[data-message-id]',
      '.message-list-item',
      '.bubble',
      '.message'
    ];
    
    let bubbles = [];
    for (const selector of bubbleSelectors) {
      bubbles = container.querySelectorAll(selector);
      if (bubbles.length > 0) {
        console.log('[Clarity-TG] Found', bubbles.length, 'messages with selector:', selector);
        break;
      }
    }
    
    if (bubbles.length === 0) {
      console.log('[Clarity-TG] No messages found with any selector. DOM structure:', container.innerHTML.substring(0, 500));
    }
    
    bubbles.forEach((el, index) => {
      const data = extractMessageData(el, index);
      if (data?.text) {
        result.push(data);
      }
    });
    
    console.log('[Clarity-TG] Extracted', result.length, 'messages');
    return result;
  }
  
  function extractMessageData(el, index) {
    // Determine if message is from us (outgoing)
    // Telegram Web uses 'own' class or data attribute
    const isFromMe = el.classList.contains('own') || 
                     el.classList.contains('is-out') || 
                     el.classList.contains('outgoing') ||
                     el.getAttribute('data-is-own') === 'true' ||
                     el.closest('.own') !== null;
    
    // Get message ID if available
    const messageId = el.getAttribute('data-message-id') ||
                      el.getAttribute('data-mid') || 
                      el.id?.replace('message-', '') ||
                      el.dataset.messageId ||
                      null;
    
    // Extract time FIRST (before we modify elements)
    const timeEl = el.querySelector('.MessageMeta .time, .message-time, .time, .time-inner, time, .message-meta');
    const datetime = timeEl?.getAttribute('datetime') || '';
    const timeDisplay = timeEl?.innerText || timeEl?.textContent || '';
    
    // Detect media types FIRST
    let mediaType = null;
    let mediaUrl = null;
    
    // =============================================
    // CHECK STICKERS/EMOJIS FIRST (before images!)
    // Stickers often contain img elements, so check these first
    // =============================================
    
    // Check for Telegram stickers (animated .tgs or static webp)
    const stickerEl = el.querySelector('.Sticker, .sticker, [class*="sticker"], tgs-player, .AnimatedSticker, .media-sticker');
    // Also check for sticker wrappers that might contain the sticker
    const stickerWrapper = el.querySelector('[class*="sticker-wrapper"], .sticker-container');
    // Animated stickers use canvas or Lottie
    const animatedSticker = el.querySelector('canvas[class*="sticker"], .lottie-sticker');
    
    if (stickerEl || stickerWrapper || animatedSticker) {
      mediaType = 'sticker';
    }
    
    // Check for emoji-only messages (large emoji, custom emoji)
    const customEmoji = el.querySelector('.custom-emoji, [class*="CustomEmoji"], .emoji-big, .animated-emoji');
    // Check if message is ONLY emoji (no other text content)
    const textContent = el.querySelector('.text-content, .message-content');
    const textOnly = textContent?.innerText?.trim() || '';
    // Regex to detect if text is ONLY emojis (standard Unicode emojis)
    const emojiOnlyRegex = /^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{200D}\s]+$/u;
    const isEmojiOnly = textOnly && emojiOnlyRegex.test(textOnly) && textOnly.length <= 8;
    
    if ((customEmoji || isEmojiOnly) && !mediaType) {
      mediaType = 'emoji';
    }
    
    // =============================================
    // NOW check for images/photos (but NOT if already detected as sticker/emoji)
    // =============================================
    if (!mediaType) {
      const photoEl = el.querySelector('.media-photo, .Photo, img.photo, .media-inner img:not([class*="sticker"]), .thumbnail img:not([class*="sticker"]), .media-container img:not([class*="sticker"])');
      // Make sure it's not inside a sticker container
      const isInsideSticker = photoEl?.closest('.Sticker, .sticker, [class*="sticker"]');
      if (photoEl && !isInsideSticker) {
        mediaType = 'image';
        mediaUrl = photoEl.src || photoEl.getAttribute('data-src');
      }
    }
    
    // Check for videos
    const videoEl = el.querySelector('.media-video, video, .Video, .media-inner video');
    if (videoEl && !mediaType) {
      mediaType = 'video';
      mediaUrl = videoEl.src || videoEl.querySelector('source')?.src;
    }
    
    // Check for documents/files
    const documentEl = el.querySelector('.Document, .document, .File, .file, [class*="document"]');
    if (documentEl && !mediaType) {
      mediaType = 'document';
    }
    
    // Check for voice messages
    const voiceEl = el.querySelector('.Audio.is-voice, .voice-message, [class*="voice"]');
    if (voiceEl && !mediaType) {
      mediaType = 'voice';
    }
    
    // Check for audio
    const audioEl = el.querySelector('.Audio:not(.is-voice), .audio, [class*="audio"]');
    if (audioEl && !mediaType) {
      mediaType = 'audio';
    }
    
    // Check for GIFs
    const gifEl = el.querySelector('.AnimatedSticker, .GifVideo, [class*="gif"]');
    if (gifEl && !mediaType) {
      mediaType = 'gif';
    }
    
    // Check for media containers (generic)
    const mediaContainer = el.querySelector('.media-container, .media-inner, .media-wrapper, .Media, [class*="media"]');
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
    
    // Elements to remove to get clean text (timestamps, metadata, etc.)
    const elementsToRemove = [
      'time', 
      '.time', 
      '.time-inner',
      '.MessageMeta', 
      '.message-meta', 
      '.message-time',
      '.status', 
      '.reactions', 
      '.reply-wrapper', 
      '.document', 
      '.media-container', 
      '.sticker', 
      '.quick-reaction', 
      '.avatar', 
      '.message-select-control',
      '.bottom-marker',
      '.message-date',
      '.date',
      '.duration',
      '.video-duration',
      '.media-duration',
      '[class*="duration"]',
      '.VideoPlayer',
      '.media-inner',
      '.media-photo',
      '.media-video',
      '.thumbnail'
    ];
    
    // Extract text - Telegram uses various nested elements
    let text = '';
    
    // Try different selectors for message text (updated for Telegram Web)
    const textSelectors = [
      '.text-content',
      '.message-content-wrapper .text-content',
      '.message-content',
      '.text',
      '.translatable-message',
      '[data-entity-type]',
      '.raw-text'
    ];
    
    for (const selector of textSelectors) {
      const textEl = el.querySelector(selector);
      if (textEl) {
        // IMPORTANT: Clone and remove time/meta elements before extracting text
        const clone = textEl.cloneNode(true);
        clone.querySelectorAll(elementsToRemove.join(', ')).forEach(e => e.remove());
        text = clone.innerText || clone.textContent || '';
        if (text.trim()) {
          break;
        }
      }
    }
    
    // If no text found in selectors, try the message-content-wrapper
    if (!text.trim()) {
      const contentWrapper = el.querySelector('.message-content-wrapper');
      if (contentWrapper) {
        // Clone and remove non-text elements
        const clone = contentWrapper.cloneNode(true);
        clone.querySelectorAll(elementsToRemove.join(', ')).forEach(e => e.remove());
        text = clone.innerText || clone.textContent || '';
      }
    }
    
    // Last resort: try the element itself
    if (!text.trim()) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll(elementsToRemove.join(', ')).forEach(e => e.remove());
      text = clone.innerText || clone.textContent || '';
    }
    
    text = text?.trim() || '';
    
    // Check if text is just a video duration (e.g., "0:11", "1:23", "0:11s")
    // If so, treat it as a video with no text
    if (text && /^\d{1,2}:\d{2}s?$/.test(text)) {
      // This looks like a duration, not actual text
      if (!mediaType) {
        mediaType = 'video'; // Assume it's a video if we have duration
      }
      text = ''; // Clear the duration text
    }
    
    // If no text but has media, use placeholder
    if (!text && mediaType) {
      switch (mediaType) {
        case 'image':
          text = '[📷 Image]';
          break;
        case 'video':
          text = '[🎬 Video]';
          break;
        case 'sticker':
          text = '[🎭 Sticker]';
          break;
        case 'emoji':
          text = '[😊 Emoji]';
          break;
        case 'document':
          text = '[📎 Document]';
          break;
        case 'voice':
          text = '[🎤 Voice Message]';
          break;
        case 'audio':
          text = '[🎵 Audio]';
          break;
        case 'gif':
          text = '[🎞️ GIF]';
          break;
        default:
          text = '[📎 Media]';
      }
    }
    
    // Skip if still no content
    if (!text) return null;
    
    return {
      id: messageId,
      text,
      isFromMe,
      time: timeDisplay.trim(),
      datetime: datetime,
      order: index,
      platform: 'telegram',
      mediaType: mediaType,       // 'image', 'video', 'sticker', 'document', 'voice', 'audio', 'gif', 'media', or null
      mediaUrl: mediaUrl          // URL if available
    };
  }
  
  // ============================================================
  // HELPERS
  // ============================================================
  
  function isInChat() {
    const url = window.location.href;
    const hash = window.location.hash;
    
    // Telegram Web A uses hash routing: #@username or #-123456789
    const hasChat = hash && (hash.startsWith('#@') || hash.startsWith('#-') || /^#\d+/.test(hash));
    const hasChatContainer = !!document.querySelector(SELECTORS.chatContainer);
    
    return hasChat || hasChatContainer;
  }
  
  function getChatIdFromUrl() {
    const hash = window.location.hash;
    
    // #@username format
    if (hash.startsWith('#@')) {
      return hash.substring(2); // Remove #@
    }
    
    // #-123456789 format (group/channel)
    if (hash.startsWith('#-')) {
      return hash.substring(1); // Keep the minus sign
    }
    
    // #123456789 format (user ID)
    const match = hash.match(/^#(\d+)/);
    if (match) {
      return match[1];
    }
    
    return null;
  }
  
  function getChatInfo() {
    const chatId = getChatIdFromUrl();
    
    // Try to get username/name from header
    let username = null;
    let displayName = null;
    
    const headerSelectors = [
      '.peer-title',
      '.chat-info .title',
      '.top .info .title',
      '.chat-title'
    ];
    
    for (const selector of headerSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        displayName = el.innerText || el.textContent;
        break;
      }
    }
    
    // If chatId starts with @, it's a username
    if (chatId && !chatId.startsWith('-') && isNaN(chatId)) {
      username = chatId;
    }
    
    return {
      chatId,
      username,
      displayName,
      platform: 'telegram'
    };
  }
  
  // ============================================================
  // CHECK LAST MESSAGE SENDER - For image reply detection
  // ============================================================
  
  function checkLastMessageSender() {
    try {
      // Find all messages in the current chat
      const containerSelectors = [
        '.bubbles',
        '.bubbles-inner',
        '#column-center .bubbles',
        '.messages-container'
      ];
      
      let container = null;
      for (const selector of containerSelectors) {
        container = document.querySelector(selector);
        if (container) break;
      }
      
      if (!container) {
        console.log('[Clarity-TG] checkLastMessageSender: No container found');
        return { success: false, error: 'No chat container found' };
      }
      
      // Get all message bubbles
      const bubbleSelectors = [
        '.Message.message-list-item',
        '.Message',
        '[data-message-id]',
        '.bubble',
        '.message'
      ];
      
      let bubbles = [];
      for (const selector of bubbleSelectors) {
        bubbles = Array.from(container.querySelectorAll(selector));
        if (bubbles.length > 0) break;
      }
      
      if (bubbles.length === 0) {
        console.log('[Clarity-TG] checkLastMessageSender: No messages found');
        return { success: false, error: 'No messages found' };
      }
      
      // Get the LAST message (most recent)
      const lastBubble = bubbles[bubbles.length - 1];
      
      // Check if it's ours (outgoing)
      const isFromMe = lastBubble.classList.contains('own') || 
                       lastBubble.classList.contains('is-out') || 
                       lastBubble.classList.contains('outgoing') ||
                       lastBubble.getAttribute('data-is-own') === 'true' ||
                       lastBubble.closest('.own') !== null;
      
      // Try to get a preview of the message content
      let preview = '';
      
      // Check for text content
      const textEl = lastBubble.querySelector('.text-content, .message-content, .text');
      if (textEl) {
        preview = textEl.innerText?.trim()?.slice(0, 50) || '';
      }
      
      // Check for media (image)
      const hasImage = lastBubble.querySelector('.media-photo, .Photo, img.photo, .media-inner img');
      const hasVideo = lastBubble.querySelector('.media-video, video, .Video');
      const hasSticker = lastBubble.querySelector('.Sticker, .sticker');
      
      if (!preview) {
        if (hasImage) preview = '[📷 Image]';
        else if (hasVideo) preview = '[🎬 Video]';
        else if (hasSticker) preview = '[🎭 Sticker]';
        else preview = '[📎 Media]';
      }
      
      console.log('[Clarity-TG] checkLastMessageSender:', {
        isFromMe,
        preview: preview.slice(0, 30),
        hasImage: !!hasImage,
        totalMessages: bubbles.length
      });
      
      return {
        success: true,
        lastMessageIsOurs: isFromMe,
        lastSender: isFromMe ? 'me' : 'them',
        lastMessagePreview: preview,
        hasImage: !!hasImage,
        hasVideo: !!hasVideo,
        totalMessages: bubbles.length
      };
      
    } catch (error) {
      console.error('[Clarity-TG] checkLastMessageSender error:', error);
      return { success: false, error: error.message };
    }
  }
  
  // ============================================================
  // START
  // ============================================================
  
  init();
})();
