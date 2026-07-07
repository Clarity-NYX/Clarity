// ============================================================
// NYX CRM BRIDGE — Draft Sync (Real-time CRM ↔ OF typing bridge)
// ============================================================

import { DRAFT_SYNC_INTERVAL } from './constants.js';
import { S, dataKey } from './state.js';
import { patchDoc, getDoc } from './firestore.js';
import { findOfTab, sendLockToTab, sendUnlockToTab } from './tab-helpers.js';

export async function draftSyncTick() {
  if (!S.nyxModelId || !S.isInitialized) return;
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
    const hasPendingSend = remoteAction?.type === 'SEND' && remoteAction.ts && remoteAction.ts !== S.lastRemoteActionTs;

    // ── remoteDraft → SET_DRAFT_TEXT: live typing from CRM to OF compose box ──
    // One-way push: CRM types → remoteDraft in Firestore → bridge sends SET_DRAFT_TEXT → OF compose box.
    // No bounce back: currentDraft.text is frozen (only set once on chat open), so the text
    // we push here is never echoed back to CRM via the currentDraft poll below.
    // SKIP when SEND is pending — text is already in the compose box, no need to re-inject.
    const remoteDraft = cmdDoc.remoteDraft;
    if (remoteDraft && remoteDraft.ts && remoteDraft.ts !== S.lastRemoteDraftTs) {
      S.lastRemoteDraftTs = remoteDraft.ts;
      if (hasPendingSend) {
        console.log(`[NYX CRM] ✏️ remoteDraft skipped — SEND action pending (no SET_DRAFT_TEXT flash)`);
      } else {
        const draftText = remoteDraft.text ?? '';
        console.log(`[NYX CRM] ✏️ remoteDraft → SET_DRAFT_TEXT: "${draftText.substring(0, 50)}${draftText.length > 50 ? '...' : ''}"`);
        try {
          await chrome.tabs.sendMessage(ofTab.id, { type: 'SET_DRAFT_TEXT', text: draftText });
          // Small cooldown: skip next draft poll to avoid reading back stale text
          S.skipDraftPollUntil = Date.now() + 1500;
        } catch { /* silent — tab may not be on a chat page */ }
      }
    }

    // Process remoteDraftAction (CRM user deleting media -> OF compose box)
    if (remoteAction && remoteAction.ts && remoteAction.ts !== S.lastRemoteActionTs) {
      S.lastRemoteActionTs = remoteAction.ts;
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
              fanId: remoteAction.fanId || null,
              text: (remoteAction.text || '').substring(0, 100),
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
        S.skipDraftPollUntil = Date.now() + 5000;
        return;
      }
    }

    // ── Cooldown guard: skip draft poll if we just sent a message ──
    if (Date.now() < S.skipDraftPollUntil) return;

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
      const isNewChat = fanId && fanId !== S.lastDraftSyncFanId;
      if (isNewChat) {
        S.lastDraftSyncFanId = fanId;
        S.initialDraftText = draft?.text || '';  // Cache text from first poll
        console.log(`[NYX CRM] 📝 New chat detected (fan ${fanId}) — initial draft text: "${S.initialDraftText.slice(0, 50)}${S.initialDraftText.length > 50 ? '...' : ''}"`);
      }

      if (draft) {
        const currentDraft = {
          // Text: only the initial value (frozen after first poll for this fanId)
          // This prevents continuous OF typing from echoing into CRM
          text: isNewChat ? S.initialDraftText : S.initialDraftText,
          media: Array.isArray(draft.media) ? draft.media : [],
          price: draft.price || null,
          fanId,
        };
        const json = JSON.stringify(currentDraft);
        if (json !== S.lastCurrentDraftJson) {
          S.lastCurrentDraftJson = json;
          await patchDoc(`of_chat_commands/${dataKey()}`, { currentDraft });
        }
      } else if (S.lastCurrentDraftJson !== '{}') {
        // Draft is null/empty — clear it in Firestore so CRM knows compose box is empty
        const emptyDraft = { text: '', media: [], fanId };
        const json = JSON.stringify(emptyDraft);
        if (json !== S.lastCurrentDraftJson) {
          S.lastCurrentDraftJson = json;
          await patchDoc(`of_chat_commands/${dataKey()}`, { currentDraft: emptyDraft });
        }
      }
    } catch { /* silent */ }
  } catch { /* silent */ }
}

export function startDraftSync() {
  if (S.draftSyncTimer) clearInterval(S.draftSyncTimer);
  S.draftSyncTimer = setInterval(draftSyncTick, DRAFT_SYNC_INTERVAL);
  console.log('[NYX CRM] Draft sync started (every 2s)');
}

export function stopDraftSync() {
  if (S.draftSyncTimer) { clearInterval(S.draftSyncTimer); S.draftSyncTimer = null; }
  S.lastRemoteDraftTs = null;
  S.lastRemoteActionTs = null;
  S.lastCurrentDraftJson = '';
  S.lastDraftSyncFanId = null;
  S.initialDraftText = '';
  S.skipDraftPollUntil = 0;
}

