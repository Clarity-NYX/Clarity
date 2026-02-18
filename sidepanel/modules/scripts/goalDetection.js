// ============================================================
// SCRIPTS MODULE - GOAL DETECTION (SMART VERSION)
// Only checks CURRENT action, BEFORE generating a response
// No aggressive auto-skip on chat load
// ============================================================

import Store from '../../state/store.js';
import { $ } from '../../utils/dom.js';
import { showNotification } from '../../utils/notify.js';
import API from '../../utils/api.js';
import Progress from './progressManager.js';

// State
let isCheckingGoal = false;
const GOAL_CHECK_CONFIDENCE_THRESHOLD = 0.8; // Raised from 0.7 for more conservative checking

// ============================================================
// SMART GOAL PATTERNS (Requires proper verification)
// ============================================================

const GOAL_PATTERNS = {
  // Goals that require US to initiate
  greeting: {
    goalPatterns: [/greet|say (hi|hello|hey)|introduce yourself|start.*(chat|conversation)/i, /warm.*(welcome|greeting)/i],
    requiresMyMessage: true,
    myMessagePatterns: [/^(hi|hello|hey|good (morning|afternoon|evening))/i, /^how.*(are|you)/i, /welcome/i, /nice to meet/i],
    checkFirstMessage: true // Only complete if WE sent first OR our message matches greeting patterns
  },
  
  // Goals about asking for info (requires US to ask)
  askName: {
    goalPatterns: [/ask.*(their|his|her)?\s*name/i, /find out.*(their|his|her)?\s*name/i, /get.*(their|his|her)?\s*name/i],
    requiresMyMessage: true,
    myMessagePatterns: [/what('s| is).*(your|ur)\s*name/i, /name\?/i, /who am i talking/i, /may i (ask|know)/i]
  },
  
  // Goals where THEY provide info (completed when they respond)
  getName: {
    goalPatterns: [/learn.*(their|his|her)?\s*name/i],
    requiresTheirResponse: true,
    theirMessagePatterns: [/my name is\s+(\w+)/i, /i'm\s+(\w+)/i, /call me\s+(\w+)/i, /name.+is\s+(\w+)/i],
    notesField: 'name'
  },
  
  askAge: {
    goalPatterns: [/ask.*(their|his|her)?\s*age/i, /how old/i, /find out.*(their|his|her)?\s*age/i],
    requiresMyMessage: true,
    myMessagePatterns: [/how old/i, /age\?/i, /what('s| is).*(your|ur)\s*age/i]
  },
  
  getAge: {
    goalPatterns: [/learn.*(their|his|her)?\s*age/i],
    requiresTheirResponse: true,
    theirMessagePatterns: [/i'm\s*(\d{2})/i, /(\d{2})\s*years?\s*old/i, /i am\s*(\d{2})/i],
    notesField: 'age'
  },
  
  askLocation: {
    goalPatterns: [/ask.*(where|location|city|country)/i, /where.*(from|live|located)/i],
    requiresMyMessage: true,
    myMessagePatterns: [/where.*(from|live|based|located)/i, /location\?/i, /what (city|country)/i]
  },
  
  getLocation: {
    goalPatterns: [/learn.*(location|where)/i],
    requiresTheirResponse: true,
    theirMessagePatterns: [/i'm from\s+(\w+)/i, /i live in\s+(\w+)/i, /from\s+(\w+)/i, /based in\s+(\w+)/i],
    notesField: 'location'
  },
  
  // Generic ask pattern
  askQuestion: {
    goalPatterns: [/^ask\s/i, /ask them/i, /ask (about|if|what|how|why|when|where)/i],
    requiresMyMessage: true,
    myMessageMustContain: '?' // Our message must contain a question mark
  }
};

// ============================================================
// SMART SINGLE-ACTION CHECK (Called BEFORE generation)
// ============================================================

// Check if CURRENT action is already satisfied
// Returns: { satisfied: boolean, reason: string, shouldAdvance: boolean }
export const checkCurrentActionSatisfied = async (messages, notes) => {
  const currentAction = Progress.getCurrentAction();
  if (!currentAction || !currentAction.goal) {
    return { satisfied: false, reason: 'No current action', shouldAdvance: false };
  }
  
  const goal = currentAction.goal;
  const goalLower = goal.toLowerCase();
  
  // Try to match against patterns
  for (const [type, pattern] of Object.entries(GOAL_PATTERNS)) {
    const matchesGoal = pattern.goalPatterns?.some(p => p.test(goalLower));
    if (!matchesGoal) continue;
    
    // Check notes field first (most reliable)
    if (pattern.notesField && notes?.[pattern.notesField]) {
      console.log(`[GoalCheck] ✅ ${type}: Found in notes (${pattern.notesField})`);
      return { satisfied: true, reason: `Found in notes: ${pattern.notesField}`, shouldAdvance: true };
    }
    
    // Check if WE need to send a message
    if (pattern.requiresMyMessage) {
      const myMessages = messages.filter(m => m.isFromMe);
      
      // Check first message for greeting goals
      if (pattern.checkFirstMessage && messages.length > 0) {
        const firstMessage = messages[0];
        // If THEY messaged first and goal is to greet, we need to send a greeting
        if (!firstMessage.isFromMe) {
          // Check if we have a subsequent greeting message
          const myGreeting = myMessages.find(m => 
            pattern.myMessagePatterns?.some(p => p.test(m.text || ''))
          );
          if (myGreeting) {
            console.log(`[GoalCheck] ✅ ${type}: We sent a greeting after they initiated`);
            return { satisfied: true, reason: 'Sent greeting', shouldAdvance: true };
          }
          // We haven't greeted yet
          return { satisfied: false, reason: 'Need to greet (they messaged first)', shouldAdvance: false };
        }
      }
      
      // Check our messages for required patterns
      if (pattern.myMessagePatterns) {
        const matchingMessage = myMessages.find(m => 
          pattern.myMessagePatterns.some(p => p.test(m.text || ''))
        );
        if (matchingMessage) {
          console.log(`[GoalCheck] ✅ ${type}: Found matching message from us`);
          return { satisfied: true, reason: `Found our ${type} message`, shouldAdvance: true };
        }
      }
      
      // Check if our message must contain specific content
      if (pattern.myMessageMustContain) {
        const hasContent = myMessages.some(m => 
          (m.text || '').includes(pattern.myMessageMustContain)
        );
        if (hasContent) {
          console.log(`[GoalCheck] ✅ ${type}: Our message contains required content`);
          return { satisfied: true, reason: `Asked question`, shouldAdvance: true };
        }
      }
    }
    
    // Check if THEY need to respond
    if (pattern.requiresTheirResponse) {
      const theirMessages = messages.filter(m => !m.isFromMe);
      
      if (pattern.theirMessagePatterns) {
        const matchingMessage = theirMessages.find(m => 
          pattern.theirMessagePatterns.some(p => p.test(m.text || ''))
        );
        if (matchingMessage) {
          console.log(`[GoalCheck] ✅ ${type}: Found matching response from them`);
          return { satisfied: true, reason: `They provided ${type}`, shouldAdvance: true };
        }
      }
    }
  }
  
  // No local match found - goal not satisfied locally
  return { satisfied: false, reason: 'No local match', shouldAdvance: false };
};

// Advance to next action if current is satisfied (call before generating)
// Returns the action to generate for
// NOTE: Auto-skip DISABLED - was too aggressive and skipping too many actions
export const getActionForGeneration = async () => {
  await Progress.init();
  
  const currentAction = Progress.getCurrentAction();
  if (!currentAction) {
    console.log('[GoalCheck] All actions complete');
    return null; // All done
  }
  
  // AUTO-SKIP DISABLED - Just return the current action
  // The AI will work on this action, and it will be marked complete after sending
  // This prevents false positives where actions get skipped incorrectly
  console.log(`[GoalCheck] 🎯 Current action: "${currentAction.goal?.slice(0, 40)}..."`);
  return currentAction;
};

// ============================================================
// EXPORTED FUNCTIONS (Used by other modules)
// ============================================================

// Re-export ProgressManager functions for backwards compatibility
export const isActionCompleted = Progress.isComplete;
export const markActionCompleted = Progress.markComplete;
export const getCurrentIncompleteAction = Progress.getCurrentAction;
export const getSubscriberScriptStats = Progress.getStats;
export const loadSubscriberProgress = Progress.init;

// Check if current goal has been achieved (called after sending a message)
export const checkGoalCompletion = async (renderCallback) => {
  if (isCheckingGoal) return;
  
  const currentAction = Progress.getCurrentAction();
  if (!currentAction || !currentAction.goal) {
    console.log('[GoalCheck] No current action/goal to check');
    return;
  }
  
  const messages = Store.get('messages');
  if (!messages || messages.length < 2) {
    console.log('[GoalCheck] Not enough messages');
    return;
  }
  
  const recentMessages = messages.slice(-8);
  const hasMyMessage = recentMessages.some(m => m.isFromMe);
  if (!hasMyMessage) {
    console.log('[GoalCheck] No recent messages from me');
    return;
  }
  
  // Use the new smart check
  const notes = Store.get('currentNotes') || Store.get('storedChat')?.notes || {};
  const result = await checkCurrentActionSatisfied(messages, notes);
  
  if (result.satisfied) {
    console.log(`[GoalCheck] ✅ Goal completed: ${result.reason}`);
    await Progress.markComplete(currentAction.stageIdx, currentAction.actionIdx);
    if (renderCallback) renderCallback();
    showNotification(`✅ Goal achieved: "${currentAction.goal.slice(0, 30)}..."`);
    return;
  }
  
  // Goal not satisfied by local check - don't use AI, just wait
  console.log(`[GoalCheck] ⏳ Goal not yet satisfied: ${result.reason}`);
};

// Auto-switch tone when action changes
export const updateToneForCurrentAction = () => {
  const currentAction = Progress.getCurrentAction();
  if (!currentAction?.action?.tone) return;
  
  const currentTone = Store.get('tone');
  const newTone = currentAction.action.tone;
  
  if (newTone !== currentTone) {
    Store.set('tone', newTone);
    const toneSelect = $('toneSelect');
    if (toneSelect) toneSelect.value = newTone;
    chrome.storage.local.set({ defaultTone: newTone });
    console.log(`[Tone] Auto-switched to: ${newTone}`);
  }
};

// Auto-skip satisfied goals - NOW DISABLED ON CHAT LOAD
// Instead, use getActionForGeneration() before generating a message
export const autoSkipSatisfiedGoals = async (renderCallback) => {
  // DISABLED: No longer auto-skip on chat load
  // This was causing false positives where steps were marked complete incorrectly
  // The new approach: check ONLY the current action BEFORE generating a message
  console.log('[AutoSkip] ⚠️ DISABLED - Using pre-generation check instead');
  
  // Just load progress, don't auto-skip anything
  await Progress.init();
  
  if (renderCallback) renderCallback();
};

// AI Cross-Check: Analyze conversation to find completed goals
// CONSERVATIVE VERSION - With sanity limits to prevent false positives
const aiCrossCheckGoals = async (messages, renderCallback) => {
  // Get current script and all uncompleted goals
  const currentScript = Store.get('currentScript');
  if (!currentScript?.stages) return 0;
  
  // SANITY CHECK 1: Minimum message requirement
  // Need at least 6 messages (3 exchanges) before AI can reasonably determine progress
  if (messages.length < 6) {
    console.log(`[AI-CrossCheck] ⏭️ Skipping - only ${messages.length} messages (need 6+)`);
    return 0;
  }
  
  // Count subscriber messages specifically
  const subscriberMessages = messages.filter(m => !m.isFromMe);
  if (subscriberMessages.length < 2) {
    console.log(`[AI-CrossCheck] ⏭️ Skipping - only ${subscriberMessages.length} subscriber messages (need 2+)`);
    return 0;
  }
  
  // Collect all uncompleted goals with their positions
  const goalsToCheck = [];
  currentScript.stages.forEach((stage, stageIdx) => {
    stage.actions?.forEach((action, actionIdx) => {
      if (!Progress.isComplete(stageIdx, actionIdx) && action.goal) {
        goalsToCheck.push({
          stageIdx,
          actionIdx,
          goal: action.goal
        });
      }
    });
  });
  
  // SANITY CHECK 2: Max goals to skip at once
  // Never try to skip more than (messages/3) goals - that would be unrealistic
  const maxSkippable = Math.min(3, Math.floor(messages.length / 3));
  const goalsSubset = goalsToCheck.slice(0, Math.min(3, goalsToCheck.length)); // Max 3 goals at once
  
  if (goalsSubset.length === 0) {
    console.log('[AI-CrossCheck] No goals to check');
    return 0;
  }
  
  console.log(`[AI-CrossCheck] 🧠 Checking ${goalsSubset.length} goals with AI (max skippable: ${maxSkippable})...`);
  
  // Build a single AI prompt to check goals
  const recentMessages = messages.slice(-12); // Last 12 messages
  const conversationText = recentMessages.map(m => 
    `${m.isFromMe ? 'Me' : 'Sub'}: ${m.text}`
  ).join('\n');
  
  const goalsText = goalsSubset.map((g, i) => `${i + 1}. ${g.goal}`).join('\n');
  
  try {
    // Use existing check-goal endpoint with stricter prompt
    const response = await API.checkGoal({
      goal: `Analyze ONLY the following goals against the conversation.
A goal is COMPLETE only if there is CLEAR evidence in the conversation that it was achieved.
Be CONSERVATIVE - if unsure, mark as NOT complete.

GOALS TO CHECK:
${goalsText}

CONVERSATION:
${conversationText}

Return ONLY a JSON array with the numbers of goals that are DEFINITELY complete.
Example: [1] or [2, 3] or []
If NO goals are clearly complete, return: []
DO NOT include a goal number unless you are 90%+ confident it was achieved.`,
      recentMessages: recentMessages
    });
    
    if (response.success) {
      // Parse the response - STRICT JSON parsing only
      let completedIndices = [];
      
      // Try to find JSON array in response
      const jsonMatch = response.reason?.match(/\[[\d,\s]*\]/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          // Validate it's an array of numbers
          if (Array.isArray(parsed) && parsed.every(n => typeof n === 'number')) {
            completedIndices = parsed;
          }
        } catch (e) {
          console.log('[AI-CrossCheck] ⚠️ Could not parse JSON - NOT using fallback (too risky)');
          // DO NOT use fallback regex - it causes false positives
          return 0;
        }
      }
      
      // SANITY CHECK 3: Never skip more than maxSkippable
      if (completedIndices.length > maxSkippable) {
        console.log(`[AI-CrossCheck] ⚠️ AI tried to skip ${completedIndices.length} goals but max is ${maxSkippable} - limiting`);
        completedIndices = completedIndices.slice(0, maxSkippable);
      }
      
      // SANITY CHECK 4: Validate indices are in range
      completedIndices = completedIndices.filter(n => n >= 1 && n <= goalsSubset.length);
      
      // Mark completed goals
      let skipped = 0;
      for (const idx of completedIndices) {
        const goalInfo = goalsSubset[idx - 1]; // 1-indexed to 0-indexed
        if (goalInfo) {
          console.log(`[AI-CrossCheck] ✅ AI confirmed complete: "${goalInfo.goal.slice(0, 40)}..."`);
          await Progress.markComplete(goalInfo.stageIdx, goalInfo.actionIdx);
          skipped++;
        }
      }
      
      if (skipped > 0) {
        showNotification(`🧠 AI detected ${skipped} already-completed goal${skipped > 1 ? 's' : ''}`);
      }
      
      return skipped;
    }
  } catch (error) {
    console.error('[AI-CrossCheck] Error:', error);
  }
  
  return 0;
};

// Validation on load (simplified)
export const validateAndSyncProgress = autoSkipSatisfiedGoals;

// Smart detect completed checkpoints (now uses AI)
export const smartDetectCompletedCheckpoints = aiCrossCheckGoals;
export const checkCurrentActionPreSatisfied = async () => false;
export const getSubscriberProgress = Progress.getCompleted;
