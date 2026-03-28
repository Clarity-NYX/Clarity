// ============================================================
// MASS MESSAGE MODULE — Multi-step personalized messaging wizard
// ============================================================

import { $, escapeHtml } from '../utils/dom.js';
import { showNotification } from '../utils/notify.js';
import Store from '../state/store.js';
import API from '../utils/api.js';
import { getImages } from './imagePool.js';
import { getGroups, getGroupMap } from './subscriberGroups.js';

// ============================================================
// CONSTANTS
// ============================================================

const STORAGE_KEY_TEMPLATES = 'clarity_broadcast_templates';
const STORAGE_KEY_HISTORY = 'clarity_broadcast_history';

const SPENDING_TIERS = [
  { id: 'free',    label: 'Free',      min: 0,       max: 0,        color: '#6b7280', icon: '⚪' },
  { id: 'starter', label: 'Starter',   min: 0.01,    max: 50,       color: '#4ade80', icon: '🟢' },
  { id: 'fan',     label: 'Fan',       min: 50.01,   max: 200,      color: '#2dd4bf', icon: '🩵' },
  { id: 'loyal',   label: 'Loyal',     min: 200.01,  max: 500,      color: '#38bdf8', icon: '🔵' },
  { id: 'vip',     label: 'VIP',       min: 500.01,  max: 1000,     color: '#818cf8', icon: '🟣' },
  { id: 'elite',   label: 'Elite',     min: 1000.01, max: 3000,     color: '#a855f7', icon: '💎' },
  { id: 'whale',   label: 'Whale',     min: 3000.01, max: Infinity, color: '#ec4899', icon: '🐋' }
];

const DEFAULT_TEMPLATES = [
  { id: 'gm',       name: '☀️ Good Morning',   prompt: 'Send a warm personalized good morning message. If you know their name or interests, mention them naturally. Keep it short and sweet.' },
  { id: 'gn',       name: '🌙 Good Night',     prompt: 'Send a flirty good night message. Make them feel special before bed.' },
  { id: 'missyou',  name: '💕 Miss You',        prompt: 'Send a "thinking of you" / "miss you" message. Make it personal and genuine.' },
  { id: 'newpost',  name: '📸 New Post',        prompt: 'Let them know you just posted new content. Build excitement and curiosity.' },
  { id: 'offer',    name: '🎁 Special Offer',   prompt: 'Offer them a special deal or discount. Make it feel exclusive and personal.' },
  { id: 'checkin',  name: '💬 Check In',        prompt: 'Casual check-in message. Ask how they are doing, reference something personal if known.' }
];

// Wizard steps
const STEPS = ['recipients', 'compose', 'confirm', 'sending', 'done'];

// ============================================================
// STATE
// ============================================================

let state = {
  currentStep: 0,        // index into STEPS
  direction: 1,          // 1 = forward, -1 = back (for animation)
  
  // Step 1: Recipients
  selectedTiers: new Set(),       // tier filter (narrows visible list)
  selectedGroups: new Set(),      // group filter (narrows visible list)
  selectedSubscribers: new Set(), // manually picked subscriber IDs
  minSpend: 0,
  maxSpend: Infinity,
  skipRecentHours: 0,
  
  // Step 2: Compose
  prompt: '',
  attachedMedia: null,
  
  // Step 3: Confirm
  delaySeconds: 45,
  
  // Data
  allSubscribers: [],
  filteredRecipients: [],   // subscribers visible after tier filter
  
  // Execution
  currentIndex: 0,
  results: [],
  isPaused: false,
  isStopped: false,
  previewMessage: '',
  previewSub: null,
  
  // Pre-generated messages (subscriberId → editable text)
  generatedMessages: new Map(),
  isGenerating: false,
  generateProgress: 0
};

let templates = [];
let history = [];

// ============================================================
// INITIALIZATION
// ============================================================

export function initBroadcast() {
  loadTemplates();
  loadHistory();
}

function loadTemplates() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_TEMPLATES);
    templates = stored ? JSON.parse(stored) : [...DEFAULT_TEMPLATES];
  } catch (_) { templates = [...DEFAULT_TEMPLATES]; }
}

function saveTemplates() {
  try { localStorage.setItem(STORAGE_KEY_TEMPLATES, JSON.stringify(templates)); } catch (_) {}
}

function loadHistory() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_HISTORY);
    history = stored ? JSON.parse(stored) : [];
  } catch (_) { history = []; }
}

function saveHistory() {
  try {
    if (history.length > 50) history = history.slice(-50);
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(history));
  } catch (_) {}
}

// ============================================================
// DATA
// ============================================================

