// ============================================================
// SCRIPTS MODULE - SECTIONS EDITOR
// ============================================================

import { $, escapeHtml } from '../../utils/dom.js';
import { showNotification } from '../../utils/notify.js';
import { ACTION_ICONS, TONE_ICONS } from './constants.js';
import { openActionModal, openEditActionModal, deleteActionFromSection } from './actionModal.js';

// Callback for getting editing script (set from editor.js)
let _getEditingScript = null;
let _triggerAutoSave = null;

export const setSectionsCallbacks = (getScript, autoSave) => {
  _getEditingScript = getScript;
  _triggerAutoSave = autoSave;
};

// Render sections in editor
export const renderEditorSections = () => {
  const container = $('editorSections');
  const editingScript = _getEditingScript ? _getEditingScript() : null;
  
  console.log('🔧 renderEditorSections called');
  console.log('🔧 Container found:', !!container);
  console.log('🔧 editingScript:', !!editingScript);
  
  if (!container || !editingScript) {
    console.log('🔧 Aborting: container or editingScript missing');
    return;
  }
  
  if (!editingScript.stages?.length) {
    console.log('🔧 No stages - showing empty message');
    container.innerHTML = '<p style="color: var(--text-secondary); padding: 20px; text-align: center;">No sections yet. Click "+ Add" to create one.</p>';
    return;
  }
  
  console.log('🔧 Rendering', editingScript.stages.length, 'sections');
  
  container.innerHTML = editingScript.stages.map((stage, stageIdx) => {
    const actions = stage.actions || stage.messages || [];
    const actionCount = actions.length;
    
    return `
      <div class="editor-section" data-stage-idx="${stageIdx}">
        <div class="section-header">
          <div class="section-title">
            <span class="section-number">Section ${stageIdx + 1}/${editingScript.stages.length}</span>
            <input type="text" class="section-name-input" value="${escapeHtml(stage.name || `Section ${stageIdx + 1}`)}" data-stage-idx="${stageIdx}">
          </div>
          <div class="section-actions">
            <span class="section-count">${actionCount} action${actionCount !== 1 ? 's' : ''}</span>
            <button class="btn-icon delete-section-btn" data-stage-idx="${stageIdx}" title="Delete section">🗑️</button>
          </div>
        </div>
        <div class="section-actions-list">
          ${renderSectionActions(stage, stageIdx)}
        </div>
        <button class="add-action-btn" data-stage-idx="${stageIdx}">➕ Add Action</button>
      </div>
    `;
  }).join('');
  
  setupSectionEventListeners();
};

// Render actions in a section
const renderSectionActions = (stage, stageIdx) => {
  const actions = stage.actions || stage.messages || [];
  
  if (!actions.length) {
    return '<p class="no-actions">No actions yet. Click "Add Action" to create checkpoints.</p>';
  }
  
  return actions.map((action, actionIdx) => {
    const type = action.type || 'text';
    const goal = action.goal || action.text || '';
    const price = action.price || 0;
    const tone = action.tone || '';
    const icon = ACTION_ICONS[type] || '💬';
    const toneIcon = tone ? TONE_ICONS[tone] : '';
    
    // Price badge (for any media action with a price)
    let priceBadge = '';
    if (type === 'media') {
      priceBadge = price > 0 
        ? `<span class="action-price-badge paid">$${price}</span>`
        : `<span class="action-price-badge free">FREE</span>`;
    }
    
    // Pool Image badge (media with image from pool)
    let poolImageBadge = '';
    if (type === 'media' && action.poolImage) {
      const mediaIcon = action.poolImage.mediaType === 'video' ? '🎬' : '🖼️';
      poolImageBadge = `<span class="action-pool-image-badge">${mediaIcon} ${action.poolImage.name || 'Image'}</span>`;
    }
    
    // Tone badge
    let toneBadge = '';
    if (tone && toneIcon) {
      toneBadge = `<span class="action-tone-badge">${toneIcon} ${tone}</span>`;
    }
    
    return `
      <div class="editor-action" data-stage-idx="${stageIdx}" data-action-idx="${actionIdx}" draggable="true">
        <div class="action-drag-handle">⋮⋮</div>
        <div class="action-type-badge">${icon}</div>
        <div class="action-content">
          <div class="action-goal">${escapeHtml(goal)}</div>
          <div class="action-meta">
            ${toneBadge}
            ${priceBadge}
            ${poolImageBadge}
          </div>
        </div>
        <div class="action-buttons">
          <button class="action-edit-btn" data-stage-idx="${stageIdx}" data-action-idx="${actionIdx}" title="Edit">✏️</button>
          <button class="action-delete-btn" data-stage-idx="${stageIdx}" data-action-idx="${actionIdx}" title="Delete">✕</button>
        </div>
      </div>
    `;
  }).join('');
};

