// ============================================================
// SCRIPTS MODULE - EDITOR (Script List & Editor Views)
// ============================================================

import Store from '../../state/store.js';
import { $, escapeHtml } from '../../utils/dom.js';
import { showNotification } from '../../utils/notify.js';
import API from '../../utils/api.js';
import { getScriptOrder, loadTimingSettings, saveTimingSettings } from './timing.js';
import { renderEditorSections, addNewSection, setSectionsCallbacks } from './sections.js';
import { setActionModalCallbacks, setupActionModalListeners } from './actionModal.js';
import { populateScriptDropdown, createNewScript, getCurrentProfileId, loadGlobalTemplates, copyTemplateToProfile, copyAllTemplatesToProfile, saveScriptAsTemplate } from './core.js';
import { initImageStorage, storeImage, getImage, getImages, deleteImage, getStorageStats } from './imageStorage.js';

// Editor state
let editingScript = null;
let editingScriptIndex = -1;
let autoSaveTimeout = null;
const AUTO_SAVE_DELAY = 1000; // 1 second debounce

// Getter for editing script (used by other modules)
export const getEditingScript = () => editingScript;

// ============================================================
// AUTO-SAVE FUNCTIONALITY
// ============================================================

// Trigger auto-save (debounced)
export const triggerAutoSave = () => {
  if (!editingScript || editingScriptIndex < 0) return;
  
  // Clear existing timeout
  if (autoSaveTimeout) {
    clearTimeout(autoSaveTimeout);
  }
  
  // Schedule auto-save
  autoSaveTimeout = setTimeout(async () => {
    console.log('[AutoSave] 💾 Auto-saving script...');
    await performAutoSave();
  }, AUTO_SAVE_DELAY);
};

// Perform the actual auto-save
const performAutoSave = async () => {
  if (!editingScript || editingScriptIndex < 0) {
    console.log('[AutoSave] ⚠️ No script to save');
    return;
  }
  
  const profileId = getCurrentProfileId();
  if (!profileId) {
    console.log('[AutoSave] ⚠️ No profile ID');
    return;
  }
  
  const nameInput = $('editScriptName');
  if (nameInput) editingScript.name = nameInput.value.trim() || editingScript.name;
  
  // Save timing settings
  saveTimingSettings(editingScript);
  
  // DEBUG: Log what we're sending
  const imagePoolSize = editingScript.imagePool?.length || 0;
  const totalImageDataSize = editingScript.imagePool?.reduce((acc, img) => {
    const dataSize = typeof img === 'string' ? img.length : (img.imageData?.length || 0);
    return acc + dataSize;
  }, 0) || 0;
  
  console.log('[AutoSave] 📊 DEBUG INFO:');
  console.log('  - Profile ID:', profileId);
  console.log('  - Script ID:', editingScript.id);
  console.log('  - Script Name:', editingScript.name);
  console.log('  - Stages:', editingScript.stages?.length || 0);
  console.log('  - Image Pool Size:', imagePoolSize, 'images');
  console.log('  - Total Image Data Size:', (totalImageDataSize / 1024).toFixed(2), 'KB');
  
  const payload = {
    profileId,
    scriptId: editingScript.id,
    name: editingScript.name,
    stages: editingScript.stages,
    timingSettings: editingScript.timingSettings,
    imagePool: editingScript.imagePool || [],
    imagePoolRandomize: editingScript.imagePoolRandomize ?? true
  };
  
  console.log('[AutoSave] 📤 Sending payload size:', (JSON.stringify(payload).length / 1024).toFixed(2), 'KB');
  
  try {
    const response = await API.updateProfileScript(payload);
    
    console.log('[AutoSave] 📥 Response:', response);
    
    if (response.success) {
      const scripts = Store.get('scripts');
      scripts[editingScriptIndex] = editingScript;
      Store.set('scripts', scripts);
      chrome.storage.local.set({ scripts });
      
      // CRITICAL: Also update currentScript if it's the same script!
      // This ensures the workflow sees the latest action data (type, poolImage, etc.)
      const currentScript = Store.get('currentScript');
      if (currentScript && currentScript.id === editingScript.id) {
        // Create a fresh copy to ensure Store detects the change
        const updatedScript = JSON.parse(JSON.stringify(editingScript));
        Store.set('currentScript', updatedScript);
        chrome.storage.local.set({ currentScriptId: updatedScript.id });
        console.log('[AutoSave] ✅ Also updated currentScript to sync workflow data');
      }
      
      populateScriptDropdown();
      console.log('[AutoSave] ✅ Script auto-saved successfully');
    } else {
      console.error('[AutoSave] ❌ Auto-save failed:', response.error);
      console.error('[AutoSave] ❌ Full response:', JSON.stringify(response, null, 2));
    }
  } catch (error) {
    console.error('[AutoSave] ❌ Auto-save error:', error);
    console.error('[AutoSave] ❌ Error name:', error.name);
    console.error('[AutoSave] ❌ Error message:', error.message);
    console.error('[AutoSave] ❌ Error stack:', error.stack);
  }
};

// Initialize callbacks for sections and action modal
export const initEditorCallbacks = () => {
  setSectionsCallbacks(getEditingScript, triggerAutoSave);
  setActionModalCallbacks(renderEditorSections, getEditingScript, triggerAutoSave);
};

