// ============================================================
// NYX CRM BRIDGE — Direct Firestore REST API integration
// ============================================================
// Connects Clarity to the NYX CRM dashboard via Firestore.
// - Sends heartbeat every 30s so CRM shows "Clarity Online"
// - Syncs chat list & messages to of_chats collection
// - Polls of_chat_commands queue for CRM-initiated commands
// - Executes SEND_MESSAGE commands via content script
//
// Auth: Uses Firebase Auth REST API with NYX CRM credentials
// stored in chrome.storage.local under 'nyxCrmConfig'
// ============================================================

import { initOFPresence, stopOFPresence } from './of-presence.js';

const NYX_PROJECT_ID = 'nyx-app-998b2';
const NYX_API_KEY = 'AIzaSyB49rt1oYgre4pNgfD9SRnKatCeFQJSWPY';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${NYX_PROJECT_ID}/databases/(default)/documents`;
const AUTH_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${NYX_API_KEY}`;
const REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${NYX_API_KEY}`;
const MFA_FINALIZE_URL = `https://identitytoolkit.googleapis.com/v2/accounts/mfaSignIn:finalize?key=${NYX_API_KEY}`;

const STORAGE_BUCKET = 'nyx-app-998b2.firebasestorage.app';
const STORAGE_UPLOAD_BASE = `https://firebasestorage.googleapis.com/upload/storage/v1/b/${STORAGE_BUCKET}/o`;

const HEARTBEAT_INTERVAL = 30_000;  // 30 seconds
const COMMAND_POLL_INTERVAL = 2_000; // 2 seconds — faster command pickup for near-realtime feel
const DRAFT_SYNC_INTERVAL = 2_000;  // 2 seconds — fast loop for real-time typing
const ALARM_NAME = 'nyx-crm-keepalive';
const ALARM_PERIOD_MINUTES = 0.4;   // ~24 seconds (Chrome allows < 1 min for unpacked dev extensions)

// ── State ──
let nyxIdToken = null;
let nyxRefreshToken = null;
let nyxTokenExpiry = 0;
let nyxModelId = null;      // Model user ID — kept for user doc lookups & backward compat
let nyxProfileId = null;     // OF Profile ID — used as Firestore data key for all collections
let heartbeatTimer = null;
let commandPollTimer = null;
let isInitialized = false;
let skipNextStorageChange = false; // prevents double-init from selectNyxModel + storage listener
let crmChatTabId = null; // Separate tab for OPEN_CHAT so main OF tab keeps monitoring chat list
let cleanupInProgress = false; // Suppresses SAVE_CHAT/SYNC_CHAT sync during cleanup
let cleanupStartedAt = 0;     // Timestamp when cleanup started — safety timeout after 10 min
let openChatInProgress = false; // Suppresses CHAT_MESSAGES sync during OPEN_CHAT (prevents duplicate writes)
let draftSyncTimer = null;
let initPromise = null; // Deduplicates concurrent init attempts
let commandProcessing = false; // Prevents overlapping pollCommands runs

/** Data key for Firestore paths — uses profileId when set, falls back to modelId for backward compat */
function dataKey() { return nyxProfileId || nyxModelId; }

// ── Draft sync state (for real-time CRM ↔ OF typing bridge) ──
let lastRemoteDraftTs = null;       // Timestamp of last remoteDraft we processed
let lastRemoteActionTs = null;      // Timestamp of last remoteDraftAction we processed
let lastCurrentDraftJson = '';      // JSON of last currentDraft we wrote (dedup)
let skipDraftPollUntil = 0;          // Timestamp: skip draft poll after SEND to prevent echo
let lastDraftSyncFanId = null;      // Track which fanId we've already sent initial text for
let initialDraftText = '';           // Cached text from first poll (frozen after initial load)

// ============================================================
// TAB NAVIGATION HELPERS — solve the race condition with tab reuse
// ============================================================

/** Wait for a tab to finish loading after navigation (status === 'complete').
 *  This is CRITICAL: after chrome.tabs.update(tabId, {url}), the old content
 *  script is destroyed and a new one injects once the page loads. Without waiting,
 *  we'd send messages to the dying old content script → 0 messages. */
function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false); // Don't reject — caller handles gracefully
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** Wait for content script to be ready on the CORRECT chat page.
 *  Polls IS_CHAT_READY and verifies the URL contains the expected fanId.
 *  This prevents the old content script (on a different chat) from
 *  falsely responding "ready". */
async function waitForCorrectChat(tabId, fanId, maxAttempts = 30, intervalMs = 500) {
  const expectedUrlPart = `/my/chats/chat/${fanId}`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'IS_CHAT_READY' });
      // Verify BOTH readiness AND correct URL (prevents old content script responding)
      if (res?.ready && res.url && res.url.includes(expectedUrlPart)) {
        console.log(`[NYX CRM] ✅ Content script ready on correct chat (fan ${fanId}) after ${attempt + 1} attempts`);
        return true;
      }
      // Content script responded but wrong URL or not ready yet — keep waiting
      if (res?.url && !res.url.includes(expectedUrlPart)) {
        // Old content script still responding — the page hasn't navigated yet
        continue;
      }
    } catch {
      // Content script not injected yet — keep trying
      continue;
    }
  }

  console.warn(`[NYX CRM] ⚠️ Content script not ready for fan ${fanId} after ${maxAttempts} attempts (${(maxAttempts * intervalMs / 1000).toFixed(0)}s)`);
  return false;
}

/** Navigate the CRM chat tab to a fan's conversation and wait until ready.
 *  Returns the tab ID, or null on failure. Handles tab creation, reuse, and loading.
 *  @param {string} fanId
 *  @param {object} [opts]
 *  @param {boolean} [opts.active=false] - If true, make the tab active (required for cleanup — OF won't render messages in background tabs) */
async function navigateCrmTab(fanId, { active = false } = {}) {
  const chatUrl = `https://onlyfans.com/my/chats/chat/${fanId}`;
  let tabId = null;
  let isNewTab = false;

  // Try to reuse existing CRM chat tab
  if (crmChatTabId) {
    try {
      const existingTab = await chrome.tabs.get(crmChatTabId);
      if (existingTab && existingTab.url?.includes('onlyfans.com')) {
        await chrome.tabs.update(crmChatTabId, { url: chatUrl, active });
        tabId = crmChatTabId;
        console.log(`[NYX CRM] 📂 Reused CRM chat tab ${tabId} — navigating to fan ${fanId} (active=${active})`);
      }
    } catch {
      crmChatTabId = null;
    }
  }

  if (!tabId) {
    const newTab = await chrome.tabs.create({ url: chatUrl, active });
    tabId = newTab.id;
    crmChatTabId = tabId;
    isNewTab = true;
    console.log(`[NYX CRM] 📂 Created new CRM chat tab ${tabId} for fan ${fanId} (active=${active})`);
  }

  // CRITICAL: Wait for tab to fully load (new content script to inject)
  const loaded = await waitForTabLoad(tabId, 30000);
  if (!loaded) {
    console.warn(`[NYX CRM] ⚠️ Tab load timeout for fan ${fanId} — attempting anyway`);
  }

  // Extra buffer for OF's SPA to render the chat DOM
  await new Promise(r => setTimeout(r, 1500));

  // Now wait for content script to confirm it's ready on the CORRECT chat
  const ready = await waitForCorrectChat(tabId, fanId);
  if (!ready) {
    console.warn(`[NYX CRM] ⚠️ Content script not ready for fan ${fanId} — will attempt extraction anyway`);
  }

  // Final DOM stabilization wait
  await new Promise(r => setTimeout(r, 1500));

  return tabId;
}

// ============================================================
// LONG-RUNNING SCAN HELPERS — bypass Chrome's 5-min message timeout
// ============================================================

/**
 * Start a cleanup scan on the content script tab and wait for the result.
 * 
 * Chrome MV3 kills sendMessage response channels after ~5 minutes.
 * For long chats, the scroll+scrape can take 10-30 minutes.
 * 
 * Solution: fire-and-forget pattern.
 *  1. Send CRM_CLEANUP_SCAN — content script responds immediately with { started: true }
 *  2. Content script runs the scan async and sends CLEANUP_SCAN_COMPLETE when done
 *  3. We listen for that message here with a generous timeout
 *
 * @param {number} tabId - The tab to send the scan command to
 * @param {string} fanId - For logging
 * @param {number} timeoutMs - Max time to wait (default 30 min)
 * @returns {Promise<{success: boolean, messages: Array}>}
 */
function waitForCleanupScanComplete(tabId, fanId, timeoutMs = 30 * 60_000) {
  return new Promise(async (resolve, reject) => {
    let resolved = false;
    let timeoutId = null;
    const chunkedMessages = []; // Collect messages from CLEANUP_SCAN_CHUNK messages

    // ── Step 1: Set up listener for CLEANUP_SCAN_COMPLETE and CLEANUP_SCAN_CHUNK ──
    function onMessage(message, sender) {
      // Only accept from the correct tab
      const fromCorrectTab = sender.tab?.id === tabId || !sender.tab;
      if (!fromCorrectTab) return;

      // Collect chunked messages (fallback for large payloads)
      if (message.type === 'CLEANUP_SCAN_CHUNK') {
        if (message.messages) {
          chunkedMessages.push(...message.messages);
          console.log(`[NYX CRM] 🧹 Received chunk ${(message.chunkIndex || 0) + 1}/${message.totalChunks || '?'} (${message.messages.length} msgs, total so far: ${chunkedMessages.length})`);
        }
        return; // Don't resolve yet — wait for CLEANUP_SCAN_COMPLETE
      }

      if (message.type === 'CLEANUP_SCAN_COMPLETE') {
        cleanup();

        // If chunked mode, use the accumulated chunk messages instead of inline messages
        const finalMessages = message.chunked
          ? chunkedMessages
          : (message.messages || []);
        const finalCount = message.chunked
          ? chunkedMessages.length
          : (message.count || finalMessages.length);

        console.log(`[NYX CRM] 🧹 Received CLEANUP_SCAN_COMPLETE for fan ${fanId}: ${finalCount} messages${message.chunked ? ' (chunked)' : ''}${message.thumbnailsStripped ? ' (thumbnails stripped)' : ''}`);
        resolve({
          success: message.success || false,
          messages: finalMessages,
          count: finalCount,
          error: message.error || null,
        });
      }
    }

    function cleanup() {
      if (resolved) return;
      resolved = true;
      chrome.runtime.onMessage.removeListener(onMessage);
      if (timeoutId) clearTimeout(timeoutId);
    }

    // Register listener BEFORE sending the command
    chrome.runtime.onMessage.addListener(onMessage);

    // ── Step 2: Set timeout ──
    timeoutId = setTimeout(() => {
      if (!resolved) {
        cleanup();
        console.warn(`[NYX CRM] ⚠️ Cleanup scan timed out after ${(timeoutMs / 60_000).toFixed(0)} min for fan ${fanId}`);
        resolve({ success: false, messages: [], error: `Cleanup scan timed out (${(timeoutMs / 60_000).toFixed(0)} min)` });
      }
    }, timeoutMs);

    // ── Step 3: Send the scan command (content script responds immediately) ──
    try {
      const ack = await chrome.tabs.sendMessage(tabId, { type: 'CRM_CLEANUP_SCAN' });
      if (!ack?.started && !ack?.success) {
        // Content script couldn't even start — don't wait
        cleanup();
        resolve({ success: false, messages: [], error: 'Content script could not start cleanup scan' });
      } else {
        console.log(`[NYX CRM] 🧹 Cleanup scan started on tab ${tabId} for fan ${fanId} — waiting up to ${(timeoutMs / 60_000).toFixed(0)} min...`);
      }
    } catch (e) {
      cleanup();
      resolve({ success: false, messages: [], error: `Failed to send scan command: ${e.message}` });
    }
  });
}

// ============================================================
// FIREBASE AUTH (REST API)
// ============================================================

/** Sign in to NYX Firebase and get an idToken */
async function signIn(email, password) {
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'NYX auth failed');

  // Firebase MFA challenge: response has mfaPendingCredential but no idToken
  if (data.mfaPendingCredential || !data.idToken) {
    // Return MFA challenge data so the UI can prompt for TOTP code
    const mfaEnrollmentId = data.mfaInfo?.[0]?.mfaEnrollmentId || null;
    return {
      mfaRequired: true,
      mfaPendingCredential: data.mfaPendingCredential,
      mfaEnrollmentId,
      mfaDisplayName: data.mfaInfo?.[0]?.displayName || 'TOTP',
    };
  }

  nyxIdToken = data.idToken;
  nyxRefreshToken = data.refreshToken;
  nyxTokenExpiry = Date.now() + (parseInt(data.expiresIn, 10) * 1000) - 60_000; // refresh 1 min early
  await persistRefreshToken();
  console.log('[NYX CRM] ✅ Authenticated with NYX Firebase');
  return { mfaRequired: false };
}

/**
 * Finalize MFA sign-in with TOTP verification code.
 * Called after signIn() returns mfaRequired: true.
 */
async function finalizeMfaSignIn(mfaPendingCredential, mfaEnrollmentId, totpCode) {
  const res = await fetch(MFA_FINALIZE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mfaPendingCredential,
      mfaEnrollmentId,
      totpVerificationInfo: { verificationCode: totpCode },
    }),
  });
  const data = await res.json();
  if (data.error) {
    const msg = data.error.message || 'MFA verification failed';
    throw new Error(msg.includes('INVALID') ? 'Invalid 2FA code. Please try again.' : msg);
  }
  if (!data.idToken) throw new Error('MFA verification did not return a token');

  nyxIdToken = data.idToken;
  nyxRefreshToken = data.refreshToken;
  nyxTokenExpiry = Date.now() + (parseInt(data.expiresIn, 10) * 1000) - 60_000;
  await persistRefreshToken();
  console.log('[NYX CRM] ✅ MFA verified — authenticated with NYX Firebase');
  return true;
}

/** Refresh the idToken using the refreshToken */
async function refreshToken() {
  if (!nyxRefreshToken) return false;
  try {
    const res = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: nyxRefreshToken }),
    });
    const data = await res.json();
    if (data.error) { console.warn('[NYX CRM] Token refresh failed:', data.error); return false; }
    nyxIdToken = data.id_token;
    nyxRefreshToken = data.refresh_token;
    nyxTokenExpiry = Date.now() + (parseInt(data.expires_in, 10) * 1000) - 60_000;
    await persistRefreshToken();
    return true;
  } catch (e) {
    console.warn('[NYX CRM] Token refresh error:', e.message);
    return false;
  }
}

/** Persist refresh token to storage for service worker restarts */
async function persistRefreshToken() {
  if (nyxRefreshToken) {
    try { await chrome.storage.local.set({ nyxCrmRefreshToken: nyxRefreshToken }); }
    catch (e) { /* silent */ }
  }
}

/** Get a valid idToken (auto-refresh if expired) */
async function getToken() {
  if (!nyxIdToken) return null;
  if (Date.now() > nyxTokenExpiry) {
    const ok = await refreshToken();
    if (!ok) return null;
  }
  return nyxIdToken;
}

// ============================================================
// FIRESTORE REST API HELPERS
// ============================================================

/** Convert JS value to Firestore Value format */
function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) fields[k] = toFirestoreValue(v);
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

/** Build Firestore document body from a plain object */
function buildDoc(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) fields[k] = toFirestoreValue(v);
  }
  return { fields };
}

