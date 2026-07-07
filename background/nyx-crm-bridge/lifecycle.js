// ============================================================
// NYX CRM BRIDGE — Lifecycle, Init, Public API
// ============================================================

import { FIRESTORE_BASE, HEARTBEAT_INTERVAL, COMMAND_POLL_INTERVAL, DRAFT_SYNC_INTERVAL } from './constants.js';
import { S, dataKey } from './state.js';
import { signIn, finalizeMfaSignIn, refreshToken, getToken } from './auth.js';
import { patchDoc, runQuery, getDoc, deleteDoc, deleteCollection, extractValue } from './firestore.js';
import { sendHeartbeat, startHeartbeat, stopHeartbeat } from './heartbeat.js';
import { startCommandPolling, stopCommandPolling, pollCommands } from './commands.js';
import { syncMessages, clearFanCache } from './chat-sync.js';
import { _setEnsureSyncReady } from './chat-sync.js';
import { parseSpentAmount } from './utils.js';
import { syncVaultToFirestore, syncSentToFirestore } from './vault.js';
import { initOFPresence, stopOFPresence } from '../of-presence.js';

// Draft sync — imported for start/stop
let _draftSyncTick = null;
function startDraftSync() {
  // Lazy import to avoid circular
  if (!_draftSyncTick) {
    import('./draft-sync.js').then(m => {
      _draftSyncTick = m.draftSyncTick;
      if (S.draftSyncTimer) clearInterval(S.draftSyncTimer);
      S.draftSyncTimer = setInterval(_draftSyncTick, DRAFT_SYNC_INTERVAL);
      console.log('[NYX CRM] Draft sync started (every 2s)');
    });
    return;
  }
  if (S.draftSyncTimer) clearInterval(S.draftSyncTimer);
  S.draftSyncTimer = setInterval(_draftSyncTick, DRAFT_SYNC_INTERVAL);
  console.log('[NYX CRM] Draft sync started (every 2s)');
}

function stopDraftSync() {
  if (S.draftSyncTimer) { clearInterval(S.draftSyncTimer); S.draftSyncTimer = null; }
  S.lastRemoteDraftTs = null;
  S.lastRemoteActionTs = null;
  S.lastCurrentDraftJson = '';
  S.lastDraftSyncFanId = null;
  S.initialDraftText = '';
  S.skipDraftPollUntil = 0;
}

/** Ensure the bridge is ready for message sync operations.
 *  If not initialized (common after MV3 service worker restart),
 *  attempts to re-init from storage before giving up.
 *  Deduplicates concurrent init attempts via S.initPromise.
 *  @returns {boolean} true if ready, false if unrecoverable */
export async function ensureSyncReady() {
  if (S.isInitialized && S.nyxModelId && S.nyxIdToken) return true;

  // Already attempting init — wait for it
  if (S.initPromise) {
    try {
      await S.initPromise;
      return S.isInitialized && !!S.nyxModelId;
    } catch {
      return false;
    }
  }

  // Attempt recovery
  console.log('[NYX CRM] 🔄 syncMessages: bridge not ready — attempting auto-recovery...');
  S.initPromise = initNyxCrmBridge();
  try {
    const ok = await S.initPromise;
    S.initPromise = null;
    if (ok) {
      console.log('[NYX CRM] ✅ Auto-recovery successful — bridge re-initialized');
      return true;
    }
    console.warn('[NYX CRM] ⚠️ Auto-recovery failed — bridge could not init');
    return false;
  } catch (e) {
    S.initPromise = null;
    console.warn('[NYX CRM] ❌ Auto-recovery error:', e.message);
    return false;
  }
}

// ============================================================
// INITIALIZATION
// ============================================================

