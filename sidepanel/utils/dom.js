// ============================================================
// DOM UTILITIES
// ============================================================

// Get element by ID
export const $ = (id) => document.getElementById(id);

// Query selector all
export const $$ = (selector) => document.querySelectorAll(selector);

// Query selector
export const qs = (selector) => document.querySelector(selector);

// Escape HTML to prevent XSS
export const escapeHtml = (text) => {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
};

// Toggle class
export const toggleClass = (el, className, force) => {
  if (typeof el === 'string') el = $(el);
  el?.classList.toggle(className, force);
};

// Show element
export const show = (el) => {
  if (typeof el === 'string') el = $(el);
  el?.classList.remove('hidden');
};

// Hide element
export const hide = (el) => {
  if (typeof el === 'string') el = $(el);
  el?.classList.add('hidden');
};

// Create element with attributes
export const createElement = (tag, attrs = {}, children = []) => {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (key === 'className') el.className = value;
    else if (key === 'textContent') el.textContent = value;
    else if (key === 'innerHTML') el.innerHTML = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value);
  });
  children.forEach(child => {
    if (typeof child === 'string') el.appendChild(document.createTextNode(child));
    else el.appendChild(child);
  });
  return el;
};

export default { $, $$, qs, escapeHtml, toggleClass, show, hide, createElement };