/** PATCH a Firestore document (create or update) */
async function patchDoc(path, data) {
  const token = await getToken();
  if (!token) return null;

  const fields = Object.keys(data);
  const masks = fields.map(f => `updateMask.fieldPaths=${f}`).join('&');
  const url = `${FIRESTORE_BASE}/${path}?${masks}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(buildDoc(data)),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.warn(`[NYX CRM] PATCH ${path} failed:`, res.status, err.error?.message || '');
    return null;
  }
  return res.json();
}

/** Run a structured query (for filtering commands by status) */
async function runQuery(parentPath, collectionId, filters) {
  const token = await getToken();
  if (!token) return [];

  const url = `${FIRESTORE_BASE}/${parentPath}:runQuery`;
  const structuredQuery = {
    from: [{ collectionId }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: filters.map(f => ({
          fieldFilter: {
            field: { fieldPath: f.field },
            op: f.op || 'EQUAL',
            value: toFirestoreValue(f.value),
          },
        })),
      },
    },
    limit: 10,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery }),
  });

  if (!res.ok) return [];
  const results = await res.json();
  // Filter out empty results (Firestore returns [{readTime}] when no matches)
  return results.filter(r => r.document).map(r => {
    const doc = r.document;
    const id = doc.name.split('/').pop();
    const fields = {};
    if (doc.fields) {
      for (const [k, v] of Object.entries(doc.fields)) {
        fields[k] = extractValue(v);
      }
    }
    return { id, ...fields, _name: doc.name };
  });
}

/** List ALL documents in a Firestore collection, paginating through all pages.
 *  Firestore REST API returns max 300 docs per request + a nextPageToken.
 *  We loop until there are no more pages so cleanup truly deletes everything. */
async function listDocs(collectionPath) {
  const allDocs = [];
  let pageToken = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const token = await getToken();
    if (!token) return allDocs;

    let url = `${FIRESTORE_BASE}/${collectionPath}?pageSize=300`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) break;
      const data = await res.json();
      if (data.documents) {
        for (const doc of data.documents) {
          const id = doc.name.split('/').pop();
          allDocs.push({ id, _name: doc.name });
        }
      }
      // If there's a nextPageToken, keep going; otherwise we're done
      if (data.nextPageToken) {
        pageToken = data.nextPageToken;
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  return allDocs;
}

/** GET a single Firestore document by path — returns parsed fields object or null */
async function getDoc(docPath) {
  const token = await getToken();
  if (!token) return null;
  const url = `${FIRESTORE_BASE}/${docPath}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.fields) return null;
    const fields = {};
    for (const [k, v] of Object.entries(data.fields)) fields[k] = extractValue(v);
    return fields;
  } catch { return null; }
}

/** Delete a single Firestore document by path */
async function deleteDoc(docPath) {
  const token = await getToken();
  if (!token) return false;

  const url = `${FIRESTORE_BASE}/${docPath}`;
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok || res.status === 404; // 404 = already gone, treat as success
  } catch {
    return false;
  }
}

/** Firestore batchWrite — up to 500 writes (update or delete) in a single HTTP request.
 *  This is the core speed optimization: turns N sequential HTTP calls into ceil(N/500) batch calls.
 *  @param {Array<{update?: {path: string, data: object}, delete?: string}>} operations
 *  @returns {number} count of successfully committed operations */
async function batchWrite(operations) {
  if (!operations?.length) return 0;

  const BATCH_LIMIT = 500; // Firestore max per batchWrite call
  const docNamePrefix = `projects/${NYX_PROJECT_ID}/databases/(default)/documents`;
  let committed = 0;

  // Chunk into groups of 500
  for (let i = 0; i < operations.length; i += BATCH_LIMIT) {
    const chunk = operations.slice(i, i + BATCH_LIMIT);
    const token = await getToken();
    if (!token) break;

    const writes = chunk.map(op => {
      if (op.delete) {
        return { delete: `${docNamePrefix}/${op.delete}` };
      }
      if (op.update) {
        const fields = {};
        const fieldPaths = [];
        for (const [k, v] of Object.entries(op.update.data)) {
          if (v !== undefined) {
            fields[k] = toFirestoreValue(v);
            fieldPaths.push(k);
          }
        }
        return {
          update: {
            name: `${docNamePrefix}/${op.update.path}`,
            fields,
          },
          updateMask: { fieldPaths },
        };
      }
      return null;
    }).filter(Boolean);

    if (writes.length === 0) continue;

    try {
      const url = `https://firestore.googleapis.com/v1/projects/${NYX_PROJECT_ID}/databases/(default)/documents:batchWrite`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ writes }),
      });

      if (res.ok) {
        const result = await res.json();
        // Count successes (writeResults with no error status)
        const writeResults = result.writeResults || [];
        const successes = writeResults.filter(wr => !wr.status || wr.status.code === 0).length;
        const failures = writeResults.filter(wr => wr.status && wr.status.code !== 0);
        committed += successes;
        if (failures.length > 0) {
          console.warn(`[NYX CRM] batchWrite partial failure: ${successes}/${writeResults.length} succeeded, ${failures.length} failed. First error:`, JSON.stringify(failures[0].status));
        }
      } else {
        const errBody = await res.text().catch(() => '');
        console.error(`[NYX CRM] ❌ batchWrite HTTP ${res.status} (${chunk.length} ops). Path sample: ${chunk[0]?.update?.path || chunk[0]?.delete || 'unknown'}. Response: ${errBody.slice(0, 500)}`);
      }
    } catch (e) {
      console.warn(`[NYX CRM] batchWrite error:`, e.message);
    }
  }

  return committed;
}

/** Delete all documents in a Firestore collection.
 *  Uses parallel individual DELETE calls instead of batchWrite because
 *  batchWrite returns 403 with Firebase Auth tokens (same known issue
 *  that forced syncMessages to use parallel patchDoc instead). */
async function deleteCollection(collectionPath) {
  const docs = await listDocs(collectionPath);
  if (docs.length === 0) return 0;

  const CONCURRENCY = 10;
  let deleted = 0;
  let failed = 0;

  for (let i = 0; i < docs.length; i += CONCURRENCY) {
    const batch = docs.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(doc => deleteDoc(`${collectionPath}/${doc.id}`))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) deleted++;
      else failed++;
    }
  }

  if (failed > 0) {
    console.warn(`[NYX CRM] 🗑️ deleteCollection: ${deleted} deleted, ${failed} FAILED out of ${docs.length} in ${collectionPath}`);
  } else {
    console.log(`[NYX CRM] 🗑️ Deleted ${deleted}/${docs.length} docs from ${collectionPath}`);
  }
  return deleted;
}

/** Extract plain JS value from Firestore Value */
function extractValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(extractValue);
  if ('mapValue' in v) {
    const obj = {};
    for (const [k, fv] of Object.entries(v.mapValue.fields || {})) obj[k] = extractValue(fv);
    return obj;
  }
  return null;
}

// ============================================================
// HEARTBEAT — tells CRM that Clarity is online
// ============================================================

async function sendHeartbeat() {
  if (!nyxModelId) return;
  try {
    await patchDoc(`of_chat_commands/${dataKey()}`, {
      lastHeartbeat: new Date(),
      clarityVersion: chrome.runtime.getManifest().version,
      // Don't overwrite cleanup/full-sync status — those are managed by their own flows
      ...(!cleanupInProgress ? { status: 'idle' } : {}),
    });
  } catch (e) {
    // Silent — heartbeat failure should never break Clarity
  }
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  sendHeartbeat(); // immediate first beat
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  // Create chrome.alarm as safety net — survives service worker suspension
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  console.log('[NYX CRM] 💓 Heartbeat started (interval 30s + alarm every ~24s)');
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  chrome.alarms.clear(ALARM_NAME).catch(() => {});
}

// ============================================================
// CHAT SYNC — writes chat data to NYX Firestore
// ============================================================

/** Normalize any timestamp value to a valid ISO string.
 *  Handles: epoch seconds (number), epoch ms (number), epoch-as-string,
 *  ISO strings, Date objects, and OF title-attr strings.
 *  Returns NULL if the value cannot be parsed — never falls back to "now".
 *  Callers must handle null (e.g. by omitting lastMessageAt from the Firestore doc). */
function normalizeTimestamp(val) {
  if (!val) return null;

  let date;

  if (typeof val === 'number') {
    // Epoch seconds (< 1e12) vs epoch ms (>= 1e12)
    date = new Date(val > 1e12 ? val : val * 1000);
  } else if (typeof val === 'string') {
    // Could be an epoch string like "1780808400" or an ISO string
    const num = Number(val);
    if (!isNaN(num) && val.trim().length > 0 && /^\d+$/.test(val.trim())) {
      // Pure numeric string — treat as epoch
      date = new Date(num > 1e12 ? num : num * 1000);
    } else {
      // OF title-attr format: "Sunday, April 6, 2026 at 5:06:17 PM"
      // 1. Strip " at " — Date.parse can't handle it
      // 2. Strip leading day name + comma — "Sunday, " breaks Date.parse in some engines
      let cleaned = val.replace(/\s+at\s+/i, ' ');
      cleaned = cleaned.replace(/^[A-Za-z]+,\s*/, '');
      date = new Date(cleaned);
    }
  } else if (val instanceof Date) {
    date = val;
  } else if (val?.toDate) {
    // Firestore Timestamp
    date = val.toDate();
  } else if (val?.seconds) {
    // Raw Firestore Timestamp object
    date = new Date(val.seconds * 1000);
  } else {
    date = new Date(val);
  }

  // Validate: must be a real date with year >= 2020 (anything older is clearly wrong)
  if (!date || isNaN(date.getTime()) || date.getFullYear() < 2020) {
    return null;
  }

  // Future-date guard: if date is more than 1 day in the future, it was likely
  // parsed from a month/day string without a year (e.g. "Sep 12" → Sep 12 of current year).
  // Roll it back to last year.
  const ONE_DAY = 86400_000;
  if (date.getTime() > Date.now() + ONE_DAY) {
    date.setFullYear(date.getFullYear() - 1);
  }

  return date.toISOString();
}

/** Estimate a timestamp from a display-text string like "5:06 pm", "2h", "Yesterday", "Sep 12".
 *  This is the background-script equivalent of the content script's estimateTimestamp().
 *  Returns epoch ms (number) or null if unparseable. */
function estimateTimestampFromDisplay(timeText) {
  if (!timeText) return null;
  const now = Date.now();
  const text = timeText.toLowerCase().trim();

  // "Xm" = X minutes ago
  const minutesMatch = text.match(/^(\d+)\s*m$/);
  if (minutesMatch) return now - (parseInt(minutesMatch[1]) * 60_000);

  // "Xh" = X hours ago
  const hoursMatch = text.match(/^(\d+)\s*h$/);
  if (hoursMatch) return now - (parseInt(hoursMatch[1]) * 3600_000);

  // "Yesterday"
  if (text.includes('yesterday')) return now - 86400_000;

  // "Xd" = X days ago
  const daysMatch = text.match(/^(\d+)\s*d$/);
  if (daysMatch) return now - (parseInt(daysMatch[1]) * 86400_000);

  // Date patterns: "Sep 12", "12 Sep", "Apr 5", "5 Apr"
  const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  const dateMatch1 = text.match(/^([a-z]{3})\s+(\d{1,2})$/);
  const dateMatch2 = text.match(/^(\d{1,2})\s+([a-z]{3})$/);
  let monthNum = null, dayNum = null;
  if (dateMatch1 && months[dateMatch1[1]] !== undefined) {
    monthNum = months[dateMatch1[1]]; dayNum = parseInt(dateMatch1[2]);
  } else if (dateMatch2 && months[dateMatch2[2]] !== undefined) {
    monthNum = months[dateMatch2[2]]; dayNum = parseInt(dateMatch2[1]);
  }
  if (monthNum !== null && dayNum) {
    const cur = new Date();
    let year = cur.getFullYear();
    const candidate = new Date(year, monthNum, dayNum, 12, 0, 0);
    if (candidate.getTime() > now) year--;
    return new Date(year, monthNum, dayNum, 12, 0, 0).getTime();
  }

  // Time-only: "1:23 pm", "14:30" — means today
  const timeMatch = text.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1]);
    const mins = parseInt(timeMatch[2]);
    const ampm = timeMatch[3];
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    const today = new Date();
    today.setHours(hours, mins, 0, 0);
    return today.getTime();
  }

  return null;
}

/** Parse a spent string like "$1,234.56" to a number */
function parseSpentAmount(val) {
  if (!val && val !== 0) return 0;
  if (typeof val === 'number') return val;
  const cleaned = String(val).replace(/[^0-9.]/g, '');
  return parseFloat(cleaned) || 0;
}

/** Sync a conversation summary (from OF_CHAT_LIST_UPDATED) */
async function syncConversation(fanId, data) {
  if (!nyxModelId || !fanId) return;
  try {
    // Only include fanName if we have a REAL name (not the generic 'Fan' default).
    // This prevents code paths that pass 'Fan' as a placeholder from overwriting
    // the actual subscriber name already stored in Firestore.
    const resolvedName = data.subscriberName || data.name || null;
    const doc = {
      ...(resolvedName && resolvedName !== 'Fan' ? { fanName: resolvedName } : {}),
      lastMessage: data.lastMessage || data.lastMessagePreview || data.preview || '',
      isUnread: data.hasUnread || false,
    };

    // ── Resolve lastMessageAt with clear priority chain ──
    // 1. Direct epoch ms from scraper (most reliable — already parsed by Date.parse in content script)
    // 2. Pre-parsed ISO string (from cleanup/fullsync paths)
    // 3. Raw title-attr string (parse here in bridge)
    // 4. Display text estimation ("5:06 pm" → today, "2h" → 2hrs ago)
    // 5. Fallback: omit field (Firestore keeps existing value)
    let isoTimestamp = null;

    // Priority 1: epoch ms number from scraper (e.g. 1780358400000)
    const epochMs = Number(data.lastMessageTimestamp);
    if (epochMs > 1e12) {
      const d = new Date(epochMs);
      if (!isNaN(d.getTime()) && d.getFullYear() >= 2020) {
        isoTimestamp = d.toISOString();
      }
    }

    // Priority 2: already-ISO or parseable string from lastMessageAt (cleanup/fullsync paths)
    if (!isoTimestamp && data.lastMessageAt) {
      isoTimestamp = normalizeTimestamp(data.lastMessageAt);
    }

    // Priority 3: raw title-attr string from fullTime (e.g. "Sunday, June 4, 2026 at 5:06:17 PM")
    if (!isoTimestamp && data.fullTime) {
      isoTimestamp = normalizeTimestamp(data.fullTime);
    }

    // Priority 4: display text estimation ("5:06 pm", "2h", "Yesterday", "Sep 12")
    if (!isoTimestamp && data.timeText) {
      const estimated = estimateTimestampFromDisplay(data.timeText);
      if (estimated) {
        isoTimestamp = new Date(estimated).toISOString();
      }
    }

    if (isoTimestamp) {
      doc.lastMessageAt = isoTimestamp;
    }
    // If still no timestamp, omit lastMessageAt — Firestore keeps its existing value

    // Include totalSpent if present (from notes or direct field)
    const rawSpent = data.totalSpent ?? data.notes?.totalSpent ?? null;
    if (rawSpent !== null && rawSpent !== undefined) {
      const amount = parseSpentAmount(rawSpent);
      if (amount > 0) doc.totalSpent = amount;
    }

    const result = await patchDoc(`of_chats/${dataKey()}/conversations/${fanId}`, doc);
    if (!result) console.warn(`[NYX CRM] ⚠️ syncConversation failed for fan ${fanId} (patchDoc returned null)`);
  } catch (e) {
    console.warn(`[NYX CRM] ❌ syncConversation error for fan ${fanId}:`, e.message);
  }
}

