// ============================================================
// AUTO-CHAT MODULE - Thin Wrapper
// Re-exports everything from ./autochat/ for backwards compatibility
// 
// Original file was 1988 lines - now split into:
// - autochat/constants.js  - Constants & enums
// - autochat/state.js      - State management
// - autochat/ui.js         - UI render functions
// - autochat/listeners.js  - Event handlers
// - autochat/blocklist.js  - Block list management
// - autochat/workflow.js   - Main workflow logic
// - autochat/index.js      - Entry point
// ============================================================

// Re-export everything from the modular structure
export * from './autochat/index.js';

// Re-export the default export for backwards compatibility
export { default } from './autochat/index.js';
