// Media Pool Module
// Manages a pool of images AND videos for auto-responses (Telegram & OnlyFans)
// Media files are stored in Firebase Storage (via signed URLs)
// Metadata synced to Firestore for cross-device access; localStorage as fast cache

import { storeImage as uploadToStorage, storeFile as uploadFileToStorage, deleteImage as deleteFromStorage } from './scripts/imageStorage.js';

import { apiRequest } from '../utils/api.js';


const BASE_STORAGE_KEY = 'clarity_image_pool';
const BASE_VAULTS_KEY = 'clarity_vaults';
const BASE_SENT_IMAGES_KEY = 'clarity_sent_images'; // Track sent media per subscriber
let STORAGE_KEY = BASE_STORAGE_KEY;
let VAULTS_KEY = BASE_VAULTS_KEY;
let SENT_IMAGES_KEY = BASE_SENT_IMAGES_KEY;
let imagePool = [];
let vaults = []; // [{ id, name, createdAt }]
let pendingMediaData = null;
let pendingMediaFile = null;  // Raw File object for large uploads (avoids base64 memory issues)
let pendingMediaType = 'image'; // 'image' or 'video'
let sentImagesMap = {}; // { subscriberId: [mediaId1, mediaId2, ...] }
let _poolLoaded = false;
let _vaultsLoaded = false;
let _cloudSynced = false; // Whether we've pulled from server this session
let _lastSyncTime = 0;    // Timestamp of last successful sync
let _activeProfileId = null; // Current model profile — scopes vault per profile
let _lastUrlRefreshTime = 0; // Timestamp of last successful refreshDownloadURLs() call


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
let _syncGeneration = 0; // Incremented on every profile switch — used to discard stale async results

// ============================================================
// PER-PROFILE VAULT SCOPING — separate vault for each model profile
// ============================================================
// When a profile is selected, localStorage keys are prefixed
// with the profileId so each profile has its own independent media pool.
// Calling setActiveProfile() saves the current profile's data, switches
// keys, and loads the new profile's data from localStorage + cloud.

/** Switch to a different model profile — scopes vault data per profile.
 *  @param {string|null} profileId — profile ID (e.g. "p_abc123"), or null to reset to global

 *  @param {object} [opts]
 *  @param {boolean} [opts.skipSync=false] — if true, skip cloud sync (for fast reconnect) */
export function setActiveProfile(profileId, { skipSync = false } = {}) {
  const newId = profileId || null;
  if (newId === _activeProfileId) return; // No change

  // Invalidate any in-flight async syncFromServer() calls — their results are now stale
  _syncGeneration++;
  console.log(`[ImagePool] 🔄 Switching vault profile: ${_activeProfileId || 'global'} → ${newId || 'global'} (gen=${_syncGeneration})`);

  // ── Save current profile's data to localStorage before switching ──
  if (_poolLoaded) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(imagePool)); } catch (_) {}
  }
  if (_vaultsLoaded) {
    try { localStorage.setItem(VAULTS_KEY, JSON.stringify(vaults)); } catch (_) {}
  }
  try { localStorage.setItem(SENT_IMAGES_KEY, JSON.stringify(sentImagesMap)); } catch (_) {}

  // ── Update profile ID and recalculate localStorage keys ──
  _activeProfileId = newId;
  if (newId) {
    STORAGE_KEY = `${BASE_STORAGE_KEY}_${newId}`;
    VAULTS_KEY = `${BASE_VAULTS_KEY}_${newId}`;
    SENT_IMAGES_KEY = `${BASE_SENT_IMAGES_KEY}_${newId}`;
  } else {
    STORAGE_KEY = BASE_STORAGE_KEY;
    VAULTS_KEY = BASE_VAULTS_KEY;
    SENT_IMAGES_KEY = BASE_SENT_IMAGES_KEY;
  }

  // ── Persist active profile to chrome.storage.local so it survives SW restarts ──
  try { chrome.storage.local.set({ clarityActiveVaultProfile: newId }).catch(() => {}); } catch (_) {}

  // ── Reset in-memory state and reload from new profile's localStorage ──
  imagePool = [];
  vaults = [];
  sentImagesMap = {};
  _poolLoaded = false;
  _vaultsLoaded = false;
  _cloudSynced = false;
  _lastSyncTime = 0;
  _lastKnownVersions = { pool: 0, vaults: 0, sent: 0 };

  // Cancel pending syncs/timers from previous profile
  clearTimeout(_poolSyncTimer);
  clearTimeout(_vaultsSyncTimer);
  clearTimeout(_sentSyncTimer);
  stopPolling();

  // Load new profile's data from localStorage (fast)
  loadPool();
  loadVaults();
  loadSentImagesMap();
  renderPool();

  console.log(`[ImagePool] ✅ Profile switched to ${newId || 'global'}: ${imagePool.length} items, ${vaults.length} vaults`);

  // Trigger cloud sync for the new profile (async)
  if (!skipSync) {
    syncFromServer().then(() => {
      renderPool();
      window.dispatchEvent(new CustomEvent('vault-pool-updated'));
    }).catch(() => {});
  } else if (newId) {
    // skipSync + profile active: mark as synced immediately so saves work.
    // Profile mode uses the profile-scoped Clarity server doc; localStorage is the cache.
    _cloudSynced = true;
    _lastSyncTime = Date.now();
    // Notify vault modal (if open) to refresh with the new profile's data
    window.dispatchEvent(new CustomEvent('vault-pool-updated'));
  }
}

