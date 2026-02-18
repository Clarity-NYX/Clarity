// ============================================================
// AUTOCHAT CONSTANTS - From working autochat.js
// ============================================================

// Workflow States
export const WorkflowState = {
  IDLE: 'IDLE',
  GENERATING: 'GENERATING',
  WAITING_RESPONSE: 'WAITING_RESPONSE',
  SENDING: 'SENDING',
  VERIFYING: 'VERIFYING',
  COMPLETE: 'COMPLETE',
  ERROR: 'ERROR'
};

// Timing Constants
export const TIMING = {
  MAX_RETRIES: 3,
  MIN_TIME_BETWEEN_SENDS: 10000, // 10 seconds minimum between sends
  CONDITION_TIMEOUT: 10000,      // 10 seconds timeout for wait conditions
  CONDITION_POLL: 200,           // 200ms polling interval
  MESSAGE_LOAD_DELAY: 1500,      // 1.5 seconds to wait for messages to load
  RESPONSE_TIMEOUT: 15000,       // 15 seconds for AI response generation
  SEND_VERIFICATION_DELAY: 2000, // 2 seconds to verify message sent
  WORKFLOW_RETRY_DELAY: 2000,    // 2 seconds before retrying workflow
  MINIMUM_ACTIONS_FOR_COMPLETE: 3 // Minimum actions before marking script complete
};

// Step Status Types
export const StepStatus = {
  PENDING: 'pending',
  ACTIVE: 'active',
  DONE: 'done',
  ERROR: 'error'
};

// Step Names
export const WORKFLOW_STEPS = ['openingChat', 'loadingMessages', 'generating', 'sending', 'verifying'];
export const STEP_DISPLAY_NAMES = ['Opening', 'Loading', 'Generating', 'Sending', 'Verifying'];

// Default States
export const DEFAULT_STEP_STATUS = {
  openingChat: StepStatus.PENDING,
  loadingMessages: StepStatus.PENDING,
  generating: StepStatus.PENDING,
  sending: StepStatus.PENDING,
  verifying: StepStatus.PENDING
};