/** Initialize the NYX CRM bridge (called on service worker start + storage changes) */
export async function initNyxCrmBridge() {
  try {
    const result = await chrome.storage.local.get(['nyxCrmConfig', 'nyxCrmRefreshToken']);
    const config = result.nyxCrmConfig;

    if (!config?.modelId) {
      console.log('[NYX CRM] ⚠️ Not configured — no modelId');
      return false;
    }

    S.nyxModelId = config.modelId;
    S.nyxProfileId = config.profileId || null;  // Restore profileId from config

    // Strategy 1: Try stored refresh token first (bypasses MFA entirely)
    if (result.nyxCrmRefreshToken) {
      S.nyxRefreshToken = result.nyxCrmRefreshToken;
      const refreshed = await refreshToken();
      if (refreshed) {
        startHeartbeat();
        startCommandPolling();
        startDraftSync();
        initOFPresence(getToken, dataKey, FIRESTORE_BASE);
        S.isInitialized = true;
        console.log(`[NYX CRM] ✅ Bridge initialized via refresh token — model=${S.nyxModelId}, profile=${S.nyxProfileId || 'none'}, dataKey=${dataKey()}`);
        return true;
      }
      console.warn('[NYX CRM] ⚠️ Stored refresh token expired, trying password...');
    }

    // Strategy 2: Fall back to email/password (only works for non-MFA accounts)
    if (config.email && config.password) {
      const authResult = await signIn(config.email, config.password);
      if (authResult.mfaRequired) {
        console.warn('[NYX CRM] ⚠️ MFA required — cannot auto-reconnect. User must re-authenticate via Settings.');
        return false;
      }
      startHeartbeat();
      startCommandPolling();
      startDraftSync();
      initOFPresence(getToken, dataKey, FIRESTORE_BASE);
      S.isInitialized = true;
      console.log(`[NYX CRM] ✅ Bridge initialized via password — model=${S.nyxModelId}, profile=${S.nyxProfileId || 'none'}, dataKey=${dataKey()}`);
      return true;
    }

    console.log('[NYX CRM] ⚠️ No refresh token or credentials available');
    return false;
  } catch (e) {
    console.error('[NYX CRM] ❌ Bridge init failed:', e.message);
    S.isInitialized = false;
    return false;
  }
}

/** Stop the bridge (cleanup) */
export function stopNyxCrmBridge() {
  stopHeartbeat();
  stopCommandPolling();
  stopDraftSync();
  stopOFPresence();
  S.nyxIdToken = null;
  S.nyxRefreshToken = null;
  S.nyxModelId = null;
  S.nyxProfileId = null;
  S.isInitialized = false;
  console.log('[NYX CRM] 🛑 Bridge stopped');
}

/** Check if bridge is active */
export function isNyxBridgeActive() {
  return S.isInitialized && !!S.nyxModelId;
}

/** Get current bridge status (for UI) */
export function getNyxBridgeStatus() {
  return {
    initialized: S.isInitialized,
    modelId: S.nyxModelId,
    profileId: S.nyxProfileId,
    dataKey: dataKey(),
    hasToken: !!S.nyxIdToken,
  };
}

export async function connectNyxCrm(email, password) {
  const result = await signIn(email, password);

  if (result.mfaRequired) {
    // Store email/password temporarily so verifyNyxMfa can save them after MFA
    await chrome.storage.local.set({ nyxCrmAuth: { email, password } });
    return result; // { mfaRequired, mfaPendingCredential, mfaEnrollmentId, mfaDisplayName }
  }

  // No MFA — store credentials for auto-reconnect
  await chrome.storage.local.set({ nyxCrmAuth: { email, password } });
  return { mfaRequired: false };
}

/**
 * Verify MFA TOTP code after connectNyxCrm returned mfaRequired: true.
 * On success, the user is fully authenticated and ready to fetch models.
 */
export async function verifyNyxMfa(mfaPendingCredential, mfaEnrollmentId, totpCode) {
  await finalizeMfaSignIn(mfaPendingCredential, mfaEnrollmentId, totpCode);
  return true;
}

/**
 * Fetch models from NYX Firestore (users with role=model).
 * Requires prior signIn().
 */
export async function fetchNyxModels() {
  const token = await getToken();
  if (!token) throw new Error('Not authenticated with NYX CRM');

  const url = `${FIRESTORE_BASE}:runQuery`;
  const structuredQuery = {
    from: [{ collectionId: 'users' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'role' },
        op: 'EQUAL',
        value: { stringValue: 'model' },
      },
    },
    limit: 50,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery }),
  });

  if (!res.ok) throw new Error('Failed to fetch models from NYX');
  const results = await res.json();

  return results
    .filter(r => r.document)
    .map(r => {
      const doc = r.document;
      const id = doc.name.split('/').pop();
      const fields = {};
      if (doc.fields) {
        for (const [k, v] of Object.entries(doc.fields)) fields[k] = extractValue(v);
      }
      return { id, displayName: fields.displayName || fields.email || id, email: fields.email || '', ofProfiles: fields.ofProfiles || [] };
    });
}

/**
 * Select a model and start the bridge.
 * Saves full config to storage so bridge auto-starts on reload.
 */
