/**
 * Shared Sanitization Utilities
 * Centralized functions for XSS prevention and safe HTML handling
 */

import DOMPurify from 'dompurify';

/**
 * Sanitize HTML content to prevent XSS attacks
 * @param {string} html - HTML string to sanitize
 * @param {Object} options - DOMPurify options
 * @returns {string} Sanitized HTML
 */
export function sanitizeHtml(html, options = {}) {
  if (!html) return '';
  
  const defaultOptions = {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'span', 'div', 'ul', 'ol', 'li'],
    ALLOWED_ATTR: ['href', 'class', 'id', 'target', 'rel'],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'input'],
    FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover']
  };

  return DOMPurify.sanitize(html, { ...defaultOptions, ...options });
}

/**
 * Escape HTML entities to prevent XSS when inserting text
 * Use this for simple text content that should not contain HTML
 * @param {string} text - Text to escape
 * @returns {string} Escaped text safe for innerHTML
 */
export function escapeHtml(text) {
  if (!text) return '';
  if (typeof text !== 'string') {
    text = String(text);
  }
  
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Escape HTML using a map for faster processing
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
export function escapeHtmlFast(text) {
  if (!text) return '';
  if (typeof text !== 'string') {
    text = String(text);
  }

  const escapeMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
    '/': '&#x2F;',
    '`': '&#x60;',
    '=': '&#x3D;'
  };

  return text.replace(/[&<>"'`=/]/g, char => escapeMap[char]);
}

/**
 * Create a safe text element
 * @param {string} tagName - HTML tag name
 * @param {string} text - Text content
 * @param {Object} attributes - Element attributes
 * @returns {HTMLElement} Safe DOM element
 */
export function createSafeElement(tagName, text, attributes = {}) {
  const element = document.createElement(tagName);
  element.textContent = text;
  
  for (const [key, value] of Object.entries(attributes)) {
    // Only allow safe attributes
    if (!key.startsWith('on') && key !== 'srcdoc') {
      element.setAttribute(key, value);
    }
  }
  
  return element;
}

/**
 * Safely set innerHTML with sanitization
 * @param {HTMLElement} element - Target element
 * @param {string} html - HTML content
 * @param {Object} options - DOMPurify options
 */
export function setSafeInnerHTML(element, html, options = {}) {
  if (element && html !== undefined) {
    element.innerHTML = sanitizeHtml(html, options);
  }
}

/**
 * Safely create HTML from template with escaped values
 * @param {string} template - Template string with {key} placeholders
 * @param {Object} values - Values to interpolate (will be escaped)
 * @returns {string} Safe HTML string
 */
export function safeTemplate(template, values) {
  if (!template) return '';
  
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = values[key];
    return value !== undefined ? escapeHtmlFast(value) : match;
  });
}

/**
 * Sanitize URL to prevent javascript: protocol attacks
 * @param {string} url - URL to sanitize
 * @returns {string} Safe URL or empty string
 */
export function sanitizeUrl(url) {
  if (!url) return '';
  
  const sanitized = url.trim().toLowerCase();
  
  // Block dangerous protocols
  if (sanitized.startsWith('javascript:') || 
      sanitized.startsWith('data:') || 
      sanitized.startsWith('vbscript:')) {
    return '';
  }
  
  return url;
}

/**
 * Validate and sanitize profile/user data
 * @param {Object} data - User data object
 * @returns {Object} Sanitized data object
 */
export function sanitizeUserData(data) {
  if (!data || typeof data !== 'object') return {};
  
  const sanitized = {};
  
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      sanitized[key] = escapeHtmlFast(value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map(item => 
        typeof item === 'string' ? escapeHtmlFast(item) : item
      );
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeUserData(value);
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

// Export default object for non-module usage
export default {
  sanitizeHtml,
  escapeHtml,
  escapeHtmlFast,
  createSafeElement,
  setSafeInnerHTML,
  safeTemplate,
  sanitizeUrl,
  sanitizeUserData
};
