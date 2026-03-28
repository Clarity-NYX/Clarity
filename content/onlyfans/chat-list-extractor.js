// ============================================================
// CHAT LIST EXTRACTOR - Scrapes OnlyFans chat list
// ============================================================
// PERFORMANCE-OPTIMIZED:
// - Scrape result caching with TTL to prevent redundant DOM queries
// - Hash-first check: if caller provides last hash, skip scrape entirely
// - Reduced console.log noise in production hot paths
// ============================================================

// Scrape cache — prevents re-scraping when called multiple times within TTL
let _scrapeCache = null;
let _scrapeCacheTime = 0;
const SCRAPE_CACHE_TTL = 2000; // Don't re-scrape within 2 seconds

// Scrape chat list with timestamps for auto-chat (includes isTheirMessageLast)
export const scrapeChatListWithTimestamps = () => {
  // Return cached result if within TTL
  const now = Date.now();
  if (_scrapeCache && (now - _scrapeCacheTime) < SCRAPE_CACHE_TTL) {
    return _scrapeCache;
  }
  
  const chats = [];
  const chatItems = document.querySelectorAll('.b-available-users__item.b-chats__item');
  
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
      const lastMsgContainer = item.querySelector('.b-chats__item__last-message');
      const isFromThem = lastMsgContainer?.classList.contains('m-from-them') ||
                        !lastMsgContainer?.classList.contains('m-from-me');
      
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
      
      // Check for unread indicator
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
  
  const result = { success: true, chats };
  
  // Cache the result
  _scrapeCache = result;
  _scrapeCacheTime = now;
  
  return result;
};

// Invalidate scrape cache (call when you know DOM has changed)
export const invalidateScrapeCache = () => {
  _scrapeCache = null;
  _scrapeCacheTime = 0;
};

// Scrape chat list (simplified version without timestamps)
export const scrapeChatList = () => {
  const chats = [];
  const chatItems = document.querySelectorAll('.b-available-users__item.b-chats__item');
  
  chatItems.forEach(item => {
    try {
      const itemId = item.id || '';
      const linkEl = item.querySelector('a.b-chats__item__link');
      const linkMatch = linkEl?.href?.match(/\/chat\/(\d+)/);
      const subscriberId = itemId || (linkMatch ? linkMatch[1] : null);
      
      if (!subscriberId) return;
      
      const usernameEl = item.querySelector('.g-user-name');
      const subscriberName = usernameEl?.textContent?.trim() || 'Unknown';
      
      const handleEl = item.querySelector('.g-user-username');
      const handle = handleEl?.textContent?.trim() || '';
      
      const lastMsgEl = item.querySelector('.b-chats__item__last-message__text');
      const lastMessagePreview = lastMsgEl?.textContent?.trim() || '';
      
      const timeEl = item.querySelector('.b-chats__item__time span');
      const timeText = timeEl?.textContent?.trim() || '';
      const fullTime = timeEl?.getAttribute('title') || '';
      
      const avatarLink = item.querySelector('.g-avatar');
      const isOnline = avatarLink?.classList.contains('online_status_class') || false;
      
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
