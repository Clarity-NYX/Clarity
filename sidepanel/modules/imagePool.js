// Media Pool Module
// Manages a pool of images AND videos for auto-responses (Telegram & OnlyFans)
// Media files are stored in Firebase Storage (via signed URLs)
// Metadata synced to Firestore for cross-device access; localStorage as fast cache

import { storeImage as uploadToStorage, deleteImage as deleteFromStorage } from './scripts/imageStorage.js';
import { apiRequest } from '../utils/api.js';

const STORAGE_KEY = 'clarity_image_pool';
const VAULTS_KEY = 'clarity_vaults';
const SENT_IMAGES_KEY = 'clarity_sent_images'; // Track sent media per subscriber
let imagePool = [];
let vaults = []; // [{ id, name, createdAt }]
let pendingMediaData = null;
let pendingMediaType = 'image'; // 'image' or 'video'
let sentImagesMap = {}; // { subscriberId: [mediaId1, mediaId2, ...] }
let _poolLoaded = false;
let _vaultsLoaded = false;
let _cloudSynced = false; // Whether we've pulled from server this session

// ============================================================
// CLOUD SYNC — Debounced push to Firestore via server API
// ============================================================

let _poolSyncTimer = null;
let _vaultsSyncTimer = null;
let _sentSyncTimer = null;
const SYNC_DEBOUNCE_MS = 2000; // 2s debounce for server saves

// ============================================================
// LIVE POLLING — Detect remote changes every 30s
// ============================================================
let _pollInterval = null;
const POLL_INTERVAL_MS = 30000; // 30s between version checks
let _lastKnownVersions = { pool: 0, vaults: 0, sent: 0 };
let _isSyncing = false; // Prevent overlapping syncs

function schedulePoolSync() {
  clearTimeout(_poolSyncTimer);
  _poolSyncTimer = setTimeout(() => pushPoolToServer(), SYNC_DEBOUNCE_MS);
}

function scheduleVaultsSync() {
  clearTimeout(_vaultsSyncTimer);
  _vaultsSyncTimer = setTimeout(() => pushVaultsToServer(), SYNC_DEBOUNCE_MS);
}

function scheduleSentSync() {
  clearTimeout(_sentSyncTimer);
  _sentSyncTimer = setTimeout(() => pushSentToServer(), SYNC_DEBOUNCE_MS);
}

async function pushPoolToServer() {
  try {
    await apiRequest('/storage/vault/pool', {
      method: 'PUT',
      body: JSON.stringify({ items: imagePool })
    });
    console.log('[ImagePool] ☁️ Pool synced to server:', imagePool.length, 'items');
  } catch (err) {
    console.warn('[ImagePool] ⚠️ Pool server sync failed (will retry):', err.message);
  }
}

async function pushVaultsToServer() {
  try {
    await apiRequest('/storage/vault/vaults', {
      method: 'PUT',
      body: JSON.stringify({ vaults })
    });
    console.log('[ImagePool] ☁️ Vaults synced to server:', vaults.length, 'vaults');
  } catch (err) {
    console.warn('[ImagePool] ⚠️ Vaults server sync failed:', err.message);
  }
}

async function pushSentToServer() {
  try {
    await apiRequest('/storage/vault/sent', {
      method: 'PUT',
      body: JSON.stringify({ map: sentImagesMap })
    });
    console.log('[ImagePool] ☁️ Sent map synced to server:', Object.keys(sentImagesMap).length, 'subscribers');
  } catch (err) {
    console.warn('[ImagePool] ⚠️ Sent map server sync failed:', err.message);
  }
}

// Refresh download URLs for pool items with storagePath (signed URLs expire after 4h)
async function refreshDownloadURLs() {
  const itemsNeedingRefresh = imagePool.filter(item => item.storagePath);
  if (itemsNeedingRefresh.length === 0) return;

  console.log(`[ImagePool] 🔄 Refreshing ${itemsNeedingRefresh.length} download URLs...`);

  try {
    // Batch refresh via server (max 200 per call)
    const BATCH_LIMIT = 200;
    for (let i = 0; i < itemsNeedingRefresh.length; i += BATCH_LIMIT) {
      const batch = itemsNeedingRefresh.slice(i, i + BATCH_LIMIT);
      const payload = batch.map(item => ({ id: item.id, storagePath: item.storagePath }));

      const result = await apiRequest('/storage/vault/refresh-urls', {
        method: 'POST',
        body: JSON.stringify({ items: payload })
      });

      if (result.success && Array.isArray(result.items)) {
        // Apply fresh URLs to pool items
        for (const refreshed of result.items) {
          if (refreshed.downloadURL) {
            const poolItem = imagePool.find(p => p.id === refreshed.id);
            if (poolItem) {
              poolItem.downloadURL = refreshed.downloadURL;
            }
          }
        }
      }
    }

    // Save refreshed URLs to localStorage (no need to push back to server —
    // server stores storagePath, URLs are generated fresh each time)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(imagePool));
    } catch (_) {}

    console.log(`[ImagePool] ✅ Download URLs refreshed for ${itemsNeedingRefresh.length} items`);
  } catch (err) {
    console.warn('[ImagePool] ⚠️ URL refresh failed (images may not display):', err.message);
  }
}

