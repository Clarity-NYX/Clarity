// ============================================================
// CHAT LIST EXTRACTOR - Scrapes OnlyFans chat list
// ============================================================

// Scrape chat list with timestamps for auto-chat (includes isTheirMessageLast)
export const scrapeChatListWithTimestamps = () => {
  console.log('[Content] Scraping chat list WITH timestamps...');
  
  const chats = [];
  const chatItems = document.querySelectorAll('.b-available-users__item.b-chats__item');
  
  console.log('[Content] Found chat items:', chatItems.length);
  
  chatItems.forEach(item => {
    try {
      // Get subscriber ID from item id attribute or from link
      const itemId = item.id || '';
      const linkEl = item.querySelector('a.b-chats__item__link');
      const linkMatch = linkEl?.href?.match(/\/chat\/(\d+)/);
      const subscriberId = itemId || (linkMatch ? linkMatch[1] : null);
      
      if (!subscriberId) return;
      
      // Get username
      const usernameEl = item.querySelector('.g-user-name');
      const subscriberName = usernameEl?.textContent?.trim() || 'Unknown';
      
      // Get last message preview
      const lastMsgEl = item.querySelector('.b-chats__item__last-message__text');
      const lastMessagePreview = lastMsgEl?.textContent?.trim() || '';
      
      // Determine if THEIR message is last (we need to reply)
      // Check for "m-from-them" indicator or other classes
      const lastMsgContainer = item.querySelector('.b-chats__item__last-message');
      const isFromThem = lastMsgContainer?.classList.contains('m-from-them') ||
                        !lastMsgContainer?.classList.contains('m-from-me');
      
      // Also check the text itself for common patterns
      // If the preview starts with "You:" it's our message
      const isOurMessage = lastMessagePreview.startsWith('You:') || 
                          lastMsgContainer?.classList.contains('m-from-me');
      
      // Get time and try to parse timestamp
      const timeEl = item.querySelector('.b-chats__item__time span');
      const timeText = timeEl?.textContent?.trim() || '';
      const fullTimeAttr = timeEl?.getAttribute('title') || '';
      
      // Try to parse the timestamp
      let lastMessageTimestamp = null;
      if (fullTimeAttr) {
        const parsed = Date.parse(fullTimeAttr);
        if (!isNaN(parsed)) {
          lastMessageTimestamp = parsed;
        }
      }
      
      // If no parseable timestamp, estimate from relative time
      if (!lastMessageTimestamp && timeText) {
        lastMessageTimestamp = estimateTimestamp(timeText);
      }
      
      // Check for unread indicator (OnlyFans uses "m-unread" class and "uread-count" element - note typo)
      const hasUnread = item.classList.contains('m-unread') || 
                        item.querySelector('.b-chats__item__uread-count') !== null;
      
      chats.push({
        id: `of:${subscriberId}`,
        rawId: subscriberId,
        subscriberName,
        lastMessagePreview,
        isTheirMessageLast: !isOurMessage,
        lastMessageTimestamp,
        timeText,
        hasUnread
      });
    } catch (e) {
      console.error('[Content] Error parsing chat item:', e);
    }
  });
  
  console.log('[Content] Scraped chats with timestamps:', chats.length);
  return { success: true, chats };
};

// Scrape chat list (simplified version without timestamps)
export const scrapeChatList = () => {
  console.log('[Content] Scraping chat list...');
  
  const chats = [];
  const chatItems = document.querySelectorAll('.b-available-users__item.b-chats__item');
  
  console.log('[Content] Found chat items:', chatItems.length);
  
  chatItems.forEach(item => {
    try {
      // Get subscriber ID from item id attribute or from link
      const itemId = item.id || '';
      const linkEl = item.querySelector('a.b-chats__item__link');
      const linkMatch = linkEl?.href?.match(/\/chat\/(\d+)/);
      const subscriberId = itemId || (linkMatch ? linkMatch[1] : null);
      
      if (!subscriberId) return;
      
      // Get username
      const usernameEl = item.querySelector('.g-user-name');
      const subscriberName = usernameEl?.textContent?.trim() || 'Unknown';
      
      // Get handle (if available)
      const handleEl = item.querySelector('.g-user-username');
      const handle = handleEl?.textContent?.trim() || '';
      
      // Get last message preview
      const lastMsgEl = item.querySelector('.b-chats__item__last-message__text');
      const lastMessagePreview = lastMsgEl?.textContent?.trim() || '';
      
      // Get time
      const timeEl = item.querySelector('.b-chats__item__time span');
      const timeText = timeEl?.textContent?.trim() || '';
      const fullTime = timeEl?.getAttribute('title') || '';
      
      // Check if online
      const avatarLink = item.querySelector('.g-avatar');
      const isOnline = avatarLink?.classList.contains('online_status_class') || false;
      
      // Check for unread indicator (OnlyFans uses "m-unread" class and "uread-count" element - note typo)
      const hasUnread = item.classList.contains('m-unread') || 
                        item.querySelector('.b-chats__item__uread-count') !== null;
      
      chats.push({
        id: `of:${subscriberId}`,
        rawId: subscriberId,
        subscriberName,
        handle,
        lastMessagePreview,
        timeText,
        fullTime,
        isOnline,
        hasUnread
      });
    } catch (e) {
      console.error('[Content] Error parsing chat item:', e);
    }
  });
  
  console.log('[Content] Scraped chats:', chats.length);
  return { success: true, chats };
};

// Estimate timestamp from relative time text (e.g., "5m", "2h", "Yesterday")
const estimateTimestamp = (timeText) => {
  const now = Date.now();
  const text = timeText.toLowerCase().trim();
  
  // Pattern: "Xm" = X minutes ago
  const minutesMatch = text.match(/^(\d+)\s*m$/);
  if (minutesMatch) {
    return now - (parseInt(minutesMatch[1]) * 60 * 1000);
  }
  
  // Pattern: "Xh" = X hours ago
  const hoursMatch = text.match(/^(\d+)\s*h$/);
  if (hoursMatch) {
    return now - (parseInt(hoursMatch[1]) * 60 * 60 * 1000);
  }
  
  // "Yesterday" = ~24 hours ago
  if (text.includes('yesterday')) {
    return now - (24 * 60 * 60 * 1000);
  }
  
  // "X days ago" or just "Xd"
  const daysMatch = text.match(/^(\d+)\s*d$/);
  if (daysMatch) {
    return now - (parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000);
  }
  
  // Fallback: assume recent (within last hour)
  return now - (30 * 60 * 1000);
};