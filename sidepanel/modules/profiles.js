// ============================================================
// PROFILES MODULE
// ============================================================

import Store from '../state/store.js';
import { $, escapeHtml } from '../utils/dom.js';
import { showNotification } from '../utils/notify.js';
import API from '../utils/api.js';

// Callback for loading scripts when profile changes
let _loadScriptsCallback = null;

// Set callback to load scripts (called from scripts/index.js to avoid circular deps)
export const setScriptsLoadCallback = (callback) => {
  _loadScriptsCallback = callback;
};

let editingProfileId = null;

// Tag data storage
let kinksTags = [];
let boundariesTags = [];

// DOM elements
const el = {
  get profileDropdownBtn() { return $('profileDropdownBtn'); },
  get profileDropdown() { return $('profileDropdown'); },
  get profileList() { return $('profileList'); },
  get currentProfileAvatar() { return $('currentProfileAvatar'); },
  get currentProfileName() { return $('currentProfileName'); },
  get profileModal() { return $('profileModal'); },
  get profileModalTitle() { return $('profileModalTitle'); },
  get profileNameInput() { return $('profileNameInput'); },
  get profileModelNameInput() { return $('profileModelNameInput'); },
  get profileLanguageSelect() { return $('profileLanguageSelect'); },
  get avatarPicker() { return $('avatarPicker'); },
  get profileToneSelect() { return $('profileToneSelect'); },
  // New persona fields
  get profileAgeInput() { return $('profileAgeInput'); },
  get profileCountryInput() { return $('profileCountryInput'); },
  get profileCityInput() { return $('profileCityInput'); },
  get profileMatchLocationCheckbox() { return $('profileMatchLocationCheckbox'); },
  get profileTimezoneSelect() { return $('profileTimezoneSelect'); },
  get profileBodyTypeSelect() { return $('profileBodyTypeSelect'); },
  get profileHairSelect() { return $('profileHairSelect'); },
  get profileEyesSelect() { return $('profileEyesSelect'); },
  get profilePersonalityInput() { return $('profilePersonalityInput'); },
  get profileStyleRulesInput() { return $('profileStyleRulesInput'); },
  get profileWakeUpTime() { return $('profileWakeUpTime'); },
  get profileSleepTime() { return $('profileSleepTime'); },
  get kinksInput() { return $('kinksInput'); },
  get kinksTags() { return $('kinksTags'); },
  get boundariesInput() { return $('boundariesInput'); },
  get boundariesTags() { return $('boundariesTags'); },
  get deleteProfileBtn() { return $('deleteProfileBtn'); }
};

// Load profiles - EAGER LOADING PATTERN
// 1. Load from cache immediately (instant UI)
// 2. Sync from server in background
// 3. Update UI if server data differs
export const loadProfiles = async () => {
  // STEP 1: Load from cache IMMEDIATELY (no waiting)
  const cached = await chrome.storage.local.get(['cachedProfiles', 'currentProfileId']);
  
  if (cached.cachedProfiles?.length > 0) {
    console.log('[Profiles] 🚀 Instant load from cache:', cached.cachedProfiles.length, 'profiles');
    Store.set('profiles', cached.cachedProfiles);
    renderProfileDropdown();
    
    // Auto-select profile from cache
    if (cached.currentProfileId) {
      const profile = cached.cachedProfiles.find(p => p.id === cached.currentProfileId);
      if (profile) {
        selectProfile(profile);
      } else if (cached.cachedProfiles.length > 0) {
        selectProfile(cached.cachedProfiles[0]);
      }
    } else if (cached.cachedProfiles.length > 0) {
      selectProfile(cached.cachedProfiles[0]);
    }
  }
  
  // STEP 2: Sync from server in background (don't block UI)
  syncProfilesFromServer();
};

