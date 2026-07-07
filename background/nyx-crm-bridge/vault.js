// ============================================================
// NYX CRM BRIDGE — Vault Sync & CRUD
// ============================================================

import { S, dataKey } from './state.js';
import { getToken } from './auth.js';
import { patchDoc, getDoc } from './firestore.js';
import { findOfTab, sendLockToTab, sendUnlockToTab } from './tab-helpers.js';

/** Sync vault data from Clarity to NYX Firestore.
 *  Called when imagePool changes (pool, vaults, or sentMap).
 *  Writes to vault_data/{key} as a single document (~lightweight).
 *  @param {Array} pool — media pool items
 *  @param {Array} vaults — vault folders
 *  @param {Object} sent — sent tracking map
 *  @param {string|null} vaultProfileId — optional per-profile key override (from Clarity profile selector) */
export async function syncVaultToFirestore(pool, vaults, sent, vaultProfileId = null) {
  if (!S.nyxModelId || !S.isInitialized) return;

  // Always prefer bridge's dataKey() (NYX CRM profile/model ID) — the passed
  // vaultProfileId may be a Clarity-internal profile ID that doesn't match
  // any vault_data document in NYX CRM Firestore.
  const key = dataKey() || vaultProfileId;
  const poolArr = pool || [];

  try {
    // ── READ-MERGE-WRITE: Preserve items added by CRM ──
    // CRM can add/delete media directly in Firestore. Clarity only knows about
    // its own items. We must MERGE to avoid overwriting CRM-added items.
    let mergedPool = poolArr.map(item => ({
      id: item.id || '',
      name: item.name || '',
      mediaType: item.mediaType || 'image',
      downloadURL: item.downloadURL || '',
      storagePath: item.storagePath || '',
      vaultId: item.vaultId || 'default',
      createdAt: item.createdAt || 0,
      usageCount: item.usageCount || 0,
    }));

    let existingSent = {};
    let existingVaults = [];

    try {
      const existing = await getDoc(`vault_data/${key}`);
      if (existing) {
        const existingPool = Array.isArray(existing.pool) ? existing.pool : [];
        existingSent = (existing.sent && typeof existing.sent === 'object') ? existing.sent : {};
        existingVaults = Array.isArray(existing.vaults) ? existing.vaults : [];

        // ── EMPTY-POOL OVERWRITE PROTECTION ──
        if (poolArr.length === 0 && existingPool.length > 0) {
          console.log(`[NYX CRM] 🛡️ Vault overwrite BLOCKED: incoming pool is empty but Firestore has ${existingPool.length} items at vault_data/${key} — skipping write to prevent data loss`);
          return;
        }

        // Find CRM-added items: items in Firestore that are NOT in Clarity's pool.
        // CRM items are identified by: id starts with 'crm_' OR storagePath starts with 'vault-media/'
        // OR lastModifiedBy === 'crm' / 'crm-copy'
        const clarityIds = new Set(poolArr.map(item => item.id));
        const crmOnlyItems = existingPool.filter(item => {
          if (clarityIds.has(item.id)) return false; // Already in Clarity's pool
          // Keep items that were added by CRM (not in Clarity's pool)
          return true;
        });

        if (crmOnlyItems.length > 0) {
          // Append CRM-only items to the merged pool
          mergedPool = [...mergedPool, ...crmOnlyItems];
          console.log(`[NYX CRM] 🔀 Vault MERGE: ${poolArr.length} Clarity items + ${crmOnlyItems.length} CRM-only items = ${mergedPool.length} total`);
        }

        // Merge vaults: keep CRM-created vaults that Clarity doesn't know about
        const clarityVaultIds = new Set((vaults || []).map(v => v.id));
        const crmOnlyVaults = existingVaults.filter(v => !clarityVaultIds.has(v.id));
        existingVaults = [...(vaults || []), ...crmOnlyVaults];

        // Merge sent maps: combine both (CRM's markSent + Clarity's markSent)
        const mergedSentMap = { ...existingSent };
        if (sent && typeof sent === 'object') {
          for (const [subId, sentData] of Object.entries(sent)) {
            if (!mergedSentMap[subId]) {
              mergedSentMap[subId] = sentData;
            } else if (Array.isArray(sentData) && Array.isArray(mergedSentMap[subId])) {
              // Merge arrays, dedup
              const combined = new Set([...mergedSentMap[subId], ...sentData]);
              mergedSentMap[subId] = [...combined];
            } else if (typeof sentData === 'object' && typeof mergedSentMap[subId] === 'object') {
              mergedSentMap[subId] = { ...mergedSentMap[subId], ...sentData };
            } else {
              mergedSentMap[subId] = sentData; // Clarity wins on type mismatch
            }
          }
        }
        existingSent = mergedSentMap;
      }
    } catch (checkErr) {
      console.warn(`[NYX CRM] ⚠️ Could not read existing vault for merge — doing full write:`, checkErr.message);
      existingSent = sent || {};
      existingVaults = vaults || [];
    }

    const doc = {
      pool: mergedPool,
      vaults: existingVaults,
      sent: existingSent,
      syncedAt: new Date().toISOString(),
      clarityVersion: chrome.runtime.getManifest().version,
    };

    await patchDoc(`vault_data/${key}`, doc);
    console.log(`[NYX CRM] 📦 Vault synced to Firestore (${key}): ${doc.pool.length} items, ${doc.vaults.length} vaults, ${Object.keys(doc.sent).length} sent tracks`);
  } catch (e) {
    console.warn(`[NYX CRM] ❌ syncVaultToFirestore error:`, e.message);
  }
}

