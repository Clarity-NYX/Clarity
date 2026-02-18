// ============================================================
// TAB MONITORING
// ============================================================

import { SUPPORTED_PLATFORMS } from './config.js';

// Check if URL matches supported platform
export const isSupportedPlatformUrl = (url) => {
  if (!url) return false;
  return SUPPORTED_PLATFORMS.some(platform => 
    platform.patterns.some(pattern => url.includes(pattern))
  );
};

// Check if any supported tabs are open
export const checkSupportedTabs = async () => {
  try {
    const tabs = await chrome.tabs.query({});
    const supportedTab = tabs.find(tab => isSupportedPlatformUrl(tab.url));
    
    if (!supportedTab) {
      console.log('[TabMonitor] No supported tabs - notifying sidepanel');
      chrome.runtime.sendMessage({ 
        type: 'NO_SUPPORTED_TABS',
        reason: 'All platform tabs closed'
      }).catch(() => {});
    }
  } catch (error) {
    console.error('[TabMonitor] Error checking tabs:', error);
  }
};

// Setup tab monitoring listeners
export function setupTabMonitoring() {
  // Monitor tab removal
  chrome.tabs.onRemoved.addListener((tabId) => {
    console.log('[TabMonitor] Tab removed:', tabId);
    setTimeout(checkSupportedTabs, 100);
  });

  // Monitor tab URL changes
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) {
      chrome.storage.local.get(['lastPlatformTabId']).then(result => {
        if (result.lastPlatformTabId === tabId && !isSupportedPlatformUrl(changeInfo.url)) {
          console.log('[TabMonitor] Tab navigated away from platform');
          checkSupportedTabs();
        }
      });
      
      if (isSupportedPlatformUrl(changeInfo.url)) {
        chrome.storage.local.set({ lastPlatformTabId: tabId });
      }
    }
  });

  // Monitor window close
  chrome.windows.onRemoved.addListener((windowId) => {
    console.log('[TabMonitor] Window closed:', windowId);
    setTimeout(checkSupportedTabs, 100);
  });
}