// Sync profiles from server (background, non-blocking)
const syncProfilesFromServer = async () => {
  try {
    console.log('[Profiles] 🔄 Background sync from server...');
    const response = await API.getProfiles();
    
    if (response && response.success) {
      const serverProfiles = response.profiles || [];
      const cachedProfiles = Store.get('profiles') || [];
      
      // Compare: did anything change?
      const changed = JSON.stringify(serverProfiles) !== JSON.stringify(cachedProfiles);
      
      if (changed || cachedProfiles.length === 0) {
        console.log('[Profiles] ✨ Server has updates, refreshing UI');
        Store.set('profiles', serverProfiles);
        
        // Update cache for next time
        await chrome.storage.local.set({ cachedProfiles: serverProfiles });
        
        renderProfileDropdown();
        
        // Handle profile selection
        if (serverProfiles.length > 0) {
          const currentProfile = Store.get('currentProfile');
          const cached = await chrome.storage.local.get(['currentProfileId']);
          
          // If no profile selected yet, or current profile no longer exists
          if (!currentProfile || !serverProfiles.find(p => p.id === currentProfile.id)) {
            if (cached.currentProfileId) {
              const profile = serverProfiles.find(p => p.id === cached.currentProfileId);
              if (profile) {
                selectProfile(profile);
              } else {
                selectProfile(serverProfiles[0]);
              }
            } else {
              selectProfile(serverProfiles[0]);
            }
          }
        }
      } else {
        console.log('[Profiles] ✅ Cache is up to date');
      }
    } else {
      console.warn('[Profiles] Server response not successful:', response);
      // Don't clear profiles - keep using cache
    }
  } catch (error) {
    console.error('[Profiles] Background sync failed:', error);
    // Don't clear profiles - keep using cache
    // This means profiles will still work even if API is temporarily down
  }
};

// Render profile dropdown
export const renderProfileDropdown = () => {
  const profileList = el.profileList;
  if (!profileList) return;
  
  const profiles = Store.get('profiles');
  const currentProfile = Store.get('currentProfile');
  
  if (profiles.length === 0) {
    profileList.innerHTML = `
      <div class="profile-list-empty" style="padding: 12px; text-align: center; color: var(--text-secondary); font-size: 12px;">
        No profiles yet
      </div>`;
    return;
  }
  
  profileList.innerHTML = profiles.map(profile => `
    <div class="profile-list-item ${currentProfile?.id === profile.id ? 'active' : ''}" data-id="${profile.id}">
      <span class="profile-avatar">${profile.avatar || '👤'}</span>
      <div class="profile-info">
        <div class="profile-item-name">${escapeHtml(profile.name)}</div>
        <div class="profile-item-meta">${profile.chatCount || 0} chats</div>
      </div>
      ${currentProfile?.id === profile.id ? '<span class="profile-check">✓</span>' : ''}
      <button class="edit-profile-btn" data-id="${profile.id}" title="Edit">✏️</button>
    </div>
  `).join('');
  
  profileList.querySelectorAll('.profile-list-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('edit-profile-btn')) {
        e.stopPropagation();
        const profile = profiles.find(p => p.id === e.target.dataset.id);
        if (profile) openProfileModal(profile);
        return;
      }
      
      const profile = profiles.find(p => p.id === item.dataset.id);
      if (profile) {
        selectProfile(profile);
        closeProfileDropdown();
      }
    });
  });
};

// Select a profile
export const selectProfile = (profile) => {
  const previousProfileId = Store.get('currentProfile')?.id;
  
  Store.set('currentProfile', profile);
  Store.set('tone', profile.defaultTone || 'sweet');
  Store.set('persona', profile.persona || '');
  
  if (el.currentProfileAvatar) el.currentProfileAvatar.textContent = profile.avatar || '👤';
  if (el.currentProfileName) el.currentProfileName.textContent = profile.name;
  
  const toneSelect = $('toneSelect');
  const personaInput = $('personaInput');
  if (toneSelect) toneSelect.value = Store.get('tone');
  if (personaInput) personaInput.value = '';  // Clear override field
  
  chrome.storage.local.set({ currentProfileId: profile.id });
  renderProfileDropdown();
  
  // Update persona preview in settings
  updatePersonaPreview(profile);
  
  // Reload scripts for the new profile (if profile changed)
  if (previousProfileId !== profile.id && _loadScriptsCallback) {
    console.log('📋 Profile changed, reloading scripts for:', profile.name);
    _loadScriptsCallback();
  }
};