/** Execute FORCE_VAULT_SYNC — re-pushes cached vault data to Firestore.
 *  Called when CRM detects empty vault and Clarity is online.
 *  1. Try chrome.storage.local cache (nyxVaultCache) — fastest, no sidepanel needed
 *  2. Fallback: ask sidepanel to trigger notifyNyxCrmVaultChanged() */
export async function executeForceVaultSync(cmd) {
  console.log(`[NYX CRM] 📦 Executing FORCE_VAULT_SYNC...`);

  // Strategy 1: Use cached vault data from chrome.storage.local
  try {
    const stored = await chrome.storage.local.get('nyxVaultCache');
    const cache = stored.nyxVaultCache;
    if (cache && Array.isArray(cache.pool) && cache.pool.length > 0) {
      console.log(`[NYX CRM] 📦 Found cached vault: ${cache.pool.length} items (profile=${cache.activeProfileId || 'default'}) — syncing to Firestore...`);
      await syncVaultToFirestore(cache.pool, cache.vaults || [], cache.sent || {}, cache.activeProfileId || null);
      console.log(`[NYX CRM] 📦 ✅ FORCE_VAULT_SYNC complete (from cache)`);
      return;
    }
    console.log(`[NYX CRM] 📦 No cached vault data — trying sidepanel...`);
  } catch (e) {
    console.warn(`[NYX CRM] 📦 Cache read failed:`, e.message);
  }

  // Strategy 2: Ask sidepanel to trigger a fresh vault sync
  try {
    await chrome.runtime.sendMessage({ type: 'CRM_TRIGGER_VAULT_SYNC' });
    console.log(`[NYX CRM] 📦 ✅ Sent CRM_TRIGGER_VAULT_SYNC to sidepanel`);
    // Sidepanel will call notifyNyxCrmVaultChanged() → NYX_CRM_VAULT_SYNC → syncVaultToFirestore
  } catch {
    throw new Error('No cached vault data and sidepanel not open — please open Clarity sidepanel and try again');
  }
}

/** Execute REFRESH_VAULT_URLS — asks sidepanel to refresh expired signed URLs
 *  and sync fresh ones back to NYX Firestore.
 *  1. Sends CRM_REFRESH_VAULT_URLS to sidepanel
 *  2. Sidepanel calls refreshDownloadURLs() → notifyNyxCrmVaultChanged()
 *  3. Fresh URLs flow back to CRM via Firestore onSnapshot */
export async function executeRefreshVaultUrls(cmd) {
  console.log(`[NYX CRM] 🔄 Executing REFRESH_VAULT_URLS (reason: ${cmd.reason || 'unknown'})...`);

  try {
    await chrome.runtime.sendMessage({ type: 'CRM_REFRESH_VAULT_URLS' });
    console.log(`[NYX CRM] 🔄 ✅ Sent CRM_REFRESH_VAULT_URLS to sidepanel`);
  } catch {
    // Sidepanel not open — try FORCE_VAULT_SYNC as fallback (uses cached data)
    console.log(`[NYX CRM] 🔄 Sidepanel not open — falling back to FORCE_VAULT_SYNC...`);
    await executeForceVaultSync(cmd);
  }
}

