// ============================================================
// AUTO-CHAT ONLYFANS - Sidepanel UI Module
// Separate from Telegram - handles OF-specific UI and state
// ============================================================

import { $, show, hide, escapeHtml } from '../utils/dom.js';
import { showNotification } from '../utils/notify.js';
import Store from '../state/store.js';

// ============================================================
// STATE
// ============================================================

let ofAutoChatState = {
  enabled: false,
  autoSendEnabled: false,  // false = queue-only (pre-generate, user sends manually)
  maxActiveChats: 5,
  waitTimeMinutes: 1,
  activePool: [],    // Array of chat states with responses
  stats: { today: { generated: 0, sent: 0, errors: 0 } },
  readyCount: 0
};

let isPanelCollapsed = true;

// ============================================================
// RENDER FUNCTIONS
// ============================================================

// Render the OF Auto-Chat panel
export function renderOFAutoChatPanel() {
  console.log('[OF-AutoChat-UI] 📦 renderOFAutoChatPanel called');
  
  // Skip rendering on Telegram - this panel is OnlyFans-only
  const isTelegram = document.body.classList.contains('telegram-platform');
  if (isTelegram) {
    console.log('[OF-AutoChat-UI] ⏭️ Skipping render - Telegram platform');
    const container = $('autoChatPanelOF');
    if (container) {
      container.classList.add('hidden');
      container.style.display = 'none';
    }
    return;
  }
  
  const container = $('autoChatPanelOF');
  console.log('[OF-AutoChat-UI] Container found:', !!container, container);
  if (!container) {
    console.error('[OF-AutoChat-UI] ❌ Container #autoChatPanelOF NOT FOUND!');
    return;
  }
  
  const { enabled, maxActiveChats, waitTimeMinutes, activePool, stats } = ofAutoChatState;
  
  container.className = `autochat-panel-of ${isPanelCollapsed ? 'collapsed' : 'expanded'}`;
  
  // Count chats by status
  const generating = activePool.filter(c => c.status === 'generating').length;
  const ready = activePool.filter(c => c.status === 'ready').length;
  const waiting = activePool.filter(c => c.status === 'waiting').length;
  
  container.innerHTML = `
    <div class="autochat-of-header" id="autoChatOFHeaderToggle">
      <div class="autochat-of-header-left">
        <span class="collapse-arrow">${isPanelCollapsed ? '▶' : '▼'}</span>
        <h3>🔥 Auto-Chat</h3>
        ${isPanelCollapsed ? `<span class="header-quick-stats">${ready} ready · ${generating} gen · ${waiting} wait</span>` : ''}
      </div>
      <div class="autochat-of-header-right">
        <button id="ofAutoChatToggle" class="toggle-btn ${enabled ? 'active' : ''}">
          ${enabled ? '🟢 ON' : '🔴 OFF'}
        </button>
      </div>
    </div>
    
    <div class="autochat-of-body ${isPanelCollapsed ? 'hidden' : ''}">
      <div class="autochat-of-stats">
        <div class="stat-item">
          <span class="stat-icon">⏳</span>
          <span class="stat-value">${waiting}</span>
          <span class="stat-label">Waiting</span>
        </div>
        <div class="stat-item">
          <span class="stat-icon">🤖</span>
          <span class="stat-value">${generating}</span>
          <span class="stat-label">Generating</span>
        </div>
        <div class="stat-item">
          <span class="stat-icon">✅</span>
          <span class="stat-value">${ready}</span>
          <span class="stat-label">Ready</span>
        </div>
      </div>
      
      <div class="autochat-of-controls">
        <div class="control-row">
          <label>Mode</label>
          <button id="ofAutoSendToggle" class="mode-toggle-btn ${ofAutoChatState.autoSendEnabled ? 'auto-send' : 'queue-only'}">
            ${ofAutoChatState.autoSendEnabled ? '📤 Auto-Send' : '📋 Queue Only'}
          </button>
        </div>
        <div class="control-row">
          <label>Max Active Chats</label>
          <input type="range" id="ofMaxChatsSlider" min="1" max="10" value="${maxActiveChats}">
          <span id="ofMaxChatsValue">${maxActiveChats}</span>
        </div>
        <div class="control-row">
          <label>Wait Time (min)</label>
          <input type="range" id="ofWaitTimeSlider" min="0.5" max="5" step="0.5" value="${waitTimeMinutes}">
          <span id="ofWaitTimeValue">${waitTimeMinutes}m</span>
        </div>
      </div>
      
      <div class="autochat-of-daily">
        <span>📊 Today: ${stats.today.generated} generated · ${stats.today.sent} sent</span>
      </div>
    </div>
  `;
  
  // Attach event listeners
  setupOFAutoChatListeners();
  
  // Header toggle
  $('autoChatOFHeaderToggle')?.addEventListener('click', (e) => {
    if (e.target.closest('#ofAutoChatToggle')) return;
    isPanelCollapsed = !isPanelCollapsed;
    renderOFAutoChatPanel();
  });
}

