// ============================================================
// CONFIGURATION
// ============================================================

// Production API URL (Heroku)
export const CONFIG = {
  API_URL: 'https://clarity-notes-api-0a5da158d2ca.herokuapp.com/api',
  ONLYFANS_URL: 'https://onlyfans.com/my/chats'
};

export const AUTOCHAT_CONFIG = {
  MAX_ACTIVE_CHATS: 5,
  IDLE_TIMEOUT_MS: 10 * 60 * 1000,
  RESPONSE_DELAY_MIN: 30000,
  RESPONSE_DELAY_MAX: 180000,
  MAX_PARALLEL_REQUESTS: 3,
  SCAN_INTERVAL: 5000
};

export const SUPPORTED_PLATFORMS = [
  { name: 'onlyfans', patterns: ['onlyfans.com'] },
  { name: 'telegram', patterns: ['web.telegram.org'] }
];

export const DEFAULT_SCRIPTS = [
  {
    id: 'gfe-classic',
    name: '🌹 GFE Classic',
    stages: [
      { id: 1, name: 'Warmup', messages: [
        { text: 'Warm greeting - make them feel special', completed: false },
        { text: 'Ask how their day is going', completed: false },
        { text: 'Share something about your day', completed: false }
      ]},
      { id: 2, name: 'Shower Tease', messages: [
        { text: "Mention you're about to shower", completed: false },
        { text: "Ask what they're up to", completed: false },
        { text: 'Tease about shower thoughts', completed: false },
        { text: 'Send a teasing pre-shower hint', completed: false }
      ]},
      { id: 3, name: 'Bed Strip-tease', messages: [
        { text: "Say you're getting into bed", completed: false },
        { text: "Mention what you're wearing", completed: false },
        { text: 'Ask if they want to see', completed: false },
        { text: 'Build anticipation', completed: false }
      ]},
      { id: 4, name: 'PPV Offer', messages: [
        { text: 'Tease exclusive content', completed: false },
        { text: "Describe what's in the PPV", completed: false },
        { text: 'Send the PPV message', completed: false }
      ]}
    ]
  },
  {
    id: 'quick-ppv',
    name: '💋 Quick PPV Sell',
    stages: [
      { id: 1, name: 'Greeting', messages: [
        { text: 'Sexy hello', completed: false },
        { text: "Ask what they're doing", completed: false }
      ]},
      { id: 2, name: 'Tease', messages: [
        { text: 'Hint at new content', completed: false },
        { text: 'Build desire', completed: false }
      ]},
      { id: 3, name: 'Close', messages: [
        { text: 'Make the offer', completed: false },
        { text: 'Send PPV', completed: false }
      ]}
    ]
  },
  {
    id: 'new-sub',
    name: '🎁 New Sub Welcome',
    stages: [
      { id: 1, name: 'Welcome', messages: [
        { text: 'Thank them for subscribing', completed: false },
        { text: 'Introduce yourself warmly', completed: false }
      ]},
      { id: 2, name: 'Get to Know', messages: [
        { text: 'Ask what brought them here', completed: false },
        { text: 'Ask what content they like', completed: false }
      ]},
      { id: 3, name: 'First Tease', messages: [
        { text: 'Tease some exclusive content', completed: false },
        { text: 'Offer a welcome gift/preview', completed: false }
      ]}
    ]
  }
];
