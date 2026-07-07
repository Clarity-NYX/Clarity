// ============================================================
// NYX BRIDGE — Sends Clarity chat data to NYX Extension
// ============================================================
// Fire-and-forget: if NYX extension isn't running, Clarity
// continues normally. Bridge failure never breaks Clarity.
// ============================================================

/**
 * Known NYX Extension IDs.
 * First entry = Chrome Web Store published ID (permanent).
 * Add dev/unpacked IDs below for local testing.
 */
const NYX_EXTENSION_IDS = [
  // TODO: Replace with published Chrome Web Store extension ID
  // 'abcdefghijklmnopabcdefghijklmnop',
];

let cachedNyxId = null;
let lastDiscoveryAttempt = 0;
const DISCOVERY_COOLDOWN_MS = 30_000; // Don't re-discover more than once per 30s

/**
 * Discover the NYX extension by trying each known ID with a PING.
 * Caches the result so subsequent calls are instant.
 * Returns the extension ID or null if NYX extension is not reachable.
 */
export async function getNyxExtensionId() {
  if (cachedNyxId) return cachedNyxId;

  // Don't spam discovery attempts
  const now = Date.now();
  if (now - lastDiscoveryAttempt < DISCOVERY_COOLDOWN_MS) return null;
  lastDiscoveryAttempt = now;

  // Also check if user has configured a custom NYX extension ID
  try {
    const stored = await chrome.storage.local.get('nyxExtensionId');
    if (stored.nyxExtensionId) {
      // Prepend user-configured ID so it's tried first
      if (!NYX_EXTENSION_IDS.includes(stored.nyxExtensionId)) {
        NYX_EXTENSION_IDS.unshift(stored.nyxExtensionId);
      }
    }
  } catch (e) {
    // Storage access failed — continue with hardcoded IDs
  }

  for (const id of NYX_EXTENSION_IDS) {
    try {
      const response = await chrome.runtime.sendMessage(id, { type: 'PING' });
      if (response?.pong) {
        cachedNyxId = id;
        console.log('[NYX Bridge] ✅ Connected to NYX Extension:', id);
        return id;
      }
    } catch (e) {
      // This ID didn't respond — try next
      continue;
    }
  }

  console.log('[NYX Bridge] ⚠️ NYX Extension not reachable (tried', NYX_EXTENSION_IDS.length, 'IDs)');
  return null;
}

/**
 * Clear cached ID (call if NYX extension disconnects).
 */
export function resetNyxBridge() {
  cachedNyxId = null;
  lastDiscoveryAttempt = 0;
}

/**
 * Send a full chat sync to NYX Extension (after SAVE_CHAT).
 * Maps Clarity data → NYX bridge message format.
 */
export async function bridgeChatSync(profileId, subscriberId, subscriberName, messages) {
  try {
    const nyxExtId = await getNyxExtensionId();
    if (!nyxExtId) return;

    await chrome.runtime.sendMessage(nyxExtId, {
      type: 'CLARITY_CHAT_SYNC',
      profileId,
      subscriberId,
      subscriberName,
      messages,
    }).catch(() => {}); // Silent fail
  } catch (e) {
    // Bridge failure never breaks Clarity
  }
}

/**
 * Send incremental new messages to NYX Extension (after SYNC_CHAT).
 */
export async function bridgeNewMessages(profileId, subscriberId, subscriberName, newMessages) {
  try {
    const nyxExtId = await getNyxExtensionId();
    if (!nyxExtId) return;

    await chrome.runtime.sendMessage(nyxExtId, {
      type: 'CLARITY_NEW_MESSAGES',
      profileId,
      subscriberId,
      subscriberName,
      newMessages,
    }).catch(() => {});
  } catch (e) {
    // Bridge failure never breaks Clarity
  }
}

/**
 * Send chat list update to NYX Extension (after OF_CHAT_LIST_UPDATED).
 * This populates the conversation summaries in the dashboard.
 */
export async function bridgeChatListUpdate(chatList) {
  try {
    const nyxExtId = await getNyxExtensionId();
    if (!nyxExtId) return;

    await chrome.runtime.sendMessage(nyxExtId, {
      type: 'CLARITY_CHAT_LIST',
      chatList,
    }).catch(() => {});
  } catch (e) {
    // Bridge failure never breaks Clarity
  }
}