// Render chat cards with generated responses in the chat list view
export function renderOFAutoChatCards() {
  const chatListItems = $('chatListItems');
  if (!chatListItems) return;
  
  const { activePool } = ofAutoChatState;
  
  // Get existing chat cards
  const existingCards = chatListItems.querySelectorAll('.chat-list-item');
  
  existingCards.forEach(card => {
    const peerId = card.dataset.chatId;
    const chatState = activePool.find(c => c.peerId === peerId);
    
    // Remove old response section if exists
    const oldResponse = card.querySelector('.chat-response-section');
    if (oldResponse) oldResponse.remove();
    
    if (chatState && (chatState.status === 'ready' || chatState.status === 'generating' || chatState.status === 'waiting' || chatState.status === 'error')) {
      // Add response section
      const responseSection = createResponseSection(chatState);
      card.appendChild(responseSection);
    }
  });
}

// Create the response section for a chat card
function createResponseSection(chatState) {
  const section = document.createElement('div');
  section.className = `chat-response-section status-${chatState.status}`;
  
  if (chatState.status === 'waiting') {
    const timeLeft = Math.max(0, Math.ceil((chatState.waitingUntil - Date.now()) / 1000));
    // Show different UI if response is pre-generated
    if (chatState.generatedResponse) {
      section.innerHTML = `
        <div class="response-pregenerated">
          <span class="pregenerated-icon">📦</span>
          <span class="pregenerated-text">Ready in ${timeLeft}s</span>
          <span class="pregenerated-preview">${escapeHtml(chatState.generatedResponse.substring(0, 50))}...</span>
        </div>
      `;
    } else {
      section.innerHTML = `
        <div class="response-waiting">
          <span class="waiting-icon">⏳</span>
          <span class="waiting-text">Waiting ${timeLeft}s...</span>
        </div>
      `;
    }
  } else if (chatState.status === 'pre_generating') {
    section.innerHTML = `
      <div class="response-generating pre-gen">
        <div class="spinner small"></div>
        <span class="generating-text">Pre-generating...</span>
      </div>
    `;
  } else if (chatState.status === 'generating') {
    section.innerHTML = `
      <div class="response-generating">
        <div class="spinner small"></div>
        <span class="generating-text">Generating response...</span>
      </div>
    `;
  } else if (chatState.status === 'ready' && chatState.generatedResponse) {
    section.innerHTML = `
      <div class="response-content">
        <div class="response-preview">
          <span class="response-icon">🤖</span>
          <span class="response-text">${escapeHtml(chatState.generatedResponse.substring(0, 100))}${chatState.generatedResponse.length > 100 ? '...' : ''}</span>
        </div>
        <div class="response-actions">
          <button class="btn-response-action btn-regen" data-peer-id="${chatState.peerId}" title="Regenerate">
            🔄
          </button>
          <button class="btn-response-action btn-edit" data-peer-id="${chatState.peerId}" title="Edit">
            ✏️
          </button>
          <button class="btn-response-action btn-send" data-peer-id="${chatState.peerId}" title="Send">
            📤
          </button>
        </div>
      </div>
    `;
    
    // Attach action handlers after adding to DOM
    setTimeout(() => attachResponseActionHandlers(section, chatState.peerId), 0);
  } else if (chatState.status === 'retrying') {
    section.innerHTML = `
      <div class="response-retrying">
        <span class="retrying-icon">🔄</span>
        <span class="retrying-text">${escapeHtml(chatState.error || 'Retrying...')}</span>
      </div>
    `;
  } else if (chatState.status === 'error') {
    section.innerHTML = `
      <div class="response-error">
        <span class="error-icon">❌</span>
        <span class="error-text">${escapeHtml(chatState.error || 'Error')}</span>
        <button class="btn-response-action btn-retry" data-peer-id="${chatState.peerId}">Retry</button>
      </div>
    `;
    setTimeout(() => attachResponseActionHandlers(section, chatState.peerId), 0);
  } else if (chatState.status === 'sending') {
    section.innerHTML = `
      <div class="response-sending">
        <div class="spinner small"></div>
        <span class="sending-text">Sending...</span>
      </div>
    `;
  }
  
  return section;
}

