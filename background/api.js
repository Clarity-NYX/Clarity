// ============================================================
// API SERVICE - Calls secure backend
// With Retry Logic for Network Resilience
// ============================================================

import { CONFIG } from './config.js';

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 3,           // Maximum number of retry attempts
  baseDelay: 1000,         // Base delay in ms (1 second)
  maxDelay: 10000,         // Maximum delay in ms (10 seconds)
  retryableStatuses: [408, 429, 500, 502, 503, 504], // HTTP statuses to retry
};

// Sleep helper for retry delays
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Calculate delay with exponential backoff + jitter
const calculateRetryDelay = (attempt) => {
  const exponentialDelay = RETRY_CONFIG.baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 500; // Add 0-500ms random jitter
  return Math.min(exponentialDelay + jitter, RETRY_CONFIG.maxDelay);
};

// Check if error is retryable network error
const isRetryableError = (error) => {
  if (!error) return false;
  const msg = error.message?.toLowerCase() || '';
  return msg.includes('fetch') || 
         msg.includes('network') || 
         msg.includes('timeout') ||
         msg.includes('connection');
};

export const API = {
  async getAuthToken() {
    return new Promise(async (resolve) => {
      const result = await chrome.storage.local.get(['firebaseUser']);
      const user = result.firebaseUser;
      
      if (!user?.idToken) {
        resolve(null);
        return;
      }
      
      try {
        const payload = JSON.parse(atob(user.idToken.split('.')[1]));
        const expiresAt = payload.exp * 1000;
        const now = Date.now();
        
        if (expiresAt - now < 5 * 60 * 1000) {
          const newToken = await this.refreshToken(user.refreshToken);
          resolve(newToken);
          return;
        }
      } catch (e) {
        console.log('Could not decode token, trying anyway');
      }
      
      resolve(user.idToken);
    });
  },

  async refreshToken(refreshToken) {
    if (!refreshToken) return null;
    
    try {
      // Call server auth endpoint (no exposed API key!)
      const response = await fetch(`${CONFIG.API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      });
      
      const data = await response.json();
      if (!response.ok || !data.success) {
        console.log('[API] Token refresh failed:', data.error);
        return null;
      }
      
      const result = await chrome.storage.local.get(['firebaseUser']);
      const user = result.firebaseUser;
      if (user) {
        user.idToken = data.idToken;
        user.refreshToken = data.refreshToken;
        await chrome.storage.local.set({ firebaseUser: user });
      }
      
      return data.idToken;
    } catch (error) {
      console.error('[API] Token refresh error:', error);
      return null;
    }
  },

  async request(endpoint, options = {}) {
    let token = await this.getAuthToken();
    if (!token) throw new Error('Please sign in to continue');
    
    const maxRetries = RETRY_CONFIG.maxRetries;
    let lastError = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        let response = await fetch(`${CONFIG.API_URL}${endpoint}`, {
          ...options,
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...options.headers }
        });
        
        let data = await response.json().catch(() => ({ error: 'Invalid response' }));
        
        // Handle token expiration
        if (response.status === 401 && data.message?.includes('expired')) {
          const result = await chrome.storage.local.get(['firebaseUser']);
          token = await this.refreshToken(result.firebaseUser?.refreshToken);
          
          if (token) {
            response = await fetch(`${CONFIG.API_URL}${endpoint}`, {
              ...options,
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...options.headers }
            });
            data = await response.json().catch(() => ({ error: 'Invalid response' }));
          }
        }
        
        // Check for retryable HTTP status
        if (!response.ok) {
          const shouldRetry = attempt < maxRetries && 
                             RETRY_CONFIG.retryableStatuses.includes(response.status);
          
          if (shouldRetry) {
            const delay = calculateRetryDelay(attempt);
            console.warn(`[API] Request to ${endpoint} failed with ${response.status}, retrying in ${delay}ms... (${attempt + 1}/${maxRetries})`);
            await sleep(delay);
            continue;
          }
          
          throw new Error(data.error || data.message || `Request failed: ${response.status}`);
        }
        
        // Success!
        if (attempt > 0) {
          console.log(`[API] Request to ${endpoint} succeeded after ${attempt} retries`);
        }
        
        return data;
        
      } catch (error) {
        lastError = error;
        
        // Check if this is a retryable network error
        const shouldRetry = attempt < maxRetries && isRetryableError(error);
        
        if (shouldRetry) {
          const delay = calculateRetryDelay(attempt);
          console.warn(`[API] Network error on ${endpoint}: ${error.message}, retrying in ${delay}ms... (${attempt + 1}/${maxRetries})`);
          await sleep(delay);
          continue;
        }
        
        // Not retryable or out of retries
        throw error;
      }
    }
    
    // Should not reach here, but just in case
    throw lastError || new Error('Request failed after retries');
  },

  // AI endpoints
  generateResponse: (data) => API.request('/ai/generate', { method: 'POST', body: JSON.stringify(data) }),
  summarizeConversation: (messages) => API.request('/ai/summarize', { method: 'POST', body: JSON.stringify({ messages }) }),
  extractInfo: (messages) => API.request('/ai/extract', { method: 'POST', body: JSON.stringify({ messages }) }),
  checkGoal: (data) => API.request('/ai/check-goal', { method: 'POST', body: JSON.stringify(data) }),
  validateResponse: (data) => API.request('/ai/validate-response', { method: 'POST', body: JSON.stringify(data) }),
  generateScript: (data) => API.request('/ai/generate-script', { method: 'POST', body: JSON.stringify(data) }),
  getScriptCategories: () => API.request('/ai/script-categories'),

  // Credits
  getCredits: () => API.request('/credits'),
  getPackages: () => API.request('/packages'),
  mockPurchase: (packageId) => API.request('/credits/mock-purchase', { method: 'POST', body: JSON.stringify({ packageId }) }),

  // Profiles
  getProfiles: () => API.request('/profiles'),
  getProfile: (id) => API.request(`/profiles/${id}`),
  createProfile: (data) => API.request('/profiles', { method: 'POST', body: JSON.stringify(data) }),
  updateProfile: (id, data) => API.request(`/profiles/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteProfile: (id) => API.request(`/profiles/${id}`, { method: 'DELETE' }),

  // Chats
  getChat: (profileId, subId) => API.request(`/profiles/${profileId}/chats/${subId}`),
  saveChat: (profileId, subId, data) => API.request(`/profiles/${profileId}/chats/${subId}`, { method: 'PUT', body: JSON.stringify(data) }),
  syncChat: (profileId, subId, data) => API.request(`/profiles/${profileId}/chats/${subId}/sync`, { method: 'POST', body: JSON.stringify(data) }),
  getChatNotes: (profileId, subId) => API.request(`/profiles/${profileId}/chats/${subId}/notes`),
  saveChatNotes: (profileId, subId, notes) => API.request(`/profiles/${profileId}/chats/${subId}/notes`, { method: 'PUT', body: JSON.stringify({ notes }) }),
  getChats: (profileId) => API.request(`/profiles/${profileId}/chats`),

  // Scripts
  getGlobalScripts: () => API.request('/scripts'),
  getProfileScripts: (profileId) => API.request(`/scripts/profiles/${profileId}/scripts`),
  createGlobalScript: (data) => API.request('/scripts', { method: 'POST', body: JSON.stringify(data) }),
  createProfileScript: (profileId, data) => API.request(`/scripts/profiles/${profileId}/scripts`, { method: 'POST', body: JSON.stringify(data) }),
  updateGlobalScript: (id, data) => API.request(`/scripts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  updateProfileScript: (profileId, id, data) => API.request(`/scripts/profiles/${profileId}/scripts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteGlobalScript: (id) => API.request(`/scripts/${id}`, { method: 'DELETE' }),
  deleteProfileScript: (profileId, id) => API.request(`/scripts/profiles/${profileId}/scripts/${id}`, { method: 'DELETE' }),
  copyScriptToProfile: (scriptId, profileId) => API.request('/scripts/copy-to-profile', { method: 'POST', body: JSON.stringify({ scriptId, profileId }) }),
  copyScriptToTemplates: (scriptId, profileId) => API.request('/scripts/copy-to-templates', { method: 'POST', body: JSON.stringify({ scriptId, profileId }) }),
  copyAllTemplatesToProfile: (profileId) => API.request(`/scripts/copy-all-to-profile/${profileId}`, { method: 'POST' }),

  // Usage
  getTotalUsage: () => API.request('/usage/total'),
  resetUsage: () => API.request('/usage/reset', { method: 'DELETE' }),

  // Blocked Users
  getBlockedUsers: (profileId) => API.request(`/ai/blocked-users/${profileId}`),
  addBlockedUser: (profileId, subscriberId, subscriberName, reason) => 
    API.request(`/ai/blocked-users/${profileId}`, { 
      method: 'POST', 
      body: JSON.stringify({ subscriberId, subscriberName, reason }) 
    }),
  removeBlockedUser: (profileId, subscriberId) => 
    API.request(`/ai/blocked-users/${profileId}/${subscriberId}`, { method: 'DELETE' }),

  // AI Situational Classification
  classifySituational: (message, enabledPresets) => 
    API.request('/ai/classify-situational', { 
      method: 'POST', 
      body: JSON.stringify({ message, enabledPresets }) 
    }),

  // AI Image Selection from Pool
  selectBestImage: (userMessage, imageList) => 
    API.request('/ai/select-image', { 
      method: 'POST', 
      body: JSON.stringify({ userMessage, imageList }) 
    }),

  // AI-Generated Image Caption
  generateImageCaption: (data) => 
    API.request('/ai/generate-image-caption', { 
      method: 'POST', 
      body: JSON.stringify(data) 
    })
};