// Show script list view
export const showScriptListView = () => {
  $('scriptListView')?.classList.remove('hidden');
  $('scriptEditorView')?.classList.add('hidden');
  editingScript = null;
  editingScriptIndex = -1;
};

// Show script editor view
export const showScriptEditorView = () => {
  $('scriptListView')?.classList.add('hidden');
  $('scriptEditorView')?.classList.remove('hidden');
};

// Render script list (sorted by order)
export const renderScriptList = () => {
  const listEl = $('scriptList');
  if (!listEl) return;
  
  const scripts = Store.get('scripts');
  
  if (!scripts || scripts.length === 0) {
    listEl.innerHTML = `<div class="scripts-empty"><p>No scripts yet. Create your first script!</p></div>`;
    return;
  }
  
  // Sort by order setting
  const sortedScripts = [...scripts].sort((a, b) => getScriptOrder(a) - getScriptOrder(b));
  
  listEl.innerHTML = sortedScripts.map((script) => {
    const sectionCount = script.stages?.length || 0;
    const order = script.timingSettings?.order;
    const orderBadge = order !== undefined ? `<span class="script-order-badge">#${order}</span>` : '';
    return `
      <div class="script-item" data-id="${script.id}">
        <div class="script-item-info">
          <span class="script-item-name">${orderBadge}${escapeHtml(script.name)}</span>
          <span class="script-item-meta">${sectionCount} section${sectionCount !== 1 ? 's' : ''}</span>
        </div>
        <span class="script-item-arrow">›</span>
      </div>
    `;
  }).join('');
  
  listEl.querySelectorAll('.script-item').forEach(item => {
    item.addEventListener('click', () => {
      const scriptId = item.dataset.id;
      const scripts = Store.get('scripts');
      const idx = scripts.findIndex(s => s.id === scriptId);
      if (idx !== -1) loadScriptIntoEditor(idx);
    });
  });
};

// Load script into editor
export const loadScriptIntoEditor = (scriptIndex) => {
  const scripts = Store.get('scripts');
  console.log('📂 Loading script into editor, index:', scriptIndex);
  console.log('📂 Available scripts:', scripts.length);
  
  if (scriptIndex < 0 || scriptIndex >= scripts.length) {
    showScriptListView();
    return;
  }
  
  editingScriptIndex = scriptIndex;
  editingScript = JSON.parse(JSON.stringify(scripts[scriptIndex]));
  console.log('📂 Editing script:', editingScript.name);
  console.log('📂 Script stages:', editingScript.stages?.length || 0);
  
  // Switch to editor view
  showScriptEditorView();
  
  const nameInput = $('editScriptName');
  if (nameInput) nameInput.value = editingScript.name;
  
  // Load timing settings
  loadTimingSettings(editingScript);
  
  renderEditorSections();
  
  // Load image pool
  renderImagePool();
};

// Handle creating new script from list view
export const handleCreateNewScript = async () => {
  const script = await createNewScript();
  if (script) {
    const scripts = Store.get('scripts');
    const idx = scripts.findIndex(s => s.id === script.id);
    if (idx !== -1) {
      loadScriptIntoEditor(idx);
    }
  }
};

// Save script (profile-specific)
export const saveEditingScript = async () => {
  if (!editingScript || editingScriptIndex < 0) return;
  
  const profileId = getCurrentProfileId();
  if (!profileId) {
    showNotification('Please select a profile first');
    return;
  }
  
  const nameInput = $('editScriptName');
  if (nameInput) editingScript.name = nameInput.value.trim() || editingScript.name;
  
  // Save timing settings
  saveTimingSettings(editingScript);
  
  try {
    const response = await API.updateProfileScript({
      profileId,
      scriptId: editingScript.id,
      name: editingScript.name,
      stages: editingScript.stages,
      timingSettings: editingScript.timingSettings,
      imagePool: editingScript.imagePool || [],
      imagePoolRandomize: editingScript.imagePoolRandomize ?? true
    });
    
    if (response.success) {
      const scripts = Store.get('scripts');
      scripts[editingScriptIndex] = editingScript;
      Store.set('scripts', scripts);
      chrome.storage.local.set({ scripts });
      
      // CRITICAL: Also update currentScript if it's the same script!
      const currentScript = Store.get('currentScript');
      if (currentScript && currentScript.id === editingScript.id) {
        const updatedScript = JSON.parse(JSON.stringify(editingScript));
        Store.set('currentScript', updatedScript);
        chrome.storage.local.set({ currentScriptId: updatedScript.id });
        console.log('[SaveScript] ✅ Also updated currentScript');
      }
      
      populateScriptDropdown();
      renderScriptList();
      showNotification('Script saved!');
    } else {
      showNotification(response.error || 'Failed to save script');
    }
  } catch (error) {
    console.error('Save script error:', error);
    showNotification('Failed to save script');
  }
};

