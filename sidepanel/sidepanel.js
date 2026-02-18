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
import { renderChatMessages, setupMessageListener, loadAndSyncChat, setupTabWatcher, setupChatListListeners } from './modules/chat.js';
import { loadNotes, setupNotesListeners } from './modules/notes.js';
import { loadScripts, renderScriptStages, renderScriptList, setupScriptsListeners } from './modules/scripts/index.js';
import { setupAIListeners } from './modules/ai.js';
import { loadSettings, setupSettingsListeners } from './modules/settings.js';
import { loadCredits, setupCreditsListeners } from './modules/credits.js';
import { initPlatform, checkPlatformSelection, showPlatformSelector, hidePlatformSelector } from './modules/platform.js';
import { initAutoChat, renderAutoChatPanel } from './modules/autochat.js';
import { initProfileMenu } from './modules/profileMenu.js';
import { initOFAutoChat, renderOFAutoChatPanel } from './modules/autochat-onlyfans.js';
import { initVoice, renderVoiceGeneratorPanel } from './modules/voice.js';
import { initNotifications } from './modules/notifications.js';
import * as ImagePool from './modules/imagePool.js';

// ============================================================
// TAB SWITCHING
// ============================================================

const switchTab = (tabName) => {
  $$('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  
  ['chat', 'notes', 'scripts'].forEach(name => {
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
  if (tabName === 'notes') loadNotes();
  if (tabName === 'scripts') renderScriptList();
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
  
  // Initialize profile menu and settings panel in chat tab
  initProfileMenu();
};

// ============================================================
// INITIALIZATION
// ============================================================

const init = async () => {
  try {
    // Initialize platform selector listeners first
    await initPlatform();
    
    const user = await FirebaseAuth.checkAuthState();
    
    if (user) {
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
      
      // Load profiles (critical)
      try {
        await loadProfiles();
      } catch (e) {
        console.error('Profiles load error:', e);
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
      
      // Initialize Image Pool (for Telegram)
      console.log('[Sidepanel] 📸 Initializing Image Pool...');
      ImagePool.init();
      
      // Show Image Pool only for Telegram platform
      if (currentPlatform === 'telegram') {
        ImagePool.show();
      } else {
        ImagePool.hide();
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

document.addEventListener('DOMContentLoaded', () => {
  init();
  setupTabDisconnectListener();
  // Note: setupTabWatcher is now called inside init() ONLY if platform is already selected
});