/** Sync a full chat list from content script — parallelized with concurrency limit.
 *  Old: sequential await per conversation → 50 convs × 200ms = 10s.
 *  New: 6 concurrent patchDoc calls → 50 convs ÷ 6 = ~1.7s. */
export async function syncChatList(chatList) {
  if (!nyxModelId || !isInitialized || !chatList?.length) {
    console.log(`[NYX CRM] syncChatList skipped: modelId=${!!nyxModelId}, initialized=${isInitialized}, chats=${chatList?.length || 0}`);
    return;
  }
  console.log(`[NYX CRM] 📋 Syncing ${chatList.length} conversations to model ${nyxModelId} (parallel)...`);

  const CONCURRENCY = 6;
  let synced = 0;
  const validChats = chatList.filter(chat => {
    const fanId = String(chat.rawId || chat.subscriberId || chat.id || '').replace(/^of:/i, '');
    return !!fanId;
  });

  // Process in concurrent batches
  for (let i = 0; i < validChats.length; i += CONCURRENCY) {
    const batch = validChats.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(chat => {
        const fanId = String(chat.rawId || chat.subscriberId || chat.id || '').replace(/^of:/i, '');
        return syncConversation(fanId, chat);
      })
    );
    synced += results.filter(r => r.status === 'fulfilled').length;
  }

  console.log(`[NYX CRM] 📋 Synced ${synced}/${chatList.length} conversations (parallel)`);
}

/** Sync messages after SAVE_CHAT or SYNC_CHAT — APPEND-ONLY with validation.
 *  @param {object} [opts] - Options
 *  @param {boolean} [opts._internal] - If true, bypass the cleanupInProgress guard
 *         (used by executeCleanup's own write-back so it doesn't block itself)
 *  @param {boolean} [opts.isFullSync] - If true, write orderIndex to Firestore.
 *         Only SAVE_CHAT (full chat replacement) should set this to true.
 *         Partial syncs (SYNC_CHAT, NYX_CRM_SYNC_MESSAGE, OPEN_CHAT) must NOT
 *         write orderIndex because their msg.order values are relative to a
 *         partial batch (e.g. last 5 DOM messages) and would corrupt the
 *         canonical ordering set by the last full sync. */
export async function syncMessages(profileId, subscriberId, subscriberName, messages, { _internal = false, skipConversationUpdate = false, isFullSync = false } = {}) {
  // ══ NUCLEAR DIAGNOSTIC: log entry with full state ══
  console.log(`[NYX CRM] 🟡 syncMessages ENTERED: sub=${subscriberId}, msgs=${messages?.length || 0}, model=${nyxModelId || 'null'}, init=${isInitialized}, token=${!!nyxIdToken}, cleanup=${cleanupInProgress}, _internal=${_internal}`);

  // ── Auto-recover if bridge lost state (MV3 service worker restart) ──
  if (!nyxModelId || !isInitialized) {
    console.log(`[NYX CRM] 🟡 syncMessages: bridge not ready, calling ensureSyncReady()...`);
    const ready = await ensureSyncReady();
    if (!ready) {
      console.error(`[NYX CRM] ❌ syncMessages DROPPED — bridge not ready after recovery (modelId=${!!nyxModelId}, init=${isInitialized}, sub=${subscriberId}, msgs=${messages?.length || 0})`);
      return;
    }
    console.log(`[NYX CRM] 🟡 syncMessages: bridge recovered — model=${nyxModelId}, init=${isInitialized}`);
  }

  // ── Guard: suppress sidepanel SAVE_CHAT/SYNC_CHAT writes during cleanup ──
  if (cleanupInProgress && !_internal) {
    // Safety timeout: if cleanup has been running for >10 min, force-release the lock.
    const CLEANUP_SAFETY_TIMEOUT = 10 * 60_000; // 10 minutes
    if (cleanupStartedAt > 0 && (Date.now() - cleanupStartedAt) > CLEANUP_SAFETY_TIMEOUT) {
      console.warn(`[NYX CRM] ⚠️ cleanupInProgress has been true for >${CLEANUP_SAFETY_TIMEOUT / 60_000} min — force-releasing lock (safety timeout)`);
      cleanupInProgress = false;
      cleanupStartedAt = 0;
    } else {
      console.log(`[NYX CRM] 🚫 syncMessages SKIPPED — cleanup in progress (started ${cleanupStartedAt > 0 ? ((Date.now() - cleanupStartedAt) / 1000).toFixed(0) + 's ago' : 'unknown'})`);
      return;
    }
  }

  const fanId = String(subscriberId).replace(/^of:/i, '');
  if (!fanId || !messages?.length) {
    console.log(`[NYX CRM] 🚫 syncMessages SKIPPED — empty: fanId="${fanId}", msgs=${messages?.length || 0}`);
    return;
  }

  // ── Validation gate: reject bad data, generate fallback IDs if needed ──
  const validMessages = messages.filter(m => {
    // Generate fallback ID for messages without one (e.g. real-time NEW_MESSAGE with no data-id)
    // DETERMINISTIC: same message content always produces same ID, preventing duplicate
    // Firestore documents on re-entry. Old random IDs (`rt-${Date.now()}-${Math.random()}`)
    // created NEW docs each call → 41 → 82 → 160 duplicates on every re-sync.
    if (!m.id || m.id === 'null' || m.id === 'undefined') {
      const sender = (m.isFromMe || m.fromMe) ? 'me' : 'them';
      const textHash = (m.text || '').substring(0, 80).replace(/[^a-zA-Z0-9]/g, '');
      const timeHint = m.datetime || m.time || '';
      m.id = `rt-${sender}-${textHash.substring(0, 30)}-${timeHint.replace(/[^0-9T:]/g, '').substring(0, 15)}`;
    }
    const id = String(m.id);
    if (!id) return false;
    // Must have text OR media content (media-only messages are valid)
    if (!m.text && !m.mediaThumbnail && !m.thumbnail && !m.mediaType) return false;
    return true;
  });

  if (validMessages.length === 0) {
    console.error(`[NYX CRM] ❌ syncMessages: ALL ${messages.length} messages REJECTED for fan ${fanId}. Sample: ${JSON.stringify(messages[0] || {}).slice(0, 300)}`);
    return;
  }

  // Check that at least some messages have timestamps (sanity check)
  const withDatetime = validMessages.filter(m => m.datetime);
  if (withDatetime.length < Math.min(2, validMessages.length)) {
    console.warn(`[NYX CRM] ⚠️ Most messages lack timestamps for fan ${fanId} — syncing anyway`);
  }

  console.log(`[NYX CRM] 🟢 syncMessages: ${validMessages.length} valid msgs for fan ${fanId}, model=${nyxModelId}. Writing to Firestore...`);

  // ── Only update conversation summary if last message is recent (within 1 hour) ──
  const lastMsg = validMessages[validMessages.length - 1];
  const lastMsgTime = lastMsg?.datetime ? new Date(lastMsg.datetime).getTime() : 0;
  const ONE_HOUR = 3600_000;

  if (!skipConversationUpdate && (lastMsgTime > Date.now() - ONE_HOUR || !lastMsgTime)) {
    await syncConversation(fanId, {
      subscriberName: subscriberName || 'Fan',
      lastMessage: lastMsg?.text || '',
      lastMessageAt: lastMsg.datetime || new Date().toISOString(),
      hasUnread: false,
    });
  } else if (skipConversationUpdate) {
    console.log(`[NYX CRM] 📋 Skipped conversation update (skipConversationUpdate=true)`);
  } else {
    console.log(`[NYX CRM] 📋 Skipped summary update — last message is older than 1 hour`);
  }

  // ── Append-only parallel patchDoc writes ──
  // NOTE: batchWrite REST API returns 403 for Firebase Auth tokens (known issue),
  // so we use parallel patchDoc calls instead. Each patchDoc is an individual PATCH
  // request that works reliably. Concurrency-limited to avoid rate limiting.
  const MAX_THUMBNAIL_SIZE = 200_000; // 200KB — truncate base64 thumbnails to prevent oversized docs
  const msgBasePath = `of_chats/${dataKey()}/conversations/${fanId}/messages`;
  const CONCURRENCY = 12; // parallel patchDoc calls at once — increased for faster sync
  let synced = 0;
  let failed = 0;

  console.log(`[NYX CRM] 🟢 syncMessages: writing ${validMessages.length} msgs via parallel patchDoc (concurrency=${CONCURRENCY}). Path: ${msgBasePath}/...`);

  // Compute a single timestamp for this entire batch — used as orderIndex base
  // for non-fullSync paths. All messages in the batch share this base, with their
  // position offset ensuring correct relative order within the batch.
  const batchTimestamp = Date.now();

  // Track last resolved timestamp for interpolation (prevents new Date() fallback
  // from producing wildly wrong timestamps like 9:13 am for a 3:16 pm message)
  let lastResolvedTimestamp = null;

  // Process in concurrent batches
  for (let i = 0; i < validMessages.length; i += CONCURRENCY) {
    const batch = validMessages.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((msg, batchIdx) => {
        let thumbnail = msg.mediaThumbnail || msg.thumbnail || null;
        if (thumbnail && thumbnail.length > MAX_THUMBNAIL_SIZE) {
          thumbnail = null;
        }

        const docPath = `${msgBasePath}/${String(msg.id)}`;

        // ── Resolve createdAt with priority chain ──
        // 1. datetime attr from <time> element (ISO string — most reliable)
        // 2. Estimate from display text ("5:06 pm" → today's date at that time)
        // 3. Existing createdAt from content script
        // 4. Previous message's timestamp (interpolation — messages sent within same minute)
        // 5. Last resort: current time
        let resolvedCreatedAt = null;
        if (msg.datetime) {
          resolvedCreatedAt = normalizeTimestamp(msg.datetime);
        }
        if (!resolvedCreatedAt && msg.time) {
          const estimated = estimateTimestampFromDisplay(msg.time);
          if (estimated) resolvedCreatedAt = new Date(estimated).toISOString();
        }
        if (!resolvedCreatedAt && msg.createdAt) {
          resolvedCreatedAt = normalizeTimestamp(msg.createdAt);
        }
        if (!resolvedCreatedAt && lastResolvedTimestamp) {
          // Interpolate from previous message — much better than new Date() which
          // gives scan time (e.g. 9:13 am) instead of actual message time (~3:16 pm)
          resolvedCreatedAt = lastResolvedTimestamp;
        }
        if (!resolvedCreatedAt) {
          resolvedCreatedAt = new Date().toISOString();
        }
        // Update tracker for next message's interpolation
        lastResolvedTimestamp = resolvedCreatedAt;

        // ── Build the doc fields ──
        const docFields = {
          text: msg.text || '',
          isFromMe: msg.isFromMe || msg.fromMe || false,
          createdAt: resolvedCreatedAt,
          timeDisplay: msg.time || '',
          mediaThumbnail: thumbnail,
          mediaType: msg.mediaType || null,
          mediaUrl: msg.mediaUrl || null,
          tipAmount: msg.tipAmount || null,
          isPPV: msg.isPPV || false,
          replyTo: msg.replyTo || null,
          _targetFanId: fanId,
        };

        // ── orderIndex: determines message display order in CRM ──
        // EVERY message gets orderIndex — no exceptions. This prevents
        // the "two-group" sorting bug where messages without orderIndex
        // (from CHAT_MESSAGES batch) sort after ALL messages that have
        // orderIndex (from cleanup or NEW_MESSAGE), breaking chronological order.
        //
        // Full sync (CLEANUP): sequential 0, 1, 2... matching DOM order.
        //   These are the canonical baseline — small integers.
        //
        // All other paths (NEW_MESSAGE, CHAT_MESSAGES, OPEN_CHAT):
        //   Use batchTimestamp + position. Since batchTimestamp is ~1.7 trillion,
        //   these always sort AFTER cleanup messages (0-N). Within a batch,
        //   messages maintain their DOM order via the position offset.
        //   For messages already in Firestore from cleanup, overwriting their
        //   orderIndex is fine: patchDoc upserts, and the batch contains the
        //   most recent visible messages — they SHOULD sort at the end.
        if (isFullSync) {
          const orderIndex = (typeof msg.order === 'number') ? msg.order : (i + batchIdx);
          docFields.orderIndex = orderIndex;
        } else {
          // Timestamp-based orderIndex for all non-cleanup paths
          // batchTimestamp is computed once before the loop (see above)
          docFields.orderIndex = batchTimestamp + (i + batchIdx);
        }

        return patchDoc(docPath, docFields);
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) synced++;
      else failed++;
    }
  }

  if (failed > 0) {
    console.log(`[NYX CRM] ⚠️ syncMessages: ${synced} succeeded, ${failed} failed for fan ${fanId}`);
  } else {
    console.log(`[NYX CRM] ✅ syncMessages SUCCESS: ${synced}/${validMessages.length} messages for fan ${fanId}`);
  }

  // ── Fire-and-forget: enrich video URLs via OF API, then download → Firebase Storage ──
  // DOM extraction can't get video URLs (OF loads them dynamically via video.js).
  // Step 1: Identify video messages that have no mediaUrl (need API enrichment)
  // Step 2: Request video URLs from content script via OF API
  // Step 3: Patch Firestore docs with the CDN URLs
  // Step 4: Download from CDN → upload to Firebase Storage → update videoStorageUrl
  const videosWithUrl = validMessages.filter(m =>
    m.mediaType === 'video' &&
    m.mediaUrl &&
    !m.mediaUrl.startsWith('blob:') &&
    !m.mediaUrl.includes('firebasestorage.googleapis.com') &&
    (m.mediaUrl.includes('cdn') || m.mediaUrl.includes('cloudfront') || m.mediaUrl.startsWith('https://'))
  );
  const videosWithoutUrl = validMessages.filter(m =>
    m.mediaType === 'video' && !m.mediaUrl
  );

  // Process videos that already have CDN URLs (rare — from API-enriched re-syncs)
  if (videosWithUrl.length > 0) {
    processVideoUploads(fanId, videosWithUrl, msgBasePath).catch(e => {
      console.warn(`[NYX CRM] 🎬 Video upload background task failed:`, e.message);
    });
  }

  // Enrich videos that lack URLs via the OF API (the common path for video messages)
  if (videosWithoutUrl.length > 0) {
    enrichVideoUrls(fanId, videosWithoutUrl, msgBasePath).catch(e => {
      console.warn(`[NYX CRM] 🎬 Video URL enrichment failed:`, e.message);
    });
  }
}

// ============================================================
// VIDEO DOWNLOAD + FIREBASE STORAGE UPLOAD
// ============================================================
// Downloads video files from OF CDN (CloudFront signed URLs) and uploads
// them to Firebase Storage for permanent, playable storage in the CRM.
// CDN URLs have auth embedded in query params — no cookies needed.
// Runs as a background task after syncMessages completes.

/** Track in-progress video uploads to prevent duplicate downloads.
 *  Key = message ID, Value = true if upload started. */
const videoUploadTracker = new Set();

/**
 * Download a video from an OF CDN URL and upload to Firebase Storage.
 * @param {string} cdnUrl - The CloudFront signed URL
 * @param {string} storagePath - Firebase Storage path (e.g. of-chat-videos/profileId/fanId/msgId.mp4)
 * @returns {Promise<string|null>} The permanent download URL, or null on failure
 */