// Delete script (profile-specific)
export const deleteEditingScript = async () => {
  if (!editingScript || editingScriptIndex < 0) return;
  if (!confirm(`Delete "${editingScript.name}"? This cannot be undone.`)) return;
  
  const profileId = getCurrentProfileId();
  if (!profileId) {
    showNotification('Please select a profile first');
    return;
  }
  
  try {
    const response = await API.deleteProfileScript({ profileId, scriptId: editingScript.id });
    
    if (response.success) {
      const scripts = Store.get('scripts');
      scripts.splice(editingScriptIndex, 1);
      Store.set('scripts', scripts);
      
      populateScriptDropdown();
      showScriptListView();
      renderScriptList();
      showNotification('Script deleted');
    } else {
      showNotification(response.error || 'Failed to delete script');
    }
  } catch (error) {
    console.error('Delete script error:', error);
    showNotification('Failed to delete script');
  }
};

// ============================================================
// SHARE SCRIPT TO ANOTHER PROFILE
// ============================================================

// Open share script modal
export const openShareScriptModal = () => {
  if (!editingScript) {
    showNotification('No script to share');
    return;
  }
  
  const profiles = Store.get('profiles') || [];
  const currentProfile = Store.get('currentProfile');
  
  // Filter out current profile
  const otherProfiles = profiles.filter(p => p.id !== currentProfile?.id);
  
  if (otherProfiles.length === 0) {
    showNotification('No other profiles to share to. Create another profile first.');
    return;
  }
  
  // Create modal if it doesn't exist
  let modal = $('shareScriptModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'shareScriptModal';
    modal.className = 'modal hidden';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>📤 Share Script to Profile</h3>
          <button id="closeShareScriptModalBtn" class="icon-btn">✕</button>
        </div>
        <div class="modal-body">
          <p style="margin-bottom: 12px; color: var(--text-secondary);">
            Copy "<strong id="shareScriptName"></strong>" to another profile:
          </p>
          <div id="shareScriptProfileList" class="profile-share-list"></div>
        </div>
        <div class="modal-footer">
          <button id="cancelShareScriptBtn" class="btn btn-secondary">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    
    // Setup close listeners
    $('closeShareScriptModalBtn')?.addEventListener('click', closeShareScriptModal);
    $('cancelShareScriptBtn')?.addEventListener('click', closeShareScriptModal);
  }
  
  // Update script name in modal
  const scriptNameEl = $('shareScriptName');
  if (scriptNameEl) scriptNameEl.textContent = editingScript.name;
  
  // Render profile list
  const listEl = $('shareScriptProfileList');
  if (listEl) {
    listEl.innerHTML = otherProfiles.map(profile => `
      <div class="share-profile-item" data-profile-id="${profile.id}">
        <span class="profile-avatar">${profile.avatar || '👤'}</span>
        <div class="share-profile-info">
          <div class="share-profile-name">${escapeHtml(profile.name)}</div>
          <div class="share-profile-meta">${profile.chatCount || 0} chats</div>
        </div>
        <button class="btn btn-sm btn-primary share-to-profile-btn" data-profile-id="${profile.id}">
          📤 Copy
        </button>
      </div>
    `).join('');
    
    // Add click handlers
    listEl.querySelectorAll('.share-to-profile-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const targetProfileId = e.target.dataset.profileId;
        const targetProfile = otherProfiles.find(p => p.id === targetProfileId);
        await shareScriptToProfile(targetProfileId, targetProfile?.name);
      });
    });
  }
  
  modal.classList.remove('hidden');
};

// Close share script modal
const closeShareScriptModal = () => {
  const modal = $('shareScriptModal');
  if (modal) modal.classList.add('hidden');
};

