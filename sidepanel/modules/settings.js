// ============================================================
// SETTINGS MODULE
// ============================================================

import Store from '../state/store.js';
import { $ } from '../utils/dom.js';
import { showNotification } from '../utils/notify.js';

// Automation states
let autoGenerateEnabled = false;
let autoNotesEnabled = false;
let typingSpeedPercent = 100; // 100% = normal speed

// Auto-Chat settings with defaults
let autoChatSettings = {
  cooldownMinutes: 10,        // Minutes before moving to cooldown
  responseDelayMin: 30,       // Min seconds before responding
  responseDelayMax: 180,      // Max seconds before responding
  maxActiveChats: 5,          // Max concurrent chats
  autoOpenChats: true,        // Auto-open chats from queue
  prioritizeNewest: true      // Newest unreads first
};

// Get auto-chat settings
export const getAutoChatSettings = () => autoChatSettings;

// ============================================================
// SITUATIONAL REACTIONS SYSTEM
// ============================================================

// Default situational presets
const DEFAULT_SITUATIONAL_PRESETS = {
  botAccusation: {
    id: 'botAccusation',
    name: 'Accused of being a bot',
    enabled: true,
    triggers: ['are you a bot', 'you a bot', 'youre a bot', "you're a bot", 'ur a bot', 'u a bot', 'this is a bot', 'is this a bot', 'bot?', 'are you real', 'you real?', 'are you ai', 'you ai?', 'chatgpt', 'gpt', 'talking to a bot', 'automated', 'not real', 'fake account', 'are you human'],
    response: "haha no im real, just sometimes i type weird cause im on my phone lol",
    trackAccusations: true // Special flag to track repeated accusations
  },
  receivedImage: {
    id: 'receivedImage',
    name: 'Received photo from them',
    enabled: true,
    // Triggers for when THEY SEND you a photo (various platforms)
    // NOTE: Stickers are intentionally excluded - they should be ignored
    triggers: ['[photo]', '[image]', '[picture]', '[media]', '📷', '🖼️', '[видео]', '[фото]', '[Photo]', '[Image]', 'photo attached', 'image attached', '[ Photo ]', '[ Image ]', '[📷 Photo]', '[📷 Image]', '[🎥 Video]', '📷 Photo', '📷 Image', '🎥 Video'],
    response: "omg thats so hot",
    continueScript: false // ALWAYS use this response, don't pass to AI
  },
  askImages: {
    id: 'askImages',
    name: 'Asked for pics/nudes',
    enabled: true,
    // Triggers for when THEY ASK you to send them photos - comprehensive list
    triggers: [
      // Direct requests
      'send me a', 'send me pic', 'send me photo', 'send me image', 'send me nudes', 'send nudes',
      'send a pic', 'send a photo', 'send pics', 'send photos', 'send something', 'send me something sexy',
      // Show me variants
      'show me your', 'show me you', 'show me naked', 'show me more', 'show me something',
      'show yourself', 'show me one', 'show me', 'show ur',
      // Can I see variants - EXPANDED
      'can i see your', 'can i see you', 'can i see', 'can u show', 'could i see',
      'see your pic', 'see your photo', 'see you', 'see your',
      // Want to see variants  
      'wanna see you', 'want to see you', 'want to see', 'i want to see', 'wanna see',
      'let me see you', 'let me see', 'lemme see',
      // "Your pic" style - NEW
      'your pic', 'ur pic', 'a pic', 'one pic', 'your photo', 'your picture',
      // Please variants - NEW
      'pic please', 'photo please', 'please send', 'please show',
      // Question style - EXPANDED
      'pics?', 'nudes?', 'photo?', 'picture?', 'naked?', 'a pic?',
      // Body parts (usually in context of asking to see)
      'ur boobs', 'your boobs', 'your tits', 'your ass', 'your pussy', 'your body',
      'some boobs', 'some tits', 'see boobs', 'see tits', 'see ass',
      // Naked/nude variants
      'naked', 'nude', 'undressed', 'without clothes', 'topless', 'bottomless',
      // Other common asks
      'more pics', 'another pic', 'more photos', 'another photo',
      'something hot', 'something sexy', 'something naughty', 'something spicy',
      // What do you look like - NEW
      'what do you look like', 'what you look like', 'how do you look'
    ],
    response: "mmm you want to see? 😏",
    sendImage: true, // NEW: Actually send an image from the pool
    continueScript: false
  },
  askVideoCall: {
    id: 'askVideoCall',
    name: 'Asked for video call',
    enabled: true,
    // REMOVED "call me" - too ambiguous (matches "call me X" = nickname)
    // REMOVED "can we call" - let AI handle, too prone to false positives
    triggers: ['video call', 'videocall', 'facetime', 'zoom', 'wanna call', 'lets call', 'voice call', 'phone call', 'skype', 'discord call', 'wanna video', 'video chat'],
    response: "unfortunately we have just very slow internet currently... calls keep dropping 😭"
  },
  askMeet: {
    id: 'askMeet',
    name: 'Asked to meet IRL',
    enabled: true,
    triggers: ['meet up', 'meet you', 'meet irl', 'in person', 'real life', 'where do you live', 'can we meet', 'lets meet', 'hookup', 'hook up'],
    response: "i dont meet with new subs babe... maybe in the future if we get closer 💕"
  },
  askPhone: {
    id: 'askPhone',
    name: 'Asked for phone number',
    enabled: true,
    triggers: ['phone number', 'your number', 'give me your number', 'whats your number', 'text me', 'whatsapp', 'snapchat', 'your phone', 'ur number', 'digits'],
    response: "i dont give out my number babe... but im always here for u"
  },
  askFree: {
    id: 'askFree',
    name: 'Asked for free content',
    enabled: true,
    triggers: ['free', 'for free', 'send free', 'free pic', 'free video', 'free content', 'dont have money', 'no money'],
    response: "i put so much work into my content babe... but ill make it worth it for u 😘"
  },
  askSocial: {
    id: 'askSocial',
    name: 'Asked for social media',
    enabled: true,
    triggers: ['instagram', 'insta', 'twitter', 'tiktok', 'social media', 'socials', 'your ig', 'your twitter'],
    response: "i keep my socials private babe... this is where we can really connect"
  },
  priceComplaint: {
    id: 'priceComplaint',
    name: 'Complains about prices',
    enabled: true,
    triggers: ['too expensive', 'so expensive', 'thats a lot', 'too much', 'cant afford', 'cheaper', 'discount'],
    response: "i promise its worth it babe... noone else makes content like this"
  },
  reEngage: {
    id: 'reEngage',
    name: 'Re-engage (they went silent)',
    enabled: false, // Manual trigger only by default
    triggers: [],
    response: "hey stranger... been thinking about u 😏"
  }
};

