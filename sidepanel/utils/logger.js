/**
 * Structured Logging Service
 * Centralized logging with levels and configurable output
 */

// Log levels
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4
};

// Current log level (can be changed at runtime)
let currentLogLevel = LOG_LEVELS.DEBUG;

// Whether to show timestamps
let showTimestamps = true;

// Log level colors for console
const LEVEL_STYLES = {
  DEBUG: 'color: #888; font-weight: normal',
  INFO: 'color: #3498db; font-weight: normal',
  WARN: 'color: #f39c12; font-weight: bold',
  ERROR: 'color: #e74c3c; font-weight: bold'
};

// Emoji prefixes for better visibility
const LEVEL_EMOJI = {
  DEBUG: '🔍',
  INFO: 'ℹ️',
  WARN: '⚠️',
  ERROR: '❌'
};

/**
 * Format a log message with optional timestamp and module
 */
const formatMessage = (level, module, message) => {
  const parts = [];
  
  if (showTimestamps) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour12: false });
    const ms = now.getMilliseconds().toString().padStart(3, '0');
    parts.push(`[${time}.${ms}]`);
  }
  
  parts.push(`[${level}]`);
  
  if (module) {
    parts.push(`[${module}]`);
  }
  
  parts.push(message);
  
  return parts.join(' ');
};

/**
 * Core log function
 */
const log = (level, levelName, module, message, ...args) => {
  if (level < currentLogLevel) return;
  
  const emoji = LEVEL_EMOJI[levelName];
  const style = LEVEL_STYLES[levelName];
  const formattedMsg = formatMessage(levelName, module, message);
  
  const consoleMethod = levelName === 'ERROR' ? 'error' : 
                        levelName === 'WARN' ? 'warn' : 
                        levelName === 'DEBUG' ? 'debug' : 'log';
  
  if (args.length > 0) {
    console[consoleMethod](`%c${emoji} ${formattedMsg}`, style, ...args);
  } else {
    console[consoleMethod](`%c${emoji} ${formattedMsg}`, style);
  }
};

/**
 * Create a logger instance for a specific module
 * @param {string} moduleName - Name of the module (e.g., 'AI', 'AutoChat', 'Profiles')
 * @returns {Object} Logger instance with debug, info, warn, error methods
 */
export const createLogger = (moduleName) => {
  return {
    debug: (message, ...args) => log(LOG_LEVELS.DEBUG, 'DEBUG', moduleName, message, ...args),
    info: (message, ...args) => log(LOG_LEVELS.INFO, 'INFO', moduleName, message, ...args),
    warn: (message, ...args) => log(LOG_LEVELS.WARN, 'WARN', moduleName, message, ...args),
    error: (message, ...args) => log(LOG_LEVELS.ERROR, 'ERROR', moduleName, message, ...args),
    
    // Group logging for related messages
    group: (label) => console.group(`[${moduleName}] ${label}`),
    groupEnd: () => console.groupEnd(),
    
    // Timing utilities
    time: (label) => console.time(`[${moduleName}] ${label}`),
    timeEnd: (label) => console.timeEnd(`[${moduleName}] ${label}`),
    
    // Table logging for arrays/objects
    table: (data, columns) => {
      console.log(`[${moduleName}] Data table:`);
      console.table(data, columns);
    }
  };
};

/**
 * Global logger functions (no module prefix)
 */
export const Logger = {
  debug: (message, ...args) => log(LOG_LEVELS.DEBUG, 'DEBUG', null, message, ...args),
  info: (message, ...args) => log(LOG_LEVELS.INFO, 'INFO', null, message, ...args),
  warn: (message, ...args) => log(LOG_LEVELS.WARN, 'WARN', null, message, ...args),
  error: (message, ...args) => log(LOG_LEVELS.ERROR, 'ERROR', null, message, ...args),
  
  // Configuration methods
  setLevel: (level) => {
    if (typeof level === 'string') {
      currentLogLevel = LOG_LEVELS[level.toUpperCase()] ?? LOG_LEVELS.DEBUG;
    } else {
      currentLogLevel = level;
    }
    console.log(`[Logger] Log level set to: ${Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === currentLogLevel)}`);
  },
  
  setShowTimestamps: (show) => {
    showTimestamps = show;
  },
  
  // Get current level
  getLevel: () => currentLogLevel,
  getLevelName: () => Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === currentLogLevel),
  
  // Available levels
  LEVELS: LOG_LEVELS
};

/**
 * Load log level from storage
 */
export const initLogger = async () => {
  try {
    const result = await chrome.storage.local.get(['logLevel']);
    if (result.logLevel !== undefined) {
      Logger.setLevel(result.logLevel);
    } else {
      // Default to INFO in production, DEBUG in development
      Logger.setLevel(LOG_LEVELS.INFO);
    }
  } catch (e) {
    // Default to INFO if storage fails
    currentLogLevel = LOG_LEVELS.INFO;
  }
};

/**
 * Save log level to storage
 */
export const setLogLevel = async (level) => {
  Logger.setLevel(level);
  try {
    await chrome.storage.local.set({ logLevel: currentLogLevel });
  } catch (e) {
    console.warn('Failed to save log level:', e);
  }
};

export default Logger;
