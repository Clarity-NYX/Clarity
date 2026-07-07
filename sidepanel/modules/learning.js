// ============================================================
// AI LEARNING MODULE
// Controls simulation, displays conversations, shows insights
// ============================================================

import { $ } from '../utils/dom.js';
import { apiRequest } from '../utils/api.js';
import { escapeHtml } from '../utils/sanitize.js';
import Store from '../state/store.js';

// ============================================================
// STATE
// ============================================================

let pollInterval = null;
let currentViewingSim = null;

// ============================================================
// HELPERS
// ============================================================

const getProfileId = () => Store.get('currentProfile')?.id;

// ============================================================
// STATUS POLLING
// ============================================================

async function pollStatus() {
  try {
    const data = await apiRequest('/simulation/status');
    if (!data.success) return;

    const dot = $('simStatusDot');
    const text = $('simStatusText');
    const progress = $('simProgress');
    const score = $('simAvgScore');
    const bar = $('simProgressBar');
    const startBtn = $('simStartBtn');
    const pauseBtn = $('simPauseBtn');
    const stopBtn = $('simStopBtn');

    if (data.running) {
      dot.className = data.paused ? 'status-dot paused' : 'status-dot running';
      text.textContent = data.paused ? 'Paused' : `Running Batch ${data.batchNumber}`;
      progress.textContent = `${data.currentBatchProgress}/${data.currentBatchSize}`;
      score.textContent = data.avgScore > 0 ? `${data.avgScore.toFixed(1)}/10` : '--';
      const pct = data.currentBatchSize > 0 ? (data.currentBatchProgress / data.currentBatchSize) * 100 : 0;
      bar.style.width = `${pct}%`;
      startBtn.disabled = true;
      pauseBtn.disabled = false;
      stopBtn.disabled = false;
      pauseBtn.textContent = data.paused ? '▶ Resume' : '⏸ Pause';
    } else {
      dot.className = 'status-dot idle';
      text.textContent = data.batchNumber > 0 ? `Batch ${data.batchNumber} Complete` : 'Idle';
      if (data.batchNumber > 0) {
        score.textContent = data.avgScore > 0 ? `${data.avgScore.toFixed(1)}/10` : '--';
        bar.style.width = '100%';
      }
      startBtn.disabled = false;
      pauseBtn.disabled = true;
      stopBtn.disabled = true;

      // Stop polling if not running
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
        // Auto-refresh conversations & insights
        loadConversations();
        loadInsights();
      }
    }
  } catch (e) {
    console.error('[Learning] Poll error:', e.message);
  }
}

function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(pollStatus, 3000);
  pollStatus(); // Immediate first poll
}

// ============================================================
// SIMULATION CONTROLS
// ============================================================

async function handleStart() {
  const profileId = getProfileId();
  if (!profileId) {
    alert('Select a profile first');
    return;
  }

  const batchSize = parseInt($('simBatchSize')?.value) || 10;
  const delay = (parseInt($('simDelay')?.value) || 5) * 1000;
  const msgCount = parseInt($('simMsgCount')?.value) || 24;
  const kinkSelect = $('simKinkFocus');
  const focusKinks = kinkSelect ? Array.from(kinkSelect.selectedOptions).map(o => o.value) : [];

  try {
    $('simStartBtn').disabled = true;
    $('simStartBtn').textContent = '⏳ Starting...';

    await apiRequest('/simulation/start', {
      method: 'POST',
      body: JSON.stringify({ profileId, batchSize, delayBetweenSims: delay, messagesPerConversation: msgCount, focusKinks })
    });

    startPolling();
    $('simStartBtn').textContent = '▶ Start Training';
  } catch (e) {
    console.error('[Learning] Start error:', e.message);
    $('simStartBtn').disabled = false;
    $('simStartBtn').textContent = '▶ Start Training';
    alert('Failed to start: ' + e.message);
  }
}

async function handlePause() {
  try {
    const dot = $('simStatusDot');
    const isPaused = dot?.classList.contains('paused');
    await apiRequest(isPaused ? '/simulation/resume' : '/simulation/pause', { method: 'POST' });
    pollStatus();
  } catch (e) {
    console.error('[Learning] Pause error:', e.message);
  }
}

async function handleStop() {
  try {
    await apiRequest('/simulation/stop', { method: 'POST' });
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    pollStatus();
    loadConversations();
  } catch (e) {
    console.error('[Learning] Stop error:', e.message);
  }
}

// ============================================================
// CONVERSATIONS LIST
// ============================================================

