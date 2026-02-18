// ============================================================
// NOTIFICATION UTILITIES
// ============================================================

import { $, show, hide } from './dom.js';

// Show toast notification
export const showNotification = (message, duration = 2000) => {
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: #4caf50; color: white; padding: 10px 20px;
    border-radius: 8px; font-size: 14px; z-index: 1000;
    animation: fadeIn 0.3s ease;
  `;
  notification.textContent = message;
  document.body.appendChild(notification);
  setTimeout(() => notification.remove(), duration);
};

// Show error message in UI
export const showError = (message) => {
  const errorMessage = $('errorMessage');
  const errorState = $('errorState');
  if (errorMessage) errorMessage.textContent = message;
  show(errorState);
};

// Hide error message
export const hideError = () => {
  hide('errorState');
};

// Show loading state
export const showLoading = (isLoading) => {
  const loadingState = $('loadingState');
  if (loadingState) {
    loadingState.classList.toggle('hidden', !isLoading);
  }
};

export default { showNotification, showError, hideError, showLoading };
