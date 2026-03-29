// ============================================================
// CREDITS MODULE - Dynamic usage-based tracking
// ============================================================

import Store from '../state/store.js';
import { $ } from '../utils/dom.js';
import { showNotification } from '../utils/notify.js';
import API, { apiRequest } from '../utils/api.js';

// Credit costs are now dynamic (actual usage * 4)
// These are just fallback estimates for UI display before API response
const ESTIMATED_CREDIT_COSTS = {
  generate: 3,    // ~3-10 credits depending on token usage
  extract: 2,     // ~1-5 credits
  quickAction: 1  // ~1-2 credits
};

// For backwards compatibility
const CREDIT_COSTS = ESTIMATED_CREDIT_COSTS;

// Track if user has own API key (hides credits display)
let usingOwnApiKey = false;

// Check if user has their own API key
// NOTE: /api/settings endpoint not yet implemented — skip network call,
// always show credits display. When settings endpoint is added, restore the fetch.
export const checkOwnApiKey = async () => {
  usingOwnApiKey = false;
  Store.set('usingOwnApiKey', false);
  showCreditsDisplay();
  return false;
};

// Hide the credits display (when using own API key)
export const hideCreditsDisplay = () => {
  const creditsBtn = $('creditsBtn');
  if (creditsBtn) {
    creditsBtn.style.display = 'none';
  }
  console.log('[Credits] Hidden - using own API key');
};

// Show the credits display (when using credits)
export const showCreditsDisplay = () => {
  const creditsBtn = $('creditsBtn');
  if (creditsBtn) {
    creditsBtn.style.display = 'flex';
  }
};

// Load user credits from API
export const loadCredits = async () => {
  try {
    // First check if user has own API key
    const hasOwnKey = await checkOwnApiKey();
    if (hasOwnKey) {
      // Don't load credits if using own key
      return 0;
    }
    
    const response = await API.getCredits();
    
    if (response && response.credits !== undefined) {
      Store.set('credits', response.credits);
      Store.set('plan', response.plan || 'free');
      updateCreditsDisplay();
      
      // One-time reset: Check if we need to reset old usage data (wrong pricing)
      const resetDone = await chrome.storage.local.get(['usageResetV2']);
      if (!resetDone.usageResetV2) {
        console.log('📊 Resetting usage data (one-time fix for pricing)...');
        try {
          await API.resetUsage();
          await chrome.storage.local.set({ usageResetV2: true });
          console.log('✅ Usage data reset successfully');
        } catch (e) {
          console.error('Failed to reset usage:', e);
        }
      }
      
      // Load usage
      loadTotalUsage();
      
      return response.credits;
    }
  } catch (error) {
    console.error('Failed to load credits:', error);
  }
  return 0;
};

// Load total usage from API
export const loadTotalUsage = async () => {
  try {
    const response = await API.getTotalUsage();
    
    if (response && response.success && response.total) {
      const estimatedCost = response.total.estimatedCost || 0;
      Store.set('totalUsageCost', estimatedCost);
      updateUsageDisplay(estimatedCost);
    }
  } catch (error) {
    console.error('Failed to load usage:', error);
  }
};

// Update usage display (shows actual API cost in dollars)
export const updateUsageDisplay = (cost) => {
  const usageDisplay = $('usageDisplay');
  if (!usageDisplay) return;
  
  // Format as currency
  usageDisplay.textContent = '$' + cost.toFixed(2);
  usageDisplay.title = `Total API cost: $${cost.toFixed(4)}`;
};

// Update credits display in header
export const updateCreditsDisplay = () => {
  const credits = Store.get('credits') || 0;
  
  // Format number with commas
  const formatted = credits.toLocaleString();
  
  // Try both $ helper and direct getElementById for reliability
  const creditsDisplay = $('creditsDisplay') || document.getElementById('creditsDisplay');
  const modalCreditsBalance = $('modalCreditsBalance') || document.getElementById('modalCreditsBalance');
  
  console.log('[Credits] 💰 Updating display:', formatted, 'Element found:', !!creditsDisplay);
  
  if (creditsDisplay) {
    creditsDisplay.textContent = formatted;
    // Force repaint for visibility
    creditsDisplay.style.display = 'none';
    creditsDisplay.offsetHeight; // Trigger reflow
    creditsDisplay.style.display = '';
  }
  
  if (modalCreditsBalance) {
    modalCreditsBalance.textContent = `${formatted} credits`;
  }
};

// Check if user has enough credits
export const hasEnoughCredits = (action) => {
  const credits = Store.get('credits') || 0;
  const cost = CREDIT_COSTS[action] || 0;
  return credits >= cost;
};

// Deduct credits (called after successful action)
export const deductCredits = async (action) => {
  const cost = CREDIT_COSTS[action] || 0;
  if (cost === 0) return true;
  
  const currentCredits = Store.get('credits') || 0;
  
  if (currentCredits < cost) {
    showNotification('Not enough credits! Click 🪙 to buy more.');
    openPackagesModal();
    return false;
  }
  
  // Optimistically update UI
  const newCredits = currentCredits - cost;
  Store.set('credits', newCredits);
  updateCreditsDisplay();
  
  return true;
};