async function loadConversations() {
  try {
    const data = await apiRequest('/simulation/conversations?limit=50');
    if (!data.success) return;

    const list = $('simConvList');
    if (!data.conversations || data.conversations.length === 0) {
      list.innerHTML = '<div class="sim-empty-state"><span>🧪</span><p>No simulations yet</p><small>Start training to see conversations here</small></div>';
      return;
    }

    list.innerHTML = data.conversations.map(sim => {
      const score = sim.evaluation?.avgScore || 0;
      const scoreColor = score >= 7 ? 'good' : score >= 5 ? 'ok' : 'bad';
      return `<div class="sim-conv-item" data-sim-id="${sim.id}">
        <div class="sim-conv-left">
          <span class="sim-conv-index">#${sim.simIndex}</span>
          <span class="sim-conv-archetype">${sim.archetypeName}</span>
        </div>
        <div class="sim-conv-right">
          <span class="sim-conv-score ${scoreColor}">${score.toFixed(1)}</span>
          <span class="sim-conv-msgs">${sim.conversation?.length || 0} msgs</span>
        </div>
      </div>`;
    }).join('');

    // Click handlers
    list.querySelectorAll('.sim-conv-item').forEach(item => {
      item.addEventListener('click', () => viewConversation(item.dataset.simId));
    });
  } catch (e) {
    console.error('[Learning] Load conversations error:', e.message);
  }
}

// ============================================================
// CONVERSATION VIEWER
// ============================================================

async function viewConversation(simId) {
  try {
    const data = await apiRequest(`/simulation/conversations/${simId}`);
    if (!data.success || !data.conversation) return;

    const sim = data.conversation;
    currentViewingSim = sim;

    // Show viewer, hide list
    $('simConvList')?.parentElement?.classList.add('hidden');
    $('simChatViewer')?.classList.remove('hidden');

    // Header
    $('simChatArchetype').textContent = sim.archetypeName;
    $('simChatScore').textContent = `${(sim.evaluation?.avgScore || 0).toFixed(1)}/10`;

    // Score bars
    const scoresEl = $('simChatScores');
    const scores = sim.evaluation?.scores || {};
    scoresEl.innerHTML = Object.entries(scores).map(([key, val]) => {
      const pct = (val / 10) * 100;
      const color = val >= 7 ? '#4ade80' : val >= 5 ? '#fbbf24' : '#f87171';
      return `<div class="score-bar-row">
        <span class="score-bar-label">${key}</span>
        <div class="score-bar-track"><div class="score-bar-fill" style="width:${pct}%;background:${color}"></div></div>
        <span class="score-bar-value">${val}/10</span>
      </div>`;
    }).join('');

    // Messages
    const msgsEl = $('simChatMessages');
    msgsEl.innerHTML = (sim.conversation || []).map(m => {
      const isMistress = m.role === 'mistress';
      return `<div class="sim-msg ${isMistress ? 'sim-msg-mistress' : 'sim-msg-sub'}">
        <span class="sim-msg-role">${isMistress ? '👑 Mistress' : '🙍 Sub'}</span>
        <p class="sim-msg-text">${escapeHtml(m.text)}</p>
      </div>`;
    }).join('');

    // Evaluation
    const evalEl = $('simChatEval');
    const ev = sim.evaluation || {};
    evalEl.innerHTML = `
      <div class="eval-item eval-best"><strong>Best:</strong> ${escapeHtml(ev.bestMoment || 'N/A')}</div>
      <div class="eval-item eval-worst"><strong>Worst:</strong> ${escapeHtml(ev.worstMoment || 'N/A')}</div>
      <div class="eval-item eval-insight"><strong>Insight:</strong> ${escapeHtml(ev.keyInsight || 'N/A')}</div>
    `;

    // Scroll to top
    msgsEl.scrollTop = 0;
  } catch (e) {
    console.error('[Learning] View conversation error:', e.message);
  }
}

function backToConvList() {
  $('simChatViewer')?.classList.add('hidden');
  $('simConvList')?.parentElement?.classList.remove('hidden');
  currentViewingSim = null;
}

// ============================================================
// INSIGHTS & ENHANCEMENT
// ============================================================

async function loadInsights() {
  try {
    const data = await apiRequest('/simulation/batches');
    if (!data.success || !data.batches || data.batches.length === 0) return;

    const latest = data.batches[0];
    if (!latest.analysis) return;

    const insightsEl = $('simInsights');
    const contentEl = $('simInsightsContent');
    insightsEl.classList.remove('hidden');

    const a = latest.analysis;
    contentEl.innerHTML = `
      <div class="insight-section">
        <h5>🏆 Strengths</h5>
        <ul>${(a.strengths || []).map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
      </div>
      <div class="insight-section">
        <h5>⚠️ Weaknesses</h5>
        <ul>${(a.weaknesses || []).map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
      </div>
      <div class="insight-section">
        <h5>💡 Recommendations</h5>
        <ul>${(a.recommendations || []).map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
      </div>
      <div class="insight-section">
        <p><strong>Overall:</strong> ${escapeHtml(a.overallAssessment || 'N/A')}</p>
      </div>
    `;

    // Enhancement prompt
    if (latest.enhancementPrompt) {
      $('simEnhancement')?.classList.remove('hidden');
      $('simEnhancementText').textContent = latest.enhancementPrompt;
    }

    // History list
    renderHistory(data.batches);
  } catch (e) {
    console.error('[Learning] Load insights error:', e.message);
  }
}