async function downloadAndUploadVideo(cdnUrl, storagePath) {
  const token = await getToken();
  if (!token) {
    console.warn('[NYX CRM] 🎬 No auth token — skipping video upload');
    return null;
  }

  // Step 1: Download the video from OF CDN
  console.log(`[NYX CRM] 🎬 Downloading video from CDN...`);
  let videoBlob;
  try {
    const cdnRes = await fetch(cdnUrl);
    if (!cdnRes.ok) {
      console.warn(`[NYX CRM] 🎬 CDN fetch failed: ${cdnRes.status} ${cdnRes.statusText}`);
      return null;
    }
    videoBlob = await cdnRes.blob();
    console.log(`[NYX CRM] 🎬 Downloaded ${(videoBlob.size / 1024 / 1024).toFixed(1)}MB video`);
  } catch (e) {
    console.warn(`[NYX CRM] 🎬 CDN download error:`, e.message);
    return null;
  }

  // Safety: skip files > 500MB (protect against runaway downloads)
  const MAX_VIDEO_SIZE = 500 * 1024 * 1024; // 500MB
  if (videoBlob.size > MAX_VIDEO_SIZE) {
    console.warn(`[NYX CRM] 🎬 Video too large (${(videoBlob.size / 1024 / 1024).toFixed(0)}MB) — skipping`);
    return null;
  }

  // Skip tiny files (< 1KB) that are likely error responses
  if (videoBlob.size < 1024) {
    console.warn(`[NYX CRM] 🎬 File too small (${videoBlob.size}B) — likely an error response, skipping`);
    return null;
  }

  // Step 2: Upload to Firebase Storage via REST API
  const contentType = videoBlob.type || 'video/mp4';
  const encodedPath = encodeURIComponent(storagePath);
  const uploadUrl = `${STORAGE_UPLOAD_BASE}?uploadType=media&name=${encodedPath}`;

  console.log(`[NYX CRM] 🎬 Uploading to Firebase Storage: ${storagePath}`);
  try {
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        Authorization: `Bearer ${token}`,
      },
      body: videoBlob,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => '');
      console.warn(`[NYX CRM] 🎬 Upload failed: ${uploadRes.status} — ${errText.slice(0, 200)}`);
      return null;
    }

    const uploadData = await uploadRes.json();
    // Build the permanent download URL
    const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodedPath}?alt=media`;
    console.log(`[NYX CRM] 🎬 ✅ Uploaded: ${storagePath} (${(videoBlob.size / 1024 / 1024).toFixed(1)}MB)`);
    return downloadUrl;
  } catch (e) {
    console.warn(`[NYX CRM] 🎬 Upload error:`, e.message);
    return null;
  }
}

/**
 * Process multiple video messages: download from CDN, upload to Storage, update Firestore.
 * Runs sequentially to avoid overwhelming the network.
 * @param {string} fanId - The fan ID
 * @param {Array} videoMsgs - Array of message objects with mediaUrl (CDN URLs)
 * @param {string} msgBasePath - Firestore base path for message docs
 */
async function processVideoUploads(fanId, videoMsgs, msgBasePath) {
  console.log(`[NYX CRM] 🎬 Processing ${videoMsgs.length} video uploads for fan ${fanId}...`);
  let uploaded = 0;
  let skipped = 0;

  for (const msg of videoMsgs) {
    const msgId = String(msg.id);

    // Dedup: skip if already being processed
    if (videoUploadTracker.has(msgId)) {
      skipped++;
      continue;
    }
    videoUploadTracker.add(msgId);

    try {
      // Determine file extension from URL or content type
      const urlPath = new URL(msg.mediaUrl).pathname;
      const ext = urlPath.match(/\.(mp4|webm|mov|m4v)$/i)?.[1]?.toLowerCase() || 'mp4';
      const storagePath = `of-chat-videos/${dataKey()}/${fanId}/${msgId}.${ext}`;

      const downloadUrl = await downloadAndUploadVideo(msg.mediaUrl, storagePath);

      if (downloadUrl) {
        // Update the Firestore message doc with the permanent storage URL
        const docPath = `${msgBasePath}/${msgId}`;
        await patchDoc(docPath, { videoStorageUrl: downloadUrl });
        uploaded++;
        console.log(`[NYX CRM] 🎬 ✅ Video stored + Firestore updated: ${msgId}`);
      }
    } catch (e) {
      console.warn(`[NYX CRM] 🎬 Error processing video ${msgId}:`, e.message);
    }

    // Small delay between downloads to be gentle on the network
    if (videoMsgs.indexOf(msg) < videoMsgs.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`[NYX CRM] 🎬 Video upload batch complete: ${uploaded} uploaded, ${skipped} skipped, ${videoMsgs.length - uploaded - skipped} failed`);
}

/**
 * Enrich video messages that lack mediaUrl by fetching URLs from the OF API.
 * Sends FETCH_VIDEO_URLS to the content script on the OF tab, which calls the
 * OF chat messages API to get actual video CDN URLs (CloudFront signed URLs).
 * Then patches Firestore docs with the URLs and triggers video download+upload.
 *
 * @param {string} fanId - The fan/chat ID (same as OF user ID)
 * @param {Array} videoMsgs - Video message objects with mediaType='video' but no mediaUrl
 * @param {string} msgBasePath - Firestore base path for message docs
 */
async function enrichVideoUrls(fanId, videoMsgs, msgBasePath) {
  console.log(`[NYX CRM] 🎬 Enriching ${videoMsgs.length} video messages for fan ${fanId} via OF API...`);

  // Find the OF tab to send the FETCH_VIDEO_URLS message
  const ofTab = await findOfTab();
  if (!ofTab) {
    console.warn(`[NYX CRM] 🎬 No OF tab found — cannot enrich video URLs`);
    return;
  }

  try {
    // Send FETCH_VIDEO_URLS to content script — it calls the OF API and returns
    // a map of { msgId: videoUrl } for all video messages in the chat
    const response = await chrome.tabs.sendMessage(ofTab.id, {
      type: 'FETCH_VIDEO_URLS',
      chatId: fanId,
    });

    if (!response?.success || !response.videoUrls) {
      console.warn(`[NYX CRM] 🎬 FETCH_VIDEO_URLS failed:`, response?.error || 'no response');
      return;
    }

    const videoUrls = response.videoUrls; // { msgId: cdnUrl }
    const urlCount = Object.keys(videoUrls).length;
    console.log(`[NYX CRM] 🎬 Got ${urlCount} video URLs from OF API`);

    if (urlCount === 0) return;

    // Match enriched URLs to our video messages and patch Firestore
    const enrichedMsgs = [];
    for (const msg of videoMsgs) {
      const msgId = String(msg.id);
      const cdnUrl = videoUrls[msgId];

      if (cdnUrl && !cdnUrl.startsWith('blob:')) {
        // Patch Firestore doc with the CDN URL
        const docPath = `${msgBasePath}/${msgId}`;
        try {
          await patchDoc(docPath, { mediaUrl: cdnUrl });
          console.log(`[NYX CRM] 🎬 ✅ Enriched video URL for msg ${msgId}`);
          // Build a message object for processVideoUploads
          enrichedMsgs.push({ ...msg, mediaUrl: cdnUrl });
        } catch (e) {
          console.warn(`[NYX CRM] 🎬 Failed to patch mediaUrl for msg ${msgId}:`, e.message);
        }
      }
    }

    console.log(`[NYX CRM] 🎬 Enriched ${enrichedMsgs.length}/${videoMsgs.length} video messages with CDN URLs`);

    // Now trigger the download+upload pipeline for enriched videos
    if (enrichedMsgs.length > 0) {
      processVideoUploads(fanId, enrichedMsgs, msgBasePath).catch(e => {
        console.warn(`[NYX CRM] 🎬 Video upload after enrichment failed:`, e.message);
      });
    }
  } catch (e) {
    console.warn(`[NYX CRM] 🎬 enrichVideoUrls error:`, e.message);
  }
}

// ============================================================
// COMMAND POLLING — picks up commands from CRM
// ============================================================

async function pollCommands() {
  if (!nyxModelId) return;
  if (commandProcessing) {
    console.log('[NYX CRM] pollCommands skipped — previous run still active');
    return;
  }
  commandProcessing = true;
  try {
    const commands = await runQuery(
      `of_chat_commands/${dataKey()}`,
      'queue',
      [{ field: 'status', value: 'pending' }]
    );

    for (const cmd of commands) {
      await executeCommand(cmd);
    }
  } catch (e) {
    // Silent — polling failure should never break Clarity
  } finally {
    commandProcessing = false;
  }
}

async function executeCommand(cmd) {
  const cmdPath = `of_chat_commands/${dataKey()}/queue/${cmd.id}`;

  // Mark as processing
  await patchDoc(cmdPath, { status: 'processing', processedAt: new Date().toISOString() });

  try {
    switch (cmd.type) {
      case 'SEND_MESSAGE':
        await executeSendMessage(cmd);
        break;
      case 'OPEN_CHAT':
        await executeOpenChat(cmd);
        break;
      case 'FULL_SYNC':
        await executeFullSync(cmd);
        break;
      case 'CLEANUP':
        await executeCleanup(cmd);
        break;
      case 'SCAN_PROFILE':
        await executeScanProfile(cmd);
        break;
      case 'SET_TASK_DAYS':
        await executeSetTaskDays(cmd);
        break;
      case 'SEND_MEDIA':
        await executeSendMedia(cmd);
        break;
      case 'MARK_SENT':
        await executeMarkSent(cmd);
        break;
      case 'UNMARK_SENT':
        await executeUnmarkSent(cmd);
        break;
      case 'VAULT_MOVE_MEDIA':
        await executeVaultMoveMedia(cmd);
        break;
      case 'VAULT_CREATE':
        await executeVaultCreate(cmd);
        break;
      case 'VAULT_RENAME':
        await executeVaultRename(cmd);
        break;
      case 'VAULT_DELETE':
        await executeVaultDelete(cmd);
        break;
      case 'VAULT_DELETE_MEDIA':
        await executeVaultDeleteMedia(cmd);
        break;
      case 'TRIGGER_SEND':
        await executeTriggerSend(cmd);
        break;
      case 'SET_PRICE':
        await executeSetPrice(cmd);
        break;
      case 'FORCE_VAULT_SYNC':
        await executeForceVaultSync(cmd);
        break;
      case 'REFRESH_VAULT_URLS':
        await executeRefreshVaultUrls(cmd);
        break;
      case 'SAVE_NOTES':
        await executeSaveNotes(cmd);
        break;
      default:
        throw new Error(`Unknown command: ${cmd.type}`);
    }
    // Mark as completed
    await patchDoc(cmdPath, { status: 'completed', completedAt: new Date().toISOString() });
  } catch (e) {
    // Mark as failed
    await patchDoc(cmdPath, { status: 'failed', error: e.message, completedAt: new Date().toISOString() });
    console.warn(`[NYX CRM] ❌ Command ${cmd.id} failed:`, e.message);
  }
}

/** Execute SEND_MESSAGE — clicks the send button in OF compose box.
 *  Uses CRM_TRIGGER_SEND (click-only) first, falls back to SEND_MESSAGE with
 *  skipInjection=true. NEVER re-injects text — text should already be in the
 *  compose box from live typing (SET_DRAFT_TEXT via draftSyncTick).
 *  Includes retry logic to handle transient content script connection issues. */
async function executeSendMessage(cmd) {
  const fanId = cmd.fanId;
  const text = cmd.text;
  if (!fanId || !text) throw new Error('Missing fanId or text');

  console.log(`[NYX CRM] 📤 Executing SEND_MESSAGE to fan ${fanId}: "${text.slice(0, 50)}..."`);

  // ── SEND LOCK: block page interaction for the entire command ──
  const lockTab = await findOfTab();
  if (lockTab) await sendLockToTab(lockTab.id, 'Sending message…');

  try {
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ofTab = await findOfTab();
    if (!ofTab) {
      if (attempt < MAX_RETRIES) {
        console.warn(`[NYX CRM] 📤 No OF tab found (attempt ${attempt}/${MAX_RETRIES}) — retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw new Error('No OnlyFans tab open');
    }

    try {
      // Step 1: Try CRM_TRIGGER_SEND — just click the send button (no text injection)
      console.log(`[NYX CRM] 📤 Attempt ${attempt}: trying CRM_TRIGGER_SEND (click-only)...`);
      try {
        const triggerRes = await chrome.tabs.sendMessage(ofTab.id, { type: 'CRM_TRIGGER_SEND', fanId });
        if (triggerRes?.success) {
          console.log(`[NYX CRM] 📤 ✅ CRM_TRIGGER_SEND succeeded on attempt ${attempt}`);
          return;
        }
        console.warn(`[NYX CRM] 📤 CRM_TRIGGER_SEND failed:`, triggerRes?.error, '— trying skipInjection fallback');
      } catch (e) {
        console.warn(`[NYX CRM] 📤 CRM_TRIGGER_SEND error:`, e.message, '— trying skipInjection fallback');
      }

      // Step 2: Fallback — SEND_MESSAGE with skipInjection=true (click send only, no text manipulation)
      const sendRes = await chrome.tabs.sendMessage(ofTab.id, {
        type: 'SEND_MESSAGE',
        text,
        skipInjection: true,
      });

      if (sendRes?.success) {
        console.log(`[NYX CRM] 📤 ✅ SEND_MESSAGE (skipInjection) succeeded on attempt ${attempt}`);
        return;
      }

      console.warn(`[NYX CRM] 📤 SEND_MESSAGE (skipInjection) failed on tab ${ofTab.id} (attempt ${attempt}/${MAX_RETRIES}):`, sendRes?.error || 'no success');
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) {
      console.warn(`[NYX CRM] 📤 Attempt ${attempt}/${MAX_RETRIES} error:`, e.message);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  throw new Error('Could not send via content script after 3 attempts — no active OF chat tab responded');

  } finally {
    // ── SEND UNLOCK: always release even if all attempts failed ──
    if (lockTab) await sendUnlockToTab(lockTab.id);
  }
}

/** Execute OPEN_CHAT — navigates the EXISTING OnlyFans tab to a fan's chat.
 *  Does NOT create a new tab — reuses the tab the user already has open.
 *  After navigation, extracts the last 20 messages and does an incremental
 *  append-only sync (PATCH/upsert) so only NEW messages are added to Firebase. */
/** Execute TRIGGER_SEND - clicks the OF send button without typing new text.
 *  Used when the compose box already has content (text via draft sync and/or media).
 *  Uses findOfTab() (proven helper) + retry logic for reliability. */
