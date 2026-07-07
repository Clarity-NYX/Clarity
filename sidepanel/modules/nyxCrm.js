// ============================================================
// NYX CRM CONNECTION MODULE
// ============================================================
// Manages the UI flow for connecting Clarity to the NYX CRM
// dashboard. Five states:
//   disconnected → mfa-verify → model-select → connected
//
// Communicates with background/nyx-crm-bridge.js via messages:
//   NYX_CRM_CONNECT       → authenticate with NYX Firebase
//   NYX_CRM_VERIFY_MFA    → verify TOTP 2FA code
//   NYX_CRM_FETCH_MODELS  → get list of model profiles
//   NYX_CRM_SELECT_MODEL  → assign model + profile & start bridge
//   NYX_CRM_DISCONNECT    → stop bridge & clear config
//   NYX_CRM_GET_STATUS    → check current bridge state
// ============================================================

import { $ } from '../utils/dom.js';
// NOTE: Vault scoping is controlled exclusively by profiles.js (setActiveProfile).
// The CRM module must NOT call setActiveProfile — doing so overwrites the
// Clarity-profile-based vault scope with CRM data keys, causing all profiles
// to show the same vault content.

// ── Helpers ──

/** Send a message to the background script and return the response */
function sendMessage(type, data = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, data }, (response) => {
      resolve(response || { success: false, error: 'No response' });
    });
  });
}

/** Show an element by removing .hidden */
function show(el) { if (el) el.classList.remove('hidden'); }

/** Hide an element by adding .hidden */
function hide(el) { if (el) el.classList.add('hidden'); }

// ── DOM References (cached on init) ──
let els = {};

// ── MFA State (held between connect and verify steps) ──
let mfaPendingCredential = null;
let mfaEnrollmentId = null;

// ── Models cache (stores full model data including ofProfiles) ──
let cachedModels = [];

function cacheElements() {
  els = {
    section:        $('nyxCrmSection'),
    status:         $('nyxCrmStatus'),
    statusDot:      $('nyxCrmStatusDot'),
    statusText:     $('nyxCrmStatusText'),
    // Login form
    loginForm:      $('nyxCrmLoginForm'),
    emailInput:     $('nyxCrmEmail'),
    passwordInput:  $('nyxCrmPassword'),
    loginError:     $('nyxCrmLoginError'),
    connectBtn:     $('nyxCrmConnectBtn'),
    // MFA form
    mfaForm:        $('nyxCrmMfaForm'),
    totpInput:      $('nyxCrmTotpCode'),
    mfaError:       $('nyxCrmMfaError'),
    verifyMfaBtn:   $('nyxCrmVerifyMfaBtn'),
    mfaBackBtn:     $('nyxCrmMfaBackBtn'),
    // Model selector
    modelSelector:  $('nyxCrmModelSelector'),
    modelSelect:    $('nyxCrmModelSelect'),
    selectModelBtn: $('nyxCrmSelectModelBtn'),
    backBtn:        $('nyxCrmBackBtn'),
    // Profile selector (within model selector)
    profileGroup:   $('nyxCrmProfileGroup'),
    profileSelect:  $('nyxCrmProfileSelect'),
    // Connected state
    connected:      $('nyxCrmConnected'),
    modelName:      $('nyxCrmModelName'),
    disconnectBtn:  $('nyxCrmDisconnectBtn'),
  };
}

// ── UI State Management ──

/** Switch to disconnected state: show login form */
function showDisconnectedState() {
  mfaPendingCredential = null;
  mfaEnrollmentId = null;
  cachedModels = [];

  els.statusDot?.classList.remove('online');
  els.statusDot?.classList.add('offline');
  if (els.statusText) els.statusText.textContent = 'Not connected';

  show(els.loginForm);
  hide(els.mfaForm);
  hide(els.modelSelector);
  hide(els.connected);
  hide(els.loginError);
  hide(els.mfaError);
  hide(els.profileGroup);

  // Clear inputs
  if (els.emailInput) els.emailInput.value = '';
  if (els.passwordInput) els.passwordInput.value = '';
  if (els.totpInput) els.totpInput.value = '';
  if (els.connectBtn) {
    els.connectBtn.disabled = false;
    els.connectBtn.textContent = '🔗 Connect to NYX';
  }
}