// Attach handlers to response action buttons
function attachResponseActionHandlers(section, peerId) {
  // Regenerate
  section.querySelector('.btn-regen')?.addEventListener('click', (e) => {
    e.stopPropagation();
    regenerateResponse(peerId);
  });
  
  // Edit
  section.querySelector('.btn-edit')?.addEventListener('click', (e) => {
    e.stopPropagation();
    editResponse(peerId);
  });
  
  // Send
  section.querySelector('.btn-send')?.addEventListener('click', (e) => {
    e.stopPropagation();
    sendResponse(peerId);
  });
  
  // Retry (for errors)
  section.querySelector('.btn-retry')?.addEventListener('click', (e) => {
    e.stopPropagation();
    regenerateResponse(peerId);
  });
}

// ============================================================
// EVENT LISTENERS
// ============================================================

function setupOFAutoChatListeners() {
  // Main toggle
  $('ofAutoChatToggle')?.addEventListener('click', async () => {
    const newState = !ofAutoChatState.enabled;
    
    const profileId = Store.get('currentProfile')?.id;
    if (newState && !profileId) {
      showNotification('⚠️ Please select a profile first');
      return;
    }
    
    const response = await chrome.runtime.sendMessage({
      type: 'OF_AUTOCHAT_SET_ENABLED',
      data: { enabled: newState, profileId }
    });
    
    if (response.success) {
      ofAutoChatState.enabled = response.enabled;
      renderOFAutoChatPanel();
      showNotification(newState ? '🔥 OnlyFans Auto-Chat enabled!' : 'Auto-Chat disabled');
    }
  });
  
  // Max chats slider
  const maxSlider = $('ofMaxChatsSlider');
  maxSlider?.addEventListener('input', (e) => {
    $('ofMaxChatsValue').textContent = e.target.value;
  });
  maxSlider?.addEventListener('change', async (e) => {
    const maxChats = parseInt(e.target.value, 10);
    await chrome.runtime.sendMessage({
      type: 'OF_AUTOCHAT_SET_MAX_CHATS',
      data: { maxChats }
    });
    ofAutoChatState.maxActiveChats = maxChats;
  });
  
  // Wait time slider
  const waitSlider = $('ofWaitTimeSlider');
  waitSlider?.addEventListener('input', (e) => {
    $('ofWaitTimeValue').textContent = `${e.target.value}m`;
  });
  waitSlider?.addEventListener('change', async (e) => {
    const minutes = parseFloat(e.target.value);
    await chrome.runtime.sendMessage({
      type: 'OF_AUTOCHAT_SET_WAIT_TIME',
      data: { minutes }
    });
    ofAutoChatState.waitTimeMinutes = minutes;
  });
  
  // Auto-send toggle
  $('ofAutoSendToggle')?.addEventListener('click', async () => {
    const newValue = !ofAutoChatState.autoSendEnabled;
    const response = await chrome.runtime.sendMessage({
      type: 'OF_AUTOCHAT_SET_AUTO_SEND',
      data: { autoSend: newValue }
    });
    if (response.success) {
      ofAutoChatState.autoSendEnabled = response.autoSendEnabled;
      renderOFAutoChatPanel();
      showNotification(newValue ? '📤 Auto-Send enabled' : '📋 Queue-Only mode (pre-generate, send manually)');
    }
  });
}

