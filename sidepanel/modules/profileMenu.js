// ============================================================
// PROFILE MENU MODULE - Handle profile menu dropdown
// ============================================================

import { $ } from '../utils/dom.js';
import { showNotification } from '../utils/notify.js';
import { apiRequest } from '../utils/api.js';
import { hideCreditsDisplay, showCreditsDisplay } from './credits.js';

// Setup profile menu event listeners
export const setupProfileMenu = () => {
  const profileMenuBtn = $('profileMenuBtn');
  const profileMenu = $('profileMenu');
  const settingsMenuBtn = $('settingsMenuBtn');
  const billingMenuBtn = $('billingMenuBtn');
  const logoutMenuBtn = $('logoutMenuBtn');
  
  if (!profileMenuBtn || !profileMenu) {
    console.warn('[ProfileMenu] Profile menu elements not found');
    return;
  }
  
  // Toggle profile menu
  profileMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    profileMenu.classList.toggle('hidden');
  });
  
  // Close menu when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.profile-menu-container')) {
      profileMenu.classList.add('hidden');
    }
  });
  
  // Settings menu item - open the settings panel in Chat tab
  if (settingsMenuBtn) {
    settingsMenuBtn.addEventListener('click', () => {
      profileMenu.classList.add('hidden');
      console.log('[ProfileMenu] Settings clicked');
      
      // Switch to Chat tab first
      const chatTabBtn = document.querySelector('[data-tab="chat"]');
      if (chatTabBtn && !chatTabBtn.classList.contains('active')) {
        chatTabBtn.click();
      }
      
      // Expand the settings panel
      const settingsPanelChat = $('settingsPanelChat');
      const settingsPanelBody = $('settingsPanelBody');
      const settingsPanelArrow = $('settingsPanelArrow');
      
      if (settingsPanelChat && !settingsPanelChat.classList.contains('expanded')) {
        settingsPanelChat.classList.remove('collapsed');
        settingsPanelChat.classList.add('expanded');
        if (settingsPanelBody) settingsPanelBody.classList.remove('hidden');
        if (settingsPanelArrow) settingsPanelArrow.textContent = '▼';
        
        // Scroll into view
        setTimeout(() => {
          settingsPanelChat.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
      }
    });
  }
  
  // API Keys menu item
  const apiKeysMenuBtn = $('apiKeysMenuBtn');
  if (apiKeysMenuBtn) {
    apiKeysMenuBtn.addEventListener('click', () => {
      profileMenu.classList.add('hidden');
      console.log('[ProfileMenu] API Keys clicked');
      openApiKeysModal();
    });
  }
  
  // Billing menu item
  if (billingMenuBtn) {
    billingMenuBtn.addEventListener('click', () => {
      profileMenu.classList.add('hidden');
      // TODO: Open billing page
      console.log('[ProfileMenu] Billing clicked');
      // For now, open credits modal
      const creditsBtn = $('creditsBtn');
      if (creditsBtn) {
        creditsBtn.click();
      }
    });
  }
  
  // Log out menu item
  if (logoutMenuBtn) {
    logoutMenuBtn.addEventListener('click', async () => {
      profileMenu.classList.add('hidden');
      
      if (!confirm('Are you sure you want to logout?')) return;
      
      console.log('[ProfileMenu] Logging out...');
      
      try {
        await FirebaseAuth.signOut();
        showNotification('👋 Logged out successfully');
      } catch (error) {
        console.error('[ProfileMenu] Logout error:', error);
        showNotification('❌ Logout failed', 'error');
      }
    });
  }
  
  console.log('[ProfileMenu] Profile menu initialized');
};

// Setup settings panel in Chat Tab
export const setupSettingsPanelChat = () => {
  const settingsPanelChat = $('settingsPanelChat');
  const settingsPanelHeader = $('settingsPanelHeaderToggle');
  const settingsPanelBody = $('settingsPanelBody');
  const settingsPanelArrow = $('settingsPanelArrow');
  
  if (!settingsPanelChat || !settingsPanelHeader) {
    console.warn('[ProfileMenu] Settings panel elements not found');
    return;
  }
  
  // Toggle settings panel
  settingsPanelHeader.addEventListener('click', () => {
    const isCollapsed = settingsPanelChat.classList.contains('collapsed');
    
    if (isCollapsed) {
      // Expand
      settingsPanelChat.classList.remove('collapsed');
      settingsPanelChat.classList.add('expanded');
      if (settingsPanelBody) settingsPanelBody.classList.remove('hidden');
      if (settingsPanelArrow) settingsPanelArrow.textContent = '▼';
    } else {
      // Collapse
      settingsPanelChat.classList.remove('expanded');
      settingsPanelChat.classList.add('collapsed');
      if (settingsPanelBody) settingsPanelBody.classList.add('hidden');
      if (settingsPanelArrow) settingsPanelArrow.textContent = '▶';
    }
  });
  
  // Sync settings between main panel and chat panel
  syncSettingsInputs();
  
  // Also populate situational reactions in the chat panel
  populateSituationalInChatPanel();
  
  console.log('[ProfileMenu] Settings panel in Chat Tab initialized');
};

// Populate situational reactions in chat panel
const populateSituationalInChatPanel = () => {
  // Import settings module to get situational presets
  import('./settings.js').then(settingsModule => {
    const situationalSettings = settingsModule.getSituationalPresets();
    const container = $('situationalListChat');
    
    if (!container || !situationalSettings) return;
    
    container.innerHTML = Object.entries(situationalSettings).map(([key, preset]) => `
      <div class="situational-item ${preset.enabled ? '' : 'disabled'}" data-preset="${key}">
        <div class="situational-header">
          <span class="situational-name">${preset.name}</span>
          <label class="toggle-switch situational-toggle">
            <input type="checkbox" data-preset="${key}" ${preset.enabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <textarea class="situational-response" data-preset="${key}" placeholder="Response...">${preset.response || ''}</textarea>
        ${preset.triggers?.length ? `
          <div class="situational-triggers">
            <strong>Triggers:</strong> ${preset.triggers.slice(0, 5).join(', ')}${preset.triggers.length > 5 ? '...' : ''}
          </div>
        ` : ''}
      </div>
    `).join('');
    
    // Add event listeners for toggles
    container.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        const presetId = e.target.dataset.preset;
        const enabled = e.target.checked;
        settingsModule.updateSituationalPreset(presetId, { enabled });
        
        // Update UI
        const item = container.querySelector(`.situational-item[data-preset="${presetId}"]`);
        if (item) item.classList.toggle('disabled', !enabled);
        
        // Also update the main settings panel if it exists
        const mainContainer = $('situationalList');
        if (mainContainer) {
          const mainItem = mainContainer.querySelector(`.situational-item[data-preset="${presetId}"]`);
          if (mainItem) {
            mainItem.classList.toggle('disabled', !enabled);
            const mainCheckbox = mainItem.querySelector('input[type="checkbox"]');
            if (mainCheckbox) mainCheckbox.checked = enabled;
          }
        }
      });
    });
    
    // Add event listeners for response text (auto-save on change)
    container.querySelectorAll('textarea.situational-response').forEach(textarea => {
      let saveTimeout;
      textarea.addEventListener('input', (e) => {
        const presetId = e.target.dataset.preset;
        const response = e.target.value;
        
        // Debounce save
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
          settingsModule.updateSituationalPreset(presetId, { response });
          
          // Also update the main settings panel if it exists
          const mainContainer = $('situationalList');
          if (mainContainer) {
            const mainTextarea = mainContainer.querySelector(`textarea[data-preset="${presetId}"]`);
            if (mainTextarea) mainTextarea.value = response;
          }
        }, 500);
      });
    });
  });
};

