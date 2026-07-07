// ============================================================
// OF PRESENCE MANAGER — Open/Close OnlyFans based on CRM activity
// ============================================================
// Polls Firestore `of_presence/{profileId}` to determine if any
// CRM user is actively on /of-chat. Controls the OF tab lifecycle:
//
//  1. User opens /of-chat → presence.active = true → Open OF tab
//  2. User navigates away → presence.active = false → Navigate to /my/chats/
//  3. 3 minutes of inactivity → Close OF tab entirely (go "offline")
//  4. User returns to /of-chat → Re-open OF tab
// ============================================================

const PRESENCE_POLL_INTERVAL = 5_000;  // Poll every 5 seconds
const IDLE_CLOSE_TIMEOUT = 3 * 60_000; // 3 minutes before closing OF tab
const OF_CHATS_URL = 'https://onlyfans.com/my/chats/';

// ── State ──
let presencePollTimer = null;
let idleCloseTimer = null;
let ofPresenceTabId = null;     // The OF tab we manage
let lastPresenceActive = null;  // Last known active state
let presenceInitialized = false;

// These are set by initOFPresence from nyx-crm-bridge
let _getToken = null;
let _dataKey = null;
let _firestoreBase = null;

/**
 * Initialize the OF presence manager.
 * Called from nyx-crm-bridge after CRM auth is established.
 * @param {Function} getTokenFn - async function that returns a valid Firebase idToken
 * @param {Function} dataKeyFn - function that returns the current profileId
 * @param {string} firestoreBase - Firestore REST API base URL
 */
export function initOFPresence(getTokenFn, dataKeyFn, firestoreBase) {
  _getToken = getTokenFn;
  _dataKey = dataKeyFn;
  _firestoreBase = firestoreBase;

  if (presenceInitialized) return;
  presenceInitialized = true;

  startPresencePolling();
  console.log('[OF Presence] ✅ Presence manager initialized');
}

/** Stop the presence manager (on disconnect/logout) */
export function stopOFPresence() {
  if (presencePollTimer) { clearInterval(presencePollTimer); presencePollTimer = null; }
  if (idleCloseTimer) { clearTimeout(idleCloseTimer); idleCloseTimer = null; }
  presenceInitialized = false;
  lastPresenceActive = null;
  console.log('[OF Presence] 🛑 Presence manager stopped');
}

// ============================================================
// POLLING — Check presence doc in Firestore
// ============================================================

function startPresencePolling() {
  if (presencePollTimer) clearInterval(presencePollTimer);
  pollPresence(); // immediate first check
  presencePollTimer = setInterval(pollPresence, PRESENCE_POLL_INTERVAL);
}