// Section event listeners
const setupSectionEventListeners = () => {
  const editingScript = _getEditingScript ? _getEditingScript() : null;
  
  // Section name input (with auto-save)
  document.querySelectorAll('.section-name-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const stageIdx = parseInt(e.target.dataset.stageIdx);
      if (editingScript?.stages[stageIdx]) {
        editingScript.stages[stageIdx].name = e.target.value;
        if (_triggerAutoSave) _triggerAutoSave();
      }
    });
  });
  
  // Add action button - opens modal
  document.querySelectorAll('.add-action-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const stageIdx = parseInt(e.target.dataset.stageIdx);
      openActionModal(stageIdx);
    });
  });
  
  // Edit action button
  document.querySelectorAll('.action-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const stageIdx = parseInt(e.target.dataset.stageIdx);
      const actionIdx = parseInt(e.target.dataset.actionIdx);
      openEditActionModal(stageIdx, actionIdx);
    });
  });
  
  // Delete action button
  document.querySelectorAll('.action-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const stageIdx = parseInt(e.target.dataset.stageIdx);
      const actionIdx = parseInt(e.target.dataset.actionIdx);
      deleteActionFromSection(stageIdx, actionIdx);
    });
  });
  
  // Delete section button
  document.querySelectorAll('.delete-section-btn').forEach(btn => {
    btn.addEventListener('click', (e) => deleteSection(parseInt(e.target.dataset.stageIdx)));
  });
  
  // Setup drag and drop
  setupDragAndDrop();
};

// Drag and drop functionality
const setupDragAndDrop = () => {
  const editingScript = _getEditingScript ? _getEditingScript() : null;
  
  let draggedElement = null;
  let draggedStageIdx = null;
  let draggedActionIdx = null;
  
  document.querySelectorAll('.editor-action').forEach(actionEl => {
    actionEl.addEventListener('dragstart', (e) => {
      draggedElement = actionEl;
      draggedStageIdx = parseInt(actionEl.dataset.stageIdx);
      draggedActionIdx = parseInt(actionEl.dataset.actionIdx);
      actionEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    
    actionEl.addEventListener('dragend', () => {
      actionEl.classList.remove('dragging');
      document.querySelectorAll('.editor-action').forEach(el => {
        el.classList.remove('drag-over');
      });
      draggedElement = null;
      draggedStageIdx = null;
      draggedActionIdx = null;
    });
    
    actionEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      
      if (draggedElement && actionEl !== draggedElement) {
        const targetStageIdx = parseInt(actionEl.dataset.stageIdx);
        
        // Only allow reordering within same section
        if (targetStageIdx === draggedStageIdx) {
          actionEl.classList.add('drag-over');
        }
      }
    });
    
    actionEl.addEventListener('dragleave', () => {
      actionEl.classList.remove('drag-over');
    });
    
    actionEl.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      const targetStageIdx = parseInt(actionEl.dataset.stageIdx);
      const targetActionIdx = parseInt(actionEl.dataset.actionIdx);
      
      // Only allow reordering within same section
      if (draggedElement && targetStageIdx === draggedStageIdx && targetActionIdx !== draggedActionIdx && editingScript) {
        const stage = editingScript.stages[draggedStageIdx];
        const actions = stage.actions || stage.messages || [];
        
        // Remove from old position
        const [movedAction] = actions.splice(draggedActionIdx, 1);
        
        // Insert at new position
        const newIdx = draggedActionIdx < targetActionIdx 
          ? targetActionIdx - 1 
          : targetActionIdx;
        actions.splice(newIdx, 0, movedAction);
        
        // Update the correct array
        if (stage.actions) {
          stage.actions = actions;
        } else {
          stage.messages = actions;
        }
        
        renderEditorSections();
        showNotification('Action reordered');
        
        // Auto-save after drag-drop
        if (_triggerAutoSave) _triggerAutoSave();
      }
      
      actionEl.classList.remove('drag-over');
    });
  });
};

// Add new section
export const addNewSection = () => {
  const editingScript = _getEditingScript ? _getEditingScript() : null;
  
  if (!editingScript) {
    console.log('❌ addNewSection: No editingScript');
    return;
  }
  
  if (!editingScript.stages) {
    editingScript.stages = [];
  }
  
  const input = $('newSectionNameInput');
  const name = input?.value?.trim() || `Section ${editingScript.stages.length + 1}`;
  
  console.log('➕ Adding new section:', name);
  
  editingScript.stages.push({
    id: editingScript.stages.length + 1,
    name: name,
    actions: []
  });
  
  if (input) input.value = '';
  
  renderEditorSections();
  showNotification('Section added!');
  
  // Auto-save after adding section
  if (_triggerAutoSave) _triggerAutoSave();
};

// Delete section
const deleteSection = (stageIdx) => {
  const editingScript = _getEditingScript ? _getEditingScript() : null;
  if (!editingScript || !confirm('Delete this section?')) return;
  
  editingScript.stages.splice(stageIdx, 1);
  renderEditorSections();
  showNotification('Section deleted');
  
  // Auto-save after deleting section
  if (_triggerAutoSave) _triggerAutoSave();
};
