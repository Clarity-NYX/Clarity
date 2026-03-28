// ============================================================
// CENTRALIZED STATE MANAGEMENT
// ============================================================

const state = {
  // Chat
  messages: [],
  subscriberName: '',
  currentSubscriberId: null,
  storedChat: null,
  isSyncing: false,
  
  // Scripts
  scripts: [],
  currentScript: null,
  currentStage: 1,
  
  // Operation tracking (prevents race conditions)
  operationVersion: 0,  // Increments on each subscriber switch
  isLoadingProgress: false,  // Prevents stale renders
  
  // Render version tracking (detects display desync)
  messageVersion: 0,       // Increments only when message content actually changes
  lastRenderedVersion: 0,  // Last version that was rendered to DOM
  lastMessageFingerprint: '', // Fingerprint of last messages set (count + last text)
  
  // AI
  summary: '',
  lastSummaryCount: 0,
  
  // Settings
  tone: 'sweet',
  persona: '',
  apiKey: '',
  
  // Profiles
  profiles: [],
  currentProfile: null
};

// Event listeners for state changes
const listeners = {};

export const Store = {
  // Getters
  get: (key) => state[key],
  
  getAll: () => ({ ...state }),
  
  // Setters
  set: (key, value) => {
    const oldValue = state[key];
    
    // PERFORMANCE: Cap messages array to prevent unbounded memory growth
    // Keep only the most recent 5000 messages in the in-memory store
    // (full history is preserved in the database)
    if (key === 'messages' && Array.isArray(value) && value.length > 5000) {
      console.log(`[Store] Capping messages from ${value.length} to 5000 (most recent kept)`);
      value = value.slice(-5000);
    }
    
    state[key] = value;
    // Auto-bump message version ONLY when message content actually changes
    // This prevents unnecessary re-renders when incoming messages are identical
    if (key === 'messages') {
      const msgs = value || [];
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      const fingerprint = `${msgs.length}|${lastMsg ? (lastMsg.isFromMe ? '1' : '0') : ''}|${(lastMsg?.text || '').substring(0, 30)}`;
      if (fingerprint !== state.lastMessageFingerprint) {
        state.lastMessageFingerprint = fingerprint;
        state.messageVersion++;
      }
    }
    Store.emit(key, value, oldValue);
  },
  
  // Mark that the renderer has caught up
  markRendered: () => {
    state.lastRenderedVersion = state.messageVersion;
  },
  
  // Check if display is out of sync
  isDisplayStale: () => {
    return state.messageVersion !== state.lastRenderedVersion;
  },
  
  // Batch update
  update: (updates) => {
    Object.entries(updates).forEach(([key, value]) => {
      state[key] = value;
    });
  },
  
  // Event system
  on: (event, callback) => {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(callback);
  },
  
  // Alias for on() - subscribe to state changes
  subscribe: (key, callback) => {
    if (!listeners[key]) listeners[key] = [];
    listeners[key].push(callback);
    // Return unsubscribe function
    return () => {
      listeners[key] = listeners[key].filter(cb => cb !== callback);
    };
  },
  
  off: (event, callback) => {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter(cb => cb !== callback);
  },
  
  emit: (event, ...args) => {
    if (!listeners[event]) return;
    listeners[event].forEach(cb => cb(...args));
  },
  
  // Reset state
  reset: () => {
    state.messages = [];
    state.storedChat = null;
    state.summary = '';
    state.currentSubscriberId = null;
  },
  
  // Operation versioning (prevents race conditions on chat switch)
  // Call this when switching subscribers
  newOperation: () => {
    state.operationVersion++;
    state.isLoadingProgress = true;
    console.log(`[Store] New operation version: ${state.operationVersion}`);
    return state.operationVersion;
  },
  
  // Check if an operation is still valid (hasn't been superseded)
  isOperationValid: (version) => {
    return version === state.operationVersion;
  },
  
  // Mark loading complete
  finishLoading: () => {
    state.isLoadingProgress = false;
  },
  
  // Get current operation version
  getOperationVersion: () => state.operationVersion
};

export default Store;
