// ============================================================
// API UTILITIES - Chrome Runtime Message Wrapper
// With Retry Logic for Network Resilience
// ============================================================

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 3,           // Maximum number of retry attempts
  baseDelay: 1000,         // Base delay in ms (1 second)
  maxDelay: 10000,         // Maximum delay in ms (10 seconds)
  retryableStatuses: [408, 429, 500, 502, 503, 504], // HTTP statuses to retry
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ENETUNREACH', 'FETCH_ERROR']
};

// Sleep helper for retry delays
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Calculate delay with exponential backoff + jitter
const calculateRetryDelay = (attempt) => {
  const exponentialDelay = RETRY_CONFIG.baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 500; // Add 0-500ms random jitter
  return Math.min(exponentialDelay + jitter, RETRY_CONFIG.maxDelay);
};

// Check if error is retryable
const isRetryableError = (error) => {
  if (!error) return false;
  
  // Network errors
  if (error.name === 'TypeError' && error.message?.includes('fetch')) return true;
  if (error.name === 'NetworkError') return true;
  if (error.message?.includes('network') || error.message?.includes('Network')) return true;
  if (error.message?.includes('Failed to fetch')) return true;
  
  // Connection errors
  for (const errCode of RETRY_CONFIG.retryableErrors) {
    if (error.message?.includes(errCode)) return true;
  }
  
  return false;
};

// Production API URL (hardcoded - always use this)
const API_BASE_URL = 'https://clarity-notes-api-0a5da158d2ca.herokuapp.com/api';

// Send message to background script
export const sendMessage = (type, data = {}) => {
  return chrome.runtime.sendMessage({ type, data });
};

// Make direct HTTP request to API server with retry logic
export const apiRequest = async (endpoint, options = {}) => {
  const { maxRetries = RETRY_CONFIG.maxRetries, retryEnabled = true } = options;
  
  // Get auth token from global FirebaseAuth (defined in firebase.js)
  let token = null;
  try {
    if (typeof FirebaseAuth !== 'undefined') {
      const user = FirebaseAuth.getCurrentUser();
      if (user?.idToken) {
        token = user.idToken;
      }
    }
  } catch (e) {
    console.warn('Could not get Firebase token:', e.message);
  }
  
  const headers = {
    'Content-Type': 'application/json',
    ...(token && { 'Authorization': `Bearer ${token}` }),
    ...(options.headers || {})
  };
  
  let lastError = null;
  
  for (let attempt = 0; attempt <= (retryEnabled ? maxRetries : 0); attempt++) {
    try {
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: options.method || 'GET',
        headers,
        body: options.body
      });
      
      // Check if we should retry based on status code
      if (!response.ok) {
        const shouldRetry = retryEnabled && 
                           attempt < maxRetries && 
                           RETRY_CONFIG.retryableStatuses.includes(response.status);
        
        if (shouldRetry) {
          const delay = calculateRetryDelay(attempt);
          console.warn(`[API] Request failed with ${response.status}, retrying in ${delay}ms... (${attempt + 1}/${maxRetries})`);
          await sleep(delay);
          continue;
        }
        
        // Not retryable or out of retries - throw error
        const error = await response.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(error.error || error.message || `Request failed: ${response.status}`);
      }
      
      // Success!
      if (attempt > 0) {
        console.log(`[API] Request succeeded after ${attempt} retries`);
      }
      
      return response.json();
      
    } catch (error) {
      lastError = error;
      
      // Check if this is a retryable network error
      const shouldRetry = retryEnabled && 
                         attempt < maxRetries && 
                         isRetryableError(error);
      
      if (shouldRetry) {
        const delay = calculateRetryDelay(attempt);
        console.warn(`[API] Network error: ${error.message}, retrying in ${delay}ms... (${attempt + 1}/${maxRetries})`);
        await sleep(delay);
        continue;
      }
      
      // Not retryable or out of retries
      throw error;
    }
  }
  
  // Should not reach here, but just in case
  throw lastError || new Error('Request failed after retries');
};

// Convenience wrapper for requests that shouldn't retry (e.g., POST mutations)
export const apiRequestNoRetry = (endpoint, options = {}) => {
  return apiRequest(endpoint, { ...options, retryEnabled: false });
};

// Platform detection
export const detectPlatform = (url) => {
  if (!url) return null;
  if (url.includes('onlyfans.com')) return 'onlyfans';
  if (url.includes('web.telegram.org')) return 'telegram';
  return null;
};

// Get current platform from active tab
export const getCurrentPlatform = () => {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(detectPlatform(tabs[0]?.url));
    });
  });
};

