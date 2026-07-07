// ============================================================
// CHAT MODULE INDEX - Exports all chat functionality
// ============================================================

// Re-export from chat list module
export {
  showChatListView,
  showConversationView,
  loadChatList,
  renderChatList,
  setupChatListListeners,
  updateAutoChatState
} from './chatList.js';

// Re-export from chat alarm module
export {
  updateUnreadChats,
  handleNewUnreadDetected,
  toggleAlarmMute
} from './chatAlarm.js';

// Re-export from chat storage module
export {
  saveFullChatReplacement,
  forceFlushPendingSaves,
  syncNewMessagesToDatabase,
  setupWindowCloseHandlers
} from './chatStorage.js';

// Re-export from chat renderer module
export {
  renderChatMessages,
  populateNotesFromChat,
  displaySubscriberStats,
  startDisplayCrossCheck,
  stopDisplayCrossCheck
} from './chatRenderer.js';

// Re-export from chat sync module
export {
  handleIncomingMessages,
  loadAndSyncChat,
  setupTabWatcher,
  detectAndSyncChat,
  forceRefreshSubscriberStats
} from './chatSync.js';

// Re-export from message listener
export {
  setupMessageListener
} from './messageListener.js';

// Re-export vault
export { setupVault, openVault } from './chatVault.js';


import { $ } from '../../utils/dom.js';
import { forceRefreshSubscriberStats as _forceRefresh } from './chatSync.js';
import { startDisplayCrossCheck as _startCrossCheck } from './chatRenderer.js';
import { startTaskDaysCountdown as _startTaskCountdown } from './taskDays.js';
import { setupVault } from './chatVault.js';
import { handleDisplayLangChange } from './displayTranslation.js';

// Re-export display-translation helpers for use by other chat modules
export { restoreDisplayLang, translateNewMessages, handleDisplayLangChange } from './displayTranslation.js';


// Main setup function

export const setupChat = () => {
  setupWindowCloseHandlers();
  setupChatListListeners();
  setupTabWatcher();
  setupMessageListener();
  
  // Start periodic display cross-check (detects & fixes stale messages)
  _startCrossCheck();
  
  // Start task days countdown auto-update
  _startTaskCountdown();
  
  // Refresh subscriber info button
  $('refreshSubInfoBtn')?.addEventListener('click', () => _forceRefresh());
  
  // Chat display-language dropdown — translate visible messages into chosen language
  $('chatDisplayLangSelect')?.addEventListener('change', (e) => {
    handleDisplayLangChange(e.target.value);
  });
  
  // Media vault
  setupVault();

};