async function executeTriggerSend(cmd) {
  const fanId = cmd.fanId;
  if (!fanId) throw new Error('Missing fanId');
  console.log(`[NYX CRM] 📤 Executing TRIGGER_SEND for fan ${fanId}`);

  // ── SEND LOCK: block page interaction for the entire command ──
  const lockTab = await findOfTab();
  if (lockTab) await sendLockToTab(lockTab.id, 'Sending message…');

  try {
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ofTab = await findOfTab();
    if (!ofTab) {
      if (attempt < MAX_RETRIES) {
        console.warn(`[NYX CRM] 📤 No OF tab found (attempt ${attempt}/${MAX_RETRIES}) — retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw new Error('No OnlyFans tab open');
    }

    try {
      const response = await chrome.tabs.sendMessage(ofTab.id, {
        type: 'CRM_TRIGGER_SEND',
        fanId,
      });
      if (response?.success) {
        console.log(`[NYX CRM] 📤 ✅ TRIGGER_SEND succeeded on attempt ${attempt}`);
        return;
      }
      console.warn(`[NYX CRM] 📤 TRIGGER_SEND failed on tab ${ofTab.id} (attempt ${attempt}/${MAX_RETRIES}):`, response?.error || 'no success');
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) {
      console.warn(`[NYX CRM] 📤 TRIGGER_SEND attempt ${attempt}/${MAX_RETRIES} error:`, e.message);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  throw new Error('Could not trigger send after 3 attempts — no active OF chat tab responded');

  } finally {
    // ── SEND UNLOCK: always release even if all attempts failed ──
    if (lockTab) await sendUnlockToTab(lockTab.id);
  }
}

/** Execute SET_PRICE — sets PPV price on media in the OF compose box.
 *  Uses the queue system for proper ordering: SEND_MEDIA → SET_PRICE → SEND.
 *  Waits for OF chat page to be ready before executing.
 *  Includes retry logic (3 attempts) with page-ready verification. */
async function executeSetPrice(cmd) {
  const fanId = cmd.fanId;
  const price = Number(cmd.price);
  if (!fanId) throw new Error('Missing fanId');
  if (!price || price <= 0) throw new Error(`Invalid price: ${cmd.price}`);

  console.log(`[NYX CRM] 💰 Executing SET_PRICE: $${price} for fan ${fanId}`);

  // ── SEND LOCK: block page interaction for the entire command ──
  const lockTab = await findOfTab();
  if (lockTab) await sendLockToTab(lockTab.id, 'Setting price…');

  try {
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ofTab = await findOfTab();
    if (!ofTab) {
      if (attempt < MAX_RETRIES) {
        console.warn(`[NYX CRM] 💰 No OF tab found (attempt ${attempt}/${MAX_RETRIES}) — retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw new Error('No OnlyFans tab open');
    }

    // Verify the OF tab is on a chat page before attempting price set
    try {
      const readyRes = await chrome.tabs.sendMessage(ofTab.id, { type: 'IS_CHAT_READY' });
      if (!readyRes?.ready) {
        console.warn(`[NYX CRM] 💰 Chat page not ready (attempt ${attempt}/${MAX_RETRIES}) — waiting 3s...`);
        await new Promise(r => setTimeout(r, 3000));
        if (attempt >= MAX_RETRIES) {
          throw new Error('Chat page not ready after retries');
        }
        continue;
      }
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        console.warn(`[NYX CRM] 💰 IS_CHAT_READY check failed (attempt ${attempt}/${MAX_RETRIES}):`, e.message);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
    }

    try {
      const priceRes = await chrome.tabs.sendMessage(ofTab.id, { type: 'SET_PRICE', price });
      if (priceRes?.success) {
        console.log(`[NYX CRM] 💰 ✅ SET_PRICE succeeded on attempt ${attempt} — $${price}`);
        return; // Success
      }

      console.warn(`[NYX CRM] 💰 SET_PRICE failed on attempt ${attempt}/${MAX_RETRIES}:`, priceRes?.error || 'no success');
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) {
      console.warn(`[NYX CRM] 💰 SET_PRICE attempt ${attempt}/${MAX_RETRIES} error:`, e.message);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  throw new Error(`Could not set price to $${price} after ${MAX_RETRIES} attempts`);

  } finally {
    // ── SEND UNLOCK: always release even if all attempts failed ──
    if (lockTab) await sendUnlockToTab(lockTab.id);
  }
}

async function executeOpenChat(cmd) {
  const fanId = cmd.fanId;
  const fanName = cmd.fanName || 'Fan';
  if (!fanId) throw new Error('Missing fanId');

  // ── LOCK: suppress CHAT_MESSAGES from content script's autoLoadChat ──
  // Without this, navigating the OF tab triggers autoLoadChat → CHAT_MESSAGES → syncMessages
  // IN PARALLEL with our own extraction + syncMessages. Messages without stable OF data-id
  // (tips, system msgs, media placeholders) get random fallback IDs each call → duplicates
  // that accumulate on every re-entry (41 → 82 → 160...).
  openChatInProgress = true;

  try {
  console.log(`[NYX CRM] 📂 Executing OPEN_CHAT for fan ${fanId} (${fanName}) — same-tab navigation (CHAT_MESSAGES LOCKED)...`);

  const chatUrl = `https://onlyfans.com/my/chats/chat/${fanId}`;

  // ── Step 1: Find the EXISTING OnlyFans tab (never create a new one) ──
  const tabs = await chrome.tabs.query({ url: 'https://onlyfans.com/*' });
  if (tabs.length === 0) {
    throw new Error('No OnlyFans tab open — please open OnlyFans first');
  }

  // Prefer the active OF tab; fall back to the first one found
  const ofTab = tabs.find(t => t.active) || tabs[0];
  const tabId = ofTab.id;

  // Check if already on this chat (no navigation needed)
  const alreadyOnChat = ofTab.url && ofTab.url.includes(`/my/chats/chat/${fanId}`);
  // Check if on any chats page (chat list visible → Method A available)
  const onChatsPage = ofTab.url && ofTab.url.includes('/my/chats/');

  if (alreadyOnChat) {
    console.log(`[NYX CRM] 📂 Already on fan ${fanId}'s chat — skipping navigation`);
  } else if (onChatsPage) {
    // ── METHOD A: Click user from chat list (SPA navigation — faster, no full reload) ──
    console.log(`[NYX CRM] 📂 Method A: Clicking fan ${fanId} from chat list sidebar...`);
    let methodASuccess = false;

    try {
      const clickRes = await chrome.tabs.sendMessage(tabId, { type: 'CLICK_CHAT_LIST_USER', fanId });
      if (clickRes?.success) {
        console.log(`[NYX CRM] 📂 ✅ Method A succeeded (${clickRes.method}) — waiting for SPA navigation...`);
        // SPA navigation is fast but we still need to wait for OF to render the chat
        await new Promise(r => setTimeout(r, 700));
        // Wait for content script to confirm it's on the correct chat page
        const ready = await waitForCorrectChat(tabId, fanId, 20, 300);
        if (ready) {
          methodASuccess = true;
          console.log(`[NYX CRM] 📂 ✅ Method A: Chat page for fan ${fanId} is ready`);
          // Final DOM stabilization
          await new Promise(r => setTimeout(r, 200));
        } else {
          console.warn(`[NYX CRM] 📂 ⚠️ Method A: Click succeeded but chat page not ready — falling back to Method B`);
        }
      } else {
        console.log(`[NYX CRM] 📂 Method A failed: ${clickRes?.error || 'unknown'} — falling back to Method B`);
      }
    } catch (e) {
      console.warn(`[NYX CRM] 📂 Method A error: ${e.message} — falling back to Method B`);
    }

    // ── METHOD B FALLBACK: Full URL navigation ──
    if (!methodASuccess) {
      console.log(`[NYX CRM] 📂 Method B: Navigating via URL to fan ${fanId}...`);
      await chrome.tabs.update(tabId, { url: chatUrl });
      const loaded = await waitForTabLoad(tabId, 30000);
      if (!loaded) {
        console.warn(`[NYX CRM] ⚠️ Tab load timeout for fan ${fanId} — attempting extraction anyway`);
      }
      await new Promise(r => setTimeout(r, 1000));
      const ready = await waitForCorrectChat(tabId, fanId);
      if (!ready) {
        console.warn(`[NYX CRM] ⚠️ Content script not ready for fan ${fanId} — attempting extraction anyway`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
  } else {
    // ── METHOD B: Not on chats page at all — direct URL navigation ──
    console.log(`[NYX CRM] 📂 Method B: Navigating existing OF tab ${tabId} to fan ${fanId}...`);

    await chrome.tabs.update(tabId, { url: chatUrl });

    // Wait for tab to fully load (content script reinjects after navigation)
    const loaded = await waitForTabLoad(tabId, 30000);
    if (!loaded) {
      console.warn(`[NYX CRM] ⚠️ Tab load timeout for fan ${fanId} — attempting extraction anyway`);
    }

    // Buffer for OF's SPA to render the chat DOM
    await new Promise(r => setTimeout(r, 1000));

    // Wait for content script to confirm ready on the CORRECT chat page
    const ready = await waitForCorrectChat(tabId, fanId);
    if (!ready) {
      console.warn(`[NYX CRM] ⚠️ Content script not ready for fan ${fanId} — attempting extraction anyway`);
    }

    // Final DOM stabilization
    await new Promise(r => setTimeout(r, 500));
  }

  // ── Step 3: Extract messages with retry + tab refresh on failure ──
  // The content script sometimes loses connection (MV3 service worker restart,
  // tab backgrounding, etc.). Refreshing the OF page re-injects it.
  const MAX_EXTRACT_RETRIES = 3;
  let messages = [];
  let notSubscribed = false;

  for (let attempt = 1; attempt <= MAX_EXTRACT_RETRIES; attempt++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'CRM_OPEN_CHAT' });
      if (res?.notSubscribed) notSubscribed = true;
      if (res?.success && res.messages?.length > 0) {
        messages = res.messages;
        break; // Success — exit retry loop
      }
      // Content script responded but 0 messages — might be a dead state
      if (attempt < MAX_EXTRACT_RETRIES) {
        console.warn(`[NYX CRM] ⚠️ Extraction returned ${res?.messages?.length || 0} messages (attempt ${attempt}/${MAX_EXTRACT_RETRIES}) — refreshing tab...`);
        await chrome.tabs.reload(tabId);
        await waitForTabLoad(tabId, 30000);
        await new Promise(r => setTimeout(r, 2000));
        await waitForCorrectChat(tabId, fanId);
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      // Content script not reachable — refresh the tab to re-inject it
      if (attempt < MAX_EXTRACT_RETRIES) {
        console.warn(`[NYX CRM] ⚠️ Content script unreachable (attempt ${attempt}/${MAX_EXTRACT_RETRIES}): ${e.message} — refreshing tab...`);
        try {
          await chrome.tabs.reload(tabId);
          await waitForTabLoad(tabId, 30000);
          await new Promise(r => setTimeout(r, 2000));
          await waitForCorrectChat(tabId, fanId);
          await new Promise(r => setTimeout(r, 1000));
        } catch (refreshErr) {
          console.warn(`[NYX CRM] ⚠️ Tab refresh failed:`, refreshErr.message);
        }
      } else {
        console.warn(`[NYX CRM] ❌ All ${MAX_EXTRACT_RETRIES} extraction attempts failed for fan ${fanId}`);
      }
    }
  }

  console.log(`[NYX CRM] 📂 Extracted ${messages.length} messages from chat${messages.length === 0 ? ` (failed after ${MAX_EXTRACT_RETRIES} attempts)` : ''}`);

  // ── Step 4: Gap-fill sync — sync ALL extracted messages (PATCH = upsert, never deletes) ──
  // NOTE: We do NOT call syncConversation() here. That would update lastMessageAt
  // and trigger the CRM's onSnapshot listener to re-sort the conversation list.
  // The conversation summary is updated separately by the regular chat-list sync pipeline.
  // Syncing ALL messages (not just last 20) ensures the CRM fills any gaps in history.
  //
  // IMPORTANT: If the conversation was already cleaned up, SKIP the gap-fill sync entirely.
  // Cleanup assigns canonical sequential orderIndex (0,1,2...) for ALL messages.
  // Gap-fill only sees ~20 visible DOM messages and would overwrite those with 0-19,
  // corrupting the order for the rest. New messages are handled by the regular SYNC_CHAT flow.
  if (messages.length > 0) {
    const convDoc = await getDoc(`of_chats/${dataKey()}/conversations/${fanId}`);
    const isCleanedUp = convDoc?.cleanedUp === true;

    if (isCleanedUp) {
      console.log(`[NYX CRM] 📂 Skipping gap-fill sync — conversation already cleanedUp (${convDoc.cleanedUpMessageCount || '?'} msgs). Preserving canonical orderIndex.`);
    } else {
      console.log(`[NYX CRM] 📂 Gap-fill sync: ALL ${messages.length} messages (append-only, no conversation re-sort)...`);

      // syncMessages uses PATCH/upsert — safe to call on existing msgs, only adds new ones
      // Pass skipConversationUpdate=true to prevent re-sorting the CRM list
      // Use isFullSync=true so messages get sequential orderIndex (0,1,2...) instead of timestamp-based
      await syncMessages(null, fanId, fanName, messages, { skipConversationUpdate: true, isFullSync: true });

      console.log(`[NYX CRM] 📂 Synced ${messages.length} messages for fan ${fanId}`);

      // Mark conversation as cleanedUp so CRM applies cleanup filter + removes ⚠️ warning
      await patchDoc(`of_chats/${dataKey()}/conversations/${fanId}`, {
        cleanedUp: true,
        cleanedUpAt: new Date().toISOString(),
        cleanedUpMessageCount: messages.length,
      });
      console.log(`[NYX CRM] 📂 Marked conversation ${fanId} as cleanedUp (${messages.length} msgs)`);
    }
  }

  // ── Step 5: Update heartbeat to reflect activity ──
  await patchDoc(`of_chat_commands/${dataKey()}`, {
    lastHeartbeat: new Date(),
    status: 'chatting',
    activeFanId: fanId,
  });

  // ── Step 5b: Sync subscription status to conversation doc ──
  // When notSubscribed=true, the OF chat shows "Please subscribe to resume messaging"
  // instead of a message input. Write this to Firestore so CRM can show a banner.
  // Always write the field (true or false) so it clears when fan re-subscribes.
  await patchDoc(`of_chats/${dataKey()}/conversations/${fanId}`, {
    notSubscribed: notSubscribed,
    ...(notSubscribed ? { notSubscribedAt: new Date().toISOString() } : { notSubscribedAt: null }),
  });
  if (notSubscribed) {
    console.log(`[NYX CRM] ⚠️ Fan ${fanId} is NOT subscribed — saved to Firestore`);
  }

  console.log(`[NYX CRM] ✅ OPEN_CHAT complete — existing tab navigated to fan ${fanId}, ${messages.length > 0 ? `${messages.length} msgs synced` : 'no messages extracted'}`);

  // ── Step 6: Ask sidepanel to sync fan profile stats to Firestore ──
  // The sidepanel loads notes (subscribedSince, totalSpent, etc.) via detectAndSyncChat.
  // Small delay ensures notes are loaded before we ask for them.
  setTimeout(() => {
    chrome.runtime.sendMessage({
      type: 'CRM_SYNC_PROFILE_ON_OPEN',
      fanId,
    }).catch(() => {
      // Sidepanel not open — no-op
    });
  }, 3000);

  } finally {
    // ── UNLOCK: always release even if extraction/sync threw ──
    openChatInProgress = false;
    console.log(`[NYX CRM] 🔓 OPEN_CHAT lock released (openChatInProgress = false)`);
  }
}

/** Execute SCAN_PROFILE — scrapes subscriber stats directly from the OF chat page
 *  via the content script's SCRAPE_PROFILE_STATS handler, then writes the results
 *  to Firestore so the CRM gets the updated values via onSnapshot. */
async function executeScanProfile(cmd) {
  const fanId = cmd.fanId;
  if (!fanId) throw new Error('Missing fanId');

  console.log(`[NYX CRM] 📊 Executing SCAN_PROFILE for fan ${fanId} — scraping from content script...`);

  // ── Step 1: Find the OF tab with this fan's chat open ──
  const chatUrl = `https://onlyfans.com/my/chats/chat/${fanId}`;
  const ofTabs = await chrome.tabs.query({ url: 'https://onlyfans.com/*' });

  // Prefer the tab that already has this fan's chat open
  let tabId = null;
  for (const t of ofTabs) {
    if (t.url?.includes(`/chat/${fanId}`)) { tabId = t.id; break; }
  }
  // Fallback: any OF tab
  if (!tabId && ofTabs.length > 0) tabId = ofTabs[0].id;
  if (!tabId) throw new Error('No OnlyFans tab found — cannot scan profile');

  // If the tab isn't already on the fan's chat, navigate to it
  const currentTab = ofTabs.find(t => t.id === tabId);
  if (!currentTab?.url?.includes(`/chat/${fanId}`)) {
    console.log(`[NYX CRM] 📊 Navigating OF tab to fan ${fanId} chat...`);
    await chrome.tabs.update(tabId, { url: chatUrl });
    await waitForTabLoad(tabId, 30000);
    await new Promise(r => setTimeout(r, 2000)); // Wait for OF to render
  }

  // ── Step 2: Scrape profile stats from the content script ──
  let stats = null;
  const MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_PROFILE_STATS' });
      if (res?.success && res.stats) {
        stats = res.stats;
        console.log(`[NYX CRM] 📊 ✅ Scraped stats for fan ${fanId}:`, JSON.stringify(stats));
        break;
      }
      console.warn(`[NYX CRM] 📊 Scrape attempt ${attempt} returned no stats — retrying...`);
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.warn(`[NYX CRM] 📊 Scrape attempt ${attempt} failed: ${e.message}`);
      if (attempt < MAX_RETRIES) {
        await chrome.tabs.reload(tabId);
        await waitForTabLoad(tabId, 30000);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  // ── Step 3: Also check notSubscribed status ──
  let notSubscribed = false;
  try {
    const chatRes = await chrome.tabs.sendMessage(tabId, { type: 'CRM_OPEN_CHAT' });
    if (chatRes?.notSubscribed) notSubscribed = true;
  } catch { /* ignore */ }

  // ── Step 4: Build the update object and write to Firestore ──
  const update = {
    profileScannedAt: new Date().toISOString(),
    notSubscribed: notSubscribed,
    ...(notSubscribed ? { notSubscribedAt: new Date().toISOString() } : { notSubscribedAt: null }),
  };

  if (stats) {
    // totalSpent: "$8" → store as-is (CRM's parseSpentAmount handles the "$" format)
    if (stats.totalSpent) {
      update.totalSpent = stats.totalSpent;
    }

    // subscribedFor: "1 days" → subscribedDays: 1
    if (stats.subscribedFor) {
      const dayMatch = stats.subscribedFor.match(/(\d+)\s*(day|days|week|weeks|month|months|year|years)/i);
      if (dayMatch) {
        const num = parseInt(dayMatch[1]);
        const unit = dayMatch[2].toLowerCase();
        let days = num;
        if (unit.startsWith('week')) days = num * 7;
        else if (unit.startsWith('month')) days = num * 30;
        else if (unit.startsWith('year')) days = num * 365;
        update.subscribedDays = days;
      }
    }

    // subscribedSince: ISO date string
    if (stats.subscribedSince) {
      update.subscribedSince = stats.subscribedSince;
    }
  }

  // Write to the conversation doc in Firestore
  const convPath = `of_chats/${dataKey()}/conversations/${fanId}`;
  await patchDoc(convPath, update);

  console.log(`[NYX CRM] 📊 ✅ SCAN_PROFILE complete for fan ${fanId} — wrote to Firestore:`, JSON.stringify(update));
}

/** Execute SET_TASK_DAYS — converts CRM taskDays (number) to a deadline ISO string
 *  and sends it to the sidepanel so Clarity's local notes get updated in real-time. */
async function executeSetTaskDays(cmd) {
  const fanId = cmd.fanId;
  const taskDays = Number(cmd.taskDays) || 0;
  if (!fanId) throw new Error('Missing fanId');

  console.log(`[NYX CRM] 🎯 Executing SET_TASK_DAYS for fan ${fanId}: ${taskDays} days`);

  // Convert days-from-now to an absolute ISO deadline (matches Clarity's taskDeadline format)
  const deadline = taskDays > 0
    ? new Date(Date.now() + taskDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  // Send to sidepanel via runtime message — sidepanel listens for CRM_TASK_DAYS_UPDATE
  try {
    await chrome.runtime.sendMessage({
      type: 'CRM_TASK_DAYS_UPDATE',
      fanId,
      taskDays,
      taskDeadline: deadline,
    });
    console.log(`[NYX CRM] 🎯 Sent CRM_TASK_DAYS_UPDATE to sidepanel`);
  } catch {
    // Sidepanel might not be open — that's fine, Firestore already has the data
    console.log(`[NYX CRM] 🎯 Sidepanel not open — task days saved to Firestore only`);
  }
}

/** Execute SAVE_NOTES — relays updated notes from CRM to Clarity's sidepanel.
 *  Follows the same pattern as executeSetTaskDays:
 *  sends a chrome.runtime.sendMessage to sidepanel which updates Store, UI, and DB. */
async function executeSaveNotes(cmd) {
  const fanId = cmd.fanId;
  const notes = cmd.notes;
  if (!fanId) throw new Error('Missing fanId');
  if (!notes || typeof notes !== 'object') throw new Error('Missing or invalid notes');

  console.log(`[NYX CRM] 📝 Executing SAVE_NOTES for fan ${fanId}: ${Object.keys(notes).join(', ')}`);

  try {
    await chrome.runtime.sendMessage({
      type: 'CRM_NOTES_UPDATE',
      fanId,
      notes,
    });
    console.log(`[NYX CRM] 📝 ✅ Sent CRM_NOTES_UPDATE to sidepanel`);
  } catch {
    // Sidepanel not open — that's fine, Firestore already has the data from the CRM write
    console.log(`[NYX CRM] 📝 Sidepanel not open — notes saved to Firestore only`);
  }
}

/** Execute FULL_SYNC — iterates through all fan chats, does a full scroll-scan of each one,
 *  and syncs complete message history (with media) to Firestore.
 *  Receives cmd.fanIds (array of fan IDs) from the CRM. */
async function executeFullSync(cmd) {
  const fanIds = cmd.fanIds;
  if (!Array.isArray(fanIds) || fanIds.length === 0) {
    throw new Error('FULL_SYNC requires fanIds array');
  }

  console.log(`[NYX CRM] 🔄 FULL_SYNC starting — ${fanIds.length} chats to scan...`);

  // Update heartbeat to show full-sync is running
  await patchDoc(`of_chat_commands/${dataKey()}`, {
    lastHeartbeat: new Date(),
    status: 'full-sync',
    fullSyncProgress: {
      current: 0,
      total: fanIds.length,
      currentFanId: null,
      currentFanName: null,
      phase: 'starting',
      messagesCollected: 0,
      startedAt: new Date().toISOString(),
    },
  });

  let totalMessagessynced = 0;

  for (let i = 0; i < fanIds.length; i++) {
    const fanId = String(fanIds[i]).replace(/^of:/i, '');
    const fanName = cmd.fanNames?.[i] || 'Fan';

    console.log(`[NYX CRM] 🔄 FULL_SYNC [${i + 1}/${fanIds.length}] — opening chat for fan ${fanId} (${fanName})...`);

    // Update progress in heartbeat doc so CRM UI can show real-time status
    await patchDoc(`of_chat_commands/${dataKey()}`, {
      lastHeartbeat: new Date(),
      status: 'full-sync',
      fullSyncProgress: {
        current: i,
        total: fanIds.length,
        currentFanId: fanId,
        currentFanName: fanName,
        phase: 'navigating',
        messagesCollected: 0,
      },
    });

    try {
      // ── Step 1: Navigate CRM chat tab using reliable helper ──
      // navigateCrmTab waits for tab load + verifies correct URL in content script
      const tabId = await navigateCrmTab(fanId);

      // ── Step 2: Send CRM_FULL_SCAN — content script scrolls through entire chat ──
      await patchDoc(`of_chat_commands/${dataKey()}`, {
        lastHeartbeat: new Date(),
        fullSyncProgress: {
          current: i,
          total: fanIds.length,
          currentFanId: fanId,
          currentFanName: fanName,
          phase: 'scanning',
          messagesCollected: 0,
        },
      });

      let messages = [];
      try {
        const res = await chrome.tabs.sendMessage(tabId, { type: 'CRM_FULL_SCAN' });
        if (res?.success && res.messages) {
          messages = res.messages;
        }
      } catch (e) {
        console.warn(`[NYX CRM] ⚠️ Full scan failed for fan ${fanId}:`, e.message);
      }

      // ── Retry once if 0 messages (content script may need more time) ──
      if (messages.length === 0) {
        console.log(`[NYX CRM] 🔁 Retrying full scan for fan ${fanId} after 4s...`);
        await new Promise(r => setTimeout(r, 4000));
        try {
          const res = await chrome.tabs.sendMessage(tabId, { type: 'CRM_FULL_SCAN' });
          if (res?.success && res.messages) {
            messages = res.messages;
          }
        } catch (e) {
          console.warn(`[NYX CRM] ⚠️ Full scan retry failed for fan ${fanId}:`, e.message);
        }
      }

      console.log(`[NYX CRM] 🔄 Fan ${fanId}: extracted ${messages.length} messages`);

      // ── Step 3: Only delete + resync if we actually got messages ──
      // SAFETY: Never delete old messages if scan returned 0 — that would wipe data
      if (messages.length > 0) {
        // Update progress to show deleting phase
        await patchDoc(`of_chat_commands/${dataKey()}`, {
          lastHeartbeat: new Date(),
          fullSyncProgress: {
            current: i,
            total: fanIds.length,
            currentFanId: fanId,
            currentFanName: fanName,
            phase: 'deleting',
            messagesCollected: messages.length,
          },
        });

        // Delete ALL existing message docs for this fan — fresh start
        const msgCollectionPath = `of_chats/${dataKey()}/conversations/${fanId}/messages`;
        const deletedCount = await deleteCollection(msgCollectionPath);
        if (deletedCount > 0) {
          console.log(`[NYX CRM] 🗑️ Cleared ${deletedCount} old messages for fan ${fanId} before rescan`);
        }

        // Update progress to show syncing phase
        await patchDoc(`of_chat_commands/${dataKey()}`, {
          lastHeartbeat: new Date(),
          fullSyncProgress: {
            current: i,
            total: fanIds.length,
            currentFanId: fanId,
            currentFanName: fanName,
            phase: 'syncing',
            messagesCollected: messages.length,
          },
        });

        // For full sync, also force-update the conversation summary with the REAL latest message
        const lastMsg = messages[messages.length - 1];
        await syncConversation(fanId, {
          subscriberName: fanName,
          lastMessage: lastMsg?.text || '',
          lastMessageAt: lastMsg?.datetime || new Date().toISOString(),
          hasUnread: false,
        });

        // Sync all messages (append-only upsert)
        await syncMessages(null, fanId, fanName, messages);
        totalMessagessynced += messages.length;
      } else {
        console.warn(`[NYX CRM] ⚠️ 0 messages for fan ${fanId} — skipping delete+resync to protect existing data`);
      }

      // Update progress after completing this fan
      await patchDoc(`of_chat_commands/${dataKey()}`, {
        lastHeartbeat: new Date(),
        fullSyncProgress: {
          current: i + 1,
          total: fanIds.length,
          currentFanId: fanId,
          currentFanName: fanName,
          phase: 'done',
          messagesCollected: messages.length,
        },
      });

      // Small delay between chats to avoid hammering OF
      if (i < fanIds.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }

    } catch (err) {
      console.warn(`[NYX CRM] ⚠️ FULL_SYNC error on fan ${fanId}:`, err.message);
      // Continue to next fan — don't abort the whole sync
    }
  }

  // ── Done: update heartbeat to show completion ──
  await patchDoc(`of_chat_commands/${dataKey()}`, {
    lastHeartbeat: new Date(),
    status: 'idle',
    fullSyncProgress: {
      current: fanIds.length,
      total: fanIds.length,
      currentFanId: null,
      currentFanName: null,
      phase: 'complete',
      messagesCollected: totalMessagessynced,
      completedAt: new Date().toISOString(),
    },
  });

  console.log(`[NYX CRM] ✅ FULL_SYNC complete — ${fanIds.length} chats scanned, ${totalMessagessynced} total messages synced`);
}

/** Execute CLEANUP — for a single fan chat:
 *  1. Delete ALL existing messages from Firebase
 *  2. Navigate to chat on OF
 *  3. Scroll to the VERY TOP (cleanupScanChat)
 *  4. Scrape ALL messages in one pass (chronological)
 *  5. Save everything fresh to Firebase
 *  6. Mark conversation as cleanedUp: true */
async function executeCleanup(cmd) {
  const fanId = cmd.fanId;
  const fanName = cmd.fanName || 'Fan';
  if (!fanId) throw new Error('Missing fanId');

  // ── LOCK: suppress sidepanel SAVE_CHAT/SYNC_CHAT writes for the duration ──
  // Without this, navigateCrmTab() loads the chat → content script's autoLoadChat()
  // fires → sidepanel sends SAVE_CHAT → syncMessages() writes to Firestore IN PARALLEL
  // with our delete-then-rescan cycle → duplicate messages.
  cleanupInProgress = true;
  cleanupStartedAt = Date.now();
  console.log(`[NYX CRM] 🧹 Executing CLEANUP for fan ${fanId} (${fanName}) — syncMessages LOCKED`);

  try {
    const msgCollectionPath = `of_chats/${dataKey()}/conversations/${fanId}/messages`;

    // ── Step 1: Delete ALL existing messages from Firebase ──
    await patchDoc(`of_chat_commands/${dataKey()}`, {
      lastHeartbeat: new Date(),
      status: 'cleanup',
      cleanupProgress: { fanId, fanName, phase: 'deleting', messagesFound: 0 },
    });

    const deletedCount = await deleteCollection(msgCollectionPath);
    console.log(`[NYX CRM] 🧹 Deleted ${deletedCount} old messages for fan ${fanId}`);

    // Also delete the conversation summary doc itself — truly start from zero
    const convDocPath = `of_chats/${dataKey()}/conversations/${fanId}`;
    const convDeleted = await deleteDoc(convDocPath);
    console.log(`[NYX CRM] 🧹 Deleted conversation summary doc for fan ${fanId}: ${convDeleted ? 'OK' : 'not found'}`);

    // ── Step 2: Navigate to chat on OF (same tab — no new tab) ──
    await patchDoc(`of_chat_commands/${dataKey()}`, {
      lastHeartbeat: new Date(),
      cleanupProgress: { fanId, fanName, phase: 'navigating', messagesFound: 0 },
    });

    // Find the EXISTING OnlyFans tab (same approach as executeOpenChat — never create a new one)
    const chatUrl = `https://onlyfans.com/my/chats/chat/${fanId}`;
    const ofTabs = await chrome.tabs.query({ url: 'https://onlyfans.com/*' });
    if (ofTabs.length === 0) {
      throw new Error('No OnlyFans tab open — please open OnlyFans first');
    }
    const ofTab = ofTabs.find(t => t.active) || ofTabs[0];
    let tabId = ofTab.id;

    const alreadyOnChat = ofTab.url && ofTab.url.includes(`/my/chats/chat/${fanId}`);
    if (alreadyOnChat) {
      console.log(`[NYX CRM] 🧹 Already on fan ${fanId}'s chat — skipping navigation`);
    } else {
      console.log(`[NYX CRM] 🧹 Navigating existing OF tab ${tabId} to fan ${fanId} for cleanup...`);
      await chrome.tabs.update(tabId, { url: chatUrl, active: true });

      const loaded = await waitForTabLoad(tabId, 30000);
      if (!loaded) {
        console.warn(`[NYX CRM] ⚠️ Tab load timeout for fan ${fanId} — attempting cleanup anyway`);
      }

      // Buffer for OF's SPA to render the chat DOM
      await new Promise(r => setTimeout(r, 1500));

      // Wait for content script to confirm ready on the CORRECT chat page
      const ready = await waitForCorrectChat(tabId, fanId);
      if (!ready) {
        console.warn(`[NYX CRM] ⚠️ Content script not ready for fan ${fanId} — attempting cleanup anyway`);
      }

      // Final DOM stabilization
      await new Promise(r => setTimeout(r, 1000));
    }

    // ── Step 2b: Clear extension local chat storage for this fan ──
    // This ensures the sidepanel's cached chat data is also wiped
    try {
      const stored = await chrome.storage.local.get('chatStorage');
      if (stored.chatStorage) {
        const chatStorage = stored.chatStorage;
        // Remove chat entries matching this fan's ID
        let cleared = false;
        for (const key of Object.keys(chatStorage)) {
          if (key.includes(fanId)) {
            delete chatStorage[key];
            cleared = true;
          }
        }
        if (cleared) {
          await chrome.storage.local.set({ chatStorage });
          console.log(`[NYX CRM] 🧹 Cleared extension local chat storage for fan ${fanId}`);
        }
      }
    } catch (e) {
      // Non-critical — continue cleanup
      console.warn(`[NYX CRM] ⚠️ Could not clear local chat storage:`, e.message);
    }

    // ── Step 3: Send CRM_CLEANUP_SCAN — content script scrolls to top, then scrapes all ──
    // NOTE: Chrome MV3 has a hard ~5 min timeout on sendMessage channels.
    // Long chats can take 10-30 min to scroll through. So we use a fire-and-forget
    // pattern: content script responds immediately with { started: true }, then
    // sends results as a separate CLEANUP_SCAN_COMPLETE message when done.
    await patchDoc(`of_chat_commands/${dataKey()}`, {
      lastHeartbeat: new Date(),
      cleanupProgress: { fanId, fanName, phase: 'scrolling-to-top', messagesFound: 0 },
    });

    let messages = [];
    try {
      // Set up a listener BEFORE sending the scan command
      const scanResult = await waitForCleanupScanComplete(tabId, fanId, 30 * 60_000); // 30 min timeout
      if (scanResult?.success && scanResult.messages) {
        messages = scanResult.messages;
      }
    } catch (e) {
      console.warn(`[NYX CRM] ⚠️ Cleanup scan failed for fan ${fanId}:`, e.message);
    }

    console.log(`[NYX CRM] 🧹 Cleanup scan: ${messages.length} messages extracted for fan ${fanId}`);

    // ── Step 4: Save all messages to Firebase ──
    if (messages.length > 0) {
      await patchDoc(`of_chat_commands/${dataKey()}`, {
        lastHeartbeat: new Date(),
        cleanupProgress: { fanId, fanName, phase: 'saving', messagesFound: messages.length },
      });

      // Force-update conversation summary with the real latest message
      const lastMsg = messages[messages.length - 1];
      await syncConversation(fanId, {
        subscriberName: fanName,
        lastMessage: lastMsg?.text || '',
        lastMessageAt: lastMsg?.datetime || new Date().toISOString(),
        hasUnread: false,
      });

      // Sync all messages — _internal: true bypasses the cleanupInProgress guard
      await syncMessages(null, fanId, fanName, messages, { _internal: true, isFullSync: true });
    }

    // ── Step 5: Mark conversation as cleanedUp in Firestore ──
    await patchDoc(`of_chats/${dataKey()}/conversations/${fanId}`, {
      cleanedUp: true,
      cleanedUpAt: new Date().toISOString(),
      cleanedUpMessageCount: messages.length,
    });

    // ── Done ──
    await patchDoc(`of_chat_commands/${dataKey()}`, {
      lastHeartbeat: new Date(),
      status: 'idle',
      cleanupProgress: { fanId, fanName, phase: 'complete', messagesFound: messages.length },
    });

    console.log(`[NYX CRM] ✅ CLEANUP complete — ${messages.length} messages saved for fan ${fanId}`);
  } finally {
    // ── UNLOCK: always release even if cleanup throws ──
    cleanupInProgress = false;
    console.log(`[NYX CRM] 🔓 syncMessages UNLOCKED — cleanup finished for fan ${fanId}`);

    // ── Tell sidepanel to re-detect & save the current chat ──
    // After cleanup, the sidepanel still has stale in-memory data (e.g. old 283 messages).
    // Sending CRM_CLEANUP_COMPLETE triggers detectAndSyncChat() which:
    //   1. Re-extracts messages from the DOM (now has the full cleaned chat)
    //   2. Calls SAVE_CHAT → API.saveChat() (updates Heroku backend)
    //   3. Updates the sidepanel's Store → correct message count displayed
    // Small delay so the lock release is fully propagated before the re-sync triggers.
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'CRM_CLEANUP_COMPLETE',
        fanId,
      }).catch(() => {
        // Sidepanel not open — no-op (Heroku will be updated next time chat is opened)
        console.log(`[NYX CRM] 🧹 Sidepanel not open — CRM_CLEANUP_COMPLETE not delivered`);
      });
    }, 500);
  }
}

function startCommandPolling() {
  if (commandPollTimer) clearInterval(commandPollTimer);
  pollCommands(); // immediate first poll
  commandPollTimer = setInterval(pollCommands, COMMAND_POLL_INTERVAL);
  console.log('[NYX CRM] 🔄 Command polling started (every 2s)');
}

function stopCommandPolling() {
  if (commandPollTimer) { clearInterval(commandPollTimer); commandPollTimer = null; }
}


// ============================================================
// DRAFT SYNC — Real-time CRM <-> OF typing bridge via Firestore
// ============================================================

// ============================================================
// SEND LOCK HELPERS — blocks OF page interaction during CRM operations
// ============================================================
// The content script shows a full-page overlay that prevents the chatter
// from clicking anything (especially switching chats) while a CRM command
// is in progress. The bridge sends SEND_LOCK before starting a multi-step
// command and SEND_UNLOCK when the command completes (or fails).

/** Send SEND_LOCK to the OF tab's content script. Safe to call even if tab is gone. */
async function sendLockToTab(tabId, statusText = 'Sending…') {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SEND_LOCK', statusText });
    console.log(`[NYX CRM] 🔒 SEND_LOCK sent to tab ${tabId}: "${statusText}"`);
  } catch (e) {
    console.warn(`[NYX CRM] 🔒 SEND_LOCK failed (tab ${tabId}):`, e.message);
  }
}

/** Send SEND_UNLOCK to the OF tab's content script. Safe to call even if tab is gone. */
async function sendUnlockToTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SEND_UNLOCK' });
    console.log(`[NYX CRM] 🔓 SEND_UNLOCK sent to tab ${tabId}`);
  } catch (e) {
    // Tab might be closed/navigated — that's fine, overlay is destroyed with it
    console.warn(`[NYX CRM] 🔓 SEND_UNLOCK failed (tab ${tabId}):`, e.message);
  }
}

