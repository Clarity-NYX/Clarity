// ============================================================
// SCRIPTS MODULE - CORE (Load, Save, Select)
// Uses per-subscriber progress tracking
// Profile-specific scripts with global templates support
// ============================================================

import Store from '../../state/store.js';
import { $ } from '../../utils/dom.js';
import { showNotification } from '../../utils/notify.js';
import API from '../../utils/api.js';
import { getScriptOrder } from './timing.js';
import { smartDetectCompletedCheckpoints } from './goalDetection.js';

// Get current profile ID helper
const getCurrentProfileId = () => {
  const currentProfile = Store.get('currentProfile');
  return currentProfile?.id || null;
};

// Render callbacks (set from index.js to avoid circular deps)
let _renderScriptStages = null;
let _renderScriptList = null;
let _populateScriptDropdown = null;

export const setRenderCallbacks = (renderStages, renderList, populateDropdown) => {
  _renderScriptStages = renderStages;
  _renderScriptList = renderList;
  _populateScriptDropdown = populateDropdown;
};

// Check if action is completed for current subscriber (per-script)
const isActionCompletedForScript = (scriptId, stageIdx, actionIdx) => {
  const storedChat = Store.get('storedChat') || {};
  if (!scriptId || !storedChat.scriptProgress) {
    return false;
  }
  
  const progress = storedChat.scriptProgress[scriptId] || { completedActions: [] };
  const key = `${stageIdx}:${actionIdx}`;
  return progress.completedActions?.includes(key) || false;
};

// Check if a script has incomplete actions (per-subscriber)
const hasIncompleteActions = (script) => {
  const stages = script.stages || [];
  return stages.some((stage, stageIdx) => {
    const actions = stage.actions || stage.messages || [];
    return actions.some((_, actionIdx) => !isActionCompletedForScript(script.id, stageIdx, actionIdx));
  });
};

// Get script completion progress (percentage) - per-subscriber
export const getScriptProgress = (script) => {
  const stages = script.stages || [];
  let total = 0;
  let completed = 0;
  
  stages.forEach((stage, stageIdx) => {
    const actions = stage.actions || stage.messages || [];
    actions.forEach((_, actionIdx) => {
      total++;
      if (isActionCompletedForScript(script.id, stageIdx, actionIdx)) {
        completed++;
      }
    });
  });
  
  return total > 0 ? (completed / total) : 0;
};

// Check if script is 100% complete
export const isScriptComplete = (script) => {
  const progress = getScriptProgress(script);
  return progress >= 1.0;
};

// Calculate subscriber day (how many days since subscription)
const getSubscriberDay = (subscribedSince) => {
  if (!subscribedSince) return 1;
  
  const since = new Date(subscribedSince);
  const now = new Date();
  const diffDays = Math.floor((now - since) / (1000 * 60 * 60 * 24));
  
  return diffDays + 1;
};

// ============================================================
// LOAD SCRIPTS
// ============================================================

// Load scripts for current profile
export const loadScripts = async () => {
  const profileId = getCurrentProfileId();
  
  if (!profileId) {
    console.warn('No profile selected, cannot load scripts');
    Store.set('scripts', []);
    if (_renderScriptList) _renderScriptList();
    return;
  }
  
  try {
    const response = await API.getProfileScripts(profileId);
    console.log('Profile scripts response for', profileId, ':', response);
    
    if (response && response.success && response.scripts) {
      Store.set('scripts', response.scripts);
      chrome.storage.local.set({ scripts: response.scripts });
      if (_populateScriptDropdown) _populateScriptDropdown();
      if (_renderScriptList) _renderScriptList();
      
      chrome.storage.local.get(['currentScriptId'], (result) => {
        const scripts = Store.get('scripts');
        const currentId = result.currentScriptId;
        
        if (currentId) {
          const script = scripts.find(s => s.id === currentId);
          if (script) {
            Store.set('currentScript', script);
            const scriptSelect = $('scriptSelect');
            if (scriptSelect) scriptSelect.value = currentId;
            if (_renderScriptStages) _renderScriptStages();
          }
        } else if (scripts.length > 0) {
          Store.set('currentScript', scripts[0]);
          chrome.storage.local.set({ currentScriptId: scripts[0].id });
          if (_renderScriptStages) _renderScriptStages();
        }
      });
    } else {
      console.warn('Scripts response not successful');
      Store.set('scripts', []);
      if (_renderScriptList) _renderScriptList();
    }
  } catch (error) {
    console.error('Failed to load scripts from API:', error);
    Store.set('scripts', []);
    if (_renderScriptList) _renderScriptList();
  }
};

