// ============================================================
// SCRIPTS MODULE - RENDERER (Chat Tab View)
// Single-section display with navigation
// Uses ProgressManager for reliable progress tracking
// ============================================================

import Store from '../../state/store.js';
import { $, escapeHtml } from '../../utils/dom.js';
import { ACTION_ICONS } from './constants.js';
import Progress from './progressManager.js';

// Track current displayed section index
let displayedSectionIndex = 0;
// Track if section actions are expanded
let sectionExpanded = false;

// Get actions for a stage (support both formats)
const getStageActions = (stage) => stage.actions || stage.messages || [];

// Navigate to previous section
export const prevSection = () => {
  const currentScript = Store.get('currentScript');
  if (!currentScript?.stages?.length) return;
  
  if (displayedSectionIndex > 0) {
    displayedSectionIndex--;
    renderScriptStages();
  }
};

// Navigate to next section
export const nextSection = () => {
  const currentScript = Store.get('currentScript');
  if (!currentScript?.stages?.length) return;
  
  if (displayedSectionIndex < currentScript.stages.length - 1) {
    displayedSectionIndex++;
    renderScriptStages();
  }
};

// Jump to specific section
export const goToSection = (index) => {
  const currentScript = Store.get('currentScript');
  if (!currentScript?.stages?.length) return;
  
  if (index >= 0 && index < currentScript.stages.length) {
    displayedSectionIndex = index;
    renderScriptStages();
  }
};

