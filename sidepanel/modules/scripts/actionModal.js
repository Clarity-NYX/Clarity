// ============================================================
// SCRIPTS MODULE - ACTION MODAL
// With Vault Item Scanning Support & Image Pool Selection
// ============================================================

import { $ } from '../../utils/dom.js';
import { showNotification } from '../../utils/notify.js';
import Store from '../../state/store.js';
import * as ImagePool from '../imagePool.js';

// Modal state
let currentActionStageIndex = -1;
let currentActionIndex = -1; // -1 for add mode, >= 0 for edit mode
let selectedActionType = 'text';
let selectedVaultItem = null;  // Store selected vault item (OnlyFans)
let selectedPoolImage = null;  // Store selected pool image (Telegram)

// Callback for re-rendering sections (set from editor.js)
let _renderEditorSections = null;
let _getEditingScript = null;
let _triggerAutoSave = null;

export const setActionModalCallbacks = (renderSections, getScript, autoSave) => {
  _renderEditorSections = renderSections;
  _getEditingScript = getScript;
  _triggerAutoSave = autoSave;
};

// Get selected vault item (for external access)
export const getSelectedVaultItem = () => selectedVaultItem;

// Set selected vault item (called when vault item is scanned)
export const setSelectedVaultItem = (item) => {
  selectedVaultItem = item;
  updateVaultPreview();
};

// Clear selected vault item
export const clearSelectedVaultItem = () => {
  selectedVaultItem = null;
  updateVaultPreview();
};

// Get selected pool image (for external access)
export const getSelectedPoolImage = () => selectedPoolImage;

// Set selected pool image
export const setSelectedPoolImage = (image) => {
  selectedPoolImage = image;
  updateImagePoolPreview();
};

// Clear selected pool image
export const clearSelectedPoolImage = () => {
  selectedPoolImage = null;
  updateImagePoolPreview();
};

// Check if current platform is Telegram
const isTelegramPlatform = () => {
  const platform = Store.get('selectedPlatform');
  return platform === 'telegram';
};

// Update Image Pool preview display (for Telegram)
const updateImagePoolPreview = () => {
  const previewContainer = $('poolImagePreview');
  const selectBtn = $('selectPoolImageBtn');
  
  if (!previewContainer) return;
  
  if (selectedPoolImage) {
    // Support both downloadURL (Firebase Storage) and imageData (legacy/base64)
    const imageUrl = selectedPoolImage.downloadURL || selectedPoolImage.imageData;
    const isVideo = selectedPoolImage.mediaType === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(imageUrl || '');
    
    const mediaTag = isVideo
      ? `<video src="${imageUrl}" class="pool-preview-thumb" muted preload="metadata"></video>`
      : `<img src="${imageUrl}" class="pool-preview-thumb" alt="${selectedPoolImage.name}">`;
    
    previewContainer.classList.remove('hidden');
    previewContainer.innerHTML = `
      <div class="pool-image-preview">
        ${mediaTag}
        <div class="pool-preview-info">
          <span class="pool-preview-name">${isVideo ? '🎬 ' : ''}${selectedPoolImage.name}</span>
          <span class="pool-preview-category">${selectedPoolImage.category || ''}</span>
        </div>
        <button type="button" id="removePoolImageBtn" class="pool-preview-remove" title="Remove">✕</button>
      </div>
    `;
    
    // Add remove button listener
    $('removePoolImageBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      clearSelectedPoolImage();
    });
    
    // Update button text
    if (selectBtn) selectBtn.textContent = '🔄 Change Image';
  } else {
    previewContainer.classList.add('hidden');
    previewContainer.innerHTML = '';
    
    // Reset button text
    if (selectBtn) selectBtn.textContent = '📸 Select from Pool';
  }
};