const parseSpent = (s) => {
  if (!s) return 0;
  const n = parseFloat(s.toString().replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : n;
};

const getTier = (amount) => {
  for (const t of SPENDING_TIERS) {
    if (amount >= t.min && amount <= t.max) return t;
  }
  return SPENDING_TIERS[0];
};

/**
 * Read names from the already-rendered chat list DOM in the sidepanel.
 * The chat list view scrapes real names from OnlyFans and renders them.
 * Returns Map<rawId, { name, handle }>
 */
function readNamesFromChatListDOM() {
  const nameMap = new Map();
  const items = document.querySelectorAll('.chat-list-item');
  items.forEach(item => {
    const rawId = item.dataset?.rawId;
    if (!rawId) return;
    const nameEl = item.querySelector('.chat-list-name');
    const handleEl = item.querySelector('.chat-list-handle');
    const name = nameEl?.textContent?.trim();
    const handle = handleEl?.textContent?.trim() || '';
    if (name && name !== 'Unknown') {
      nameMap.set(rawId, { name, handle });
    }
  });
  return nameMap;
}

async function loadSubscribers() {
  const profile = Store.get('currentProfile');
  if (!profile?.id) return [];
  try {
    // 1) Read real names from the already-rendered chat list in our sidepanel
    const domNames = readNamesFromChatListDOM();
    
    // 2) Also try scraping from OnlyFans tab (backup if chat list isn't rendered)
    let scrapedNames = new Map();
    try {
      const tabs = await chrome.tabs.query({ url: '*://onlyfans.com/*' });
      if (tabs.length > 0) {
        const scraped = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_CHAT_LIST' }, (res) => {
            if (chrome.runtime.lastError) { resolve({ success: false }); return; }
            resolve(res || { success: false });
          });
        });
        if (scraped.success && scraped.chats) {
          scraped.chats.forEach(c => {
            const rid = (c.rawId || c.id || '').replace(/^of:/, '');
            if (rid && c.subscriberName && c.subscriberName !== 'Unknown') {
              scrapedNames.set(rid, { name: c.subscriberName, handle: c.handle || '' });
            }
          });
        }
      }
    } catch (_) {}
    
    // 3) Load Firestore data (spending, notes, messages)
    const firestoreResult = await API.getChats(profile.id);
    const firestoreChats = (firestoreResult.success && firestoreResult.chats) ? firestoreResult.chats : [];
    
    return firestoreChats.map(chat => {
      const rawId = (chat.id || '').replace(/^of:/, '');
      const amount = parseSpent(chat.notes?.totalSpent);
      const tier = getTier(amount);
      const lastMessageAt = chat.lastMessageAt || chat.updatedAt || 0;
      
      // Name priority: sidepanel DOM > scraped from OF tab > notes.name > Firestore subscriberName > rawId
      const domEntry = domNames.get(rawId);
      const scrapedEntry = scrapedNames.get(rawId);
      const displayName = domEntry?.name
        || scrapedEntry?.name
        || chat.notes?.name
        || (chat.subscriberName && chat.subscriberName !== 'Unknown' ? chat.subscriberName : null)
        || rawId;
      
      return {
        id: chat.id, rawId,
        name: displayName,
        handle: domEntry?.handle || scrapedEntry?.handle || (displayName !== rawId ? rawId : ''),
        totalSpent: chat.notes?.totalSpent || '$0',
        spentAmount: amount, tier,
        notes: chat.notes || {},
        messages: chat.messages || [],
        lastMessageAt: typeof lastMessageAt === 'string' ? new Date(lastMessageAt).getTime() : lastMessageAt
      };
    }).sort((a, b) => b.spentAmount - a.spentAmount);
  } catch (e) {
    console.error('[MassMsg] Error loading subscribers:', e);
    return [];
  }
}

function applyFilters() {
  const { selectedTiers, selectedGroups, minSpend, maxSpend, skipRecentHours } = state;
  const now = Date.now();
  const skipMs = skipRecentHours * 60 * 60 * 1000;
  const gMap = selectedGroups.size > 0 ? getGroupMap() : null;
  
  state.filteredRecipients = state.allSubscribers.filter(sub => {
    if (selectedTiers.size > 0 && !selectedTiers.has(sub.tier.id)) return false;
    // Group filter: subscriber must be in one of the selected groups
    if (gMap) {
      const subGroupId = gMap[sub.id] || gMap[sub.rawId] || null;
      if (!subGroupId || !selectedGroups.has(subGroupId)) return false;
    }
    if (sub.spentAmount < minSpend) return false;
    if (maxSpend < Infinity && sub.spentAmount > maxSpend) return false;
    if (skipRecentHours > 0 && sub.lastMessageAt && (now - sub.lastMessageAt) < skipMs) return false;
    return true;
  });
}

// ============================================================
// MODAL OPEN / CLOSE
// ============================================================

export function openBroadcastModal() {
  const modal = $('broadcastModal');
  if (!modal) return;
  
  // Reset
  state.currentStep = 0;
  state.direction = 1;
  state.currentIndex = 0;
  state.results = [];
  state.isPaused = false;
  state.isStopped = false;
  state.previewMessage = '';
  state.previewSub = null;
  state.selectedSubscribers = new Set();
  state.selectedGroups = new Set();
  state.selectedTiers = new Set();
  state.generatedMessages = new Map();
  state.isGenerating = false;
  state.generateProgress = 0;
  
  modal.classList.add('active');
  renderCurrentStep();
  loadSubscribersAsync();
}

export function closeBroadcastModal() {
  const modal = $('broadcastModal');
  if (modal) modal.classList.remove('active');
  if (state.currentStep === 3) state.isStopped = true; // Stop if running
}

async function loadSubscribersAsync() {
  const body = $('broadcastBody');
  if (!body) return;
  
  // Show loading overlay on first step
  const loader = body.querySelector('.mm-step-loading');
  if (loader) loader.classList.remove('hidden');
  
  state.allSubscribers = await loadSubscribers();
  applyFilters();
  
  if (loader) loader.classList.add('hidden');
  
  // Re-render to update counts
  if (state.currentStep === 0) renderCurrentStep();
}