// Update persona preview in settings panel
export const updatePersonaPreview = (profile) => {
  const previewContent = $('personaPreviewContent');
  if (!previewContent) return;
  
  if (!profile) {
    previewContent.innerHTML = '<p class="persona-preview-text">No profile selected</p>';
    return;
  }
  
  // Build preview text
  const parts = [];
  if (profile.name) parts.push(`<strong>${escapeHtml(profile.name)}</strong>`);
  if (profile.age) parts.push(`${profile.age} years old`);
  if (profile.country) parts.push(`from ${escapeHtml(profile.country)}`);
  
  // Appearance
  const appearance = [];
  if (profile.bodyType) appearance.push(profile.bodyType);
  if (profile.appearance?.hair) appearance.push(`${profile.appearance.hair} hair`);
  if (profile.appearance?.eyes) appearance.push(`${profile.appearance.eyes} eyes`);
  if (appearance.length) parts.push(appearance.join(', '));
  
  if (profile.personality) parts.push(escapeHtml(profile.personality));
  
  let html = '';
  if (parts.length) {
    html += `<p class="persona-preview-text has-content">${parts.join(' • ')}</p>`;
  } else {
    html += `<p class="persona-preview-text">No details set</p>`;
  }
  
  // Add tags
  const tags = [];
  if (profile.kinks?.length) {
    profile.kinks.forEach(k => tags.push(`<span class="persona-tag">${escapeHtml(k)}</span>`));
  }
  if (profile.boundaries?.length) {
    profile.boundaries.forEach(b => tags.push(`<span class="persona-tag boundary">🚫 ${escapeHtml(b)}</span>`));
  }
  
  if (tags.length) {
    html += `<div class="persona-tags">${tags.join('')}</div>`;
  }
  
  previewContent.innerHTML = html;
};

// Edit current profile from settings
export const editCurrentProfile = () => {
  const currentProfile = Store.get('currentProfile');
  if (currentProfile) {
    openProfileModal(currentProfile);
  } else {
    openProfileModal(); // Open new profile modal
  }
};

// Toggle dropdown
export const toggleProfileDropdown = () => {
  const isOpen = !el.profileDropdown?.classList.contains('hidden');
  isOpen ? closeProfileDropdown() : openProfileDropdown();
};

export const openProfileDropdown = () => {
  el.profileDropdown?.classList.remove('hidden');
  el.profileDropdownBtn?.classList.add('open');
};

export const closeProfileDropdown = () => {
  el.profileDropdown?.classList.add('hidden');
  el.profileDropdownBtn?.classList.remove('open');
};

// ============================================
// TAG SYSTEM HELPERS
// ============================================

const renderTags = (containerId, tags, tagType) => {
  const container = $(containerId);
  if (!container) return;
  
  container.innerHTML = tags.map((tag, idx) => `
    <span class="tag-item" data-idx="${idx}" data-type="${tagType}">
      ${escapeHtml(tag)}
      <span class="tag-remove">✕</span>
    </span>
  `).join('');
  
  // Add click listeners to remove tags
  container.querySelectorAll('.tag-item').forEach(tagEl => {
    tagEl.addEventListener('click', () => {
      const idx = parseInt(tagEl.dataset.idx);
      const type = tagEl.dataset.type;
      if (type === 'kinks') {
        kinksTags.splice(idx, 1);
        renderTags('kinksTags', kinksTags, 'kinks');
      } else {
        boundariesTags.splice(idx, 1);
        renderTags('boundariesTags', boundariesTags, 'boundaries');
      }
    });
  });
};

// Add tag directly using module-level arrays
const addTag = (tagType) => {
  const isKinks = tagType === 'kinks';
  const inputId = isKinks ? 'kinksInput' : 'boundariesInput';
  const containerId = isKinks ? 'kinksTags' : 'boundariesTags';
  const tagsArray = isKinks ? kinksTags : boundariesTags;
  
  const input = $(inputId);
  if (!input) return;
  
  const value = input.value.trim();
  if (value && !tagsArray.includes(value)) {
    tagsArray.push(value);
    console.log(`[Profiles] Added tag "${value}" to ${tagType}:`, tagsArray);
    renderTags(containerId, tagsArray, tagType);
    input.value = '';
  }
};

const setupTagInput = (inputId, tagType) => {
  const input = $(inputId);
  if (!input) return;
  
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTag(tagType);
    }
  });
};

// ============================================
// PROFILE MODAL
// ============================================

