// AI Context - Context building for AI generation, summary updates
import Store from '../../state/store.js';
import API from '../../utils/api.js';
import { isActionCompleted, getActionForGeneration } from '../scripts/index.js';

// ============================================================
// CONTEXT BUILDERS
// ============================================================

// Get current incomplete action from script - uses per-subscriber progress
export const getCurrentAction = async () => {
  const currentScript = Store.get('currentScript');
  console.log('[AI Debug] currentScript:', currentScript?.name, 'stages:', currentScript?.stages?.length);

  if (!currentScript?.stages) {
    console.log('[AI Debug] No currentScript or stages - returning null');
    return null;
  }

  // Use the NEW smart pre-generation check
  // This checks if current action is satisfied and auto-advances if needed
  const incomplete = await getActionForGeneration();
  console.log('[AI Debug] getActionForGeneration result:', incomplete);

  if (!incomplete) {
    console.log('[AI Debug] No incomplete action found - all completed or error');
    return null;
  }

  // Use stageIdx/actionIdx (new names from ProgressManager)
  const stageIdx = incomplete.stageIdx ?? incomplete.stageIndex ?? 0;
  const actionIdx = incomplete.actionIdx ?? incomplete.actionIndex ?? 0;

  // Enrich with script context
  const stage = currentScript.stages[stageIdx];
  const result = {
    ...incomplete.action,
    stageIndex: stageIdx,
    actionIndex: actionIdx,
    stageName: stage?.name || incomplete.stageName || '',
    totalStages: currentScript.stages.length,
    scriptName: currentScript.name,
    goal: incomplete.goal
  };

  console.log('[AI Debug] Current action goal:', result.goal);
  return result;
};

// Get completed actions context - uses per-subscriber progress
export const getCompletedActionsContext = () => {
  const currentScript = Store.get('currentScript');
  if (!currentScript?.stages) return '';

  const completed = [];

  currentScript.stages.forEach((stage, stageIdx) => {
    const actions = stage.actions || stage.messages || [];
    actions.forEach((action, actionIdx) => {
      // Check per-subscriber progress instead of action.completed
      if (isActionCompleted(stageIdx, actionIdx)) {
        completed.push(action.goal || action.text || '');
      }
    });
  });

  if (completed.length === 0) return '';
  return completed.slice(-5).join(', '); // Last 5 completed goals
};

// Get subscriber notes context
export const getNotesContext = () => {
  // Try currentNotes first (from database), then storedChat.notes as fallback
  const notes = Store.get('currentNotes') || Store.get('storedChat')?.notes || {};

  const parts = [];
  if (notes.name) parts.push(`Name: ${notes.name}`);
  if (notes.age) parts.push(`Age: ${notes.age}`);
  if (notes.location) parts.push(`Location: ${notes.location}`);
  if (notes.job) parts.push(`Job: ${notes.job}`);
  if (notes.hobbies) parts.push(`Likes: ${notes.hobbies}`);
  if (notes.kinks) parts.push(`Kinks: ${notes.kinks}`);
  if (notes.other) parts.push(`Notes: ${notes.other}`);

  return parts.join(', ');
};

// Get profile context (YOUR persona info - ALL settings sent to AI)
export const getProfileContext = () => {
  const profile = Store.get('currentProfile');
  if (!profile) return null;

  // Build a complete profile info object with ALL available data
  const profileInfo = {};

  // Identity
  if (profile.name) profileInfo.name = profile.name;
  if (profile.modelName) profileInfo.modelName = profile.modelName;
  if (profile.age) profileInfo.age = profile.age;

  // Location
  if (profile.country) profileInfo.country = profile.country;
  if (profile.city) profileInfo.city = profile.city;
  if (profile.matchSubscriberLocation) profileInfo.matchSubscriberLocation = profile.matchSubscriberLocation;
  if (profile.timezone) profileInfo.timezone = profile.timezone;

  // Appearance
  if (profile.bodyType) profileInfo.bodyType = profile.bodyType;
  if (profile.appearance?.hair) profileInfo.hairColor = profile.appearance.hair;
  if (profile.appearance?.eyes) profileInfo.eyeColor = profile.appearance.eyes;
  if (profile.relationshipStatus) profileInfo.relationshipStatus = profile.relationshipStatus;

  // Personality & Style
  if (profile.personality) profileInfo.personality = profile.personality;
  if (profile.defaultTone) profileInfo.tone = profile.defaultTone;
  if (profile.styleRules) profileInfo.style = profile.styleRules;

  // Kinks & Boundaries — critical for AI to know what's allowed
  if (profile.kinks?.length) profileInfo.kinks = profile.kinks;
  if (profile.boundaries?.length) profileInfo.boundaries = profile.boundaries;

  // Schedule — helps AI answer "when are you free?" naturally
  if (profile.schedule?.wakeUpTime) profileInfo.wakeUpTime = profile.schedule.wakeUpTime;
  if (profile.schedule?.sleepTime) profileInfo.sleepTime = profile.schedule.sleepTime;

  // CRITICAL: Include language setting for forced language response
  if (profile.language) {
    profileInfo.language = profile.language;
  }

  // Check if there's any actual data
  if (Object.keys(profileInfo).length === 0) return null;

  console.log('[AI] getProfileContext:', Object.keys(profileInfo).join(', '));
  return profileInfo;
};

// Update conversation summary
export const updateSummary = async () => {
  const messages = Store.get('messages');
  const lastSummaryCount = Store.get('lastSummaryCount');
  const summary = Store.get('summary');

  const needsUpdate = messages.length >= 5 &&
    (messages.length - lastSummaryCount >= 10 || !summary);

  if (!needsUpdate) return;

  try {
    const response = await API.summarize({ messages });

    if (response.success && response.summary) {
      Store.set('summary', response.summary);
      Store.set('lastSummaryCount', messages.length);
    }
  } catch (error) {
    console.error('Summary generation failed:', error);
  }
};
