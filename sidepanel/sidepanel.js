// ============================================================
// CLARITY NOTES - SIDE PANEL
// Clean Modular Architecture
// ============================================================

// State
import Store from './state/store.js';

// Utils
import { $, $$ } from './utils/dom.js';

// Modules
import { showMainApp, showAuthPanel, setupAuthListeners } from './modules/auth.js';
import { loadProfiles, setupProfileListeners } from './modules/profiles.js';
import { renderChatMessages, setupMessageListener, loadAndSyncChat, setupTabWatcher, setupChatListListeners, forceRefreshSubscriberStats, setupVault, openVault, handleDisplayLangChange } from './modules/chat.js';

import { loadNotes, setupNotesListeners } from './modules/notes.js';
import { loadScripts, renderScriptStages, renderScriptList, setupScriptsListeners } from './modules/scripts/index.js';
import { setupAIListeners } from './modules/ai/index.js';
import { loadSettings, setupSettingsListeners } from './modules/settings.js';
import { loadCredits, setupCreditsListeners } from './modules/credits.js';
import { initPlatform, checkPlatformSelection, showPlatformSelector, hidePlatformSelector } from './modules/platform.js';
import { initAutoChat, renderAutoChatPanel } from './modules/autochat.js';
import { initProfileMenu } from './modules/profileMenu.js';
import { initOFAutoChat, renderOFAutoChatPanel } from './modules/autochat-onlyfans.js';
import { initVoice, renderVoiceGeneratorPanel } from './modules/voice.js';
import { initNotifications } from './modules/notifications.js';
import * as ImagePool from './modules/imagePool.js';
import { triggerCloudSync as triggerVaultCloudSync } from './modules/imagePool.js';
import { initBroadcast, openBroadcastModal, closeBroadcastModal } from './modules/broadcast.js';
import { initLearning, setupLearningListeners } from './modules/learning.js';
import { initSubscriberGroups, renderGroupPicker } from './modules/subscriberGroups.js';


// ============================================================
// TAB SWITCHING
// ============================================================

