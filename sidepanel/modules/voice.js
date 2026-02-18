// ============================================================
// VOICE MODULE - ElevenLabs Voice Generation
// ============================================================

import Store from '../state/store.js';
import { $, $$ } from '../utils/dom.js';
import { showNotification } from '../utils/notify.js';
import { apiRequest } from '../utils/api.js';

// Voice settings state
let voiceSettings = {
  elevenLabsApiKey: '',
  selectedVoiceId: '',
  selectedVoiceName: '',
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  speed: 1.0,
  modelId: 'eleven_multilingual_v2'  // Use v2/v3 for better quality
};

// Available voices (fetched from API)
let availableVoices = [];

// Voice library (saved generated messages)
let voiceLibrary = [];

// Current audio state
let currentAudio = null;
let isGenerating = false;

// ============================================================
// VOICE SETTINGS MANAGEMENT
// ============================================================

// Load voice settings from storage
export const loadVoiceSettings = () => {
  return new Promise(resolve => {
    chrome.storage.local.get(['voiceSettings', 'voiceLibrary'], (result) => {
      if (result.voiceSettings) {
        voiceSettings = { ...voiceSettings, ...result.voiceSettings };
      }
      if (result.voiceLibrary) {
        voiceLibrary = result.voiceLibrary;
      }
      resolve(voiceSettings);
    });
  });
};

// Save voice settings to storage
export const saveVoiceSettings = () => {
  chrome.storage.local.set({ voiceSettings });
};

// Save voice library to storage
const saveVoiceLibrary = () => {
  chrome.storage.local.set({ voiceLibrary });
};

// Get current voice settings
export const getVoiceSettings = () => voiceSettings;

// Update voice settings
export const updateVoiceSettings = (updates) => {
  voiceSettings = { ...voiceSettings, ...updates };
  saveVoiceSettings();
  return voiceSettings;
};

// ============================================================
// ELEVENLABS API INTEGRATION
// ============================================================

// Fetch available voices from ElevenLabs
export const fetchVoices = async () => {
  if (!voiceSettings.elevenLabsApiKey) {
    showNotification('Please enter your ElevenLabs API key first');
    return [];
  }
  
  try {
    const response = await apiRequest('/voice/voices', {
      headers: {
        'x-elevenlabs-api-key': voiceSettings.elevenLabsApiKey
      }
    });
    
    if (response.voices) {
      availableVoices = response.voices;
      renderVoiceDropdown();
      showNotification(`Loaded ${availableVoices.length} voices`);
      return availableVoices;
    }
    
    return [];
  } catch (error) {
    console.error('Failed to fetch voices:', error);
    showNotification('Failed to fetch voices. Check your API key.');
    return [];
  }
};

// Generate voice from text
export const generateVoice = async (text, options = {}) => {
  if (!voiceSettings.elevenLabsApiKey) {
    showNotification('Please configure ElevenLabs API key in settings');
    return null;
  }
  
  if (!voiceSettings.selectedVoiceId) {
    showNotification('Please select a voice first');
    return null;
  }
  
  if (!text?.trim()) {
    showNotification('Please enter text to generate voice');
    return null;
  }
  
  // Replace placeholders in text
  const resolvedText = resolveTemplatePlaceholders(text);
  
  isGenerating = true;
  updateGenerateButtonState();
  
  try {
    const response = await apiRequest('/voice/generate', {
      method: 'POST',
      headers: {
        'x-elevenlabs-api-key': voiceSettings.elevenLabsApiKey
      },
      body: JSON.stringify({
        text: resolvedText,
        voiceId: voiceSettings.selectedVoiceId,
        stability: voiceSettings.stability,
        similarityBoost: voiceSettings.similarityBoost,
        style: voiceSettings.style,
        speed: voiceSettings.speed,
        modelId: voiceSettings.modelId
      })
    });
    
    if (response.audio) {
      const audioData = {
        id: Date.now(),
        audio: response.audio,
        contentType: response.contentType,
        text: resolvedText,
        originalText: text,
        voiceId: voiceSettings.selectedVoiceId,
        voiceName: voiceSettings.selectedVoiceName,
        settings: response.settings,
        createdAt: new Date().toISOString()
      };
      
      showAudioPlayer(audioData);
      
      // Optionally save to library
      if (options.saveToLibrary !== false) {
        addToVoiceLibrary(audioData);
      }
      
      showNotification('Voice generated successfully!');
      return audioData;
    }
    
    throw new Error('No audio in response');
    
  } catch (error) {
    console.error('Voice generation failed:', error);
    showNotification('Failed to generate voice: ' + (error.message || 'Unknown error'));
    return null;
  } finally {
    isGenerating = false;
    updateGenerateButtonState();
  }
};