// Share/copy script to another profile
const shareScriptToProfile = async (targetProfileId, targetProfileName) => {
  if (!editingScript || !targetProfileId) return;
  
  const currentProfileId = getCurrentProfileId();
  if (!currentProfileId) {
    showNotification('No current profile');
    return;
  }
  
  // Show loading state
  const btn = document.querySelector(`.share-to-profile-btn[data-profile-id="${targetProfileId}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳...';
  }
  
  try {
    // Deep copy the entire script to preserve all nested data
    // including poolImage references in actions, image pool metadata, etc.
    const scriptCopy = JSON.parse(JSON.stringify(editingScript));
    
    // Clear the ID so a new one will be generated
    delete scriptCopy.id;
    
    // Add copy suffix to name
    scriptCopy.name = `${editingScript.name} (copy)`;
    
    // Log what we're sharing
    console.log('[ShareScript] 📤 Sharing script with:');
    console.log('  - Name:', scriptCopy.name);
    console.log('  - Stages:', scriptCopy.stages?.length || 0);
    console.log('  - Image Pool:', scriptCopy.imagePool?.length || 0, 'images');
    
    // Count actions with poolImage attached
    let actionsWithImages = 0;
    scriptCopy.stages?.forEach(stage => {
      stage.actions?.forEach(action => {
        if (action.poolImage) {
          actionsWithImages++;
          console.log(`  - Action "${action.goal?.slice(0, 30)}..." has poolImage:`, action.poolImage.name);
        }
      });
    });
    console.log('  - Actions with poolImage:', actionsWithImages);
    
    // Step 1: Create the script in the target profile (basic data)
    const response = await API.createProfileScript({
      profileId: targetProfileId,
      name: scriptCopy.name,
      stages: scriptCopy.stages || [],
      timingSettings: scriptCopy.timingSettings || {},
      imagePool: scriptCopy.imagePool || [],
      imagePoolRandomize: scriptCopy.imagePoolRandomize ?? true
    });
    
    if (response.success && response.script) {
      const newScriptId = response.script.id;
      console.log('[ShareScript] Script created with ID:', newScriptId);
      
      // Step 2: If there's imagePool data, do an update to ensure it's saved
      // (Some servers don't save imagePool on create, only on update)
      if (scriptCopy.imagePool?.length > 0 || actionsWithImages > 0) {
        console.log('[ShareScript] 📤 Updating script with imagePool and stages...');
        
        const updateResponse = await API.updateProfileScript({
          profileId: targetProfileId,
          scriptId: newScriptId,
          name: scriptCopy.name,
          stages: scriptCopy.stages || [],
          timingSettings: scriptCopy.timingSettings || {},
          imagePool: scriptCopy.imagePool || [],
          imagePoolRandomize: scriptCopy.imagePoolRandomize ?? true
        });
        
        if (updateResponse.success) {
          console.log('[ShareScript] ✅ ImagePool updated successfully');
        } else {
          console.warn('[ShareScript] ⚠️ ImagePool update failed:', updateResponse.error);
        }
      }
      
      closeShareScriptModal();
      const imageCount = scriptCopy.imagePool?.length || 0;
      showNotification(`✅ Script shared to ${targetProfileName || 'profile'}! (${imageCount} images)`);
      console.log('[ShareScript] Successfully shared script to profile:', targetProfileId);
    } else {
      showNotification(response.error || 'Failed to share script');
      console.error('[ShareScript] Failed:', response.error);
    }
  } catch (error) {
    console.error('[ShareScript] Error:', error);
    showNotification('Failed to share script');
  } finally {
    // Reset button state
    if (btn) {
      btn.disabled = false;
      btn.textContent = '📤 Copy';
    }
  }
};

// ============================================================
// TEMPLATES MODAL
// ============================================================

let selectedTemplateIds = new Set();

const openTemplatesModal = async () => {
  $('templatesModal')?.classList.remove('hidden');
  $('templatesLoading')?.classList.remove('hidden');
  $('templatesList')?.classList.add('hidden');
  $('noTemplatesMessage')?.classList.add('hidden');
  
  selectedTemplateIds.clear();
  updateImportSelectedBtn();
  
  // Load global templates
  const templates = await loadGlobalTemplates();
  
  $('templatesLoading')?.classList.add('hidden');
  
  if (templates && templates.length > 0) {
    renderTemplatesList(templates);
    $('templatesList')?.classList.remove('hidden');
  } else {
    $('noTemplatesMessage')?.classList.remove('hidden');
  }
};

const closeTemplatesModal = () => {
  $('templatesModal')?.classList.add('hidden');
  selectedTemplateIds.clear();
};

const renderTemplatesList = (templates) => {
  const listEl = $('templatesList');
  if (!listEl) return;
  
  listEl.innerHTML = templates.map(template => {
    const stageCount = template.stages?.length || 0;
    const actionCount = template.stages?.reduce((sum, s) => sum + (s.actions?.length || s.messages?.length || 0), 0) || 0;
    
    return `
      <div class="template-item" data-id="${template.id}">
        <input type="checkbox" class="template-checkbox" data-id="${template.id}">
        <div class="template-info">
          <div class="template-name">${escapeHtml(template.name)}</div>
          <div class="template-meta">
            <span>${stageCount} stage${stageCount !== 1 ? 's' : ''}</span>
            <span>•</span>
            <span>${actionCount} action${actionCount !== 1 ? 's' : ''}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
  
  // Add click handlers
  listEl.querySelectorAll('.template-item').forEach(item => {
    const checkbox = item.querySelector('.template-checkbox');
    const id = item.dataset.id;
    
    item.addEventListener('click', (e) => {
      if (e.target !== checkbox) {
        checkbox.checked = !checkbox.checked;
      }
      
      if (checkbox.checked) {
        selectedTemplateIds.add(id);
        item.classList.add('selected');
      } else {
        selectedTemplateIds.delete(id);
        item.classList.remove('selected');
      }
      
      updateImportSelectedBtn();
    });
  });
};

const updateImportSelectedBtn = () => {
  const btn = $('importSelectedBtn');
  if (!btn) return;
  
  const count = selectedTemplateIds.size;
  btn.disabled = count === 0;
  btn.textContent = count > 0 ? `📥 Import Selected (${count})` : '📥 Import Selected';
};

const importSelectedTemplates = async () => {
  if (selectedTemplateIds.size === 0) return;
  
  const btn = $('importSelectedBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Importing...';
  }
  
  let successCount = 0;
  for (const templateId of selectedTemplateIds) {
    const success = await copyTemplateToProfile(templateId);
    if (success) successCount++;
  }
  
  closeTemplatesModal();
  
  if (successCount > 0) {
    showNotification(`Imported ${successCount} script${successCount !== 1 ? 's' : ''}!`);
  }
};

const importAllTemplates = async () => {
  const btn = $('importAllBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Importing...';
  }
  
  await copyAllTemplatesToProfile();
  
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Import All';
  }
  
  closeTemplatesModal();
};

