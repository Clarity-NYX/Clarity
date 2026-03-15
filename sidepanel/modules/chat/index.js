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
  displaySubscriberStats
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

import { $ } from '../../utils/dom.js';
import { forceRefreshSubscriberStats as _forceRefresh } from './chatSync.js';

// Main setup function
export const setupChat = () => {
  setupWindowCloseHandlers();
  setupChatListListeners();
  setupTabWatcher();
  setupMessageListener();
  
  // Refresh subscriber info button
  $('refreshSubInfoBtn')?.addEventListener('click', () => _forceRefresh());
};
