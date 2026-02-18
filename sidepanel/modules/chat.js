// ============================================================
// CHAT MODULE - Refactored to use modular architecture
// ============================================================

// Import all functionality from the modular structure
import {
  // Chat list functionality
  showChatListView,
  showConversationView,
  loadChatList,
  setupChatListListeners,
  
  // Chat alarm functionality
  toggleAlarmMute,
  
  // Chat storage functionality
  
  // Chat renderer functionality
  renderChatMessages,
  
  // Chat sync functionality
  loadAndSyncChat,
  setupTabWatcher,
  
  // Message listener
  setupMessageListener,
  
  // Main setup
  setupChat
} from './chat/index.js';

// Make toggleAlarmMute available globally for the notification module
if (typeof window !== 'undefined') {
  window.chatModule = {
    toggleAlarmMute
  };
}

// Default export for backwards compatibility
export default { 
  renderChatMessages, 
  setupMessageListener, 
  loadAndSyncChat, 
  setupTabWatcher,
  showChatListView,
  showConversationView,
  loadChatList,
  setupChatListListeners,
  toggleAlarmMute
};

// Named exports
export {
  renderChatMessages,
  setupMessageListener,
  loadAndSyncChat,
  setupTabWatcher,
  showChatListView,
  showConversationView,
  loadChatList,
  setupChatListListeners,
  toggleAlarmMute,
  setupChat
};