// Show Image Pool picker modal - now uses SCRIPT's image pool
const showImagePoolPicker = () => {
  // Get images from the current script's image pool (not the global ImagePool)
  const editingScript = _getEditingScript ? _getEditingScript() : null;
  const scriptImages = editingScript?.imagePool || [];
  
  // Also get from global pool as fallback
  const globalImages = ImagePool.getImages();
  
  // Normalize script images (can be old format string or new format object)
  const normalizedScriptImages = scriptImages.map((img, idx) => {
    if (typeof img === 'string') {
      return {
        id: `script_img_${idx}`,
        name: `Image ${idx + 1}`,
        imageData: img,
        description: '',
        category: 'other',
        tags: []
      };
    }
    return img;
  });
  
  // Combine: script images first, then global pool
  const allImages = [
    ...normalizedScriptImages,
    ...globalImages.filter(g => !normalizedScriptImages.some(s => s.id === g.id))
  ];
  
  if (allImages.length === 0) {
    showNotification('No images in pool. Add images first in Script Timing Settings!');
    return;
  }
  
  // Create picker modal
  const picker = document.createElement('div');
  picker.id = 'imagePoolPicker';
  picker.className = 'modal-overlay';
  picker.innerHTML = `
    <div class="modal image-pool-picker-modal">
      <div class="modal-header">
        <h3>📸 Select Image</h3>
        <button type="button" class="modal-close-btn" id="closePoolPicker">×</button>
      </div>
      <div class="modal-body">
        ${normalizedScriptImages.length > 0 ? '<p style="font-size:12px;color:var(--text-secondary);margin:0 0 8px;">Script Images (from Image Pool in settings):</p>' : ''}
        <div class="image-picker-grid">
          ${allImages.map(img => {
            // Support both downloadURL (Firebase) and imageData (legacy)
            const imageUrl = img.downloadURL || img.imageData;
            const isVid = img.mediaType === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(imageUrl || '');
            const mediaEl = isVid
              ? `<video src="${imageUrl}" muted preload="metadata" style="width:100%;height:100%;object-fit:cover;"></video>`
              : `<img src="${imageUrl}" alt="${img.name}" loading="lazy">`;
            return `
              <div class="image-picker-item" data-id="${img.id}" title="${img.description || img.name}">
                ${mediaEl}
                <div class="image-picker-overlay">
                  <span>${isVid ? '🎬 ' : ''}${img.name}</span>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(picker);
  
  // Store all images for lookup
  const imagesMap = new Map(allImages.map(img => [img.id, img]));
  
  // Add click handlers
  picker.querySelectorAll('.image-picker-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = item.dataset.id;
      const image = imagesMap.get(id);
      if (image) {
        setSelectedPoolImage(image);
        showNotification('Image selected!');
      }
      picker.remove();
    });
  });
  
  // Close button
  $('closePoolPicker')?.addEventListener('click', () => picker.remove());
  
  // Close on overlay click
  picker.addEventListener('click', (e) => {
    if (e.target === picker) picker.remove();
  });
};

// Update vault preview display
const updateVaultPreview = () => {
  const previewContainer = $('vaultItemPreview');
  const scanBtn = $('scanVaultBtn');
  
  if (!previewContainer) return;
  
  if (selectedVaultItem) {
    previewContainer.classList.remove('hidden');
    previewContainer.innerHTML = `
      <div class="vault-preview">
        ${selectedVaultItem.thumbnail ? 
          `<img src="${selectedVaultItem.thumbnail}" class="vault-preview-thumb" alt="Vault item">` :
          `<div class="vault-preview-placeholder">${selectedVaultItem.mediaType === 'video' ? '🎬' : '📷'}</div>`
        }
        <div class="vault-preview-info">
          <span class="vault-preview-type">${selectedVaultItem.mediaType === 'video' ? '🎬 Video' : '📷 Photo'}</span>
          ${selectedVaultItem.duration ? `<span class="vault-preview-duration">${selectedVaultItem.duration}</span>` : ''}
          ${selectedVaultItem.date ? `<span class="vault-preview-date">${selectedVaultItem.date}</span>` : ''}
        </div>
        <button type="button" id="removeVaultItemBtn" class="vault-preview-remove" title="Remove">✕</button>
      </div>
    `;
    
    // Add remove button listener
    $('removeVaultItemBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      clearSelectedVaultItem();
    });
    
    // Update scan button text
    if (scanBtn) scanBtn.textContent = '🔄 Change Item';
  } else {
    previewContainer.classList.add('hidden');
    previewContainer.innerHTML = '';
    
    // Reset scan button text
    if (scanBtn) scanBtn.textContent = '🎯 Scan Vault Item';
  }
};