/** Get the currently active profile ID */
export function getActiveProfile() {
  return _activeProfileId;
}

/** Restore active profile from chrome.storage.local (called on init).
 *  Returns the stored profileId or null. */
async function restoreActiveProfile() {
  try {
    const stored = await chrome.storage.local.get('clarityActiveVaultProfile');
    const profileId = stored.clarityActiveVaultProfile || null;
    if (profileId && profileId !== _activeProfileId) {
      // Update keys without full re-init (init() will load data next)
      _activeProfileId = profileId;
      STORAGE_KEY = `${BASE_STORAGE_KEY}_${profileId}`;
      VAULTS_KEY = `${BASE_VAULTS_KEY}_${profileId}`;
      SENT_IMAGES_KEY = `${BASE_SENT_IMAGES_KEY}_${profileId}`;
      console.log(`[ImagePool] 🔄 Restored vault profile from storage: ${profileId}`);
    }
    return profileId;
  } catch (_) {
    return null;
  }
}

function schedulePoolSync() {
  // SAFETY: Never push to server before initial sync completes.
  // A device with incomplete local data could overwrite existing server data.
  if (!_cloudSynced) {
    console.log('[ImagePool] ⏳ Pool write deferred — waiting for initial cloud sync');
    return;
  }
  // Push to the Clarity server in BOTH global and profile mode. The server doc is
  // profile-scoped (via profileId), so uploads reliably reach Firebase and other
  // same-account devices then pick them up.
  clearTimeout(_poolSyncTimer);

  _poolSyncTimer = setTimeout(() => pushPoolToServer(), SYNC_DEBOUNCE_MS);
}

function scheduleVaultsSync() {
  if (!_cloudSynced) {
    console.log('[ImagePool] ⏳ Vaults write deferred — waiting for initial cloud sync');
    return;
  }
  // Push to profile-scoped Clarity server doc in both modes (see schedulePoolSync).
  clearTimeout(_vaultsSyncTimer);
  _vaultsSyncTimer = setTimeout(() => pushVaultsToServer(), SYNC_DEBOUNCE_MS);
}

function scheduleSentSync() {
  if (!_cloudSynced) {
    console.log('[ImagePool] ⏳ Sent write deferred — waiting for initial cloud sync');
    return;
  }
  // Push to profile-scoped Clarity server doc in both modes (see schedulePoolSync).
  clearTimeout(_sentSyncTimer);
  _sentSyncTimer = setTimeout(() => pushSentToServer(), SYNC_DEBOUNCE_MS);
}