/** Switch to MFA verification state: show TOTP input */
function showMfaState() {
  els.statusDot?.classList.remove('offline');
  els.statusDot?.classList.add('online');
  if (els.statusText) els.statusText.textContent = '2FA required';

  hide(els.loginForm);
  show(els.mfaForm);
  hide(els.modelSelector);
  hide(els.connected);
  hide(els.mfaError);

  // Clear and focus the TOTP input
  if (els.totpInput) {
    els.totpInput.value = '';
    setTimeout(() => els.totpInput.focus(), 100);
  }
  if (els.verifyMfaBtn) {
    els.verifyMfaBtn.disabled = false;
    els.verifyMfaBtn.textContent = '🔓 Verify & Continue';
  }
}

/** Switch to model-selection state: show model dropdown */
function showModelSelectionState(models) {
  mfaPendingCredential = null;
  mfaEnrollmentId = null;
  cachedModels = models; // Store for profile lookup

  els.statusDot?.classList.remove('offline');
  els.statusDot?.classList.add('online');
  if (els.statusText) els.statusText.textContent = 'Authenticated — select model';

  hide(els.loginForm);
  hide(els.mfaForm);
  show(els.modelSelector);
  hide(els.connected);
  hide(els.profileGroup); // Hidden until model with profiles is selected

  // Populate dropdown
  if (els.modelSelect) {
    els.modelSelect.innerHTML = '<option value="">— Choose a model —</option>';
    for (const model of models) {
      const opt = document.createElement('option');
      opt.value = model.id;
      opt.textContent = model.displayName || model.email || model.id;
      els.modelSelect.appendChild(opt);
    }
  }

  if (els.selectModelBtn) {
    els.selectModelBtn.disabled = false;
    els.selectModelBtn.textContent = '✅ Assign & Start Bridge';
  }
}

/** Called when model dropdown changes — populates profile selector if model has ofProfiles */
function onModelSelectChange() {
  const modelId = els.modelSelect?.value;
  if (!modelId) {
    hide(els.profileGroup);
    return;
  }

  const model = cachedModels.find(m => m.id === modelId);
  const profiles = model?.ofProfiles || [];

  if (profiles.length === 0) {
    // No OF profiles — hide the profile selector, bridge will use modelId as data key
    hide(els.profileGroup);
    return;
  }

  // Populate profile dropdown
  if (els.profileSelect) {
    els.profileSelect.innerHTML = '<option value="">— Choose OF profile —</option>';
    for (const profile of profiles) {
      const opt = document.createElement('option');
      opt.value = profile.id;
      const label = profile.name || profile.ofUsername || profile.id;
      opt.textContent = label + (profile.ofUsername ? ` (@${profile.ofUsername})` : '');
      els.profileSelect.appendChild(opt);
    }
  }

  show(els.profileGroup);
  console.log(`[NYX CRM UI] 📋 Model ${modelId} has ${profiles.length} OF profiles`);
}

/** Switch to connected state: show status + disconnect */
function showConnectedState(modelId, profileId) {
  mfaPendingCredential = null;
  mfaEnrollmentId = null;

  els.statusDot?.classList.remove('offline');
  els.statusDot?.classList.add('online');
  if (els.statusText) els.statusText.textContent = 'Connected & syncing';

  hide(els.loginForm);
  hide(els.mfaForm);
  hide(els.modelSelector);
  show(els.connected);

  // Try to show a friendly model name from the dropdown options
  let modelLabel = modelId;
  if (els.modelSelect) {
    const option = els.modelSelect.querySelector(`option[value="${modelId}"]`);
    if (option) modelLabel = option.textContent;
  }

  // If connected with a profile, try to show profile name too
  let profileLabel = '';
  if (profileId) {
    // Try dropdown first
    if (els.profileSelect) {
      const profOption = els.profileSelect.querySelector(`option[value="${profileId}"]`);
      if (profOption) profileLabel = profOption.textContent;
    }
    // Fallback: look up in cached models
    if (!profileLabel && cachedModels.length > 0) {
      const model = cachedModels.find(m => m.id === modelId);
      const profile = model?.ofProfiles?.find(p => p.id === profileId);
      if (profile) profileLabel = profile.name || profile.ofUsername || profileId;
    }
    if (!profileLabel) profileLabel = profileId;
  }

  const fullLabel = profileLabel ? `${modelLabel} → ${profileLabel}` : modelLabel;
  if (els.modelName) els.modelName.textContent = fullLabel;
}