// Open action modal (for adding new action)
export const openActionModal = (stageIdx) => {
  currentActionStageIndex = stageIdx;
  currentActionIndex = -1; // Add mode
  selectedActionType = 'text';
  selectedVaultItem = null;  // Reset vault item
  selectedPoolImage = null;  // Reset pool image
  
  const modal = $('actionModal');
  const modalTitle = modal?.querySelector('.modal-header h3');
  const addBtn = $('addActionBtn');
  const goalInput = $('actionGoalInput');
  const priceInput = $('actionPriceInput');
  const priceGroup = $('actionPriceGroup');
  const vaultScanGroup = $('vaultScanGroup');
  const imagePoolGroup = $('imagePoolSelectGroup');
  const toneSelect = $('actionToneSelect');
  
  if (modalTitle) modalTitle.textContent = '➕ Add Action';
  if (addBtn) addBtn.textContent = '➕ Add Action';
  if (goalInput) goalInput.value = '';
  if (priceInput) priceInput.value = '0';
  if (priceGroup) priceGroup.classList.add('hidden');
  if (vaultScanGroup) vaultScanGroup.classList.add('hidden');
  if (imagePoolGroup) imagePoolGroup.classList.add('hidden');
  if (toneSelect) toneSelect.value = '';
  
  // Reset type selector
  document.querySelectorAll('.action-type-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.type === 'text');
  });
  
  // Reset previews
  updateVaultPreview();
  updateImagePoolPreview();
  
  modal?.classList.remove('hidden');
};

// Open action modal for editing existing action
export const openEditActionModal = (stageIdx, actionIdx) => {
  const editingScript = _getEditingScript ? _getEditingScript() : null;
  if (!editingScript?.stages[stageIdx]) return;
  
  const stage = editingScript.stages[stageIdx];
  const actions = stage.actions || stage.messages || [];
  const action = actions[actionIdx];
  
  if (!action) return;
  
  currentActionStageIndex = stageIdx;
  currentActionIndex = actionIdx; // Edit mode
  selectedActionType = action.type || 'text';
  selectedVaultItem = action.vaultItem || null;  // Load existing vault item
  selectedPoolImage = action.poolImage || null;  // Load existing pool image
  
  const isTelegram = isTelegramPlatform();
  
  const modal = $('actionModal');
  const modalTitle = modal?.querySelector('.modal-header h3');
  const addBtn = $('addActionBtn');
  const goalInput = $('actionGoalInput');
  const priceInput = $('actionPriceInput');
  const priceGroup = $('actionPriceGroup');
  const vaultScanGroup = $('vaultScanGroup');
  const imagePoolGroup = $('imagePoolSelectGroup');
  const toneSelect = $('actionToneSelect');
  
  if (modalTitle) modalTitle.textContent = '✏️ Edit Action';
  if (addBtn) addBtn.textContent = '💾 Save Changes';
  
  if (goalInput) goalInput.value = action.goal || action.text || '';
  if (priceInput) priceInput.value = String(action.price || 0);
  if (toneSelect) toneSelect.value = action.tone || '';
  
  const isMedia = selectedActionType === 'media';
  
  // Handle platform-specific media options
  // Show price and vault scan only for OnlyFans
  if (priceGroup) priceGroup.classList.toggle('hidden', !isMedia || isTelegram);
  if (vaultScanGroup) vaultScanGroup.classList.toggle('hidden', !isMedia || isTelegram);
  // Show image pool for BOTH platforms
  if (imagePoolGroup) imagePoolGroup.classList.toggle('hidden', !isMedia);
  
  // Set selected type
  document.querySelectorAll('.action-type-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.type === selectedActionType);
  });
  
  // Update previews with existing items
  updateVaultPreview();
  updateImagePoolPreview();
  
  modal?.classList.remove('hidden');
};