// Get subscriber ID from current tab URL (supports both platforms)
export const getSubscriberIdFromTab = () => {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.url) {
        resolve(null);
        return;
      }
      
      const url = tabs[0].url;
      const platform = detectPlatform(url);
      
      if (platform === 'onlyfans') {
        // OnlyFans: /my/chats/chat/{id}
        const match = url.match(/\/chat\/(\d+)/);
        const id = match?.[1] || null;
        resolve(id ? { platform: 'onlyfans', id, fullId: `of:${id}` } : null);
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
        
        resolve(id ? { platform: 'telegram', id, fullId: `tg:${id}` } : null);
      } else {
        resolve(null);
      }
    });
  });
};

// Request messages from content script (works for both platforms)
export const requestChatFromPage = () => {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        console.log('[API] requestChatFromPage error:', chrome.runtime.lastError);
        resolve(null);
        return;
      }
      
      const url = tabs[0]?.url;
      const platform = detectPlatform(url);
      
      console.log('[API] requestChatFromPage - URL:', url, 'Platform:', platform);
      
      if (!platform) {
        console.log('[API] No supported platform detected');
        resolve(null);
        return;
      }
      
      console.log('[API] Sending GET_MESSAGES to tab:', tabs[0].id);
      
      chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_MESSAGES' }, (response) => {
        if (chrome.runtime.lastError) {
          console.log('[API] GET_MESSAGES error:', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        console.log('[API] GET_MESSAGES response:', response);
        resolve(response);
      });
    });
  });
};

// Check if current tab is OnlyFans
export const isOnlyFansTab = async () => {
  const platform = await getCurrentPlatform();
  return platform === 'onlyfans';
};

// Check if current tab is Telegram
export const isTelegramTab = async () => {
  const platform = await getCurrentPlatform();
  return platform === 'telegram';
};

// Check if current tab is a supported platform
export const isSupportedPlatform = async () => {
  const platform = await getCurrentPlatform();
  return platform !== null;
};