// ============================================================
// STEP NAVIGATION
// ============================================================

function goToStep(stepIndex) {
  if (stepIndex < 0 || stepIndex >= STEPS.length) return;
  state.direction = stepIndex > state.currentStep ? 1 : -1;
  state.currentStep = stepIndex;
  renderCurrentStep();
}

function nextStep() {
  goToStep(state.currentStep + 1);
}

function prevStep() {
  goToStep(state.currentStep - 1);
}

// ============================================================
// RENDERING
// ============================================================

function renderCurrentStep() {
  const body = $('broadcastBody');
  if (!body) return;
  
  const stepName = STEPS[state.currentStep];
  const dir = state.direction > 0 ? 'right' : 'left';
  
  // Animate out old content, then render new
  body.classList.add('mm-animating');
  body.style.setProperty('--mm-dir', dir === 'right' ? '1' : '-1');
  
  // Small delay for exit animation
  requestAnimationFrame(() => {
    body.innerHTML = '';
    
    // Step indicator (not shown during sending/done)
    if (state.currentStep < 3) {
      body.appendChild(createStepIndicator());
    }
    
    const content = document.createElement('div');
    content.className = 'mm-step-content mm-enter';
    
    switch (stepName) {
      case 'recipients': renderRecipientsStep(content); break;
      case 'compose':    renderComposeStep(content); break;
      case 'confirm':    renderConfirmStep(content); break;
      case 'sending':    renderSendingStep(content); break;
      case 'done':       renderDoneStep(content); break;
    }
    
    body.appendChild(content);
    
    // Trigger enter animation
    requestAnimationFrame(() => {
      content.classList.remove('mm-enter');
      content.classList.add('mm-entered');
      body.classList.remove('mm-animating');
    });
  });
}

function createStepIndicator() {
  const steps = ['Recipients', 'Compose', 'Review'];
  const el = document.createElement('div');
  el.className = 'mm-steps';
  el.innerHTML = steps.map((label, i) => `
    <div class="mm-step-dot ${i === state.currentStep ? 'active' : ''} ${i < state.currentStep ? 'done' : ''}">
      <div class="mm-dot">${i < state.currentStep ? '✓' : i + 1}</div>
      <span class="mm-step-label">${label}</span>
    </div>
    ${i < steps.length - 1 ? '<div class="mm-step-line ' + (i < state.currentStep ? 'done' : '') + '"></div>' : ''}
  `).join('');
  return el;
}

// ============================================================
// HELPERS — selected recipients
// ============================================================

/** Get the actual list of subscribers that the user manually picked */
function getSelectedRecipients() {
  return state.filteredRecipients.filter(s => state.selectedSubscribers.has(s.id));
}

// ============================================================
// STEP 1: RECIPIENTS
// ============================================================