/** Show an error in the login form */
function showLoginError(message) {
  if (els.loginError) {
    els.loginError.textContent = message;
    show(els.loginError);
  }
}

/** Show an error in the MFA form */
function showMfaError(message) {
  if (els.mfaError) {
    els.mfaError.textContent = message;
    show(els.mfaError);
  }
}

// ── Event Handlers ──

/** Handle Connect button click */
async function handleConnect() {
  const email = els.emailInput?.value?.trim();
  const password = els.passwordInput?.value;

  if (!email || !password) {
    showLoginError('Please enter both email and password.');
    return;
  }

  // Set loading state
  hide(els.loginError);
  if (els.connectBtn) {
    els.connectBtn.disabled = true;
    els.connectBtn.textContent = '⏳ Connecting...';
  }

  try {
    // Step 1: Authenticate
    const authResult = await sendMessage('NYX_CRM_CONNECT', { email, password });
    if (!authResult.success) {
      showLoginError(authResult.error || 'Authentication failed');
      if (els.connectBtn) {
        els.connectBtn.disabled = false;
        els.connectBtn.textContent = '🔗 Connect to NYX';
      }
      return;
    }

    // Check if MFA is required
    if (authResult.mfaRequired) {
      mfaPendingCredential = authResult.mfaPendingCredential;
      mfaEnrollmentId = authResult.mfaEnrollmentId;
      showMfaState();
      console.log('[NYX CRM UI] 🔐 MFA required — showing TOTP input');
      return;
    }

    // No MFA — proceed directly to fetch models
    await fetchModelsAndShow();
  } catch (err) {
    showLoginError(err.message || 'Connection failed');
    if (els.connectBtn) {
      els.connectBtn.disabled = false;
      els.connectBtn.textContent = '🔗 Connect to NYX';
    }
  }
}

/** Handle MFA Verify button click */
async function handleVerifyMfa() {
  const totpCode = els.totpInput?.value?.trim();

  if (!totpCode || totpCode.length !== 6) {
    showMfaError('Please enter a 6-digit code.');
    return;
  }

  if (!mfaPendingCredential || !mfaEnrollmentId) {
    showMfaError('MFA session expired. Please start over.');
    return;
  }

  // Set loading state
  hide(els.mfaError);
  if (els.verifyMfaBtn) {
    els.verifyMfaBtn.disabled = true;
    els.verifyMfaBtn.textContent = '⏳ Verifying...';
  }

  try {
    const verifyResult = await sendMessage('NYX_CRM_VERIFY_MFA', {
      mfaPendingCredential,
      mfaEnrollmentId,
      totpCode,
    });

    if (!verifyResult.success) {
      showMfaError(verifyResult.error || 'Verification failed');
      if (els.verifyMfaBtn) {
        els.verifyMfaBtn.disabled = false;
        els.verifyMfaBtn.textContent = '🔓 Verify & Continue';
      }
      // Clear the input for retry
      if (els.totpInput) {
        els.totpInput.value = '';
        els.totpInput.focus();
      }
      return;
    }

    // MFA verified — proceed to fetch models
    console.log('[NYX CRM UI] ✅ MFA verified successfully');
    await fetchModelsAndShow();
  } catch (err) {
    showMfaError(err.message || 'Verification failed');
    if (els.verifyMfaBtn) {
      els.verifyMfaBtn.disabled = false;
      els.verifyMfaBtn.textContent = '🔓 Verify & Continue';
    }
  }
}

/** Fetch models from NYX and show the model selector */
async function fetchModelsAndShow() {
  const modelsResult = await sendMessage('NYX_CRM_FETCH_MODELS');
  if (!modelsResult.success || !modelsResult.models?.length) {
    // Show error in whichever form is currently visible
    const errorMsg = modelsResult.error || 'No model profiles found in NYX.';
    if (!els.mfaForm?.classList.contains('hidden')) {
      showMfaError(errorMsg);
    } else {
      showLoginError(errorMsg);
    }
    return;
  }

  // Success — show model selector
  showModelSelectionState(modelsResult.models);
}