export async function selectNyxModel(modelId, profileId = null) {
  const stored = await chrome.storage.local.get(['nyxCrmAuth']);
  const auth = stored.nyxCrmAuth;
  if (!auth?.email || !auth?.password) throw new Error('Not authenticated — connect first');

  // Prevent storage listener from killing the bridge we're about to start
  S.skipNextStorageChange = true;

  // Save full config for auto-reconnect on service worker restart
  await chrome.storage.local.set({
    nyxCrmConfig: { email: auth.email, password: auth.password, modelId, profileId },
  });

  // Start immediately — we already have a valid token from connectNyxCrm/verifyNyxMfa
  S.nyxModelId = modelId;
  S.nyxProfileId = profileId;
  startHeartbeat();
  startCommandPolling();
  startDraftSync();
  S.isInitialized = true;

  // [ORPHAN CLEANUP] Clean up commands stuck in "processing" for > 5 min
  try {
    const stuckCmds = await runQuery(
      `of_chat_commands/${profileId || modelId}`, 'queue',
      [{ field: 'status', value: 'processing' }]
    );
    const FIVE_MIN = 5 * 60 * 1000;
    for (const cmd of stuckCmds) {
      const processedAt = cmd.processedAt ? new Date(cmd.processedAt).getTime() : 0;
      if (Date.now() - processedAt > FIVE_MIN) {
        const cmdPath = `of_chat_commands/${profileId || modelId}/queue/${cmd.id}`;
        await patchDoc(cmdPath, { status: 'failed', error: 'Orphaned — stuck in processing > 5 min', failedAt: new Date().toISOString() });
        console.log(`[NYX CRM] Orphan cleanup: failed stuck command ${cmd.id} (type=${cmd.type})`);
      }
    }
  } catch (e) { console.warn('[NYX CRM] Orphan cleanup error (non-critical):', e.message); }

  console.log(`[NYX CRM] ✅ Model selected and bridge started: model=${modelId}, profile=${profileId || 'none (using modelId)'}`);
  return true;
}

/**
 * NUKE_CHAT — delete ALL Firebase data for a single fan conversation.
 * Called from sidepanel's "Delete All" button via background handler.
 * Deletes: all message docs + conversation summary doc.
 */
export async function nukeChat(subscriberId) {
  if (!S.nyxModelId || !S.isInitialized) {
    console.warn('[NYX CRM] nukeChat skipped — bridge not active');
    return { success: false, error: 'CRM bridge not active' };
  }

  const fanId = String(subscriberId).replace(/^of:/i, '');
  if (!fanId) return { success: false, error: 'Invalid subscriber ID' };

  console.log(`[NYX CRM] 🗑️ NUKE_CHAT — deleting all Firebase data for fan ${fanId}...`);

  // Step 1: Delete all message documents
  const msgPath = `of_chats/${dataKey()}/conversations/${fanId}/messages`;
  const deletedMsgs = await deleteCollection(msgPath);

  // Step 2: Delete the conversation summary document
  const convPath = `of_chats/${dataKey()}/conversations/${fanId}`;
  const convDeleted = await deleteDoc(convPath);

  // Step 3: Clear in-memory dedup cache so next sync starts fresh
  clearFanCache(fanId);

  console.log(`[NYX CRM] 🗑️ NUKE_CHAT complete — ${deletedMsgs} messages deleted, conv doc: ${convDeleted ? 'deleted' : 'not found'}`);
  return { success: true, deletedMessages: deletedMsgs, conversationDeleted: convDeleted };
}

/**
 * Sync spending data for a specific subscriber to NYX CRM Firestore.
 * Called when subscriber stats are fetched/refreshed (notes.totalSpent updated).
 * @param {string} subscriberId - The subscriber's OF ID (may include "of:" prefix)
 * @param {string|number} totalSpent - The total spent value (string like "$150.00" or number)
 */
export async function syncSpending(subscriberId, totalSpent) {
  if (!S.nyxModelId || !S.isInitialized) return;
  const fanId = String(subscriberId).replace(/^of:/i, '');
  if (!fanId) return;

  const amount = parseSpentAmount(totalSpent);
  if (amount <= 0) return;

  try {
    await patchDoc(`of_chats/${dataKey()}/conversations/${fanId}`, {
      totalSpent: amount,
    });
    console.log(`[NYX CRM] 💰 Synced spending for fan ${fanId}: $${amount.toFixed(2)}`);
  } catch (e) {
    console.warn(`[NYX CRM] ❌ syncSpending error for fan ${fanId}:`, e.message);
  }
}