function renderRecipientsStep(container) {
  const pickedCount = getSelectedRecipients().length;
  const visibleCount = state.filteredRecipients.length;
  const allVisibleSelected = visibleCount > 0 && state.filteredRecipients.every(s => state.selectedSubscribers.has(s.id));
  
  container.innerHTML = `
    <h4 class="mm-title">Who do you want to message?</h4>
    <p class="mm-subtitle">Filter by tier, then pick subscribers</p>
    
    <div class="mm-tier-grid">
      ${SPENDING_TIERS.map(t => `
        <label class="mm-tier ${state.selectedTiers.has(t.id) ? 'selected' : ''}" data-tier="${t.id}" style="--tc: ${t.color}">
          <span class="mm-tier-check">${state.selectedTiers.has(t.id) ? '✓' : ''}</span>
          <span class="mm-tier-icon">${t.icon}</span>
          <div class="mm-tier-info">
            <span class="mm-tier-name">${t.label}</span>
            <span class="mm-tier-range">${t.max === 0 ? '$0' : t.max === Infinity ? '$' + t.min.toLocaleString() + '+' : '$' + t.min.toLocaleString() + '–$' + t.max.toLocaleString()}</span>
          </div>
        </label>
      `).join('')}
    </div>
    
    ${(() => {
      const allGroups = getGroups();
      if (allGroups.length === 0) return '';
      return `
        <div class="mm-group-section" id="mmGroupFilter">
          <div class="mm-group-title">👥 Groups</div>
          <div class="mm-group-grid">
            ${allGroups.map(g => `
              <button class="mm-group-pill ${state.selectedGroups.has(g.id) ? 'selected' : ''}" data-gid="${g.id}" style="--sg-color: ${g.color}">
                <span class="mm-group-pill-icon">${g.icon}</span>
                <span class="mm-group-pill-name">${escapeHtml(g.name)}</span>
              </button>
            `).join('')}
          </div>
        </div>
      `;
    })()}
    
    <div class="mm-filter-extras">
      <div class="mm-filter-row">
        <label class="mm-check-label">
          <input type="checkbox" id="mmSkipRecent" ${state.skipRecentHours > 0 ? 'checked' : ''}>
          <span>Skip messaged in last</span>
        </label>
        <input type="number" id="mmSkipHours" class="mm-input-mini" value="${state.skipRecentHours || 24}" min="1" max="168">
        <span class="mm-filter-unit">hrs</span>
      </div>
    </div>
    
    <div class="mm-list-header">
      <div class="mm-list-count">
        <div class="mm-count-badge">${pickedCount}</div>
        <span class="mm-count-label">selected of ${visibleCount}</span>
      </div>
      <button class="mm-select-all-btn" id="mmSelectAll">
        ${allVisibleSelected ? 'Deselect All' : 'Select All'}
      </button>
    </div>
    
    <div class="mm-sub-list" id="mmSubList">
      ${state.filteredRecipients.length > 0 ? state.filteredRecipients.map(s => `
        <div class="mm-sub-item ${state.selectedSubscribers.has(s.id) ? 'selected' : ''}" data-sid="${escapeHtml(s.id)}" style="--tc: ${s.tier.color}">
          <div class="mm-sub-check">${state.selectedSubscribers.has(s.id) ? '✓' : ''}</div>
          <span class="mm-sub-icon">${s.tier.icon}</span>
          <div class="mm-sub-info">
            <span class="mm-sub-name">${escapeHtml(s.name)}</span>
            <span class="mm-sub-handle">${escapeHtml(s.handle || s.rawId)}</span>
          </div>
          <span class="mm-sub-spent" style="color: ${s.tier.color}">${escapeHtml(s.totalSpent)}</span>
        </div>
      `).join('') : `
        <div class="mm-sub-empty">No subscribers match filters</div>
      `}
    </div>
    
    <div class="mm-step-loading hidden">
      <div class="spinner"></div>
      <p>Loading subscribers...</p>
    </div>
    
    <div class="mm-nav">
      <div></div>
      <button class="mm-btn mm-btn-primary" id="mmNext1" ${pickedCount === 0 ? 'disabled' : ''}>
        Next (${pickedCount}) <span class="mm-btn-arrow">→</span>
      </button>
    </div>
  `;
  
  // Tier clicks (filter only — doesn't auto-select)
  container.querySelectorAll('.mm-tier').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.tier;
      if (state.selectedTiers.has(id)) state.selectedTiers.delete(id);
      else state.selectedTiers.add(id);
      applyFilters();
      renderCurrentStep();
    });
  });
  
  // Group pill clicks (filter only)
  container.querySelectorAll('.mm-group-pill').forEach(el => {
    el.addEventListener('click', () => {
      const gid = el.dataset.gid;
      if (state.selectedGroups.has(gid)) state.selectedGroups.delete(gid);
      else state.selectedGroups.add(gid);
      applyFilters();
      renderCurrentStep();
    });
  });
  
  // Skip recent
  container.querySelector('#mmSkipRecent')?.addEventListener('change', e => {
    state.skipRecentHours = e.target.checked ? (parseInt(container.querySelector('#mmSkipHours')?.value) || 24) : 0;
    applyFilters();
    renderCurrentStep();
  });
  container.querySelector('#mmSkipHours')?.addEventListener('change', e => {
    if (container.querySelector('#mmSkipRecent')?.checked) {
      state.skipRecentHours = parseInt(e.target.value) || 24;
      applyFilters();
      renderCurrentStep();
    }
  });
  
  // Select All / Deselect All
  container.querySelector('#mmSelectAll')?.addEventListener('click', () => {
    if (allVisibleSelected) {
      // Deselect all visible
      state.filteredRecipients.forEach(s => state.selectedSubscribers.delete(s.id));
    } else {
      // Select all visible
      state.filteredRecipients.forEach(s => state.selectedSubscribers.add(s.id));
    }
    renderCurrentStep();
  });
  
  // Individual subscriber click → toggle selection
  container.querySelectorAll('.mm-sub-item').forEach(el => {
    el.addEventListener('click', () => {
      const sid = el.dataset.sid;
      if (state.selectedSubscribers.has(sid)) {
        state.selectedSubscribers.delete(sid);
      } else {
        state.selectedSubscribers.add(sid);
      }
      renderCurrentStep();
    });
  });
  
  // Next
  container.querySelector('#mmNext1')?.addEventListener('click', nextStep);
}

// ============================================================
// STEP 2: COMPOSE
// ============================================================