function renderHistory(batches) {
  const list = $('simHistoryList');
  if (!batches || batches.length === 0) {
    list.innerHTML = '<small class="sim-history-empty">No batches completed yet</small>';
    return;
  }
  list.innerHTML = batches.map(b => {
    const date = b.completedAt ? new Date(b.completedAt).toLocaleDateString() : '...';
    return `<div class="sim-history-item">
      <span class="history-batch">Batch ${b.batchNumber}</span>
      <span class="history-sims">${b.batchSize || 0} sims</span>
      <span class="history-score">${(b.avgScore || 0).toFixed(1)}/10</span>
      <span class="history-date">${date}</span>
    </div>`;
  }).join('');
}

// ============================================================
// TRAINING DATA (Reference Chats)
// ============================================================

export async function saveCurrentChatAsTraining() {
  const messages = Store.get('messages') || [];
  if (!messages.length) { alert('No chat loaded to save'); return; }
  
  const profileId = getProfileId();
  const subscriberId = Store.get('currentSubscriberId') || 'unknown';
  const storedChat = Store.get('storedChat') || {};
  const notes = storedChat.notes || {};
  
  const label = prompt('Label for this training chat:', `${notes.name || subscriberId} - ${new Date().toLocaleDateString()}`);
  if (!label) return;

  try {
    const btn = document.getElementById('saveForTrainingBtn');
    if (btn) btn.textContent = '⏳';
    
    await apiRequest('/simulation/training-data', {
      method: 'POST',
      body: JSON.stringify({
        chatId: `${subscriberId}_${Date.now()}`,
        subscriberId,
        profileId,
        messages,
        notes,
        stats: {
          subscribedFor: notes.subscribedFor || notes.subscribedSince || null,
          totalSpent: notes.totalSpent || null,
          totalMessages: messages.length
        },
        label
      })
    });
    
    if (btn) { btn.textContent = '✅'; setTimeout(() => { btn.textContent = '📚'; }, 2000); }
    console.log('[Learning] 📚 Chat saved as training data');
  } catch (e) {
    console.error('[Learning] Save training data error:', e);
    alert('Failed to save: ' + e.message);
    const btn = document.getElementById('saveForTrainingBtn');
    if (btn) btn.textContent = '📚';
  }
}

