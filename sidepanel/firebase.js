// Clarity Notes - Firebase Authentication
// Server-proxied implementation (no exposed API key)

// API URL from config or default
const API_URL = 'https://clarity-notes-api-0a5da158d2ca.herokuapp.com/api';

const ERROR_MESSAGES = {
  EMAIL_NOT_FOUND: 'No account found with this email',
  INVALID_PASSWORD: 'Incorrect password',
  USER_DISABLED: 'This account has been disabled',
  EMAIL_EXISTS: 'An account already exists with this email',
  OPERATION_NOT_ALLOWED: 'Email/password sign-in is disabled',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Try again later',
  WEAK_PASSWORD: 'Password should be at least 6 characters',
  INVALID_EMAIL: 'Invalid email address',
  INVALID_LOGIN_CREDENTIALS: 'Invalid email or password'
};

let currentUser = null;

const FirebaseAuth = {
  /**
   * Sign in with email and password
   * @param {string} email 
   * @param {string} password 
   * @returns {Promise<object>} User object
   */
  async signIn(email, password) {
    try {
      const response = await fetch(`${API_URL}/auth/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await response.json();
      
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Sign in failed');
      }

      currentUser = {
        uid: data.uid,
        email: data.email,
        idToken: data.idToken,
        refreshToken: data.refreshToken
      };

      await chrome.storage.local.set({ firebaseUser: currentUser });
      return currentUser;
    } catch (error) {
      console.error('[FirebaseAuth] Sign in error:', error);
      throw error;
    }
  },

  /**
   * Register new account with email and password
   * @param {string} email 
   * @param {string} password 
   * @returns {Promise<object>} User object
   */
  async register(email, password) {
    try {
      const response = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await response.json();
      
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Registration failed');
      }

      currentUser = {
        uid: data.uid,
        email: data.email,
        idToken: data.idToken,
        refreshToken: data.refreshToken
      };

      await chrome.storage.local.set({ firebaseUser: currentUser });
      return currentUser;
    } catch (error) {
      console.error('[FirebaseAuth] Registration error:', error);
      throw error;
    }
  },

  /**
   * Sign out current user
   */
  async signOut() {
    currentUser = null;
    await chrome.storage.local.remove('firebaseUser');
  },

  /**
   * Get current user (from memory)
   */
  getCurrentUser: () => currentUser,

  /**
   * Check auth state from storage
   */
  async checkAuthState() {
    try {
      const result = await chrome.storage.local.get(['firebaseUser']);
      currentUser = result.firebaseUser || null;
      return currentUser;
    } catch (error) {
      console.error('[FirebaseAuth] Check auth state error:', error);
      return null;
    }
  },

  /**
   * Refresh expired token
   * @returns {Promise<object|null>} Updated user or null
   */
  async refreshToken() {
    if (!currentUser?.refreshToken) return null;

    try {
      const response = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: currentUser.refreshToken })
      });

      const data = await response.json();
      
      if (!response.ok || !data.success) {
        // Token is invalid - sign out
        if (data.requiresReauth) {
          await this.signOut();
        }
        return null;
      }

      currentUser.idToken = data.idToken;
      currentUser.refreshToken = data.refreshToken;
      await chrome.storage.local.set({ firebaseUser: currentUser });
      return currentUser;
    } catch (error) {
      console.error('[FirebaseAuth] Token refresh error:', error);
      return null;
    }
  },

  /**
   * Send password reset email
   * @param {string} email 
   * @returns {Promise<object>} Result
   */
  async sendPasswordResetEmail(email) {
    try {
      const response = await fetch(`${API_URL}/auth/password-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('[FirebaseAuth] Password reset error:', error);
      return { success: true, message: 'If an account exists, a reset link has been sent.' };
    }
  }
};

window.FirebaseAuth = FirebaseAuth;
