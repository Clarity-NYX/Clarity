// ============================================================
// NOTES MODULE - Database-backed with smart auto-scan
// ============================================================

import Store from '../state/store.js';
import { $, hide, show } from '../utils/dom.js';
import { showNotification, showError } from '../utils/notify.js';
import API from '../utils/api.js';
import { isAutoNotesEnabled } from './settings.js';

// DOM elements
const el = {
  get noteName() { return $('noteName'); },
  get noteAge() { return $('noteAge'); },
  get noteLocation() { return $('noteLocation'); },
  get noteJob() { return $('noteJob'); },
  get noteHobbies() { return $('noteHobbies'); },
  get noteKinks() { return $('noteKinks'); },
  get noteOther() { return $('noteOther'); },
  get extractingState() { return $('extractingState'); }
};

// ============================================================
// CACHING LAYER - Reduce Firebase reads
// ============================================================

const notesCache = {
  data: new Map(), // subscriberId -> { notes, timestamp }
  ttl: 3600000,    // 1 hour cache TTL
  
  // Get cached notes
  get(subscriberId) {
    const cached = this.data.get(subscriberId);
    if (!cached) return null;
    
    // Check if expired
    if (Date.now() - cached.timestamp > this.ttl) {
      this.data.delete(subscriberId);
      return null;
    }
    
    console.log('[Notes] Using cached data for:', subscriberId);
    return cached.notes;
  },
  
  // Set cached notes
  set(subscriberId, notes) {
    this.data.set(subscriberId, {
      notes,
      timestamp: Date.now()
    });
  },
  
  // Clear cache for a subscriber
  clear(subscriberId) {
    this.data.delete(subscriberId);
  },
  
  // Clear all cache
  clearAll() {
    this.data.clear();
  }
};

// Get current subscriber ID
const getCurrentSubscriberId = () => {
  const subscriberId = Store.get('currentSubscriberId') || Store.get('subscriberName') || null;
  console.log('[Notes] getCurrentSubscriberId:', subscriberId);
  return subscriberId;
};

// Get current profile ID
const getCurrentProfileId = () => {
  const profile = Store.get('currentProfile');
  return profile?.id || null;
};

// Display notes in UI
const displayNotes = (notes) => {
  if (!notes) return;
  
  el.noteName && (el.noteName.value = notes.name || '');
  el.noteAge && (el.noteAge.value = notes.age || '');
  el.noteLocation && (el.noteLocation.value = notes.location || '');
  el.noteJob && (el.noteJob.value = notes.job || '');
  el.noteHobbies && (el.noteHobbies.value = notes.hobbies || '');
  el.noteKinks && (el.noteKinks.value = notes.kinks || '');
  el.noteOther && (el.noteOther.value = notes.other || '');
};

// Get notes from UI
const getNotesFromUI = () => {
  return {
    name: el.noteName?.value || '',
    age: el.noteAge?.value || '',
    location: el.noteLocation?.value || '',
    job: el.noteJob?.value || '',
    hobbies: el.noteHobbies?.value || '',
    kinks: el.noteKinks?.value || '',
    other: el.noteOther?.value || ''
  };
};

// Check if current platform is Telegram
const isTelegramPlatform = () => {
  return Store.get('currentPlatform') === 'telegram';
};

// Load notes from database with caching
// Platform-aware: Telegram uses local storage, OnlyFans uses Firebase
export const loadNotesFromDB = async () => {
  const profileId = getCurrentProfileId();
  const subscriberId = getCurrentSubscriberId();
  
  if (!profileId || !subscriberId) {
    // Fall back to local storage
    loadNotesLocal();
    return null;
  }
  
  // Check cache first
  const cachedNotes = notesCache.get(subscriberId);
  if (cachedNotes) {
    displayNotes(cachedNotes);
    Store.set('currentNotes', cachedNotes);
    return cachedNotes;
  }
  
  // TELEGRAM: Always load from storedChat (which was loaded from local storage)
  if (isTelegramPlatform()) {
    const storedChat = Store.get('storedChat') || {};
    const notes = storedChat.notes || {};
    console.log('[Notes] 📂 Telegram: Loading notes from local storage');
    
    if (Object.keys(notes).length > 0) {
      notesCache.set(subscriberId, notes);
      displayNotes(notes);
      Store.set('currentNotes', notes);
      return notes;
    }
    
    // No notes yet, return empty
    loadNotesLocal();
    return null;
  }
  
  // ONLYFANS: Load from Firebase API
  try {
    const response = await API.getChatNotes({ profileId, subscriberId });
    
    if (response.success && response.notes) {
      // Cache the notes
      notesCache.set(subscriberId, response.notes);
      
      displayNotes(response.notes);
      Store.set('currentNotes', response.notes);
      return response.notes;
    }
  } catch (error) {
    console.error('Failed to load notes from DB:', error);
  }
  
  // Fall back to local storage
  loadNotesLocal();
  return null;
};

