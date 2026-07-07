// ============================================================
// NYX CRM BRIDGE — Shared Mutable State
// ============================================================
// All modules import this object and mutate it directly.
// This replaces the 20+ module-level `let` variables.

export const S = {
  nyxIdToken: null,
  nyxRefreshToken: null,
  nyxTokenExpiry: 0,
  nyxModelId: null,       // Model user ID — kept for user doc lookups & backward compat
  nyxProfileId: null,      // OF Profile ID — used as Firestore data key for all collections
  heartbeatTimer: null,
  commandPollTimer: null,
  isInitialized: false,
  skipNextStorageChange: false, // prevents double-init from selectNyxModel + storage listener
  crmChatTabId: null,      // Separate tab for OPEN_CHAT so main OF tab keeps monitoring chat list
  cleanupInProgress: false, // Suppresses SAVE_CHAT/SYNC_CHAT sync during cleanup
  cleanupStartedAt: 0,     // Timestamp when cleanup started — safety timeout after 10 min
  openChatInProgress: false, // Suppresses CHAT_MESSAGES sync during OPEN_CHAT (prevents duplicate writes)
  draftSyncTimer: null,
  initPromise: null,        // Deduplicates concurrent init attempts
  commandProcessing: false, // Prevents overlapping pollCommands runs

  // Draft sync state (for real-time CRM ↔ OF typing bridge)
  lastRemoteDraftTs: null,
  lastRemoteActionTs: null,
  lastCurrentDraftJson: '',
  skipDraftPollUntil: 0,
  lastDraftSyncFanId: null,
  initialDraftText: '',

  // handleCrmChatMessage dedup state
  lastSyncedNewMsgId: '',
  lastBatchSyncTime: 0,
  lastBatchFanId: '',
  lastBatchLatestId: '',
  lastBatchMsgCount: 0,
};

/** Data key for Firestore paths — uses profileId when set, falls back to modelId for backward compat */
export function dataKey() { return S.nyxProfileId || S.nyxModelId; }

