// ============================================================
// SCRIPTS MODULE - MAIN INDEX
// Clean modular architecture
// Profile-specific scripts support
// ============================================================

import Store from '../../state/store.js';
import { $ } from '../../utils/dom.js';
import { showNotification } from '../../utils/notify.js';

// Import sub-modules
import { 
  loadScripts, 
  populateScriptDropdown, 
  populateChatScriptDropdown,
  autoSelectScript, 
  setRenderCallbacks, 
  loadGlobalTemplates, 
  copyTemplateToProfile, 
  copyAllTemplatesToProfile, 
  saveScriptAsTemplate,
  isManualModeActive,
  getManualScriptId,
  setManualScript,
  clearManualScript,
  getScriptProgress,
  isScriptComplete
} from './core.js';
import { renderScriptStages, initAndRender, resetDisplayedSection } from './renderer.js';
import { renderScriptList, setupEditorListeners, showScriptListView } from './editor.js';
import { checkGoalCompletion, isActionCompleted, getCurrentIncompleteAction, getSubscriberScriptStats, loadSubscriberProgress, autoSkipSatisfiedGoals, updateToneForCurrentAction, getActionForGeneration, checkCurrentActionSatisfied } from './goalDetection.js';
import Progress from './progressManager.js';
import { updateScheduleTypeVisibility, updateTimingModeVisibility } from './timing.js';
import { setupCalendarListeners, openCalendarModal, closeCalendarModal } from './calendar.js';
import { setupScriptBuilderListeners } from './scriptBuilder.js';
import { setScriptsLoadCallback } from '../profiles.js';

// Initialize render callbacks to avoid circular dependencies
setRenderCallbacks(renderScriptStages, renderScriptList, populateScriptDropdown);

// Set up callback for profiles module to reload scripts when profile changes
setScriptsLoadCallback(() => {
  console.log('🔄 Reloading scripts for new profile...');
  showScriptListView(); // Reset to list view when profile changes
  loadScripts();
});

// Setup all scripts-related event listeners
export const setupScriptsListeners = () => {
  // Script selection dropdown (in chat tab - hidden)
  $('scriptSelect')?.addEventListener('change', (e) => {
    const scripts = Store.get('scripts');
    const script = scripts.find(s => s.id === e.target.value);
    if (script) {
      Store.set('currentScript', script);
      chrome.storage.local.set({ currentScriptId: script.id });
      renderScriptStages();
    }
  });
  
  // Chat script selector (visible dropdown)
  $('scriptSelectChat')?.addEventListener('change', async (e) => {
    const scripts = Store.get('scripts');
    const script = scripts.find(s => s.id === e.target.value);
    if (script) {
      Store.set('currentScript', script);
      chrome.storage.local.set({ currentScriptId: script.id });
      
      // Check if manual mode is active from the button state
      const isManualMode = !$('scriptManualModeBtn')?.classList.contains('hidden');
      
      if (isManualMode) {
        // Save manual script selection
        await setManualScript(script.id);
        console.log('[Scripts] Saving manual script selection:', script.name);
      }
      
      renderScriptStages();
    }
  });
  
  // Manual mode button
  $('scriptManualModeBtn')?.addEventListener('click', async () => {
    const currentScript = Store.get('currentScript');
    if (currentScript) {
      await setManualScript(currentScript.id);
      
      // Update UI
      $('scriptManualModeBtn')?.classList.add('hidden');
      $('scriptAutoModeBtn')?.classList.remove('hidden');
      $('scriptModeIndicator')?.classList.remove('hidden');
      
      showNotification('Manual script selection enabled');
    }
  });
  
  // Auto mode button
  $('scriptAutoModeBtn')?.addEventListener('click', async () => {
    await clearManualScript();
    
    // Update UI
    $('scriptAutoModeBtn')?.classList.add('hidden');
    $('scriptManualModeBtn')?.classList.remove('hidden');
    $('scriptModeIndicator')?.classList.add('hidden');
    
    // Re-run auto selection
    const storedNotes = Store.get('storedChat')?.notes || {};
    autoSelectScript(storedNotes.subscribedSince);
    
    showNotification('Returned to automatic script selection');
  });
  
  // Setup editor listeners (scripts tab)
  setupEditorListeners();
  
  // Setup calendar listeners
  setupCalendarListeners();
  
  // Setup AI script builder listeners
  setupScriptBuilderListeners();
  
  // Timing & scheduling settings listeners
  $('scriptScheduleType')?.addEventListener('change', (e) => {
    updateScheduleTypeVisibility(e.target.value);
  });
  
  $('scriptTimingMode')?.addEventListener('change', (e) => {
    updateTimingModeVisibility(e.target.value);
  });
  
  // Day number up/down buttons
  $('dayUpBtn')?.addEventListener('click', () => {
    const input = $('scriptSubscriberDay');
    if (input) {
      const current = parseInt(input.value) || 0;
      input.value = current + 1;
    }
  });
  
  $('dayDownBtn')?.addEventListener('click', () => {
    const input = $('scriptSubscriberDay');
    if (input) {
      const current = parseInt(input.value) || 2;
      if (current > 1) input.value = current - 1;
      else input.value = '';  // Clear to "Any"
    }
  });
};

// Re-export everything needed by other modules
export {
  // Core
  loadScripts,
  populateScriptDropdown,
  autoSelectScript,
  loadGlobalTemplates,
  copyTemplateToProfile,
  copyAllTemplatesToProfile,
  saveScriptAsTemplate,
  
  // Renderer
  renderScriptStages,
  initAndRender,
  resetDisplayedSection,
  
  // Editor
  renderScriptList,
  
  // Goal detection
  checkGoalCompletion,
  isActionCompleted,
  getCurrentIncompleteAction,
  getSubscriberScriptStats,
  loadSubscriberProgress,
  autoSkipSatisfiedGoals,
  updateToneForCurrentAction,
  getActionForGeneration,
  checkCurrentActionSatisfied,
  
  // Progress Manager
  Progress
};

// Default export for backwards compatibility
export default {
  loadScripts,
  renderScriptStages,
  renderScriptList,
  setupScriptsListeners
};
