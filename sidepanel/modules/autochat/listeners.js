// ============================================================
// AUTOCHAT LISTENERS - Event Handlers from working autochat.js
// ============================================================

import { $ } from '../../utils/dom.js';
import { showNotification } from '../../utils/notify.js';
import { 
  autoChatState,
  processingStatus,
  setAutoChatState,
  updateProcessingStatus,
  resetStepStatuses,
  setWorkflowLock,
  setLastProcessedPeerId,
  currentWorkflowState,
  setCurrentWorkflowState,
  crossCheckedChats
} from './state.js';
import { WorkflowState } from './constants.js';
import { renderAutoChatPanel, renderStatusBar } from './ui.js';

// ============================================================
// CONTROL LISTENERS
// ============================================================

export function setupAutoChatListeners() {
  // Main toggle
  $('autoChatToggle')?.addEventListener('click', async () => {
    const newState = !autoChatState.enabled;
    
    // Get profile ID
    let profileId = null;
    try {
      const Store = (await import('../../state/store.js')).default;
      profileId = Store.get('currentProfile')?.id;
    } catch (e) {
      console.log('[AutoChat] Could not get profile ID:', e.message);
    }
    
    // If enabling, load blocked users into background cache first
    if (newState) {
      if (profileId) {
        console.log('[AutoChat] Loading blocked users before enabling...');
        try {
          await chrome.runtime.sendMessage({
            type: 'AUTOCHAT_LOAD_BLOCKED_USERS',
            data: { profileId }
          });
          console.log('[AutoChat] ✅ Blocked users loaded into background');
        } catch (e) {
          console.log('[AutoChat] Could not preload blocked users:', e.message);
        }
      } else {
        console.log('[AutoChat] ⚠️ No profile selected - blocked users will not be loaded!');
        showNotification('⚠️ Please select a profile first');
        return;
      }
    }
    
    const response = await chrome.runtime.sendMessage({
      type: 'AUTOCHAT_SET_ENABLED',
      data: { enabled: newState, profileId }
    });
    
    if (response.success) {
      setAutoChatState({ enabled: response.enabled });
      renderAutoChatPanel();
      showNotification(newState ? '🤖 Auto-Chat enabled!' : 'Auto-Chat disabled');
    }
  });
  
  // Priority mode toggle
  $('priorityToggle')?.addEventListener('click', async () => {
    const newState = !autoChatState.prioritizeByProgress;
    
    const response = await chrome.runtime.sendMessage({
      type: 'AUTOCHAT_SET_PRIORITY_MODE',
      data: { enabled: newState }
    });
    
    if (response.success) {
      setAutoChatState({ prioritizeByProgress: newState });
      renderAutoChatPanel();
      showNotification(newState ? '✅ Prioritizing by script progress' : 'Processing in order added');
    }
  });
  
  // Auto-send toggle
  $('autoSendToggle')?.addEventListener('click', async () => {
    const newState = !autoChatState.autoSendEnabled;
    
    if (newState) {
      // Confirm before enabling auto-send
      if (!confirm('⚠️ Auto-Send will automatically send messages without your review. Are you sure?')) {
        return;
      }
    }
    
    const response = await chrome.runtime.sendMessage({
      type: 'AUTOCHAT_SET_AUTO_SEND',
      data: { enabled: newState }
    });
    
    if (response.success) {
      setAutoChatState({ autoSendEnabled: response.autoSendEnabled });
      renderAutoChatPanel();
      showNotification(newState ? '⚠️ Auto-Send enabled!' : 'Auto-Send disabled');
    }
  });
}

// ============================================================
// MESSAGE LISTENER - Background state sync
// ============================================================

export function setupAutoChatMessageListener() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'AUTOCHAT_STATE_CHANGED') {
      const wasEnabled = autoChatState.enabled;
      setAutoChatState(message.data);
      
      // Clear processing status when AutoChat is disabled
      if (wasEnabled && !autoChatState.enabled) {
        console.log('[AutoChat] Disabled - clearing processing status and lock');
        resetStepStatuses();
        updateProcessingStatus({ currentChat: null });
        setCurrentWorkflowState(WorkflowState.IDLE);
        setWorkflowLock(false);
        setLastProcessedPeerId(null);
        // NOTE: We do NOT clear crossCheckedChats - keep it persistent across sessions
        // This prevents expensive AI cross-checks on chats we've already visited
        console.log(`[AutoChat] Cross-check cache preserved: ${crossCheckedChats.size} chats`);
        renderStatusBar();
      }
      
      renderAutoChatPanel();
    }
    
    // Handle step update from background (for opening chat status)
    if (message.type === 'AUTOCHAT_STEP_UPDATE') {
      const { chatName, chatIndex, totalChats, step, status } = message.data || {};
      
      updateProcessingStatus({
        currentChat: chatName || processingStatus.currentChat,
        currentIndex: chatIndex || processingStatus.currentIndex,
        totalChats: totalChats || processingStatus.totalChats
      });
      
      if (step && status) {
        processingStatus.stepStatus[step] = status;
      }
      
      renderAutoChatPanel();
    }
    
    // Handle AI generation trigger from AutoChat workflow
    if (message.type === 'AUTOCHAT_TRIGGER_GENERATION') {
      console.log('[AutoChat-UI] Received trigger to generate AI response for:', message.data?.peerId);
      
      // Update processing status with chat info
      updateProcessingStatus({
        currentChat: message.data?.chatName || `Chat #${message.data?.peerId}`,
        currentIndex: message.data?.chatIndex || 0,
        totalChats: message.data?.totalChats || 0
      });
      
      // Import and trigger workflow (lazy load to avoid circular deps)
      import('./workflow.js').then(({ triggerAIGeneration }) => {
        triggerAIGeneration(message.data?.peerId, message.data?.autoSend);
      });
    }
  });
}
