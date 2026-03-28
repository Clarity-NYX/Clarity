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
export { setupVault } from './chatVault.js';

import { $ } from '../../utils/dom.js';
import { apiRequest } from '../../utils/api.js';
import Store from '../../state/store.js';
import { forceRefreshSubscriberStats as _forceRefresh } from './chatSync.js';
import { startDisplayCrossCheck as _startCrossCheck } from './chatRenderer.js';
import { startTaskDaysCountdown as _startTaskCountdown } from './taskDays.js';
import { setupVault } from './chatVault.js';

// ============================================================
// SAVE CHAT AS TRAINING DATA
// ============================================================
async function saveCurrentChatAsTraining() {
  const messages = Store.get('messages') || [];
  if (!messages.length) { alert('No chat loaded to save'); return; }

  const profileId = Store.get('currentProfile')?.id;
  const subscriberId = Store.get('currentSubscriberId') || 'unknown';
  const storedChat = Store.get('storedChat') || {};
  const notes = storedChat.notes || {};

  const label = prompt('Label for this training chat:', `${notes.name || subscriberId} - ${new Date().toLocaleDateString()}`);
  if (!label) return;

  const btn = document.getElementById('saveForTrainingBtn');
  try {
    if (btn) btn.textContent = '⏳';

    await apiRequest('/simulation/training-data', {
      method: 'POST',
      body: JSON.stringify({
        chatId: `${subscriberId}_${Date.now()}`,
        subscriberId,
        profileId,
        messages,
        notes,
        stats: {
          subscribedFor: notes.subscribedFor || notes.subscribedSince || null,
          totalSpent: notes.totalSpent || null,
          totalMessages: messages.length
        },
        label
      })
    });

    if (btn) { btn.textContent = '✅'; setTimeout(() => { btn.textContent = '📚'; }, 2000); }
    console.log('[Chat] 📚 Chat saved as training data');
  } catch (e) {
    console.error('[Chat] Save training data error:', e);
    alert('Failed to save: ' + e.message);
    if (btn) btn.textContent = '📚';
  }
}

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
  
  // Save chat as training data button
  $('saveForTrainingBtn')?.addEventListener('click', () => saveCurrentChatAsTraining());
  
  // Media vault
  setupVault();
};