// API endpoints
export const API = {
  // Profiles
  getProfiles: () => sendMessage('GET_PROFILES'),
  createProfile: (data) => sendMessage('CREATE_PROFILE', data),
  updateProfile: (data) => sendMessage('UPDATE_PROFILE', data),
  deleteProfile: (data) => sendMessage('DELETE_PROFILE', data),
  
  // Chats
  getChat: (profileId, subscriberId) => sendMessage('GET_CHAT', { profileId, subscriberId }),
  getChats: (profileId) => sendMessage('GET_CHATS', { profileId }),
  saveChat: (data) => sendMessage('SAVE_CHAT', data),
  syncChat: (data) => sendMessage('SYNC_CHAT', data),
  getChatNotes: (data) => sendMessage('GET_CHAT_NOTES', data),
  saveChatNotes: (data) => sendMessage('SAVE_CHAT_NOTES', data),
  
  // AI
  generateResponse: (data) => sendMessage('GENERATE_RESPONSE', data),
  extractInfo: (data) => sendMessage('EXTRACT_INFO', data),
  summarize: (data) => sendMessage('SUMMARIZE_CONVERSATION', data),
  checkGoal: (data) => sendMessage('CHECK_GOAL', data),
  validateResponse: (data) => sendMessage('VALIDATE_RESPONSE', data),
  generateImageCaption: (data) => sendMessage('GENERATE_IMAGE_CAPTION', data),
  
  // Stats
  fetchSubscriberStats: (subscriberId) => sendMessage('FETCH_SUBSCRIBER_STATS', { subscriberId }),
  
  // ============================================================
  // SCRIPTS API
  // ============================================================
  
  // Global templates (shared across profiles)
  getGlobalScripts: () => sendMessage('GET_GLOBAL_SCRIPTS'),
  createGlobalScript: (data) => sendMessage('CREATE_GLOBAL_SCRIPT', data),
  updateGlobalScript: (data) => sendMessage('UPDATE_GLOBAL_SCRIPT', data),
  deleteGlobalScript: (scriptId) => sendMessage('DELETE_GLOBAL_SCRIPT', { scriptId }),
  
  // Profile-specific scripts
  getProfileScripts: (profileId) => sendMessage('GET_PROFILE_SCRIPTS', { profileId }),
  createProfileScript: (data) => sendMessage('CREATE_PROFILE_SCRIPT', data),
  updateProfileScript: (data) => sendMessage('UPDATE_PROFILE_SCRIPT', data),
  deleteProfileScript: (data) => sendMessage('DELETE_PROFILE_SCRIPT', data),
  
  // Copy operations
  copyScriptToProfile: (scriptId, profileId) => sendMessage('COPY_SCRIPT_TO_PROFILE', { scriptId, profileId }),
  copyScriptToTemplates: (scriptId, profileId) => sendMessage('COPY_SCRIPT_TO_TEMPLATES', { scriptId, profileId }),
  copyAllTemplatesToProfile: (profileId) => sendMessage('COPY_ALL_TEMPLATES_TO_PROFILE', { profileId }),
  
  // Credits
  getCredits: () => sendMessage('GET_CREDITS'),
  addCredits: (data) => sendMessage('ADD_CREDITS', data),
  mockPurchase: (packageId) => sendMessage('MOCK_PURCHASE', { packageId }),
  
  // Packages
  getPackages: () => sendMessage('GET_PACKAGES'),
  
  // Usage
  getTotalUsage: () => sendMessage('GET_TOTAL_USAGE'),
  resetUsage: () => sendMessage('RESET_USAGE'),
  
  // AI Script Generation
  generateScript: (data) => sendMessage('GENERATE_SCRIPT', data),
  getScriptCategories: () => sendMessage('GET_SCRIPT_CATEGORIES'),
  
  // ============================================================
  // BLOCKED USERS API
  // ============================================================
  getBlockedUsers: (profileId) => sendMessage('GET_BLOCKED_USERS', { profileId }),
  addBlockedUser: (data) => sendMessage('ADD_BLOCKED_USER', data),
  removeBlockedUser: (data) => sendMessage('REMOVE_BLOCKED_USER', data),
  
  // Convenience method for blocking subscriber (used by bot detection)
  blockSubscriber: (profileId, subscriberId, subscriberName, reason) => 
    sendMessage('ADD_BLOCKED_USER', { profileId, subscriberId, subscriberName, reason }),
  
  // ============================================================
  // SCRIPT PROGRESS API - Direct HTTP for reliability
  // ============================================================
  
  // Get script progress for a subscriber (direct HTTP call)
  getScriptProgress: async ({ profileId, subscriberId, scriptId }) => {
    if (!profileId || !subscriberId || !scriptId) {
      return { success: false, error: 'Missing required parameters' };
    }
    try {
      // URL-encode IDs to handle colons (tg:123) and special characters
      const encProfileId = encodeURIComponent(profileId);
      const encSubscriberId = encodeURIComponent(subscriberId);
      const encScriptId = encodeURIComponent(scriptId);
      return await apiRequest(`/scripts/profiles/${encProfileId}/subscribers/${encSubscriberId}/progress/${encScriptId}`);
    } catch (error) {
      console.error('[API] getScriptProgress error:', error);
      return { success: false, error: error.message };
    }
  },
  
  // Save script progress immediately (direct HTTP call - no debounce)
  saveScriptProgress: async ({ profileId, subscriberId, scriptId, completed, scriptName }) => {
    if (!profileId || !subscriberId || !scriptId) {
      return { success: false, error: 'Missing required parameters' };
    }
    try {
      // URL-encode IDs to handle colons (tg:123) and special characters
      const encProfileId = encodeURIComponent(profileId);
      const encSubscriberId = encodeURIComponent(subscriberId);
      const encScriptId = encodeURIComponent(scriptId);
      return await apiRequest(`/scripts/profiles/${encProfileId}/subscribers/${encSubscriberId}/progress/${encScriptId}`, {
        method: 'PUT',
        body: JSON.stringify({ completed, scriptName })
      });
    } catch (error) {
      console.error('[API] saveScriptProgress error:', error);
      return { success: false, error: error.message };
    }
  },
  
  // Get all progress for a subscriber (all scripts)
  getAllScriptProgress: async ({ profileId, subscriberId }) => {
    if (!profileId || !subscriberId) {
      return { success: false, error: 'Missing required parameters' };
    }
    try {
      // URL-encode IDs to handle colons (tg:123) and special characters
      const encProfileId = encodeURIComponent(profileId);
      const encSubscriberId = encodeURIComponent(subscriberId);
      return await apiRequest(`/scripts/profiles/${encProfileId}/subscribers/${encSubscriberId}/progress`);
    } catch (error) {
      console.error('[API] getAllScriptProgress error:', error);
      return { success: false, error: error.message };
    }
  },
  
  // Clear/reset progress for a subscriber + script
  clearScriptProgress: async ({ profileId, subscriberId, scriptId }) => {
    if (!profileId || !subscriberId || !scriptId) {
      return { success: false, error: 'Missing required parameters' };
    }
    try {
      // URL-encode IDs to handle colons (tg:123) and special characters
      const encProfileId = encodeURIComponent(profileId);
      const encSubscriberId = encodeURIComponent(subscriberId);
      const encScriptId = encodeURIComponent(scriptId);
      return await apiRequest(`/scripts/profiles/${encProfileId}/subscribers/${encSubscriberId}/progress/${encScriptId}`, {
        method: 'DELETE'
      });
    } catch (error) {
      console.error('[API] clearScriptProgress error:', error);
      return { success: false, error: error.message };
    }
  }
};

export default API;