// Close action modal
export const closeActionModal = () => {
  const modal = $('actionModal');
  modal?.classList.add('hidden');
  currentActionStageIndex = -1;
  currentActionIndex = -1;
};

// Handle action type selection
export const selectActionType = (type) => {
  selectedActionType = type;
  const priceGroup = $('actionPriceGroup');
  const vaultScanGroup = $('vaultScanGroup');
  const imagePoolGroup = $('imagePoolSelectGroup');
  const goalInput = $('actionGoalInput');
  
  const isMedia = type === 'media';
  const isVoice = type === 'voice';
  const isTelegram = isTelegramPlatform();
  
  // Show/hide price for media type (OnlyFans PPV only - when using vault)
  if (priceGroup) priceGroup.classList.toggle('hidden', !isMedia || isTelegram);
  
  // Show vault scan for OnlyFans media (for PPV)
  if (vaultScanGroup) vaultScanGroup.classList.toggle('hidden', !isMedia || isTelegram);
  
  // Show image pool for BOTH platforms - allows direct image sending
  if (imagePoolGroup) imagePoolGroup.classList.toggle('hidden', !isMedia);
  
  // Update goal placeholder based on type
  if (goalInput) {
    if (isVoice) {
      goalInput.placeholder = "Voice message template, e.g., 'Hello [Name], how's your day babe?'\nUse [Name] for subscriber name, [Day] for day of week, [Time] for time of day";
    } else if (isMedia) {
      if (isTelegram) {
        goalInput.placeholder = "Description of this image action, e.g., 'Send teaser selfie to build interest'";
      } else {
        goalInput.placeholder = "What should this media achieve? Select from Image Pool OR Vault (for PPV)";
      }
    } else {
      goalInput.placeholder = "What should this action achieve? e.g., 'Build rapport and ask about their day'";
    }
  }
  
  document.querySelectorAll('.action-type-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.type === type);
  });
};

// Add or update action in section
export const addActionToSection = () => {
  const editingScript = _getEditingScript ? _getEditingScript() : null;
  
  if (currentActionStageIndex < 0 || !editingScript?.stages[currentActionStageIndex]) {
    showNotification('Error: No section selected');
    return;
  }
  
  const goalInput = $('actionGoalInput');
  const priceInput = $('actionPriceInput');
  const toneSelect = $('actionToneSelect');
  
  const goal = goalInput?.value?.trim();
  if (!goal) {
    showNotification('Please enter a goal for this action');
    goalInput?.focus();
    return;
  }
  
  const stage = editingScript.stages[currentActionStageIndex];
  const isTelegram = isTelegramPlatform();
  
  // Ensure actions array exists
  if (!stage.actions) {
    stage.actions = stage.messages || [];
    delete stage.messages;
  }
  
  if (currentActionIndex >= 0) {
    // EDIT MODE - Update existing action
    const action = stage.actions[currentActionIndex];
    if (action) {
      action.type = selectedActionType;
      action.goal = goal;
      action.tone = toneSelect?.value || undefined;
      
      if (selectedActionType === 'media') {
        // Always save price for media actions (used for PPV on OnlyFans)
        action.price = parseInt(priceInput?.value) || 0;
        
        // Pool image takes priority over vault (user can choose either for OnlyFans)
        if (selectedPoolImage) {
          // Save pool image (works for both Telegram and OnlyFans)
          action.poolImage = {
            id: selectedPoolImage.id,
            name: selectedPoolImage.name,
            downloadURL: selectedPoolImage.downloadURL || null,
            imageData: selectedPoolImage.imageData || null,
            storagePath: selectedPoolImage.storagePath || null
          };
          delete action.vaultItem; // Clear vault if pool image selected
        } else if (!isTelegram && selectedVaultItem) {
          // Save vault item for OnlyFans (only if no pool image selected)
          action.vaultItem = selectedVaultItem;
          delete action.poolImage;
        } else {
          // No media selected
          delete action.poolImage;
          delete action.vaultItem;
        }
      } else {
        delete action.price;
        delete action.vaultItem;
        delete action.poolImage;
      }
      
      closeActionModal();
      if (_renderEditorSections) _renderEditorSections();
      showNotification('Action updated!');
      
      // Auto-save after editing action
      if (_triggerAutoSave) _triggerAutoSave();
    }
  } else {
    // ADD MODE - Create new action
    const action = {
      type: selectedActionType,
      goal: goal,
      completed: false
    };
    
    const selectedTone = toneSelect?.value;
    if (selectedTone) {
      action.tone = selectedTone;
    }
    
    if (selectedActionType === 'media') {
      // Always save price for media actions (used for PPV on OnlyFans)
      action.price = parseInt(priceInput?.value) || 0;
      
      // Pool image takes priority over vault (user can choose either for OnlyFans)
      if (selectedPoolImage) {
        // Save pool image (works for both Telegram and OnlyFans)
        action.poolImage = {
          id: selectedPoolImage.id,
          name: selectedPoolImage.name,
          downloadURL: selectedPoolImage.downloadURL || null,
          imageData: selectedPoolImage.imageData || null,
          storagePath: selectedPoolImage.storagePath || null
        };
      } else if (!isTelegram && selectedVaultItem) {
        // Save vault item for OnlyFans (only if no pool image selected)
        action.vaultItem = selectedVaultItem;
      }
    }
    
    stage.actions.push(action);
    
    closeActionModal();
    if (_renderEditorSections) _renderEditorSections();
    showNotification('Action added!');
    
    // Auto-save after adding action
    if (_triggerAutoSave) _triggerAutoSave();
  }
};

