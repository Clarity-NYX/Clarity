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
      
      // Get handle (@username)
      const handleEl = item.querySelector('.g-user-username');
      const handle = handleEl?.textContent?.trim() || '';
      
      // Get online status
      const avatarLink = item.querySelector('.g-avatar');
      const isOnline = avatarLink?.classList.contains('online_status_class') || false;
      
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
      
      // Try to parse the timestamp from title attr
      // OF format: "Sunday, April 6, 2026 at 5:06:17 PM"
      // 1. Strip " at " — Date.parse can't handle it
      // 2. Strip leading day name + comma — "Sunday, " breaks Date.parse in some engines
      let lastMessageTimestamp = null;
      if (fullTimeAttr) {
        let cleaned = fullTimeAttr.replace(/\s+at\s+/i, ' ');
        cleaned = cleaned.replace(/^[A-Za-z]+,\s*/, '');
        const parsed = Date.parse(cleaned);
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
        handle,
        lastMessagePreview,
        isTheirMessageLast: !isOurMessage,
        lastMessageTimestamp,
        fullTime: fullTimeAttr,
        timeText,
        isOnline,
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

// Estimate timestamp from relative time text (e.g., "5m", "2h", "Yesterday", "Sep 12", "12 Apr")
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
  
  // Date-like patterns: "Sep 12", "12 Sep", "Apr 5", "5 Apr", etc.
  // OF shows these for messages older than a few days
  const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  const dateMatch1 = text.match(/^([a-z]{3})\s+(\d{1,2})$/); // "Sep 12"
  const dateMatch2 = text.match(/^(\d{1,2})\s+([a-z]{3})$/); // "12 Sep"
  
  let monthNum = null, dayNum = null;
  if (dateMatch1 && months[dateMatch1[1]] !== undefined) {
    monthNum = months[dateMatch1[1]];
    dayNum = parseInt(dateMatch1[2]);
  } else if (dateMatch2 && months[dateMatch2[2]] !== undefined) {
    monthNum = months[dateMatch2[2]];
    dayNum = parseInt(dateMatch2[1]);
  }
  
  if (monthNum !== null && dayNum) {
    const currentDate = new Date();
    let year = currentDate.getFullYear();
    // If the month/day is in the future, it must be from last year
    const candidate = new Date(year, monthNum, dayNum, 12, 0, 0);
    if (candidate.getTime() > now) {
      year--;
    }
    return new Date(year, monthNum, dayNum, 12, 0, 0).getTime();
  }
  
  // Time-only patterns: "1:23 pm", "14:30" — means today
  const timeMatch = text.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1]);
    const mins = parseInt(timeMatch[2]);
    const ampm = timeMatch[3];
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    const today = new Date();
    today.setHours(hours, mins, 0, 0);
    return today.getTime();
  }
  
  // Fallback: return null so normalizeTimestamp falls back to current time
  // This is safer than inventing a fake "30 min ago" timestamp
  return null;
};