// Sync settings between the main settings panel and the chat panel
const syncSettingsInputs = () => {
  // Auto-generate toggle
  const autoGenerateToggle = $('autoGenerateToggle');
  const autoGenerateToggleChat = $('autoGenerateToggleChat');
  
  if (autoGenerateToggle && autoGenerateToggleChat) {
    autoGenerateToggleChat.checked = autoGenerateToggle.checked;
    
    autoGenerateToggleChat.addEventListener('change', () => {
      autoGenerateToggle.checked = autoGenerateToggleChat.checked;
      autoGenerateToggle.dispatchEvent(new Event('change'));
    });
    
    autoGenerateToggle.addEventListener('change', () => {
      autoGenerateToggleChat.checked = autoGenerateToggle.checked;
    });
  }
  
  // Auto-notes toggle
  const autoNotesToggle = $('autoNotesToggle');
  const autoNotesToggleChat = $('autoNotesToggleChat');
  
  if (autoNotesToggle && autoNotesToggleChat) {
    autoNotesToggleChat.checked = autoNotesToggle.checked;
    
    autoNotesToggleChat.addEventListener('change', () => {
      autoNotesToggle.checked = autoNotesToggleChat.checked;
      autoNotesToggle.dispatchEvent(new Event('change'));
    });
    
    autoNotesToggle.addEventListener('change', () => {
      autoNotesToggleChat.checked = autoNotesToggle.checked;
    });
  }
  
  // Typing speed slider
  const typingSpeedSlider = $('typingSpeedSlider');
  const typingSpeedSliderChat = $('typingSpeedSliderChat');
  const typingSpeedValue = $('typingSpeedValue');
  const typingSpeedValueChat = $('typingSpeedValueChat');
  
  if (typingSpeedSlider && typingSpeedSliderChat) {
    typingSpeedSliderChat.value = typingSpeedSlider.value;
    if (typingSpeedValueChat) typingSpeedValueChat.textContent = typingSpeedSlider.value;
    
    typingSpeedSliderChat.addEventListener('input', () => {
      typingSpeedSlider.value = typingSpeedSliderChat.value;
      if (typingSpeedValue) typingSpeedValue.textContent = typingSpeedSliderChat.value;
      if (typingSpeedValueChat) typingSpeedValueChat.textContent = typingSpeedSliderChat.value;
      typingSpeedSlider.dispatchEvent(new Event('input'));
    });
    
    typingSpeedSlider.addEventListener('input', () => {
      typingSpeedSliderChat.value = typingSpeedSlider.value;
      if (typingSpeedValueChat) typingSpeedValueChat.textContent = typingSpeedSlider.value;
    });
  }
};