// Delete action from section
export const deleteActionFromSection = (stageIdx, actionIdx) => {
  const editingScript = _getEditingScript ? _getEditingScript() : null;
  if (!editingScript) return;
  if (!confirm('Delete this action?')) return;
  
  const stage = editingScript.stages[stageIdx];
  const actions = stage.actions || stage.messages || [];
  
  actions.splice(actionIdx, 1);
  
  if (stage.actions) {
    stage.actions = actions;
  } else {
    stage.messages = actions;
  }
  
  if (_renderEditorSections) _renderEditorSections();
  showNotification('Action deleted');
  
  // Auto-save after deleting action
  if (_triggerAutoSave) _triggerAutoSave();
};

// Start vault scan mode
export const startVaultScan = async () => {
  try {
    // Get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab?.id) {
      showNotification('No active tab found');
      return;
    }
    
    // Check if on OnlyFans
    if (!tab.url?.includes('onlyfans.com')) {
      showNotification('Please open the OnlyFans vault page first');
      return;
    }
    
    // Send message to content script to start scan mode
    chrome.tabs.sendMessage(tab.id, { type: 'START_VAULT_SCAN' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Error starting vault scan:', chrome.runtime.lastError);
        showNotification('Failed to start vault scan. Refresh the OnlyFans page.');
        return;
      }
      
      if (response?.success) {
        showNotification('Click on a vault item to select it');
      }
    });
  } catch (error) {
    console.error('Vault scan error:', error);
    showNotification('Failed to start vault scan');
  }
};

// Setup action modal listeners
export const setupActionModalListeners = () => {
  // Action type selector buttons
  document.querySelectorAll('.action-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectActionType(btn.dataset.type);
    });
  });
  
  // Add action button in modal
  $('addActionBtn')?.addEventListener('click', addActionToSection);
  
  // Cancel/close action modal
  $('cancelActionBtn')?.addEventListener('click', closeActionModal);
  $('closeActionModalBtn')?.addEventListener('click', closeActionModal);
  
  // Scan vault item button (OnlyFans)
  $('scanVaultBtn')?.addEventListener('click', startVaultScan);
  
  // Select pool image button (Telegram)
  $('selectPoolImageBtn')?.addEventListener('click', showImagePoolPicker);
  
  // Listen for vault item selection from content script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'VAULT_ITEM_SELECTED') {
      console.log('Vault item received:', message.data);
      setSelectedVaultItem(message.data);
      showNotification('Vault item selected!');
      sendResponse({ success: true });
    }
    
    if (message.type === 'VAULT_SCAN_CANCELLED') {
      console.log('Vault scan cancelled');
      sendResponse({ success: true });
    }
    
    return true;
  });
};