// Check server for remote changes — called every POLL_INTERVAL_MS
async function pollForChanges() {
  if (_isSyncing || !_cloudSynced) return; // Don't poll until initial sync is done

  // Skip when tab is hidden (saves bandwidth)
  if (document.hidden) return;

  try {
    const data = await apiRequest('/storage/vault/version');
    if (!data.success) return;

    const serverVersions = {
      pool: data.poolUpdatedAt || 0,
      vaults: data.vaultsUpdatedAt || 0,
      sent: data.sentUpdatedAt || 0
    };

    // Check if any collection has been updated remotely
    const poolChanged = serverVersions.pool > _lastKnownVersions.pool;
    const vaultsChanged = serverVersions.vaults > _lastKnownVersions.vaults;
    const sentChanged = serverVersions.sent > _lastKnownVersions.sent;

    if (!poolChanged && !vaultsChanged && !sentChanged) return; // No changes

    console.log(`[ImagePool] 🔔 Remote changes detected:`,
      poolChanged ? 'pool' : '', vaultsChanged ? 'vaults' : '', sentChanged ? 'sent' : '');

    _isSyncing = true;

    // Fetch fresh data from server
    const fullData = await apiRequest('/storage/vault');
    if (!fullData.success) { _isSyncing = false; return; }

    let needsRender = false;

    // Update pool if changed
    if (poolChanged && Array.isArray(fullData.pool)) {
      imagePool = fullData.pool;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(imagePool)); } catch (_) {}
      needsRender = true;
    }

    // Update vaults if changed
    if (vaultsChanged && Array.isArray(fullData.vaults)) {
      vaults = fullData.vaults;
      if (!vaults.find(v => v.id === 'default')) {
        vaults.unshift({ id: 'default', name: 'General', createdAt: 0 });
      }
      try { localStorage.setItem(VAULTS_KEY, JSON.stringify(vaults)); } catch (_) {}
      needsRender = true;
    }

    // Update sent map if changed
    if (sentChanged && fullData.sent && typeof fullData.sent === 'object') {
      sentImagesMap = fullData.sent;
      try { localStorage.setItem(SENT_IMAGES_KEY, JSON.stringify(sentImagesMap)); } catch (_) {}
    }

    // Update version tracking
    _lastKnownVersions = serverVersions;

    // Refresh download URLs for new/updated pool items
    if (poolChanged && imagePool.length > 0) {
      await refreshDownloadURLs();
    }

    if (needsRender) {
      renderPool();
      console.log(`[ImagePool] 🔄 Live sync: UI updated with remote changes`);
    }
  } catch (err) {
    // Silent fail — polling errors are not critical
    console.debug('[ImagePool] Poll check failed:', err.message);
  } finally {
    _isSyncing = false;
  }
}

// Start live polling for cross-device changes
function startPolling() {
  stopPolling(); // Clear any existing interval
  _pollInterval = setInterval(pollForChanges, POLL_INTERVAL_MS);
  console.log(`[ImagePool] 📡 Live polling started (every ${POLL_INTERVAL_MS / 1000}s)`);

  // Also poll when tab becomes visible again (user returns to extension)
  document.addEventListener('visibilitychange', _onVisibilityChange);
}

function stopPolling() {
  if (_pollInterval) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
  document.removeEventListener('visibilitychange', _onVisibilityChange);
}

function _onVisibilityChange() {
  if (!document.hidden && _cloudSynced) {
    // Tab became visible — poll immediately for any changes missed while hidden
    pollForChanges();
  }
}

// Pull all vault data from server — called once on init
async function syncFromServer() {
  if (_cloudSynced) return;
  try {
    const data = await apiRequest('/storage/vault');
    if (!data.success) return;

    const serverPool = Array.isArray(data.pool) ? data.pool : [];
    const serverVaults = Array.isArray(data.vaults) ? data.vaults : [];
    const serverSent = (data.sent && typeof data.sent === 'object') ? data.sent : {};

    // Merge strategy: Server wins for pool & vaults (authoritative source)
    // but merge in any local-only items not yet synced
    if (serverPool.length > 0 || imagePool.length === 0) {
      // Merge: keep server items, add any local items with IDs not in server
      const serverIds = new Set(serverPool.map(i => i.id));
      const localOnly = imagePool.filter(i => !serverIds.has(i.id));
      imagePool = [...serverPool, ...localOnly];
      savePool();
      if (localOnly.length > 0) {
        console.log(`[ImagePool] 🔄 Merged ${localOnly.length} local-only items into server pool`);
        schedulePoolSync(); // Push merged result back
      }
    }

    if (serverVaults.length > 0 || vaults.length <= 1) {
      // Merge vaults similarly
      const serverVaultIds = new Set(serverVaults.map(v => v.id));
      const localOnlyVaults = vaults.filter(v => v.id !== 'default' && !serverVaultIds.has(v.id));
      vaults = [...serverVaults, ...localOnlyVaults];
      // Ensure default exists
      if (!vaults.find(v => v.id === 'default')) {
        vaults.unshift({ id: 'default', name: 'General', createdAt: 0 });
      }
      saveVaults();
      if (localOnlyVaults.length > 0) {
        scheduleVaultsSync();
      }
    }

    if (Object.keys(serverSent).length > 0 || Object.keys(sentImagesMap).length === 0) {
      // Merge sent maps: union of both
      for (const [subId, ids] of Object.entries(serverSent)) {
        if (!sentImagesMap[subId]) {
          sentImagesMap[subId] = ids;
        } else {
          const merged = new Set([...sentImagesMap[subId], ...ids]);
          sentImagesMap[subId] = [...merged];
        }
      }
      saveSentImagesMap();
    }

    _cloudSynced = true;

    // Capture version timestamps for polling change detection
    // Fetch version info to seed the polling baseline
    try {
      const versionData = await apiRequest('/storage/vault/version');
      if (versionData.success) {
        _lastKnownVersions = {
          pool: versionData.poolUpdatedAt || 0,
          vaults: versionData.vaultsUpdatedAt || 0,
          sent: versionData.sentUpdatedAt || 0
        };
      }
    } catch (_) {} // Non-critical

    console.log(`[ImagePool] ☁️ Cloud sync complete: ${imagePool.length} items, ${vaults.length} vaults, ${Object.keys(sentImagesMap).length} subscriber tracks`);

    // Refresh download URLs — signed URLs expire after 4h,
    // so items synced from server need fresh URLs on this device
    if (imagePool.length > 0) {
      await refreshDownloadURLs();
    }

    // Start live polling for cross-device changes
    startPolling();
  } catch (err) {
    console.warn('[ImagePool] ⚠️ Cloud sync failed (using local cache):', err.message);
  }
}

