// AI Helpers - Pure utility functions, response parsing, bot accusation tracking
import Store from '../../state/store.js';
import API, { detectPlatform } from '../../utils/api.js';

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

// Convert blob to base64 data URL
export const blobToBase64 = (blob) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

// Helper to extract subscriber ID from URL (similar to getSubscriberIdFromTab)
export const getSubscriberIdFromTabUrl = (url) => {
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
// AI RESPONSE PARSING
// ============================================================

export const parseAIResponse = (responseText) => {
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

// ============================================================
// BOT ACCUSATION TRACKING
// ============================================================

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
export const MAX_BOT_ACCUSATIONS = 3;

// Get/increment bot accusation count for subscriber
export const trackBotAccusation = (subscriberId) => {
  const currentCount = botAccusationTracker.get(subscriberId) || 0;
  const newCount = currentCount + 1;
  botAccusationTracker.set(subscriberId, newCount);
  return newCount;
};

// Check if subscriber should be blocked for bot accusations
export const shouldBlockForBotAccusation = (subscriberId) => {
  const count = botAccusationTracker.get(subscriberId) || 0;
  return count >= MAX_BOT_ACCUSATIONS;
};

// Get appropriate response for bot accusation count
export const getBotAccusationResponse = (accusationCount) => {
  if (accusationCount >= MAX_BOT_ACCUSATIONS) {
    return { response: BOT_FINAL_WARNING, shouldBlock: true };
  }

  // Cycle through excuses
  const responseIndex = Math.min(accusationCount - 1, BOT_EXCUSE_RESPONSES.length - 1);
  return { response: BOT_EXCUSE_RESPONSES[responseIndex], shouldBlock: false };
};

// Block subscriber via API
export const blockSubscriberForBotAccusation = async (subscriberId, subscriberName) => {
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