async function pollPresence() {
  const profileId = _dataKey?.();
  if (!profileId || !_getToken || !_firestoreBase) return;

  try {
    const token = await _getToken();
    if (!token) return;

    const url = `${_firestoreBase}/of_presence/${profileId}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      // Doc doesn't exist yet — treat as inactive
      if (res.status === 404) {
        handlePresenceChange(false, null);
        return;
      }
      return;
    }

    const data = await res.json();
    const fields = data.fields || {};
    const active = fields.active?.booleanValue === true;
    const lastSeen = fields.lastSeen?.timestampValue
      ? new Date(fields.lastSeen.timestampValue)
      : null;

    // Stale check: if lastSeen > 60s ago, treat as inactive
    // (safety net for crashed CRM tabs that didn't clean up)
    if (active && lastSeen) {
      const staleMs = Date.now() - lastSeen.getTime();
      if (staleMs > 60_000) {
        console.log(`[OF Presence] ⚠️ Presence stale (${(staleMs / 1000).toFixed(0)}s) — treating as inactive`);
        handlePresenceChange(false, lastSeen);
        return;
      }
    }

    handlePresenceChange(active, lastSeen);
  } catch (err) {
    console.warn('[OF Presence] Poll error:', err.message);
  }
}

// ============================================================
// TAB MANAGEMENT — Open/Close/Navigate OF tabs
// ============================================================

async function handlePresenceChange(active, lastSeen) {
  // No change — skip
  if (active === lastPresenceActive) return;

  const prevState = lastPresenceActive;
  lastPresenceActive = active;

  if (active) {
    // ── CRM user came online → Open OF ──
    console.log('[OF Presence] 🟢 CRM user active — opening OnlyFans');
    cancelIdleClose();
    await openOFTab();
  } else {
    // ── CRM user went offline → Navigate to /my/chats/ and start idle timer ──
    console.log('[OF Presence] 🔴 CRM user inactive — navigating to chats list');
    await navigateToChatslist();
    startIdleCloseTimer();
  }
}

/** Open the OF chats page in a managed tab */
async function openOFTab() {
  // Check if our managed tab still exists
  if (ofPresenceTabId) {
    try {
      const tab = await chrome.tabs.get(ofPresenceTabId);
      if (tab && tab.url?.includes('onlyfans.com')) {
        // Tab exists — navigate to chats list if it was closed/idle
        if (!tab.url.includes('/my/chats')) {
          await chrome.tabs.update(ofPresenceTabId, { url: OF_CHATS_URL });
        }
        console.log('[OF Presence] 📂 Reused existing OF tab', ofPresenceTabId);
        return;
      }
    } catch {
      ofPresenceTabId = null;
    }
  }

  // Also check if there's already an OF tab open (opened by user or another system)
  try {
    const tabs = await chrome.tabs.query({ url: '*://onlyfans.com/*' });
    if (tabs.length > 0) {
      ofPresenceTabId = tabs[0].id;
      console.log('[OF Presence] 📂 Found existing OF tab', ofPresenceTabId);
      return;
    }
  } catch { /* ignore */ }

  // No OF tab found — create one
  try {
    const tab = await chrome.tabs.create({ url: OF_CHATS_URL, active: false });
    ofPresenceTabId = tab.id;
    console.log('[OF Presence] 📂 Created new OF tab', ofPresenceTabId);
  } catch (err) {
    console.warn('[OF Presence] Failed to create OF tab:', err.message);
  }
}

/** Navigate the managed OF tab to the general chats list (not a specific chat) */
async function navigateToChatslist() {
  if (!ofPresenceTabId) return;

  try {
    const tab = await chrome.tabs.get(ofPresenceTabId);
    if (tab && tab.url?.includes('onlyfans.com')) {
      // Only navigate if we're on a specific chat (not already on /my/chats/)
      if (tab.url.includes('/my/chats/chat/')) {
        await chrome.tabs.update(ofPresenceTabId, { url: OF_CHATS_URL });
        console.log('[OF Presence] ↩️ Navigated to /my/chats/ (away from specific chat)');
      }
    }
  } catch {
    ofPresenceTabId = null;
  }
}

/** Close the managed OF tab entirely (go "offline") */
async function closeOFTab() {
  console.log('[OF Presence] 🚫 Closing OF tab (3 min idle timeout)');

  // Close our managed tab
  if (ofPresenceTabId) {
    try {
      await chrome.tabs.remove(ofPresenceTabId);
      console.log('[OF Presence] ✅ Closed managed OF tab', ofPresenceTabId);
    } catch { /* already closed */ }
    ofPresenceTabId = null;
  }

  // Also close any other OF tabs to ensure full offline
  try {
    const tabs = await chrome.tabs.query({ url: '*://onlyfans.com/*' });
    for (const tab of tabs) {
      try { await chrome.tabs.remove(tab.id); } catch { /* ignore */ }
    }
    if (tabs.length > 0) {
      console.log(`[OF Presence] ✅ Closed ${tabs.length} OF tab(s) — fully offline`);
    }
  } catch { /* ignore */ }
}

// ============================================================
// IDLE TIMER — 3 minutes of no CRM activity → close OF
// ============================================================

function startIdleCloseTimer() {
  cancelIdleClose();
  console.log('[OF Presence] ⏱️ Starting 3-minute idle close timer');
  idleCloseTimer = setTimeout(() => {
    console.log('[OF Presence] ⏱️ 3-minute idle timeout reached');
    closeOFTab();
    idleCloseTimer = null;
  }, IDLE_CLOSE_TIMEOUT);
}

function cancelIdleClose() {
  if (idleCloseTimer) {
    clearTimeout(idleCloseTimer);
    idleCloseTimer = null;
    console.log('[OF Presence] ⏱️ Idle close timer cancelled (user came back)');
  }
}

// ============================================================
// TAB CLOSE LISTENER — Track if our managed tab was manually closed
// ============================================================

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === ofPresenceTabId) {
    ofPresenceTabId = null;
    console.log('[OF Presence] 📂 Managed OF tab was closed externally');
  }
});