// Supported media types
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const SUPPORTED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/mov'];
const MAX_VIDEO_SIZE_MB = 50; // Max 50MB for videos

// Initialize
export function init() {
  loadPool();
  loadVaults();
  loadSentImagesMap();
  setupEventListeners();
  renderPool();
  console.log('[ImagePool] Initialized with', imagePool.length, 'images,', vaults.length, 'vaults');

  // Pull from server (async, non-blocking) — merges cloud data with local cache
  syncFromServer().then(() => {
    renderPool(); // Re-render with merged data
  }).catch(() => {}); // Errors already logged inside syncFromServer
}

// Load pool from localStorage
function loadPool() {
  if (_poolLoaded) return;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      imagePool = JSON.parse(stored);
    }
  } catch (e) {
    console.error('[ImagePool] Error loading pool:', e);
    imagePool = [];
  }
  _poolLoaded = true;
}

// Ensure pool is loaded before any operation
function ensureLoaded() {
  if (!_poolLoaded) loadPool();
  if (!_vaultsLoaded) loadVaults();
}

// Load sent images tracking from localStorage
function loadSentImagesMap() {
  try {
    const stored = localStorage.getItem(SENT_IMAGES_KEY);
    if (stored) {
      sentImagesMap = JSON.parse(stored);
      // PERFORMANCE: Prune on load to prevent unbounded growth
      pruneSentImagesMap();
    }
  } catch (e) {
    console.error('[ImagePool] Error loading sent images map:', e);
    sentImagesMap = {};
  }
}

// PERFORMANCE: Prune sentImagesMap to prevent unbounded localStorage growth
// Keeps only the most recent entries per subscriber
function pruneSentImagesMap(maxPerSubscriber = 200, maxSubscribers = 500) {
  let pruned = false;
  
  // Cap entries per subscriber
  for (const [subId, sentIds] of Object.entries(sentImagesMap)) {
    if (sentIds.length > maxPerSubscriber) {
      sentImagesMap[subId] = sentIds.slice(-maxPerSubscriber);
      pruned = true;
    }
  }
  
  // Remove empty subscriber entries
  for (const subId of Object.keys(sentImagesMap)) {
    if (!sentImagesMap[subId] || sentImagesMap[subId].length === 0) {
      delete sentImagesMap[subId];
      pruned = true;
    }
  }
  
  // Cap total subscribers (keep most recent by key insertion order)
  const subscriberIds = Object.keys(sentImagesMap);
  if (subscriberIds.length > maxSubscribers) {
    const toRemove = subscriberIds.slice(0, subscriberIds.length - maxSubscribers);
    for (const subId of toRemove) {
      delete sentImagesMap[subId];
    }
    pruned = true;
  }
  
  if (pruned) {
    console.log(`[ImagePool] Pruned sentImagesMap: ${Object.keys(sentImagesMap).length} subscribers`);
  }
}

// Save sent images tracking to localStorage + schedule cloud sync
function saveSentImagesMap() {
  try {
    localStorage.setItem(SENT_IMAGES_KEY, JSON.stringify(sentImagesMap));
    scheduleSentSync();
  } catch (e) {
    console.error('[ImagePool] Error saving sent images map:', e);
  }
}

// Save pool to localStorage + schedule cloud sync
function savePool() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(imagePool));
    updateStats();
    schedulePoolSync();
  } catch (e) {
    console.error('[ImagePool] Error saving pool:', e);
    throw e; // Re-throw so callers can detect save failures (e.g. QuotaExceededError)
  }
}

// Setup event listeners
function setupEventListeners() {
  // Toggle section
  const toggle = document.getElementById('imagePoolToggle');
  const section = document.getElementById('imagePoolSection');
  const body = document.getElementById('imagePoolBody');
  
  if (toggle && section && body) {
    toggle.addEventListener('click', () => {
      section.classList.toggle('collapsed');
      body.classList.toggle('hidden');
    });
  }
  
  // Dropzone
  const dropzone = document.getElementById('imageAddDropzone');
  const fileInput = document.getElementById('imagePoolUpload'); // Use correct ID from HTML
  
  if (dropzone && fileInput) {
    dropzone.addEventListener('click', () => fileInput.click());
    
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
    
    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('drag-over');
    });
    
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) {
        handleMediaFile(file);
      }
    });
    
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        handleMediaFile(file);
      }
      e.target.value = ''; // Reset
    });
  }
  
  // Save button
  const saveBtn = document.getElementById('saveNewImageBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', saveNewImage);
  }
  
  // Cancel button
  const cancelBtn = document.getElementById('cancelNewImageBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', cancelNewImage);
  }
  
  // Filter & Search
  const categoryFilter = document.getElementById('imagePoolCategoryFilter');
  const searchInput = document.getElementById('imagePoolSearchInput');
  
  if (categoryFilter) {
    categoryFilter.addEventListener('change', renderPool);
  }
  
  if (searchInput) {
    searchInput.addEventListener('input', renderPool);
  }
}