/** Execute SEND_MEDIA — sends a media item directly to the OF content tab.
 *  Bypasses sidepanel entirely: bridge → content script → sendImageToChat().
 *  On success, auto-marks the item as sent via executeMarkSent().
 *
 *  CRITICAL: The file is downloaded HERE in the background script, NOT in the
 *  content script. In MV3, content script fetch() is subject to the PAGE's CORS
 *  (onlyfans.com), which can't access firebasestorage.googleapis.com. The background
 *  service worker has host_permissions and bypasses CORS entirely. We download the
 *  file here, convert to base64 data URL, and pass it to the content script. */
export async function executeSendMedia(cmd) {
  const { fanId, mediaId, downloadURL } = cmd;
  if (!fanId || !mediaId) throw new Error('Missing fanId or mediaId');
  if (!downloadURL) throw new Error('Missing downloadURL — media must have a permanent CRM storage URL');

  console.log(`[NYX CRM] 📷 Executing SEND_MEDIA: media ${mediaId} to fan ${fanId}`);
  console.log(`[NYX CRM] 📷 URL: ${downloadURL.substring(0, 100)}...`);

  // Step 1: Find the active OnlyFans tab
  const ofTab = await findOfTab();
  if (!ofTab) {
    throw new Error('No OnlyFans tab found — please open OnlyFans in a browser tab');
  }

  // ── Send Lock: block all user interaction while media is being sent ──
  await sendLockToTab(ofTab.id, 'Sending media…');
  try {

  // Step 2: Download the file in the background script (avoids MV3 content script CORS)
  console.log(`[NYX CRM] 📷 Downloading media in background script (MV3 CORS workaround)...`);
  let dataUrl;
  try {
    const response = await fetch(downloadURL);
    if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
    const blob = await response.blob();
    const mimeType = blob.type || 'image/jpeg';
    // Convert blob to base64 data URL using FileReader-compatible approach for service worker
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 8192; // Process in chunks to avoid call stack overflow on large files
    for (let i = 0; i < bytes.byteLength; i += CHUNK) {
      const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength));
      binary += String.fromCharCode(...slice);
    }
    const base64 = btoa(binary);
    dataUrl = `data:${mimeType};base64,${base64}`;
    console.log(`[NYX CRM] 📷 Downloaded ${(bytes.byteLength / 1024).toFixed(0)}KB, type: ${mimeType}`);
  } catch (err) {
    throw new Error(`Failed to download media from CRM storage: ${err.message}`);
  }

  // Step 3: Send CRM_SEND_MEDIA to the content script with base64 data URL (no CORS needed)
  try {
    const result = await chrome.tabs.sendMessage(ofTab.id, {
      type: 'CRM_SEND_MEDIA',
      fanId,
      mediaId,
      downloadURL: dataUrl, // base64 data URL — content script handles natively
      autoSend: false,
    });

    if (result?.success) {
      const wasSent = result.sent === true;
      const wasStaged = result.staged === true;
      console.log(`[NYX CRM] 📷 ✅ Media ${mediaId} ${wasStaged ? 'STAGED (not sent)' : 'injected'} into OF chat for fan ${fanId}`);

      // Step 4: Only mark as sent if the media was actually sent (not just staged)
      if (wasSent) {
        try {
          await executeMarkSent({ fanId, mediaId });
          console.log(`[NYX CRM] 📷 ✅ Auto-marked media ${mediaId} as sent to fan ${fanId}`);
        } catch (markErr) {
          console.warn(`[NYX CRM] 📷 ⚠️ Media sent but mark-sent failed:`, markErr.message);
        }
      } else {
        console.log(`[NYX CRM] 📷 📋 Media ${mediaId} staged only — NOT marking as sent (user will send manually)`);
      }
    } else {
      throw new Error(result?.error || 'Content script returned failure');
    }
  } catch (err) {
    if (err.message?.includes('Content script returned failure')) throw err;
    throw new Error(`Failed to send media to OF tab: ${err.message}`);
  }
  } finally {
    await sendUnlockToTab(ofTab.id);
  }
}

/** Execute MARK_SENT — marks a media item as sent to a subscriber in Clarity's sentImagesMap.
 *  Two-pronged: (1) relay to sidepanel for Clarity local state, (2) write directly to Firestore
 *  so the CRM's onSnapshot fires immediately (~1s) instead of waiting for the debounced vault sync. */