// Load global templates
export const loadGlobalTemplates = async () => {
  try {
    const response = await API.getGlobalScripts();
    console.log('Global templates response:', response);
    
    if (response && response.success && response.scripts) {
      Store.set('globalTemplates', response.scripts);
      return response.scripts;
    }
  } catch (error) {
    console.error('Failed to load global templates:', error);
  }
  
  Store.set('globalTemplates', []);
  return [];
};

// Fallback to localStorage
const loadScriptsFromLocalStorage = () => {
  chrome.storage.local.get(['scripts'], (result) => {
    if (result.scripts && result.scripts.length > 0) {
      Store.set('scripts', result.scripts);
      if (_populateScriptDropdown) _populateScriptDropdown();
      if (_renderScriptList) _renderScriptList();
      
      const scripts = Store.get('scripts');
      if (scripts.length > 0) {
        Store.set('currentScript', scripts[0]);
        if (_renderScriptStages) _renderScriptStages();
      }
    } else {
      Store.set('scripts', []);
      if (_renderScriptList) _renderScriptList();
    }
  });
};

// Populate dropdown (sorted by order)
export const populateScriptDropdown = () => {
  const scriptSelect = $('scriptSelect');
  if (!scriptSelect) return;
  
  const scripts = Store.get('scripts');
  const sortedScripts = [...scripts].sort((a, b) => getScriptOrder(a) - getScriptOrder(b));
  scriptSelect.innerHTML = sortedScripts.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
};

// Populate chat script dropdown with completion indicators
export const populateChatScriptDropdown = () => {
  const scriptSelectChat = $('scriptSelectChat');
  if (!scriptSelectChat) return;
  
  const scripts = Store.get('scripts') || [];
  const sortedScripts = [...scripts].sort((a, b) => getScriptOrder(a) - getScriptOrder(b));
  
  if (scripts.length === 0) {
    scriptSelectChat.innerHTML = '<option value="">No scripts available</option>';
    return;
  }
  
  // Build options with completion status
  scriptSelectChat.innerHTML = sortedScripts.map(script => {
    const progress = getScriptProgress(script);
    const progressPercent = Math.round(progress * 100);
    const isComplete = progressPercent === 100;
    
    let displayText = script.name;
    if (isComplete) {
      displayText += ' ✅';
    } else if (progressPercent > 0) {
      displayText += ` (${progressPercent}%)`;
    }
    
    return `<option value="${script.id}" data-complete="${isComplete}" data-progress="${progressPercent}">${displayText}</option>`;
  }).join('');
  
  // Set current script
  const currentScript = Store.get('currentScript');
  if (currentScript) {
    scriptSelectChat.value = currentScript.id;
  }
};

// Check if manual mode is active for subscriber
export const isManualModeActive = () => {
  const subscriberId = Store.get('currentSubscriberId');
  if (!subscriberId) return false;
  
  const storedChat = Store.get('storedChat') || {};
  return storedChat.manualScriptMode === true;
};

// Get manual script selection for subscriber
export const getManualScriptId = () => {
  const subscriberId = Store.get('currentSubscriberId');
  if (!subscriberId) return null;
  
  const storedChat = Store.get('storedChat') || {};
  return storedChat.manualScriptId || null;
};

// Set manual script selection
export const setManualScript = async (scriptId) => {
  const currentProfile = Store.get('currentProfile');
  const subscriberId = Store.get('currentSubscriberId');
  
  if (!currentProfile || !subscriberId) return;
  
  // Get current stored chat and notes
  const storedChat = Store.get('storedChat') || {};
  const currentNotes = storedChat.notes || {};
  
  // Update notes with manual script selection
  const updatedNotes = {
    ...currentNotes,
    manualScriptMode: true,
    manualScriptId: scriptId
  };
  
  // Update local state
  storedChat.notes = updatedNotes;
  Store.set('storedChat', storedChat);
  
  // Save to database
  try {
    await API.saveChatNotes({
      profileId: currentProfile.id,
      subscriberId: subscriberId,
      notes: updatedNotes
    });
    console.log('[Scripts] Manual script saved:', scriptId);
  } catch (error) {
    console.error('Failed to save manual script selection:', error);
  }
};