// Handle media file selection (image or video)
function handleMediaFile(file) {
  if (!file) return;
  
  const isImage = SUPPORTED_IMAGE_TYPES.includes(file.type) || file.type.startsWith('image/');
  const isVideo = SUPPORTED_VIDEO_TYPES.includes(file.type) || file.type.startsWith('video/');
  
  if (!isImage && !isVideo) {
    alert('Unsupported file type. Please use images (JPG, PNG, GIF, WebP) or videos (MP4, WebM).');
    return;
  }
  
  // Check video size
  if (isVideo && file.size > MAX_VIDEO_SIZE_MB * 1024 * 1024) {
    alert(`Video file is too large. Maximum size is ${MAX_VIDEO_SIZE_MB}MB.`);
    return;
  }
  
  pendingMediaType = isVideo ? 'video' : 'image';
  
  const reader = new FileReader();
  reader.onload = (e) => {
    pendingMediaData = e.target.result;
    showAddForm(pendingMediaData, pendingMediaType);
  };
  reader.readAsDataURL(file);
}

// Show add media form
function showAddForm(mediaData, mediaType = 'image') {
  const form = document.getElementById('imageAddForm');
  const previewImg = document.getElementById('newImagePreview');
  let previewVideo = document.getElementById('newVideoPreview');
  const dropzone = document.getElementById('imageAddDropzone');
  
  if (form) {
    form.classList.remove('hidden');
    
    // Handle video preview
    if (mediaType === 'video') {
      // Create video preview if it doesn't exist
      if (!previewVideo && previewImg) {
        previewVideo = document.createElement('video');
        previewVideo.id = 'newVideoPreview';
        previewVideo.className = 'media-preview-video';
        previewVideo.controls = true;
        previewVideo.muted = true;
        previewVideo.style.maxWidth = '100%';
        previewVideo.style.maxHeight = '200px';
        previewVideo.style.borderRadius = '8px';
        previewImg.parentNode.insertBefore(previewVideo, previewImg);
      }
      
      if (previewVideo) {
        previewVideo.src = mediaData;
        previewVideo.style.display = 'block';
      }
      if (previewImg) previewImg.style.display = 'none';
    } else {
      // Image preview
      if (previewImg) {
        previewImg.src = mediaData;
        previewImg.style.display = 'block';
      }
      if (previewVideo) previewVideo.style.display = 'none';
    }
    
    if (dropzone) dropzone.style.display = 'none';
  }
  
  // Clear form fields
  const nameInput = document.getElementById('newImageName');
  const descInput = document.getElementById('newImageDescription');
  const tagsInput = document.getElementById('newImageTags');
  
  if (nameInput) nameInput.value = '';
  if (descInput) descInput.value = '';
  if (tagsInput) tagsInput.value = '';
}

// Hide add media form
function hideAddForm() {
  const form = document.getElementById('imageAddForm');
  const dropzone = document.getElementById('imageAddDropzone');
  const previewImg = document.getElementById('newImagePreview');
  const previewVideo = document.getElementById('newVideoPreview');
  
  if (form) form.classList.add('hidden');
  if (dropzone) dropzone.style.display = '';
  if (previewImg) previewImg.style.display = '';
  if (previewVideo) {
    previewVideo.src = '';
    previewVideo.style.display = 'none';
  }
  
  pendingMediaData = null;
  pendingMediaType = 'image';
}