/** Sync fan profile stats (subscribed days, spent, etc.) to Firestore conversation doc */
export async function syncFanProfile(subscriberId, stats) {
  if (!S.nyxModelId || !S.isInitialized) return;
  const fanId = String(subscriberId).replace(/^of:/i, '');
  if (!fanId || !stats) return;

  try {
    const doc = { lastProfileScan: new Date().toISOString() };

    if (stats.subscribedDays != null) doc.subscribedDays = Number(stats.subscribedDays) || 0;
    if (stats.subscribedSince) doc.subscribedSince = stats.subscribedSince;
    if (stats.totalSpent != null) {
      const amount = parseSpentAmount(stats.totalSpent);
      if (amount > 0) doc.totalSpent = amount;
    }

    await patchDoc(`of_chats/${dataKey()}/conversations/${fanId}`, doc);
    console.log(`[NYX CRM] 📊 Synced fan profile for ${fanId}:`, doc);
  } catch (e) {
    console.warn(`[NYX CRM] ❌ syncFanProfile error for fan ${fanId}:`, e.message);
  }
}

/** Set task days on a fan's conversation doc (from CRM ADD_TASK command) */
export async function setTaskDays(subscriberId, taskDays) {
  if (!S.nyxModelId || !S.isInitialized) return;
  const fanId = String(subscriberId).replace(/^of:/i, '');
  if (!fanId) return;

  try {
    await patchDoc(`of_chats/${dataKey()}/conversations/${fanId}`, {
      taskDays: Number(taskDays) || 0,
      taskDaysUpdatedAt: new Date().toISOString(),
    });
    console.log(`[NYX CRM] 🎯 Set task days for fan ${fanId}: ${taskDays}`);
  } catch (e) {
    console.warn(`[NYX CRM] ❌ setTaskDays error for fan ${fanId}:`, e.message);
  }
}

/** Disconnect and clear config */
export async function disconnectNyxCrm() {
  S.skipNextStorageChange = true; // prevent listener from re-initing after we clear config
  stopNyxCrmBridge();
  await chrome.storage.local.remove(['nyxCrmConfig', 'nyxCrmAuth', 'nyxCrmRefreshToken']);
  console.log('[NYX CRM] 🔌 Disconnected and config cleared');
  return true;
}

// ============================================================
// ALARM-BASED KEEPALIVE — survives service worker suspension
// ============================================================
// Chrome MV3 suspends the service worker after ~30s of inactivity,
// killing all setInterval timers (heartbeat + command polling).
// chrome.alarms is the ONLY timer that survives suspension.
// When the alarm fires, it wakes the SW and we:
//   1. Re-init from storage if in-memory state was lost
//   2. Send heartbeat + poll commands
//   3. Restart fast intervals for the next ~30s of active life

/** Called by index.js when the keepalive alarm fires.
 *  This is the CRITICAL path that keeps the bridge alive during idle periods. */
export async function ensureBridgeAlive() {
  // Check if in-memory state was wiped by SW suspension
  if (!S.nyxModelId || !S.nyxIdToken) {
    // State lost — try to restore from storage
    const result = await chrome.storage.local.get(['nyxCrmConfig', 'nyxCrmRefreshToken']);
    const config = result.nyxCrmConfig;
    if (!config?.modelId) return; // Not configured — nothing to do

    if (!S.nyxModelId) S.nyxModelId = config.modelId;
    if (!S.nyxProfileId) S.nyxProfileId = config.profileId || null;

    // Restore auth token
    if (result.nyxCrmRefreshToken && !S.nyxIdToken) {
      S.nyxRefreshToken = result.nyxCrmRefreshToken;
      const ok = await refreshToken();
      if (!ok) {
        // Try email/password as fallback
        if (config.email && config.password) {
          const authResult = await signIn(config.email, config.password);
          if (authResult.mfaRequired) return; // Can't auto-recover MFA
        } else {
          return;
        }
      }
    }

    S.isInitialized = true;
    console.log('[NYX CRM] ⏰ Alarm restored bridge state from storage (SW was suspended)');
  }

  // Now do the actual work: heartbeat + command poll
  await sendHeartbeat();
  await pollCommands();

  // Restart fast intervals (they'll run for ~30s until SW suspends again)
  if (!S.heartbeatTimer) {
    S.heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  }
  if (!S.commandPollTimer) {
    S.commandPollTimer = setInterval(pollCommands, COMMAND_POLL_INTERVAL);
  }
  if (!S.draftSyncTimer && _draftSyncTick) {
    S.draftSyncTimer = setInterval(_draftSyncTick, DRAFT_SYNC_INTERVAL);
  }
}

