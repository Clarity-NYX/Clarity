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
    state[key] = value;
    Store.emit(key, value, oldValue);
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