// Save new media to pool (uploads to Firebase Storage)
async function saveNewImage() {
  if (!pendingMediaData) return;
  
  const nameInput = document.getElementById('newImageName');
  const descInput = document.getElementById('newImageDescription');
  const categorySelect = document.getElementById('newImageCategory');
  const tagsInput = document.getElementById('newImageTags');
  
  const defaultName = pendingMediaType === 'video' ? `Video ${imagePool.length + 1}` : `Image ${imagePool.length + 1}`;
  const name = nameInput?.value?.trim() || defaultName;
  const description = descInput?.value?.trim() || '';
  const category = categorySelect?.value || 'other';
  const tagsStr = tagsInput?.value?.trim() || '';
  const tags = tagsStr ? tagsStr.split(',').map(t => t.trim().toLowerCase()).filter(t => t) : [];
  
  // Disable save button while uploading
  const saveBtn = document.getElementById('saveNewImageBtn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '⏳ Uploading...'; }
  
  const mediaData = pendingMediaData;
  const mediaType = pendingMediaType;
  
  try {
    // Upload to Firebase Storage
    const storageResult = await uploadToStorage(mediaData, {
      scriptId: 'vault',
      mediaType
    });
    
    const newMedia = {
      id: storageResult.id || `${mediaType === 'video' ? 'vid' : 'img'}_${Date.now()}`,
      name,
      description,
      category,
      tags,
      mediaType,
      downloadURL: storageResult.downloadURL,
      storagePath: storageResult.storagePath,
      createdAt: Date.now(),
      usageCount: 0,
      lastUsed: null
    };
    
    imagePool.push(newMedia);
    savePool();
    renderPool();
    hideAddForm();
    
    console.log(`[MediaPool] ☁️ Added ${mediaType} to Firebase Storage:`, name);
  } catch (err) {
    console.error('[MediaPool] Upload failed:', err);
    alert('Failed to upload media. Please try again.');
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Save'; }
  }
}

// Cancel adding new image
function cancelNewImage() {
  hideAddForm();
}

// Add image/video to pool programmatically (used by vault)
// Uploads to Firebase Storage, stores only metadata + downloadURL in localStorage
export async function addImage(mediaData, mediaType = 'image', name = '', vaultId = 'default') {
  ensureLoaded();
  const defaultName = mediaType === 'video' ? `Video ${imagePool.length + 1}` : `Image ${imagePool.length + 1}`;
  
  // Upload to Firebase Storage
  const storageResult = await uploadToStorage(mediaData, {
    scriptId: 'vault',
    mediaType
  });
  
  const newMedia = {
    id: storageResult.id || `${mediaType === 'video' ? 'vid' : 'img'}_${Date.now()}`,
    name: name || defaultName,
    description: '',
    category: 'other',
    tags: [],
    mediaType,
    downloadURL: storageResult.downloadURL,
    storagePath: storageResult.storagePath,
    vaultId: vaultId || 'default',
    createdAt: Date.now(),
    usageCount: 0,
    lastUsed: null
  };
  
  imagePool.push(newMedia);
  
  try {
    savePool();
  } catch (e) {
    // Revert on save failure
    imagePool.pop();
    throw e;
  }
  
  console.log(`[ImagePool] ☁️ Added ${mediaType}: ${newMedia.name} (Firebase Storage)`);
  return newMedia;
}

// Delete image from pool (and from Firebase Storage if stored there)
export async function deleteImage(imageId) {
  ensureLoaded();
  const item = imagePool.find(img => img.id === imageId);
  
  // Delete from Firebase Storage if it has a storagePath
  if (item?.storagePath) {
    deleteFromStorage(item.storagePath).catch(err => {
      console.warn('[ImagePool] Failed to delete from Storage (continuing):', err);
    });
  }
  
  imagePool = imagePool.filter(img => img.id !== imageId);
  savePool();
  renderPool();
}

// Render the image pool grid
function renderPool() {
  const container = document.getElementById('imagePoolList');
  const countBadge = document.getElementById('imagePoolCount');
  
  if (!container) return;
  
  // Get filter values
  const categoryFilter = document.getElementById('imagePoolCategoryFilter')?.value || '';
  const searchQuery = document.getElementById('imagePoolSearchInput')?.value?.toLowerCase() || '';
  
  // Filter images
  let filtered = imagePool;
  
  if (categoryFilter) {
    filtered = filtered.filter(img => img.category === categoryFilter);
  }
  
  if (searchQuery) {
    filtered = filtered.filter(img => 
      img.name.toLowerCase().includes(searchQuery) ||
      img.description.toLowerCase().includes(searchQuery) ||
      img.tags.some(t => t.includes(searchQuery))
    );
  }
  
  // Update count badge
  if (countBadge) {
    countBadge.textContent = imagePool.length;
  }
  
  // Render
  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="image-pool-empty">
        <span class="empty-icon">📷</span>
        <p>${imagePool.length === 0 ? 'No images yet' : 'No matching images'}</p>
        <small>${imagePool.length === 0 ? 'Add images to respond to "send pic" requests' : 'Try a different filter'}</small>
      </div>
    `;
    return;
  }
  
  container.innerHTML = filtered.map(img => {
    const isVideo = img.mediaType === 'video';
    return `
    <div class="image-pool-item ${isVideo ? 'video-item' : ''}" data-id="${img.id}" title="${img.description}">
      ${isVideo ? `
        <video src="${img.imageData || img.downloadURL}" muted preload="metadata"></video>
        <div class="video-play-icon">▶</div>
      ` : `
        <img src="${img.imageData || img.downloadURL}" alt="${img.name}">
      `}
      <div class="image-pool-item-overlay">
        <div class="image-pool-item-name">${isVideo ? '🎬 ' : ''}${img.name}</div>
        <div class="image-pool-item-category">${getCategoryLabel(img.category)}</div>
      </div>
      <div class="image-pool-item-actions">
        <button class="image-pool-item-btn delete-btn" data-id="${img.id}" title="Delete">🗑️</button>
      </div>
    </div>
    `;
  }).join('');
  
  // Add click handlers for delete
  container.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (confirm('Delete this image?')) {
        deleteImage(id);
      }
    });
  });
  
  // Add click handlers for editing image details
  container.querySelectorAll('.image-pool-item').forEach(item => {
    item.addEventListener('click', (e) => {
      // Don't trigger if clicking on delete button
      if (e.target.closest('.delete-btn')) return;
      
      const id = item.dataset.id;
      const image = imagePool.find(img => img.id === id);
      if (image) {
        showEditModal(image);
      }
    });
  });
}

// Show edit modal for an image
function showEditModal(image) {
  // Create or get edit modal
  let modal = document.getElementById('imageEditModal');
  
  if (!modal) {
    // Create the modal HTML
    const modalHTML = `
      <div id="imageEditModal" class="modal">
        <div class="modal-backdrop"></div>
        <div class="modal-content image-edit-modal">
          <div class="modal-header">
            <h3>✏️ Edit Image</h3>
            <button class="modal-close" id="closeImageEditModal">&times;</button>
          </div>
          <div class="modal-body">
            <div class="edit-image-preview">
              <img id="editImagePreview" src="" alt="Preview">
              <video id="editVideoPreview" controls muted style="display:none; max-width:100%; max-height:200px; border-radius:8px;"></video>
            </div>
            <div class="form-group">
              <label>Name</label>
              <input type="text" id="editImageName" class="form-control" placeholder="Image name">
            </div>
            <div class="form-group">
              <label>Description (helps AI select this image)</label>
              <textarea id="editImageDescription" class="form-control" rows="3" placeholder="Describe this image..."></textarea>
            </div>
            <div class="form-group">
              <label>Category</label>
              <select id="editImageCategory" class="form-control">
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
              <label>Tags (comma separated, helps AI match requests)</label>
              <input type="text" id="editImageTags" class="form-control" placeholder="hot, sexy, bedroom, etc.">
            </div>
            <div class="image-edit-stats">
              <span>📊 Sent <strong id="editImageUsage">0</strong> times</span>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="cancelImageEditBtn">Cancel</button>
            <button class="btn btn-primary" id="saveImageEditBtn">💾 Save Changes</button>
          </div>
        </div>
      </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHTML);
    modal = document.getElementById('imageEditModal');
    
    // Add event listeners
    document.getElementById('closeImageEditModal').addEventListener('click', hideEditModal);
    document.getElementById('cancelImageEditBtn').addEventListener('click', hideEditModal);
    modal.querySelector('.modal-backdrop').addEventListener('click', hideEditModal);
  }
  
  // Populate the form — toggle between image/video preview
  const editImgEl = document.getElementById('editImagePreview');
  const editVidEl = document.getElementById('editVideoPreview');
  const mediaSrc = image.imageData || image.downloadURL || '';
  
  if (image.mediaType === 'video') {
    if (editImgEl) editImgEl.style.display = 'none';
    if (editVidEl) { editVidEl.src = mediaSrc; editVidEl.style.display = 'block'; }
    // Update modal title
    const titleEl = modal.querySelector('.modal-header h3');
    if (titleEl) titleEl.textContent = '✏️ Edit Video';
  } else {
    if (editImgEl) { editImgEl.src = mediaSrc; editImgEl.style.display = 'block'; }
    if (editVidEl) { editVidEl.src = ''; editVidEl.style.display = 'none'; }
    const titleEl = modal.querySelector('.modal-header h3');
    if (titleEl) titleEl.textContent = '✏️ Edit Image';
  }
  
  document.getElementById('editImageName').value = image.name || '';
  document.getElementById('editImageDescription').value = image.description || '';
  document.getElementById('editImageCategory').value = image.category || 'other';
  document.getElementById('editImageTags').value = (image.tags || []).join(', ');
  document.getElementById('editImageUsage').textContent = image.usageCount || 0;
  
  // Set up save handler
  const saveBtn = document.getElementById('saveImageEditBtn');
  // Remove old handler and add new one
  const newSaveBtn = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
  newSaveBtn.addEventListener('click', () => saveImageEdit(image.id));
  
  // Show modal
  modal.classList.add('active');
}

