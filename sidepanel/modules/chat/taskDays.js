// ============================================================
// TASK DAYS MODULE - Per-subscriber task deadline tracking
// Stored in subscriber notes, synced across all users per profile
// ============================================================

import Store from '../../state/store.js';
import { $ } from '../../utils/dom.js';
import { saveNotesToDB } from '../notes.js';
import { showNotification } from '../../utils/notify.js';

// Auto-update interval (every 30s for minute-accurate display)
let countdownInterval = null;

// ============================================================
// CORE: Calculate remaining time from deadline
// ============================================================

const getTimeRemaining = (deadline) => {
  if (!deadline) return null;
  const now = Date.now();
  const end = new Date(deadline).getTime();
  const diff = end - now;
  
  if (diff <= 0) return { expired: true, total: 0, days: 0, hours: 0, minutes: 0 };
  
  return {
    expired: false,
    total: diff,
    days: Math.floor(diff / (1000 * 60 * 60 * 24)),
    hours: Math.floor((diff / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((diff / (1000 * 60)) % 60)
  };
};

// ============================================================
// CORE: Get color tier based on remaining time
// ============================================================

const getTimeTier = (remaining) => {
  if (!remaining || remaining.expired) return { cls: 'task-expired', label: 'Expired' };
  const hours = remaining.days * 24 + remaining.hours;
  if (hours > 72) return { cls: 'task-plenty', label: 'plenty' };       // >3 days = green
  if (hours > 24) return { cls: 'task-moderate', label: 'moderate' };    // 1-3 days = yellow
  if (hours > 6)  return { cls: 'task-urgent', label: 'urgent' };       // 6-24h = orange
  return { cls: 'task-critical', label: 'critical' };                     // <6h = red
};

// ============================================================
// CORE: Format remaining time as readable string
// ============================================================

const formatRemaining = (remaining) => {
  if (!remaining || remaining.expired) return 'Expired';
  
  // More than 24h: show days only (compact)
  if (remaining.days > 0) return `${remaining.days}d`;
  
  // Last day (<24h): show HH:MM
  const hh = String(remaining.hours).padStart(2, '0');
  const mm = String(remaining.minutes).padStart(2, '0');
  return `${hh}:${mm}`;
};

// ============================================================
// UI: Render task days display
// ============================================================

export const renderTaskDays = (notes) => {
  const container = $('taskDaysContainer');
  if (!container) return;
  
  const deadline = notes?.taskDeadline;
  
  if (!deadline) {
    // No task set — show compact "+" button
    container.innerHTML = `
      <button id="addTaskDaysBtn" class="task-add-btn" title="Add task deadline">
        <span class="task-add-icon">⏰</span>
        <span class="task-add-label">+Task</span>
      </button>`;
    container.className = 'task-days-container';
    
    // Bind click
    $('addTaskDaysBtn')?.addEventListener('click', showTaskDaysInput);
    return;
  }
  
  // Task exists — show countdown
  const remaining = getTimeRemaining(deadline);
  const tier = getTimeTier(remaining);
  const text = formatRemaining(remaining);
  
  container.innerHTML = `
    <div class="task-badge ${tier.cls}" title="Task deadline: ${new Date(deadline).toLocaleString()}">
      <span class="task-badge-icon">⏰</span>
      <span class="task-badge-time">${text}</span>
      <button class="task-badge-remove" title="Remove task deadline">✕</button>
    </div>`;
  container.className = 'task-days-container has-task';
  
  // Bind remove
  container.querySelector('.task-badge-remove')?.addEventListener('click', (e) => {
    e.stopPropagation();
    removeTaskDeadline();
  });
  
  // Bind click on badge to allow editing (add more days)
  container.querySelector('.task-badge')?.addEventListener('click', showTaskDaysInput);
};

// ============================================================
// UI: Show inline input to add days
// ============================================================

const showTaskDaysInput = () => {
  const container = $('taskDaysContainer');
  if (!container) return;
  
  const notes = Store.get('currentNotes') || {};
  const hasExisting = !!notes.taskDeadline;
  
  container.innerHTML = `
    <div class="task-input-row">
      <input type="number" id="taskDaysInput" class="task-days-input" 
             placeholder="Days" min="1" max="365" value="3" autofocus>
      <button id="taskDaysSaveBtn" class="task-save-btn" title="Save">✓</button>
      <button id="taskDaysCancelBtn" class="task-cancel-btn" title="Cancel">✕</button>
    </div>`;
  container.className = 'task-days-container editing';
  
  const input = $('taskDaysInput');
  input?.focus();
  input?.select();
  
  // Save on Enter
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addTaskDays();
    if (e.key === 'Escape') renderTaskDays(notes);
  });
  
  $('taskDaysSaveBtn')?.addEventListener('click', addTaskDays);
  $('taskDaysCancelBtn')?.addEventListener('click', () => renderTaskDays(notes));
};

// ============================================================
// ACTION: Add task days and save to DB
// ============================================================

const addTaskDays = async () => {
  const input = $('taskDaysInput');
  const days = parseInt(input?.value, 10);
  
  if (!days || days < 1 || days > 365) {
    showNotification('Enter 1-365 days');
    return;
  }
  
  // Calculate deadline: now + days * 24 hours (exact to the minute)
  const deadline = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  
  // Update notes
  const notes = Store.get('currentNotes') || {};
  notes.taskDeadline = deadline;
  notes.taskDaysAdded = days;
  notes.taskAddedAt = new Date().toISOString();
  Store.set('currentNotes', notes);
  
  // Render immediately
  renderTaskDays(notes);
  
  // Persist to database
  const currentProfile = Store.get('currentProfile');
  const currentSubscriberId = Store.get('currentSubscriberId');
  if (currentProfile && currentSubscriberId) {
    await saveNotesToDB(notes);
    console.log(`[TaskDays] ✅ Saved ${days}-day deadline for ${currentSubscriberId}: ${deadline}`);
  }
  
  showNotification(`⏰ Task set: ${days} day${days > 1 ? 's' : ''} from now`);
};

// ============================================================
// ACTION: Remove task deadline
// ============================================================

const removeTaskDeadline = async () => {
  const notes = Store.get('currentNotes') || {};
  delete notes.taskDeadline;
  delete notes.taskDaysAdded;
  delete notes.taskAddedAt;
  Store.set('currentNotes', notes);
  
  // Render immediately
  renderTaskDays(notes);
  
  // Persist to database
  const currentProfile = Store.get('currentProfile');
  const currentSubscriberId = Store.get('currentSubscriberId');
  if (currentProfile && currentSubscriberId) {
    await saveNotesToDB(notes);
    console.log(`[TaskDays] 🗑️ Removed task deadline for ${currentSubscriberId}`);
  }
  
  showNotification('Task deadline removed');
};

// ============================================================
// AUTO-UPDATE: Refresh countdown every 30 seconds
// ============================================================

export const startTaskDaysCountdown = () => {
  if (countdownInterval) return;
  
  countdownInterval = setInterval(() => {
    const notes = Store.get('currentNotes');
    if (notes?.taskDeadline) {
      renderTaskDays(notes);
    }
  }, 30000); // 30 seconds
  
  console.log('[TaskDays] Countdown auto-update started');
};

export const stopTaskDaysCountdown = () => {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
};