function renderComposeStep(container) {
  container.innerHTML = `
    <h4 class="mm-title">Compose your message</h4>
    <p class="mm-subtitle">Pick a template or write your own prompt</p>
    
    <div class="mm-templates">
      ${templates.map(t => `
        <button class="mm-tpl-pill" data-tid="${t.id}" title="${escapeHtml(t.prompt)}">${t.name}</button>
      `).join('')}
      <button class="mm-tpl-pill mm-tpl-save" id="mmSaveTemplate" title="Save current as template">+ Save</button>
    </div>
    
    <textarea id="mmPrompt" class="mm-prompt" placeholder="Describe what to say...&#10;&#10;e.g., Send a personalized good morning message. Mention their interests if known.">${escapeHtml(state.prompt)}</textarea>
    
    <div class="mm-media-attach">
      <button class="mm-attach-btn" id="mmAttachMedia">
        ${state.attachedMedia ? `📎 ${escapeHtml(state.attachedMedia.name)}` : '📎 Attach media'}
      </button>
      ${state.attachedMedia ? `<button class="mm-attach-remove" id="mmRemoveMedia">✕</button>` : ''}
    </div>
    
    <div class="mm-nav">
      <button class="mm-btn mm-btn-ghost" id="mmBack2">
        <span class="mm-btn-arrow">←</span> Back
      </button>
      <button class="mm-btn mm-btn-primary" id="mmNext2" ${!state.prompt.trim() ? 'disabled' : ''}>
        Next <span class="mm-btn-arrow">→</span>
      </button>
    </div>
  `;
  
  // Templates
  container.querySelectorAll('.mm-tpl-pill[data-tid]').forEach(pill => {
    pill.addEventListener('click', () => {
      const t = templates.find(x => x.id === pill.dataset.tid);
      if (t) {
        state.prompt = t.prompt;
        container.querySelector('#mmPrompt').value = t.prompt;
        container.querySelector('#mmNext2').disabled = false;
      }
    });
  });
  
  // Save template
  container.querySelector('#mmSaveTemplate')?.addEventListener('click', () => {
    const prompt = state.prompt.trim();
    if (!prompt) { showNotification('Write a prompt first'); return; }
    const name = window.prompt('Template name:');
    if (!name?.trim()) return;
    templates.push({ id: `c_${Date.now()}`, name: name.trim(), prompt });
    saveTemplates();
    renderCurrentStep();
    showNotification(`Template "${name.trim()}" saved!`);
  });
  
  // Prompt input
  container.querySelector('#mmPrompt')?.addEventListener('input', e => {
    state.prompt = e.target.value;
    container.querySelector('#mmNext2').disabled = !e.target.value.trim();
  });
  
  // Media
  container.querySelector('#mmAttachMedia')?.addEventListener('click', () => openMediaPicker(container));
  container.querySelector('#mmRemoveMedia')?.addEventListener('click', () => {
    state.attachedMedia = null;
    renderCurrentStep();
  });
  
  // Nav
  container.querySelector('#mmBack2')?.addEventListener('click', prevStep);
  container.querySelector('#mmNext2')?.addEventListener('click', () => {
    state.prompt = container.querySelector('#mmPrompt')?.value?.trim() || state.prompt;
    nextStep();
  });
}

// ============================================================
// STEP 3: CONFIRM / REVIEW
// ============================================================

function renderConfirmStep(container) {
  const recipients = getSelectedRecipients();
  const count = recipients.length;
  const genCount = state.generatedMessages.size;
  const allGenerated = recipients.every(s => state.generatedMessages.has(s.id));
  
  container.innerHTML = `
    <h4 class="mm-title">Review & edit messages</h4>
    <p class="mm-subtitle">Generate all messages, review and edit before sending</p>
    
    <div class="mm-setting-row">
      <span class="mm-setting-label">⏱️ Delay between sends</span>
      <div class="mm-delay-ctrl">
        <input type="range" id="mmDelay" min="15" max="120" step="5" value="${state.delaySeconds}">
        <span id="mmDelayVal" class="mm-delay-val">${state.delaySeconds}s</span>
      </div>
    </div>
    
    ${!allGenerated ? `
      <button class="mm-btn mm-btn-primary mm-generate-all-btn" id="mmGenerateAll" ${state.isGenerating ? 'disabled' : ''}>
        ${state.isGenerating ? `⏳ Generating ${genCount}/${count}...` : `✨ Generate All Messages (${count})`}
      </button>
      ${state.isGenerating ? `
        <div class="mm-progress" style="margin-top:8px">
          <div class="mm-progress-bar" style="width: ${count > 0 ? Math.round((genCount / count) * 100) : 0}%"></div>
        </div>
      ` : ''}
    ` : ''}
    
    <div class="mm-msg-list" id="mmMsgList">
      ${recipients.map(s => {
        const msg = state.generatedMessages.get(s.id);
        const realName = s.notes?.name || '';
        return `
          <div class="mm-msg-card" data-sid="${escapeHtml(s.id)}">
            <div class="mm-msg-header">
              <span class="mm-msg-icon" style="color:${s.tier.color}">${s.tier.icon}</span>
              <span class="mm-msg-name">${escapeHtml(s.name)}</span>
              ${realName ? `<span class="mm-msg-realname">(${escapeHtml(realName)})</span>` : '<span class="mm-msg-realname">(no name)</span>'}
              <button class="mm-msg-regen" data-sid="${escapeHtml(s.id)}" title="Regenerate">🔄</button>
            </div>
            ${msg
              ? `<textarea class="mm-msg-edit" data-sid="${escapeHtml(s.id)}">${escapeHtml(msg)}</textarea>`
              : `<div class="mm-msg-pending">Not generated yet</div>`
            }
          </div>
        `;
      }).join('')}
    </div>
    
    <div class="mm-time-estimate">
      <span>⏳ ~${Math.ceil((count * state.delaySeconds) / 60)} min to send</span>
    </div>
    
    <div class="mm-nav">
      <button class="mm-btn mm-btn-ghost" id="mmBack3">
        <span class="mm-btn-arrow">←</span> Back
      </button>
      <button class="mm-btn mm-btn-send" id="mmStartSend" ${!allGenerated ? 'disabled' : ''}>
        🚀 Send ${count} message${count !== 1 ? 's' : ''}
      </button>
    </div>
  `;
  
  // Delay slider
  container.querySelector('#mmDelay')?.addEventListener('input', e => {
    state.delaySeconds = parseInt(e.target.value);
    container.querySelector('#mmDelayVal').textContent = `${state.delaySeconds}s`;
    const est = container.querySelector('.mm-time-estimate span');
    if (est) est.textContent = `⏳ ~${Math.ceil((count * state.delaySeconds) / 60)} min to send`;
  });
  
  // Generate All
  container.querySelector('#mmGenerateAll')?.addEventListener('click', () => generateAllMessages());
  
  // Save edits on input (live sync to state)
  container.querySelectorAll('.mm-msg-edit').forEach(ta => {
    ta.addEventListener('input', () => {
      state.generatedMessages.set(ta.dataset.sid, ta.value);
    });
  });
  
  // Regenerate single
  container.querySelectorAll('.mm-msg-regen').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sid = btn.dataset.sid;
      const sub = recipients.find(s => s.id === sid);
      if (!sub) return;
      btn.textContent = '⏳';
      btn.disabled = true;
      try {
        const text = await generatePersonalizedMessage(sub);
        state.generatedMessages.set(sid, text);
        const ta = container.querySelector(`.mm-msg-edit[data-sid="${sid}"]`);
        if (ta) ta.value = text;
        else renderCurrentStep();
      } catch (err) {
        showNotification(`❌ ${err.message}`);
      }
      btn.textContent = '🔄';
      btn.disabled = false;
    });
  });
  
  // Nav
  container.querySelector('#mmBack3')?.addEventListener('click', prevStep);
  container.querySelector('#mmStartSend')?.addEventListener('click', startSending);
}