// ============================================================
// IMAGE POOL MANAGEMENT (with metadata)
// ============================================================

let pendingImageFile = null;
let pendingImageBase64 = null;

// Render image pool grid - loads images from Firebase Storage URLs
const renderImagePool = async () => {
  const grid = $('imagePoolGrid');
  const randomizeCheckbox = $('imagePoolRandomize');
  
  if (!grid || !editingScript) return;
  
  const images = editingScript.imagePool || [];
  
  if (images.length === 0) {
    grid.innerHTML = '';
    return;
  }
  
  // Build grid with images from Firebase Storage URLs
  const imageElements = images.map((img, idx) => {
    let imageUrl = null;
    let name = 'Unknown';
    let description = '';
    
    // Check if this has a Firebase Storage downloadURL (new format)
    if (typeof img === 'object' && img.downloadURL) {
      imageUrl = img.downloadURL;
      name = img.name || `Image ${idx + 1}`;
      description = img.description || '';
    } else if (typeof img === 'object' && img.imageData) {
      // Old format with embedded data
      imageUrl = img.imageData;
      name = img.name || `Image ${idx + 1}`;
      description = img.description || '';
    } else if (typeof img === 'string') {
      // Legacy format - just base64 string
      imageUrl = img;
      name = `Image ${idx + 1}`;
    }
    
    // Detect if this is a video (by mediaType field, file extension, or URL pattern)
    const isVideo = img?.mediaType === 'video' || 
      /\.(mp4|webm|mov)(\?|$)/i.test(imageUrl || '') ||
      imageUrl?.startsWith('data:video/');
    
    if (!imageUrl) {
      return `
        <div class="image-pool-item missing" data-index="${idx}" title="Media missing">
          <div class="image-missing">❌ Missing</div>
          <div class="image-pool-item-overlay">
            <span class="image-pool-item-name">${escapeHtml(img?.name || 'Missing')}</span>
          </div>
          <button class="remove-btn" data-index="${idx}" title="Remove">✕</button>
        </div>
      `;
    }
    
    const mediaEl = isVideo
      ? `<video src="${imageUrl}" muted preload="metadata" style="width:100%;height:100%;object-fit:cover;"></video>
         <div class="video-play-icon" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:24px;opacity:0.8;">▶</div>`
      : `<img src="${imageUrl}" alt="${escapeHtml(name)}" loading="lazy">`;
    
    return `
      <div class="image-pool-item${isVideo ? ' video-item' : ''}" data-index="${idx}" title="${escapeHtml(description || name)}">
        ${mediaEl}
        <div class="image-pool-item-overlay">
          <span class="image-pool-item-name">${isVideo ? '🎬 ' : ''}${escapeHtml(name)}</span>
        </div>
        <button class="remove-btn" data-index="${idx}" title="Remove">✕</button>
      </div>
    `;
  });
  
  grid.innerHTML = imageElements.join('');
  
  // Add remove button listeners
  grid.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      removeImageFromPool(idx);
    });
  });
  
  // Add click-to-edit listeners
  grid.querySelectorAll('.image-pool-item').forEach(item => {
    item.addEventListener('click', (e) => {
      // Don't trigger if clicking remove button
      if (e.target.closest('.remove-btn')) return;
      
      const idx = parseInt(item.dataset.index);
      const img = editingScript.imagePool[idx];
      if (img) {
        openScriptImageEditModal(img, idx);
      }
    });
  });
  
  // Load randomize setting
  if (randomizeCheckbox && editingScript.imagePoolRandomize !== undefined) {
    randomizeCheckbox.checked = editingScript.imagePoolRandomize;
  }
  
  console.log(`[ImagePool] 📊 Rendered ${images.length} images from Firebase Storage`);
};