// ============================================================
// API KEYS MODAL FUNCTIONALITY
// ============================================================

// Track if user has their own API key
let hasOwnApiKey = false;

// Open API Keys modal and load current status
async function openApiKeysModal() {
  const modal = $('apiKeysModal');
  if (!modal) return;
  
  modal.classList.remove('hidden');
  
  // Setup event listeners
  setupApiKeysModalListeners();
  
  // Load current status
  await loadApiKeyStatus();
}

// Setup modal event listeners
function setupApiKeysModalListeners() {
  const closeBtn = $('closeApiKeysModalBtn');
  const closeBtn2 = $('closeApiKeysBtn');
  const saveBtn = $('saveApiKeyBtn');
  const removeBtn = $('removeApiKeyBtn');
  const modal = $('apiKeysModal');
  
  // Close buttons
  if (closeBtn) closeBtn.onclick = () => modal.classList.add('hidden');
  if (closeBtn2) closeBtn2.onclick = () => modal.classList.add('hidden');
  
  // Save API key
  if (saveBtn) saveBtn.onclick = saveApiKey;
  
  // Remove API key
  if (removeBtn) removeBtn.onclick = removeApiKey;
  
  // Close on outside click
  modal.onclick = (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  };
}

// Load current API key status
async function loadApiKeyStatus() {
  const statusIcon = $('apiKeyStatusIcon');
  const statusText = $('apiKeyStatusText');
  const removeBtn = $('removeApiKeyBtn');
  const apiKeyInput = $('grokApiKeyInput');
  
  try {
    const response = await apiRequest('/settings', { method: 'GET' });
    
    if (response.success && response.settings?.hasOwnApiKey) {
      hasOwnApiKey = true;
      if (statusIcon) statusIcon.textContent = '🔑';
      if (statusText) statusText.textContent = 'Using your own API key (Unlimited)';
      if (removeBtn) removeBtn.classList.remove('hidden');
      if (apiKeyInput) apiKeyInput.placeholder = '••••••••••••';
    } else {
      hasOwnApiKey = false;
      if (statusIcon) statusIcon.textContent = '💳';
      if (statusText) statusText.textContent = 'Using credits';
      if (removeBtn) removeBtn.classList.add('hidden');
      if (apiKeyInput) apiKeyInput.placeholder = 'xai-...';
    }
  } catch (error) {
    console.error('[ApiKeys] Error loading status:', error);
    if (statusText) statusText.textContent = 'Error loading status';
  }
}

