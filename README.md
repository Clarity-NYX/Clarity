# Clarity Notes

A smart productivity Chrome extension for OnlyFans content creators. Features AI-powered response generation, conversation tracking, subscriber notes, and script management.

## Features

- 🤖 **AI Response Generation** - Generate contextual responses using Grok AI
- 💬 **Chat Integration** - Real-time chat extraction from OnlyFans
- 📝 **Subscriber Notes** - Save and auto-extract subscriber information
- 📋 **Script Management** - Follow conversation scripts with progress tracking
- 🔐 **Firebase Auth** - Secure user authentication

## Project Structure

```
├── manifest.json          # Chrome extension manifest
├── background.js          # Service worker (API calls, message handling)
├── content.js             # Content script (chat extraction)
├── sidepanel/
│   ├── sidepanel.html     # Side panel UI
│   ├── sidepanel.css      # Styles
│   ├── sidepanel.js       # Main application logic
│   └── firebase.js        # Firebase authentication
├── styles/
│   └── inject.css         # Injected styles for OnlyFans
└── icons/                 # Extension icons
```

## Architecture

### background.js
- `CONFIG` - API configuration constants
- `TONES` - Response tone definitions
- `STAGE_GOALS` - Script stage objectives
- `API` - Grok API service methods
- `handlers` - Message type handlers

### sidepanel.js
- `state` - Centralized state management
- `el` - DOM element references
- Auth, Settings, Scripts, Chat, AI, Tabs, Notes modules
- Clean separation of concerns

### content.js
- `SELECTORS` - DOM selector constants
- Message extraction and observation
- URL change detection
- Auto-sync with sidepanel

### firebase.js
- Lightweight REST API authentication
- Token refresh handling
- Chrome storage persistence

## Installation

1. Clone this repository
2. Open `chrome://extensions/` in Chrome
3. Enable "Developer mode"
4. Click "Load unpacked" and select this folder
5. Navigate to OnlyFans to use the extension

## API Configuration

The Grok API key is configured in `background.js`:

```javascript
const CONFIG = {
  API_KEY: 'your-api-key-here',
  API_URL: 'https://api.x.ai/v1/chat/completions',
  MODEL: 'grok-4-latest'
};
```

## Usage

1. Open any chat on OnlyFans
2. Click the extension icon to open the side panel
3. Chat messages will auto-load
4. Use "Generate Response" for AI suggestions
5. Use Notes tab to save subscriber info
6. Track progress with script stages

## Version

1.0.0