// ============================================================
// ACTIONS
// ============================================================

async function regenerateResponse(peerId) {
  showNotification('🔄 Regenerating...');
  await chrome.runtime.sendMessage({
    type: 'OF_AUTOCHAT_REGENERATE',
    data: { peerId }
  });
}

async function editResponse(peerId) {
  const chatState = ofAutoChatState.activePool.find(c => c.peerId === peerId);
  if (!chatState?.generatedResponse) return;
  
  const newText = prompt('Edit response:', chatState.generatedResponse);
  if (newText && newText.trim()) {
    await chrome.runtime.sendMessage({
      type: 'OF_AUTOCHAT_UPDATE_RESPONSE',
      data: { peerId, response: newText.trim() }
    });
    showNotification('✏️ Response updated');
  }
}

async function sendResponse(peerId) {
  const chatState = ofAutoChatState.activePool.find(c => c.peerId === peerId);
  if (!chatState?.generatedResponse) {
    showNotification('❌ No response to send');
    return;
  }
  
  showNotification('📤 Sending...');
  const result = await chrome.runtime.sendMessage({
    type: 'OF_AUTOCHAT_SEND_MESSAGE',
    data: { peerId }
  });
  
  if (result.success) {
    showNotification('✅ Message sent!');
  } else {
    showNotification(`❌ ${result.error || 'Failed to send'}`);
  }
}

// ============================================================
// STATE SYNC
// ============================================================

export async function loadOFAutoChatState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'OF_AUTOCHAT_GET_STATE' });
    
    if (response.success && response.state) {
      ofAutoChatState = {
        ...ofAutoChatState,
        ...response.state
      };
      renderOFAutoChatPanel();
      renderOFAutoChatCards();
    }
  } catch (error) {
    console.error('[OF-AutoChat-UI] Failed to load state:', error);
  }
}

// Listen for state changes from background
export function setupOFAutoChatMessageListener() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'OF_AUTOCHAT_STATE_CHANGED') {
      ofAutoChatState = {
        ...ofAutoChatState,
        ...message.data
      };
      renderOFAutoChatPanel();
      renderOFAutoChatCards();
    }
    
    // Handle generation trigger
    if (message.type === 'OF_AUTOCHAT_TRIGGER_GENERATION') {
      console.log('[OF-AutoChat-UI] Generation trigger for:', message.data?.peerId);
      handleGenerationTrigger(message.data?.peerId, message.data?.subscriberName);
    }
    
    // Handle progress marking after successful auto-send
    if (message.type === 'OF_AUTOCHAT_MARK_PROGRESS') {
      console.log('[OF-AutoChat-UI] 📋 Progress mark request:', message.data);
      handleProgressMark(message.data);
    }
  });
}

