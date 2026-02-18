// ============================================================
// AUTOCHAT UI - Render Functions from working autochat.js
// ============================================================

import { $ } from '../../utils/dom.js';
import { 
  autoChatState, 
  processingStatus, 
  isCollapsed,
  setIsCollapsed
} from './state.js';

// ============================================================
// RENDER FUNCTIONS
// ============================================================

// Render the orange status bar above the panel
export function renderStatusBar() {
  const statusBar = $('autoChatStatusBar');
  if (!statusBar) return;
  
  // Only show when AutoChat is enabled AND processing
  if (!autoChatState.enabled || !processingStatus.currentChat) {
    statusBar.classList.add('hidden');
    return;
  }
  
  statusBar.classList.remove('hidden');
  
  // Get current step name
  const steps = ['openingChat', 'loadingMessages', 'generating', 'sending', 'verifying'];
  const stepNames = ['Opening', 'Loading', 'Generating', 'Sending', 'Verifying'];
  let currentStepName = 'Idle';
  
  for (let i = 0; i < steps.length; i++) {
    if (processingStatus.stepStatus[steps[i]] === 'active') {
      currentStepName = stepNames[i];
      break;
    }
  }
  
  // Count completed steps
  const completedSteps = steps.filter(s => processingStatus.stepStatus[s] === 'done').length;
  
  statusBar.innerHTML = `
    <div class="status-bar-content">
      <div class="status-bar-left">
        <span class="status-icon">⚡</span>
        <span class="status-chat-name">${processingStatus.currentChat}</span>
        <span class="status-position">(${processingStatus.currentIndex}/${processingStatus.totalChats})</span>
      </div>
      <div class="status-bar-right">
        <span class="status-step">${currentStepName}...</span>
        <span class="status-progress">${completedSteps}/5</span>
      </div>
    </div>
  `;
}

// Get step icons based on status
function getStepIcon(status) {
  switch (status) {
    case 'done': return '✅';
    case 'active': return '⏳';
    case 'error': return '❌';
    default: return '⬜';
  }
}