// Append the active profileId to a vault API path so the server reads/writes the
// correct per-profile Firestore doc. Global mode (no profile) leaves the path
// unchanged, preserving backward compatibility with the original doc IDs.
function vaultQuery(path) {
  if (!_activeProfileId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}profileId=${encodeURIComponent(_activeProfileId)}`;
}

async function pushPoolToServer() {
  try {
    await apiRequest('/storage/vault/pool', {
      method: 'PUT',
      body: JSON.stringify({ items: imagePool, profileId: _activeProfileId || null })
    });
    console.log('[ImagePool] ☁️ Pool synced to server:', imagePool.length, 'items', _activeProfileId ? `(profile ${_activeProfileId})` : '');
  } catch (err) {
    console.warn('[ImagePool] ⚠️ Pool server sync failed (will retry):', err.message);
  }
}

async function pushVaultsToServer() {
  try {
    await apiRequest('/storage/vault/vaults', {
      method: 'PUT',
      body: JSON.stringify({ vaults, profileId: _activeProfileId || null })
    });
    console.log('[ImagePool] ☁️ Vaults synced to server:', vaults.length, 'vaults', _activeProfileId ? `(profile ${_activeProfileId})` : '');
  } catch (err) {
    console.warn('[ImagePool] ⚠️ Vaults server sync failed:', err.message);
  }
}

async function pushSentToServer() {
  try {
    await apiRequest('/storage/vault/sent', {
      method: 'PUT',
      body: JSON.stringify({ map: sentImagesMap, profileId: _activeProfileId || null })
    });
    console.log('[ImagePool] ☁️ Sent map synced to server:', Object.keys(sentImagesMap).length, 'subscribers', _activeProfileId ? `(profile ${_activeProfileId})` : '');
  } catch (err) {
    console.warn('[ImagePool] ⚠️ Sent map server sync failed:', err.message);
  }
}

// Pull the profile-scoped vault from the Clarity server and MERGE any items not
// already present locally: uploads reach the profile-scoped server doc so other
// same-account devices pick them up here.
//
// Version-gated: fetches the lightweight /version endpoint first and skips the full
// pull when nothing changed (unless force=true). Non-destructive — only ADDS items,
// never removes (deletions are handled by the Firestore poll).
// Returns { added, addedVaults, serverIds } or null on failure.
async function pullProfileServerVault({ force = false } = {}) {
  if (!_activeProfileId) return null;
  try {
    let versions = null;
    try {
      const ver = await apiRequest(vaultQuery('/storage/vault/version'));
      if (ver && ver.success) {
        versions = {
          pool: ver.poolUpdatedAt || 0,
          vaults: ver.vaultsUpdatedAt || 0,
          sent: ver.sentUpdatedAt || 0
        };
      }
    } catch (_) {}

    // Skip the expensive full fetch when the server hasn't changed
    if (!force && versions &&
        versions.pool <= _lastKnownVersions.pool &&
        versions.vaults <= _lastKnownVersions.vaults &&
        versions.sent <= _lastKnownVersions.sent) {
      return { added: 0, addedVaults: 0, serverIds: null, unchanged: true };
    }

    const data = await apiRequest(vaultQuery('/storage/vault'));
    if (!data || !data.success) return null;

    const serverPool = Array.isArray(data.pool) ? data.pool : [];
    const serverVaults = Array.isArray(data.vaults) ? data.vaults : [];

    const localIds = new Set(imagePool.map(i => i.id));
    const newItems = serverPool.filter(i => i && i.id && !localIds.has(i.id));
    if (newItems.length > 0) imagePool = [...imagePool, ...newItems];

    const localVaultIds = new Set(vaults.map(v => v.id));
    const newVaults = serverVaults.filter(v => v && v.id && !localVaultIds.has(v.id));
    if (newVaults.length > 0) vaults = [...vaults, ...newVaults];

    if (versions) _lastKnownVersions = versions;

    return { added: newItems.length, addedVaults: newVaults.length, serverIds: new Set(serverPool.map(i => i.id)) };
  } catch (err) {
    console.debug('[ImagePool] Profile server pull failed:', err.message);
    return null;
  }
}


// Refresh download URLs for pool items with storagePath (signed URLs expire after 4h)

export async function refreshDownloadURLs() {
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

    _lastUrlRefreshTime = Date.now();
    console.log(`[ImagePool] ✅ Download URLs refreshed for ${itemsNeedingRefresh.length} items`);
  } catch (err) {
    console.warn('[ImagePool] ⚠️ URL refresh failed (images may not display):', err.message);
  }
}

// Per-element guard so a broken <img>/<video> only re-fetches its URL once
// (prevents an infinite error→reload loop when the file is truly gone).
const _mediaErrorRetried = new WeakSet();

// Batched media-error recovery.
// When many thumbnails share an expired signed URL, every <img> fires `error`
// almost simultaneously. Firing one /storage/url request per image floods the
// server (HTTP 429). Instead we queue failed elements and flush them in a single
// debounced batch call to /storage/vault/refresh-urls (max 200 storagePaths per
// request), then swap each element's src from the batch result.
const _mediaErrorQueue = new Map(); // storagePath → { els: Set<HTMLElement>, itemId }
let _mediaErrorFlushTimer = null;
const MEDIA_ERROR_DEBOUNCE_MS = 400; // batch errors that arrive within 400ms
const MEDIA_ERROR_BATCH_LIMIT = 200; // server cap per refresh-urls call

async function _flushMediaErrorQueue() {
  _mediaErrorFlushTimer = null;
  if (_mediaErrorQueue.size === 0) return;

  // Snapshot + clear the queue so new errors during the request re-batch cleanly
  const entries = Array.from(_mediaErrorQueue.entries());
  _mediaErrorQueue.clear();

  for (let i = 0; i < entries.length; i += MEDIA_ERROR_BATCH_LIMIT) {
    const chunk = entries.slice(i, i + MEDIA_ERROR_BATCH_LIMIT);
    const payload = chunk.map(([storagePath, info]) => ({
      id: info.itemId || storagePath,
      storagePath
    }));

    try {
      const result = await apiRequest('/storage/vault/refresh-urls', {
        method: 'POST',
        body: JSON.stringify({ items: payload })
      });

      if (result?.success && Array.isArray(result.items)) {
        // Map refreshed URLs back by id → apply to every element awaiting that path
        const byId = new Map(result.items.map(r => [r.id, r.downloadURL]));
        let poolChanged = false;

        for (const [storagePath, info] of chunk) {
          const freshUrl = byId.get(info.itemId || storagePath);
          if (!freshUrl) continue;

          // Persist the fresh URL onto the cached pool item
          if (info.itemId) {
            const poolItem = imagePool.find(p => p.id === info.itemId);
            if (poolItem) { poolItem.downloadURL = freshUrl; poolChanged = true; }
          }
          // Swap src on all elements that were showing this path
          for (const el of info.els) {
            if (el && el.isConnected) el.src = freshUrl;
          }
        }

        if (poolChanged) {
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(imagePool)); } catch (_) {}
        }
      }
    } catch (err) {
      console.debug('[ImagePool] Batched media URL refresh failed:', err.message);
    }
  }
}

// onerror handler for media elements — a signed URL that returns 400/403 is almost
// always expired. Queues the element for a batched, debounced URL refresh so a
// grid of broken thumbnails triggers ONE server call instead of dozens (429).
// Exported so vault/editor/testMedia render paths can attach the same fallback.
export function handleMediaError(el, storagePath, itemId) {
  if (!el || !storagePath) return;
  if (_mediaErrorRetried.has(el)) return; // Already retried once — give up
  _mediaErrorRetried.add(el);

  let entry = _mediaErrorQueue.get(storagePath);
  if (!entry) {
    entry = { els: new Set(), itemId: itemId || null };
    _mediaErrorQueue.set(storagePath, entry);
  }
  entry.els.add(el);
  if (itemId && !entry.itemId) entry.itemId = itemId;

  clearTimeout(_mediaErrorFlushTimer);
  _mediaErrorFlushTimer = setTimeout(_flushMediaErrorQueue, MEDIA_ERROR_DEBOUNCE_MS);
}



// Check server for remote changes — called every POLL_INTERVAL_MS
async function pollForChanges() {
  if (_isSyncing) return;

  // PROFILE MODE: poll the profile-scoped Clarity server doc for items other
  // same-account devices (e.g. employees) pushed to the server.
  if (_activeProfileId) {
    if (!_cloudSynced || document.hidden) return;
    try {
      _isSyncing = true;
      const pulled = await pullProfileServerVault({ force: false });
      if (pulled && pulled.added > 0) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(imagePool)); } catch (_) {}
        try { localStorage.setItem(VAULTS_KEY, JSON.stringify(vaults)); } catch (_) {}
        if (imagePool.some(item => item.storagePath)) {
          await refreshDownloadURLs().catch(() => {});
        }
        renderPool();
        window.dispatchEvent(new CustomEvent('vault-pool-updated'));
        console.log(`[ImagePool] 🔄 Profile server poll: +${pulled.added} items, +${pulled.addedVaults} vaults`);
      }
    } catch (err) {
      console.debug('[ImagePool] Profile server poll failed:', err.message);
    } finally {
      _isSyncing = false;
    }
    return;
  }

  // If initial sync hasn't completed yet, retry it instead of polling

  if (!_cloudSynced) {
    console.log('[ImagePool] 📡 Initial sync not done — retrying syncFromServer...');
    _isSyncing = true;
    try {
      await syncFromServer();
      if (_cloudSynced) {
        renderPool();
        window.dispatchEvent(new CustomEvent('vault-pool-updated'));
      }
    } catch (_) {} finally { _isSyncing = false; }
    return;
  }

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
    const fullData = await apiRequest(vaultQuery('/storage/vault'));
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
      // Notify vault modal (if open) to re-render with fresh data
      window.dispatchEvent(new CustomEvent('vault-pool-updated'));
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

// Wait for Firebase auth to be ready (token available)
async function waitForAuth(maxWaitMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      if (typeof FirebaseAuth !== 'undefined') {
        const user = FirebaseAuth.getCurrentUser();
        if (user?.idToken) return true;
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 500)); // Check every 500ms
  }
  return false;
}

// Pull all vault data from server — CLOUD-FIRST: Firebase is the authoritative source.
// 1. Wait for auth to be ready
// 2. Fetch server state
// 3. Push any local-only items to server
// 4. Re-fetch server state to confirm round-trip
// 5. Replace local pool with verified server data
// This guarantees: what you see = what's on Firebase = what other devices see
//
// PROFILE SCOPING: When a profile is active, the vault is read/written through the
// profile-scoped Clarity server doc (via profileId) instead of the single global
// vault. localStorage is the fast cache; the profile-scoped server doc is the
// cross-device backbone that lets every same-account device see the same media.
async function syncFromServer() {
  // Allow re-sync if first sync returned empty pool (other device may not have pushed yet)
  if (_cloudSynced && imagePool.length > 0) return;

  // ── PROFILE MODE: Sync via the profile-scoped Clarity server doc ──
  // localStorage is the local cache; the profile-scoped server doc (keyed by
  // profileId) is the authoritative cross-device source. We pull it, then
  // UNCONDITIONALLY mirror our merged vault back so other same-account devices
  // (e.g. employees) always see the same media.
  if (_activeProfileId) {
    console.log(`[ImagePool] 📌 Profile "${_activeProfileId}" active — syncing via profile-scoped server doc`);

    // Ensure a default vault exists in the local cache before syncing
    if (!vaults.find(v => v.id === 'default')) {
      vaults.unshift({ id: 'default', name: 'General', createdAt: 0 });
      try { localStorage.setItem(VAULTS_KEY, JSON.stringify(vaults)); } catch (_) {}
    }

    _cloudSynced = true;
    _lastSyncTime = Date.now();

    // ── CROSS-DEVICE BACKBONE: profile-scoped Clarity server doc ──
    // (1) Pull anything other devices pushed, then (2) UNCONDITIONALLY mirror our
    // authoritative vault up so every other same-account device can retrieve it.
    // The PUT is idempotent, so re-pushing identical data is safe. This is the fix
    // for "media only shows on my laptop, not my employees'".
    try {
      const pulled = await pullProfileServerVault({ force: true });
      if (pulled && pulled.added > 0) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(imagePool)); } catch (_) {}
        try { localStorage.setItem(VAULTS_KEY, JSON.stringify(vaults)); } catch (_) {}
        console.log(`[ImagePool] ☁️ Profile server pull: +${pulled.added} items, +${pulled.addedVaults} vaults`);
      }

      // Refresh signed URLs for cached/pulled items (they expire after ~4h)
      if (imagePool.some(item => item.storagePath)) {
        await refreshDownloadURLs().catch(() => {});
      }

      if (imagePool.length > 0) {
        console.log(`[ImagePool] 🔄 Mirroring ${imagePool.length} items to profile server doc (cross-device backbone)...`);
        await pushPoolToServer().catch(() => {});
        await pushVaultsToServer().catch(() => {});
      }
    } catch (_) {}

    // Start the Clarity server poll (30s) for cross-device changes
    startPolling();

    console.log(`[ImagePool] ✅ Profile vault ready: ${imagePool.length} items, ${vaults.length} vaults`);
    return;
  }

  // ── GLOBAL MODE: Full Clarity server sync ──
  // Capture generation counter — if a profile switch happens during this async fetch,
  // _syncGeneration will be incremented and we'll discard the stale results.
  const myGeneration = _syncGeneration;

  // Wait for auth — on fresh installs, FirebaseAuth may not have a token yet
  const authReady = await waitForAuth();
  if (!authReady) {
    console.warn('[ImagePool] ⚠️ Auth not ready after 8s — skipping cloud sync (will retry on next poll)');
    startPolling(); // Start polling so we can sync when auth becomes available
    return;
  }

  try {
    console.log(`[ImagePool] ☁️ Cloud-first sync starting... (local cache: ${imagePool.length} items)`);

    // ── Step 1: Fetch current server state ──
    const data = await apiRequest('/storage/vault');
    if (!data.success) {
      console.warn('[ImagePool] ⚠️ Server returned error for vault fetch');
      return;
    }

    const serverPool = Array.isArray(data.pool) ? data.pool : [];
    const serverVaults = Array.isArray(data.vaults) ? data.vaults : [];
    const serverSent = (data.sent && typeof data.sent === 'object') ? data.sent : {};

    console.log(`[ImagePool] ☁️ Server has: ${serverPool.length} pool items, ${serverVaults.length} vaults, ${Object.keys(serverSent).length} sent tracks`);

    // ── Step 2: Push any local-only items to server (first-time sync) ──
    const serverIds = new Set(serverPool.map(i => i.id));
    const localOnlyPool = imagePool.filter(i => !serverIds.has(i.id));
    let needsReFetch = false;

    if (localOnlyPool.length > 0) {
      console.log(`[ImagePool] 🔄 Pushing ${localOnlyPool.length} local-only items to server...`);
      // Temporarily merge for push (server items + local-only)
      imagePool = [...serverPool, ...localOnlyPool];
      await pushPoolToServer();
      console.log(`[ImagePool] ✅ Local items pushed to server`);
      needsReFetch = true;
    }

    // Push local-only vaults
    const serverVaultIds = new Set(serverVaults.map(v => v.id));
    const localOnlyVaults = vaults.filter(v => v.id !== 'default' && !serverVaultIds.has(v.id));
    if (localOnlyVaults.length > 0) {
      vaults = [...serverVaults, ...localOnlyVaults];
      if (!vaults.find(v => v.id === 'default')) {
        vaults.unshift({ id: 'default', name: 'General', createdAt: 0 });
      }
      await pushVaultsToServer();
      needsReFetch = true;
    }

    // Push local-only sent tracking
    const localSentKeys = Object.keys(sentImagesMap);
    const serverSentKeys = Object.keys(serverSent);
    let mergedSent = { ...serverSent };
    let sentChanged = false;
    for (const [subId, ids] of Object.entries(sentImagesMap)) {
      if (!mergedSent[subId]) {
        mergedSent[subId] = ids;
        sentChanged = true;
      } else {
        const merged = new Set([...mergedSent[subId], ...ids]);
        if (merged.size > mergedSent[subId].length) {
          mergedSent[subId] = [...merged];
          sentChanged = true;
        }
      }
    }
    if (sentChanged) {
      sentImagesMap = mergedSent;
      await pushSentToServer();
      needsReFetch = true;
    }

    // ── Step 3: Re-fetch from server to get authoritative state ──
    // This confirms the round-trip: what's on Firebase is what we display
    let finalPool, finalVaults, finalSent;

    if (needsReFetch) {
      console.log(`[ImagePool] 🔄 Re-fetching from server to verify round-trip...`);
      const verifyData = await apiRequest('/storage/vault');
      if (verifyData.success) {
        finalPool = Array.isArray(verifyData.pool) ? verifyData.pool : serverPool;
        finalVaults = Array.isArray(verifyData.vaults) ? verifyData.vaults : serverVaults;
        finalSent = (verifyData.sent && typeof verifyData.sent === 'object') ? verifyData.sent : mergedSent;
        console.log(`[ImagePool] ✅ Verified: server has ${finalPool.length} pool items after push`);
      } else {
        finalPool = [...serverPool, ...localOnlyPool];
        finalVaults = [...serverVaults, ...localOnlyVaults];
        finalSent = mergedSent;
      }
    } else {
      // No local-only items — server data IS the authoritative state
      finalPool = serverPool;
      finalVaults = serverVaults;
      finalSent = serverSent;
    }

    // ── RACE CONDITION GUARD: Check if profile changed during async fetch ──
    // If setActiveProfile() was called while we were fetching, _syncGeneration
    // will have been incremented. Discard the stale global data to prevent
    // contaminating the newly-active profile's vault.
    if (_syncGeneration !== myGeneration) {
      console.warn(`[ImagePool] ⚠️ Profile changed during global sync (gen ${myGeneration} → ${_syncGeneration}) — DISCARDING stale server data to prevent vault contamination`);
      return;
    }

    // ── Step 4: Replace local state with server-verified data ──
    imagePool = finalPool;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(imagePool)); } catch (_) {}
    updateStats();

    vaults = finalVaults;
    if (!vaults.find(v => v.id === 'default')) {
      vaults.unshift({ id: 'default', name: 'General', createdAt: 0 });
    }
    try { localStorage.setItem(VAULTS_KEY, JSON.stringify(vaults)); } catch (_) {}

    sentImagesMap = finalSent;
    try { localStorage.setItem(SENT_IMAGES_KEY, JSON.stringify(sentImagesMap)); } catch (_) {}

    _cloudSynced = true;
    _lastSyncTime = Date.now();

    // Capture version timestamps for polling change detection
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

    console.log(`[ImagePool] ☁️ Cloud-first sync complete: ${imagePool.length} items (from Firebase), ${vaults.length} vaults, ${Object.keys(sentImagesMap).length} sent tracks`);

    // Refresh download URLs — signed URLs expire after 4h,
    // so items from server need fresh URLs on this device
    if (imagePool.length > 0) {
      await refreshDownloadURLs();
    }

    // Start live polling for cross-device changes
    startPolling();
  } catch (err) {
    console.warn('[ImagePool] ⚠️ Cloud sync failed (using local cache):', err.message);
    // Start polling anyway so we can retry later
    if (!_pollInterval) startPolling();
  }
}

// Supported media types
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const SUPPORTED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/mov'];
const MAX_VIDEO_SIZE_MB = 2048; // Max 2GB for videos

// ONE-TIME MIGRATION v3: Per-profile vault separation.
// A previous fallback seeded ALL profiles with the same global vault data (418 items).
// This migration keeps vault data ONLY for profiles matching "Ria" (case-insensitive)
// and clears all other profile-scoped vault keys so they start with empty vaults.
// Reads cachedProfiles from chrome.storage.local to find the Ria profile ID.
async function runVaultMigrationIfNeeded() {
  const MIGRATION_KEY = 'clarity_vault_migration_v3';
  if (localStorage.getItem(MIGRATION_KEY)) return; // Already migrated

  console.log('[ImagePool] 🧹 MIGRATION v3: Per-profile vault separation — keeping vault only for Ria...');

  // Find Ria's profile ID from cached profiles
  let riaProfileId = null;
  try {
    const stored = await chrome.storage.local.get('cachedProfiles');
    const profiles = stored.cachedProfiles || [];
    console.log(`[ImagePool] 🧹 Found ${profiles.length} cached profiles:`, profiles.map(p => `${p.name} (${p.id})`));

    // Find ALL profile IDs that contain "ria" in the name (case-insensitive)
    const riaProfiles = profiles.filter(p => p.name && p.name.toLowerCase().includes('ria'));
    if (riaProfiles.length > 0) {
      riaProfileId = riaProfiles[0].id;
      console.log(`[ImagePool] 🧹 Ria profile found: "${riaProfiles[0].name}" (${riaProfileId})`);
    } else {
      console.log(`[ImagePool] 🧹 No "Ria" profile found — will clear ALL profile-scoped vault keys`);
    }
  } catch (e) {
    console.warn(`[ImagePool] 🧹 Could not read cached profiles:`, e.message);
  }

  // Collect all profile-scoped vault keys from localStorage
  const keysToRemove = [];
  const keysToKeep = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    // Match profile-scoped keys like "clarity_image_pool_PROFILEID" but NOT the base keys
    const isProfileScoped = (
      (key.startsWith('clarity_image_pool_') && key !== 'clarity_image_pool') ||
      (key.startsWith('clarity_vaults_') && key !== 'clarity_vaults') ||
      (key.startsWith('clarity_sent_images_') && key !== 'clarity_sent_images')
    );
    if (!isProfileScoped) continue;

    // Check if this key belongs to Ria's profile
    if (riaProfileId && key.endsWith(`_${riaProfileId}`)) {
      keysToKeep.push(key);
    } else {
      keysToRemove.push(key);
    }
  }

  // Remove non-Ria profile vault keys
  keysToRemove.forEach(key => {
    console.log(`[ImagePool] 🧹 Clearing non-Ria vault key: ${key}`);
    localStorage.removeItem(key);
  });

  console.log(`[ImagePool] ✅ Migration v3 complete: kept ${keysToKeep.length} Ria keys, cleared ${keysToRemove.length} other profile keys`);
  localStorage.setItem(MIGRATION_KEY, Date.now().toString());
}

// Initialize
export async function init() {
  // Run one-time migration to clear contaminated profile-scoped vault data
  await runVaultMigrationIfNeeded();

  // Restore per-profile vault scope before loading any data
  await restoreActiveProfile();

  loadPool();
  loadVaults();
  loadSentImagesMap();
  setupEventListeners();
  renderPool();
  console.log('[ImagePool] Initialized with', imagePool.length, 'images,', vaults.length, 'vaults', _activeProfileId ? `(profile: ${_activeProfileId})` : '(global)');

  // IMPORTANT: syncFromServer() is NOT called here.
  // profiles.js → selectProfile() → setActiveProfile() will trigger the correct
  // per-profile sync. Starting a global sync here creates a race condition where
  // the async fetch completes AFTER the profile switch and writes global vault data
  // into the profile-scoped localStorage key, contaminating all profiles.
  // If no profiles exist, sidepanel.js calls triggerCloudSync() as fallback.
}

/** Trigger a cloud sync manually — used by sidepanel.js when no profiles are loaded.
 *  Wrapped with render + event dispatch for UI update. */
export function triggerCloudSync() {
  syncFromServer().then(() => {
    renderPool();
    window.dispatchEvent(new CustomEvent('vault-pool-updated'));
  }).catch(() => {});
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
// Uses URL.createObjectURL for preview (no base64 conversion — supports 2GB+ files)
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
    alert(`Video file is too large. Maximum size is ${(MAX_VIDEO_SIZE_MB / 1024).toFixed(0)}GB.`);
    return;
  }
  
  pendingMediaType = isVideo ? 'video' : 'image';
  pendingMediaFile = file; // Store raw File for direct upload (no base64 for large files)
  
  // Use object URL for preview — zero memory overhead, works for any file size
  const previewUrl = URL.createObjectURL(file);
  pendingMediaData = previewUrl; // Used for preview display only
  showAddForm(previewUrl, pendingMediaType);
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
  
  // Revoke object URL to free memory
  if (pendingMediaData && pendingMediaData.startsWith('blob:')) {
    URL.revokeObjectURL(pendingMediaData);
  }
  pendingMediaData = null;
  pendingMediaFile = null;
  pendingMediaType = 'image';
}

// Save new media to pool (uploads to Firebase Storage)
// Uses direct File upload (storeFile) when available — supports files up to 2GB
async function saveNewImage() {
  if (!pendingMediaFile && !pendingMediaData) return;
  
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
    // Upload to Firebase Storage — use direct File upload when available (supports 2GB+)
    const storageResult = pendingMediaFile
      ? await uploadFileToStorage(pendingMediaFile, { scriptId: 'vault', mediaType })
      : await uploadToStorage(mediaData, { scriptId: 'vault', mediaType });
    
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

// Add file to pool directly from a File object (used by vault batch upload)
// Uploads File directly to Firebase Storage via signed URL — no base64, supports 2GB+
export async function addFile(file, mediaType = 'image', name = '', vaultId = 'default') {
  ensureLoaded();
  const defaultName = mediaType === 'video' ? `Video ${imagePool.length + 1}` : `Image ${imagePool.length + 1}`;

  const storageResult = await uploadFileToStorage(file, {
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
    imagePool.pop();
    throw e;
  }

  console.log(`[ImagePool] ☁️ Added ${mediaType}: ${newMedia.name} (direct file upload, ${(file.size / 1024 / 1024).toFixed(1)}MB)`);
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
        <video src="${img.imageData || img.downloadURL}" data-storage-path="${img.storagePath || ''}" muted preload="metadata"></video>
        <div class="video-play-icon">▶</div>
      ` : `
        <img src="${img.imageData || img.downloadURL}" data-storage-path="${img.storagePath || ''}" alt="${img.name}">
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
  
  // Attach expired-URL fallback: if a signed URL 400s, re-mint a fresh one
  container.querySelectorAll('img[data-storage-path], video[data-storage-path]').forEach(el => {
    const storagePath = el.getAttribute('data-storage-path');
    if (!storagePath) return;
    const itemEl = el.closest('.image-pool-item');
    const itemId = itemEl?.dataset?.id;
    el.addEventListener('error', () => handleMediaError(el, storagePath, itemId), { once: false });
  });

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
