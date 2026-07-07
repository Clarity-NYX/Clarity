// ============================================================
// NYX CRM BRIDGE — Chat Sync & Video Upload
// ============================================================
// REWRITTEN: Clean append-only architecture.
// - Dedup: tracks synced message IDs per fan, skips already-written messages
// - Sequential orderIndex: single counter stored on conversation doc
// - No more dual numbering (cleanup=0,1,2 vs realtime=timestamp)
// ============================================================

import { STORAGE_BUCKET, STORAGE_UPLOAD_BASE } from './constants.js';
import { S, dataKey } from './state.js';
import { getToken } from './auth.js';
import { patchDoc, getDoc, listDocs } from './firestore.js';
import { findOfTab } from './tab-helpers.js';
import { normalizeTimestamp, estimateTimestampFromDisplay, parseSpentAmount } from './utils.js';

// Forward declaration — resolved at runtime (avoids circular dep)
let _ensureSyncReady = null;
export function _setEnsureSyncReady(fn) { _ensureSyncReady = fn; }

// ============================================================
// DEDUP TRACKING — per-fan Set of message IDs already in Firestore
// ============================================================
// On MV3 service worker restart, these are empty. First call for
// a fan populates from Firestore via listDocs. Subsequent calls
// skip already-known IDs without any Firestore reads.
const _syncedIds = new Map(); // fanId → Set<msgId>
const _maxOrderIdx = new Map(); // fanId → number (current max orderIndex)

/** Get or populate the synced-IDs set for a fan.
 *  First call does a listDocs read; subsequent calls return from cache. */
async function getSyncedIds(fanId) {
  if (_syncedIds.has(fanId)) return _syncedIds.get(fanId);

  const set = new Set();
  const msgBasePath = `of_chats/${dataKey()}/conversations/${fanId}/messages`;

  try {
    // listDocs returns { id, _name } objects — we only need IDs for dedup
    const docs = await listDocs(msgBasePath);
    if (docs?.length) {
      for (const d of docs) {
        if (d.id) set.add(d.id);
      }
      // maxOrderIndex is read from the conversation doc in syncMessages()
      // (listDocs doesn't return field data, only doc IDs)
      console.log(`[NYX CRM] 📋 Loaded ${set.size} existing message IDs for fan ${fanId}`);
    }
  } catch (e) {
    console.warn(`[NYX CRM] ⚠️ Could not load existing IDs for fan ${fanId}:`, e.message);
    // Continue with empty set — worst case we'll rewrite some messages
  }

  _syncedIds.set(fanId, set);
  return set;
}

/** Get the current max orderIndex for a fan. */
function getMaxOrderIndex(fanId) {
  return _maxOrderIdx.get(fanId) ?? -1;
}

/** Update max orderIndex after writing. */
function setMaxOrderIndex(fanId, val) {
  _maxOrderIdx.set(fanId, val);
}

/** Clear cached data for a fan (e.g. after nukeChat). */
export function clearFanCache(fanId) {
  _syncedIds.delete(fanId);
  _maxOrderIdx.delete(fanId);
}

// ============================================================
// SYNC CONVERSATION SUMMARY
// ============================================================

/** Sync a conversation summary (from OF_CHAT_LIST_UPDATED) */
export async function syncConversation(fanId, data) {
  if (!S.nyxModelId || !fanId) return;
  try {
    const resolvedName = data.subscriberName || data.name || null;
    const doc = {
      ...(resolvedName && resolvedName !== 'Fan' ? { fanName: resolvedName } : {}),
      lastMessage: data.lastMessage || data.lastMessagePreview || data.preview || '',
      isUnread: data.hasUnread || false,
    };

    // ── Resolve lastMessageAt with priority chain ──
    let isoTimestamp = null;

    const epochMs = Number(data.lastMessageTimestamp);
    if (epochMs > 1e12) {
      const d = new Date(epochMs);
      if (!isNaN(d.getTime()) && d.getFullYear() >= 2020) {
        isoTimestamp = d.toISOString();
      }
    }

    if (!isoTimestamp && data.lastMessageAt) {
      isoTimestamp = normalizeTimestamp(data.lastMessageAt);
    }

    if (!isoTimestamp && data.fullTime) {
      isoTimestamp = normalizeTimestamp(data.fullTime);
    }

    if (!isoTimestamp && data.timeText) {
      const estimated = estimateTimestampFromDisplay(data.timeText);
      if (estimated) isoTimestamp = new Date(estimated).toISOString();
    }

    if (isoTimestamp) doc.lastMessageAt = isoTimestamp;

    const rawSpent = data.totalSpent ?? data.notes?.totalSpent ?? null;
    if (rawSpent !== null && rawSpent !== undefined) {
      const amount = parseSpentAmount(rawSpent);
      if (amount > 0) doc.totalSpent = amount;
    }

    const result = await patchDoc(`of_chats/${dataKey()}/conversations/${fanId}`, doc);
    if (!result) console.warn(`[NYX CRM] ⚠️ syncConversation failed for fan ${fanId}`);
  } catch (e) {
    console.warn(`[NYX CRM] ❌ syncConversation error for fan ${fanId}:`, e.message);
  }
}

