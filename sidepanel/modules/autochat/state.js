// ============================================================
// AUTOCHAT STATE MANAGEMENT - From working autochat.js
// ============================================================

import { DEFAULT_STEP_STATUS, WorkflowState } from './constants.js';

// Local state mirror - Pool-Based Event-Driven System
export let autoChatState = {
  enabled: false,
  autoSendEnabled: false,
  prioritizeByProgress: true, // Prioritize chats by script progress
  
  // Pool-based state (no limits anymore)
  activePoolSize: 0,       // Total chats currently in pool
  activePoolReadyCount: 0, // Chats ready to process
  activePoolWaitingCount: 0, // Chats waiting for reply
  currentlyProcessing: null,
  
  // Legacy properties for compatibility
  queueCount: 0,
  waitingCount: 0,
  
  stats: { today: { completed: 0, interrupted: 0, inProgress: 0 } }
};

// Processing status for visual display
export let processingStatus = {
  currentChat: null,
  currentIndex: 0,
  totalChats: 0,
  step: 'idle',
  stepStatus: { ...DEFAULT_STEP_STATUS },
  retries: 0,
  maxRetries: 3,
  timeoutRemaining: 0,
  lastError: null,
  waitingForReply: [],  // Chats waiting for reply: { name, peerId, sentAt, expiresAt }
  waitTimeMinutes: 10    // How long to wait for reply
};

// UI state
export let isCollapsed = true; // Start collapsed

// Workflow state
export let currentWorkflowState = WorkflowState.IDLE;
export let workflowRetries = 0;
export let workflowLock = false;
export let lastProcessedPeerId = null;
export let lastMessageSentTime = 0;

// Track which chats have been AI cross-checked this session
// Only run expensive AI cross-check on FIRST entry to each chat
export const crossCheckedChats = new Set();

// Per-subscriber cooldown tracking (prevents responding to same person for X time)
// Map: peerId → timestamp of last message sent
export const subscriberCooldowns = new Map();

// Cooldown duration in milliseconds (1 minute)
export const COOLDOWN_DURATION_MS = 60 * 1000; // 60 seconds

// Check if subscriber is in cooldown
export function isSubscriberInCooldown(peerId) {
  const peerIdStr = peerId?.toString();
  if (!peerIdStr) return false;
  
  const lastSentTime = subscriberCooldowns.get(peerIdStr);
  if (!lastSentTime) return false;
  
  const elapsed = Date.now() - lastSentTime;
  return elapsed < COOLDOWN_DURATION_MS;
}

// Get remaining cooldown time in seconds
export function getCooldownRemaining(peerId) {
  const peerIdStr = peerId?.toString();
  if (!peerIdStr) return 0;
  
  const lastSentTime = subscriberCooldowns.get(peerIdStr);
  if (!lastSentTime) return 0;
  
  const elapsed = Date.now() - lastSentTime;
  const remaining = COOLDOWN_DURATION_MS - elapsed;
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

// Set cooldown for subscriber (called after sending message)
export function setSubscriberCooldown(peerId) {
  const peerIdStr = peerId?.toString();
  if (peerIdStr) {
    subscriberCooldowns.set(peerIdStr, Date.now());
    console.log(`[Cooldown] ⏱️ Set 1-minute cooldown for ${peerIdStr}`);
  }
}

// Clear expired cooldowns (optional cleanup)
export function cleanupExpiredCooldowns() {
  const now = Date.now();
  for (const [peerId, timestamp] of subscriberCooldowns.entries()) {
    if (now - timestamp > COOLDOWN_DURATION_MS * 2) { // Clean up after 2x duration
      subscriberCooldowns.delete(peerId);
    }
  }
}

// Block list state
export let blockListCollapsed = true;
export let blockedUsers = [];

// ============================================================
// STATE UPDATE FUNCTIONS
// ============================================================

export function updateAutoChatState(updates) {
  autoChatState = { ...autoChatState, ...updates };
}

export function setAutoChatState(newState) {
  autoChatState = { ...autoChatState, ...newState };
}

export function updateProcessingStatus(updates) {
  processingStatus = { ...processingStatus, ...updates };
}

export function setIsCollapsed(value) {
  isCollapsed = value;
}

export function setCurrentWorkflowState(state) {
  currentWorkflowState = state;
}

export function setWorkflowRetries(value) {
  workflowRetries = value;
}

export function setWorkflowLock(value) {
  workflowLock = value;
}

export function setLastProcessedPeerId(value) {
  lastProcessedPeerId = value;
}

export function setLastMessageSentTime(value) {
  lastMessageSentTime = value;
}

export function setBlockListCollapsed(value) {
  blockListCollapsed = value;
}

export function setBlockedUsers(users) {
  blockedUsers = users;
}

export function addBlockedUser(user) {
  if (!blockedUsers.some(u => (u.subscriberId || u.id) === (user.subscriberId || user.id))) {
    blockedUsers = [...blockedUsers, user];
  }
}

export function removeBlockedUser(userId) {
  blockedUsers = blockedUsers.filter(u => (u.subscriberId || u.id) !== userId);
}

// ============================================================
// STEP STATUS HELPERS
// ============================================================

export function resetStepStatuses() {
  processingStatus.stepStatus = { ...DEFAULT_STEP_STATUS };
  processingStatus.lastError = null;
  processingStatus.retries = 0;
}

export function updateStepStatus(step, status, error = null) {
  processingStatus.stepStatus[step] = status;
  if (error) processingStatus.lastError = error;
}

// ============================================================
// STATE SYNC WITH BACKGROUND
// ============================================================

export async function loadAutoChatState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'AUTOCHAT_GET_STATE' });
    
    if (response.success) {
      autoChatState = {
        ...autoChatState,
        ...response.state
      };
      return true;
    }
  } catch (error) {
    console.error('[AutoChat] Failed to load state:', error);
  }
  return false;
}
