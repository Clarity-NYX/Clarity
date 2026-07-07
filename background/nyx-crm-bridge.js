// ============================================================
// NYX CRM BRIDGE — Compatibility barrel
// ============================================================
// This file re-exports everything from the modular nyx-crm-bridge/ directory.
// Consumers (index.js, handlers.js) import from './nyx-crm-bridge.js'
// and this barrel transparently delegates to the split modules.
//
// Original monolithic file preserved as nyx-crm-bridge-BACKUP.js

export {
  syncChatList,
  syncMessages,
  syncVaultToFirestore,
  syncSentToFirestore,
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
  queueCleanup,
} from './nyx-crm-bridge/index.js';