/**
 * Handle CHAT_MESSAGES or NEW_MESSAGE from the content script.
 * Called by index.js with sender info already extracted.
 * @param {string} type - 'CHAT_MESSAGES' or 'NEW_MESSAGE'
 * @param {string} fanId - Fan ID extracted from the OF chat URL
 * @param {object|Array} data - message.data from the content script
 * @returns {Promise<{synced: boolean, error?: string}>}
 */
export async function handleCrmChatMessage(type, fanId, data) {
  console.log(`[NYX CRM] 🔴 handleCrmChatMessage: type=${type}, fan=${fanId}, init=${S.isInitialized}, model=${!!S.nyxModelId}, token=${!!S.nyxIdToken}, cleanup=${S.cleanupInProgress}`);

  // ── Guard: block ALL content script syncs during cleanup to prevent race conditions ──
  // Without this, navigateCrmTab during cleanup loads the chat → content script extracts
  // visible messages → sends CHAT_MESSAGES here → we'd write them BEFORE cleanup finishes
  // deleting + rescanning → stale/duplicate messages survive.
  if (S.cleanupInProgress) {
    console.log(`[NYX CRM] 🚫 handleCrmChatMessage BLOCKED — cleanup in progress`);
    return { synced: false, reason: 'cleanup in progress' };
  }

  // ── Guard: block CHAT_MESSAGES during OPEN_CHAT to prevent parallel duplicate writes ──
  // When OPEN_CHAT navigates the OF tab, autoLoadChat fires and sends CHAT_MESSAGES here.
  // That would run syncMessages IN PARALLEL with OPEN_CHAT's own syncMessages, and messages
  // without stable OF data-id get random fallback IDs each call → new Firestore docs each time.
  // NEW_MESSAGE is NOT blocked — single new messages during OPEN_CHAT are fine (they have real IDs).
  if (S.openChatInProgress && type === 'CHAT_MESSAGES') {
    console.log(`[NYX CRM] 🚫 handleCrmChatMessage BLOCKED — OPEN_CHAT in progress (suppressing CHAT_MESSAGES to prevent duplicates)`);
    return { synced: false, reason: 'open chat in progress' };
  }

  // ── NEW_MESSAGE — always sync immediately (single message, no rate limit) ──
  if (type === 'NEW_MESSAGE') {
    const msg = data;
    if (!msg || (!msg.text && !msg.mediaThumbnail && !msg.mediaType)) {
      return { synced: false, reason: 'empty message' };
    }

    // Simple dedup: skip if exact same message ID just synced
    const msgKey = msg.id || `${msg.text}|${msg.isFromMe}`;
    if (msgKey === S.lastSyncedNewMsgId) {
      return { synced: false, reason: 'dedup' };
    }
    S.lastSyncedNewMsgId = msgKey;

    console.log(`[NYX CRM] 📨 NEW_MESSAGE → fan ${fanId}: "${(msg.text || '').slice(0, 50)}" (id=${msg.id || 'none'})`);

    try {
      if (!S.isInitialized || !S.nyxModelId || !S.nyxIdToken) {
        const ready = await ensureSyncReady();
        if (!ready) {
          console.error('[NYX CRM] 📨 ❌ Bridge not ready for NEW_MESSAGE — dropped');
          return { synced: false, error: 'bridge not ready' };
        }
      }
      await syncMessages(null, fanId, 'Fan', [msg]);
      console.log(`[NYX CRM] 📨 ✅ NEW_MESSAGE synced for fan ${fanId}`);
      return { synced: true };
    } catch (e) {
      console.error('[NYX CRM] 📨 ❌ NEW_MESSAGE sync error:', e.message);
      return { synced: false, error: e.message };
    }
  }

  // ── CHAT_MESSAGES — batch sync with rate limit ──
  if (type === 'CHAT_MESSAGES') {
    const allMessages = Array.isArray(data) ? data : [];
    if (allMessages.length === 0) {
      return { synced: false, reason: 'empty array' };
    }

    // Sync ALL messages — patchDoc is an idempotent upsert, so writing existing
    // messages just overwrites with the same data. This ensures no messages are
    // ever missed. Rate-limiting dedup below prevents redundant writes.
    const latestId = allMessages[allMessages.length - 1]?.id || '';
    const msgCount = allMessages.length;

    // Dedup: skip if EXACT same content (same fan + same latest ID + same count)
    // No time-based rate limit — patchDoc is idempotent, so duplicate writes are
    // harmless but missed writes cause missing messages in the CRM.
    const now = Date.now();
    const isSameContent = (fanId === S.lastBatchFanId && latestId === S.lastBatchLatestId && latestId !== '' && msgCount === S.lastBatchMsgCount);

    if (isSameContent) {
      return { synced: false, reason: 'dedup (same content)' };
    }

    // Content changed — allow the sync
    S.lastBatchSyncTime = now;
    S.lastBatchFanId = fanId;
    S.lastBatchLatestId = latestId;
    S.lastBatchMsgCount = msgCount;

    console.log(`[NYX CRM] 📨 CHAT_MESSAGES → fan ${fanId}: ${allMessages.length} msgs (latest: ${latestId || 'unknown'}, bridge: init=${S.isInitialized}, model=${!!S.nyxModelId}, token=${!!S.nyxIdToken})`);

    try {
      if (!S.isInitialized || !S.nyxModelId || !S.nyxIdToken) {
        console.log(`[NYX CRM] 📨 Bridge not ready — attempting ensureSyncReady()...`);
        const ready = await ensureSyncReady();
        if (!ready) {
          console.error('[NYX CRM] 📨 ❌ Bridge not ready for CHAT_MESSAGES — dropped');
          return { synced: false, error: 'bridge not ready' };
        }
        console.log(`[NYX CRM] 📨 Bridge recovered — proceeding with sync`);
      }
      await syncMessages(null, fanId, 'Fan', allMessages);
      console.log(`[NYX CRM] 📨 ✅ CHAT_MESSAGES synced for fan ${fanId} (${allMessages.length} msgs)`);
      return { synced: true };
    } catch (e) {
      console.error('[NYX CRM] 📨 ❌ CHAT_MESSAGES sync error:', e.message, e.stack?.split('\n')[1] || '');
      return { synced: false, error: e.message };
    }
  }

  return { synced: false, reason: 'unknown type' };
}