// Open edit modal for script image
const openScriptImageEditModal = (img, index) => {
  let modal = $('scriptImageEditModal');
  
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'scriptImageEditModal';
    modal.className = 'modal hidden';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>✏️ Edit Image</h3>
          <button id="closeScriptImageEditModalBtn" class="icon-btn">✕</button>
        </div>
        <div class="modal-body">
          <div class="script-image-preview">
            <img id="scriptImageEditPreview" src="" alt="Preview">
          </div>
          <div class="form-group">
            <label>Name:</label>
            <input type="text" id="scriptImageEditName" placeholder="e.g., Beach Selfie">
          </div>
          <div class="form-group">
            <label>Description (helps AI select this image):</label>
            <textarea id="scriptImageEditDescription" placeholder="Describe what's in the image...&#10;e.g., Selfie at beach, smiling, wearing bikini, sunny day"></textarea>
          </div>
          <div class="form-group">
            <label>Category:</label>
            <select id="scriptImageEditCategory">
              <option value="selfie">📸 Selfie</option>
              <option value="full_body">🧍 Full Body</option>
              <option value="activity">🎯 Activity</option>
              <option value="location">📍 Location</option>
              <option value="outfit">👗 Outfit</option>
              <option value="mood">😊 Mood</option>
              <option value="other">📁 Other</option>
            </select>
          </div>
          <div class="form-group">
            <label>Tags (comma separated):</label>
            <input type="text" id="scriptImageEditTags" placeholder="e.g., beach, happy, sunny, bikini">
          </div>
        </div>
        <div class="modal-footer">
          <button id="saveScriptImageEditBtn" class="btn btn-primary">💾 Save Changes</button>
          <button id="cancelScriptImageEditBtn" class="btn btn-secondary">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    
    // Setup close listeners
    $('closeScriptImageEditModalBtn')?.addEventListener('click', closeScriptImageEditModal);
    $('cancelScriptImageEditBtn')?.addEventListener('click', closeScriptImageEditModal);
  }
  
  // Populate form with image data
  const preview = $('scriptImageEditPreview');
  const nameInput = $('scriptImageEditName');
  const descInput = $('scriptImageEditDescription');
  const categorySelect = $('scriptImageEditCategory');
  const tagsInput = $('scriptImageEditTags');
  
  const imageUrl = img.downloadURL || img.imageData || '';
  const isVideo = img.mediaType === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(imageUrl);
  if (preview) {
    if (isVideo && preview.tagName === 'IMG') {
      // Replace img with video element for video previews
      const video = document.createElement('video');
      video.id = preview.id;
      video.className = preview.className;
      video.src = imageUrl;
      video.muted = true;
      video.preload = 'metadata';
      preview.parentNode.replaceChild(video, preview);
    } else {
      preview.src = imageUrl;
    }
  }
  if (nameInput) nameInput.value = img.name || '';
  if (descInput) descInput.value = img.description || '';
  if (categorySelect) categorySelect.value = img.category || 'other';
  if (tagsInput) tagsInput.value = (img.tags || []).join(', ');
  
  // Setup save handler (remove old, add new)
  const saveBtn = $('saveScriptImageEditBtn');
  const newSaveBtn = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
  newSaveBtn.addEventListener('click', () => saveScriptImageEdit(index));
  
  modal.classList.remove('hidden');
};

// Close edit modal
const closeScriptImageEditModal = () => {
  const modal = $('scriptImageEditModal');
  if (modal) modal.classList.add('hidden');
};

// Save image edits
const saveScriptImageEdit = (index) => {
  if (!editingScript?.imagePool?.[index]) return;
  
  const img = editingScript.imagePool[index];
  
  const nameInput = $('scriptImageEditName');
  const descInput = $('scriptImageEditDescription');
  const categorySelect = $('scriptImageEditCategory');
  const tagsInput = $('scriptImageEditTags');
  
  img.name = nameInput?.value?.trim() || img.name;
  img.description = descInput?.value?.trim() || '';
  img.category = categorySelect?.value || 'other';
  
  const tagsStr = tagsInput?.value?.trim() || '';
  img.tags = tagsStr ? tagsStr.split(',').map(t => t.trim().toLowerCase()).filter(t => t) : [];
  
  closeScriptImageEditModal();
  renderImagePool();
  triggerAutoSave();
  showNotification('Image updated!');
  
  console.log('[ImagePool] ✏️ Updated image:', img.name);
};

// Handle media upload (image or video) - show form first
const handleImageUpload = async (files) => {
  if (!editingScript || !files.length) return;
  
  const file = files[0]; // Handle one at a time
  
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  
  if (!isImage && !isVideo) {
    showNotification('Please select an image or video file');
    return;
  }
  
  // Check file size: 5MB for images, 50MB for videos
  const maxSize = isVideo ? 50 * 1024 * 1024 : 5 * 1024 * 1024;
  if (file.size > maxSize) {
    showNotification(`${isVideo ? 'Video' : 'Image'} ${file.name} is too large (max ${isVideo ? '50' : '5'}MB)`);
    return;
  }
  
  try {
    let base64;
    if (isVideo) {
      // Videos: read raw base64, no compression
      base64 = await fileToBase64Raw(file);
    } else {
      // Images: compress via canvas
      base64 = await fileToBase64(file);
    }
    
    pendingImageFile = file;
    pendingImageBase64 = base64;
    
    // Show modal with form
    showImageAddModal(base64, file.name, isVideo ? 'video' : 'image');
  } catch (error) {
    console.error('Failed to convert file:', error);
    showNotification('Failed to process file');
  }
};

// Read file as base64 without compression (for videos)
const fileToBase64Raw = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
};

// Track pending media type for the add modal
let pendingMediaType = 'image';