/** Handle model selection + start bridge */
async function handleSelectModel() {
  const modelId = els.modelSelect?.value;
  if (!modelId) {
    alert('Please select a model profile.');
    return;
  }

  // Get selected profile ID (may be empty if model has no ofProfiles or user didn't select)
  const profileId = els.profileSelect?.value || null;

  // If model has profiles but none selected, warn the user
  const model = cachedModels.find(m => m.id === modelId);
  if (model?.ofProfiles?.length > 0 && !profileId) {
    alert('This model has OF profiles — please select one before starting the bridge.');
    return;
  }

  if (els.selectModelBtn) {
    els.selectModelBtn.disabled = true;
    els.selectModelBtn.textContent = '⏳ Starting bridge...';
  }

  try {
    const result = await sendMessage('NYX_CRM_SELECT_MODEL', { modelId, profileId });
    if (!result.success) {
      alert(result.error || 'Failed to start bridge');
      if (els.selectModelBtn) {
        els.selectModelBtn.disabled = false;
        els.selectModelBtn.textContent = '✅ Assign & Start Bridge';
      }
      return;
    }

    showConnectedState(modelId, profileId);

    // NOTE: Vault scoping is handled by profiles.js (setActiveProfile with Clarity profile ID).
    // We do NOT call setActiveProfile here — doing so would overwrite the per-Clarity-profile
    // vault scope with the CRM data key, causing all profiles to show the same vault.
    console.log(`[NYX CRM UI] ✅ Bridge started for model: ${modelId}${profileId ? `, profile: ${profileId}` : ''}`);
  } catch (err) {
    alert(err.message || 'Failed to start bridge');
    if (els.selectModelBtn) {
      els.selectModelBtn.disabled = false;
      els.selectModelBtn.textContent = '✅ Assign & Start Bridge';
    }
  }
}

/** Handle Back button from MFA form */
function handleMfaBack() {
  mfaPendingCredential = null;
  mfaEnrollmentId = null;
  showDisconnectedState();
}

/** Handle Back button (go from model selector back to login) */
function handleBack() {
  showDisconnectedState();
}

/** Handle Disconnect button */
async function handleDisconnect() {
  if (!confirm('Disconnect from NYX CRM? The dashboard will show Clarity as offline.')) return;

  try {
    await sendMessage('NYX_CRM_DISCONNECT');
  } catch (e) {
    // Ignore errors — we're disconnecting anyway
  }

  showDisconnectedState();
  console.log('[NYX CRM UI] 🔌 Disconnected');
}

// ── Initialization ──

/** Check current bridge status and set the correct UI state */
async function loadInitialState() {
  try {
    const status = await sendMessage('NYX_CRM_GET_STATUS');
    if (status.success && status.initialized && status.modelId) {
      // Already connected — show connected state with profile info
      showConnectedState(status.modelId, status.profileId || null);

      // NOTE: Vault scoping is handled by profiles.js (setActiveProfile with Clarity profile ID).
      // We do NOT call setActiveProfile here — profiles.js is the sole owner of vault scoping.
      console.log(`[NYX CRM UI] Already connected to model: ${status.modelId}${status.profileId ? `, profile: ${status.profileId}` : ''}, dataKey: ${status.dataKey}`);
    } else {
      showDisconnectedState();
    }
  } catch (e) {
    showDisconnectedState();
  }
}

/** Initialize the NYX CRM connection UI */
export function initNyxCrm() {
  cacheElements();

  // If settings section doesn't exist (HTML not updated), skip silently
  if (!els.section) {
    console.log('[NYX CRM UI] Section not found — skipping init');
    return;
  }

  // Wire up event listeners — Login
  els.connectBtn?.addEventListener('click', handleConnect);
  els.passwordInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleConnect();
  });
  els.emailInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.passwordInput?.focus();
  });

  // Wire up event listeners — MFA
  els.verifyMfaBtn?.addEventListener('click', handleVerifyMfa);
  els.mfaBackBtn?.addEventListener('click', handleMfaBack);
  els.totpInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleVerifyMfa();
  });
  // Auto-submit when 6 digits are entered
  els.totpInput?.addEventListener('input', () => {
    const val = els.totpInput.value.replace(/\D/g, '').slice(0, 6);
    els.totpInput.value = val;
    if (val.length === 6) {
      handleVerifyMfa();
    }
  });

  // Wire up event listeners — Model selector
  els.modelSelect?.addEventListener('change', onModelSelectChange);
  els.selectModelBtn?.addEventListener('click', handleSelectModel);
  els.backBtn?.addEventListener('click', handleBack);

  // Wire up event listeners — Connected
  els.disconnectBtn?.addEventListener('click', handleDisconnect);

  // Load current state
  loadInitialState();

  console.log('[NYX CRM UI] ✅ Module initialized');
}