async function loadTrainingData() {
  try {
    const data = await apiRequest('/simulation/training-data');
    if (!data.success) return;

    const list = document.getElementById('refChatList');
    if (!data.items || data.items.length === 0) {
      list.innerHTML = '<div class="sim-empty-state"><span>📚</span><p>No reference chats yet</p><small>Open a real chat and click 📚 to save it as training data</small></div>';
      return;
    }

    list.innerHTML = data.items.map(item => {
      const badges = [];
      if (item.hasMedia) badges.push('📸');
      if (item.hasPurchases) badges.push('💰');
      return `<div class="ref-chat-item" data-ref-id="${item.id}">
        <div class="ref-chat-left">
          <span class="ref-chat-label">${escapeHtml(item.label)}</span>
          <span class="ref-chat-meta">${item.messageCount} msgs · ${item.myMessageCount}↗ ${item.theirMessageCount}↙ ${badges.join(' ')}</span>
        </div>
        <div class="ref-chat-right">
          <span class="ref-chat-date">${item.savedAt ? new Date(item.savedAt).toLocaleDateString() : ''}</span>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('.ref-chat-item').forEach(item => {
      item.addEventListener('click', () => viewTrainingChat(item.dataset.refId));
    });
  } catch (e) {
    console.error('[Learning] Load training data error:', e);
  }
}

async function viewTrainingChat(refId) {
  try {
    const data = await apiRequest(`/simulation/training-data/${refId}`);
    if (!data.success || !data.data) return;

    const chat = data.data;
    currentViewingRef = refId;

    // Hide list, show viewer
    document.querySelector('.sim-reference')?.classList.add('hidden');
    $('refChatViewer')?.classList.remove('hidden');

    $('refChatLabel').textContent = chat.label || 'Reference Chat';
    $('refChatMsgCount').textContent = `${chat.messageCount || 0} msgs`;

    // Notes section
    const notesEl = $('refChatNotes');
    const n = chat.notes || {};
    const s = chat.stats || {};
    const infoParts = [];
    if (n.name) infoParts.push(`👤 ${n.name}`);
    if (n.age) infoParts.push(`🎂 ${n.age}`);
    if (n.location) infoParts.push(`📍 ${n.location}`);
    if (s.totalSpent) infoParts.push(`💰 ${s.totalSpent}`);
    if (n.kinks) infoParts.push(`🔥 ${n.kinks}`);
    notesEl.innerHTML = infoParts.length ? `<div class="ref-notes-bar">${infoParts.map(p => `<span class="ref-note-tag">${escapeHtml(p)}</span>`).join('')}</div>` : '';

    // Messages
    const msgsEl = $('refChatMessages');
    msgsEl.innerHTML = (chat.messages || []).map(m => {
      const isMe = m.isFromMe;
      let mediaBadge = '';
      if (m.mediaType) {
        const icon = m.mediaType === 'video' ? '🎬' : m.mediaType === 'ppv' ? '💰' : '📸';
        mediaBadge = `<span class="ref-media-badge">${icon} ${m.mediaType}</span>`;
      }
      let payBadge = '';
      if (m.paymentStatus) {
        payBadge = `<span class="ref-pay-badge ${m.paymentStatus}">${m.paymentStatus === 'paid' ? '✅' : '❌'} ${m.paymentAmount || ''}</span>`;
      }
      let thumbHtml = '';
      if (m.mediaThumbnail) {
        thumbHtml = `<img class="ref-msg-thumb" src="${m.mediaThumbnail}" alt="media">`;
      }
      return `<div class="ref-msg ${isMe ? 'ref-msg-me' : 'ref-msg-them'}">
        <div class="ref-msg-bubble">
          ${thumbHtml}
          <p class="ref-msg-text">${escapeHtml(m.text)}</p>
          <div class="ref-msg-meta">${mediaBadge}${payBadge}<span class="ref-msg-time">${m.time || ''}</span></div>
        </div>
      </div>`;
    }).join('');

    msgsEl.scrollTop = 0;
  } catch (e) {
    console.error('[Learning] View training chat error:', e);
  }
}

async function deleteTrainingChat() {
  if (!currentViewingRef) return;
  if (!confirm('Delete this reference chat?')) return;
  try {
    await apiRequest(`/simulation/training-data/${currentViewingRef}`, { method: 'DELETE' });
    backToRefList();
    loadTrainingData();
  } catch (e) {
    console.error('[Learning] Delete training data error:', e);
  }
}

function backToRefList() {
  $('refChatViewer')?.classList.add('hidden');
  document.querySelector('.sim-reference')?.classList.remove('hidden');
  currentViewingRef = null;
}

let currentViewingRef = null;

// ============================================================
// COPY ENHANCEMENT PROMPT
// ============================================================

function copyEnhancement() {
  const text = $('simEnhancementText')?.textContent;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const btn = $('simCopyEnhancement');
    btn.textContent = '✅ Copied!';
    setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000);
  });
}

// ============================================================
// INIT & SETUP
// ============================================================

export async function initLearning() {
  console.log('[Learning] 🧠 Initializing AI Learning module');
  
  // Check if user is admin — only show tab for admins
  try {
    const data = await apiRequest('/auth/role');
    if (data.success && data.role === 'admin') {
      console.log('[Learning] 🔑 Admin role detected — showing AI tab & save button');
      const tabBtn = document.getElementById('learningTabBtn');
      if (tabBtn) tabBtn.style.display = '';
      showSaveForTrainingBtn();
    } else {
      console.log('[Learning] 👤 Non-admin user — AI tab hidden');
    }
  } catch (e) {
    console.log('[Learning] Role check failed — AI tab hidden:', e.message);
  }

}

export function setupLearningListeners() {
  $('simStartBtn')?.addEventListener('click', handleStart);
  $('simPauseBtn')?.addEventListener('click', handlePause);
  $('simStopBtn')?.addEventListener('click', handleStop);
  $('simRefreshBtn')?.addEventListener('click', loadConversations);
  $('simBackToList')?.addEventListener('click', backToConvList);
  $('simCopyEnhancement')?.addEventListener('click', copyEnhancement);
  $('simLoadHistory')?.addEventListener('click', loadInsights);

  // Reference chat listeners
  $('refRefreshBtn')?.addEventListener('click', loadTrainingData);
  $('refBackToList')?.addEventListener('click', backToRefList);
  $('refDeleteBtn')?.addEventListener('click', deleteTrainingChat);

  // Save for training button (in chat header)
  document.getElementById('saveForTrainingBtn')?.addEventListener('click', saveCurrentChatAsTraining);
}

export function showSaveForTrainingBtn() {
  const btn = document.getElementById('saveForTrainingBtn');
  if (btn) btn.style.display = '';
}

export function onLearningTabActive() {

  pollStatus();
  loadConversations();
  loadInsights();
  loadTrainingData();
}