// Show media add modal (image or video)
const showImageAddModal = (mediaData, fileName, mediaType = 'image') => {
  pendingMediaType = mediaType;
  
  // Create modal if it doesn't exist
  let modal = $('scriptImageAddModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'scriptImageAddModal';
    modal.className = 'modal hidden';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3 id="scriptMediaAddTitle">📸 Add Image to Pool</h3>
          <button id="closeScriptImageModalBtn" class="icon-btn">✕</button>
        </div>
        <div class="modal-body">
          <div class="script-image-preview">
            <img id="scriptImagePreview" src="" alt="Preview">
            <video id="scriptVideoPreview" controls muted style="display:none; max-width:100%; max-height:200px; border-radius:8px;"></video>
          </div>
          <div class="form-group">
            <label>Name:</label>
            <input type="text" id="scriptImageName" placeholder="e.g., Beach Selfie">
          </div>
          <div class="form-group">
            <label>Description (for AI matching):</label>
            <textarea id="scriptImageDescription" placeholder="Describe what's in the image so AI knows when to use it...&#10;e.g., Selfie at beach, smiling, wearing bikini, sunny day"></textarea>
          </div>
          <div class="form-group">
            <label>Category:</label>
            <select id="scriptImageCategory">
              <option value="selfie">📸 Selfie</option>
              <option value="full_body">🧍 Full Body</option>
              <option value="activity">🎯 Activity</option>
              <option value="location">📍 Location</option>
              <option value="outfit">👗 Outfit</option>
              <option value="mood">😊 Mood</option>
              <option value="other">📁 Other</option>
            </select>
          </div>
          <div class="form-group">
            <label>Tags (comma separated):</label>
            <input type="text" id="scriptImageTags" placeholder="e.g., beach, happy, sunny, bikini">
          </div>
        </div>
        <div class="modal-footer">
          <button id="saveScriptImageBtn" class="btn btn-primary">➕ Add to Pool</button>
          <button id="cancelScriptImageBtn" class="btn btn-secondary">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    
    // Setup listeners
    $('closeScriptImageModalBtn')?.addEventListener('click', closeImageAddModal);
    $('cancelScriptImageBtn')?.addEventListener('click', closeImageAddModal);
    $('saveScriptImageBtn')?.addEventListener('click', saveImageToPool);
  }
  
  // Update title based on media type
  const titleEl = $('scriptMediaAddTitle');
  if (titleEl) titleEl.textContent = mediaType === 'video' ? '🎬 Add Video to Pool' : '📸 Add Image to Pool';
  
  // Toggle image/video preview
  const imgPreview = $('scriptImagePreview');
  const vidPreview = $('scriptVideoPreview');
  
  if (mediaType === 'video') {
    if (imgPreview) imgPreview.style.display = 'none';
    if (vidPreview) { vidPreview.src = mediaData; vidPreview.style.display = 'block'; }
  } else {
    if (imgPreview) { imgPreview.src = mediaData; imgPreview.style.display = 'block'; }
    if (vidPreview) { vidPreview.src = ''; vidPreview.style.display = 'none'; }
  }
  
  // Populate form
  const nameInput = $('scriptImageName');
  const descInput = $('scriptImageDescription');
  const tagsInput = $('scriptImageTags');
  
  if (nameInput) nameInput.value = fileName.replace(/\.[^/.]+$/, ''); // Remove extension
  if (descInput) descInput.value = '';
  if (tagsInput) tagsInput.value = '';
  
  modal.classList.remove('hidden');
};

// Close image add modal
const closeImageAddModal = () => {
  const modal = $('scriptImageAddModal');
  if (modal) modal.classList.add('hidden');
  pendingImageFile = null;
  pendingImageBase64 = null;
};

// Save image with metadata to pool - uploads to Firebase Storage
const saveImageToPool = async () => {
  if (!editingScript || !pendingImageBase64) return;
  
  const nameInput = $('scriptImageName');
  const descInput = $('scriptImageDescription');
  const categorySelect = $('scriptImageCategory');
  const tagsInput = $('scriptImageTags');
  
  const name = nameInput?.value?.trim() || 'Untitled';
  const description = descInput?.value?.trim() || '';
  const category = categorySelect?.value || 'other';
  const tagsStr = tagsInput?.value?.trim() || '';
  const tags = tagsStr ? tagsStr.split(',').map(t => t.trim().toLowerCase()).filter(t => t) : [];
  
  if (!editingScript.imagePool) {
    editingScript.imagePool = [];
  }
  
  // Show loading state
  const saveBtn = $('saveScriptImageBtn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = '⏳ Uploading...';
  }
  
  try {
    // Upload media to Firebase Storage
    const result = await storeImage(pendingImageBase64, {
      name,
      description,
      category,
      tags,
      scriptId: editingScript.id,
      mediaType: pendingMediaType // 'image' or 'video'
    });
    
    const label = pendingMediaType === 'video' ? 'Video' : 'Image';
    console.log(`[ImagePool] ✅ ${label} uploaded to Firebase Storage`);
    console.log(`[ImagePool] 📥 Download URL: ${result.downloadURL.substring(0, 60)}...`);
    
    // Add metadata + download URL to the script
    // Only stores URL reference, not the actual media data
    editingScript.imagePool.push({
      id: result.id,
      downloadURL: result.downloadURL, // Firebase Storage URL
      storagePath: result.storagePath, // For deletion later
      name,
      description,
      category,
      tags,
      mediaType: pendingMediaType, // 'image' or 'video'
      createdAt: Date.now()
    });
    
    closeImageAddModal();
    renderImagePool();
    triggerAutoSave();
    showNotification(`${label} uploaded to cloud!`);
    
  } catch (error) {
    console.error('[ImagePool] Failed to upload image:', error);
    showNotification('Failed to upload image: ' + error.message);
  } finally {
    // Reset button state
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = '➕ Add to Pool';
    }
  }
};