// Handle marking progress after auto-chat sends a message
async function handleProgressMark(data) {
  const { peerId, subscriberName, profileId, stageIdx, actionIdx, goal } = data;
  
  if (stageIdx === undefined || actionIdx === undefined) {
    console.log('[OF-AutoChat-UI] No action info to mark');
    return;
  }
  
  console.log(`[OF-AutoChat-UI] 📋 Marking progress for ${subscriberName}: stage ${stageIdx}, action ${actionIdx}`);
  
  try {
    // Import Progress module
    const Progress = (await import('./scripts/progressManager.js')).default;
    const scriptsModule = await import('./scripts/index.js');
    const API = (await import('../utils/api.js')).default;
    
    // Save current state to restore later
    const previousState = {
      subscriberId: Store.get('currentSubscriberId'),
      currentScript: Store.get('currentScript'),
      currentNotes: Store.get('currentNotes')
    };
    
    // Set up context for this subscriber
    Store.set('currentSubscriberId', peerId);
    
    // Load chat data to get script assignment
    const chatResponse = await API.getChat(profileId, peerId);
    
    if (chatResponse.success && chatResponse.chat) {
      Store.set('storedChat', chatResponse.chat);
      Store.set('currentNotes', chatResponse.chat.notes || {});
    }
    
    // Load the script for this subscriber
    const storedNotes = chatResponse.chat?.notes || {};
    const subscribedSince = storedNotes.subscribedSince;
    await scriptsModule.autoSelectScript(subscribedSince);
    
    // Initialize progress for this subscriber/script
    await Progress.init(true);
    
    // Mark the action as complete
    const marked = await Progress.markComplete(stageIdx, actionIdx);
    
    if (marked) {
      console.log(`[OF-AutoChat-UI] ✅ Progress marked: stage ${stageIdx}, action ${actionIdx} (${goal?.slice(0, 40)}...)`);
      showNotification(`✅ Auto-chat: Step ${stageIdx + 1}.${actionIdx + 1} completed!`);
    } else {
      console.log(`[OF-AutoChat-UI] ⚠️ Progress marking returned false`);
    }
    
    // Restore previous state
    Store.set('currentSubscriberId', previousState.subscriberId);
    Store.set('currentScript', previousState.currentScript);
    Store.set('currentNotes', previousState.currentNotes);
    
    // Re-initialize progress for the original subscriber if any
    if (previousState.subscriberId) {
      await Progress.init(true);
    }
    
  } catch (error) {
    console.error('[OF-AutoChat-UI] Error marking progress:', error);
  }
}

// ============================================================
// AI GENERATION HANDLING
// ============================================================

