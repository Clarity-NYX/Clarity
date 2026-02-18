// ============================================================
// PLATFORM MODULE - Handle platform selection
// ============================================================

import Store from '../state/store.js';
import { $ } from '../utils/dom.js';

// Available platforms
export const PLATFORMS = {
  onlyfans: {
    id: 'onlyfans',
    name: 'OnlyFans',
    url: 'onlyfans.com',
    icon: '💙',
    color: '#00AFF0'
  },
  telegram: {
    id: 'telegram',
    name: 'Telegram',
    url: 'web.telegram.org',
    icon: '📱',
    color: '#0088cc'
  },
  snapchat: {
    id: 'snapchat',
    name: 'Snapchat',
    url: 'web.snapchat.com',
    icon: '👻',
    color: '#FFFC00',
    comingSoon: true
  },
  instagram: {
    id: 'instagram',
    name: 'Instagram',
    url: 'instagram.com',
    icon: '📷',
    color: '#E1306C',
    comingSoon: true
  }
};

// Get stored platform
export const getStoredPlatform = async () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['selectedPlatform'], (result) => {
      resolve(result.selectedPlatform || null);
    });
  });
};

// Save selected platform
export const setStoredPlatform = async (platform) => {
  return new Promise((resolve) => {
    chrome.storage.local.set({ selectedPlatform: platform }, () => {
      Store.set('selectedPlatform', platform);
      resolve();
    });
  });
};

// Show platform selector
export const showPlatformSelector = () => {
  console.log('[Platform] Showing platform selector');
  
  const selector = $('platformSelector');
  if (selector) {
    selector.classList.remove('hidden');
  }
  
  // Hide auth panel
  const authPanel = document.getElementById('authPanel');
  if (authPanel) {
    authPanel.classList.add('hidden');
  }
  
  // Hide main content areas
  document.querySelector('.header')?.classList.add('hidden');
  document.querySelector('.tab-nav')?.classList.add('hidden');
  document.querySelector('.main-content')?.classList.add('hidden');
  document.querySelector('.footer')?.classList.add('hidden');
};

// Hide platform selector and show main content
export const hidePlatformSelector = () => {
  const selector = $('platformSelector');
  if (selector) {
    selector.classList.add('hidden');
  }
  
  // Show main content areas
  document.querySelector('.header')?.classList.remove('hidden');
  document.querySelector('.tab-nav')?.classList.remove('hidden');
  document.querySelector('.main-content')?.classList.remove('hidden');
  document.querySelector('.footer')?.classList.remove('hidden');
};

// Handle platform card click
const handlePlatformSelect = async (platform) => {
  if (PLATFORMS[platform]?.comingSoon) {
    return; // Don't allow selecting coming soon platforms
  }
  
  console.log('[Platform] Selected:', platform);
  
  // Save selection
  await setStoredPlatform(platform);
  
  // Open the platform's website in a new tab
  const platformInfo = PLATFORMS[platform];
  if (platformInfo) {
    let url;
    if (platform === 'onlyfans') {
      url = 'https://onlyfans.com/my/chats';
    } else if (platform === 'telegram') {
      url = 'https://web.telegram.org/a/';
    } else {
      url = 'https://' + platformInfo.url;
    }
    
    // Open in new tab
    chrome.tabs.create({ url });
  }
  
  // Hide selector and show main UI
  hidePlatformSelector();
  
  // Update UI to reflect selected platform
  updatePlatformUI(platform);
  
  // Dynamically import and start chat watching
  try {
    const { startChatWatching } = await import('../sidepanel.js');
    startChatWatching();
  } catch (e) {
    console.error('[Platform] Failed to start chat watching:', e);
  }
  
  // Start tab watcher for the selected platform
  const { setupTabWatcher } = await import('./chat.js');
  setupTabWatcher();
};