// Convert file to base64 with compression
const fileToBase64 = (file, maxWidth = 1200, quality = 0.8) => {
  return new Promise((resolve, reject) => {
    // First, read as data URL to get original
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const originalDataUrl = reader.result;
      
      // Create image to get dimensions
      const img = new Image();
      img.onerror = () => reject(new Error('Failed to load image'));
      img.onload = () => {
        // Calculate new dimensions (maintain aspect ratio)
        let width = img.width;
        let height = img.height;
        
        if (width > maxWidth) {
          height = (height * maxWidth) / width;
          width = maxWidth;
        }
        
        // Create canvas for compression
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        
        // Convert to compressed JPEG (or PNG if transparent)
        const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
        
        // Log compression stats
        const originalSize = originalDataUrl.length;
        const compressedSize = compressedDataUrl.length;
        const savings = ((1 - compressedSize / originalSize) * 100).toFixed(1);
        console.log(`[ImagePool] 🗜️ Compressed: ${(originalSize/1024).toFixed(0)}KB → ${(compressedSize/1024).toFixed(0)}KB (${savings}% smaller)`);
        
        resolve(compressedDataUrl);
      };
      img.src = originalDataUrl;
    };
    reader.readAsDataURL(file);
  });
};

// Remove image from pool (also deletes from Firebase Storage)
const removeImageFromPool = async (index) => {
  if (!editingScript?.imagePool) return;
  
  const img = editingScript.imagePool[index];
  
  // Delete from Firebase Storage if it has a storagePath
  if (img?.storagePath) {
    try {
      await deleteImage(img.storagePath);
      console.log(`[ImagePool] 🗑️ Deleted from Firebase Storage: ${img.storagePath}`);
    } catch (error) {
      console.error('[ImagePool] Failed to delete from Firebase Storage:', error);
      // Continue anyway - remove from pool even if storage delete fails
    }
  }
  
  editingScript.imagePool.splice(index, 1);
  renderImagePool();
  triggerAutoSave();
  showNotification('Image removed from pool');
};

// Clear all images from pool
const clearImagePool = () => {
  if (!editingScript?.imagePool?.length) return;
  if (!confirm('Remove all images from this script\'s pool?')) return;
  
  editingScript.imagePool = [];
  renderImagePool();
  triggerAutoSave();
  showNotification('Image pool cleared');
};

// Setup image pool listeners
const setupImagePoolListeners = () => {
  // Image upload
  $('imagePoolUpload')?.addEventListener('change', (e) => {
    if (e.target.files?.length) {
      handleImageUpload(Array.from(e.target.files));
      e.target.value = ''; // Reset input
    }
  });
  
  // Clear all
  $('clearImagePoolBtn')?.addEventListener('click', clearImagePool);
  
  // Randomize toggle
  $('imagePoolRandomize')?.addEventListener('change', (e) => {
    if (editingScript) {
      editingScript.imagePoolRandomize = e.target.checked;
      triggerAutoSave();
    }
  });
};

// Setup editor listeners
export const setupEditorListeners = () => {
  // Initialize callbacks
  initEditorCallbacks();
  
  // Create script (inline form)
  $('createScriptBtn')?.addEventListener('click', handleCreateNewScript);
  $('newScriptNameInput')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleCreateNewScript();
  });
  
  // Section buttons
  $('addSectionBtn')?.addEventListener('click', addNewSection);
  $('newSectionNameInput')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addNewSection();
  });
  
  // Save/delete/share script
  $('saveScriptBtn')?.addEventListener('click', saveEditingScript);
  $('deleteScriptBtn')?.addEventListener('click', deleteEditingScript);
  $('shareScriptBtn')?.addEventListener('click', openShareScriptModal);
  
  // Image pool listeners
  setupImagePoolListeners();
  
  // ============================================================
  // AUTO-SAVE TRIGGERS
  // ============================================================
  
  // Script name change
  $('editScriptName')?.addEventListener('input', triggerAutoSave);
  
  // Timing settings changes
  const timingInputs = [
    'scriptOrder', 'scriptSubscriberDay', 'scriptScheduleType',
    'scriptScheduledDay', 'scriptScheduleStartDay', 'scriptScheduleEndDay',
    'scriptMinMinutes', 'scriptNotBeforeTime', 'scriptNotAfterTime', 'scriptAutoSwitch'
  ];
  
  timingInputs.forEach(id => {
    const el = $(id);
    if (el) {
      el.addEventListener('change', triggerAutoSave);
      if (el.tagName === 'INPUT' && el.type !== 'checkbox') {
        el.addEventListener('input', triggerAutoSave);
      }
    }
  });
  
  // Back button
  $('backToListBtn')?.addEventListener('click', () => {
    showScriptListView();
    renderScriptList();
  });
  
  // Import templates button
  $('importTemplatesBtn')?.addEventListener('click', openTemplatesModal);
  
  // Templates modal listeners
  $('closeTemplatesModalBtn')?.addEventListener('click', closeTemplatesModal);
  $('cancelTemplatesBtn')?.addEventListener('click', closeTemplatesModal);
  $('importSelectedBtn')?.addEventListener('click', importSelectedTemplates);
  $('importAllBtn')?.addEventListener('click', importAllTemplates);
  
  // Setup action modal listeners
  setupActionModalListeners();
};