// ============================================================
// TEMPLATE PLACEHOLDER SYSTEM
// ============================================================

// Resolve template placeholders
export const resolveTemplatePlaceholders = (text) => {
  if (!text) return '';
  
  // Get subscriber name from store or use fallback
  const subscriberName = Store.get('subscriberName') || 
                         Store.get('currentSubscriberName') || 
                         'babe';
  
  const now = new Date();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const day = dayNames[now.getDay()];
  
  // Determine time of day
  const hour = now.getHours();
  let timeOfDay = 'day';
  if (hour < 12) timeOfDay = 'morning';
  else if (hour < 17) timeOfDay = 'afternoon';
  else if (hour < 21) timeOfDay = 'evening';
  else timeOfDay = 'night';
  
  // Replace placeholders
  return text
    .replace(/\[Name\]/gi, subscriberName)
    .replace(/\[Day\]/gi, day)
    .replace(/\[Time\]/gi, timeOfDay);
};

// Preview resolved text (for display)
export const previewResolvedText = (text) => {
  const resolved = resolveTemplatePlaceholders(text);
  const previewEl = $('voiceTemplatePreview');
  if (previewEl) {
    previewEl.textContent = resolved;
    previewEl.classList.toggle('hidden', !text || text === resolved);
  }
  return resolved;
};

// ============================================================
// AUDIO PLAYBACK
// ============================================================

// Show audio player with generated audio
const showAudioPlayer = (audioData) => {
  const playerContainer = $('voiceAudioPlayer');
  if (!playerContainer) return;
  
  // Create audio element
  const audioUrl = `data:${audioData.contentType};base64,${audioData.audio}`;
  
  playerContainer.innerHTML = `
    <div class="voice-player">
      <div class="voice-player-info">
        <span class="voice-player-voice">🎤 ${audioData.voiceName || 'Voice'}</span>
        <span class="voice-player-text">"${audioData.text.slice(0, 50)}${audioData.text.length > 50 ? '...' : ''}"</span>
      </div>
      <audio id="voiceAudioElement" controls>
        <source src="${audioUrl}" type="${audioData.contentType}">
      </audio>
      <div class="voice-player-actions">
        <button class="btn btn-sm btn-outline" id="downloadVoiceBtn" title="Download audio">
          💾 Download
        </button>
        <button class="btn btn-sm btn-primary" id="sendVoiceBtn" title="Send to Chat">
          📤 Send
        </button>
      </div>
    </div>
  `;
  
  playerContainer.classList.remove('hidden');
  
  // Auto-play the audio
  const audioElement = $('voiceAudioElement');
  if (audioElement) {
    setTimeout(() => {
      audioElement.play().catch(e => {
        console.log('Auto-play blocked:', e.message);
      });
    }, 100);
  }
  
  // Setup download button
  $('downloadVoiceBtn')?.addEventListener('click', () => {
    downloadAudio(audioData);
  });
  
  // Setup send button
  $('sendVoiceBtn')?.addEventListener('click', () => {
    sendVoiceToChat(audioData);
  });
  
  // Store current audio for reference
  currentAudio = audioData;
};

// Download audio file
const downloadAudio = (audioData) => {
  const audioUrl = `data:${audioData.contentType};base64,${audioData.audio}`;
  const link = document.createElement('a');
  link.href = audioUrl;
  link.download = `voice_${audioData.id}.mp3`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showNotification('Audio downloaded!');
};

// Send voice to chat (placeholder - needs platform integration)
const sendVoiceToChat = async (audioData) => {
  showNotification('Voice message ready - download and send manually for now');
  downloadAudio(audioData);
};

// ============================================================
// VOICE LIBRARY
// ============================================================

// Add audio to voice library
const addToVoiceLibrary = (audioData) => {
  // Don't save the full audio data to storage (too large)
  const libraryEntry = {
    id: audioData.id,
    text: audioData.text,
    originalText: audioData.originalText,
    voiceId: audioData.voiceId,
    voiceName: audioData.voiceName,
    createdAt: audioData.createdAt
  };
  
  voiceLibrary.unshift(libraryEntry);
  
  // Keep only last 50 entries
  if (voiceLibrary.length > 50) {
    voiceLibrary = voiceLibrary.slice(0, 50);
  }
  
  saveVoiceLibrary();
  renderVoiceLibrary();
};