// Hide edit modal
function hideEditModal() {
  const modal = document.getElementById('imageEditModal');
  if (modal) {
    modal.classList.remove('active');
  }
}

// Save image edits
function saveImageEdit(imageId) {
  const image = imagePool.find(img => img.id === imageId);
  if (!image) return;
  
  // Update image data
  image.name = document.getElementById('editImageName').value.trim() || image.name;
  image.description = document.getElementById('editImageDescription').value.trim() || '';
  image.category = document.getElementById('editImageCategory').value || 'other';
  
  const tagsStr = document.getElementById('editImageTags').value.trim();
  image.tags = tagsStr ? tagsStr.split(',').map(t => t.trim().toLowerCase()).filter(t => t) : [];
  
  // Save and re-render
  savePool();
  renderPool();
  hideEditModal();
  
  console.log('[ImagePool] ✏️ Updated image:', image.name);
}

// Update stats display
function updateStats() {
  const statsEl = document.getElementById('imagePoolStats');
  if (statsEl) {
    const totalUsed = imagePool.reduce((sum, img) => sum + img.usageCount, 0);
    statsEl.textContent = `${imagePool.length} images • ${totalUsed} sent`;
  }
}

// Get category label
function getCategoryLabel(category) {
  const labels = {
    'selfie': '📸 Selfie',
    'full_body': '🧍 Full Body',
    'activity': '🎯 Activity',
    'location': '📍 Location',
    'outfit': '👗 Outfit',
    'mood': '😊 Mood',
    'other': '📁 Other'
  };
  return labels[category] || category;
}

// ============================================================
// VAULT MANAGEMENT - Named collections for organizing media
// ============================================================

function loadVaults() {
  if (_vaultsLoaded) return;
  try {
    const stored = localStorage.getItem(VAULTS_KEY);
    if (stored) vaults = JSON.parse(stored);
  } catch (_) { vaults = []; }
  // Ensure default vault exists
  if (!vaults.find(v => v.id === 'default')) {
    vaults.unshift({ id: 'default', name: 'General', createdAt: 0 });
    saveVaults();
  }
  _vaultsLoaded = true;
}

function saveVaults() {
  try { localStorage.setItem(VAULTS_KEY, JSON.stringify(vaults)); scheduleVaultsSync(); } catch (_) {}
}

export function getVaults() { ensureLoaded(); return [...vaults]; }

export function createVault(name) {
  ensureLoaded();
  const id = `vault_${Date.now()}`;
  const v = { id, name: name.trim() || 'Untitled', createdAt: Date.now() };
  vaults.push(v);
  saveVaults();
  return v;
}