const switchTab = (tabName) => {
  $$('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  
  ['chat', 'notes', 'scripts', 'vault'].forEach(name => {
    const tab = $(name + 'Tab');
    tab?.classList.toggle('active', name === tabName);
  });
  
  // Show subscriber info bar only on chat tab with messages
  const subscriberInfoBar = $('subscriberInfoBar');
  if (subscriberInfoBar) {
    const showBar = tabName === 'chat' && Store.get('messages').length > 0;
    subscriberInfoBar.classList.toggle('hidden', !showBar);
  }
  
  // Tab-specific actions
  if (tabName === 'notes') {
    loadNotes();
    renderGroupPicker();
  }
  if (tabName === 'scripts') renderScriptList();
  if (tabName === 'vault') openVault();
};

// ============================================================
// SETUP ALL EVENT LISTENERS
// ============================================================

const setupEventListeners = () => {
  // Tab navigation
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  
  // Module listeners
  setupProfileListeners();
  setupNotesListeners();
  setupScriptsListeners();
  setupAIListeners();
  setupSettingsListeners();
  setupCreditsListeners();
  setupChatListListeners();
  
  // Chat display-language dropdown — translate visible messages into chosen language
  $('chatDisplayLangSelect')?.addEventListener('change', (e) => {
    handleDisplayLangChange(e.target.value);
  });
  
  // Media vault
  setupVault();

  
  // Learning module (Save for Training button)
  setupLearningListeners();
  
  // Initialize profile menu and settings panel in chat tab
  initProfileMenu();
  
  // Refresh subscriber info button (Spent / Subscribed)
  $('refreshSubInfoBtn')?.addEventListener('click', () => {
    console.log('[Sidepanel] 🔄 Refresh subscriber stats clicked');
    forceRefreshSubscriberStats();
  });
  
};

// ============================================================
// INITIALIZATION
// ============================================================

// Track if app is fully initialized (prevents double-init from storage listener)
let appInitialized = false;

const init = async () => {
  try {
    // Initialize platform selector listeners first
    await initPlatform();
    
    let user = await FirebaseAuth.checkAuthState();
    
    // RETRY: If auth not ready yet, wait briefly and check again
    // This handles the race condition where sidepanel opens before storage is populated
    if (!user) {
      console.log('[Sidepanel] Auth not ready, retrying in 500ms...');
      await new Promise(r => setTimeout(r, 500));
      user = await FirebaseAuth.checkAuthState();
    }
    if (!user) {
      console.log('[Sidepanel] Auth still not ready, retrying in 1500ms...');
      await new Promise(r => setTimeout(r, 1500));
      user = await FirebaseAuth.checkAuthState();
    }
    
    if (user) {
      appInitialized = true;
      
      // Check if platform is selected AND tab is open
      const hasPlatform = await checkPlatformSelection();
      
      if (!hasPlatform) {
        // Show platform selector - it will handle showing main app after selection
        // Note: showPlatformSelector() is already called inside checkPlatformSelection()
        setupEventListeners();
        setupAuthListeners(); // For logout
        return;
      }
      
      // Platform tab is open - hide selector and show main app
      hidePlatformSelector();
      showMainApp();
      setupEventListeners();
      
      // Load settings first (non-critical)
      try {
        await loadSettings();
      } catch (e) {
        console.error('Settings load error:', e);
      }
      
      // Initialize voice module (loads voice settings)
      try {
        await initVoice();
      } catch (e) {
        console.error('Voice init error:', e);
      }
      
      // Initialize Image Pool BEFORE profiles — profiles.js selectProfile() calls
      // setActiveProfile() which needs imagePool to be initialized first so vault data
      // at the base key gets loaded and properly saved before switching to profile-scoped keys.
      console.log('[Sidepanel] 📸 Initializing Image Pool...');
      await ImagePool.init();
      
      // Load profiles (critical) — selectProfile will call setActiveProfile to scope vault per profile
      try {
        await loadProfiles();
      } catch (e) {
        console.error('Profiles load error:', e);
      }
      
      // Fallback: if no profile was loaded (e.g., zero profiles exist), trigger global vault sync.
      // Normally, loadProfiles → selectProfile → setActiveProfile handles the per-profile sync.
      // But if there are no profiles, no sync ever starts — we need to kick it off manually.
      if (!Store.get('currentProfile')) {
        console.log('[Sidepanel] No profile selected — triggering global vault cloud sync');
        triggerVaultCloudSync();
      }
      
      // Load credits (non-critical)
      try {
        await loadCredits();
      } catch (e) {
        console.error('Credits load error:', e);
      }
      
      // Load scripts (non-critical, can fail silently)
      try {
        await loadScripts();
      } catch (e) {
        console.error('Scripts load error:', e);
      }
      
      // Start chat watching for selected platform
      setupMessageListener();
      setupTabWatcher();
      setTimeout(loadAndSyncChat, 500);
      
      // Get current platform
      const currentPlatform = Store.get('selectedPlatform');
      console.log('[Sidepanel] Current platform:', currentPlatform);
      
      // Initialize Auto-Chat based on platform
      if (currentPlatform === 'telegram') {
        // Initialize Telegram Auto-Chat (refactored module)
        console.log('[Sidepanel] 📱 Initializing Telegram Auto-Chat...');
        initAutoChat();
        renderAutoChatPanel();
        // Hide OF panel
        const ofPanel = $('autoChatPanelOF');
        if (ofPanel) ofPanel.classList.add('hidden');
      } else {
        // Initialize OnlyFans-specific Auto-Chat (default for onlyfans or undefined)
        console.log('[Sidepanel] 🔥 Initializing OF Auto-Chat...');
        initOFAutoChat();
        renderOFAutoChatPanel();
        // Hide Telegram panel
        const telegramPanel = $('autoChatPanel');
        if (telegramPanel) telegramPanel.classList.add('hidden');
        const telegramStatusBar = $('autoChatStatusBar');
        if (telegramStatusBar) telegramStatusBar.classList.add('hidden');
      }
      
      // Initialize global notification system
      console.log('[Sidepanel] 🔔 Initializing notifications...');
      initNotifications();
      
      // Show Image Pool only for Telegram platform (init already done above, before loadProfiles)
      if (currentPlatform === 'telegram') {
        ImagePool.show();
      } else {
        ImagePool.hide();
      }
      
      // Initialize Subscriber Groups (localStorage-backed, must be before Broadcast)
      console.log('[Sidepanel] 👥 Initializing Subscriber Groups...');
      initSubscriberGroups();
      
      // Initialize Broadcast module
      console.log('[Sidepanel] 📢 Initializing Broadcast...');
      initBroadcast();
      
      // Broadcast button & modal listeners
      $('broadcastBtn')?.addEventListener('click', openBroadcastModal);
      $('broadcastCloseBtn')?.addEventListener('click', closeBroadcastModal);
      document.querySelector('.broadcast-backdrop')?.addEventListener('click', closeBroadcastModal);
      
      // Initialize Learning module (admin-only, shows 📚 save button)
      console.log('[Sidepanel] 🧠 Initializing Learning...');
      try {
        await initLearning();
      } catch (e) {
        console.error('Learning init error:', e);
      }
    } else {

      showAuthPanel();
      setupAuthListeners();
    }
  } catch (error) {
    console.error('Init error:', error);
    showAuthPanel();
    setupAuthListeners();
  }
};

// ============================================================
// BOOTSTRAP
// ============================================================

// Function to start chat watching after platform is selected
export const startChatWatching = () => {
  setupMessageListener();
  setupTabWatcher();
  setTimeout(loadAndSyncChat, 500);
};

// ============================================================
// TAB DISCONNECTION LISTENER
// Auto-switch to platform selector when all platform tabs close
// ============================================================

const setupTabDisconnectListener = () => {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'NO_SUPPORTED_TABS') {
      console.log('[Sidepanel] Platform tabs closed - switching to platform selector');
      
      // Clear current chat data
      Store.set('messages', []);
      Store.set('currentSubscriberId', null);
      Store.set('storedChat', null);
      Store.set('currentNotes', null);
      
      // Clear the chat display
      const chatMessages = $('chatMessages');
      if (chatMessages) {
        chatMessages.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">📡</div>
            <p>Platform disconnected</p>
            <small>Select a platform to continue</small>
          </div>
        `;
      }
      
      // Hide subscriber info bar
      $('subscriberInfoBar')?.classList.add('hidden');
      
      // Clear the progress display
      const progressCounter = $('progressCounter');
      if (progressCounter) progressCounter.textContent = '0/0';
      
      const progressBar = $('progressBar');
      if (progressBar) progressBar.style.width = '0%';
      
      // Show platform selector
      showPlatformSelector();
    }
  });
};

// ============================================================
// AUTH STATE CHANGE LISTENER
// Watches chrome.storage for auth changes — handles the race condition
// where sidepanel opens before login completes. When firebaseUser
// appears in storage, we re-initialize the entire app.
// ============================================================

const setupAuthStateListener = () => {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    
    // User just logged in — firebaseUser was set
    if (changes.firebaseUser?.newValue && !appInitialized) {
      console.log('[Sidepanel] 🔑 Auth state changed — user logged in, reinitializing...');
      init();
    }
    
    // User just logged out — firebaseUser was removed
    if (changes.firebaseUser && !changes.firebaseUser.newValue && appInitialized) {
      console.log('[Sidepanel] 🔒 Auth state changed — user logged out');
      appInitialized = false;
      showAuthPanel();
      setupAuthListeners();
    }
  });
};

document.addEventListener('DOMContentLoaded', () => {
  init();
  setupTabDisconnectListener();
  setupAuthStateListener();
  // Note: setupTabWatcher is now called inside init() ONLY if platform is already selected
});