// ============================================================
// FETCH VAULT FROM FIRESTORE — Pull vault data for the current profile
// Called by sidepanel when switching profiles to load per-profile vault data
// ============================================================
/** Fetch vault data from NYX Firestore.
 *  @param {string|null} vaultProfileId — optional per-profile key override */
export async function fetchVaultFromFirestore(vaultProfileId = null) {
  // Always prefer bridge's dataKey() (NYX CRM profile/model ID) — the passed
  // vaultProfileId may be a Clarity-internal profile ID that doesn't match
  // any vault_data document in NYX CRM Firestore.
  const key = dataKey() || vaultProfileId;
  if (!key) return { success: false, error: 'No profile connected' };

  try {
    const doc = await getDoc(`vault_data/${key}`);
    if (!doc) return { success: true, pool: [], vaults: [], sent: {} };

    const pool = Array.isArray(doc.pool) ? doc.pool : [];
    const vaults = Array.isArray(doc.vaults) ? doc.vaults : [];
    const sent = (doc.sent && typeof doc.sent === 'object') ? doc.sent : {};

    console.log(`[NYX CRM] 📦 Fetched vault for ${key}: ${pool.length} items, ${vaults.length} vaults`);
    return { success: true, pool, vaults, sent };
  } catch (e) {
    console.warn(`[NYX CRM] ❌ fetchVaultFromFirestore error:`, e.message);
    return { success: false, error: e.message };
  }
}

// Listen for config changes (re-init if user updates credentials externally)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.nyxCrmConfig) {
    // Skip if selectNyxModel or disconnectNyxCrm already handled the change
    if (S.skipNextStorageChange) {
      S.skipNextStorageChange = false;
      console.log('[NYX CRM] Config changed — skipped (already handled)');
      return;
    }
    console.log('[NYX CRM] Config changed externally — reinitializing bridge...');
    stopNyxCrmBridge();
    setTimeout(initNyxCrmBridge, 1000);
  }
});

// Wire up ensureSyncReady for chat-sync.js (breaks circular dep)
_setEnsureSyncReady(ensureSyncReady);

