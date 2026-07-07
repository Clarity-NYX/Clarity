// ============================================================
// NYX CRM BRIDGE — Heartbeat
// ============================================================

import { HEARTBEAT_INTERVAL, ALARM_NAME, ALARM_PERIOD_MINUTES } from './constants.js';
import { S, dataKey } from './state.js';
import { patchDoc } from './firestore.js';

export async function sendHeartbeat() {
  if (!S.nyxModelId) return;
  try {
    await patchDoc(`of_chat_commands/${dataKey()}`, {
      lastHeartbeat: new Date(),
      clarityVersion: chrome.runtime.getManifest().version,
      ...(!S.cleanupInProgress ? { status: 'idle' } : {}),
    });
  } catch (e) {
    // Silent — heartbeat failure should never break Clarity
  }
}

export function startHeartbeat() {
  if (S.heartbeatTimer) clearInterval(S.heartbeatTimer);
  sendHeartbeat();
  S.heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  console.log('[NYX CRM] 💓 Heartbeat started (interval 30s + alarm every ~24s)');
}

export function stopHeartbeat() {
  if (S.heartbeatTimer) { clearInterval(S.heartbeatTimer); S.heartbeatTimer = null; }
  chrome.alarms.clear(ALARM_NAME).catch(() => {});
}

