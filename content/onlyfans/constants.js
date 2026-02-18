// ============================================================
// CONSTANTS - OnlyFans specific selectors and configurations
// ============================================================

// DOM Selectors
export const SELECTORS = {
  // Chat elements
  chatContainer: '.b-chat__messages-wrapper, .b-chat__content',
  messageElement: '.b-chat__message',
  messageText: '.b-chat__message__text, .g-truncated-text',
  messageTime: '.b-chat__message__time, time',
  ownMessage: '.m-from-me, .m-own',
  
  // Chat list
  chatListContainer: '.b-available-users, .b-chats, [class*="chat-list"]',
  chatItem: '.b-available-users__item.b-chats__item',
  
  // Vault items
  vaultItem: '.b-photos__item',
  vaultListItem: '.m-vault-list__item',
  vaultGridItem: '.b-photos__grid-item',
  vaultMediaItem: '.m-media-item',
  
  // Input elements
  chatInput: 'textarea[placeholder*="message"]',
  sendButton: 'button[type="submit"]',
  
  // Profile elements - Fan Statistics in chat sidebar
  profileStats: '.b-fans__item__list__item, .b-fans__item__list, .m-fan-stats, .b-fans__item, .g-section-item, [class*="stats"]',
  fanStatsList: '.b-fans__item__list.m-fan-stats, .b-fans__item__list',
  fanStatsItem: '.b-fans__item__list__item',
  fanStatsLabel: '.b-fans__item__list__label'
};

// Typing speed configuration (100% = normal speed)
export const TYPING_SPEED_BASE = {
  baseDelay: 80,               // Base delay between characters (ms)
  variation: 60,               // Random variation (±ms)
  pauseAfterPunctuation: 200,  // Extra pause after . , ! ?
  pauseAfterWord: 50           // Small pause after space
};

// Typo configuration
export const TYPO_CONFIG = {
  rate: 0.025,  // 2.5% chance of typo per word
  types: ['missing', 'double', 'adjacent', 'transposed']
};

// Adjacent keys on QWERTY keyboard
export const ADJACENT_KEYS = {
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

// Vault scan selectors
export const VAULT_SELECTORS = [
  '.b-photos__item',
  '.m-vault-list__item',
  '[class*="vault"][class*="item"]',
  '.b-photos__grid-item',
  'div[data-media-id]',
  '.m-media-item'
];

// PPV message selectors
export const PPV_SELECTORS = {
  vaultButton: 'svg[data-icon-name="icon-vault"], use[href="#icon-vault"]',
  addToButton: 'button:contains("ADD TO")',
  usersTab: '[role="tab"], .b-tabs__item',
  userRow: '.b-username-row, .b-users__item',
  priceInput: 'input[name*="price"], input[placeholder*="price"], input[type="number"]'
};

// Polling intervals
export const INTERVALS = {
  urlCheck: 300,         // Check URL changes every 300ms
  messagePolling: 1500,  // Check for new messages every 1.5s
  chatListPolling: 10000 // Check chat list every 10s for auto-chat (reduced from 1s)
};

// Smart polling intervals based on activity
export const SMART_INTERVALS = {
  active: 5000,          // 5s when auto-chat is active
  normal: 10000,         // 10s for normal browsing
  idle: 30000           // 30s when idle (no activity for 2 min)
};