// ============================================================
// SYNC CHAT LIST
// ============================================================

/** Sync a full chat list — parallelized with concurrency limit. */
export async function syncChatList(chatList) {
  if (!S.nyxModelId || !S.isInitialized || !chatList?.length) return;

  console.log(`[NYX CRM] 📋 Syncing ${chatList.length} conversations (parallel)...`);
  const CONCURRENCY = 6;
  let synced = 0;

  const validChats = chatList.filter(chat => {
    const fanId = String(chat.rawId || chat.subscriberId || chat.id || '').replace(/^of:/i, '');
    return !!fanId;
  });

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

  console.log(`[NYX CRM] 📋 Synced ${synced}/${chatList.length} conversations`);
}

// ============================================================
// SYNC MESSAGES — APPEND-ONLY WITH DEDUP
// ============================================================
// Key changes from old version:
// 1. Checks which message IDs already exist → skips them
// 2. Uses a single sequential orderIndex counter (no dual system)
// 3. Only writes genuinely new messages
// 4. Tracks maxOrderIndex on conversation doc for consistent ordering

export async function syncMessages(profileId, subscriberId, subscriberName, messages, { _internal = false, skipConversationUpdate = false } = {}) {
  console.log(`[NYX CRM] 🟡 syncMessages: sub=${subscriberId}, msgs=${messages?.length || 0}, model=${S.nyxModelId || 'null'}`);

  // ── Auto-recover if bridge lost state ──
  if (!S.nyxModelId || !S.isInitialized) {
    const ready = await _ensureSyncReady();
    if (!ready) {
      console.error(`[NYX CRM] ❌ syncMessages DROPPED — bridge not ready`);
      return;
    }
  }

  // ── Guard: suppress during cleanup ──
  if (S.cleanupInProgress && !_internal) {
    const CLEANUP_SAFETY_TIMEOUT = 10 * 60_000;
    if (S.cleanupStartedAt > 0 && (Date.now() - S.cleanupStartedAt) > CLEANUP_SAFETY_TIMEOUT) {
      S.cleanupInProgress = false;
      S.cleanupStartedAt = 0;
    } else {
      console.log(`[NYX CRM] 🚫 syncMessages SKIPPED — cleanup in progress`);
      return;
    }
  }

  const fanId = String(subscriberId).replace(/^of:/i, '');
  if (!fanId || !messages?.length) return;

  // ── Validate messages ──
  const validMessages = messages.filter(m => {
    if (!m.id || m.id === 'null' || m.id === 'undefined') {
      const sender = (m.isFromMe || m.fromMe) ? 'me' : 'them';
      const textHash = (m.text || '').substring(0, 80).replace(/[^a-zA-Z0-9]/g, '');
      const timeHint = m.datetime || m.time || '';
      m.id = `rt-${sender}-${textHash.substring(0, 30)}-${timeHint.replace(/[^0-9T:]/g, '').substring(0, 15)}`;
    }
    const id = String(m.id);
    if (!id) return false;
    if (!m.text && !m.mediaThumbnail && !m.thumbnail && !m.mediaType) return false;
    return true;
  });

  if (validMessages.length === 0) {
    console.error(`[NYX CRM] ❌ syncMessages: ALL ${messages.length} messages rejected for fan ${fanId}`);
    return;
  }

  // ── DEDUP: Get existing message IDs for this fan ──
  const existingIds = await getSyncedIds(fanId);
  const newMessages = validMessages.filter(m => !existingIds.has(String(m.id)));

  if (newMessages.length === 0) {
    console.log(`[NYX CRM] ✅ syncMessages: all ${validMessages.length} messages already exist for fan ${fanId} — nothing to write`);
    // Still update conversation summary if needed
    if (!skipConversationUpdate) {
      const lastMsg = validMessages[validMessages.length - 1];
      await syncConversation(fanId, {
        subscriberName: subscriberName || 'Fan',
        lastMessage: lastMsg?.text || '',
        lastMessageAt: lastMsg.datetime || new Date().toISOString(),
        hasUnread: false,
      });
    }
    return;
  }

  console.log(`[NYX CRM] 🟢 syncMessages: ${newMessages.length} NEW of ${validMessages.length} total for fan ${fanId}`);

  // ── Update conversation summary ──
  if (!skipConversationUpdate) {
    const lastMsg = validMessages[validMessages.length - 1];
    const lastMsgTime = lastMsg?.datetime ? new Date(lastMsg.datetime).getTime() : 0;
    const ONE_HOUR = 3600_000;

    if (lastMsgTime > Date.now() - ONE_HOUR || !lastMsgTime) {
      await syncConversation(fanId, {
        subscriberName: subscriberName || 'Fan',
        lastMessage: lastMsg?.text || '',
        lastMessageAt: lastMsg.datetime || new Date().toISOString(),
        hasUnread: false,
      });
    }
  }

  // ── Sequential orderIndex: get current max, increment from there ──
  let currentMax = getMaxOrderIndex(fanId);

  // If we don't have a cached max, try reading from conversation doc
  if (currentMax < 0) {
    try {
      // getDoc() returns extracted plain JS values, not raw Firestore fields
      const convDoc = await getDoc(`of_chats/${dataKey()}/conversations/${fanId}`);
      if (convDoc?.maxOrderIndex !== undefined && convDoc.maxOrderIndex !== null) {
        currentMax = Number(convDoc.maxOrderIndex);
      }
    } catch { /* use default */ }
    if (currentMax < 0) currentMax = existingIds.size - 1; // fallback: count of existing msgs
    if (currentMax < 0) currentMax = -1;
  }

  // ── Write new messages with sequential orderIndex ──
  const MAX_THUMBNAIL_SIZE = 200_000;
  const msgBasePath = `of_chats/${dataKey()}/conversations/${fanId}/messages`;
  const CONCURRENCY = 12;
  let synced = 0;
  let failed = 0;
  let lastResolvedTimestamp = null;

  for (let i = 0; i < newMessages.length; i += CONCURRENCY) {
    const batch = newMessages.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((msg, batchIdx) => {
        const globalIdx = i + batchIdx;
        let thumbnail = msg.mediaThumbnail || msg.thumbnail || null;
        if (thumbnail && thumbnail.length > MAX_THUMBNAIL_SIZE) thumbnail = null;

        const docPath = `${msgBasePath}/${String(msg.id)}`;

        // ── Resolve createdAt ──
        let resolvedCreatedAt = null;
        if (msg.datetime) resolvedCreatedAt = normalizeTimestamp(msg.datetime);
        if (!resolvedCreatedAt && msg.time) {
          const estimated = estimateTimestampFromDisplay(msg.time);
          if (estimated) resolvedCreatedAt = new Date(estimated).toISOString();
        }
        if (!resolvedCreatedAt && msg.createdAt) resolvedCreatedAt = normalizeTimestamp(msg.createdAt);
        if (!resolvedCreatedAt && lastResolvedTimestamp) resolvedCreatedAt = lastResolvedTimestamp;
        if (!resolvedCreatedAt) resolvedCreatedAt = new Date().toISOString();
        lastResolvedTimestamp = resolvedCreatedAt;

        // ── Sequential orderIndex ──
        const orderIndex = currentMax + 1 + globalIdx;

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
          orderIndex,
        };

        return patchDoc(docPath, docFields);
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) synced++;
      else failed++;
    }
  }

  // ── Update tracking ──
  const newMax = currentMax + newMessages.length;
  setMaxOrderIndex(fanId, newMax);

  // Add all written IDs to the synced set
  for (const msg of newMessages) {
    existingIds.add(String(msg.id));
  }

  // ── Update maxOrderIndex on conversation doc ──
  try {
    await patchDoc(`of_chats/${dataKey()}/conversations/${fanId}`, { maxOrderIndex: newMax });
  } catch (e) {
    console.warn(`[NYX CRM] ⚠️ Failed to update maxOrderIndex for fan ${fanId}:`, e.message);
  }

  if (failed > 0) {
    console.log(`[NYX CRM] ⚠️ syncMessages: ${synced} succeeded, ${failed} failed for fan ${fanId}`);
  } else {
    console.log(`[NYX CRM] ✅ syncMessages: ${synced} NEW messages written for fan ${fanId} (orderIndex ${currentMax + 1}→${newMax})`);
  }

  // ── Video enrichment (unchanged) ──
  const videosWithUrl = newMessages.filter(m =>
    m.mediaType === 'video' && m.mediaUrl &&
    !m.mediaUrl.startsWith('blob:') &&
    !m.mediaUrl.includes('firebasestorage.googleapis.com') &&
    (m.mediaUrl.includes('cdn') || m.mediaUrl.includes('cloudfront') || m.mediaUrl.startsWith('https://'))
  );
  const videosWithoutUrl = newMessages.filter(m =>
    m.mediaType === 'video' && !m.mediaUrl
  );

  if (videosWithUrl.length > 0) {
    processVideoUploads(fanId, videosWithUrl, msgBasePath).catch(e => {
      console.warn(`[NYX CRM] 🎬 Video upload failed:`, e.message);
    });
  }
  if (videosWithoutUrl.length > 0) {
    enrichVideoUrls(fanId, videosWithoutUrl, msgBasePath).catch(e => {
      console.warn(`[NYX CRM] 🎬 Video enrichment failed:`, e.message);
    });
  }
}