// Update UI based on selected platform
export const updatePlatformUI = (platform) => {
  const platformInfo = PLATFORMS[platform];
  if (!platformInfo) return;
  
  console.log('[Platform] updatePlatformUI called for:', platform);
  
  // ===== CRITICAL: Set body class FIRST for CSS and JS platform detection =====
  // Remove all platform classes first
  document.body.classList.remove('telegram-platform', 'onlyfans-platform', 'snapchat-platform', 'instagram-platform');
  // Add the current platform class
  document.body.classList.add(`${platform}-platform`);
  console.log('[Platform] Body class set:', document.body.className);
  
  // Update empty state text based on platform
  const emptyStates = document.querySelectorAll('.empty-state small');
  emptyStates.forEach(el => {
    if (el.textContent.includes('Open a chat')) {
      el.textContent = `Open a chat on ${platformInfo.name}`;
    }
  });
  
  // Platform flags
  const isTelegram = platform === 'telegram';
  const isOnlyFans = platform === 'onlyfans';
  
  // Hide voice features for OnlyFans (voice only available on Telegram)
  const hideVoice = isOnlyFans;
  
  // Voice Settings section in settings panel
  const voiceSettingsSection = document.getElementById('voiceSettingsSection');
  if (voiceSettingsSection) {
    voiceSettingsSection.style.display = hideVoice ? 'none' : '';
  }
  
  // Voice Generator Panel in chat tab
  const voiceGeneratorPanel = document.getElementById('voiceGeneratorPanel');
  if (voiceGeneratorPanel) {
    voiceGeneratorPanel.style.display = hideVoice ? 'none' : '';
  }
  
  // Voice Library section in chat tab
  const voiceLibrarySection = document.querySelector('.voice-library-section');
  if (voiceLibrarySection) {
    voiceLibrarySection.style.display = hideVoice ? 'none' : '';
  }
  
  // Voice action type button in Add Action modal
  const voiceActionBtn = document.querySelector('.action-type-btn[data-type="voice"]');
  if (voiceActionBtn) {
    voiceActionBtn.style.display = hideVoice ? 'none' : '';
  }
  
  // OnlyFans-specific AutoChat panel (hide for Telegram)
  // FIX: Use classList instead of style.display for proper hiding
  const autoChatPanelOF = document.getElementById('autoChatPanelOF');
  if (autoChatPanelOF) {
    if (isTelegram) {
      autoChatPanelOF.classList.add('hidden');
      autoChatPanelOF.style.display = 'none';
    } else {
      autoChatPanelOF.classList.remove('hidden');
      autoChatPanelOF.style.display = '';
    }
  }
  
  // Chat List View (hide for Telegram)
  const chatListView = document.getElementById('chatListView');
  if (chatListView) {
    if (isTelegram) {
      chatListView.classList.add('hidden');
      chatListView.style.display = 'none';
    } else {
      chatListView.classList.remove('hidden');
      chatListView.style.display = '';
    }
  }
  
  // AutoChat Status Bar (hide for Telegram - this is the orange status bar)
  const autoChatStatusBar = document.getElementById('autoChatStatusBar');
  if (autoChatStatusBar) {
    if (isTelegram) {
      autoChatStatusBar.classList.add('hidden');
      autoChatStatusBar.style.display = 'none';
    } else {
      autoChatStatusBar.classList.remove('hidden');
      autoChatStatusBar.style.display = '';
    }
  }
  
  // Telegram-specific AutoChat panel (hide for OnlyFans)
  const autoChatPanel = document.getElementById('autoChatPanel');
  if (autoChatPanel) {
    if (isOnlyFans) {
      autoChatPanel.classList.add('hidden');
      autoChatPanel.style.display = 'none';
    } else {
      autoChatPanel.classList.remove('hidden');
      autoChatPanel.style.display = '';
      // Initialize and render Telegram AutoChat panel
      import('./autochat.js').then(({ initAutoChat, renderAutoChatPanel }) => {
        console.log('[Platform] Initializing Telegram AutoChat...');
        initAutoChat();
        renderAutoChatPanel();
      }).catch(e => console.error('[Platform] Failed to init Telegram AutoChat:', e));
    }
  }
  
  // Block List Panel (Telegram only)
  const blockListPanel = document.getElementById('blockListPanel');
  if (blockListPanel) {
    if (isOnlyFans) {
      blockListPanel.classList.add('hidden');
      blockListPanel.style.display = 'none';
    } else {
      blockListPanel.classList.remove('hidden');
      blockListPanel.style.display = '';
    }
  }
  
  // Subscriber Info Bar - hide for Telegram (no spent/sub date data)
  const subscriberInfoBar = document.getElementById('subscriberInfoBar');
  if (subscriberInfoBar && isTelegram) {
    subscriberInfoBar.classList.add('hidden');
  }
  
  // Usage Counter - hide for Telegram
  const usageCounter = document.getElementById('usageCounter');
  if (usageCounter && isTelegram) {
    usageCounter.classList.add('hidden');
  }
  
  // Notification Bell - hide for Telegram, show for OnlyFans
  const notificationBell = document.getElementById('notificationBellBtn');
  if (notificationBell) {
    if (isTelegram) {
      notificationBell.classList.add('hidden');
      notificationBell.style.display = 'none';
    } else {
      // Ensure bell is visible for OnlyFans
      notificationBell.classList.remove('hidden');
      notificationBell.style.display = '';
    }
  }
  
  
  // Image Pool Section - Telegram only
  const imagePoolSection = document.getElementById('imagePoolSection');
  if (imagePoolSection) {
    if (isTelegram) {
      imagePoolSection.classList.remove('hidden');
    } else {
      imagePoolSection.classList.add('hidden');
    }
  }
  
  console.log(`[Platform] UI updated for ${platform}${hideVoice ? ' (voice features hidden)' : ''}`);
  console.log(`[Platform] AutoChat panels visibility - OF: ${isOnlyFans ? 'visible' : 'hidden'}, TG: ${isTelegram ? 'visible' : 'hidden'}`);
};