// Save API key
async function saveApiKey() {
  const apiKeyInput = $('grokApiKeyInput');
  const savingState = $('apiKeySaving');
  const inputSection = $('apiKeyInputSection');
  
  const apiKey = apiKeyInput?.value?.trim();
  
  if (!apiKey) {
    showNotification('❌ Please enter an API key', 'error');
    return;
  }
  
  if (!apiKey.startsWith('xai-')) {
    showNotification('❌ API key must start with "xai-"', 'error');
    return;
  }
  
  // Show loading state
  if (inputSection) inputSection.classList.add('hidden');
  if (savingState) savingState.classList.remove('hidden');
  
  try {
    const response = await apiRequest('/settings/api-key', {
      method: 'POST',
      body: JSON.stringify({ apiKey })
    });
    
    if (response.success) {
      showNotification('✅ API key saved! You now have unlimited AI access.', 'success');
      hasOwnApiKey = true;
      
      // Clear the input
      if (apiKeyInput) apiKeyInput.value = '';
      
      // Hide credits display since using own key
      hideCreditsDisplay();
      
      // Update status
      await loadApiKeyStatus();
    } else {
      showNotification(`❌ ${response.error || 'Failed to save API key'}`, 'error');
    }
  } catch (error) {
    console.error('[ApiKeys] Error saving:', error);
    showNotification('❌ Failed to validate API key', 'error');
  } finally {
    // Hide loading state
    if (savingState) savingState.classList.add('hidden');
    if (inputSection) inputSection.classList.remove('hidden');
  }
}

// Remove API key
async function removeApiKey() {
  if (!confirm('Remove your API key? You will use credits for AI responses.')) {
    return;
  }
  
  const savingState = $('apiKeySaving');
  const inputSection = $('apiKeyInputSection');
  
  // Show loading state
  if (inputSection) inputSection.classList.add('hidden');
  if (savingState) savingState.classList.remove('hidden');
  
  try {
    const response = await apiRequest('/settings/api-key', {
      method: 'DELETE'
    });
    
    if (response.success) {
      showNotification('🔑 API key removed. Using credits now.', 'success');
      hasOwnApiKey = false;
      
      // Show credits display since back to using credits
      showCreditsDisplay();
      
      await loadApiKeyStatus();
    } else {
      showNotification(`❌ ${response.error || 'Failed to remove API key'}`, 'error');
    }
  } catch (error) {
    console.error('[ApiKeys] Error removing:', error);
    showNotification('❌ Failed to remove API key', 'error');
  } finally {
    if (savingState) savingState.classList.add('hidden');
    if (inputSection) inputSection.classList.remove('hidden');
  }
}

// Export for external use
export { hasOwnApiKey, openApiKeysModal };

// Initialize all profile menu functionality
export const initProfileMenu = () => {
  setupProfileMenu();
  setupSettingsPanelChat();
};

export default {
  setupProfileMenu,
  setupSettingsPanelChat,
  initProfileMenu,
  openApiKeysModal
};
