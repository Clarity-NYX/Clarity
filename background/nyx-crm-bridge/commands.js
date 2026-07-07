// ============================================================
// NYX CRM BRIDGE — Command System
// ============================================================

import { COMMAND_POLL_INTERVAL } from './constants.js';
import { S, dataKey } from './state.js';
import { patchDoc, getDoc, deleteDoc, deleteCollection, runQuery } from './firestore.js';
import { waitForTabLoad, waitForCorrectChat, navigateCrmTab, waitForCleanupScanComplete, findOfTab, sendLockToTab, sendUnlockToTab } from './tab-helpers.js';
import { syncConversation, syncChatList, syncMessages } from './chat-sync.js';

// Vault command handlers imported lazily to avoid circular deps
import { executeForceVaultSync, executeRefreshVaultUrls, executeSendMedia, executeMarkSent, executeUnmarkSent, executeVaultMoveMedia, executeVaultCreate, executeVaultRename, executeVaultDelete, executeVaultDeleteMedia } from './vault.js';

export async function pollCommands() {
  if (!S.nyxModelId) return;
  if (S.commandProcessing) {
    console.log('[NYX CRM] pollCommands skipped — previous run still active');
    return;
  }
  S.commandProcessing = true;
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
    S.commandProcessing = false;
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
  S.openChatInProgress = true;

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
    S.openChatInProgress = false;
    console.log(`[NYX CRM] 🔓 OPEN_CHAT lock released (S.openChatInProgress = false)`);
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
  S.cleanupInProgress = true;
  S.cleanupStartedAt = Date.now();
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

      // Sync all messages — _internal: true bypasses the S.cleanupInProgress guard
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
    S.cleanupInProgress = false;
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

export function startCommandPolling() {
  if (S.commandPollTimer) clearInterval(S.commandPollTimer);
  pollCommands(); // immediate first poll
  S.commandPollTimer = setInterval(pollCommands, COMMAND_POLL_INTERVAL);
  console.log('[NYX CRM] 🔄 Command polling started (every 2s)');
}

export function stopCommandPolling() {
  if (S.commandPollTimer) { clearInterval(S.commandPollTimer); S.commandPollTimer = null; }
}