// Profile Modal
export const openProfileModal = (profile = null) => {
  editingProfileId = profile?.id || null;
  
  if (el.profileModalTitle) {
    el.profileModalTitle.textContent = profile ? 'Edit Profile' : 'New Profile';
  }
  
  // Basic Info
  if (el.profileNameInput) el.profileNameInput.value = profile?.name || '';
  if (el.profileModelNameInput) el.profileModelNameInput.value = profile?.modelName || '';
  if (el.profileLanguageSelect) el.profileLanguageSelect.value = profile?.language || '';
  if (el.profileAgeInput) el.profileAgeInput.value = profile?.age || '';
  if (el.profileCountryInput) el.profileCountryInput.value = profile?.country || '';
  if (el.profileCityInput) el.profileCityInput.value = profile?.city || '';
  if (el.profileMatchLocationCheckbox) el.profileMatchLocationCheckbox.checked = profile?.matchSubscriberLocation || false;
  if (el.profileTimezoneSelect) el.profileTimezoneSelect.value = profile?.timezone || '';
  
  // Avatar
  const selectedAvatar = profile?.avatar || '👤';
  el.avatarPicker?.querySelectorAll('.avatar-option').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.avatar === selectedAvatar);
  });
  
  // Appearance
  if (el.profileBodyTypeSelect) el.profileBodyTypeSelect.value = profile?.bodyType || '';
  if (el.profileHairSelect) el.profileHairSelect.value = profile?.appearance?.hair || '';
  if (el.profileEyesSelect) el.profileEyesSelect.value = profile?.appearance?.eyes || '';
  
  // Personality
  if (el.profileToneSelect) el.profileToneSelect.value = profile?.defaultTone || 'sweet';
  if (el.profilePersonalityInput) el.profilePersonalityInput.value = profile?.personality || '';
  if (el.profileStyleRulesInput) el.profileStyleRulesInput.value = profile?.styleRules || '';
  
  // Schedule times
  if (el.profileWakeUpTime) el.profileWakeUpTime.value = profile?.schedule?.wakeUpTime || '08:00';
  if (el.profileSleepTime) el.profileSleepTime.value = profile?.schedule?.sleepTime || '23:00';
  
  // Tags - reset and populate
  kinksTags = profile?.kinks ? [...profile.kinks] : [];
  boundariesTags = profile?.boundaries ? [...profile.boundaries] : [];
  renderTags('kinksTags', kinksTags, 'kinks');
  renderTags('boundariesTags', boundariesTags, 'boundaries');
  
  // Clear tag inputs
  if (el.kinksInput) el.kinksInput.value = '';
  if (el.boundariesInput) el.boundariesInput.value = '';
  
  if (el.deleteProfileBtn) {
    el.deleteProfileBtn.classList.toggle('hidden', !profile);
  }
  
  el.profileModal?.classList.remove('hidden');
  closeProfileDropdown();
};

export const closeProfileModal = () => {
  el.profileModal?.classList.add('hidden');
  editingProfileId = null;
  // Reset tags
  kinksTags = [];
  boundariesTags = [];
};

const getSelectedAvatar = () => {
  const selected = el.avatarPicker?.querySelector('.avatar-option.selected');
  return selected?.dataset.avatar || '👤';
};

// Build persona string from structured data
const buildPersonaString = (profileData) => {
  const parts = [];
  
  if (profileData.name) parts.push(`Name: ${profileData.name}`);
  if (profileData.age) parts.push(`Age: ${profileData.age}`);
  if (profileData.country) parts.push(`From: ${profileData.country}`);
  
  // Appearance
  const appearance = [];
  if (profileData.bodyType) appearance.push(profileData.bodyType);
  if (profileData.appearance?.hair) appearance.push(`${profileData.appearance.hair} hair`);
  if (profileData.appearance?.eyes) appearance.push(`${profileData.appearance.eyes} eyes`);
  if (appearance.length) parts.push(`Appearance: ${appearance.join(', ')}`);
  
  if (profileData.personality) parts.push(`Personality: ${profileData.personality}`);
  if (profileData.styleRules) parts.push(`Style: ${profileData.styleRules}`);
  if (profileData.kinks?.length) parts.push(`Interests: ${profileData.kinks.join(', ')}`);
  if (profileData.boundaries?.length) parts.push(`Boundaries: ${profileData.boundaries.join(', ')}`);
  
  return parts.join('. ');
};