// Load notes from local storage (fallback)
const loadNotesLocal = () => {
  const subscriberId = getCurrentSubscriberId();
  if (!subscriberId) return;
  
  const storageKey = `notes_${subscriberId}`;
  
  chrome.storage.local.get([storageKey], (result) => {
    const notes = result[storageKey] || {};
    displayNotes(notes);
    Store.set('currentNotes', notes);
  });
};

// Legacy function for compatibility
export const loadNotes = () => {
  loadNotesFromDB();
};

// Save notes to database
// Platform-aware: Telegram uses local storage, OnlyFans uses Firebase
export const saveNotesToDB = async (notes = null) => {
  const profileId = getCurrentProfileId();
  const subscriberId = getCurrentSubscriberId();
  const notesToSave = notes || getNotesFromUI();
  
  if (!profileId || !subscriberId) {
    saveNotesLocal(notesToSave);
    return;
  }
  
  // TELEGRAM: Save to local storage via storedChat (will be persisted in chatStorage)
  if (isTelegramPlatform()) {
    console.log('[Notes] 💾 Telegram: Saving notes to local storage');
    
    // Update storedChat with new notes
    const storedChat = Store.get('storedChat') || {};
    storedChat.notes = notesToSave;
    Store.set('storedChat', storedChat);
    Store.set('currentNotes', notesToSave);
    
    // Cache the notes
    notesCache.set(subscriberId, notesToSave);
    
    // Trigger a chat save to persist to local storage
    // Import dynamically to avoid circular deps
    try {
      const { saveFullChatReplacement } = await import('./chat/chatStorage.js');
      const messages = Store.get('messages') || [];
      if (messages.length > 0) {
        saveFullChatReplacement(messages, true); // Force immediate save
      }
    } catch (e) {
      console.error('[Notes] Failed to save via chatStorage:', e);
    }
    
    if (!notes) showNotification('Notes saved!');
    return true;
  }
  
  // ONLYFANS: Save to Firebase API
  try {
    const response = await API.saveChatNotes({
      profileId,
      subscriberId,
      notes: notesToSave
    });
    
    if (response.success) {
      Store.set('currentNotes', notesToSave);
      // Update cache so next load returns fresh data
      notesCache.set(subscriberId, notesToSave);
      if (!notes) showNotification('Notes saved!');
      return true;
    }
  } catch (error) {
    console.error('Failed to save notes to DB:', error);
    saveNotesLocal(notesToSave);
  }
  
  return false;
};

// Save notes to local storage (fallback)
const saveNotesLocal = (notes = null) => {
  const subscriberId = getCurrentSubscriberId();
  if (!subscriberId) return;
  
  const storageKey = `notes_${subscriberId}`;
  const notesToSave = notes || getNotesFromUI();
  notesToSave.updatedAt = Date.now();
  
  chrome.storage.local.set({ [storageKey]: notesToSave }, () => {
    Store.set('currentNotes', notesToSave);
    if (!notes) showNotification('Notes saved locally!');
  });
};

// Save notes (auto-detect destination)
export const saveNotes = () => {
  saveNotesToDB();
};

// Clear notes
export const clearNotes = () => {
  const emptyNotes = {
    name: '', age: '', location: '', job: '',
    hobbies: '', kinks: '', other: ''
  };
  displayNotes(emptyNotes);
  // Also save the cleared notes and update cache
  const subscriberId = getCurrentSubscriberId();
  if (subscriberId) {
    notesCache.clear(subscriberId);
  }
  Store.set('currentNotes', emptyNotes);
  saveNotesToDB(emptyNotes);
  showNotification('Notes cleared');
};

// Smart merge: Only fill empty fields with new data
const smartMerge = (existing, extracted) => {
  const merged = { ...existing };
  
  for (const key of Object.keys(extracted)) {
    const newValue = extracted[key];
    const existingValue = existing[key];
    
    // Only update if:
    // 1. New value exists and isn't empty
    // 2. Existing value is empty or doesn't exist
    if (newValue && newValue.trim() && (!existingValue || !existingValue.trim())) {
      merged[key] = newValue.trim();
    }
  }
  
  return merged;
};