// Get credit cost for an action
export const getCreditCost = (action) => {
  return CREDIT_COSTS[action] || 0;
};

// Open packages modal
export const openPackagesModal = () => {
  const modal = $('packagesModal');
  if (modal) {
    updateCreditsDisplay(); // Refresh balance in modal
    modal.classList.remove('hidden');
  }
};

// Close packages modal
export const closePackagesModal = () => {
  const modal = $('packagesModal');
  if (modal) {
    modal.classList.add('hidden');
  }
};

// Handle package purchase (mock for now, will integrate Stripe later)
export const purchasePackage = async (packageId) => {
  if (packageId === 'custom') {
    // Open contact form or email
    window.open('mailto:support@claritynotes.app?subject=Custom%20Package%20Inquiry', '_blank');
    showNotification('Opening email for custom package inquiry');
    return;
  }
  
  try {
    // For now, use mock purchase endpoint
    const response = await API.mockPurchase(packageId);
    
    if (response.success) {
      Store.set('credits', response.credits);
      updateCreditsDisplay();
      showNotification(response.message || 'Credits added!');
      closePackagesModal();
    } else {
      showNotification(response.error || 'Purchase failed');
    }
  } catch (error) {
    console.error('Purchase error:', error);
    showNotification('Purchase failed. Please try again.');
  }
};

// Update credits from API response (called after any API call that deducts credits)
// Set showToast=true to display a notification with usage info
export const updateCreditsFromResponse = (response, showToast = false) => {
  console.log('[Credits] updateCreditsFromResponse called:', { response, showToast });
  
  if (!response) {
    console.log('[Credits] No response object - skipping');
    return;
  }
  
  // Debug: log what's in the response
  console.log('[Credits] Response keys:', Object.keys(response));
  console.log('[Credits] creditsUsed:', response.creditsUsed, 'creditsRemaining:', response.creditsRemaining);
  
  // Update credits if provided in response
  if (typeof response.creditsRemaining === 'number' && response.creditsRemaining >= 0) {
    Store.set('credits', response.creditsRemaining);
    updateCreditsDisplay();
    console.log(`💳 Credits updated: ${response.creditsRemaining} remaining`);
  } else if (response.creditsRemaining === -1) {
    // Unlimited credits
    console.log(`💳 Unlimited credits detected`);
  }
  
  // Log and optionally toast credits used
  if (response.creditsUsed !== undefined && response.creditsUsed !== null) {
    console.log(`💳 Action cost: ${response.creditsUsed} credits`);
    
    // Show toast notification with usage
    if (showToast) {
      const remaining = Store.get('credits') || 0;
      const remainingText = response.creditsRemaining === -1 ? 'unlimited' : remaining.toLocaleString();
      showNotification(`💳 Used ${response.creditsUsed} credits (${remainingText} left)`);
    }
  } else {
    console.log('[Credits] No creditsUsed in response');
  }
  
  // Check if credits are low (below 100) - show warning
  const credits = Store.get('credits') || 0;
  if (credits > 0 && credits < 100) {
    console.warn('⚠️ Credits running low:', credits);
    showNotification('⚠️ Low credits! Open Billing to buy more.');
  } else if (credits === 0) {
    showNotification('❌ Out of credits! Open Billing to continue.');
  }
};

// Show usage toast after action (convenience wrapper)
export const showUsageToast = (creditsUsed, actionName = '') => {
  const remaining = Store.get('credits') || 0;
  const prefix = actionName ? `${actionName}: ` : '';
  showNotification(`💳 ${prefix}${creditsUsed} credits used (${remaining.toLocaleString()} left)`);
};

// Check if credits are sufficient (preemptive check before API call)
export const checkCreditsBeforeAction = () => {
  const credits = Store.get('credits') || 0;
  if (credits <= 0) {
    showNotification('Out of credits! Open Billing to purchase more.');
    openPackagesModal();
    return false;
  }
  return true;
};

// Setup event listeners
export const setupCreditsListeners = () => {
  // Credits button click disabled for now - will add purchasing later
  // $('creditsBtn')?.addEventListener('click', openPackagesModal);
  
  // Billing menu button disabled for now - will add purchasing later
  // $('billingMenuBtn')?.addEventListener('click', () => {
  //   openPackagesModal();
  //   // Close the profile menu if open
  //   $('profileMenu')?.classList.add('hidden');
  // });
  
  // Close packages modal
  $('closePackagesModalBtn')?.addEventListener('click', closePackagesModal);
  
  // Package buy buttons
  document.querySelectorAll('.package-buy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const packageId = e.target.dataset.package;
      purchasePackage(packageId);
    });
  });
  
  // Close modal on backdrop click
  $('packagesModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'packagesModal') {
      closePackagesModal();
    }
  });
};

export default {
  loadCredits,
  loadTotalUsage,
  updateCreditsDisplay,
  updateUsageDisplay,
  updateCreditsFromResponse,
  showUsageToast,
  checkCreditsBeforeAction,
  hasEnoughCredits,
  deductCredits,
  getCreditCost,
  openPackagesModal,
  closePackagesModal,
  purchasePackage,
  setupCreditsListeners,
  CREDIT_COSTS,
  ESTIMATED_CREDIT_COSTS
};