// Current situational settings (loaded from storage)
let situationalSettings = { ...DEFAULT_SITUATIONAL_PRESETS };

// Get all situational presets
export const getSituationalPresets = () => situationalSettings;

// AI-powered situational classification (AI ONLY - no keyword fallback)
export const checkSituationalTriggerWithAI = async (message) => {
  if (!message) return null;
  
  try {
    // Get list of enabled presets
    const enabledPresets = Object.entries(situationalSettings)
      .filter(([key, preset]) => preset.enabled)
      .map(([key]) => key);
    
    if (enabledPresets.length === 0) return null;
    
    console.log('[Situational AI] Checking message:', message.slice(0, 50) + '...');
    
    // Use chrome runtime messaging to call the API
    const response = await chrome.runtime.sendMessage({
      type: 'CLASSIFY_SITUATIONAL',
      data: {
        message,
        enabledPresets
      }
    });
    
    // If we get a successful response from AI, use that result
    if (response?.success) {
      // Lower threshold to 0.5 for more sensitive detection
      if (response.match && response.confidence >= 0.5) {
        const preset = situationalSettings[response.match];
        if (preset) {
          console.log(`[Situational AI] 🎯 Matched: "${preset.name}" (confidence: ${response.confidence})`);
          return preset;
        }
      }
      console.log(`[Situational AI] ❌ Low confidence (${response.confidence || 0}), no match`);
      return null;
    }
    
    console.log('[Situational AI] ⚠️ API call failed, no match');
    return null;
  } catch (error) {
    console.error('[Situational AI] Error:', error);
    console.log('[Situational AI] Exception occurred, no match');
    return null;
  }
};

// Original keyword-based check (kept as fallback)
export const checkSituationalTrigger = (message) => {
  if (!message) return null;
  
  const msgLower = message.toLowerCase();
  
  // Special check for askImages first (it's most important for image sending)
  const askImages = situationalSettings['askImages'];
  if (askImages) {
    console.log(`[Situational] askImages enabled: ${askImages.enabled}`);
    if (askImages.enabled && askImages.triggers?.length) {
      const matched = askImages.triggers.find(trigger => msgLower.includes(trigger.toLowerCase()));
      if (matched) {
        console.log(`[Situational] 📸 askImages MATCHED on trigger: "${matched}"`);
        return askImages;
      }
    }
  }
  
  for (const [key, preset] of Object.entries(situationalSettings)) {
    if (key === 'askImages') continue; // Already checked
    if (!preset.enabled || !preset.triggers?.length) continue;
    
    // Check if any trigger matches
    const triggered = preset.triggers.some(trigger => msgLower.includes(trigger.toLowerCase()));
    
    if (triggered) {
      console.log(`[Situational] Triggered: "${preset.name}" for message: "${message.slice(0, 50)}..."`);
      return preset;
    }
  }
  
  console.log('[Situational] No keyword match found');
  return null;
};