export function renameVault(vaultId, newName) {
  ensureLoaded();
  if (vaultId === 'default') return;
  const v = vaults.find(x => x.id === vaultId);
  if (v) { v.name = newName.trim() || v.name; saveVaults(); }
}

export function deleteVault(vaultId) {
  ensureLoaded();
  if (vaultId === 'default') return;
  // Move orphaned media to default
  imagePool.forEach(img => { if (img.vaultId === vaultId) img.vaultId = 'default'; });
  savePool();
  vaults = vaults.filter(v => v.id !== vaultId);
  saveVaults();
}

export function getImagesByVault(vaultId) {
  ensureLoaded();
  if (!vaultId || vaultId === 'all') return [...imagePool];
  return imagePool.filter(img => (img.vaultId || 'default') === vaultId);
}

export function moveMediaToVault(mediaId, vaultId) {
  ensureLoaded();
  const img = imagePool.find(m => m.id === mediaId);
  if (img) { img.vaultId = vaultId; savePool(); }
}

// ============================================================
// PUBLIC API - Used by autochat/workflow
// ============================================================

// Get all images
export function getImages() {
  ensureLoaded();
  return [...imagePool];
}

// Get image by ID
export function getImageById(id) {
  ensureLoaded();
  return imagePool.find(img => img.id === id);
}

// Find best matching image for a query
export function findBestMatch(query) {
  ensureLoaded();
  if (imagePool.length === 0) return null;
  
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  let bestMatch = null;
  let bestScore = 0;
  
  for (const image of imagePool) {
    let score = 0;
    
    // Check tags (highest weight)
    for (const tag of image.tags) {
      for (const word of queryWords) {
        if (tag.includes(word) || word.includes(tag)) {
          score += 3;
        }
      }
    }
    
    // Check category
    for (const word of queryWords) {
      if (image.category.includes(word)) {
        score += 2;
      }
    }
    
    // Check description
    for (const word of queryWords) {
      if (image.description.toLowerCase().includes(word)) {
        score += 1;
      }
    }
    
    // Check name
    for (const word of queryWords) {
      if (image.name.toLowerCase().includes(word)) {
        score += 1;
      }
    }
    
    if (score > bestScore) {
      bestScore = score;
      bestMatch = image;
    }
  }
  
  // If no good match found, return random image
  if (bestScore === 0 && imagePool.length > 0) {
    const randomIndex = Math.floor(Math.random() * imagePool.length);
    return imagePool[randomIndex];
  }
  
  return bestMatch;
}

// Mark image as used
export function markImageUsed(imageId) {
  ensureLoaded();
  const image = imagePool.find(img => img.id === imageId);
  if (image) {
    image.usageCount++;
    image.lastUsed = Date.now();
    savePool();
    updateStats();
  }
}

// Get random image (with optional category filter)
export function getRandomImage(category = null) {
  ensureLoaded();
  let pool = imagePool;
  
  if (category) {
    pool = imagePool.filter(img => img.category === category);
  }
  
  if (pool.length === 0) return null;
  
  const randomIndex = Math.floor(Math.random() * pool.length);
  return pool[randomIndex];
}

// Show/hide the section based on platform
export function show() {
  const section = document.getElementById('imagePoolSection');
  if (section) {
    section.classList.remove('hidden');
  }
}

export function hide() {
  const section = document.getElementById('imagePoolSection');
  if (section) {
    section.classList.add('hidden');
  }
}

// ============================================================
// SENT IMAGES TRACKING - Prevent duplicate image sending
// ============================================================

// Mark an image as sent to a subscriber
export function markImageSentToSubscriber(subscriberId, imageId) {
  ensureLoaded();
  if (!subscriberId || !imageId) return;
  
  // Normalize subscriber ID (remove "tg:" prefix if present)
  const cleanSubscriberId = subscriberId.toString().replace(/^tg:/, '');
  
  if (!sentImagesMap[cleanSubscriberId]) {
    sentImagesMap[cleanSubscriberId] = [];
  }
  
  // Normalize image ID - extract unique part if it's a URL
  let normalizedImageId = imageId.toString();
  if (normalizedImageId.includes('firebase') || normalizedImageId.includes('http')) {
    // For URLs, use just the filename/path part
    const urlParts = normalizedImageId.split('/');
    normalizedImageId = urlParts[urlParts.length - 1].split('?')[0]; // Get filename without query params
  }
  
  // Only add if not already marked as sent
  if (!sentImagesMap[cleanSubscriberId].includes(normalizedImageId)) {
    sentImagesMap[cleanSubscriberId].push(normalizedImageId);
    saveSentImagesMap();
    console.log(`[ImagePool] ✅ Marked image "${normalizedImageId}" as sent to subscriber ${cleanSubscriberId}`);
    console.log(`[ImagePool] 📊 Total sent to ${cleanSubscriberId}: ${sentImagesMap[cleanSubscriberId].length}`);
  } else {
    console.log(`[ImagePool] ⚠️ Image "${normalizedImageId}" already marked as sent`);
  }
}