/** Generate messages for ALL selected recipients sequentially */
async function generateAllMessages() {
  const recipients = getSelectedRecipients();
  state.isGenerating = true;
  state.generateProgress = 0;
  renderCurrentStep();
  
  for (const sub of recipients) {
    if (!state.generatedMessages.has(sub.id)) {
      try {
        const text = await generatePersonalizedMessage(sub);
        state.generatedMessages.set(sub.id, text);
      } catch (err) {
        state.generatedMessages.set(sub.id, `[ERROR: ${err.message}]`);
      }
      state.generateProgress = state.generatedMessages.size;
      // Update UI without full re-render (just update progress)
      const body = $('broadcastBody');
      const btn = body?.querySelector('#mmGenerateAll');
      if (btn) btn.textContent = `⏳ Generating ${state.generateProgress}/${recipients.length}...`;
      const bar = body?.querySelector('.mm-progress-bar');
      if (bar) bar.style.width = `${Math.round((state.generateProgress / recipients.length) * 100)}%`;
    }
  }
  
  state.isGenerating = false;
  renderCurrentStep(); // Full re-render to show all editable textareas
}

// ============================================================
// STEP 4: SENDING
// ============================================================

function renderSendingStep(container) {
  const recipients = getSelectedRecipients();
  const total = recipients.length;
  const done = state.results.length;
  const sent = state.results.filter(r => r.status === 'sent').length;
  const failed = state.results.filter(r => r.status === 'error').length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const isPaused = state.isPaused;
  const current = recipients[state.currentIndex];
  
  container.innerHTML = `
    <div class="mm-sending-header">
      <h4 class="mm-title">${isPaused ? 'Paused' : 'Sending messages...'}</h4>
      <div class="mm-sending-count">${done} / ${total}</div>
    </div>
    
    <div class="mm-progress">
      <div class="mm-progress-bar" style="width: ${pct}%"></div>
    </div>
    
    <div class="mm-send-stats">
      <div class="mm-stat mm-stat-ok"><span>✅</span> ${sent}</div>
      <div class="mm-stat mm-stat-err"><span>❌</span> ${failed}</div>
      <div class="mm-stat mm-stat-left"><span>⏳</span> ${total - done}</div>
    </div>
    
    <div class="mm-results" id="mmResults">
      ${state.results.slice(-8).map(r => `
        <div class="mm-result ${r.status}">
          <span class="mm-result-status">${r.status === 'sent' ? '✅' : '❌'}</span>
          <span class="mm-result-name">${escapeHtml(r.name)}</span>
          <span class="mm-result-detail">${escapeHtml((r.message || r.error || '').substring(0, 50))}</span>
        </div>
      `).join('')}
      ${done < total && current ? `
        <div class="mm-result current">
          <span class="mm-result-status">
            <div class="mm-pulse"></div>
          </span>
          <span class="mm-result-name">${escapeHtml(current.name)}</span>
          <span class="mm-result-detail">${isPaused ? 'Paused' : 'Generating...'}</span>
        </div>
      ` : ''}
    </div>
    
    <div class="mm-nav mm-nav-sending">
      ${isPaused
        ? `<button class="mm-btn mm-btn-primary" id="mmResume">▶️ Resume</button>`
        : `<button class="mm-btn mm-btn-ghost" id="mmPause">⏸️ Pause</button>`
      }
      <button class="mm-btn mm-btn-danger" id="mmStop">⏹ Stop</button>
    </div>
  `;
  
  // Auto scroll results
  const results = container.querySelector('#mmResults');
  if (results) results.scrollTop = results.scrollHeight;
  
  container.querySelector('#mmPause')?.addEventListener('click', () => {
    state.isPaused = true;
    renderCurrentStep();
  });
  container.querySelector('#mmResume')?.addEventListener('click', () => {
    state.isPaused = false;
    renderCurrentStep();
    continueSending();
  });
  container.querySelector('#mmStop')?.addEventListener('click', () => {
    state.isStopped = true;
    goToStep(4); // done
  });
}