// Update a situational preset
export const updateSituationalPreset = (presetId, updates) => {
  if (!situationalSettings[presetId]) return false;
  
  situationalSettings[presetId] = {
    ...situationalSettings[presetId],
    ...updates
  };
  
  // Save to storage
  chrome.storage.local.set({ situationalSettings });
  return true;
};

// Load situational settings from storage
const loadSituationalSettings = () => {
  return new Promise(resolve => {
    chrome.storage.local.get(['situationalSettings'], (result) => {
      if (result.situationalSettings) {
        // Smart merge: use defaults for triggers/flags, but keep user's custom responses
        situationalSettings = {};
        for (const [key, defaultPreset] of Object.entries(DEFAULT_SITUATIONAL_PRESETS)) {
          const storedPreset = result.situationalSettings[key];
          if (storedPreset) {
            // Keep user's custom response, but use default triggers & flags
            situationalSettings[key] = {
              ...defaultPreset,                   // Start with defaults (triggers, flags)
              response: storedPreset.response || defaultPreset.response, // Keep custom response
              enabled: storedPreset.enabled !== undefined ? storedPreset.enabled : defaultPreset.enabled
            };
          } else {
            situationalSettings[key] = { ...defaultPreset };
          }
        }
      } else {
        situationalSettings = { ...DEFAULT_SITUATIONAL_PRESETS };
      }
      resolve();
    });
  });
};

// Check if auto-generate is enabled
export const isAutoGenerateEnabled = () => autoGenerateEnabled;

// Check if auto-notes is enabled
export const isAutoNotesEnabled = () => autoNotesEnabled;

// Update and save auto-chat settings
export const updateAutoChatSettings = (updates) => {
  autoChatSettings = { ...autoChatSettings, ...updates };
  chrome.storage.local.set({ autoChatSettings });
  
  // Also notify background of config change
  chrome.runtime.sendMessage({
    type: 'AUTOCHAT_UPDATE_CONFIG',
    data: autoChatSettings
  }).catch(() => {});
  
  return autoChatSettings;
};

// Load settings from storage
export const loadSettings = async () => {
  // Load situational settings first
  await loadSituationalSettings();
  
  return new Promise(resolve => {
    chrome.storage.local.get([
      'apiKey', 
      'persona', 
      'defaultTone',
      'autoGenerateEnabled',
      'autoNotesEnabled',
      'autoChatSettings',
      'typingSpeedPercent'
    ], (result) => {
      // Load auto-chat settings
      if (result.autoChatSettings) {
        autoChatSettings = { ...autoChatSettings, ...result.autoChatSettings };
      }
      
      if (result.apiKey) {
        Store.set('apiKey', result.apiKey);
        const apiKeyInput = $('apiKeyInput');
        if (apiKeyInput) apiKeyInput.value = result.apiKey;
      }
      
      if (result.persona) {
        Store.set('persona', result.persona);
        const personaInput = $('personaInput');
        if (personaInput) personaInput.value = result.persona;
      }
      
      if (result.defaultTone) {
        Store.set('tone', result.defaultTone);
        const toneSelect = $('toneSelect');
        if (toneSelect) toneSelect.value = result.defaultTone;
      }
      
      // Load automation toggles
      autoGenerateEnabled = result.autoGenerateEnabled ?? false;
      autoNotesEnabled = result.autoNotesEnabled ?? false;
      
      const autoGenerateToggle = $('autoGenerateToggle');
      const autoNotesToggle = $('autoNotesToggle');
      
      if (autoGenerateToggle) autoGenerateToggle.checked = autoGenerateEnabled;
      if (autoNotesToggle) autoNotesToggle.checked = autoNotesEnabled;
      
      // Load typing speed
      typingSpeedPercent = result.typingSpeedPercent ?? 100;
      const typingSpeedSlider = $('typingSpeedSlider');
      const typingSpeedValue = $('typingSpeedValue');
      if (typingSpeedSlider) typingSpeedSlider.value = typingSpeedPercent;
      if (typingSpeedValue) typingSpeedValue.textContent = typingSpeedPercent;
      
      resolve();
    });
  });
};