export async function executeMarkSent(cmd) {
  const { fanId, mediaId } = cmd;
  if (!fanId || !mediaId) throw new Error('Missing fanId or mediaId');

  console.log(`[NYX CRM] ✅ Executing MARK_SENT: media ${mediaId} for fan ${fanId}`);

  // 1. Relay to sidepanel (updates Clarity's local sentImagesMap + localStorage)
  try {
    await chrome.runtime.sendMessage({
      type: 'CRM_VAULT_MARK_SENT',
      fanId,
      mediaId,
    });
  } catch {
    console.log(`[NYX CRM] Sidepanel not open — continuing with direct Firestore write`);
  }

  // 2. DIRECT Firestore write — bypasses the 3s debounce so CRM onSnapshot fires immediately
  try {
    const currentDoc = await getDoc(`vault_data/${dataKey()}`);
    const currentSent = (currentDoc?.sent && typeof currentDoc.sent === 'object') ? { ...currentDoc.sent } : {};

    if (!currentSent[fanId]) currentSent[fanId] = [];
    if (Array.isArray(currentSent[fanId])) {
      if (!currentSent[fanId].includes(mediaId)) {
        currentSent[fanId] = [...currentSent[fanId], mediaId];
      }
    }

    await patchDoc(`vault_data/${dataKey()}`, {
      sent: currentSent,
      syncedAt: new Date().toISOString(),
    });
    console.log(`[NYX CRM] ✅ MARK_SENT: directly wrote to Firestore for fan ${fanId}`);
  } catch (e) {
    console.warn(`[NYX CRM] ⚠️ MARK_SENT direct Firestore write failed:`, e.message);
  }
}

/** Execute UNMARK_SENT — removes sent status for a media item.
 *  Two-pronged: (1) relay to sidepanel, (2) direct Firestore write for instant CRM update. */
export async function executeUnmarkSent(cmd) {
  const { fanId, mediaId } = cmd;
  if (!fanId || !mediaId) throw new Error('Missing fanId or mediaId');

  console.log(`[NYX CRM] ↩️ Executing UNMARK_SENT: media ${mediaId} for fan ${fanId}`);

  // 1. Relay to sidepanel (updates Clarity's local state)
  try {
    await chrome.runtime.sendMessage({
      type: 'CRM_VAULT_UNMARK_SENT',
      fanId,
      mediaId,
    });
  } catch {
    console.log(`[NYX CRM] Sidepanel not open — continuing with direct Firestore write`);
  }

  // 2. DIRECT Firestore write — bypasses debounce so CRM onSnapshot fires immediately
  try {
    const currentDoc = await getDoc(`vault_data/${dataKey()}`);
    const currentSent = (currentDoc?.sent && typeof currentDoc.sent === 'object') ? { ...currentDoc.sent } : {};

    if (Array.isArray(currentSent[fanId])) {
      currentSent[fanId] = currentSent[fanId].filter(id => id !== mediaId);
    }

    await patchDoc(`vault_data/${dataKey()}`, {
      sent: currentSent,
      syncedAt: new Date().toISOString(),
    });
    console.log(`[NYX CRM] ↩️ UNMARK_SENT: directly wrote to Firestore for fan ${fanId}`);
  } catch (e) {
    console.warn(`[NYX CRM] ⚠️ UNMARK_SENT direct Firestore write failed:`, e.message);
  }
}

/** Sync only the sent map to NYX Firestore (lightweight — no pool/vaults).
 *  Called by the immediate sent sync path from Clarity sidepanel.
 *  @param {Object} sent — sent tracking map
 *  @param {string|null} vaultProfileId — optional per-profile key override */
export async function syncSentToFirestore(sent, vaultProfileId = null) {
  if (!S.nyxModelId || !S.isInitialized) return;
  // Always prefer bridge's dataKey() (NYX CRM profile/model ID)
  const key = dataKey() || vaultProfileId;
  try {
    await patchDoc(`vault_data/${key}`, {
      sent: sent || {},
      syncedAt: new Date().toISOString(),
    });
    console.log(`[NYX CRM] 📦 Sent map synced to Firestore (${key}): ${Object.keys(sent || {}).length} subscribers`);
  } catch (e) {
    console.warn(`[NYX CRM] ❌ syncSentToFirestore error:`, e.message);
  }
}

// ============================================================
// VAULT CRUD — Commands from CRM to modify Clarity's local vault
// ============================================================
// These relay to the sidepanel via chrome.runtime.sendMessage.
// The sidepanel's messageListener.js calls the corresponding
// imagePool.js functions (moveMediaToVault, createVault, etc.)
// which update localStorage and trigger debounced Firestore sync.