// Check if an image has been sent to a subscriber
// Checks multiple possible identifiers (id, name, downloadURL, normalized versions)
export function hasImageBeenSentToSubscriber(subscriberId, imageIdOrObject) {
  ensureLoaded();
  if (!subscriberId || !imageIdOrObject) return false;
  
  const cleanSubscriberId = subscriberId.toString().replace(/^tg:/, '');
  const sentImages = sentImagesMap[cleanSubscriberId] || [];
  
  if (sentImages.length === 0) return false;
  
  // Build list of possible identifiers for this image
  let imageIdentifiers = [];
  
  if (typeof imageIdOrObject === 'string') {
    // Simple string ID
    imageIdentifiers = [
      imageIdOrObject,
      normalizeImageId(imageIdOrObject)
    ].filter(Boolean);
  } else if (typeof imageIdOrObject === 'object') {
    // Full image object - check all possible identifiers
    imageIdentifiers = [
      imageIdOrObject.id,
      imageIdOrObject.name,
      imageIdOrObject.downloadURL,
      normalizeImageId(imageIdOrObject.id),
      normalizeImageId(imageIdOrObject.name),
      normalizeImageId(imageIdOrObject.downloadURL)
    ].filter(Boolean);
  }
  
  // Check if ANY of the identifiers match any sent image
  for (const imgId of imageIdentifiers) {
    if (sentImages.includes(imgId)) {
      console.log(`[ImagePool] 🔍 Image was already sent (matched: "${imgId}")`);
      return true;
    }
  }
  
  return false;
}

// Get all sent image IDs for a subscriber
export function getSentImagesForSubscriber(subscriberId) {
ensureLoaded();
  if (!subscriberId) return [];

  const cleanSubscriberId = subscriberId.toString().replace(/^tg:/, '');
  return sentImagesMap[cleanSubscriberId] || [];
}

// Unmark an image as sent to a subscriber (toggle off)
export function unmarkImageSentToSubscriber(subscriberId, imageId) {
  ensureLoaded();
  if (!subscriberId || !imageId) return;

  const cleanSubscriberId = subscriberId.toString().replace(/^tg:/, '');
  const sentImages = sentImagesMap[cleanSubscriberId];
  if (!sentImages || sentImages.length === 0) return;

  // Normalize the provided imageId
  let normalizedImageId = imageId.toString();
  if (normalizedImageId.includes('firebase') || normalizedImageId.includes('http')) {
    const urlParts = normalizedImageId.split('/');
    normalizedImageId = urlParts[urlParts.length - 1].split('?')[0];
  }

  // Remove all matching entries (raw + normalized)
  const before = sentImages.length;
  sentImagesMap[cleanSubscriberId] = sentImages.filter(id => id !== imageId && id !== normalizedImageId);
  const removed = before - sentImagesMap[cleanSubscriberId].length;

  if (removed > 0) {
    saveSentImagesMap();
    console.log(`[ImagePool] ↩️ Unmarked image "${normalizedImageId}" as sent to ${cleanSubscriberId}`);
  }
}

// Helper: Normalize image ID for consistent tracking
function normalizeImageId(id) {
  if (!id) return null;
  let normalized = id.toString();
  if (normalized.includes('firebase') || normalized.includes('http')) {
    const urlParts = normalized.split('/');
    normalized = urlParts[urlParts.length - 1].split('?')[0];
  }
  return normalized;
}

// Get images that have NOT been sent to a subscriber (filtered list)
export function getUnsentImagesForSubscriber(subscriberId, images = null) {
  ensureLoaded();
  const pool = images || imagePool;
  if (pool.length === 0) return [];
  
  const sentIds = getSentImagesForSubscriber(subscriberId);
  console.log(`[ImagePool] 🔍 Checking against ${sentIds.length} sent IDs:`, sentIds.slice(0, 5));
  
  // Filter out images that have been sent
  const unsent = pool.filter(img => {
    // Check all possible identifiers for the image
    const imageIds = [
      img.id,
      img.name,
      img.downloadURL,
      normalizeImageId(img.id),
      normalizeImageId(img.name),
      normalizeImageId(img.downloadURL)
    ].filter(Boolean);
    
    // Check if ANY of the image identifiers are in sent list
    for (const imgId of imageIds) {
      if (sentIds.includes(imgId)) {
        console.log(`[ImagePool] ⛔ Image "${img.name || img.id}" already sent (matched: ${imgId})`);
        return false;
      }
    }
    return true;
  });
  
  console.log(`[ImagePool] 📊 Unsent images for subscriber: ${unsent.length}/${pool.length} (${sentIds.length} already sent)`);
  return unsent;
}

// Get first unsent image from a list (for script pool or global pool)
export function getFirstUnsentImage(subscriberId, images = null) {
  ensureLoaded();
  const unsent = getUnsentImagesForSubscriber(subscriberId, images);
  if (unsent.length === 0) {
    console.log('[ImagePool] ⚠️ All images have been sent to this subscriber!');
    return null;
  }
  return unsent[0];
}

// Clear sent images history for a subscriber (for testing/reset)
export function clearSentImagesForSubscriber(subscriberId) {
  ensureLoaded();
  if (!subscriberId) return;
  
  const cleanSubscriberId = subscriberId.toString().replace(/^tg:/, '');
  delete sentImagesMap[cleanSubscriberId];
  saveSentImagesMap();
  console.log(`[ImagePool] 🗑️ Cleared sent images history for subscriber ${cleanSubscriberId}`);
}

// Get stats about sent images
export function getSentImagesStats() {
  ensureLoaded();
  const totalSubscribers = Object.keys(sentImagesMap).length;
  let totalSent = 0;
  for (const subscriberId of Object.keys(sentImagesMap)) {
    totalSent += sentImagesMap[subscriberId].length;
  }
  return { totalSubscribers, totalSent };
}