// Save settings
export const saveSettings = () => {
  const apiKeyInput = $('apiKeyInput');
  const personaInput = $('personaInput');
  
  const apiKey = apiKeyInput?.value.trim() || '';
  const persona = personaInput?.value.trim() || '';
  
  Store.set('apiKey', apiKey);
  Store.set('persona', persona);
  
  chrome.storage.local.set({ apiKey, persona }, () => {
    const settingsPanel = $('settingsPanel');
    if (settingsPanel) settingsPanel.classList.add('hidden');
    showNotification('Settings saved!');
  });
};

// Render situational reactions UI
const renderSituationalPresets = () => {
  const container = $('situationalList');
  if (!container) return;
  
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
      updateSituationalPreset(presetId, { enabled });
      
      // Update UI
      const item = container.querySelector(`.situational-item[data-preset="${presetId}"]`);
      if (item) item.classList.toggle('disabled', !enabled);
      
      showNotification(`${enabled ? '✅' : '❌'} ${situationalSettings[presetId].name} ${enabled ? 'enabled' : 'disabled'}`);
    });
  });
  
  // Add event listeners for response text (auto-save on change)
  container.querySelectorAll('textarea.situational-response').forEach(textarea => {
    let saveTimeout;
    textarea.addEventListener('input', (e) => {
      const presetId = e.target.dataset.preset;
      const response = e.target.value;
      
      // Show saving indicator
      const item = textarea.closest('.situational-item');
      if (item) item.classList.add('saving');
      
      // Debounce save
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        updateSituationalPreset(presetId, { response });
        console.log(`[Settings] Auto-saved response for: ${presetId}`);
        
        // Show saved indicator briefly
        if (item) {
          item.classList.remove('saving');
          item.classList.add('saved');
          setTimeout(() => item.classList.remove('saved'), 1000);
        }
      }, 500);
    });
  });
};

// Setup event listeners
export const setupSettingsListeners = () => {
  const settingsBtn = $('settingsBtn');
  const settingsPanel = $('settingsPanel');
  const closeSettingsBtn = $('closeSettingsBtn');
  const saveSettingsBtn = $('saveSettingsBtn');
  const toneSelect = $('toneSelect');
  const subscriberName = $('subscriberName');
  
  settingsBtn?.addEventListener('click', () => {
    settingsPanel?.classList.toggle('hidden');
    // Render situational presets when opening settings
    if (!settingsPanel?.classList.contains('hidden')) {
      renderSituationalPresets();
    }
  });
  
  closeSettingsBtn?.addEventListener('click', () => {
    settingsPanel?.classList.add('hidden');
  });
  
  saveSettingsBtn?.addEventListener('click', saveSettings);
  
  toneSelect?.addEventListener('change', (e) => {
    Store.set('tone', e.target.value);
    chrome.storage.local.set({ defaultTone: e.target.value });
  });
  
  subscriberName?.addEventListener('input', (e) => {
    Store.set('subscriberName', e.target.value);
  });
  
  // Auto-generate toggle
  $('autoGenerateToggle')?.addEventListener('change', (e) => {
    autoGenerateEnabled = e.target.checked;
    chrome.storage.local.set({ autoGenerateEnabled: e.target.checked });
    showNotification(e.target.checked ? 'Auto-generate enabled' : 'Auto-generate disabled');
  });
  
  // Auto-notes toggle
  $('autoNotesToggle')?.addEventListener('change', (e) => {
    autoNotesEnabled = e.target.checked;
    chrome.storage.local.set({ autoNotesEnabled: e.target.checked });
    showNotification(e.target.checked ? 'Auto-notes enabled' : 'Auto-notes disabled');
  });
  
  // Typing speed slider
  const typingSpeedSlider = $('typingSpeedSlider');
  const typingSpeedValue = $('typingSpeedValue');
  typingSpeedSlider?.addEventListener('input', (e) => {
    const speed = parseInt(e.target.value, 10);
    typingSpeedPercent = speed;
    if (typingSpeedValue) typingSpeedValue.textContent = speed;
    // Save immediately (no debounce needed for slider)
    chrome.storage.local.set({ typingSpeedPercent: speed });
    console.log(`[Settings] Typing speed set to ${speed}%`);
  });
  
  // Logout button
  $('logoutBtn')?.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to logout?')) return;
    
    try {
      console.log('[Settings] Logging out...');
      await FirebaseAuth.signOut();
      showNotification('👋 Logged out successfully');
      // Reload the page to show login screen
      setTimeout(() => location.reload(), 500);
    } catch (error) {
      console.error('[Settings] Logout error:', error);
      showNotification('❌ Logout failed: ' + error.message);
    }
  });
};

export default { 
  loadSettings, 
  saveSettings, 
  setupSettingsListeners,
  isAutoGenerateEnabled,
  isAutoNotesEnabled
};