// Render script stages - SINGLE SECTION VIEW with navigation
export const renderScriptStages = async () => {
  const currentScript = Store.get('currentScript');
  const scriptStages = $('scriptStages');
  const progressBar = $('progressBar');
  const progressCounter = $('progressCounter');
  
  if (!scriptStages) return;
  
  if (!currentScript || !currentScript.stages?.length) {
    scriptStages.innerHTML = '<p class="no-script-msg">No script loaded</p>';
    if (progressCounter) progressCounter.textContent = '0/0';
    if (progressBar) progressBar.style.width = '0%';
    return;
  }
  
  const stages = currentScript.stages;
  
  // Initialize progress if needed (ensures we have valid data)
  await Progress.init();
  
  // Get current section from ProgressManager
  const activeSection = Progress.getCurrentSectionIndex();
  
  // Check if displayed section is all complete - auto-advance
  const displayedStage = stages[displayedSectionIndex];
  if (displayedStage) {
    const displayedActions = getStageActions(displayedStage);
    const displayedAllComplete = displayedActions.every((_, actionIdx) => 
      Progress.isComplete(displayedSectionIndex, actionIdx)
    );
    
    // If current section is complete and there's a next section, auto-advance
    if (displayedAllComplete && displayedSectionIndex < stages.length - 1) {
      displayedSectionIndex = activeSection;
    }
  }
  
  // Ensure index is within bounds
  if (displayedSectionIndex >= stages.length) displayedSectionIndex = stages.length - 1;
  if (displayedSectionIndex < 0) displayedSectionIndex = 0;
  
  // Get overall progress stats from ProgressManager
  const stats = Progress.getStats();
  const progressPercent = stats.total > 0 ? (stats.completed / stats.total) * 100 : 0;
  const scriptComplete = Progress.isScriptComplete();
  
  if (progressBar) {
    progressBar.style.width = `${progressPercent}%`;
    if (scriptComplete) {
      progressBar.classList.add('complete');
    } else {
      progressBar.classList.remove('complete');
    }
  }
  if (progressCounter) {
    progressCounter.textContent = scriptComplete ? '✅ COMPLETE' : `${stats.completed}/${stats.total}`;
  }
  
  // Update script selection panel info
  const scriptProgressPercent = $('scriptProgressPercent');
  const scriptActionsCount = $('scriptActionsCount');
  if (scriptProgressPercent) {
    scriptProgressPercent.textContent = `${Math.round(progressPercent)}%`;
  }
  if (scriptActionsCount) {
    scriptActionsCount.textContent = `${stats.completed}/${stats.total}`;
  }
  
  // Current section data
  const stage = stages[displayedSectionIndex];
  const actions = getStageActions(stage);
  const completedCount = actions.filter((_, actionIdx) => 
    Progress.isComplete(displayedSectionIndex, actionIdx)
  ).length;
  const sectionComplete = completedCount === actions.length;
  
  // Section progress percentage
  const sectionProgress = actions.length > 0 ? (completedCount / actions.length) * 100 : 0;
  
  // Build navigation HTML
  const canGoPrev = displayedSectionIndex > 0;
  const canGoNext = displayedSectionIndex < stages.length - 1;
  
  const navigationHtml = `
    <div class="section-nav" id="sectionNavHeader">
      <button class="section-nav-btn ${canGoPrev ? '' : 'disabled'}" id="prevSectionBtn" ${canGoPrev ? '' : 'disabled'}>◀</button>
      <div class="section-nav-info clickable" id="sectionToggle">
        <span class="section-nav-label">Stage ${displayedSectionIndex + 1}/${stages.length}</span>
        <span class="section-nav-name">${escapeHtml(stage.name)}</span>
        <span class="section-expand-hint">${sectionExpanded ? '▲' : '▼'}</span>
      </div>
      <button class="section-nav-btn ${canGoNext ? '' : 'disabled'}" id="nextSectionBtn" ${canGoNext ? '' : 'disabled'}>▶</button>
    </div>
    <div class="section-progress-bar">
      <div class="section-progress-fill ${sectionComplete ? 'complete' : ''}" style="width: ${sectionProgress}%"></div>
    </div>
  `;
  
  // Build actions HTML
  const actionsHtml = actions.map((action, actionIdx) => {
    const isCompleted = Progress.isComplete(displayedSectionIndex, actionIdx);
    const isCurrent = !isCompleted && actions.slice(0, actionIdx).every((_, i) => 
      Progress.isComplete(displayedSectionIndex, i)
    );
    
    const actionClass = isCompleted ? 'completed' : (isCurrent ? 'current' : '');
    const type = action.type || 'text';
    const icon = ACTION_ICONS[type] || '💬';
    const goal = action.goal || action.text || '';
    
    return `
      <div class="stage-message ${actionClass}" data-stage="${displayedSectionIndex}" data-msg="${actionIdx}">
        <div class="msg-checkbox"></div>
        <span class="action-icon">${icon}</span>
        <span class="action-text">${escapeHtml(goal)}</span>
      </div>`;
  }).join('');
  
  // Completion banner if script is 100% done
  const completionBannerHtml = scriptComplete ? `
    <div class="script-complete-banner">
      <span class="complete-icon">🎉</span>
      <span class="complete-text">Script Complete!</span>
      <span class="complete-subtext">User added to block list</span>
    </div>
  ` : '';

  scriptStages.innerHTML = `
    ${completionBannerHtml}
    ${navigationHtml}
    <div class="section-actions ${sectionExpanded ? 'expanded' : 'collapsed'}" id="sectionActionsContainer">${actionsHtml}</div>
  `;
  
  // Event listeners for navigation
  $('prevSectionBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    prevSection();
  });
  $('nextSectionBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    nextSection();
  });
  
  // Toggle section expand/collapse
  $('sectionToggle')?.addEventListener('click', () => {
    sectionExpanded = !sectionExpanded;
    const container = $('sectionActionsContainer');
    const hint = document.querySelector('.section-expand-hint');
    if (container) {
      container.classList.toggle('expanded', sectionExpanded);
      container.classList.toggle('collapsed', !sectionExpanded);
    }
    if (hint) {
      hint.textContent = sectionExpanded ? '▲' : '▼';
    }
  });
  
  // Event listeners for action items (click to toggle)
  scriptStages.querySelectorAll('.stage-message').forEach(msgEl => {
    msgEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      const stageIdx = +msgEl.dataset.stage;
      const actionIdx = +msgEl.dataset.msg;
      
      await Progress.toggle(stageIdx, actionIdx);
      renderScriptStages();
    });
  });
  
  // Store current stage for other modules
  Store.set('currentStage', displayedSectionIndex + 1);
};

// Reset displayed section (call when loading new script)
export const resetDisplayedSection = () => {
  displayedSectionIndex = 0;
  sectionExpanded = false;
};

// Initialize progress and render (call after script loads)
export const initAndRender = async () => {
  await Progress.init();
  displayedSectionIndex = Progress.getCurrentSectionIndex();
  
  // Register remote sync callback — when another user makes progress,
  // re-render the UI automatically so both users see the same state
  Progress.setOnRemoteUpdate(() => {
    console.log('[Renderer] 🔄 Remote progress update — re-rendering');
    renderScriptStages();
  });
  
  renderScriptStages();
};