// ============================================================
// STEP 5: DONE
// ============================================================

function renderDoneStep(container) {
  const sent = state.results.filter(r => r.status === 'sent').length;
  const failed = state.results.filter(r => r.status === 'error').length;
  const total = state.results.length;
  const recipientCount = getSelectedRecipients().length;
  const wasStopped = state.isStopped && total < recipientCount;
  
  container.innerHTML = `
    <div class="mm-done-hero">
      <div class="mm-done-icon">${wasStopped ? '⏹' : '🎉'}</div>
      <h4 class="mm-title">${wasStopped ? 'Stopped' : 'All done!'}</h4>
    </div>
    
    <div class="mm-done-stats">
      <div class="mm-done-stat">
        <span class="mm-done-num ok">${sent}</span>
        <span class="mm-done-label">Sent</span>
      </div>
      <div class="mm-done-stat">
        <span class="mm-done-num err">${failed}</span>
        <span class="mm-done-label">Failed</span>
      </div>
      <div class="mm-done-stat">
        <span class="mm-done-num">${total}</span>
        <span class="mm-done-label">Total</span>
      </div>
    </div>
    
    <div class="mm-results mm-results-final" id="mmResults">
      ${state.results.map(r => `
        <div class="mm-result ${r.status}">
          <span class="mm-result-status">${r.status === 'sent' ? '✅' : '❌'}</span>
          <span class="mm-result-name">${escapeHtml(r.name)}</span>
          <span class="mm-result-detail">${escapeHtml((r.message || r.error || '').substring(0, 60))}</span>
        </div>
      `).join('')}
    </div>
    
    <div class="mm-nav">
      <button class="mm-btn mm-btn-ghost" id="mmNewMsg">📢 New Mass Message</button>
      <button class="mm-btn mm-btn-primary" id="mmCloseDone">Done</button>
    </div>
  `;
  
  container.querySelector('#mmNewMsg')?.addEventListener('click', () => {
    state.currentStep = 0;
    state.results = [];
    state.currentIndex = 0;
    state.isStopped = false;
    state.isPaused = false;
    renderCurrentStep();
  });
  container.querySelector('#mmCloseDone')?.addEventListener('click', closeBroadcastModal);
}

// ============================================================
// PREVIEW
// ============================================================

async function generatePreview(container) {
  const bubble = container.querySelector('#mmPreviewBubble');
  const recipients = getSelectedRecipients();
  if (!bubble || recipients.length === 0) return;
  
  bubble.classList.remove('hidden');
  bubble.innerHTML = '<div class="mm-preview-loading"><div class="spinner"></div></div>';
  
  const sub = recipients[Math.floor(Math.random() * recipients.length)];
  state.previewSub = sub;
  
  try {
    const text = await generatePersonalizedMessage(sub);
    state.previewMessage = text;
    bubble.innerHTML = `
      <div class="mm-preview-for">For: <strong>${escapeHtml(sub.name)}</strong></div>
      <div class="mm-preview-text">${escapeHtml(text)}</div>
    `;
  } catch (e) {
    bubble.innerHTML = `<div class="mm-preview-err">❌ ${escapeHtml(e.message)}</div>`;
  }
}

// ============================================================
// AI GENERATION
// ============================================================

async function generatePersonalizedMessage(subscriber) {
  const profile = Store.get('currentProfile');
  const notesCtx = [];
  const notes = subscriber.notes || {};
  // Use ONLY the real name from notes (what the subscriber told them), NOT the username
  const realName = notes.name || '';
  if (realName) notesCtx.push(`Name: ${realName}`);
  else notesCtx.push('Name: unknown — do NOT use any username, write a neutral message without a name');
  if (notes.age) notesCtx.push(`Age: ${notes.age}`);
  if (notes.location) notesCtx.push(`Location: ${notes.location}`);
  if (notes.job) notesCtx.push(`Job: ${notes.job}`);
  if (notes.hobbies) notesCtx.push(`Interests: ${notes.hobbies}`);
  if (notes.kinks) notesCtx.push(`Kinks: ${notes.kinks}`);
  if (notes.other) notesCtx.push(`Notes: ${notes.other}`);
  notesCtx.push(`Spending: ${subscriber.totalSpent} (${subscriber.tier.label})`);
  
  const profileInfo = {};
  if (profile?.name) profileInfo.name = profile.name;
  if (profile?.modelName) profileInfo.modelName = profile.modelName;
  if (profile?.age) profileInfo.age = profile.age;
  if (profile?.personality) profileInfo.personality = profile.personality;
  if (profile?.defaultTone) profileInfo.tone = profile.defaultTone;
  if (profile?.styleRules) profileInfo.style = profile.styleRules;
  if (profile?.language) profileInfo.language = profile.language;
  
  const recentMessages = (subscriber.messages || []).slice(-3);
  
  const response = await API.generateResponse({
    summary: null,
    recentMessages: recentMessages.length > 0 ? recentMessages : [{ text: '(no recent messages)', isFromMe: false }],
    currentStage: 1,
    tone: profile?.defaultTone || 'flirty',
    persona: null,
    profile: Object.keys(profileInfo).length > 0 ? profileInfo : null,
    subscriberName: realName || null,  // Only pass real name, not username
    actionGoal: state.prompt,
    actionType: 'text',
    subscriberNotes: notesCtx.join(', '),
    isBroadcast: true
  });
  
  if (response.success && response.response) {
    let text = response.response.trim();
    if (text.startsWith('[') && text.endsWith(']')) {
      try { const p = JSON.parse(text); if (Array.isArray(p)) text = p.join(' '); } catch (_) {}
    }
    return text;
  }
  throw new Error(response.error || 'Generation failed');
}