// Render voice library
export const renderVoiceLibrary = () => {
  const container = $('voiceLibraryList');
  if (!container) return;
  
  if (voiceLibrary.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎤</div>
        <p>No voice messages yet</p>
        <small>Generated messages will appear here</small>
      </div>
    `;
    return;
  }
  
  container.innerHTML = voiceLibrary.map(entry => `
    <div class="voice-library-item" data-id="${entry.id}">
      <div class="voice-library-info">
        <span class="voice-library-text">"${entry.text.slice(0, 40)}${entry.text.length > 40 ? '...' : ''}"</span>
        <span class="voice-library-meta">${entry.voiceName} • ${new Date(entry.createdAt).toLocaleDateString()}</span>
      </div>
      <div class="voice-library-actions">
        <button class="btn btn-xs btn-outline regenerate-voice-btn" data-text="${encodeURIComponent(entry.originalText || entry.text)}" title="Regenerate">
          🔄
        </button>
        <button class="btn btn-xs btn-outline delete-voice-btn" data-id="${entry.id}" title="Delete">
          🗑️
        </button>
      </div>
    </div>
  `).join('');
  
  // Setup regenerate buttons
  container.querySelectorAll('.regenerate-voice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = decodeURIComponent(btn.dataset.text);
      const templateInput = $('voiceTemplateInput');
      if (templateInput) {
        templateInput.value = text;
        previewResolvedText(text);
      }
      showNotification('Template loaded - click Generate to create');
    });
  });
  
  // Setup delete buttons
  container.querySelectorAll('.delete-voice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.id);
      deleteFromVoiceLibrary(id);
    });
  });
};

// Delete from voice library
const deleteFromVoiceLibrary = (id) => {
  voiceLibrary = voiceLibrary.filter(entry => entry.id !== id);
  saveVoiceLibrary();
  renderVoiceLibrary();
  showNotification('Removed from library');
};

// ============================================================
// UI RENDERING
// ============================================================

// Render voice dropdown
const renderVoiceDropdown = () => {
  const dropdown = $('voiceSelect');
  if (!dropdown) return;
  
  dropdown.innerHTML = `
    <option value="">Select a voice...</option>
    ${availableVoices.map(voice => `
      <option value="${voice.id}" ${voice.id === voiceSettings.selectedVoiceId ? 'selected' : ''}>
        ${voice.name} ${voice.category ? `(${voice.category})` : ''}
      </option>
    `).join('')}
  `;
};

// Update generate button state
const updateGenerateButtonState = () => {
  const btn = $('generateVoiceBtn');
  if (!btn) return;
  
  btn.disabled = isGenerating;
  btn.innerHTML = isGenerating ? 
    '<span class="spinner-sm"></span> Generating...' : 
    '🎤 Generate Voice';
};

// ============================================================
// VOICE SETTINGS UI
// ============================================================

// Render voice settings section in settings panel
export const renderVoiceSettings = () => {
  const container = $('voiceSettingsSection');
  if (!container) return;
  
  container.innerHTML = `
    <div class="settings-section voice-settings">
      <h4>🎤 Voice Settings (ElevenLabs)</h4>
      
      <div class="form-group">
        <label>API Key</label>
        <div class="input-with-btn">
          <input type="password" id="elevenLabsApiKeyInput" 
                 value="${voiceSettings.elevenLabsApiKey}" 
                 placeholder="Enter ElevenLabs API key">
          <button type="button" id="toggleApiKeyVisibility" class="btn btn-sm btn-outline">👁️</button>
        </div>
        <small class="form-hint">Get your API key from <a href="https://elevenlabs.io" target="_blank">elevenlabs.io</a></small>
      </div>
      
      <div class="form-group">
        <label>Voice</label>
        <div class="input-with-btn">
          <select id="voiceSelect" class="form-select">
            <option value="">Select a voice...</option>
          </select>
          <button type="button" id="fetchVoicesBtn" class="btn btn-sm btn-outline">🔄 Load</button>
        </div>
      </div>
      
      <div class="form-group">
        <label>Model</label>
        <select id="voiceModelSelect" class="form-select">
          <option value="eleven_ttv_v3" ${voiceSettings.modelId === 'eleven_ttv_v3' ? 'selected' : ''}>✨ TTV v3 (Human-like & Expressive - 70+ languages)</option>
          <option value="eleven_multilingual_v2" ${voiceSettings.modelId === 'eleven_multilingual_v2' ? 'selected' : ''}>🌍 Multilingual v2 (Most Lifelike - 29 languages)</option>
          <option value="eleven_flash_v2_5" ${voiceSettings.modelId === 'eleven_flash_v2_5' ? 'selected' : ''}>⚡ Flash v2.5 (~75ms - 32 languages)</option>
          <option value="eleven_flash_v2" ${voiceSettings.modelId === 'eleven_flash_v2' ? 'selected' : ''}>⚡ Flash v2 (~75ms - English only)</option>
          <option value="eleven_turbo_v2_5" ${voiceSettings.modelId === 'eleven_turbo_v2_5' ? 'selected' : ''}>🚀 Turbo v2.5 (~250ms - 32 languages)</option>
          <option value="eleven_turbo_v2" ${voiceSettings.modelId === 'eleven_turbo_v2' ? 'selected' : ''}>🚀 Turbo v2 (~250ms - English only)</option>
          <option value="eleven_multilingual_ttv_v2" ${voiceSettings.modelId === 'eleven_multilingual_ttv_v2' ? 'selected' : ''}>🎨 Multilingual TTV v2 (Voice Designer)</option>
          <option value="eleven_multilingual_sts_v2" ${voiceSettings.modelId === 'eleven_multilingual_sts_v2' ? 'selected' : ''}>🎭 Multilingual STS v2 (Speech-to-Speech)</option>
          <option value="eleven_english_sts_v2" ${voiceSettings.modelId === 'eleven_english_sts_v2' ? 'selected' : ''}>🎭 English STS v2 (Speech-to-Speech)</option>
          <option value="eleven_monolingual_v1" ${voiceSettings.modelId === 'eleven_monolingual_v1' ? 'selected' : ''}>🇺🇸 English v1 (Legacy)</option>
        </select>
        <small class="form-hint">TTV v3 = newest & most expressive, Multilingual v2 = most lifelike, Flash = fastest</small>
      </div>
      
      <div class="voice-sliders">
        <div class="form-group">
          <label>Stability: <span id="stabilityValue">${voiceSettings.stability}</span></label>
          <input type="range" id="voiceStabilitySlider" min="0" max="1" step="0.05" 
                 value="${voiceSettings.stability}">
          <small class="form-hint">Higher = more consistent, Lower = more expressive</small>
        </div>
        
        <div class="form-group">
          <label>Similarity: <span id="similarityValue">${voiceSettings.similarityBoost}</span></label>
          <input type="range" id="voiceSimilaritySlider" min="0" max="1" step="0.05" 
                 value="${voiceSettings.similarityBoost}">
          <small class="form-hint">How closely to match the original voice</small>
        </div>
        
        <div class="form-group">
          <label>Style: <span id="styleValue">${voiceSettings.style}</span></label>
          <input type="range" id="voiceStyleSlider" min="0" max="1" step="0.05" 
                 value="${voiceSettings.style}">
          <small class="form-hint">Exaggerates the style of the voice</small>
        </div>
      </div>
      
      <div class="form-group">
        <button type="button" id="testVoiceBtn" class="btn btn-sm btn-outline">
          🔊 Test Voice
        </button>
      </div>
    </div>
  `;
  
  setupVoiceSettingsListeners();
};

// Setup voice settings listeners
const setupVoiceSettingsListeners = () => {
  // API Key input
  $('elevenLabsApiKeyInput')?.addEventListener('change', (e) => {
    updateVoiceSettings({ elevenLabsApiKey: e.target.value });
  });
  
  // Toggle API key visibility
  $('toggleApiKeyVisibility')?.addEventListener('click', () => {
    const input = $('elevenLabsApiKeyInput');
    if (input) {
      input.type = input.type === 'password' ? 'text' : 'password';
    }
  });
  
  // Fetch voices button
  $('fetchVoicesBtn')?.addEventListener('click', fetchVoices);
  
  // Voice select
  $('voiceSelect')?.addEventListener('change', (e) => {
    const selectedOption = e.target.selectedOptions[0];
    updateVoiceSettings({ 
      selectedVoiceId: e.target.value,
      selectedVoiceName: selectedOption?.textContent?.trim() || ''
    });
  });
  
  // Model select
  $('voiceModelSelect')?.addEventListener('change', (e) => {
    updateVoiceSettings({ modelId: e.target.value });
    showNotification(`Model changed to ${e.target.selectedOptions[0]?.textContent?.trim() || e.target.value}`);
  });
  
  // Stability slider
  $('voiceStabilitySlider')?.addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    $('stabilityValue').textContent = value;
    updateVoiceSettings({ stability: value });
  });
  
  // Similarity slider
  $('voiceSimilaritySlider')?.addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    $('similarityValue').textContent = value;
    updateVoiceSettings({ similarityBoost: value });
  });
  
  // Style slider
  $('voiceStyleSlider')?.addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    $('styleValue').textContent = value;
    updateVoiceSettings({ style: value });
  });
  
  // Test voice button
  $('testVoiceBtn')?.addEventListener('click', async () => {
    await generateVoice('Hello, this is a test of my voice.', { saveToLibrary: false });
  });
  
  // If we have an API key, try to load voices
  if (voiceSettings.elevenLabsApiKey) {
    fetchVoices();
  }
};

// ============================================================
// VOICE GENERATOR PANEL (in chat)
// ============================================================

// Render voice generator panel
export const renderVoiceGeneratorPanel = () => {
  const container = $('voiceGeneratorPanel');
  if (!container) return;
  
  const hasApiKey = !!voiceSettings.elevenLabsApiKey;
  const hasVoice = !!voiceSettings.selectedVoiceId;
  
  container.innerHTML = `
    <div class="voice-generator ${!hasApiKey || !hasVoice ? 'not-configured' : ''}">
      <div class="voice-generator-header">
        <span>🎤 Voice Message</span>
        ${!hasApiKey ? '<span class="badge badge-warning">API Key Required</span>' : ''}
        ${hasApiKey && !hasVoice ? '<span class="badge badge-warning">Select Voice</span>' : ''}
      </div>
      
      ${hasApiKey && hasVoice ? `
        <div class="voice-generator-body">
          <div class="form-group">
            <textarea id="voiceTemplateInput" 
                      class="form-textarea" 
                      placeholder="Hello [Name], how's your day babe?"
                      rows="2"></textarea>
            <div class="voice-placeholders">
              <span class="placeholder-hint">Placeholders:</span>
              <button type="button" class="placeholder-btn" data-placeholder="[Name]">[Name]</button>
              <button type="button" class="placeholder-btn" data-placeholder="[Day]">[Day]</button>
              <button type="button" class="placeholder-btn" data-placeholder="[Time]">[Time]</button>
            </div>
            <div id="voiceTemplatePreview" class="voice-preview hidden"></div>
          </div>
          
          <div id="voiceAudioPlayer" class="voice-audio-player hidden"></div>
          
          <button type="button" id="generateVoiceBtn" class="btn btn-primary btn-block">
            🎤 Generate Voice
          </button>
        </div>
      ` : `
        <div class="voice-generator-body">
          <p class="voice-setup-hint">Configure voice settings to enable voice messages</p>
          <button type="button" id="openVoiceSettingsBtn" class="btn btn-sm btn-outline">
            ⚙️ Open Settings
          </button>
        </div>
      `}
    </div>
  `;
  
  setupVoiceGeneratorListeners();
};

// Setup voice generator listeners
const setupVoiceGeneratorListeners = () => {
  // Template input with live preview
  $('voiceTemplateInput')?.addEventListener('input', (e) => {
    previewResolvedText(e.target.value);
  });
  
  // Placeholder buttons
  $$('.placeholder-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $('voiceTemplateInput');
      if (input) {
        const placeholder = btn.dataset.placeholder;
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const text = input.value;
        input.value = text.slice(0, start) + placeholder + text.slice(end);
        input.focus();
        input.selectionStart = input.selectionEnd = start + placeholder.length;
        previewResolvedText(input.value);
      }
    });
  });
  
  // Generate button
  $('generateVoiceBtn')?.addEventListener('click', () => {
    const text = $('voiceTemplateInput')?.value;
    if (text) {
      generateVoice(text);
    }
  });
  
  // Open settings button
  $('openVoiceSettingsBtn')?.addEventListener('click', () => {
    $('settingsPanel')?.classList.remove('hidden');
    // Scroll to voice settings section
    $('voiceSettingsSection')?.scrollIntoView({ behavior: 'smooth' });
  });
};

// ============================================================
// VOICE LIBRARY TOGGLE
// ============================================================

const setupVoiceLibraryToggle = () => {
  const toggle = $('voiceLibraryToggle');
  const section = toggle?.closest('.voice-library-section');
  const list = $('voiceLibraryList');
  
  toggle?.addEventListener('click', () => {
    section?.classList.toggle('collapsed');
    list?.classList.toggle('hidden');
  });
};

// ============================================================
// INITIALIZATION
// ============================================================

export const initVoice = async () => {
  await loadVoiceSettings();
  renderVoiceSettings();
  renderVoiceGeneratorPanel();
  renderVoiceLibrary();
  setupVoiceLibraryToggle();
};

export default {
  initVoice,
  loadVoiceSettings,
  getVoiceSettings,
  updateVoiceSettings,
  generateVoice,
  resolveTemplatePlaceholders,
  renderVoiceSettings,
  renderVoiceGeneratorPanel,
  renderVoiceLibrary
};
