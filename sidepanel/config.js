// ============================================================
// EXTENSION CONFIGURATION
// ============================================================

// API Configuration - Production Only
const CONFIG = {
  // Production API URL (Heroku)
  API_URL: 'https://clarity-notes-api-0a5da158d2ca.herokuapp.com/api',
  
  // App info
  APP_NAME: 'Clarity',
  APP_VERSION: '1.0.0'
};

// Export for use in other modules
window.ClarityConfig = CONFIG;