// Clear manual script selection (return to auto)
export const clearManualScript = async () => {
  const currentProfile = Store.get('currentProfile');
  const subscriberId = Store.get('currentSubscriberId');
  
  if (!currentProfile || !subscriberId) return;
  
  // Get current stored chat and notes
  const storedChat = Store.get('storedChat') || {};
  const currentNotes = storedChat.notes || {};
  
  // Update notes to clear manual script selection
  const updatedNotes = {
    ...currentNotes,
    manualScriptMode: false,
    manualScriptId: null
  };
  
  // Update local state
  storedChat.notes = updatedNotes;
  Store.set('storedChat', storedChat);
  
  // Save to database
  try {
    await API.saveChatNotes({
      profileId: currentProfile.id,
      subscriberId: subscriberId,
      notes: updatedNotes
    });
    console.log('[Scripts] Manual script mode cleared');
  } catch (error) {
    console.error('Failed to clear manual script selection:', error);
  }
};

// ============================================================
// SCRIPT SELECTION
// ============================================================

// Find best matching script based on subscriber day and schedule
export const selectScriptForSubscriber = (subscribedSince) => {
  const scripts = Store.get('scripts');
  if (!scripts || scripts.length === 0) return null;
  
  const subscriberDay = getSubscriberDay(subscribedSince);
  const messageCount = (Store.get('messages') || []).length;
  console.log(`📅 Subscriber is on Day ${subscriberDay}, ${messageCount} messages in chat`);
  
  const sortedScripts = [...scripts].sort((a, b) => getScriptOrder(a) - getScriptOrder(b));
  console.log('📋 Script order:', sortedScripts.map(s => `${s.name}(${getScriptOrder(s)})`).join(' → '));
  
  const welcomeScripts = sortedScripts.filter(s => 
    /welcome|intro|greeting|first|new|day\s*1\b|d1\b|opening/i.test(s.name)
  );
  
  console.log(`🎯 Welcome scripts found: ${welcomeScripts.map(s => s.name).join(', ') || 'none'}`);
  
  // PRIORITY 1: For Day 1 subscribers or NEW CHATS
  if (subscriberDay === 1 || messageCount < 15) {
    console.log(`🆕 Day 1 subscriber or new chat (${messageCount} msgs) - prioritizing welcome script`);
    
    const incompleteWelcome = welcomeScripts.find(s => hasIncompleteActions(s));
    if (incompleteWelcome) {
      console.log(`🎯 Using incomplete welcome script: "${incompleteWelcome.name}"`);
      return incompleteWelcome;
    }
    
    if (welcomeScripts.length > 0) {
      const welcomeWithActions = welcomeScripts.find(s => {
        const stages = s.stages || [];
        return stages.some(st => (st.actions || st.messages || []).length > 0);
      });
      if (welcomeWithActions) {
        console.log(`🎯 Using welcome script (complete): "${welcomeWithActions.name}"`);
        return welcomeWithActions;
      }
    }
    
    console.log(`📋 No welcome script - using first: "${sortedScripts[0].name}"`);
    return sortedScripts[0];
  }
  
  // PRIORITY 2: Established chat - find first script with incomplete actions
  for (const script of sortedScripts) {
    if (hasIncompleteActions(script)) {
      const progress = getScriptProgress(script);
      console.log(`📝 Found incomplete script: "${script.name}" (${(progress * 100).toFixed(0)}% complete)`);
      return script;
    }
  }
  
  // PRIORITY 3: All scripts complete - use first
  console.log('✅ All scripts complete - using first script');
  return sortedScripts[0];
};

