// ============================================================
// NYX CRM BRIDGE — Tab Navigation & Lock Helpers
// ============================================================

import { S } from './state.js';

/** Wait for a tab to finish loading after navigation (status === 'complete').
 *  This is CRITICAL: after chrome.tabs.update(tabId, {url}), the old content
 *  script is destroyed and a new one injects once the page loads. Without waiting,
 *  we'd send messages to the dying old content script → 0 messages. */
export function waitForTabLoad(tabId, timeoutMs = 30000) {
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
export async function waitForCorrectChat(tabId, fanId, maxAttempts = 30, intervalMs = 500) {
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
export async function navigateCrmTab(fanId, { active = false } = {}) {
  const chatUrl = `https://onlyfans.com/my/chats/chat/${fanId}`;
  let tabId = null;
  let isNewTab = false;

  // Try to reuse existing CRM chat tab
  if (S.crmChatTabId) {
    try {
      const existingTab = await chrome.tabs.get(S.crmChatTabId);
      if (existingTab && existingTab.url?.includes('onlyfans.com')) {
        await chrome.tabs.update(S.crmChatTabId, { url: chatUrl, active });
        tabId = S.crmChatTabId;
        console.log(`[NYX CRM] 📂 Reused CRM chat tab ${tabId} — navigating to fan ${fanId} (active=${active})`);
      }
    } catch {
      S.crmChatTabId = null;
    }
  }

  if (!tabId) {
    const newTab = await chrome.tabs.create({ url: chatUrl, active });
    tabId = newTab.id;
    S.crmChatTabId = tabId;
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
export function waitForCleanupScanComplete(tabId, fanId, timeoutMs = 30 * 60_000) {
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

/** Send SEND_LOCK to the OF tab's content script. Safe to call even if tab is gone. */
export async function sendLockToTab(tabId, statusText = 'Sending…') {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SEND_LOCK', statusText });
    console.log(`[NYX CRM] 🔒 SEND_LOCK sent to tab ${tabId}: "${statusText}"`);
  } catch (e) {
    console.warn(`[NYX CRM] 🔒 SEND_LOCK failed (tab ${tabId}):`, e.message);
  }
}

/** Send SEND_UNLOCK to the OF tab's content script. Safe to call even if tab is gone. */
export async function sendUnlockToTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SEND_UNLOCK' });
    console.log(`[NYX CRM] 🔓 SEND_UNLOCK sent to tab ${tabId}`);
  } catch (e) {
    console.warn(`[NYX CRM] 🔓 SEND_UNLOCK failed (tab ${tabId}):`, e.message);
  }
}

export async function findOfTab() {
  const tabs = await chrome.tabs.query({ url: 'https://onlyfans.com/*' });
  if (tabs.length === 0) return null;
  return tabs.find(t => t.active) || tabs[0];
}