// Extract subscriber info using AI (smart version)
export const extractSubscriberInfo = async (autoMode = false) => {
  const messages = Store.get('messages');
  
  if (!messages || messages.length < 3) {
    if (!autoMode) {
      showError('Need more conversation to analyze.');
    }
    return null;
  }
  
  // Show auto-scan status
  const autoScanStatus = $('autoScanStatus');
  if (autoMode && autoScanStatus) {
    autoScanStatus.classList.remove('hidden');
  }
  
  if (!autoMode) {
    show(el.extractingState);
  }
  
  try {
    const currentNotes = Store.get('currentNotes') || {};
    const lastScannedAt = currentNotes.lastScannedAtCount || 0;
    
    // Manual scan: ALWAYS analyze entire chat for comprehensive extraction
    // Auto scan: Only scan new messages for efficiency
    const messagesToScan = autoMode && lastScannedAt > 0 
      ? messages.slice(lastScannedAt)
      : messages; // Full chat for manual OR first auto-scan
    
    console.log(`📝 Scanning ${messagesToScan.length} messages (${autoMode ? 'auto' : 'manual'} - ${messagesToScan.length === messages.length ? 'full chat' : 'incremental'})`);
    
    const response = await API.extractInfo({ messages: messagesToScan });
    
    // Hide loading states
    if (!autoMode) {
      hide(el.extractingState);
    }
    if (autoMode && autoScanStatus) {
      autoScanStatus.classList.add('hidden');
    }
    
    if (response.success && response.info) {
      const extracted = response.info;
      const existingNotes = Store.get('currentNotes') || {};
      
      // Smart merge - don't overwrite existing data
      const mergedNotes = smartMerge(existingNotes, extracted);
      
      // Track when we scanned (message count at time of scan)
      mergedNotes.lastScannedAtCount = messages.length;
      mergedNotes.lastScannedAt = new Date().toISOString();
      mergedNotes.lastScannedTimestamp = Date.now();
      
      // Display merged notes
      displayNotes(mergedNotes);
      
      // Update chat summary UI
      updateChatSummaryUI(mergedNotes);
      
      // Auto-save to database
      await saveNotesToDB(mergedNotes);
      
      // Cache the notes
      notesCache.set(Store.get('currentSubscriberId'), mergedNotes);
      
      if (!autoMode) {
        showNotification('Info extracted and saved!');
      }
      
      return mergedNotes;
    } else {
      if (!autoMode) {
        showError(response.error || 'No info found');
      }
    }
  } catch (error) {
    if (!autoMode) {
      hide(el.extractingState);
      showError('Failed to analyze conversation');
    }
    if (autoMode && autoScanStatus) {
      autoScanStatus.classList.add('hidden');
    }
    console.error('Extract error:', error);
  }
  
  return null;
};

// Check if we should auto-scan based on message count
const shouldAutoScan = () => {
  const currentNotes = Store.get('currentNotes') || {};
  const messages = Store.get('messages') || [];
  const messageCount = messages.length;
  
  // Need at least 5 messages
  if (messageCount < 5) {
    return false;
  }
  
  // First time scan - never scanned before
  const lastScannedAt = currentNotes.lastScannedAtCount || 0;
  if (lastScannedAt === 0) {
    console.log('📝 First time scan - never scanned this chat');
    return true;
  }
  
  // Re-scan if 10+ new messages since last scan (reduced from 50)
  const newMessages = messageCount - lastScannedAt;
  if (newMessages >= 10) {
    console.log(`📝 Re-scan triggered: ${newMessages} new messages since last scan`);
    return true;
  }
  
  // Time-based scan - every 5 minutes if there are new messages
  const lastScannedTime = currentNotes.lastScannedTimestamp || 0;
  const timeSinceLastScan = Date.now() - lastScannedTime;
  if (timeSinceLastScan > 5 * 60 * 1000 && newMessages >= 3) {
    console.log(`📝 Re-scan triggered: ${Math.round(timeSinceLastScan / 60000)} minutes since last scan`);
    return true;
  }
  
  console.log(`📝 No scan needed: only ${newMessages} new messages (need 10+)`);
  return false;
};