// Auto-select script when chat loads
export const autoSelectScript = (subscribedSince) => {
  const script = selectScriptForSubscriber(subscribedSince);
  
  if (script) {
    Store.set('currentScript', script);
    chrome.storage.local.set({ currentScriptId: script.id });
    
    const scriptSelect = $('scriptSelect');
    if (scriptSelect) scriptSelect.value = script.id;
    
    if (_renderScriptStages) _renderScriptStages();
    console.log(`✅ Auto-selected script: "${script.name}"`);
    
    // After selecting script, run smart detection
    setTimeout(() => smartDetectCompletedCheckpoints(_renderScriptStages), 2000);
    
    return script;
  }
  
  return null;
};

// Save current script to storage
export const saveCurrentScript = () => {
  const scripts = Store.get('scripts');
  const currentScript = Store.get('currentScript');
  
  const scriptIndex = scripts.findIndex(s => s.id === currentScript.id);
  if (scriptIndex !== -1) {
    scripts[scriptIndex] = currentScript;
    Store.set('scripts', scripts);
    chrome.storage.local.set({ scripts });
  }
};

// ============================================================
// CREATE SCRIPTS
// ============================================================

// Create new script for current profile
export const createNewScript = async () => {
  const profileId = getCurrentProfileId();
  
  if (!profileId) {
    showNotification('Please select a profile first');
    return null;
  }
  
  const input = $('newScriptNameInput');
  const name = input?.value?.trim();
  
  if (!name) {
    showNotification('Enter a script name');
    input?.focus();
    return;
  }
  
  try {
    const response = await API.createProfileScript({ profileId, name, stages: [] });
    
    if (response.success && response.script) {
      const scripts = Store.get('scripts');
      scripts.push(response.script);
      Store.set('scripts', scripts);
      
      if (input) input.value = '';
      
      if (_populateScriptDropdown) _populateScriptDropdown();
      if (_renderScriptList) _renderScriptList();
      
      showNotification('Script created!');
      return response.script;
    } else {
      showNotification(response.error || 'Failed to create script');
    }
  } catch (error) {
    console.error('Create script error:', error);
    showNotification('Failed to create script');
  }
  
  return null;
};

// ============================================================
// COPY OPERATIONS
// ============================================================

// Copy a global template to current profile
export const copyTemplateToProfile = async (templateId) => {
  const profileId = getCurrentProfileId();
  
  if (!profileId) {
    showNotification('Please select a profile first');
    return false;
  }
  
  try {
    const response = await API.copyScriptToProfile(templateId, profileId);
    
    if (response.success) {
      showNotification(response.message || 'Script copied to profile!');
      
      // Add to local scripts list
      if (response.script) {
        const scripts = Store.get('scripts');
        scripts.push(response.script);
        Store.set('scripts', scripts);
        
        if (_populateScriptDropdown) _populateScriptDropdown();
        if (_renderScriptList) _renderScriptList();
      }
      
      return true;
    } else {
      showNotification(response.error || 'Failed to copy script');
    }
  } catch (error) {
    console.error('Copy template error:', error);
    showNotification('Failed to copy script');
  }
  
  return false;
};

// Copy all global templates to current profile
export const copyAllTemplatesToProfile = async () => {
  const profileId = getCurrentProfileId();
  
  if (!profileId) {
    showNotification('Please select a profile first');
    return false;
  }
  
  try {
    const response = await API.copyAllTemplatesToProfile(profileId);
    
    if (response.success) {
      showNotification(response.message || `Copied ${response.copied} scripts to profile!`);
      
      // Reload scripts to get the copies
      await loadScripts();
      return true;
    } else {
      showNotification(response.error || 'Failed to copy scripts');
    }
  } catch (error) {
    console.error('Copy all templates error:', error);
    showNotification('Failed to copy scripts');
  }
  
  return false;
};

// Save current profile script as a global template
export const saveScriptAsTemplate = async (scriptId) => {
  const profileId = getCurrentProfileId();
  
  if (!profileId || !scriptId) {
    showNotification('Invalid script or profile');
    return false;
  }
  
  try {
    const response = await API.copyScriptToTemplates(scriptId, profileId);
    
    if (response.success) {
      showNotification(response.message || 'Saved as template!');
      return true;
    } else {
      showNotification(response.error || 'Failed to save as template');
    }
  } catch (error) {
    console.error('Save as template error:', error);
    showNotification('Failed to save as template');
  }
  
  return false;
};

// Export for external use
export { getCurrentProfileId };