async function findOfTab() {
  const tabs = await chrome.tabs.query({ url: 'https://onlyfans.com/*' });
  if (tabs.length === 0) return null;
  return tabs.find(t => t.active) || tabs[0];
}

async function draftSyncTick() {
  if (!nyxModelId || !isInitialized) return;
  try {
    const cmdDoc = await getDoc(`of_chat_commands/${dataKey()}`);
    if (!cmdDoc) return;
    const ofTab = await findOfTab();
    if (!ofTab) return;

    // ── CRITICAL: Check for pending SEND action FIRST ──
    // When the CRM user clicks Send, both remoteDraft (from the last typing debounce)
    // and remoteDraftAction (SEND) may have new timestamps in the same tick.
    // If we process remoteDraft first, SET_DRAFT_TEXT does selectAll + insertText
    // which causes a visible "delete + re-type" flash BEFORE the send button is clicked.
    // Fix: peek at remoteDraftAction — if SEND is pending, skip SET_DRAFT_TEXT entirely.
    const remoteAction = cmdDoc.remoteDraftAction;
    const hasPendingSend = remoteAction?.type === 'SEND' && remoteAction.ts && remoteAction.ts !== lastRemoteActionTs;

    // ── remoteDraft → SET_DRAFT_TEXT: live typing from CRM to OF compose box ──
    // One-way push: CRM types → remoteDraft in Firestore → bridge sends SET_DRAFT_TEXT → OF compose box.
    // No bounce back: currentDraft.text is frozen (only set once on chat open), so the text
    // we push here is never echoed back to CRM via the currentDraft poll below.
    // SKIP when SEND is pending — text is already in the compose box, no need to re-inject.
    const remoteDraft = cmdDoc.remoteDraft;
    if (remoteDraft && remoteDraft.ts && remoteDraft.ts !== lastRemoteDraftTs) {
      lastRemoteDraftTs = remoteDraft.ts;
      if (hasPendingSend) {
        console.log(`[NYX CRM] ✏️ remoteDraft skipped — SEND action pending (no SET_DRAFT_TEXT flash)`);
      } else {
        const draftText = remoteDraft.text ?? '';
        console.log(`[NYX CRM] ✏️ remoteDraft → SET_DRAFT_TEXT: "${draftText.substring(0, 50)}${draftText.length > 50 ? '...' : ''}"`);
        try {
          await chrome.tabs.sendMessage(ofTab.id, { type: 'SET_DRAFT_TEXT', text: draftText });
          // Small cooldown: skip next draft poll to avoid reading back stale text
          skipDraftPollUntil = Date.now() + 1500;
        } catch { /* silent — tab may not be on a chat page */ }
      }
    }

    // Process remoteDraftAction (CRM user deleting media -> OF compose box)
    if (remoteAction && remoteAction.ts && remoteAction.ts !== lastRemoteActionTs) {
      lastRemoteActionTs = remoteAction.ts;
      if (remoteAction.type === 'DELETE_MEDIA' && remoteAction.index != null) {
        try {
          await chrome.tabs.sendMessage(ofTab.id, { type: 'DELETE_DRAFT_MEDIA', index: remoteAction.index });
        } catch { /* silent */ }
      }

      // REMOVE_PRICE action — CRM user clicked X on the draft price bar
      if (remoteAction.type === 'REMOVE_PRICE') {
        console.log(`[NYX CRM] 💰 REMOVE_PRICE action — removing price from OF compose`);
        try {
          const removeRes = await chrome.tabs.sendMessage(ofTab.id, { type: 'REMOVE_PRICE' });
          if (removeRes?.success) {
            console.log('[NYX CRM] 💰 ✅ REMOVE_PRICE succeeded');
          } else {
            console.warn('[NYX CRM] 💰 REMOVE_PRICE failed:', removeRes?.error);
          }
        } catch (e) {
          console.warn('[NYX CRM] 💰 REMOVE_PRICE error:', e.message);
        }
        // Clear remoteDraftAction after processing
        try {
          await patchDoc(`of_chat_commands/${dataKey()}`, { remoteDraftAction: null });
        } catch { /* non-critical */ }
        return;
      }

      // SET_PRICE action — CRM user set a media price via the Price button
      if (remoteAction.type === 'SET_PRICE' && remoteAction.price != null) {
        console.log(`[NYX CRM] 💰 SET_PRICE action — setting price to $${remoteAction.price}`);
        try {
          const priceRes = await chrome.tabs.sendMessage(ofTab.id, { type: 'SET_PRICE', price: remoteAction.price });
          if (priceRes?.success) {
            console.log('[NYX CRM] 💰 ✅ SET_PRICE succeeded');
          } else {
            console.warn('[NYX CRM] 💰 SET_PRICE failed:', priceRes?.error);
          }
        } catch (e) {
          console.warn('[NYX CRM] 💰 SET_PRICE error:', e.message);
        }
        // Clear remoteDraftAction after processing
        try {
          await patchDoc(`of_chat_commands/${dataKey()}`, { remoteDraftAction: null });
        } catch { /* non-critical */ }
        return;
      }

      // SEND action — CRM user clicked Send
      // STRATEGY: Always ensure the COMPLETE text is in the OF compose box before clicking send.
      // Previously we skipped SET_DRAFT_TEXT to avoid visual "flash", but this caused a race
      // condition where incomplete text would be sent if the last debounced draft sync hadn't
      // reached the compose box yet (typing faster than the 2s poll interval).
      //
      // The SET_DRAFT_TEXT handler in content/index.js has a smart optimization:
      // if text is ALREADY identical in the compose box → skips injection (no flash, no DOM touch).
      // Only when text differs (the race condition case) does it actually do selectAll+insertText.
      // This means: common case = zero visual impact, race case = correct text guaranteed.
      //
      // Flow: SET_DRAFT_TEXT (ensure text) → CRM_TRIGGER_SEND (click) → fallback SEND_MESSAGE
      if (remoteAction.type === 'SEND') {
        const sendText = remoteAction.text || '';
        let sent = false;

        // ── SEND LOCK: block page interaction for the entire SEND action ──
        await sendLockToTab(ofTab.id, 'Sending message…');
        try {
        // Step 1: GUARANTEE the correct text is in the compose box via SET_DRAFT_TEXT
        // The content script checks if text is already identical → returns { skipped: true } with no DOM change.
        // Only if text differs (race condition!) does it inject — preventing incomplete message sends.
        if (sendText) {
          console.log(`[NYX CRM] 📤 SEND action — ensuring complete text via SET_DRAFT_TEXT: "${sendText.substring(0, 50)}${sendText.length > 50 ? '...' : ''}"`);
          try {
            const draftRes = await chrome.tabs.sendMessage(ofTab.id, { type: 'SET_DRAFT_TEXT', text: sendText });
            if (draftRes?.success) {
              if (draftRes.skipped) {
                console.log('[NYX CRM] 📤 ✅ Text already correct in compose box (no injection needed)');
              } else {
                console.log('[NYX CRM] 📤 ✅ Text injected — was out of sync (race condition prevented!)');
              }
              // Brief delay for ProseMirror to process the text change and enable the send button
              await new Promise(r => setTimeout(r, 300));
            } else {
              console.warn('[NYX CRM] 📤 SET_DRAFT_TEXT failed:', draftRes?.error, '— proceeding with send anyway');
            }
          } catch (e) {
            console.warn('[NYX CRM] 📤 SET_DRAFT_TEXT error:', e.message, '— proceeding with send anyway');
          }
        } else {
          console.log('[NYX CRM] 📤 SEND action — no text (media-only send), skipping text injection');
        }

        // Step 2: Click the send button via CRM_TRIGGER_SEND (polls up to 3s for enabled button)
        console.log('[NYX CRM] 📤 Clicking send button via CRM_TRIGGER_SEND...');
        try {
          const triggerRes = await chrome.tabs.sendMessage(ofTab.id, { type: 'CRM_TRIGGER_SEND' });
          if (triggerRes?.success) {
            console.log('[NYX CRM] 📤 ✅ CRM_TRIGGER_SEND succeeded');
            sent = true;
          } else {
            console.warn('[NYX CRM] 📤 CRM_TRIGGER_SEND failed:', triggerRes?.error, '— trying SEND_MESSAGE fallback');
          }
        } catch (e) {
          console.warn('[NYX CRM] 📤 CRM_TRIGGER_SEND error:', e.message, '— trying SEND_MESSAGE fallback');
        }

        // Step 3: Fallback — SEND_MESSAGE with skipInjection (text already injected in Step 1)
        if (!sent && sendText) {
          console.log(`[NYX CRM] 📤 Fallback SEND_MESSAGE (skipInjection): "${sendText.slice(0, 50)}..."`);
          try {
            const sendRes = await chrome.tabs.sendMessage(ofTab.id, { type: 'SEND_MESSAGE', text: sendText, skipInjection: true });
            if (sendRes?.success) {
              console.log('[NYX CRM] 📤 ✅ SEND_MESSAGE (skipInjection) succeeded');
              sent = true;
            } else {
              console.warn('[NYX CRM] 📤 SEND_MESSAGE (skipInjection) failed:', sendRes?.error);
            }
          } catch (e2) {
            console.warn('[NYX CRM] 📤 SEND_MESSAGE (skipInjection) error:', e2.message);
          }
        }

        // Step 4: Last resort — SEND_MESSAGE with full injection (re-injects + clicks send in one shot)
        if (!sent && sendText) {
          console.log(`[NYX CRM] 📤 Last resort SEND_MESSAGE (with injection): "${sendText.slice(0, 50)}..."`);
          try {
            const sendRes = await chrome.tabs.sendMessage(ofTab.id, { type: 'SEND_MESSAGE', text: sendText, skipInjection: false });
            if (sendRes?.success) {
              console.log('[NYX CRM] 📤 ✅ SEND_MESSAGE (with injection) succeeded');
              sent = true;
            } else {
              console.warn('[NYX CRM] 📤 SEND_MESSAGE (with injection) also failed:', sendRes?.error);
            }
          } catch (e3) {
            console.warn('[NYX CRM] 📤 SEND_MESSAGE (with injection) error:', e3.message);
          }
        }

        if (!sent) {
          console.error('[NYX CRM] 📤 ❌ SEND action failed — all paths exhausted');
        }

        // Clear remoteDraftAction after processing to prevent re-fire on bridge restart
        try {
          await patchDoc(`of_chat_commands/${dataKey()}`, {
            remoteDraftAction: null,
            remoteDraft: null,
            lastSendResult: {
              success: sent,
              error: sent ? null : 'All send paths exhausted',
              ts: new Date().toISOString(),
              fanId: action.fanId || null,
              text: (action.text || '').substring(0, 100),
            },
          });
        } catch { /* non-critical */ }


        } finally {
          // ── SEND UNLOCK: always release even if send failed ──
          await sendUnlockToTab(ofTab.id);
        }
        // ── Post-SEND cooldown: skip draft poll for 5s to prevent echo ──
        // After sending, the OF compose box may still have remnants briefly.
        // Skip polling to prevent stale text being read back as a draft echo.
        skipDraftPollUntil = Date.now() + 5000;
        return;
      }
    }

    // ── Cooldown guard: skip draft poll if we just sent a message ──
    if (Date.now() < skipDraftPollUntil) return;

    // Poll content script for current draft state -> write to Firestore
    // TEXT: only synced ONCE on chat entry (to check for unsent drafts)
    // MEDIA: synced constantly (so CRM always shows staged media)
    try {
      const draftRes = await chrome.tabs.sendMessage(ofTab.id, { type: 'GET_DRAFT_STATE' });
      const draft = draftRes?.draft; // content script returns { success, draft: { text, media } | null }
      // Extract fanId from the OF tab URL: /my/chats/chat/{fanId}
      const urlMatch = (ofTab.url || '').match(/\/my\/chats\/chat\/(\d+)/);
      const fanId = urlMatch ? urlMatch[1] : '';

      // Detect chat change — new fanId means user opened a different conversation
      const isNewChat = fanId && fanId !== lastDraftSyncFanId;
      if (isNewChat) {
        lastDraftSyncFanId = fanId;
        initialDraftText = draft?.text || '';  // Cache text from first poll
        console.log(`[NYX CRM] 📝 New chat detected (fan ${fanId}) — initial draft text: "${initialDraftText.slice(0, 50)}${initialDraftText.length > 50 ? '...' : ''}"`);
      }

      if (draft) {
        const currentDraft = {
          // Text: only the initial value (frozen after first poll for this fanId)
          // This prevents continuous OF typing from echoing into CRM
          text: isNewChat ? initialDraftText : initialDraftText,
          media: Array.isArray(draft.media) ? draft.media : [],
          price: draft.price || null,
          fanId,
        };
        const json = JSON.stringify(currentDraft);
        if (json !== lastCurrentDraftJson) {
          lastCurrentDraftJson = json;
          await patchDoc(`of_chat_commands/${dataKey()}`, { currentDraft });
        }
      } else if (lastCurrentDraftJson !== '{}') {
        // Draft is null/empty — clear it in Firestore so CRM knows compose box is empty
        const emptyDraft = { text: '', media: [], fanId };
        const json = JSON.stringify(emptyDraft);
        if (json !== lastCurrentDraftJson) {
          lastCurrentDraftJson = json;
          await patchDoc(`of_chat_commands/${dataKey()}`, { currentDraft: emptyDraft });
        }
      }
    } catch { /* silent */ }
  } catch { /* silent */ }
}