// ============================================================
// VIDEO DOWNLOAD + FIREBASE STORAGE UPLOAD
// ============================================================

const videoUploadTracker = new Set();

async function downloadAndUploadVideo(cdnUrl, storagePath) {
  const token = await getToken();
  if (!token) return null;

  let videoBlob;
  try {
    const cdnRes = await fetch(cdnUrl);
    if (!cdnRes.ok) return null;
    videoBlob = await cdnRes.blob();
  } catch (e) {
    console.warn(`[NYX CRM] 🎬 CDN download error:`, e.message);
    return null;
  }

  const MAX_VIDEO_SIZE = 500 * 1024 * 1024;
  if (videoBlob.size > MAX_VIDEO_SIZE || videoBlob.size < 1024) return null;

  const contentType = videoBlob.type || 'video/mp4';
  const encodedPath = encodeURIComponent(storagePath);
  const uploadUrl = `${STORAGE_UPLOAD_BASE}?uploadType=media&name=${encodedPath}`;

  try {
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': contentType, Authorization: `Bearer ${token}` },
      body: videoBlob,
    });
    if (!uploadRes.ok) return null;
    await uploadRes.json();
    return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodedPath}?alt=media`;
  } catch (e) {
    console.warn(`[NYX CRM] 🎬 Upload error:`, e.message);
    return null;
  }
}

async function processVideoUploads(fanId, videoMsgs, msgBasePath) {
  let uploaded = 0;
  for (const msg of videoMsgs) {
    const msgId = String(msg.id);
    if (videoUploadTracker.has(msgId)) continue;
    videoUploadTracker.add(msgId);

    try {
      const urlPath = new URL(msg.mediaUrl).pathname;
      const ext = urlPath.match(/\.(mp4|webm|mov|m4v)$/i)?.[1]?.toLowerCase() || 'mp4';
      const storagePath = `of-chat-videos/${dataKey()}/${fanId}/${msgId}.${ext}`;
      const downloadUrl = await downloadAndUploadVideo(msg.mediaUrl, storagePath);
      if (downloadUrl) {
        await patchDoc(`${msgBasePath}/${msgId}`, { videoStorageUrl: downloadUrl });
        uploaded++;
      }
    } catch (e) {
      console.warn(`[NYX CRM] 🎬 Error processing video ${msgId}:`, e.message);
    }

    if (videoMsgs.indexOf(msg) < videoMsgs.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  console.log(`[NYX CRM] 🎬 Video uploads: ${uploaded}/${videoMsgs.length}`);
}

async function enrichVideoUrls(fanId, videoMsgs, msgBasePath) {
  const ofTab = await findOfTab();
  if (!ofTab) return;

  try {
    const response = await chrome.tabs.sendMessage(ofTab.id, {
      type: 'FETCH_VIDEO_URLS', chatId: fanId,
    });
    if (!response?.success || !response.videoUrls) return;

    const videoUrls = response.videoUrls;
    const enrichedMsgs = [];

    for (const msg of videoMsgs) {
      const msgId = String(msg.id);
      const cdnUrl = videoUrls[msgId];
      if (cdnUrl && !cdnUrl.startsWith('blob:')) {
        try {
          await patchDoc(`${msgBasePath}/${msgId}`, { mediaUrl: cdnUrl });
          enrichedMsgs.push({ ...msg, mediaUrl: cdnUrl });
        } catch { /* skip */ }
      }
    }

    if (enrichedMsgs.length > 0) {
      processVideoUploads(fanId, enrichedMsgs, msgBasePath).catch(() => {});
    }
  } catch (e) {
    console.warn(`[NYX CRM] 🎬 enrichVideoUrls error:`, e.message);
  }
}