// Handle AI generation trigger from background
async function handleGenerationTrigger(peerId, subscriberName) {
  if (!peerId) return;
  
  console.log(`[OF-AutoChat-UI] Generating response for ${subscriberName}...`);
  
  try {
    // Get the raw ID
    const rawId = peerId.replace(/^of:/, '');
    
    // First, let's get the current profile and stored chat data
    const profileId = Store.get('currentProfile')?.id;
    if (!profileId) {
      throw new Error('No profile selected');
    }
    
    // Import modules
    const aiModule = await import('./ai.js');
    const API = (await import('../utils/api.js')).default;
    const scriptsModule = await import('./scripts/index.js');
    const Progress = (await import('./scripts/progressManager.js')).default;
    
    // Save current state to restore later
    const previousState = {
      subscriberId: Store.get('currentSubscriberId'),
      messages: Store.get('messages'),
      storedChat: Store.get('storedChat'),
      currentScript: Store.get('currentScript'),
      currentNotes: Store.get('currentNotes')
    };
    
    // Set up context for this subscriber
    Store.set('currentSubscriberId', peerId);
    Store.set('subscriberName', subscriberName);
    
    // Load chat data from database (includes messages and notes)
    const chatResponse = await API.getChat(profileId, peerId);
    
    if (chatResponse.success && chatResponse.chat) {
      Store.set('storedChat', chatResponse.chat);
      Store.set('messages', chatResponse.chat.messages || []);
      Store.set('currentNotes', chatResponse.chat.notes || {});
      
      // Load script progress from the chat's notes
      if (chatResponse.chat.notes?.scriptProgress) {
        Store.set('scriptProgress', chatResponse.chat.notes.scriptProgress);
      }
    } else {
      console.warn(`[OF-AutoChat-UI] No chat data found for ${subscriberName}`);
      Store.set('messages', []);
    }
    
    // ===== IMPORTANT: Load the script for this subscriber =====
    // Try to get their assigned script or use auto-selection
    const storedNotes = chatResponse.chat?.notes || {};
    const subscribedSince = storedNotes.subscribedSince;
    
    // Auto-select script based on subscriber day (same logic as manual chat)
    await scriptsModule.autoSelectScript(subscribedSince);
    
    const currentScript = Store.get('currentScript');
    console.log(`[OF-AutoChat-UI] Script loaded for ${subscriberName}: ${currentScript?.name || 'None'}`);
    
    // ===== FIX: Initialize progress for this subscriber/script =====
    // This ensures we know which steps are already completed
    await Progress.init(true); // Force reload to get fresh progress
    console.log(`[OF-AutoChat-UI] Progress initialized for ${subscriberName}`);
    
    // Get current action info BEFORE generating (for progress tracking)
    const currentAction = await scriptsModule.getActionForGeneration();
    const actionInfo = currentAction ? {
      stageIdx: currentAction.stageIdx,
      actionIdx: currentAction.actionIdx,
      goal: currentAction.goal
    } : null;
    
    console.log(`[OF-AutoChat-UI] Current action for ${subscriberName}:`, actionInfo?.goal || 'No action');
    
    // Generate the response (now with proper script context and progress)
    const responseText = await aiModule.generateResponseText();
    
    // Restore previous state
    Store.set('currentSubscriberId', previousState.subscriberId);
    Store.set('messages', previousState.messages);
    Store.set('storedChat', previousState.storedChat);
    Store.set('currentScript', previousState.currentScript);
    Store.set('currentNotes', previousState.currentNotes);
    
    // Re-initialize progress for the original subscriber
    if (previousState.subscriberId) {
      await Progress.init(true);
    }
    
    if (responseText) {
      console.log(`[OF-AutoChat-UI] ✅ Generated response for ${subscriberName}: "${responseText.substring(0, 50)}..."`);
      
      // Send result back to background WITH action info for progress tracking
      await chrome.runtime.sendMessage({
        type: 'OF_AUTOCHAT_GENERATION_RESULT',
        data: {
          peerId,
          success: true,
          response: responseText,
          actionInfo: actionInfo // Include for marking progress after send
        }
      });
    } else {
      throw new Error('No response generated - check if script is assigned');
    }
    
  } catch (error) {
    console.error(`[OF-AutoChat-UI] Generation error for ${subscriberName}:`, error);
    
    await chrome.runtime.sendMessage({
      type: 'OF_AUTOCHAT_GENERATION_RESULT',
      data: {
        peerId,
        success: false,
        error: error.message
      }
    });
  }
}

// ============================================================
// PRE-GENERATED RESPONSE ACCESS
// Called by chat module when user opens a subscriber chat
// ============================================================

export async function getPregenerated(peerId) {
  if (!peerId) return null;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'OF_AUTOCHAT_GET_PREGENERATED',
      data: { peerId }
    });
    if (result?.success && result.response) {
      console.log(`[OF-AutoChat-UI] 📦 Pre-generated response found for ${peerId}`);
      return result.response;
    }
  } catch (e) {
    // Non-critical
  }
  return null;
}

// ============================================================
// INITIALIZATION
// ============================================================

export function initOFAutoChat() {
  console.log('[OF-AutoChat-UI] 🚀 initOFAutoChat called');
  setupOFAutoChatMessageListener();
  loadOFAutoChatState();
}

// ============================================================
// EXPORT
// ============================================================

export default {
  renderOFAutoChatPanel,
  renderOFAutoChatCards,
  loadOFAutoChatState,
  setupOFAutoChatMessageListener,
  initOFAutoChat,
  getPregenerated
};