export function renderAutoChatPanel() {
  console.log('[AutoChat UI] renderAutoChatPanel() called');
  const container = $('autoChatPanel');
  console.log('[AutoChat UI] Container:', container);
  if (!container) {
    console.log('[AutoChat UI] ERROR: Container #autoChatPanel not found!');
    return;
  }
  
  const { enabled, autoSendEnabled, queueCount, cooldownCount, cooldownMinutes, stats, currentlyProcessing } = autoChatState;
  
  // For queue display
  const waitingCount = queueCount || autoChatState.waitingCount || 0;
  const isProcessing = !!currentlyProcessing || !!processingStatus.currentChat;
  
  container.className = `autochat-panel ${isCollapsed ? 'collapsed' : 'expanded'}`;
  
  // Build status HTML based on pool state
  let statusHTML = '';
  if (enabled) {
    const poolWaiting = autoChatState.activePoolWaitingCount || 0;
    const poolReady = autoChatState.activePoolReadyCount || 0;
    const poolSize = autoChatState.activePoolSize || 0;
    
    if (processingStatus.currentChat) {
      // Currently processing a chat
      statusHTML = `
        <div class="autochat-processing">
          <div class="processing-header">
            <span class="processing-chat">📂 ${processingStatus.currentChat}</span>
            <span class="processing-count">(${poolSize} in pool)</span>
          </div>
          <div class="processing-steps">
            <div class="step ${processingStatus.stepStatus.openingChat}">
              ${getStepIcon(processingStatus.stepStatus.openingChat)} Opening Chat
            </div>
            <div class="step ${processingStatus.stepStatus.loadingMessages}">
              ${getStepIcon(processingStatus.stepStatus.loadingMessages)} Loading Messages
            </div>
            <div class="step ${processingStatus.stepStatus.generating}">
              ${getStepIcon(processingStatus.stepStatus.generating)} Generating Response
            </div>
            <div class="step ${processingStatus.stepStatus.sending}">
              ${getStepIcon(processingStatus.stepStatus.sending)} Sending Message
            </div>
            <div class="step ${processingStatus.stepStatus.verifying}">
              ${getStepIcon(processingStatus.stepStatus.verifying)} Verifying Sent
            </div>
          </div>
          ${processingStatus.retries > 0 ? `<div class="processing-retry">🔄 Retry: ${processingStatus.retries}/${processingStatus.maxRetries}</div>` : ''}
          ${processingStatus.lastError ? `<div class="processing-error">⚠️ ${processingStatus.lastError}</div>` : ''}
        </div>
      `;
    } else if (poolWaiting > 0 && poolReady === 0) {
      // All pool chats are waiting for replies - show WAITING FOR NEW MESSAGES
      statusHTML = `
        <div class="autochat-waiting">
          <span class="waiting-icon">⏳</span>
          <span class="waiting-text">Waiting for new messages</span>
          <span class="waiting-detail">${poolWaiting} chat${poolWaiting > 1 ? 's' : ''} awaiting reply</span>
        </div>
      `;
    } else if (poolReady > 0) {
      // Some chats are ready to process
      statusHTML = `
        <div class="autochat-idle">
          <span class="idle-icon">📬</span>
          <span class="idle-text">${poolReady} reply detected - processing...</span>
        </div>
      `;
    } else if (waitingCount > 0) {
      // Have items in queue waiting to enter pool
      statusHTML = `
        <div class="autochat-idle">
          <span class="idle-icon">📬</span>
          <span class="idle-text">${waitingCount} message${waitingCount > 1 ? 's' : ''} in queue</span>
        </div>
      `;
    } else {
      // Pool and queue empty - truly idle
      statusHTML = `
        <div class="autochat-idle">
          <span class="idle-icon">💤</span>
          <span class="idle-text">Waiting for new messages...</span>
        </div>
      `;
    }
  }
  
  // Quick stats for collapsed header
  const quickStats = isProcessing ? `📂 Processing...` : 
                     waitingCount > 0 ? `📬 ${waitingCount} queued` : 
                     `💤 Waiting`;
  
  container.innerHTML = `
    <div class="autochat-header" id="autoChatHeaderToggle">
      <div class="autochat-header-left">
        <span class="collapse-arrow">${isCollapsed ? '▶' : '▼'}</span>
        <h3>🤖 Auto-Chat</h3>
        ${isCollapsed ? `<span class="header-quick-stats">${quickStats}</span>` : ''}
      </div>
      <button id="autoChatToggle" class="toggle-btn ${enabled ? 'active' : ''}">
        ${enabled ? '🟢 ON' : '🔴 OFF'}
      </button>
    </div>
    
    <div class="autochat-body ${isCollapsed ? 'hidden' : ''}">
      ${statusHTML}
      
      <div class="autochat-stats">
        <div class="stat-row">
          <span class="stat-label">📋 Total</span>
          <span class="stat-value">${autoChatState.activePoolSize || 0}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">🎯 Ready</span>
          <span class="stat-value">${autoChatState.activePoolReadyCount || 0}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">⏳ Waiting</span>
          <span class="stat-value">${autoChatState.activePoolWaitingCount || 0}</span>
        </div>
      </div>
      
      <div class="autochat-controls">
        <div class="control-row">
          <label>Prioritize by Progress</label>
          <button id="priorityToggle" class="toggle-btn small ${autoChatState.prioritizeByProgress ? 'active' : ''}">
            ${autoChatState.prioritizeByProgress ? '✅ ON' : 'OFF'}
          </button>
        </div>
        
        <div class="control-row">
          <label>Auto-Send</label>
          <button id="autoSendToggle" class="toggle-btn small ${autoSendEnabled ? 'active danger' : ''}">
            ${autoSendEnabled ? '⚠️ ON' : 'OFF'}
          </button>
        </div>
      </div>
      
      <div class="autochat-daily-stats">
        <div class="daily-stats-row">
          <span>✅ ${stats.today?.completed || 0}</span>
          <span>❌ ${stats.today?.interrupted || 0}</span>
        </div>
      </div>
    </div>
  `;
  
  // Import and setup listeners (lazy load to avoid circular deps)
  import('./listeners.js').then(({ setupAutoChatListeners }) => {
    setupAutoChatListeners();
  });
  
  // Header click to collapse/expand
  $('autoChatHeaderToggle')?.addEventListener('click', (e) => {
    // Don't toggle if clicking the ON/OFF button
    if (e.target.closest('#autoChatToggle')) return;
    
    setIsCollapsed(!isCollapsed);
    renderAutoChatPanel();
  });
}