function startDraftSync() {
  if (draftSyncTimer) clearInterval(draftSyncTimer);
  draftSyncTimer = setInterval(draftSyncTick, DRAFT_SYNC_INTERVAL);
  console.log('[NYX CRM] Draft sync started (every 2s)');
}

function stopDraftSync() {
  if (draftSyncTimer) { clearInterval(draftSyncTimer); draftSyncTimer = null; }
  lastRemoteDraftTs = null;
  lastRemoteActionTs = null;
  lastCurrentDraftJson = '';
  lastDraftSyncFanId = null;
  initialDraftText = '';
  skipDraftPollUntil = 0;
}

// ============================================================
// SYNC READINESS — auto-recover from SW restarts
// ============================================================

/** Ensure the bridge is ready for message sync operations.
 *  If not initialized (common after MV3 service worker restart),
 *  attempts to re-init from storage before giving up.
 *  Deduplicates concurrent init attempts via initPromise.
 *  @returns {boolean} true if ready, false if unrecoverable */
async function ensureSyncReady() {
  if (isInitialized && nyxModelId && nyxIdToken) return true;

  // Already attempting init — wait for it
  if (initPromise) {
    try {
      await initPromise;
      return isInitialized && !!nyxModelId;
    } catch {
      return false;
    }
  }

  // Attempt recovery
  console.log('[NYX CRM] 🔄 syncMessages: bridge not ready — attempting auto-recovery...');
  initPromise = initNyxCrmBridge();
  try {
    const ok = await initPromise;
    initPromise = null;
    if (ok) {
      console.log('[NYX CRM] ✅ Auto-recovery successful — bridge re-initialized');
      return true;
    }
    console.warn('[NYX CRM] ⚠️ Auto-recovery failed — bridge could not init');
    return false;
  } catch (e) {
    initPromise = null;
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

    nyxModelId = config.modelId;
    nyxProfileId = config.profileId || null;  // Restore profileId from config

    // Strategy 1: Try stored refresh token first (bypasses MFA entirely)
    if (result.nyxCrmRefreshToken) {
      nyxRefreshToken = result.nyxCrmRefreshToken;
      const refreshed = await refreshToken();
      if (refreshed) {
        startHeartbeat();
        startCommandPolling();
        startDraftSync();
        initOFPresence(getToken, dataKey, FIRESTORE_BASE);
        isInitialized = true;
        console.log(`[NYX CRM] ✅ Bridge initialized via refresh token — model=${nyxModelId}, profile=${nyxProfileId || 'none'}, dataKey=${dataKey()}`);
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
      isInitialized = true;
      console.log(`[NYX CRM] ✅ Bridge initialized via password — model=${nyxModelId}, profile=${nyxProfileId || 'none'}, dataKey=${dataKey()}`);
      return true;
    }

    console.log('[NYX CRM] ⚠️ No refresh token or credentials available');
    return false;
  } catch (e) {
    console.error('[NYX CRM] ❌ Bridge init failed:', e.message);
    isInitialized = false;
    return false;
  }
}

/** Stop the bridge (cleanup) */
export function stopNyxCrmBridge() {
  stopHeartbeat();
  stopCommandPolling();
  stopDraftSync();
  stopOFPresence();
  nyxIdToken = null;
  nyxRefreshToken = null;
  nyxModelId = null;
  nyxProfileId = null;
  isInitialized = false;
  console.log('[NYX CRM] 🛑 Bridge stopped');
}

/** Check if bridge is active */
export function isNyxBridgeActive() {
  return isInitialized && !!nyxModelId;
}

/** Get current bridge status (for UI) */
export function getNyxBridgeStatus() {
  return {
    initialized: isInitialized,
    modelId: nyxModelId,
    profileId: nyxProfileId,
    dataKey: dataKey(),
    hasToken: !!nyxIdToken,
  };
}

/**
 * Connect to NYX CRM: authenticate and return success or MFA challenge.
 * Does NOT start bridge — call selectNyxModel() after.
 * Returns { mfaRequired: false } on success, or MFA challenge data if 2FA is needed.
 */
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
  skipNextStorageChange = true;

  // Save full config for auto-reconnect on service worker restart
  await chrome.storage.local.set({
    nyxCrmConfig: { email: auth.email, password: auth.password, modelId, profileId },
  });

  // Start immediately — we already have a valid token from connectNyxCrm/verifyNyxMfa
  nyxModelId = modelId;
  nyxProfileId = profileId;
  startHeartbeat();
  startCommandPolling();
  startDraftSync();
  isInitialized = true;

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
  if (!nyxModelId || !isInitialized) {
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
  if (!nyxModelId || !isInitialized) return;
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
  if (!nyxModelId || !isInitialized) return;
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
  if (!nyxModelId || !isInitialized) return;
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

// ============================================================
// VAULT SYNC — Push vault pool/vaults/sent data to NYX Firestore
// ============================================================

/** Sync vault data from Clarity to NYX Firestore.
 *  Called when imagePool changes (pool, vaults, or sentMap).
 *  Writes to vault_data/{key} as a single document (~lightweight).
 *  @param {Array} pool — media pool items
 *  @param {Array} vaults — vault folders
 *  @param {Object} sent — sent tracking map
 *  @param {string|null} vaultProfileId — optional per-profile key override (from Clarity profile selector) */
export async function syncVaultToFirestore(pool, vaults, sent, vaultProfileId = null) {
  if (!nyxModelId || !isInitialized) return;

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
async function executeForceVaultSync(cmd) {
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
async function executeRefreshVaultUrls(cmd) {
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
async function executeSendMedia(cmd) {
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
async function executeMarkSent(cmd) {
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
async function executeUnmarkSent(cmd) {
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
  if (!nyxModelId || !isInitialized) return;
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
async function executeVaultMoveMedia(cmd) {
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
async function executeVaultCreate(cmd) {
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
async function executeVaultRename(cmd) {
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
async function executeVaultDelete(cmd) {
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
async function executeVaultDeleteMedia(cmd) {
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
  if (!nyxModelId || !isInitialized) {
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

/** Disconnect and clear config */
export async function disconnectNyxCrm() {
  skipNextStorageChange = true; // prevent listener from re-initing after we clear config
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
  if (!nyxModelId || !nyxIdToken) {
    // State lost — try to restore from storage
    const result = await chrome.storage.local.get(['nyxCrmConfig', 'nyxCrmRefreshToken']);
    const config = result.nyxCrmConfig;
    if (!config?.modelId) return; // Not configured — nothing to do

    if (!nyxModelId) nyxModelId = config.modelId;
    if (!nyxProfileId) nyxProfileId = config.profileId || null;

    // Restore auth token
    if (result.nyxCrmRefreshToken && !nyxIdToken) {
      nyxRefreshToken = result.nyxCrmRefreshToken;
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

    isInitialized = true;
    console.log('[NYX CRM] ⏰ Alarm restored bridge state from storage (SW was suspended)');
  }

  // Now do the actual work: heartbeat + command poll
  await sendHeartbeat();
  await pollCommands();

  // Restart fast intervals (they'll run for ~30s until SW suspends again)
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  }
  if (!commandPollTimer) {
    commandPollTimer = setInterval(pollCommands, COMMAND_POLL_INTERVAL);
  }
  if (!draftSyncTimer) {
    draftSyncTimer = setInterval(draftSyncTick, DRAFT_SYNC_INTERVAL);
  }
}

// ============================================================
// CRM MESSAGE HANDLER — called by index.js for CHAT_MESSAGES / NEW_MESSAGE
// ============================================================
// Previously this was a separate chrome.runtime.onMessage.addListener.
// That caused Chrome MV3 lifecycle issues: the primary listener in index.js
// returned undefined for these types, which could cause Chrome to kill the
// service worker before the async Firestore writes completed.
//
// Now index.js routes these messages here explicitly and returns true,
// guaranteeing the SW stays alive for the async work.

// Dedup: track last synced message IDs per fan to avoid redundant writes
let lastSyncedNewMsgId = '';      // Last NEW_MESSAGE id synced (global — only one chat active)
let lastBatchSyncTime = 0;        // Rate limit for CHAT_MESSAGES batches only (2s)
let lastBatchFanId = '';           // Which fan the last batch was for
let lastBatchLatestId = '';        // Latest message ID in the last batch
let lastBatchMsgCount = 0;        // Message count in last batch (detect new msgs even if latestId same)

/**
 * Handle CHAT_MESSAGES or NEW_MESSAGE from the content script.
 * Called by index.js with sender info already extracted.
 * @param {string} type - 'CHAT_MESSAGES' or 'NEW_MESSAGE'
 * @param {string} fanId - Fan ID extracted from the OF chat URL
 * @param {object|Array} data - message.data from the content script
 * @returns {Promise<{synced: boolean, error?: string}>}
 */
export async function handleCrmChatMessage(type, fanId, data) {
  console.log(`[NYX CRM] 🔴 handleCrmChatMessage: type=${type}, fan=${fanId}, init=${isInitialized}, model=${!!nyxModelId}, token=${!!nyxIdToken}, cleanup=${cleanupInProgress}`);

  // ── Guard: block ALL content script syncs during cleanup to prevent race conditions ──
  // Without this, navigateCrmTab during cleanup loads the chat → content script extracts
  // visible messages → sends CHAT_MESSAGES here → we'd write them BEFORE cleanup finishes
  // deleting + rescanning → stale/duplicate messages survive.
  if (cleanupInProgress) {
    console.log(`[NYX CRM] 🚫 handleCrmChatMessage BLOCKED — cleanup in progress`);
    return { synced: false, reason: 'cleanup in progress' };
  }

  // ── Guard: block CHAT_MESSAGES during OPEN_CHAT to prevent parallel duplicate writes ──
  // When OPEN_CHAT navigates the OF tab, autoLoadChat fires and sends CHAT_MESSAGES here.
  // That would run syncMessages IN PARALLEL with OPEN_CHAT's own syncMessages, and messages
  // without stable OF data-id get random fallback IDs each call → new Firestore docs each time.
  // NEW_MESSAGE is NOT blocked — single new messages during OPEN_CHAT are fine (they have real IDs).
  if (openChatInProgress && type === 'CHAT_MESSAGES') {
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
    if (msgKey === lastSyncedNewMsgId) {
      return { synced: false, reason: 'dedup' };
    }
    lastSyncedNewMsgId = msgKey;

    console.log(`[NYX CRM] 📨 NEW_MESSAGE → fan ${fanId}: "${(msg.text || '').slice(0, 50)}" (id=${msg.id || 'none'})`);

    try {
      if (!isInitialized || !nyxModelId || !nyxIdToken) {
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
    const isSameContent = (fanId === lastBatchFanId && latestId === lastBatchLatestId && latestId !== '' && msgCount === lastBatchMsgCount);

    if (isSameContent) {
      return { synced: false, reason: 'dedup (same content)' };
    }

    // Content changed — allow the sync
    lastBatchSyncTime = now;
    lastBatchFanId = fanId;
    lastBatchLatestId = latestId;
    lastBatchMsgCount = msgCount;

    console.log(`[NYX CRM] 📨 CHAT_MESSAGES → fan ${fanId}: ${allMessages.length} msgs (latest: ${latestId || 'unknown'}, bridge: init=${isInitialized}, model=${!!nyxModelId}, token=${!!nyxIdToken})`);

    try {
      if (!isInitialized || !nyxModelId || !nyxIdToken) {
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
    if (skipNextStorageChange) {
      skipNextStorageChange = false;
      console.log('[NYX CRM] Config changed — skipped (already handled)');
      return;
    }
    console.log('[NYX CRM] Config changed externally — reinitializing bridge...');
    stopNyxCrmBridge();
    setTimeout(initNyxCrmBridge, 1000);
  }
});