/** Execute VAULT_MOVE_MEDIA — moves a media item to a different vault folder */
export async function executeVaultMoveMedia(cmd) {
  const { mediaId, vaultId } = cmd;
  if (!mediaId) throw new Error('Missing mediaId');

  console.log(`[NYX CRM] 📦 Executing VAULT_MOVE_MEDIA: media ${mediaId} → vault ${vaultId || 'default'}`);

  try {
    await chrome.runtime.sendMessage({
      type: 'CRM_VAULT_MOVE_MEDIA',
      mediaId,
      vaultId: vaultId || 'default',
    });
  } catch {
    throw new Error('Clarity sidepanel not open — please open the sidepanel and try again');
  }
}

/** Execute VAULT_CREATE — creates a new vault folder */
export async function executeVaultCreate(cmd) {
  const { vaultName } = cmd;
  if (!vaultName) throw new Error('Missing vaultName');

  console.log(`[NYX CRM] 📁 Executing VAULT_CREATE: "${vaultName}"`);

  try {
    await chrome.runtime.sendMessage({
      type: 'CRM_VAULT_CREATE',
      vaultName,
    });
  } catch {
    throw new Error('Clarity sidepanel not open — please open the sidepanel and try again');
  }
}

/** Execute VAULT_RENAME — renames an existing vault folder */
export async function executeVaultRename(cmd) {
  const { vaultId, newName } = cmd;
  if (!vaultId || !newName) throw new Error('Missing vaultId or newName');

  console.log(`[NYX CRM] ✏️ Executing VAULT_RENAME: vault ${vaultId} → "${newName}"`);

  try {
    await chrome.runtime.sendMessage({
      type: 'CRM_VAULT_RENAME',
      vaultId,
      newName,
    });
  } catch {
    throw new Error('Clarity sidepanel not open — please open the sidepanel and try again');
  }
}

/** Execute VAULT_DELETE — deletes a vault folder (media moves to default) */
export async function executeVaultDelete(cmd) {
  const { vaultId } = cmd;
  if (!vaultId) throw new Error('Missing vaultId');

  console.log(`[NYX CRM] 🗑️ Executing VAULT_DELETE: vault ${vaultId}`);

  try {
    await chrome.runtime.sendMessage({
      type: 'CRM_VAULT_DELETE',
      vaultId,
    });
  } catch {
    throw new Error('Clarity sidepanel not open — please open the sidepanel and try again');
  }
}

/** Execute VAULT_DELETE_MEDIA — deletes a media item from the pool entirely */
export async function executeVaultDeleteMedia(cmd) {
  const { mediaId } = cmd;
  if (!mediaId) throw new Error('Missing mediaId');

  console.log(`[NYX CRM] 🗑️ Executing VAULT_DELETE_MEDIA: media ${mediaId}`);

  try {
    await chrome.runtime.sendMessage({
      type: 'CRM_VAULT_DELETE_MEDIA',
      mediaId,
    });
  } catch {
    throw new Error('Clarity sidepanel not open — please open the sidepanel and try again');
  }
}

/**
 * Queue a CLEANUP command to the Firestore queue — identical to what the CRM does.
 * The bridge's pollCommands() will pick it up and run executeCleanup() with the
 * correct flow: delete all → scroll to top → scrape all → isFullSync: true → cleanedUp: true.
 * @param {string} fanId - The subscriber's OF ID
 * @param {string} [fanName='Fan'] - Display name for progress UI
 */
export async function queueCleanup(fanId, fanName = 'Fan') {
  if (!S.nyxModelId || !S.isInitialized) {
    throw new Error('CRM bridge not active — cannot queue cleanup');
  }
  if (!fanId) throw new Error('Missing fanId');

  const cleanFanId = String(fanId).replace(/^of:/i, '');
  const docId = `cleanup-${cleanFanId}-${Date.now()}`;
  const queuePath = `of_chat_commands/${dataKey()}/queue/${docId}`;

  await patchDoc(queuePath, {
    type: 'CLEANUP',
    fanId: cleanFanId,
    fanName,
    status: 'pending',
    createdAt: new Date().toISOString(),
    source: 'clarity-sidepanel',
  });

  console.log(`[NYX CRM] 🧹 Queued CLEANUP command for fan ${cleanFanId} (${fanName}) — docId: ${docId}`);
  return { success: true, docId };
}

