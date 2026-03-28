/**
 * Shared Sanitization Utilities
 * Centralized functions for XSS prevention and safe HTML handling
 * 
 * NOTE: Uses browser-native DOMParser instead of DOMPurify to avoid:
 *   1. Bare module specifier errors in Chrome extension ES modules
 *   2. Potential CSP issues with eval-based libraries
 */

// ============================================================
// HTML SANITIZATION - Browser-native, zero dependencies
// ============================================================

const DEFAULT_ALLOWED_TAGS = new Set([
  'b', 'i', 'em', 'strong', 'a', 'p', 'br', 'span', 'div', 'ul', 'ol', 'li'
]);

const DEFAULT_ALLOWED_ATTRS = new Set([
  'href', 'class', 'id', 'target', 'rel'
]);

const FORBIDDEN_TAGS = new Set([
  'script', 'style', 'iframe', 'form', 'input', 'object', 'embed',
  'link', 'meta', 'base', 'template', 'svg', 'math'
]);

const FORBIDDEN_ATTR_PREFIXES = ['on']; // blocks onclick, onerror, onload, etc.
const FORBIDDEN_ATTRS = new Set(['srcdoc', 'formaction', 'xlink:href']);

/**
 * Sanitize HTML content to prevent XSS attacks
 * Uses browser-native DOMParser — no external library needed
 * @param {string} html - HTML string to sanitize
 * @param {Object} options - Sanitization options
 * @param {Set|Array} options.ALLOWED_TAGS - Tags to allow
 * @param {Set|Array} options.ALLOWED_ATTR - Attributes to allow
 * @returns {string} Sanitized HTML
 */
export function sanitizeHtml(html, options = {}) {
  if (!html) return '';
  if (typeof html !== 'string') html = String(html);

  const allowedTags = options.ALLOWED_TAGS
    ? new Set(Array.isArray(options.ALLOWED_TAGS) ? options.ALLOWED_TAGS : options.ALLOWED_TAGS)
    : DEFAULT_ALLOWED_TAGS;

  const allowedAttrs = options.ALLOWED_ATTR
    ? new Set(Array.isArray(options.ALLOWED_ATTR) ? options.ALLOWED_ATTR : options.ALLOWED_ATTR)
    : DEFAULT_ALLOWED_ATTRS;

  // Parse HTML safely using DOMParser (no script execution)
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;

  if (!body) return '';

  // Walk the DOM tree and sanitize
  _sanitizeNode(body, allowedTags, allowedAttrs);

  return body.innerHTML;
}

/**
 * Recursively sanitize a DOM node and its children
 * @private
 */
function _sanitizeNode(parent, allowedTags, allowedAttrs) {
  // Process children in reverse so removals don't shift indices
  const children = Array.from(parent.childNodes);

  for (const node of children) {
    // Text nodes are always safe
    if (node.nodeType === Node.TEXT_NODE) continue;

    // Comment nodes — remove
    if (node.nodeType === Node.COMMENT_NODE) {
      parent.removeChild(node);
      continue;
    }

    // Element nodes
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tagName = node.tagName.toLowerCase();

      // Forbidden tags — remove entirely (including children)
      if (FORBIDDEN_TAGS.has(tagName)) {
        parent.removeChild(node);
        continue;
      }

      // Non-allowed tags — unwrap (keep children, remove the tag)
      if (!allowedTags.has(tagName)) {
        // Move children before removing the node
        while (node.firstChild) {
          parent.insertBefore(node.firstChild, node);
        }
        parent.removeChild(node);
        continue;
      }

      // Allowed tag — sanitize its attributes
      const attrsToRemove = [];
      for (const attr of node.attributes) {
        const attrName = attr.name.toLowerCase();

        // Check forbidden attribute prefixes (on*)
        const isForbiddenPrefix = FORBIDDEN_ATTR_PREFIXES.some(p => attrName.startsWith(p));
        if (isForbiddenPrefix || FORBIDDEN_ATTRS.has(attrName)) {
          attrsToRemove.push(attr.name);
          continue;
        }

        // Check allowed attributes
        if (!allowedAttrs.has(attrName)) {
          attrsToRemove.push(attr.name);
          continue;
        }

        // Sanitize href/src values — block javascript: protocol
        if (attrName === 'href' || attrName === 'src' || attrName === 'action') {
          const val = attr.value.trim().toLowerCase();
          if (val.startsWith('javascript:') || val.startsWith('data:') || val.startsWith('vbscript:')) {
            attrsToRemove.push(attr.name);
          }
        }
      }

      attrsToRemove.forEach(a => node.removeAttribute(a));

      // Force target="_blank" and rel="noopener" on links
      if (tagName === 'a') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }

      // Recurse into children
      _sanitizeNode(node, allowedTags, allowedAttrs);
    }
  }
}

// ============================================================
// HTML ESCAPING - For plain text insertion
// ============================================================

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

// ============================================================
// SAFE DOM HELPERS
// ============================================================

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
 * @param {Object} options - Sanitization options
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

// ============================================================
// URL & DATA SANITIZATION
// ============================================================

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