// Save profile
export const saveProfile = async () => {
  const name = el.profileNameInput?.value.trim();
  if (!name) {
    showNotification('Please enter a profile name');
    return;
  }
  
  // Debug: log tags before building profileData
  console.log('[Profiles] Saving - kinksTags:', kinksTags);
  console.log('[Profiles] Saving - boundariesTags:', boundariesTags);
  
  const profileData = {
    name,
    modelName: el.profileModelNameInput?.value.trim() || '',
    language: el.profileLanguageSelect?.value || '',
    avatar: getSelectedAvatar(),
    defaultTone: el.profileToneSelect?.value || 'sweet',
    // Basic Info
    age: el.profileAgeInput?.value ? parseInt(el.profileAgeInput.value) : null,
    country: el.profileCountryInput?.value.trim() || '',
    city: el.profileCityInput?.value.trim() || '',
    matchSubscriberLocation: el.profileMatchLocationCheckbox?.checked || false,
    timezone: el.profileTimezoneSelect?.value || '',
    // Appearance
    bodyType: el.profileBodyTypeSelect?.value || '',
    appearance: {
      hair: el.profileHairSelect?.value || '',
      eyes: el.profileEyesSelect?.value || ''
    },
    // Personality
    personality: el.profilePersonalityInput?.value.trim() || '',
    styleRules: el.profileStyleRulesInput?.value.trim() || '',
    // Tags - ensure arrays are copied properly
    kinks: kinksTags.length > 0 ? [...kinksTags] : [],
    boundaries: boundariesTags.length > 0 ? [...boundariesTags] : [],
    // Schedule
    schedule: {
      wakeUpTime: el.profileWakeUpTime?.value || '08:00',
      sleepTime: el.profileSleepTime?.value || '23:00'
    }
  };
  
  console.log('[Profiles] Sending profileData:', profileData);
  
  // Build compiled persona string for AI
  profileData.persona = buildPersonaString(profileData);
  
  try {
    let response;
    if (editingProfileId) {
      response = await API.updateProfile({ profileId: editingProfileId, ...profileData });
    } else {
      response = await API.createProfile(profileData);
    }
    
    if (response.success) {
      showNotification(response.message || 'Profile saved!');
      closeProfileModal();
      
      // Update cache immediately so next reload is instant
      await loadProfiles();
      
      // Ensure cache is updated
      const profiles = Store.get('profiles') || [];
      await chrome.storage.local.set({ cachedProfiles: profiles });
      
      if (response.profile) selectProfile(response.profile);
    } else {
      showNotification(response.error || 'Failed to save profile');
    }
  } catch (error) {
    console.error('Save profile error:', error);
    showNotification('Failed to save profile');
  }
};

// Delete profile
export const deleteProfile = async () => {
  if (!editingProfileId) return;
  if (!confirm('Delete this profile and all its chats?')) return;
  
  try {
    const response = await API.deleteProfile({ profileId: editingProfileId });
    
    if (response.success) {
      showNotification('Profile deleted');
      closeProfileModal();
      
      if (Store.get('currentProfile')?.id === editingProfileId) {
        Store.set('currentProfile', null);
        if (el.currentProfileAvatar) el.currentProfileAvatar.textContent = '👤';
        if (el.currentProfileName) el.currentProfileName.textContent = 'Select Profile';
      }
      
      await loadProfiles();
    } else {
      showNotification(response.error || 'Failed to delete profile');
    }
  } catch (error) {
    console.error('Delete profile error:', error);
    showNotification('Failed to delete profile');
  }
};

// Setup event listeners
export const setupProfileListeners = () => {
  el.profileDropdownBtn?.addEventListener('click', toggleProfileDropdown);
  $('addProfileBtn')?.addEventListener('click', () => openProfileModal());
  $('saveProfileBtn')?.addEventListener('click', saveProfile);
  $('deleteProfileBtn')?.addEventListener('click', deleteProfile);
  $('cancelProfileBtn')?.addEventListener('click', closeProfileModal);
  $('closeProfileModalBtn')?.addEventListener('click', closeProfileModal);
  
  // Avatar picker
  el.avatarPicker?.querySelectorAll('.avatar-option').forEach(btn => {
    btn.addEventListener('click', () => {
      el.avatarPicker.querySelectorAll('.avatar-option').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });
  
  // Tag inputs setup - use only tagType, functions reference module-level arrays
  setupTagInput('kinksInput', 'kinks');
  setupTagInput('boundariesInput', 'boundaries');
  
  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!el.profileDropdownBtn?.contains(e.target) && !el.profileDropdown?.contains(e.target)) {
      closeProfileDropdown();
    }
  });
};

export default { loadProfiles, selectProfile, setupProfileListeners };
