// ============================================================
// AUTH MODULE
// ============================================================

import { $, $$ } from '../utils/dom.js';

// Show main app UI
export const showMainApp = () => {
  $('authPanel')?.classList.add('hidden');
  $('platformSelector')?.classList.add('hidden');
  // Use classList for consistency
  $$('.header, .tab-nav, .main-content, .footer')
    .forEach(e => e.classList.remove('hidden'));
};

// Show auth panel
export const showAuthPanel = () => {
  $('authPanel')?.classList.remove('hidden');
  $('platformSelector')?.classList.add('hidden');
  // Use classList for consistency
  $$('.header, .tab-nav, .subscriber-info-bar, .main-content, .footer')
    .forEach(e => e.classList.add('hidden'));
};

// Show auth error
const showAuthError = (message) => {
  const authError = $('authError');
  if (authError) {
    authError.textContent = message;
    authError.classList.remove('hidden');
  }
};

// Setup auth event listeners
export const setupAuthListeners = () => {
  const loginBtn = $('loginBtn');
  const registerBtn = $('registerBtn');
  const showRegister = $('showRegister');
  const showLogin = $('showLogin');
  const loginForm = $('loginForm');
  const registerForm = $('registerForm');
  const authError = $('authError');
  
  // Toggle forms
  showRegister?.addEventListener('click', (e) => {
    e.preventDefault();
    loginForm?.classList.add('hidden');
    registerForm?.classList.remove('hidden');
    authError?.classList.add('hidden');
  });
  
  showLogin?.addEventListener('click', (e) => {
    e.preventDefault();
    registerForm?.classList.add('hidden');
    loginForm?.classList.remove('hidden');
    authError?.classList.add('hidden');
  });
  
  // Login handler
  loginBtn?.addEventListener('click', async () => {
    const email = $('loginEmail')?.value.trim();
    const password = $('loginPassword')?.value;
    
    if (!email || !password) {
      showAuthError('Please fill in all fields');
      return;
    }
    
    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in...';
    
    try {
      await FirebaseAuth.signIn(email, password);
      location.reload();
    } catch (error) {
      showAuthError(error.message);
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign In';
    }
  });
  
  // Register handler
  registerBtn?.addEventListener('click', async () => {
    const email = $('registerEmail')?.value.trim();
    const password = $('registerPassword')?.value;
    const confirm = $('registerPasswordConfirm')?.value;
    
    if (!email || !password || !confirm) {
      showAuthError('Please fill in all fields');
      return;
    }
    if (password !== confirm) {
      showAuthError('Passwords do not match');
      return;
    }
    if (password.length < 6) {
      showAuthError('Password must be at least 6 characters');
      return;
    }
    
    registerBtn.disabled = true;
    registerBtn.textContent = 'Creating account...';
    
    try {
      await FirebaseAuth.register(email, password);
      location.reload();
    } catch (error) {
      showAuthError(error.message);
      registerBtn.disabled = false;
      registerBtn.textContent = 'Create Account';
    }
  });
  
  // Enter key support
  $('loginPassword')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') loginBtn?.click();
  });
  $('registerPasswordConfirm')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') registerBtn?.click();
  });
};

export default { showMainApp, showAuthPanel, setupAuthListeners };
