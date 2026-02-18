// ============================================================
// SCRIPTS MODULE - AI SCRIPT BUILDER
// Generate complete scripts using AI
// ============================================================

import Store from '../../state/store.js';
import { $ } from '../../utils/dom.js';
import { showNotification } from '../../utils/notify.js';
import API from '../../utils/api.js';
import { loadScripts, populateScriptDropdown } from './core.js';
import { renderScriptList } from './editor.js';

// State
let selectedCategory = 'casual';
let generatedScript = null;

// Get current profile helper
const getCurrentProfileId = () => {
  const currentProfile = Store.get('currentProfile');
  return currentProfile?.id || null;
};

// Get current profile data
const getCurrentProfile = () => {
  return Store.get('currentProfile');
};

// Open script builder modal
export const openScriptBuilder = () => {
  const profileId = getCurrentProfileId();
  
  if (!profileId) {
    showNotification('Please select a profile first');
    return;
  }
  
  // Reset state
  selectedCategory = 'casual';
  generatedScript = null;
  
  // Reset UI
  $('scriptPromptInput').value = '';
  $('actionCountSlider').value = 15;
  $('actionCountDisplay').textContent = '15';
  
  // Reset category selection
  document.querySelectorAll('.category-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.category === 'casual');
  });
  
  // Hide preview, show generate button
  $('scriptPreview')?.classList.add('hidden');
  $('scriptBuilderLoading')?.classList.add('hidden');
  $('generateScriptBtn')?.classList.remove('hidden');
  $('saveGeneratedScriptBtn')?.classList.add('hidden');
  $('regenerateScriptBtn')?.classList.add('hidden');
  
  // Show modal
  $('scriptBuilderModal')?.classList.remove('hidden');
};

// Close script builder modal
export const closeScriptBuilder = () => {
  $('scriptBuilderModal')?.classList.add('hidden');
  generatedScript = null;
};

// Handle category selection
export const selectCategory = (category) => {
  selectedCategory = category;
  
  document.querySelectorAll('.category-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.category === category);
  });
};

// Generate script via AI
export const generateScript = async () => {
  const prompt = $('scriptPromptInput')?.value?.trim();
  
  if (!prompt) {
    showNotification('Please enter a script idea');
    $('scriptPromptInput')?.focus();
    return;
  }
  
  const actionCount = parseInt($('actionCountSlider')?.value) || 15;
  const profile = getCurrentProfile();
  
  // Show loading
  $('scriptBuilderLoading')?.classList.remove('hidden');
  $('generateScriptBtn')?.classList.add('hidden');
  $('scriptPreview')?.classList.add('hidden');
  
  try {
    const response = await API.generateScript({
      prompt,
      category: selectedCategory,
      actionCount,
      profile: profile ? {
        name: profile.name,
        age: profile.age,
        defaultTone: profile.defaultTone,
        personality: profile.personality,
        styleRules: profile.styleRules
      } : null
    });
    
    if (response.success && response.script) {
      generatedScript = response.script;
      renderScriptPreview(generatedScript);
      
      // Show preview and action buttons
      $('scriptPreview')?.classList.remove('hidden');
      $('saveGeneratedScriptBtn')?.classList.remove('hidden');
      $('regenerateScriptBtn')?.classList.remove('hidden');
      
      showNotification('Script generated!');
    } else {
      throw new Error(response.error || 'Failed to generate script');
    }
  } catch (error) {
    console.error('Generate script error:', error);
    showNotification(error.message || 'Failed to generate script');
    $('generateScriptBtn')?.classList.remove('hidden');
  } finally {
    $('scriptBuilderLoading')?.classList.add('hidden');
  }
};

// Render preview of generated script
const renderScriptPreview = (script) => {
  const nameInput = $('generatedScriptName');
  const stagesContainer = $('previewStages');
  
  if (nameInput) {
    nameInput.value = script.name || 'Untitled Script';
  }
  
  if (!stagesContainer) return;
  
  // Action type icons
  const typeIcons = {
    text: '💬',
    voice: '🎤',
    media: '📸'
  };
  
  // Tone badges
  const toneBadges = {
    sweet: '💕',
    flirty: '😏',
    spicy: '🔥',
    casual: '💬',
    dominant: '😈',
    submissive: '🥺'
  };
  
  stagesContainer.innerHTML = script.stages.map((stage, stageIdx) => `
    <div class="preview-stage">
      <div class="preview-stage-header">${stageIdx + 1}. ${stage.name}</div>
      ${(stage.actions || []).map(action => `
        <div class="preview-action">
          <span class="preview-action-type">${typeIcons[action.type] || '💬'}</span>
          <span class="preview-action-goal">${action.goal}</span>
          ${action.tone ? `<span class="preview-action-tone">${toneBadges[action.tone] || ''} ${action.tone}</span>` : ''}
        </div>
      `).join('')}
    </div>
  `).join('');
};

// Save generated script to profile
export const saveGeneratedScript = async () => {
  if (!generatedScript) {
    showNotification('No script to save');
    return;
  }
  
  const profileId = getCurrentProfileId();
  if (!profileId) {
    showNotification('Please select a profile first');
    return;
  }
  
  // Get potentially edited name
  const nameInput = $('generatedScriptName');
  if (nameInput) {
    generatedScript.name = nameInput.value.trim() || generatedScript.name;
  }
  
  try {
    const response = await API.createProfileScript({
      profileId,
      name: generatedScript.name,
      stages: generatedScript.stages
    });
    
    if (response.success && response.script) {
      // Add to local scripts
      const scripts = Store.get('scripts') || [];
      scripts.push(response.script);
      Store.set('scripts', scripts);
      
      // Refresh UI
      populateScriptDropdown();
      renderScriptList();
      
      showNotification('Script saved to profile!');
      closeScriptBuilder();
    } else {
      throw new Error(response.error || 'Failed to save script');
    }
  } catch (error) {
    console.error('Save script error:', error);
    showNotification(error.message || 'Failed to save script');
  }
};

// Regenerate script (keep same prompt)
export const regenerateScript = () => {
  generatedScript = null;
  generateScript();
};

// Setup event listeners
export const setupScriptBuilderListeners = () => {
  // Open AI Script Builder
  $('aiGenerateScriptBtn')?.addEventListener('click', openScriptBuilder);
  
  // Close modal
  $('closeScriptBuilderBtn')?.addEventListener('click', closeScriptBuilder);
  $('cancelScriptBuilderBtn')?.addEventListener('click', closeScriptBuilder);
  
  // Close on backdrop click
  $('scriptBuilderModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'scriptBuilderModal') {
      closeScriptBuilder();
    }
  });
  
  // Category selection
  document.querySelectorAll('.category-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectCategory(btn.dataset.category);
    });
  });
  
  // Action count slider
  $('actionCountSlider')?.addEventListener('input', (e) => {
    $('actionCountDisplay').textContent = e.target.value;
  });
  
  // Generate button
  $('generateScriptBtn')?.addEventListener('click', generateScript);
  
  // Save button
  $('saveGeneratedScriptBtn')?.addEventListener('click', saveGeneratedScript);
  
  // Regenerate button
  $('regenerateScriptBtn')?.addEventListener('click', regenerateScript);
};

export default {
  openScriptBuilder,
  closeScriptBuilder,
  setupScriptBuilderListeners
};