// Setup platform selector listeners
export const setupPlatformSelector = () => {
  const platformCards = document.querySelectorAll('.platform-card');
  
  platformCards.forEach(card => {
    card.addEventListener('click', () => {
      const platform = card.dataset.platform;
      handlePlatformSelect(platform);
    });
  });
};

// Initialize platform module
export const initPlatform = async () => {
  // Setup listeners only - don't show/hide anything yet
  setupPlatformSelector();
  
  // Check for stored platform and set in store (but don't hide selector)
  const storedPlatform = await getStoredPlatform();
  
  if (storedPlatform) {
    Store.set('selectedPlatform', storedPlatform);
  }
  
  // Return stored platform (or null)
  // The actual show/hide decision happens in checkPlatformSelection()
  return storedPlatform;
};

// Check if a tab with the platform URL is open
export const isPlatformTabOpen = async (platform) => {
  const platformInfo = PLATFORMS[platform];
  if (!platformInfo) {
    console.log('[Platform] isPlatformTabOpen: No platform info for', platform);
    return false;
  }
  
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      console.log('[Platform] Checking', tabs.length, 'tabs for', platformInfo.url);
      const matchingTabs = tabs.filter(tab => tab.url?.includes(platformInfo.url));
      console.log('[Platform] Found', matchingTabs.length, 'matching tabs:', matchingTabs.map(t => t.url));
      resolve(matchingTabs.length > 0);
    });
  });
};

// Check if platform selection is needed (call after auth)
export const checkPlatformSelection = async () => {
  const storedPlatform = await getStoredPlatform();
  console.log('[Platform] checkPlatformSelection - storedPlatform:', storedPlatform);
  
  // No platform stored - show selector
  if (!storedPlatform) {
    console.log('[Platform] No platform stored - showing selector');
    showPlatformSelector();
    return false;
  }
  
  // Platform stored - check if a tab with that platform is open
  const tabOpen = await isPlatformTabOpen(storedPlatform);
  console.log('[Platform] Tab open for', storedPlatform, ':', tabOpen);
  
  if (!tabOpen) {
    // Tab is closed - show selector again to let user reopen it
    console.log('[Platform] No tab found for', storedPlatform, '- showing selector');
    showPlatformSelector();
    return false;
  }
  
  // Platform tab is open - proceed normally
  console.log('[Platform] Platform tab is open, proceeding to main app');
  
  // Update UI for this platform (hide/show platform-specific features)
  updatePlatformUI(storedPlatform);
  
  return true;
};

// Reset platform selection (for settings)
export const resetPlatformSelection = async () => {
  await new Promise((resolve) => {
    chrome.storage.local.remove(['selectedPlatform'], resolve);
  });
  Store.set('selectedPlatform', null);
  showPlatformSelector();
};

export default {
  PLATFORMS,
  getStoredPlatform,
  setStoredPlatform,
  showPlatformSelector,
  hidePlatformSelector,
  initPlatform,
  checkPlatformSelection,
  resetPlatformSelection,
  updatePlatformUI
};