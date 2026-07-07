// ============================================================
// NYX CRM BRIDGE — Barrel Re-exports
// ============================================================
// This file re-exports everything that was previously exported
// from the monolithic nyx-crm-bridge.js file.
// Consumer files (index.js, handlers.js) import from here.

export { syncChatList, syncMessages } from './chat-sync.js';
export { syncVaultToFirestore, syncSentToFirestore, queueCleanup } from './vault.js';
export {
  initNyxCrmBridge,
  stopNyxCrmBridge,
  isNyxBridgeActive,
  getNyxBridgeStatus,
  connectNyxCrm,
  verifyNyxMfa,
  fetchNyxModels,
  selectNyxModel,
  nukeChat,
  syncSpending,
  syncFanProfile,
  setTaskDays,
  disconnectNyxCrm,
  ensureBridgeAlive,
  handleCrmChatMessage,
  fetchVaultFromFirestore,
} from './lifecycle.js';