// ============================================================
// SENDING EXECUTION
// ============================================================

async function startSending() {
  state.currentIndex = 0;
  state.results = [];
  state.isPaused = false;
  state.isStopped = false;
  goToStep(3); // sending step
  await continueSending();
}

async function continueSending() {
  const recipients = getSelectedRecipients();
  
  for (let i = state.currentIndex; i < recipients.length; i++) {
    if (state.isPaused || state.isStopped) { state.currentIndex = i; return; }
    
    state.currentIndex = i;
    const sub = recipients[i];
    
    try {
      renderCurrentStep();
      // Use pre-generated/edited message, or generate on-the-fly as fallback
      const message = state.generatedMessages.get(sub.id) || await generatePersonalizedMessage(sub);
      
      if (state.isPaused || state.isStopped) { state.currentIndex = i; return; }
      
      // Navigate
      const tabs = await chrome.tabs.query({ url: '*://onlyfans.com/*' });
      if (tabs.length === 0) throw new Error('No OnlyFans tab');
      const tabId = tabs[0].id;
      
      await chrome.tabs.update(tabId, { url: `https://onlyfans.com/my/chats/chat/${sub.rawId}`, active: true });
      await sleep(3000);
      await waitForChatReady(tabId, 15000);
      
      // Media
      if (state.attachedMedia?.imageData) {
        await chrome.tabs.sendMessage(tabId, { type: 'SEND_IMAGE', imageUrl: state.attachedMedia.imageData, isUrl: false, price: 0 });
        await sleep(2000);
      }
      
      // Text
      const sendResult = await chrome.tabs.sendMessage(tabId, { type: 'SEND_MESSAGE', text: message });
      if (!sendResult?.success) throw new Error(sendResult?.error || 'Send failed');
      
      state.results.push({ subscriberId: sub.id, name: sub.name, status: 'sent', message, timestamp: Date.now() });
      console.log(`[MassMsg] ✅ ${sub.name}`);
    } catch (error) {
      state.results.push({ subscriberId: sub.id, name: sub.name, status: 'error', error: error.message, timestamp: Date.now() });
      console.error(`[MassMsg] ❌ ${sub.name}:`, error);
    }
    
    renderCurrentStep();
    
    if (i < recipients.length - 1 && !state.isPaused && !state.isStopped) {
      await sleep(state.delaySeconds * 1000);
    }
  }
  
  // Done
  const sent = state.results.filter(r => r.status === 'sent').length;
  history.push({
    timestamp: Date.now(), prompt: state.prompt,
    tiers: Array.from(state.selectedTiers),
    total: recipients.length, sent,
    failed: state.results.filter(r => r.status === 'error').length
  });
  saveHistory();
  
  goToStep(4);
  showNotification(`📢 Mass message done! ${sent}/${recipients.length} sent`);
}

// ============================================================
// MEDIA PICKER
// ============================================================

function openMediaPicker(container) {
  const images = getImages();
  if (images.length === 0) { showNotification('No media in vault. Add some first!'); return; }
  
  const existing = document.getElementById('mmMediaPicker');
  if (existing) existing.remove();
  
  const picker = document.createElement('div');
  picker.id = 'mmMediaPicker';
  picker.className = 'mm-media-picker';
  picker.innerHTML = `
    <div class="mm-media-header">
      <span>📎 Select Media</span>
      <button class="icon-btn mm-media-close">✕</button>
    </div>
    <div class="mm-media-grid">
      ${images.map(img => `
        <div class="mm-media-item" data-mid="${img.id}">
          ${img.mediaType === 'video' ? '<div class="mm-media-video">🎬</div>' : `<img src="${img.imageData}" alt="">`}
        </div>
      `).join('')}
    </div>
  `;
  
  container.appendChild(picker);
  requestAnimationFrame(() => picker.classList.add('open'));
  
  picker.querySelector('.mm-media-close')?.addEventListener('click', () => {
    picker.classList.remove('open');
    setTimeout(() => picker.remove(), 200);
  });
  
  picker.querySelectorAll('.mm-media-item').forEach(item => {
    item.addEventListener('click', () => {
      const media = images.find(i => i.id === item.dataset.mid);
      if (media) {
        state.attachedMedia = { id: media.id, name: media.name, mediaType: media.mediaType, imageData: media.imageData };
        picker.remove();
        renderCurrentStep();
        showNotification(`📎 ${media.name}`);
      }
    });
  });
}

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForChatReady(tabId, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const r = await chrome.tabs.sendMessage(tabId, { type: 'IS_CHAT_READY' }); if (r?.ready) return true; } catch (_) {}
    await sleep(500);
  }
  await sleep(3000);
  return false;
}

export default { initBroadcast, openBroadcastModal, closeBroadcastModal };
