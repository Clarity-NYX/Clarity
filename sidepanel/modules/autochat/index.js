// ============================================================
// AUTOCHAT MODULE - Main Entry Point
// ============================================================

// Re-export everything from submodules for public API
export { 
  WorkflowState, 
  TIMING, 
  StepStatus, 
  WORKFLOW_STEPS, 
  STEP_DISPLAY_NAMES, 
  DEFAULT_STEP_STATUS 
} from './constants.js';

export { 
  autoChatState, 
  processingStatus,
  isCollapsed,
  currentWorkflowState,
  workflowLock,
  workflowRetries,
  lastProcessedPeerId,
  lastMessageSentTime,
  crossCheckedChats,
  blockedUsers,
  blockListCollapsed,
  loadAutoChatState,
  updateAutoChatState,
  setAutoChatState,
  updateProcessingStatus,
  setIsCollapsed,
  setCurrentWorkflowState,
  setWorkflowLock,
  setWorkflowRetries,
  setLastProcessedPeerId,
  setLastMessageSentTime,
  setBlockListCollapsed,
  setBlockedUsers,
  addBlockedUser,
  removeBlockedUser,
  resetStepStatuses,
  updateStepStatus
} from './state.js';

export { 
  renderStatusBar, 
  renderAutoChatPanel 
} from './ui.js';

export { 
  setupAutoChatListeners, 
  setupAutoChatMessageListener 
} from './listeners.js';

export { 
  renderBlockListPanel, 
  loadBlockedUsers, 
  blockUser, 
  unblockUser, 
  blockCurrentChat,
  setupBlockListListeners 
} from './blocklist.js';

export { 
  triggerAIGeneration 
} from './workflow.js';

// ============================================================
// INITIALIZATION
// ============================================================

export function initAutoChat() {
  setupAutoChatMessageListener();
  loadAutoChatState();
  
  // Initialize block list
  setupBlockListListeners();
  loadBlockedUsers();
}

// ============================================================
// DEFAULT EXPORT - For backwards compatibility
// ============================================================

import { renderAutoChatPanel } from './ui.js';
import { loadAutoChatState } from './state.js';
import { setupAutoChatMessageListener } from './listeners.js';
import { renderBlockListPanel, loadBlockedUsers, setupBlockListListeners } from './blocklist.js';

export default {
  renderAutoChatPanel,
  loadAutoChatState,
  setupAutoChatMessageListener,
  initAutoChat,
  renderBlockListPanel,
  loadBlockedUsers
};
