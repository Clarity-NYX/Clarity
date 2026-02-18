// Clarity Notes - Telegram Chat List Monitor
// Monitors the chat list for unread messages across ALL chats
// For web.telegram.org/a/

(function() {
  'use strict';
  
  // ============================================================
  // CONFIGURATION
  // ============================================================
  
  const CONFIG = {
    SCAN_INTERVAL: 5000,       // Scan chat list every 5 seconds
    DEBOUNCE_MS: 500,          // Debounce rapid changes
    MAX_CHATS_TO_TRACK: 100,   // Maximum chats to track
    DEBUG: true
  };
  
  // ============================================================
  // STATE
  // ============================================================
  
  let isMonitoring = false;
  let scanInterval = null;
  let lastScanResult = new Map(); // chatId -> { unreadCount, lastPreview, timestamp }
  let debounceTimer = null;
  
  // ============================================================
  // SELECTORS - Telegram Web A Chat List
  // ============================================================
  
  const SELECTORS = {
    // Chat list container - Telegram Web A/K uses different selectors
    chatList: '#LeftColumn-main .chat-list, .chat-list, .Transition_slide-active .chat-list, .ChatList, #column-left .chat-list, .tabs-container .chat-list',
    
    // Individual chat items in the list
    chatItem: '.ListItem.chat-item-clickable, [data-peer-id], .chat-item, .Chat, .ListItem[class*="chat"]',
    
    // Unread badge (shows number of unread messages) - UPDATED with specific Telegram classes
    unreadBadge: '.zGiYriqE.chat-badge-transition.shown.open, .Badge, .badge, [class*="Badge"], [class*="unread-count"], .unread-counter',
    
    // Unread count number inside badge
    unreadCount: '.tgKbsVmz, .badge-text, .unread-count',
    
    // Chat name/title
    chatName: '.fullName, .title, .peer-title, h3, .ListItem-title, .name',
    
    // Last message preview
    lastMessage: '.last-message, .subtitle, .ListItem-subtitle, .status, .last-message-text',
    
    // Chat avatar (for identification)
    chatAvatar: '.Avatar, .avatar, [class*="avatar"], .ChatInfo .Avatar, img.avatar',
    
    // Time of last message
    lastTime: '.LastMessageMeta, .time, time, .date, .message-time',
    
    // Online/typing indicators
    onlineIndicator: '.online, .Avatar.online, [class*="online-status"]',
    typingIndicator: '.typing, .Typing, [class*="typing"]'
  };
  
  // ============================================================
  // LOGGING
  // ============================================================
  
  const log = (...args) => {
    if (CONFIG.DEBUG) console.log('[Clarity-TG-Monitor]', ...args);
  };
  
  // ============================================================
  // CHAT LIST SCANNING
  // ============================================================
  
  async function scanChatList(scrollToFind = false) {
    const chatList = document.querySelector(SELECTORS.chatList);
    if (!chatList) {
      log('Chat list not found');
      return [];
    }
    
    // If scrollToFind is true, scroll through entire list to find all chats
    if (scrollToFind) {
      return await scanAllChatsWithScroll(chatList);
    }
    
    // Otherwise just scan visible items (for quick checks)
    return scanVisibleChats(chatList);
  }
  
  function scanVisibleChats(chatList) {
    const chatItems = chatList.querySelectorAll(SELECTORS.chatItem);
    const chats = [];
    
    // Debug: Log first chat's HTML to see unread badge structure
    if (chatItems.length > 0 && CONFIG.DEBUG) {
      const firstItem = chatItems[0];
      // Find any element that might be an unread indicator
      const possibleBadges = firstItem.querySelectorAll('span, div');
      possibleBadges.forEach(el => {
        const text = el.textContent?.trim();
        if (text && /^\d+$/.test(text) && parseInt(text) < 1000) {
          log('Found numeric element:', el.className, '=', text);
        }
      });
    }
    
    chatItems.forEach((item, index) => {
      if (index >= CONFIG.MAX_CHATS_TO_TRACK) return;
      
      const chatData = extractChatData(item);
      if (chatData) {
        chats.push(chatData);
      }
    });
    
    log(`Scanned ${chats.length} visible chats, ${chats.filter(c => c.unreadCount > 0).length} with unreads`);
    return chats;
  }
  
  // ============================================================
  // SCROLL TO TOP AND SCAN - Priority scan for new messages
  // ============================================================
  
  // Quick scan from top to find chats with unreads (called after sending)
  async function scrollToTopAndScanUnreads() {
    log('⬆️ SCROLL TO TOP: Checking for new unreads at top of list...');
    
    const chatList = document.querySelector(SELECTORS.chatList);
    if (!chatList) {
      log('Chat list not found');
      return [];
    }
    
    // Find scroll container
    let scrollContainer = null;
    const possibleContainers = [
      chatList.parentElement?.parentElement,
      chatList.parentElement,
      chatList,
      document.querySelector('#LeftColumn-main'),
      document.querySelector('#LeftColumn .tabs-tab.active'),
      document.querySelector('.Transition_slide-active')
    ];
    
    for (const container of possibleContainers) {
      if (container && container.scrollHeight > container.clientHeight) {
        const style = window.getComputedStyle(container);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          scrollContainer = container;
          break;
        }
      }
    }
    
    if (!scrollContainer) {
      scrollContainer = chatList.parentElement || chatList;
    }
    
    // SCROLL TO TOP
    scrollContainer.scrollTop = 0;
    await new Promise(r => setTimeout(r, 500));
    
    // Scan visible chats at top (these are the newest/most recent)
    const visibleItems = chatList.querySelectorAll(SELECTORS.chatItem);
    const unreadsAtTop = [];
    
    visibleItems.forEach((item, index) => {
      const chatData = extractChatData(item);
      if (chatData) {
        // Add list position - lower = higher in list = newer
        chatData.listPosition = index;
        
        if (chatData.unreadCount > 0) {
          unreadsAtTop.push(chatData);
          log(`📬 Found unread at TOP position ${index}: "${chatData.name}" (${chatData.unreadCount} messages)`);
        }
      }
    });
    
    // Report unreads found at top (these should be processed first)
    if (unreadsAtTop.length > 0) {
      log(`✅ Found ${unreadsAtTop.length} unreads at TOP of list - should be prioritized`);
      
      chrome.runtime.sendMessage({
        type: 'AUTOCHAT_UNREADS_AT_TOP',
        data: {
          chats: unreadsAtTop,
          timestamp: Date.now()
        }
      }).catch(() => {});
    }
    
    return unreadsAtTop;
  }
  
  async function scanAllChatsWithScroll(chatList, searchUntilUnreads = true) {
    log('🔍 Starting ENHANCED full chat list scan with scrolling...');
    
    const allChats = new Map();
    let foundUnreadsCount = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = 100; // Reasonable number of attempts
    
    // Better scroll container detection
    let scrollContainer = null;
    const possibleContainers = [
      chatList.parentElement?.parentElement, // Check grandparent first
      chatList.parentElement,
      chatList,
      document.querySelector('#LeftColumn-main'),
      document.querySelector('#LeftColumn .tabs-tab.active'),
      document.querySelector('.Transition_slide-active'),
      document.querySelector('[class*="column-left"]'),
      document.querySelector('.chat-folders-tabs + div') // Container after tabs
    ];
    
    // Find the actual scrollable container
    for (const container of possibleContainers) {
      if (container && container.scrollHeight > container.clientHeight) {
        const style = window.getComputedStyle(container);
        const overflowY = style.overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') {
          scrollContainer = container;
          log('✅ Found scroll container:', container.className || container.id || container.tagName);
          break;
        }
      }
    }
    
    if (!scrollContainer) {
      log('⚠️ No scrollable container found, using chatList parent');
      scrollContainer = chatList.parentElement || chatList;
    }
    
    log('📏 Container dimensions:', {
      scrollHeight: scrollContainer.scrollHeight,
      clientHeight: scrollContainer.clientHeight,
      scrollable: scrollContainer.scrollHeight > scrollContainer.clientHeight
    });
    
    // Reset to top
    scrollContainer.scrollTop = 0;
    await new Promise(r => setTimeout(r, 800)); // Wait for position reset
    
    let lastItemCount = 0;
    let stableCountAttempts = 0;
    let previousScrollTop = -1;
    
    while (scrollAttempts < maxScrollAttempts) {
      // Get current visible items
      const visibleItems = chatList.querySelectorAll(SELECTORS.chatItem);
      const currentItemCount = visibleItems.length;
      
      log(`📜 Attempt ${scrollAttempts + 1}: ${currentItemCount} items visible`);
      
      // Process new items
      let newItemsFound = false;
      visibleItems.forEach(item => {
        const chatData = extractChatData(item);
        if (chatData && !allChats.has(chatData.chatId)) {
          allChats.set(chatData.chatId, chatData);
          newItemsFound = true;
          
          if (chatData.unreadCount > 0) {
            foundUnreadsCount++;
            log(`💬 Found unread: "${chatData.name}" (${chatData.unreadCount} messages)`);
          }
        }
      });
      
      // Check multiple stop conditions
      const currentScrollTop = scrollContainer.scrollTop;
      const scrollHeight = scrollContainer.scrollHeight;
      const maxScroll = scrollHeight - scrollContainer.clientHeight;
      const isAtBottom = currentScrollTop >= (maxScroll - 5);
      const scrollNotMoving = currentScrollTop === previousScrollTop && currentScrollTop > 0;
      
      // Track stable item count
      if (currentItemCount === lastItemCount) {
        stableCountAttempts++;
      } else {
        stableCountAttempts = 0;
      }
      
      // Stop conditions
      if (isAtBottom) {
        log('✅ Reached absolute bottom of chat list');
        break;
      }
      
      if (scrollNotMoving && !newItemsFound) {
        log('⚠️ Scroll not moving and no new items - likely at end');
        break;
      }
      
      if (stableCountAttempts >= 5) {
        log('⚠️ Item count stable for 5 attempts - likely all loaded');
        break;
      }
      
      // Update tracking
      lastItemCount = currentItemCount;
      previousScrollTop = currentScrollTop;
      
    // More gentle scrolling
    const scrollIncrement = Math.min(
      scrollContainer.clientHeight * 0.4, // 40% of viewport
      300 // Max 300px at a time
    );
    
    const targetScroll = Math.min(currentScrollTop + scrollIncrement, maxScroll);
    
    // Method 1: Direct scrollTop
    scrollContainer.scrollTop = targetScroll;
    
    // Method 2: scrollTo for better browser support
    if (scrollContainer.scrollTo) {
      scrollContainer.scrollTo({
        top: targetScroll,
        behavior: 'instant'
      });
    }
    
    // Method 3: Try scrolling the last visible item into view
    // This can trigger lazy loading in some implementations
    if (visibleItems.length > 0) {
      const lastItem = visibleItems[visibleItems.length - 1];
      lastItem.scrollIntoView({ behavior: 'instant', block: 'end' });
    }
    
    // Method 4: Simulate wheel event for more natural scrolling
    // This can help trigger lazy loading on some implementations
    const wheelEvent = new WheelEvent('wheel', {
      deltaY: scrollIncrement,
      bubbles: true,
      cancelable: true,
      view: window
    });
    scrollContainer.dispatchEvent(wheelEvent);
      
      log(`⬇️ Scrolled to ${targetScroll}/${maxScroll} (${Math.round(targetScroll/maxScroll*100)}%)`);
      
      // Dynamic wait time based on whether we found new items
      const waitTime = newItemsFound ? 700 : 400;
      await new Promise(r => setTimeout(r, waitTime));
      
      scrollAttempts++;
      
      // Early exit if we've found many unreads and scrolled a lot
      if (foundUnreadsCount >= 20 && scrollAttempts > 50) {
        log('🎯 Found 20+ unreads after significant scrolling - stopping');
        break;
      }
    }
    
    // Return to top if we found unreads
    if (foundUnreadsCount > 0) {
      log('🔝 Returning to top to show unread chats');
      scrollContainer.scrollTop = 0;
      await new Promise(r => setTimeout(r, 500));
    }
    
    const chatsArray = Array.from(allChats.values());
    log(`✅ SCAN COMPLETE: ${chatsArray.length} total chats, ${foundUnreadsCount} with unreads`);
    log(`📊 Scroll stats: ${scrollAttempts} attempts, reached ${Math.round((previousScrollTop/(scrollContainer.scrollHeight-scrollContainer.clientHeight))*100)}% depth`);
    
    return chatsArray;
  }
  
  
  function extractChatData(chatItem) {
    try {
      // Get chat ID from data attribute or href
      let chatId = chatItem.dataset.peerId || 
                   chatItem.dataset.chatId ||
                   chatItem.getAttribute('data-peer-id');
      
      // Try to extract from onclick or href
      if (!chatId) {
        const link = chatItem.querySelector('a[href*="#"]');
        if (link) {
          const hash = link.getAttribute('href');
          const match = hash?.match(/#(-?\d+|@[\w]+)/);
          if (match) chatId = match[1];
        }
      }
      
      // Fallback: use the item's position or generate from name
      if (!chatId) {
        const nameEl = chatItem.querySelector(SELECTORS.chatName);
        const name = nameEl?.textContent?.trim() || '';
        chatId = `name:${name.toLowerCase().replace(/\s+/g, '_')}`;
      }
      
      // Get chat name
      const nameEl = chatItem.querySelector(SELECTORS.chatName);
      const name = nameEl?.textContent?.trim() || 'Unknown';
      
      // Get unread count - Direct badge detection
      let unreadCount = 0;
      
      // Method 1: Find the exact Telegram badge structure
      // .chat-badge-transition.shown.open contains the unread count
      const badgeDiv = chatItem.querySelector('.chat-badge-transition.shown');
      if (badgeDiv) {
        const span = badgeDiv.querySelector('span');
        if (span) {
          const text = span.textContent?.trim();
          if (text && /^\d+$/.test(text)) {
            unreadCount = parseInt(text, 10);
          }
        }
      }
      
      // Get last message preview
      const lastMsgEl = chatItem.querySelector(SELECTORS.lastMessage);
      const lastMessage = lastMsgEl?.textContent?.trim() || '';
      
      // Get last message time
      const timeEl = chatItem.querySelector(SELECTORS.lastTime);
      const lastTime = timeEl?.textContent?.trim() || '';
      
      // Check if online/typing
      const isOnline = !!chatItem.querySelector(SELECTORS.onlineIndicator);
      const isTyping = !!chatItem.querySelector(SELECTORS.typingIndicator);
      
      return {
        chatId: `tg:${chatId}`,
        rawId: chatId,
        name,
        unreadCount,
        lastMessage,
        lastTime,
        isOnline,
        isTyping,
        timestamp: Date.now()
      };
    } catch (error) {
      log('Error extracting chat data:', error);
      return null;
    }
  }
  
  // ============================================================
  // CHANGE DETECTION
  // ============================================================
  
  function detectChanges(newChats) {
    const changes = {
      newUnreads: [],      // Chats that now have unread messages
      clearedUnreads: [],  // Chats that had unreads cleared
      updatedUnreads: [],  // Chats with changed unread count
      newMessages: []      // Any chat with a new message (even if we replied)
    };
    
    const newChatsMap = new Map(newChats.map(c => [c.chatId, c]));
    
    // Check for new/updated unreads
    for (const chat of newChats) {
      const previous = lastScanResult.get(chat.chatId);
      
      if (!previous) {
        // New chat we haven't seen before
        if (chat.unreadCount > 0) {
          changes.newUnreads.push(chat);
        }
      } else {
        // Existing chat - check for changes
        if (chat.unreadCount > 0 && previous.unreadCount === 0) {
          // New unread messages
          changes.newUnreads.push(chat);
        } else if (chat.unreadCount === 0 && previous.unreadCount > 0) {
          // Unreads cleared (we read them)
          changes.clearedUnreads.push(chat);
        } else if (chat.unreadCount !== previous.unreadCount) {
          // Unread count changed
          changes.updatedUnreads.push(chat);
        }
        
        // Check if last message changed (new message received)
        if (chat.lastMessage !== previous.lastMessage) {
          changes.newMessages.push(chat);
        }
      }
    }
    
    // Check for chats that disappeared (unlikely but possible)
    for (const [chatId, previous] of lastScanResult) {
      if (!newChatsMap.has(chatId) && previous.unreadCount > 0) {
        changes.clearedUnreads.push({ chatId, ...previous });
      }
    }
    
    // Update last scan result
    lastScanResult = newChatsMap;
    
    return changes;
  }
  
  // ============================================================
  // REPORT TO BACKGROUND
  // ============================================================
  
  function reportToBackground(chats, changes) {
    // Report full chat list state
    chrome.runtime.sendMessage({
      type: 'AUTOCHAT_CHAT_LIST',
      data: {
        chats: chats,
        timestamp: Date.now(),
        totalUnread: chats.reduce((sum, c) => sum + c.unreadCount, 0),
        chatsWithUnread: chats.filter(c => c.unreadCount > 0).length
      }
    }).catch(() => {});
    
    // Report specific changes (for immediate action)
    if (changes.newUnreads.length > 0) {
      chrome.runtime.sendMessage({
        type: 'AUTOCHAT_NEW_UNREADS',
        data: {
          chats: changes.newUnreads,
          timestamp: Date.now()
        }
      }).catch(() => {});
      
      log('🔔 New unreads:', changes.newUnreads.map(c => `${c.name}: ${c.unreadCount}`));
    }
    
    if (changes.newMessages.length > 0) {
      chrome.runtime.sendMessage({
        type: 'AUTOCHAT_NEW_MESSAGES',
        data: {
          chats: changes.newMessages,
          timestamp: Date.now()
        }
      }).catch(() => {});
    }
  }
  
  // ============================================================
  // MONITORING CONTROL
  // ============================================================
  
  let fullScanCounter = 0;
  const FULL_SCAN_INTERVAL = 6; // Do full scan every 30 seconds (6 x 5 seconds)
  
  function startMonitoring() {
    if (isMonitoring) return;
    
    log('Starting chat list monitoring');
    isMonitoring = true;
    fullScanCounter = 0;
    
    // Initial TOP-FIRST scan
    performTopFirstScan();
    
    // Start interval scanning with TOP-FIRST strategy
    scanInterval = setInterval(async () => {
      await performTopFirstScan();
    }, CONFIG.SCAN_INTERVAL);
    
    // Also watch for DOM changes (immediate detection)
    setupMutationObserver();
  }
  
  // TOP-FIRST SCAN STRATEGY
  // Always check top of list first for new messages before scrolling down
  async function performTopFirstScan() {
    log('🔝 TOP-FIRST SCAN: Checking top of list first...');
    
    const chatList = document.querySelector(SELECTORS.chatList);
    if (!chatList) {
      log('Chat list not found');
      return;
    }
    
    // Find scroll container
    let scrollContainer = findScrollContainer(chatList);
    
    // STEP 1: ALWAYS scroll to top first
    scrollContainer.scrollTop = 0;
    await new Promise(r => setTimeout(r, 400));
    
    // STEP 2: Scan visible chats at top (these are the NEWEST)
    const topChats = scanVisibleChats(chatList);
    const topUnreads = topChats.filter(c => c.unreadCount > 0);
    
    // Add position info (lower = higher in list)
    topChats.forEach((chat, idx) => {
      chat.listPosition = idx;
      chat.fromTopScan = true;
    });
    
    log(`📬 TOP scan: ${topChats.length} visible, ${topUnreads.length} with unreads`);
    
    // STEP 3: If unreads found at top, report IMMEDIATELY with HIGH priority
    if (topUnreads.length > 0) {
      log(`✅ Found ${topUnreads.length} unreads at TOP - reporting with high priority`);
      
      // Report top unreads as high priority
      chrome.runtime.sendMessage({
        type: 'AUTOCHAT_UNREADS_AT_TOP',
        data: {
          chats: topUnreads,
          timestamp: Date.now()
        }
      }).catch(() => {});
      
      // Also report to general list
      const changes = detectChanges(topChats);
      reportToBackground(topChats, changes);
      
      // DON'T scroll down yet - let the system process top chats first
      // Only do full scroll scan periodically
      fullScanCounter++;
      if (fullScanCounter >= FULL_SCAN_INTERVAL * 2) { // Less frequent full scans when unreads at top
        log('Periodic full scan (even with top unreads)...');
        await performDeepScan(chatList, scrollContainer);
        fullScanCounter = 0;
      }
      
      return;
    }
    
    // STEP 4: No unreads at top - scan deeper
    log('No unreads at top - scanning deeper...');
    fullScanCounter++;
    
    if (fullScanCounter >= FULL_SCAN_INTERVAL || fullScanCounter === 1) {
      // Time for a deep scan
      await performDeepScan(chatList, scrollContainer);
      fullScanCounter = 0;
    } else {
      // Just quick visible scan
      const changes = detectChanges(topChats);
      reportToBackground(topChats, changes);
    }
  }
  
  // Find the scrollable container
  function findScrollContainer(chatList) {
    const possibleContainers = [
      chatList.parentElement?.parentElement,
      chatList.parentElement,
      chatList,
      document.querySelector('#LeftColumn-main'),
      document.querySelector('#LeftColumn .tabs-tab.active'),
      document.querySelector('.Transition_slide-active')
    ];
    
    for (const container of possibleContainers) {
      if (container && container.scrollHeight > container.clientHeight) {
        const style = window.getComputedStyle(container);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          return container;
        }
      }
    }
    
    return chatList.parentElement || chatList;
  }
  
  // Deep scan - scrolls through entire list but ALWAYS returns to top
  async function performDeepScan(chatList, scrollContainer) {
    log('🔍 Starting DEEP scan (with return-to-top)...');
    
    const allChats = new Map();
    let scrollAttempts = 0;
    const maxScrollAttempts = 50; // Limit to avoid infinite scrolling
    
    // Start from top
    scrollContainer.scrollTop = 0;
    await new Promise(r => setTimeout(r, 400));
    
    let lastItemCount = 0;
    let stableCount = 0;
    
    // Scan downward
    while (scrollAttempts < maxScrollAttempts) {
      const visibleItems = chatList.querySelectorAll(SELECTORS.chatItem);
      
      // Process visible items
      visibleItems.forEach((item, idx) => {
        const chatData = extractChatData(item);
        if (chatData && !allChats.has(chatData.chatId)) {
          chatData.listPosition = idx + scrollAttempts * 20; // Approximate position
          allChats.set(chatData.chatId, chatData);
        }
      });
      
      // Check if we've reached the bottom
      const currentScroll = scrollContainer.scrollTop;
      const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      
      if (currentScroll >= maxScroll - 10) {
        log('Reached bottom of list');
        break;
      }
      
      // Check for stable item count
      if (visibleItems.length === lastItemCount) {
        stableCount++;
        if (stableCount >= 3) {
          log('Item count stable - likely at end');
          break;
        }
      } else {
        stableCount = 0;
      }
      lastItemCount = visibleItems.length;
      
      // Scroll down
      const scrollIncrement = Math.min(scrollContainer.clientHeight * 0.5, 300);
      scrollContainer.scrollTop = Math.min(currentScroll + scrollIncrement, maxScroll);
      
      await new Promise(r => setTimeout(r, 300));
      scrollAttempts++;
    }
    
    log(`Deep scan found ${allChats.size} total chats`);
    
    // IMPORTANT: Return to top after scanning
    log('🔝 Returning to TOP after deep scan');
    scrollContainer.scrollTop = 0;
    await new Promise(r => setTimeout(r, 300));
    
    // Report all found chats
    const chatsArray = Array.from(allChats.values());
    const changes = detectChanges(chatsArray);
    reportToBackground(chatsArray, changes);
    
    // Check for unreads at top one more time
    const topUnreads = chatsArray.filter(c => c.unreadCount > 0 && c.listPosition < 20);
    if (topUnreads.length > 0) {
      chrome.runtime.sendMessage({
        type: 'AUTOCHAT_UNREADS_AT_TOP',
        data: {
          chats: topUnreads,
          timestamp: Date.now()
        }
      }).catch(() => {});
    }
  }
  
  async function performFullScan() {
    const chatList = document.querySelector(SELECTORS.chatList);
    if (!chatList) return;
    
    const scrollContainer = findScrollContainer(chatList);
    await performDeepScan(chatList, scrollContainer);
  }
  
  function stopMonitoring() {
    if (!isMonitoring) return;
    
    log('Stopping chat list monitoring');
    isMonitoring = false;
    
    if (scanInterval) {
      clearInterval(scanInterval);
      scanInterval = null;
    }
    
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
  }
  
  // ============================================================
  // MUTATION OBSERVER (Immediate Change Detection)
  // ============================================================
  
  let mutationObserver = null;
  
  function setupMutationObserver() {
    const chatList = document.querySelector(SELECTORS.chatList);
    if (!chatList || mutationObserver) return;
    
    mutationObserver = new MutationObserver((mutations) => {
      // Debounce rapid changes
      if (debounceTimer) clearTimeout(debounceTimer);
      
      debounceTimer = setTimeout(() => {
        let shouldScan = false;
        
        for (const mutation of mutations) {
          // Check if unread badges changed
          if (mutation.target.classList?.contains('Badge') ||
              mutation.target.classList?.contains('unread') ||
              mutation.target.closest?.('.Badge, .unread')) {
            shouldScan = true;
            break;
          }
          
          // Check if chat items were added/modified
          if (mutation.addedNodes.length > 0) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE &&
                  (node.classList?.contains('chat-item') ||
                   node.classList?.contains('ListItem') ||
                   node.querySelector?.('.Badge, .unread'))) {
                shouldScan = true;
                break;
              }
            }
          }
          
          if (shouldScan) break;
        }
        
        if (shouldScan) {
          log('DOM change detected, rescanning');
          const newChats = scanVisibleChats(document.querySelector(SELECTORS.chatList) || document.createElement('div'));
          const changes = detectChanges(newChats);
          reportToBackground(newChats, changes);
        }
      }, CONFIG.DEBOUNCE_MS);
    });
    
    mutationObserver.observe(chatList, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-unread']
    });
    
    log('Mutation observer attached to chat list');
  }
  
  // ============================================================
  // MESSAGE HANDLERS
  // ============================================================
  
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'AUTOCHAT_START_MONITORING':
        startMonitoring();
        sendResponse({ success: true });
        return true;
        
      case 'AUTOCHAT_STOP_MONITORING':
        stopMonitoring();
        sendResponse({ success: true });
        return true;
        
      case 'AUTOCHAT_GET_CHAT_LIST':
        scanChatList(false).then(chats => {
          sendResponse({ 
            success: true, 
            chats,
            totalUnread: chats.reduce((sum, c) => sum + c.unreadCount, 0)
          });
        });
        return true;
        
      case 'AUTOCHAT_OPEN_CHAT':
        // Click on a specific chat to open it
        openChat(message.data?.chatId || message.chatId).then(result => sendResponse(result));
        return true;
        
      case 'AUTOCHAT_OPEN_FIRST_N':
        // Click on first N chats from top
        openFirstNChats(message.data?.count || 5).then(result => sendResponse(result));
        return true;
        
      case 'AUTOCHAT_GET_FIRST_N_PEER_IDS':
        // Get peer IDs of first N chats
        const peerIds = getFirstNPeerIds(message.data?.count || 5);
        sendResponse({ success: true, peerIds });
        return true;
        
      case 'AUTOCHAT_NAVIGATE_TO_CHAT':
        // Navigate to chat by changing hash (same tab)
        const peerId = message.data?.peerId;
        if (peerId) {
          log(`Navigating to chat #${peerId}`);
          window.location.hash = `#${peerId}`;
          sendResponse({ success: true, peerId });
        } else {
          sendResponse({ success: false, error: 'No peerId provided' });
        }
        return true;
        
      case 'AUTOCHAT_GET_STATUS':
        sendResponse({
          success: true,
          isMonitoring,
          lastScanTime: lastScanResult.size > 0 ? Date.now() : null,
          trackedChats: lastScanResult.size
        });
        return true;
        
      case 'AUTOCHAT_SCROLL_TO_TOP_AND_SCAN':
        // Called after sending a message - scroll to top and find new unreads
        scrollToTopAndScanUnreads().then(unreads => {
          sendResponse({ 
            success: true, 
            unreads,
            count: unreads.length
          });
        });
        return true;
        
      case 'GET_CHAT_INFO':
        // Get current open chat info for verification
        const chatInfo = getCurrentChatInfo();
        sendResponse({ success: true, info: chatInfo });
        return true;
        
      case 'GET_LAST_MESSAGES':
        // Get last N messages from current chat for verification
        const messageCount = message.count || 3;
        const messages = getLastMessages(messageCount);
        sendResponse({ success: true, messages });
        return true;
        
      case 'SEND_IMAGE':
        // Send image to current chat via paste/drop
        // Support both formats: { imageUrl, isUrl } and { data: { imageData } }
        const imageSource = message.imageUrl || message.data?.imageUrl || message.data?.imageData;
        const isUrlFormat = message.isUrl || message.data?.isUrl || false;
        log('📸 SEND_IMAGE received, source:', imageSource ? 'PROVIDED' : 'MISSING', 'isUrl:', isUrlFormat);
        sendImageToChat(imageSource, isUrlFormat).then(result => sendResponse(result));
        return true;
    }
  });
  
  // ============================================================
  // IMAGE SENDING (via Telegram's Attach Menu UI)
  // ============================================================
  
  // Store pending file for when file input is triggered
  let pendingImageFile = null;
  
  async function sendImageToChat(imageSource, isUrl = false) {
    log('📸 SEND_IMAGE: Using Telegram UI approach...');
    log('📸 Image source type:', isUrl ? 'URL' : 'base64');
    
    try {
      if (!imageSource) {
        throw new Error('No image data provided');
      }
      
      let blob;
      let mimeType = 'image/jpeg';
      
      if (isUrl) {
        // Fetch image from URL (Firebase Storage or other)
        log('📸 Fetching image from URL:', imageSource.substring(0, 80) + '...');
        const response = await fetch(imageSource);
        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
        }
        blob = await response.blob();
        mimeType = blob.type || 'image/jpeg';
        log('📸 Image fetched, size:', blob.size, 'type:', mimeType);
      } else {
        // Convert base64 to Blob
        log('📸 Converting base64 to blob...');
        const base64Data = imageSource.split(',')[1] || imageSource;
        mimeType = imageSource.includes('image/png') ? 'image/png' : 'image/jpeg';
        
        const byteCharacters = atob(base64Data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        blob = new Blob([byteArray], { type: mimeType });
        log('📸 Blob created, size:', blob.size);
      }
      
      const fileName = `image_${Date.now()}.${mimeType === 'image/png' ? 'png' : 'jpg'}`;
      const file = new File([blob], fileName, { type: mimeType });
      
      log('📸 Created file:', fileName, 'size:', file.size);
      
      // Store the file for the input interceptor
      pendingImageFile = file;
      
      // METHOD: Click Telegram's Attach Menu → Photo/Video
      const result = await tryAttachMenuMethod(file);
      
      pendingImageFile = null;
      return result;
      
    } catch (error) {
      log('❌ SEND_IMAGE Error:', error);
      pendingImageFile = null;
      return { success: false, error: error.message };
    }
  }
  
  // Main method: Use Telegram's native Attach Menu
  async function tryAttachMenuMethod(file) {
    log('📎 Trying Direct File Input method (no dialog)...');
    
    try {
      // METHOD A: Try to find and set file on existing input WITHOUT opening dialog
      const directResult = await trySetFileDirectly(file);
      if (directResult.success) {
        return directResult;
      }
      
      // METHOD B: Try drag & drop on the composer/message area
      const dropResult = await tryComposerDrop(file);
      if (dropResult.success) {
        return dropResult;
      }
      
      // METHOD C: Try paste on the input area
      const pasteResult = await tryComposerPaste(file);
      if (pasteResult.success) {
        return pasteResult;
      }
      
      return { success: false, error: 'All methods failed - browser security prevents programmatic file selection' };
      
    } catch (error) {
      log('❌ Method failed:', error);
      return { success: false, error: error.message };
    }
  }
  
  // Try to set file directly on existing input without triggering dialog
  async function trySetFileDirectly(file) {
    log('🎯 Trying to set file directly on existing inputs...');
    
    // Find all file inputs on the page
    const inputs = document.querySelectorAll('input[type="file"]');
    log(`Found ${inputs.length} file inputs`);
    
    for (const input of inputs) {
      const accept = input.getAttribute('accept') || '';
      log(`Input: accept="${accept}", id="${input.id}", class="${input.className}"`);
      
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        
        // Dispatch events
        input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        
        log('✅ File set on input');
        
        // Wait for modal
        await new Promise(r => setTimeout(r, 700));
        
        // Check if upload modal appeared
        const modal = document.querySelector('.Modal, .SendMediaModal, [class*="send-media"]');
        if (modal) {
          log('✅ Modal appeared!');
          return await clickSendInModal();
        }
      } catch (error) {
        log(`Failed on input: ${error.message}`);
      }
    }
    
    return { success: false, error: 'Direct file set did not trigger upload' };
  }
  
  // Try drag & drop directly on the composer
  async function tryComposerDrop(file) {
    log('🖱️ Trying drag & drop on composer...');
    
    // Target elements for drop
    const dropTargets = [
      document.querySelector('.Composer'),
      document.querySelector('.composer-wrapper'),
      document.querySelector('#editable-message-text'),
      document.querySelector('.message-input-wrapper'),
      document.querySelector('#MiddleColumn'),
      document.querySelector('.messages-container'),
      document.body
    ].filter(Boolean);
    
    for (const target of dropTargets) {
      log(`Trying drop on: ${target.className || target.id || target.tagName}`);
      
      try {
        // Create DataTransfer with file
        const dt = new DataTransfer();
        dt.items.add(file);
        
        // Set effectAllowed
        Object.defineProperty(dt, 'effectAllowed', { value: 'all' });
        Object.defineProperty(dt, 'dropEffect', { value: 'copy' });
        
        // Create and dispatch events
        const createDragEvent = (type) => {
          const event = new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt
          });
          // Also try to set dataTransfer manually for some browsers
          try {
            Object.defineProperty(event, 'dataTransfer', { value: dt });
          } catch (e) {}
          return event;
        };
        
        target.dispatchEvent(createDragEvent('dragenter'));
        await new Promise(r => setTimeout(r, 50));
        
        target.dispatchEvent(createDragEvent('dragover'));
        await new Promise(r => setTimeout(r, 50));
        
        target.dispatchEvent(createDragEvent('drop'));
        
        log('Drop events dispatched');
        
        // Wait for reaction
        await new Promise(r => setTimeout(r, 500));
        
        // Check for modal
        const modal = document.querySelector('.Modal, .SendMediaModal, [class*="send-media"]');
        if (modal) {
          log('✅ Modal appeared from drop!');
          return await clickSendInModal();
        }
      } catch (error) {
        log(`Drop failed on target: ${error.message}`);
      }
    }
    
    return { success: false, error: 'Drop did not trigger upload' };
  }
  
  // Try paste on composer
  async function tryComposerPaste(file) {
    log('📋 Trying paste on composer...');
    
    const inputArea = document.querySelector('#editable-message-text, [contenteditable="true"]');
    
    if (!inputArea) {
      log('Input area not found');
      return { success: false, error: 'Input area not found' };
    }
    
    // Focus the input
    inputArea.focus();
    await new Promise(r => setTimeout(r, 100));
    
    try {
      // Create DataTransfer with file
      const dt = new DataTransfer();
      dt.items.add(file);
      
      // Create ClipboardEvent
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      
      // Try to set clipboardData for browsers that don't support it in constructor
      try {
        Object.defineProperty(pasteEvent, 'clipboardData', { value: dt });
      } catch (e) {}
      
      inputArea.dispatchEvent(pasteEvent);
      
      log('Paste event dispatched');
      
      // Wait for reaction
      await new Promise(r => setTimeout(r, 500));
      
      // Check for modal
      const modal = document.querySelector('.Modal, .SendMediaModal, [class*="send-media"]');
      if (modal) {
        log('✅ Modal appeared from paste!');
        return await clickSendInModal();
      }
      
    } catch (error) {
      log(`Paste failed: ${error.message}`);
    }
    
    return { success: false, error: 'Paste did not trigger upload' };
  }
  
  // Intercept file input when it's triggered by clicking the menu
  function interceptFileInput(file) {
    return new Promise((resolve) => {
      log('🎯 Setting up file input interceptor...');
      
      // Watch for file inputs being clicked
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // Check if it's a file input
              if (node.tagName === 'INPUT' && node.type === 'file') {
                log('🎯 File input added to DOM!');
                setFileOnInput(node, file, resolve);
                observer.disconnect();
                return;
              }
              
              // Check children
              const input = node.querySelector?.('input[type="file"]');
              if (input) {
                log('🎯 File input found in added node!');
                setFileOnInput(input, file, resolve);
                observer.disconnect();
                return;
              }
            }
          }
        }
      });
      
      observer.observe(document.body, { childList: true, subtree: true });
      
      // Also check for existing hidden file inputs that might get triggered
      const existingInputs = document.querySelectorAll('input[type="file"]');
      log(`Found ${existingInputs.length} existing file inputs`);
      
      for (const input of existingInputs) {
        // Add click listener to intercept
        const originalClick = input.click.bind(input);
        input.click = function() {
          log('🎯 File input click intercepted!');
          setFileOnInput(input, file, resolve);
          observer.disconnect();
        };
      }
      
      // Timeout after 3 seconds
      setTimeout(() => {
        observer.disconnect();
        resolve({ success: false, error: 'No file input triggered' });
      }, 3000);
    });
  }
  
  // Set file on an input element
  function setFileOnInput(input, file, resolve) {
    try {
      log('📁 Setting file on input...');
      
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      
      // Trigger all relevant events
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      
      log('✅ File set on input, events dispatched');
      resolve({ success: true });
    } catch (error) {
      log('❌ Error setting file:', error);
      resolve({ success: false, error: error.message });
    }
  }
  
  // Fallback: Find and use file input directly
  async function tryDirectFileInput(file) {
    log('🔍 Trying direct file input method...');
    
    const inputs = document.querySelectorAll('input[type="file"]');
    log(`Found ${inputs.length} file inputs`);
    
    for (const input of inputs) {
      // Check if this input accepts images
      const accept = input.getAttribute('accept') || '';
      const isImageInput = accept.includes('image') || accept.includes('video') || accept === '' || accept === '*/*';
      
      log(`Input accept="${accept}" isImageInput=${isImageInput}`);
      
      if (isImageInput) {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
          
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          
          log('✅ File set on direct input');
          
          // Wait for modal
          await new Promise(r => setTimeout(r, 500));
          
          return await clickSendInModal();
        } catch (error) {
          log('Direct input failed:', error);
        }
      }
    }
    
    return { success: false, error: 'No suitable file input found' };
  }
  
  // Find and click send button in the upload modal
  async function clickSendInModal() {
    log('🔍 Looking for send button...');
    
    // Wait a bit for modal to appear
    await new Promise(r => setTimeout(r, 1000));
    
    // Try multiple modal selectors
    const modalSelectors = [
      '.modal-dialog',
      '.Modal',
      '[class*="modal"]',
      '[class*="Modal"]',
      '[role="dialog"]',
      '.popup',
      '.Popup'
    ];
    
    let modal = null;
    for (const sel of modalSelectors) {
      modal = document.querySelector(sel);
      if (modal) {
        log(`✅ Found modal via: ${sel}, class: ${modal.className}`);
        break;
      }
    }
    
    // Debug: List ALL buttons on the entire page
    const allPageBtns = document.querySelectorAll('button.Button');
    log(`📋 Found ${allPageBtns.length} Button elements on page:`);
    
    let sendBtn = null;
    
    // Search ALL buttons on page for "Send" text or primary class
    for (const btn of allPageBtns) {
      const text = btn.textContent?.trim() || '';
      const hasSmaller = btn.classList.contains('smaller');
      const hasPrimary = btn.classList.contains('primary');
      const hasTranslucent = btn.classList.contains('translucent');
      
      log(`  Button: "${text.substring(0, 20)}" smaller=${hasSmaller} primary=${hasPrimary} translucent=${hasTranslucent}`);
      
      // Looking for the Send button: "smaller primary" without translucent, text "Send"
      if (text.toLowerCase() === 'send' && hasPrimary && !hasTranslucent) {
        sendBtn = btn;
        log('✅ FOUND Send button by text + primary!');
        break;
      }
    }
    
    // Fallback: Find any button with "Send" text
    if (!sendBtn) {
      for (const btn of allPageBtns) {
        const text = btn.textContent?.trim().toLowerCase() || '';
        if (text === 'send') {
          sendBtn = btn;
          log('✅ FOUND Send button by text only');
          break;
        }
      }
    }
    
    // Fallback: Find button.smaller.primary
    if (!sendBtn) {
      sendBtn = document.querySelector('button.Button.smaller.primary:not(.translucent)');
      if (sendBtn) {
        log('✅ FOUND via button.smaller.primary selector');
      }
    }
    
    // Fallback: Look in .wDqWK9MD container
    if (!sendBtn) {
      const containers = document.querySelectorAll('.wDqWK9MD');
      for (const container of containers) {
        const btn = container.querySelector('button.Button.primary');
        if (btn) {
          sendBtn = btn;
          log('✅ FOUND via .wDqWK9MD container');
          break;
        }
      }
    }
    
    if (!sendBtn) {
      log('❌ No send button found anywhere on page!');
      return { success: false, error: 'Send button not found. Please click manually.' };
    }
    
    // Click the button using multiple methods
    const btnText = sendBtn.textContent?.trim() || '';
    const btnClass = sendBtn.className;
    log(`🖱️ Clicking: "${btnText}" class="${btnClass}"`);
    
    // Make sure button is visible and clickable
    const rect = sendBtn.getBoundingClientRect();
    log(`Button position: x=${rect.x}, y=${rect.y}, width=${rect.width}, height=${rect.height}`);
    
    if (rect.width === 0 || rect.height === 0) {
      log('⚠️ Button has no size - might be hidden');
    }
    
    // Try to scroll button into view if needed
    sendBtn.scrollIntoView({ block: 'center' });
    await new Promise(r => setTimeout(r, 100));
    
    // Method A: Direct click
    try {
      sendBtn.click();
      log('✅ Direct click() sent');
    } catch (e) {
      log('❌ click() failed:', e);
    }
    
    await new Promise(r => setTimeout(r, 200));
    
    // Method B: MouseEvent with coordinates
    try {
      const updatedRect = sendBtn.getBoundingClientRect();
      const x = updatedRect.left + updatedRect.width / 2;
      const y = updatedRect.top + updatedRect.height / 2;
      
      const mouseDown = new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, button: 0
      });
      const mouseUp = new MouseEvent('mouseup', {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, button: 0
      });
      const click = new MouseEvent('click', {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, button: 0
      });
      
      sendBtn.dispatchEvent(mouseDown);
      sendBtn.dispatchEvent(mouseUp);
      sendBtn.dispatchEvent(click);
      log('✅ MouseEvent sequence sent');
    } catch (e) {
      log('❌ MouseEvent failed:', e);
    }
    
    // Wait to see if modal closes
    await new Promise(r => setTimeout(r, 1500));
    
    // Check if modal closed
    const modalStillThere = document.querySelector('.modal-dialog, .Modal, [class*="modal"]');
    if (!modalStillThere) {
      log('✅ Modal closed - image sent!');
      return { success: true, method: 'modal-send-click', buttonText: btnText };
    }
    
    // Check if the button is still there
    const btnStillThere = document.querySelector('button.Button.smaller.primary:not(.translucent)');
    if (!btnStillThere) {
      log('✅ Send button gone - likely sent!');
      return { success: true, method: 'modal-send-click', buttonText: btnText };
    }
    
    log('⚠️ Modal and button still visible - click may not have worked');
    log('⚠️ Please click the Send button manually');
    return { success: false, error: 'Click sent but modal did not close. Click manually.' };
  }
  
  // ============================================================
  // CHAT INFO & VERIFICATION HELPERS
  // ============================================================
  
  // Get info about the currently open chat (for verification)
  function getCurrentChatInfo() {
    log('📋 Getting current chat info...');
    
    try {
      let peerId = null;
      let displayName = null;
      
      // Method 1: Get from URL hash
      const hash = window.location.hash;
      if (hash && hash.startsWith('#')) {
        peerId = hash.substring(1);
        log('Found peer ID from URL hash:', peerId);
      }
      
      // Method 2: Get from Middle Column (the open chat area)
      const middleColumn = document.querySelector('#MiddleColumn, .MiddleColumn, [class*="middle-column"]');
      if (middleColumn) {
        // Check for peer ID on elements
        const peerIdEl = middleColumn.querySelector('[data-peer-id]');
        if (peerIdEl && !peerId) {
          peerId = peerIdEl.getAttribute('data-peer-id');
          log('Found peer ID from middle column:', peerId);
        }
        
        // Get name from chat header
        const headerSelectors = [
          '.ChatInfo .fullName',
          '.chat-info .title',
          '.TopicPeer .peer-title',
          '.ChatHeader h3',
          '[class*="ChatInfo"] .fullName',
          '.peer-title',
          '.chat-header .chat-title',
          '.chat-info-container .title',
          '.user-title'
        ];
        
        for (const selector of headerSelectors) {
          const nameEl = middleColumn.querySelector(selector);
          if (nameEl?.textContent?.trim()) {
            displayName = nameEl.textContent.trim();
            log('Found display name from', selector, ':', displayName);
            break;
          }
        }
      }
      
      // Method 3: Get from message area header if not found yet
      if (!displayName) {
        const headerEl = document.querySelector('.chat-header .user-title, .TopHeader .title, .messages-layout .chat-info .title');
        if (headerEl) {
          displayName = headerEl.textContent?.trim();
          log('Found display name from header:', displayName);
        }
      }
      
      return {
        peerId,
        displayName,
        hash,
        timestamp: Date.now()
      };
      
    } catch (error) {
      log('Error getting current chat info:', error);
      return { peerId: null, displayName: null, error: error.message };
    }
  }
  
  // Get last N messages from the current chat (for verification)
  function getLastMessages(count = 3) {
    log(`📨 Getting last ${count} messages...`);
    
    try {
      // Find message container - Telegram Web A structure
      const messageContainer = document.querySelector('.messages-container, .MessageList, [class*="message-list"], #MessageList');
      if (!messageContainer) {
        log('Message container not found');
        return [];
      }
      
      // Find message bubbles
      const messageSelectors = [
        '.Message',
        '.message',
        '[class*="Message"]:not([class*="MessageList"])',
        '.bubble'
      ];
      
      let messages = [];
      for (const selector of messageSelectors) {
        const found = messageContainer.querySelectorAll(selector);
        if (found.length > 0) {
          messages = Array.from(found);
          log(`Found ${messages.length} messages using selector: ${selector}`);
          break;
        }
      }
      
      if (messages.length === 0) {
        log('No messages found');
        return [];
      }
      
      // Get last N messages
      const lastMessages = messages.slice(-count);
      
      return lastMessages.map((msg, idx) => {
        // Extract text content
        const textSelectors = ['.text-content', '.message-text', '.text', '[class*="text-content"]', 'span.translatable-message'];
        let text = '';
        
        for (const sel of textSelectors) {
          const textEl = msg.querySelector(sel);
          if (textEl?.textContent?.trim()) {
            text = textEl.textContent.trim();
            break;
          }
        }
        
        // If no text found in specific element, get message content
        if (!text) {
          text = msg.textContent?.trim().substring(0, 100) || '';
        }
        
        // Check if it's outgoing or incoming
        const isOutgoing = msg.classList.contains('own') || 
                          msg.classList.contains('outgoing') ||
                          msg.querySelector('[class*="own"]') !== null;
        
        return {
          text: text.substring(0, 200),
          isOutgoing,
          index: idx
        };
      });
      
    } catch (error) {
      log('Error getting last messages:', error);
      return [];
    }
  }
  
  // ============================================================
  // CHAT NAVIGATION
  // ============================================================
  
  // Get peer IDs of first N chats (for opening in new tabs)
  function getFirstNPeerIds(count = 5) {
    log(`📋 Getting first ${count} chats...`);
    
    // Try multiple chat list selectors
    let chatList = document.querySelector('.chat-list');
    if (!chatList) chatList = document.querySelector('#LeftColumn-main .chat-list');
    if (!chatList) chatList = document.querySelector('.Transition_slide-active .chat-list');
    if (!chatList) chatList = document.querySelector('[class*="chat-list"]');
    
    if (!chatList) {
      log('❌ Chat list not found! Trying broader search...');
      // Try to find chat items directly
      const directItems = document.querySelectorAll('.ListItem.chat-item-clickable, .ListItem[class*="chat"]');
      if (directItems.length > 0) {
        log(`Found ${directItems.length} chat items via direct search`);
        return extractChatsFromItems(Array.from(directItems).slice(0, count));
      }
      return [];
    }
    
    // Try multiple item selectors
    let chatItems = chatList.querySelectorAll('.ListItem.chat-item-clickable');
    if (chatItems.length === 0) chatItems = chatList.querySelectorAll('.ListItem[class*="chat"]');
    if (chatItems.length === 0) chatItems = chatList.querySelectorAll('[data-peer-id]');
    if (chatItems.length === 0) chatItems = chatList.querySelectorAll('a[href^="#"]');
    if (chatItems.length === 0) chatItems = chatList.querySelectorAll('.ListItem');
    
    log(`Requested ${count} chats, found ${chatItems.length} total chat items`);
    
    return extractChatsFromItems(Array.from(chatItems).slice(0, count));
  }
  
  // Extract chat info from DOM items
  function extractChatsFromItems(items) {
    const peerIds = [];
    
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      
      // Get name from multiple possible selectors
      let name = null;
      const nameSelectors = ['.fullName', '.title', 'h3', '.peer-title', '.ListItem-title', '.name'];
      for (const sel of nameSelectors) {
        const el = item.querySelector(sel);
        if (el?.textContent?.trim()) {
          name = el.textContent.trim();
          break;
        }
      }
      if (!name) name = `Chat ${i + 1}`;
      
      // Get peer ID from Avatar or href
      let peerId = null;
      
      const avatarWithPeerId = item.querySelector('[data-peer-id]');
      if (avatarWithPeerId) {
        peerId = avatarWithPeerId.getAttribute('data-peer-id');
      }
      
      if (!peerId) {
        const anchor = item.querySelector('a[href^="#"]');
        if (anchor) {
          const href = anchor.getAttribute('href');
          peerId = href?.replace('#', '');
        }
      }
      
      // FALLBACK: If we can't find peer ID, generate one from name
      // This allows name-based search to work
      if (!peerId) {
        log(`⚠️ Chat ${i} (${name}) has no peer ID, using name-based fallback`);
        peerId = `name:${name}`;
      }
      
      peerIds.push({ peerId, name, index: i });
      log(`Chat ${i}: ${name} -> ${peerId}`);
    }
    
    log(`✅ Got ${peerIds.length} chats`);
    return peerIds;
  }
  
  // Open the FIRST chat from the top using URL navigation
  async function openFirstNChats(count = 1) {
    try {
      const chatList = document.querySelector(SELECTORS.chatList);
      if (!chatList) {
        log('Chat list not found!');
        return { success: false, error: 'Chat list not found' };
      }
      
      const chatItems = chatList.querySelectorAll(SELECTORS.chatItem);
      log(`Found ${chatItems.length} chat items`);
      
      if (chatItems.length === 0) {
        return { success: false, error: 'No chats found' };
      }
      
      // Get peer ID from first chat - it's inside the Avatar or href
      const item = chatItems[0];
      const nameEl = item.querySelector(SELECTORS.chatName);
      const name = nameEl?.textContent?.trim() || 'Chat 1';
      
      // Try to get peer ID from:
      // 1. data-peer-id on any descendant (Avatar element)
      // 2. href attribute of anchor
      let peerId = null;
      
      const avatarWithPeerId = item.querySelector('[data-peer-id]');
      if (avatarWithPeerId) {
        peerId = avatarWithPeerId.getAttribute('data-peer-id');
      }
      
      // Fallback: get from href
      if (!peerId) {
        const anchor = item.querySelector('a[href^="#"]');
        if (anchor) {
          const href = anchor.getAttribute('href');
          peerId = href?.replace('#', '');
        }
      }
      
      log(`Opening first chat: ${name}, peerId: ${peerId}`);
      
      // Try clicking the anchor element directly
      const anchor = item.querySelector('a.ListItem-button') || item.querySelector('a[href^="#"]');
      if (anchor) {
        log('Clicking anchor element...');
        anchor.click();
        return { success: true, name, peerId, index: 0, method: 'anchor-click' };
      }
      
      // Fallback: click the item itself
      log('Clicking item element...');
      item.click();
      
      // Also dispatch click event
      const clickEvent = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window
      });
      item.dispatchEvent(clickEvent);
      
      return { success: true, name, peerId, index: 0, method: 'item-click' };
    } catch (error) {
      log('Error opening chat:', error);
      return { success: false, error: error.message };
    }
  }
  
  async function openChat(targetChatId) {
    try {
      // Find the chat item in the list
      const chatList = document.querySelector(SELECTORS.chatList);
      if (!chatList) {
        return { success: false, error: 'Chat list not found' };
      }
      
      const chatItems = chatList.querySelectorAll(SELECTORS.chatItem);
      
      for (const item of chatItems) {
        const chatData = extractChatData(item);
        if (chatData?.chatId === targetChatId || chatData?.rawId === targetChatId) {
          // Found the chat, click it
          item.click();
          
          // Wait for chat to load
          await new Promise(resolve => setTimeout(resolve, 500));
          
          return { success: true, chatId: chatData.chatId };
        }
      }
      
      return { success: false, error: 'Chat not found in list' };
    } catch (error) {
      log('Error opening chat:', error);
      return { success: false, error: error.message };
    }
  }
  
  // ============================================================
  // INITIALIZATION
  // ============================================================
  
  function init() {
    log('Chat list monitor loaded');
    
    // Check if we're on the main chat list view
    const isOnChatList = !!document.querySelector(SELECTORS.chatList);
    
    if (isOnChatList) {
      log('Chat list found, ready for monitoring');
      
      // Notify background that monitor is ready
      chrome.runtime.sendMessage({
        type: 'AUTOCHAT_MONITOR_READY',
        data: { timestamp: Date.now() }
      }).catch(() => {});
    }
    
    // Watch for chat list to appear (SPA navigation)
    const bodyObserver = new MutationObserver(() => {
      const chatList = document.querySelector(SELECTORS.chatList);
      if (chatList && !isMonitoring) {
        log('Chat list appeared');
        chrome.runtime.sendMessage({
          type: 'AUTOCHAT_MONITOR_READY',
          data: { timestamp: Date.now() }
        }).catch(() => {});
      }
    });
    
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }
  
  // Helper to safely send messages (handles extension context invalidation)
  function safeSendMessage(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch (e) {
      // Extension context invalidated - stop monitoring
      if (e.message?.includes('Extension context invalidated')) {
        console.log('[Clarity-TG-Monitor] Extension reloaded - please refresh page');
        stopMonitoring();
      }
    }
  }
  
  // Expose test function globally for debugging
  window.testUnreadDetection = function() {
    const chatList = document.querySelector('.chat-list');
    if (!chatList) {
      console.log('❌ Chat list not found');
      return;
    }
    
    const items = chatList.querySelectorAll('.ListItem.chat-item-clickable');
    console.log(`Found ${items.length} chat items`);
    
    items.forEach((item, i) => {
      const name = item.querySelector('.fullName')?.textContent?.trim() || `Chat ${i}`;
      const badge = item.querySelector('.chat-badge-transition.shown span');
      if (badge) {
        const count = badge.textContent?.trim();
        console.log(`✅ ${name}: ${count} unreads`);
      }
    });
    
    console.log('--- Test complete ---');
  };
  
  // Test scrolling function
  window.testScrolling = async function() {
    console.log('[Clarity-TG-Monitor] Testing scrolling functionality...');
    const chatList = document.querySelector('.chat-list');
    if (!chatList) {
      console.log('❌ Chat list not found');
      return;
    }
    
    console.log('Chat list found:', chatList);
    console.log('Chat list scrollable?', chatList.scrollHeight > chatList.clientHeight);
    
    // Try different scroll containers
    const containers = [
      chatList,
      chatList.parentElement,
      document.querySelector('#LeftColumn-main'),
      document.querySelector('#LeftColumn'),
      document.querySelector('.LeftColumn'),
      document.querySelector('[id*="column"]'),
      document.querySelector('.tabs-tab')
    ];
    
    for (const container of containers) {
      if (container) {
        console.log(`Container: ${container.className || container.id || container.tagName}`);
        console.log(`  scrollHeight: ${container.scrollHeight}, clientHeight: ${container.clientHeight}`);
        console.log(`  scrollable: ${container.scrollHeight > container.clientHeight}`);
        console.log(`  overflow: ${window.getComputedStyle(container).overflow}`);
        console.log(`  overflowY: ${window.getComputedStyle(container).overflowY}`);
      }
    }
    
    // Try manual full scan
    console.log('\n--- Attempting full scan with scroll ---');
    const results = await scanChatList(true);
    console.log(`Full scan results: ${results.length} chats found`);
  };
  
  console.log('[Clarity-TG-Monitor] Test functions available:');
  console.log('  window.testUnreadDetection() - Test unread detection');
  console.log('  window.testScrolling() - Test scrolling functionality');
  
  // Start initialization
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
})();