// Auto-scan on chat load (if enabled AND script is complete)
export const autoScanIfEnabled = async () => {
  if (!isAutoNotesEnabled()) {
    return;
  }
  
  // Check if script is complete (only scan notes when script is 100% done)
  // This prevents wasting credits during active scripts
  try {
    const currentScript = Store.get('currentScript');
    if (currentScript?.stages) {
      // Dynamically import to avoid circular dependencies
      const { getSubscriberScriptStats } = await import('./scripts/index.js');
      const stats = getSubscriberScriptStats();
      
      // Only scan if script is 100% complete OR no progress yet (0/0)
      const isScriptComplete = stats.total > 0 && stats.completed >= stats.total;
      const noScriptStarted = stats.total === 0 || stats.completed === 0;
      
      if (!isScriptComplete && !noScriptStarted) {
        console.log(`📝 Auto-scan SKIPPED: Script in progress (${stats.completed}/${stats.total})`);
        return;
      }
      
      if (isScriptComplete) {
        console.log(`📝 Script complete (${stats.completed}/${stats.total}) - auto-scan allowed`);
      }
    }
  } catch (scriptCheckError) {
    console.log('[Notes] Script check error (non-fatal):', scriptCheckError.message);
    // Continue with auto-scan on error (fail-safe)
  }
  
  if (!shouldAutoScan()) {
    return;
  }
  
  console.log('📝 Auto-scanning notes...');
  await extractSubscriberInfo(true); // autoMode = true (silent)
};

// Update chat summary UI
const updateChatSummaryUI = (notes) => {
  const messages = Store.get('messages') || [];
  const messageCount = messages.length;
  
  // Update message count
  const totalMessagesCount = $('totalMessagesCount');
  if (totalMessagesCount) {
    totalMessagesCount.textContent = messageCount;
  }
  
  // Update last scan time
  const lastScanTime = $('lastScanTime');
  if (lastScanTime && notes.lastScannedAt) {
    const scanDate = new Date(notes.lastScannedAt);
    const now = new Date();
    const diffMs = now - scanDate;
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) {
      lastScanTime.textContent = 'Just now';
    } else if (diffMins < 60) {
      lastScanTime.textContent = `${diffMins}m ago`;
    } else if (diffMins < 1440) {
      lastScanTime.textContent = `${Math.floor(diffMins / 60)}h ago`;
    } else {
      lastScanTime.textContent = `${Math.floor(diffMins / 1440)}d ago`;
    }
  } else if (lastScanTime) {
    lastScanTime.textContent = 'Never';
  }
  
  // Update auto-scan status
  const autoScanEnabled = $('autoScanEnabled');
  if (autoScanEnabled) {
    autoScanEnabled.textContent = isAutoNotesEnabled() ? 'On' : 'Off';
    autoScanEnabled.style.color = isAutoNotesEnabled() ? 'var(--success)' : 'var(--text-secondary)';
  }
  
  // Update conversation highlights if we have extracted data
  const conversationHighlights = $('conversationHighlights');
  const highlightsList = $('highlightsList');
  
  if (conversationHighlights && highlightsList) {
    const highlights = [];
    
    // Add key insights based on extracted data
    if (notes.name) highlights.push(`Name: ${notes.name}`);
    if (notes.age) highlights.push(`Age: ${notes.age}`);
    if (notes.location) highlights.push(`From: ${notes.location}`);
    if (notes.job) highlights.push(`Works: ${notes.job}`);
    if (notes.kinks) {
      const kinksList = notes.kinks.split(',').slice(0, 3).map(k => k.trim()).join(', ');
      highlights.push(`Interests: ${kinksList}`);
    }
    
    if (highlights.length > 0) {
      conversationHighlights.classList.remove('hidden');
      highlightsList.innerHTML = highlights
        .map(h => `<li>${h}</li>`)
        .join('');
    } else {
      conversationHighlights.classList.add('hidden');
    }
  }
};

// Called when chat is loaded
export const onChatLoaded = async () => {
  // First load existing notes
  const notes = await loadNotesFromDB();
  
  // Update chat summary UI
  if (notes) {
    updateChatSummaryUI(notes);
  }
  
  // Then auto-scan if enabled AND needed (first time or 50+ new messages)
  setTimeout(() => {
    autoScanIfEnabled();
  }, 500); // Small delay to not overload
};

// Setup event listeners
export const setupNotesListeners = () => {
  $('extractInfoBtn')?.addEventListener('click', () => extractSubscriberInfo(false));
  $('saveNotesBtn')?.addEventListener('click', saveNotes);
  $('clearNotesBtn')?.addEventListener('click', clearNotes);
};

export default { 
  loadNotes, 
  loadNotesFromDB,
  saveNotes, 
  clearNotes, 
  extractSubscriberInfo,
  autoScanIfEnabled,
  onChatLoaded,
  setupNotesListeners
};
