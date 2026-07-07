// ============================================================
// CONTENT SCRIPT - Main entry point
// Clean, modular structure for OnlyFans content script
// ============================================================

import { scrapeChatList, scrapeChatListWithTimestamps } from './onlyfans/chat-list-extractor.js';
import { startChatListObserver, startChatListPolling, startPageWatching } from './onlyfans/dom-observer.js';
import { sendMessageToChat, sendImageToChat, setMediaPrice, loadTypingSpeed, setupTypingSpeedListener, findChatInput, findSendButton } from './onlyfans/message-sender.js';
import { 
  extractAllMessages, 
  autoLoadChat, 
  scrapeProfileStats,
  isOnProfilePage,
  fullScanChat,
  cleanupScanChat,
  setHighQualityCapture,
  extractDraftState,
  startDraftObserver,
  stopDraftObserver,
  resetForNewChat,
  fetchVideoUrlsForChat
} from './onlyfans/message-extractor.js';
// Vault scanner functionality removed - media sending no longer supported

(function() {
  'use strict';
  
  // ── Cleanup scan lock: prevents autoLoadChat/observer from interfering ──
  let cleanupScanActive = false;

  // ============================================================
  // SEND LOCK — blocks page interaction during CRM operations
  // ============================================================
  // When the CRM bridge is executing a send (text, image, price, etc.),
  // this overlay prevents the chatter from switching chats or clicking
  // anything that would interrupt the in-progress operation.
  
  let _sendLockEl = null;
  let _sendLockTimeout = null;
  let _bridgeLockActive = false; // True when CRM bridge owns the lock (SEND_LOCK msg)
  const SEND_LOCK_MAX_MS = 60_000; // Safety: auto-unlock after 60s

  function showSendLock(statusText = 'Sending…') {
    if (_sendLockEl) {
      // Already showing — just update the text
      const label = _sendLockEl.querySelector('.clarity-send-lock-label');
      if (label) label.textContent = statusText;
      return;
    }

    _sendLockEl = document.createElement('div');
    _sendLockEl.className = 'clarity-send-lock-overlay';
    _sendLockEl.innerHTML = `
      <div class="clarity-send-lock-card">
        <div class="clarity-send-lock-spinner"></div>
        <div class="clarity-send-lock-label">${statusText}</div>
        <div class="clarity-send-lock-hint">Please wait — do not switch chats</div>
      </div>
    `;

    // Inject styles if not already present
    if (!document.getElementById('clarity-send-lock-styles')) {
      const style = document.createElement('style');
      style.id = 'clarity-send-lock-styles';
      style.textContent = `
        .clarity-send-lock-overlay {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          background: rgba(0, 0, 0, 0.45);
          backdrop-filter: blur(2px);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: not-allowed;
          animation: clarity-lock-fadein 0.2s ease;
        }
        @keyframes clarity-lock-fadein {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .clarity-send-lock-card {
          background: linear-gradient(135deg, #1a1a2e, #16213e);
          border: 1px solid rgba(100, 180, 255, 0.25);
          border-radius: 16px;
          padding: 28px 40px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 14px;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5), 0 0 40px rgba(100, 180, 255, 0.1);
          pointer-events: none;
        }
        .clarity-send-lock-spinner {
          width: 32px; height: 32px;
          border: 3px solid rgba(255,255,255,0.15);
          border-top-color: #64b4ff;
          border-radius: 50%;
          animation: clarity-lock-spin 0.8s linear infinite;
        }
        @keyframes clarity-lock-spin {
          to { transform: rotate(360deg); }
        }
        .clarity-send-lock-label {
          color: #fff;
          font-size: 15px;
          font-weight: 600;
          letter-spacing: 0.02em;
        }
        .clarity-send-lock-hint {
          color: rgba(255,255,255,0.5);
          font-size: 12px;
          font-weight: 400;
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(_sendLockEl);

    // Block all click/mousedown/touchstart events on the page
    _sendLockEl.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); }, true);
    _sendLockEl.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); }, true);
    _sendLockEl.addEventListener('touchstart', e => { e.stopPropagation(); e.preventDefault(); }, true);

    // Safety timeout
    if (_sendLockTimeout) clearTimeout(_sendLockTimeout);
    _sendLockTimeout = setTimeout(() => {
      console.warn('[Clarity] ⚠️ Send lock safety timeout — auto-unlocking after', SEND_LOCK_MAX_MS / 1000, 's');
      hideSendLock();
    }, SEND_LOCK_MAX_MS);

    console.log('[Clarity] 🔒 Send lock ON:', statusText);
  }

  /** Hide the send lock overlay.
   *  @param {boolean} force — if true, ignores _bridgeLockActive (used by SEND_UNLOCK) */
  function hideSendLock(force = false) {
    // If the bridge owns the lock, only SEND_UNLOCK (force=true) can release it.
    // This prevents withSendLock's finally block from removing the overlay mid-sequence.
    if (_bridgeLockActive && !force) {
      console.log('[Clarity] 🔒 hideSendLock skipped — bridge lock active');
      return;
    }
    if (_sendLockTimeout) { clearTimeout(_sendLockTimeout); _sendLockTimeout = null; }
    if (_sendLockEl) {
      _sendLockEl.remove();
      _sendLockEl = null;
      _bridgeLockActive = false;
      console.log('[Clarity] 🔓 Send lock OFF');
    }
  }

  /** Wrap an async operation in the send lock overlay.
   *  Shows the lock, runs the operation, hides the lock, returns the result.
   *  If the operation throws, the lock is still released. */
  async function withSendLock(statusText, asyncFn) {
    showSendLock(statusText);
    try {
      return await asyncFn();
    } finally {
      hideSendLock();
    }
  }

  // ============================================================
  // INITIALIZATION
  // ============================================================
  
  function init() {
    console.log('[Clarity] Content script loaded');
    setupMessageListener();
    startWatching();
    
    // Load typing speed setting
    loadTypingSpeed();
    setupTypingSpeedListener();
    
    // Start chat list monitoring for auto-chat push updates
    // Observer is PRIMARY — polling only starts as fallback if observer can't attach
    if (window.location.href.includes('onlyfans.com')) {
      setTimeout(() => {
        startChatListObserver();
        // Polling will only start if observer fails to attach (see dom-observer.js)
        // Give observer 3 seconds to find its container before starting fallback
        setTimeout(() => {
          startChatListPolling(); // No-ops if observer is already active
        }, 3000);
      }, 2000);
    }
    
    // Vault scanner functionality removed
  }
  
  // ============================================================
  // MESSAGE LISTENER
  // ============================================================
  
  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'GET_MESSAGES') {
        if (!isOnChatPage()) {
          sendChatMessages([]);
          sendResponse({ success: false, error: 'Not on a chat page' });
          return true;
        }
        
        const extracted = extractAllMessages();
        sendChatMessages(extracted);
        sendResponse({ success: true, count: extracted.length });
        return true;
      }
      
      // Handle chat list scraping request — use timestamp version for CRM sync
      if (message.type === 'GET_CHAT_LIST') {
        console.log('[Content] GET_CHAT_LIST requested');
        const result = scrapeChatListWithTimestamps();
        sendResponse(result);
        return true;
      }
      
      // Handle chat list with timestamps for auto-chat
      if (message.type === 'GET_CHAT_LIST_WITH_TIMESTAMPS') {
        console.log('[Content] GET_CHAT_LIST_WITH_TIMESTAMPS requested');
        const result = scrapeChatListWithTimestamps();
        sendResponse(result);
        return true;
      }
      
      // ── SEND LOCK / UNLOCK — controlled by the CRM bridge for multi-step sequences ──
      // Bridge sends SEND_LOCK before starting a command (e.g. SEND_MEDIA → SET_PRICE → TRIGGER_SEND)
      // and SEND_UNLOCK after the entire sequence completes. The _bridgeLockActive flag prevents
      // individual withSendLock calls from prematurely removing the overlay mid-sequence.
      if (message.type === 'SEND_LOCK') {
        _bridgeLockActive = true;
        showSendLock(message.statusText || 'Processing CRM command…');
        sendResponse({ success: true });
        return true;
      }
      if (message.type === 'SEND_UNLOCK') {
        hideSendLock(true); // force=true bypasses _bridgeLockActive check
        sendResponse({ success: true });
        return true;
      }

      // Handle auto-send message request
      // When skipInjection is true (set by CRM bridge), text is already in the compose box
      // from live typing — sendMessageToChat will only click the send button, no re-injection.
      if (message.type === 'SEND_MESSAGE') {
        const skipInjection = !!message.skipInjection;
        console.log(`[Clarity] Auto-send message requested (skipInjection=${skipInjection})`);
        withSendLock('Sending message…', () => sendMessageToChat(message.text, { skipInjection }))
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // Keep channel open for async response
      }
      
      // Handle image sending request (for OnlyFans)
      if (message.type === 'SEND_IMAGE') {
        const autoSend = message.autoSend !== undefined ? message.autoSend : true;
        console.log('[Clarity] 📸 Image send requested', autoSend ? '' : '(stage only)');
        sendImageToChat(message.imageUrl, message.caption, message.price || 0, autoSend)
          .then(result => {
            console.log('[Clarity] 📸 Image send result:', result);
            sendResponse(result);
          })
          .catch(err => {
            console.error('[Clarity] 📸 Image send error:', err);
            sendResponse({ success: false, error: err.message });
          });
        return true; // Keep channel open for async response
      }

      // Handle CRM media send — bridge routes SEND_MEDIA commands here.
      // Downloads the image from CRM's permanent Firebase Storage URL and
      // injects it into the OF chat via drag & drop (reuses sendImageToChat).
      if (message.type === 'CRM_SEND_MEDIA') {
        const url = message.downloadURL || message.imageUrl || '';
        const autoSend = message.autoSend !== undefined ? message.autoSend : true;
        console.log(`[Clarity] 📷 CRM_SEND_MEDIA: injecting media into OF chat (autoSend=${autoSend})`, url.substring(0, 80));
        if (!url) {
          sendResponse({ success: false, error: 'No downloadURL provided' });
          return true;
        }
        sendImageToChat(url, message.caption || '', message.price || 0, autoSend)
          .then(result => {
            console.log('[Clarity] 📷 CRM_SEND_MEDIA result:', result);
            sendResponse(result);
          })
          .catch(err => {
            console.error('[Clarity] 📷 CRM_SEND_MEDIA error:', err);
            sendResponse({ success: false, error: err.message });
          });
        return true; // Keep channel open for async response
      }
      
      // Handle profile stats scraping request
      if (message.type === 'SCRAPE_PROFILE_STATS') {
        console.log('[Clarity] Scraping profile stats...');
        
        // Wait a bit for page to fully load
        setTimeout(() => {
          const stats = scrapeProfileStats();
          console.log('[Clarity] Scraped stats:', stats);
          sendResponse({ success: true, stats });
        }, 1500);
        
        return true; // Keep channel open for async response
      }
      
      // ============================================================
      // CHAT READINESS CHECKS (for reliable auto-chat sending)
      // ============================================================
      
      // Check if chat page is fully loaded and ready
      if (message.type === 'IS_CHAT_READY') {
        const isReady = isChatFullyLoaded();
        const currentUrl = window.location.href;
        console.log(`[Clarity] IS_CHAT_READY check: ${isReady ? '✅ Ready' : '⏳ Not ready'} — URL: ${currentUrl}`);
        sendResponse({ ready: isReady, url: currentUrl });
        return true;
      }
      
      // Handle CRM open chat request — scroll to bottom first, then extract messages
      if (message.type === 'CRM_OPEN_CHAT') {
        console.log('[Clarity] 📂 CRM_OPEN_CHAT: Scrolling to bottom + extracting messages for CRM sync...');
        
        (async () => {
          try {
            // Step 0: Check if fan is unsubscribed (no message input, "subscribe to resume" alert shown)
            const subscribeAlert = document.querySelector('.chat-footer__alert');
            const notSubscribed = !!(subscribeAlert && subscribeAlert.textContent && subscribeAlert.textContent.toLowerCase().includes('subscribe'));
            if (notSubscribed) {
              console.log('[Clarity] 📂 ⚠️ Fan is NOT subscribed — "subscribe to resume messaging" alert detected');
            }

            // Step 1: Scroll chat container to the very bottom so OF renders latest messages
            const chatContainer = document.querySelector(
              '.b-chat__messages-wrapper, .b-chat__content, [class*="chat__messages"], .m-native-custom-scrollbar'
            );
            if (chatContainer) {
              chatContainer.scrollTop = chatContainer.scrollHeight;
              console.log('[Clarity] 📂 Scrolled chat to bottom');
            }
            
            // Step 2: Wait for OF's virtualized list to render the latest messages
            await new Promise(r => setTimeout(r, 700));
            
            // Step 3: Scroll again (OF may have loaded more content)
            if (chatContainer) {
              chatContainer.scrollTop = chatContainer.scrollHeight;
            }
            await new Promise(r => setTimeout(r, 250));
            
            // Step 4: Extract all messages now visible in the DOM
            const extracted = extractAllMessages();
            console.log(`[Clarity] 📂 Extracted ${extracted.length} messages for CRM`);
            sendResponse({ success: true, messages: extracted, count: extracted.length, notSubscribed });
          } catch (err) {
            console.error('[Clarity] 📂 CRM_OPEN_CHAT error:', err);
            sendResponse({ success: false, messages: [], error: err.message });
          }
        })();
        
        return true; // Keep channel open for async response
      }

      // Handle full chat scan — scrolls through entire chat history, captures all messages + media
      if (message.type === 'CRM_FULL_SCAN') {
        console.log('[Clarity] 🔍 CRM_FULL_SCAN: Starting full chat scan (high-quality capture ON)...');
        
        (async () => {
          try {
            // Enable high-quality image capture (400px max instead of 120px)
            setHighQualityCapture(true);
            
            const allMessages = await fullScanChat((collected, phase) => {
              // Report progress back to background script
              chrome.runtime.sendMessage({
                type: 'FULL_SCAN_PROGRESS',
                collected,
                phase,
              }).catch(() => {});
            });
            
            // Restore normal capture quality
            setHighQualityCapture(false);
            
            console.log(`[Clarity] 🔍 Full scan done: ${allMessages.length} messages (high-quality)`);
            sendResponse({ success: true, messages: allMessages, count: allMessages.length });
          } catch (err) {
            // Always restore normal capture quality even on error
            setHighQualityCapture(false);
            console.error('[Clarity] 🔍 CRM_FULL_SCAN error:', err);
            sendResponse({ success: false, messages: [], error: err.message });
          }
        })();
        
        return true; // Keep channel open for async response
      }

      // Handle cleanup scan — scroll to TOP of chat, wait until fully loaded, scrape all in one pass
      // NOTE: This uses fire-and-forget pattern because Chrome MV3 has a hard ~5 min
      // timeout on sendMessage channels. Long chats take 10+ min to scroll through.
      // We respond immediately with "started", then send results via a separate message.
      if (message.type === 'CRM_CLEANUP_SCAN') {
        console.log('[Clarity] 🧹 CRM_CLEANUP_SCAN: Starting cleanup scan (scroll to top, scrape all)...');
        
        // ── LOCK: prevent autoLoadChat from interfering with our scroll operations ──
        cleanupScanActive = true;
        
        // Respond IMMEDIATELY so the message channel doesn't time out
        sendResponse({ success: true, started: true });
        
        // Run the scan in the background and send results when done
        (async () => {
          try {
            // Enable high-quality image capture for CRM viewing
            setHighQualityCapture(true);
            
            const allMessages = await cleanupScanChat((progress) => {
              // Report progress back to background script
              chrome.runtime.sendMessage({
                type: 'CLEANUP_SCAN_PROGRESS',
                phase: progress.phase,
                messagesFound: progress.messagesFound,
                scrollTop: progress.scrollTop,
              }).catch(() => {});
            });
            
            // Restore normal capture quality
            setHighQualityCapture(false);
            
            console.log(`[Clarity] 🧹 Cleanup scan done: ${allMessages.length} messages`);
            
            // ── Send results with retry + fallback for large payloads ──
            // For chats with many media messages, the base64 thumbnails can make
            // the payload 10-30MB+. If sendMessage fails, retry WITHOUT thumbnails.
            let sendSuccess = false;
            
            // Attempt 1: send full payload (with thumbnails)
            try {
              await chrome.runtime.sendMessage({
                type: 'CLEANUP_SCAN_COMPLETE',
                success: true,
                messages: allMessages,
                count: allMessages.length,
              });
              sendSuccess = true;
              console.log(`[Clarity] 🧹 CLEANUP_SCAN_COMPLETE sent (full payload, ${allMessages.length} msgs)`);
            } catch (sendErr) {
              console.warn(`[Clarity] 🧹 Full payload send failed: ${sendErr.message} — retrying without thumbnails...`);
            }
            
            // Attempt 2: strip thumbnails to reduce payload size
            if (!sendSuccess) {
              try {
                const lightMessages = allMessages.map(m => ({
                  ...m,
                  mediaThumbnail: null, // Strip base64 thumbnails (major size reduction)
                }));
                await chrome.runtime.sendMessage({
                  type: 'CLEANUP_SCAN_COMPLETE',
                  success: true,
                  messages: lightMessages,
                  count: lightMessages.length,
                  thumbnailsStripped: true,
                });
                sendSuccess = true;
                console.log(`[Clarity] 🧹 CLEANUP_SCAN_COMPLETE sent (light payload, thumbnails stripped)`);
              } catch (sendErr2) {
                console.error(`[Clarity] 🧹 Light payload also failed: ${sendErr2.message}`);
              }
            }
            
            // Attempt 3: send in chunks if still failing
            if (!sendSuccess && allMessages.length > 0) {
              console.log(`[Clarity] 🧹 Attempting chunked send (${allMessages.length} messages)...`);
              const CHUNK_SIZE = 100;
              const chunks = [];
              for (let i = 0; i < allMessages.length; i += CHUNK_SIZE) {
                chunks.push(allMessages.slice(i, i + CHUNK_SIZE).map(m => ({
                  ...m,
                  mediaThumbnail: null,
                })));
              }
              
              let allChunksSent = true;
              for (let c = 0; c < chunks.length; c++) {
                try {
                  await chrome.runtime.sendMessage({
                    type: 'CLEANUP_SCAN_CHUNK',
                    chunkIndex: c,
                    totalChunks: chunks.length,
                    messages: chunks[c],
                  });
                } catch (chunkErr) {
                  console.error(`[Clarity] 🧹 Chunk ${c + 1}/${chunks.length} failed: ${chunkErr.message}`);
                  allChunksSent = false;
                  break;
                }
              }
              
              if (allChunksSent) {
                // Send final completion signal
                try {
                  await chrome.runtime.sendMessage({
                    type: 'CLEANUP_SCAN_COMPLETE',
                    success: true,
                    messages: [], // Messages already sent in chunks
                    count: allMessages.length,
                    chunked: true,
                    totalChunks: chunks.length,
                  });
                  sendSuccess = true;
                  console.log(`[Clarity] 🧹 CLEANUP_SCAN_COMPLETE sent via ${chunks.length} chunks`);
                } catch (finalErr) {
                  console.error(`[Clarity] 🧹 Final completion signal failed: ${finalErr.message}`);
                }
              }
            }
            
            if (!sendSuccess) {
              console.error(`[Clarity] 🧹 ❌ ALL send attempts failed for ${allMessages.length} messages — data lost`);
            }
          } catch (err) {
            setHighQualityCapture(false);
            console.error('[Clarity] 🧹 CRM_CLEANUP_SCAN error:', err);
            
            chrome.runtime.sendMessage({
              type: 'CLEANUP_SCAN_COMPLETE',
              success: false,
              messages: [],
              error: err.message,
            }).catch(() => {});
          } finally {
            // ── UNLOCK: always release even if scan throws ──
            cleanupScanActive = false;
            console.log('[Clarity] 🧹 cleanupScanActive = false (scan finished)');
          }
        })();
        
        return true;
      }

      // Check if chat input field is available
      if (message.type === 'CHECK_CHAT_INPUT') {
        const input = findChatInput();
        const found = !!input;
        console.log(`[Clarity] CHECK_CHAT_INPUT: ${found ? '✅ Found' : '❌ Not found'}`);
        sendResponse({ found, inputType: input?.tagName || null });
        return true;
      }

      // Handle draft state request — returns current compose box text + attached media
      if (message.type === 'GET_DRAFT_STATE') {
        const draft = extractDraftState();
        console.log(`[Clarity] 📝 GET_DRAFT_STATE:`, draft ? `text="${(draft.text || '').substring(0, 30)}...", ${draft.media?.length || 0} media` : 'empty');
        sendResponse({ success: true, draft });
        return true;
      }

      // Handle SET_DRAFT_TEXT — instantly sets text in the OF compose box (no typing animation)
      // Used by CRM real-time typing bridge.
      // IMPORTANT: Uses document.execCommand('insertText') instead of innerHTML so that
      // ProseMirror/Tiptap registers the change in its internal state model. Without this,
      // ProseMirror thinks the editor is empty → send button stays disabled → CRM_TRIGGER_SEND fails.
      if (message.type === 'SET_DRAFT_TEXT') {
        const text = message.text ?? '';
        try {
          const editor = document.querySelector(
            '.tiptap.ProseMirror.b-text-editor, ' +
            '[contenteditable="true"].b-text-editor, ' +
            '.b-chat__message-input [contenteditable="true"], ' +
            '.b-make-post__main-wrapper [contenteditable="true"]'
          );
          if (!editor) {
            sendResponse({ success: false, error: 'Editor not found' });
            return true;
          }

          // ── CRITICAL: Skip if text is already identical ──
          // selectAllChildren + insertText causes a visible "select-all → replace" flash.
          // If the editor already has this exact text, there's no reason to re-inject it.
          // This prevents the flash the user sees as "typing" — especially right before SEND.
          const normalize = s => (s || '').replace(/[\n\r\u200B]/g, ' ').replace(/\s+/g, ' ').trim();
          const currentText = normalize(editor.innerText);
          const targetText = normalize(text);
          if (currentText === targetText) {
            console.log(`[Clarity] ✏️ SET_DRAFT_TEXT: text unchanged — skipping injection`);
            sendResponse({ success: true, skipped: true });
            return true;
          }

          console.log(`[Clarity] ✏️ SET_DRAFT_TEXT: "${text.substring(0, 40)}${text.length > 40 ? '...' : ''}"`);
          editor.focus();

          // Select all existing content and replace it
          const sel = window.getSelection();
          sel.selectAllChildren(editor);

          if (text) {
            // Use execCommand('insertText') — fires proper InputEvent with
            // inputType:'insertText' that ProseMirror/Tiptap handles natively.
            // This updates ProseMirror's internal state → send button enables correctly.
            document.execCommand('insertText', false, text);
          } else {
            // Clear: delete the selection (leaves ProseMirror in proper empty state)
            document.execCommand('delete', false, null);
          }

          sendResponse({ success: true });
        } catch (err) {
          console.error('[Clarity] ✏️ SET_DRAFT_TEXT error:', err);
          sendResponse({ success: false, error: err.message });
        }
        return true;
      }

      // Handle CRM send message — same as SEND_MESSAGE but with CRM-specific type
      // The bridge sends this type; content script delegates to sendMessageToChat
      // ALWAYS skipInjection — CRM text is already in the compose box from live typing.
      // Never do selectAll + insertText here — it causes visible "typing" flash.
      if (message.type === 'CRM_SEND_MESSAGE') {
        console.log(`[Clarity] 📤 CRM_SEND_MESSAGE (skipInjection=true): "${(message.text || '').substring(0, 50)}..."`);
        sendMessageToChat(message.text, { skipInjection: true })
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
      }

      // Handle CRM trigger send — just clicks the OF send button (for draft sends
      // where content is already in the compose box from live typing via SET_DRAFT_TEXT).
      // Polls for up to 3s for the send button to become enabled (ProseMirror
      // may need a moment to process the text and enable the button).
      // NOTE: No injection fallback exists — this MUST find the button or the send fails.
      if (message.type === 'CRM_TRIGGER_SEND') {
        console.log('[Clarity] 📤 CRM_TRIGGER_SEND: Polling for enabled send button (up to 5s)...');
        (async () => {
          try {
            const MAX_POLLS = 50;  // 50 × 100ms = 5s max wait
            const POLL_INTERVAL = 100;

            for (let poll = 0; poll < MAX_POLLS; poll++) {
              // Try findSendButton (proven helper from message-sender.js)
              const input = findChatInput();
              let btn = input ? findSendButton(input) : null;

              // Fallback: try OF-specific selectors directly
              if (!btn || btn.disabled) {
                btn = document.querySelector(
                  'button[at-attr="send_btn"].b-chat__btn-submit:not([disabled]), ' +
                  'button.b-chat__btn-submit:not([disabled]), ' +
                  'button.g-btn.m-rounded.b-chat__btn-submit:not([disabled])'
                );
              }

              if (btn && !btn.disabled) {
                btn.click();
                console.log(`[Clarity] 📤 CRM_TRIGGER_SEND: ✅ Clicked send button (poll ${poll + 1}/${MAX_POLLS})`);
                sendResponse({ success: true });
                return;
              }

              // Wait before next poll
              if (poll < MAX_POLLS - 1) {
                await new Promise(r => setTimeout(r, POLL_INTERVAL));
              }
            }

            // All polls exhausted — button never enabled
            console.warn('[Clarity] 📤 CRM_TRIGGER_SEND: ❌ Send button not found/enabled after 3s polling');
            sendResponse({ success: false, error: 'Send button not found or disabled after 3s polling' });
          } catch (err) {
            console.error('[Clarity] 📤 CRM_TRIGGER_SEND error:', err);
            sendResponse({ success: false, error: err.message });
          }
        })();
        return true; // Keep message channel open for async response
      }

      // Handle SET_PRICE — sets PPV price on uploaded media in the OF compose box
      // Called by CRM bridge when user sets a price via the Price button
      if (message.type === 'SET_PRICE') {
        const price = parseInt(message.price, 10);
        console.log(`[Clarity] 💰 SET_PRICE: Setting media price to $${price}`);
        if (!price || price <= 0) {
          sendResponse({ success: false, error: 'Invalid price value: ' + message.price });
          return true;
        }
        setMediaPrice(price)
          .then(result => {
            console.log(`[Clarity] 💰 SET_PRICE result: ${result ? '✅ Success' : '❌ Failed — check console for details'}`);
            sendResponse({ 
              success: result, 
              error: result ? undefined : 'setMediaPrice returned false — price toggle or input not found (see OF tab console for details)' 
            });
          })
          .catch(err => {
            console.error('[Clarity] 💰 SET_PRICE error:', err);
            sendResponse({ success: false, error: err.message });
          });
        return true; // Keep channel open for async response
      }

      // Handle REMOVE_PRICE — clicks the X button on the "Price to view" label to remove the price
      if (message.type === 'REMOVE_PRICE') {
        console.log('[Clarity] 💰 REMOVE_PRICE: Removing price from draft...');
        try {
          // Find the delete button inside the paid price label
          const deleteBtn = document.querySelector(
            '.b-make-post__price-free-label.m-paid button.b-dropzone__preview__delete, ' +
            '.b-make-post__price-free-label.m-paid [at-attr="delete_msg_price"], ' +
            'button[at-attr="delete_msg_price"]'
          );
          if (deleteBtn) {
            deleteBtn.click();
            console.log('[Clarity] 💰 REMOVE_PRICE: ✅ Clicked price delete button');
            sendResponse({ success: true });
          } else {
            console.warn('[Clarity] 💰 REMOVE_PRICE: Price delete button not found');
            sendResponse({ success: false, error: 'Price delete button not found' });
          }
        } catch (err) {
          console.error('[Clarity] 💰 REMOVE_PRICE error:', err);
          sendResponse({ success: false, error: err.message });
        }
        return true;
      }

      // Handle CLICK_CHAT_LIST_USER — clicks a user from the OF chat list sidebar (SPA navigation).
      // Method A: Faster than URL navigation because it's an in-app click (no full page reload).
      // The chat list is visible both on /my/chats/ and on /my/chats/chat/{id}/ (left sidebar).
      if (message.type === 'CLICK_CHAT_LIST_USER') {
        const fanId = message.fanId;
        console.log(`[Clarity] 📂 CLICK_CHAT_LIST_USER: Looking for fan ${fanId} in chat list...`);
        try {
          // Strategy 1: Find the chat list item by its id attribute (most reliable)
          // Each item has: <div id="73185816" class="b-available-users__item b-chats__item ...">
          let chatItem = document.querySelector(`.b-chats__item[id="${fanId}"]`);

          // Strategy 2: Find by the link href
          if (!chatItem) {
            const link = document.querySelector(`a.b-chats__item__link[href="/my/chats/chat/${fanId}/"]`);
            if (link) chatItem = link.closest('.b-chats__item');
          }

          // Strategy 3: Find by link href without trailing slash
          if (!chatItem) {
            const link = document.querySelector(`a.b-chats__item__link[href*="/my/chats/chat/${fanId}"]`);
            if (link) chatItem = link.closest('.b-chats__item');
          }

          if (chatItem) {
            // Click the link inside the chat item (triggers OF's SPA router)
            const link = chatItem.querySelector('a.b-chats__item__link');
            if (link) {
              link.click();
              console.log(`[Clarity] 📂 ✅ Clicked chat list link for fan ${fanId}`);
              sendResponse({ success: true, method: 'chat-list-click' });
            } else {
              // Fallback: click the item div itself (it has role="link")
              chatItem.click();
              console.log(`[Clarity] 📂 ✅ Clicked chat list item div for fan ${fanId}`);
              sendResponse({ success: true, method: 'chat-list-item-click' });
            }
          } else {
            console.log(`[Clarity] 📂 ❌ Fan ${fanId} not found in chat list DOM`);
            sendResponse({ success: false, error: 'Fan not in visible chat list' });
          }
        } catch (err) {
          console.error(`[Clarity] 📂 CLICK_CHAT_LIST_USER error:`, err);
          sendResponse({ success: false, error: err.message });
        }
        return true;
      }

      // Handle FETCH_VIDEO_URLS — uses OF API to get actual video CDN URLs for a chat
      // Called by nyx-crm-bridge after syncing messages that have mediaType=video but no mediaUrl
      if (message.type === 'FETCH_VIDEO_URLS') {
        const chatId = message.chatId;
        console.log(`[Clarity] 🎬 FETCH_VIDEO_URLS: Fetching video URLs for chat ${chatId}...`);
        fetchVideoUrlsForChat(chatId)
          .then(urls => {
            const count = Object.keys(urls).length;
            console.log(`[Clarity] 🎬 FETCH_VIDEO_URLS: Got ${count} video URLs`);
            sendResponse({ success: true, videoUrls: urls });
          })
          .catch(err => {
            console.error(`[Clarity] 🎬 FETCH_VIDEO_URLS error:`, err);
            sendResponse({ success: false, error: err.message, videoUrls: {} });
          });
        return true; // Keep channel open for async response
      }

      // Handle delete draft media — clicks the Nth delete button in the OF compose area
      if (message.type === 'DELETE_DRAFT_MEDIA') {
        const idx = message.index;
        console.log(`[Clarity] 🗑️ DELETE_DRAFT_MEDIA: Removing media at index ${idx}`);
        try {
          // Find all media preview delete buttons inside the compose area
          const composeArea = document.querySelector('.b-make-post__main-wrapper, .b-chat__message-input');
          if (!composeArea) {
            console.warn('[Clarity] 🗑️ Compose area not found');
            sendResponse({ success: false, error: 'Compose area not found' });
            return true;
          }
          const deleteButtons = composeArea.querySelectorAll('button.b-dropzone__preview__delete, .b-dropzone__preview__delete');
          console.log(`[Clarity] 🗑️ Found ${deleteButtons.length} delete buttons, clicking index ${idx}`);
          if (idx >= 0 && idx < deleteButtons.length) {
            deleteButtons[idx].click();
            sendResponse({ success: true, deleted: idx });
          } else {
            console.warn(`[Clarity] 🗑️ Index ${idx} out of range (${deleteButtons.length} buttons)`);
            sendResponse({ success: false, error: `Index ${idx} out of range` });
          }
        } catch (err) {
          console.error('[Clarity] 🗑️ DELETE_DRAFT_MEDIA error:', err);
          sendResponse({ success: false, error: err.message });
        }
        return true;
      }
    });
  }
  
  function sendChatMessages(data) {
    chrome.runtime.sendMessage({ type: 'CHAT_MESSAGES', data }).catch(() => {});
  }
  
  function sendDraftState() {
    const draft = extractDraftState();
    chrome.runtime.sendMessage({ type: 'CHAT_DRAFT_STATE', data: draft }).catch(() => {});
  }
  
  // ============================================================
  // PAGE WATCHING
  // ============================================================
  
  // FIX E: Deduplication state — prevents redundant autoLoadChat calls on page navigation
  let _chatLoaded = false;
  let _chatLoadUrl = '';

  function startWatching() {
    let lastUrl = window.location.href;
    
    // Set up page watching with callback for chat page detection
    startPageWatching((currentUrl) => {
      if (isOnChatPage()) {
        // Skip autoLoadChat during cleanup scan — it interferes with scroll operations
        // and triggers SAVE_CHAT writes that race with the cleanup's delete→rescan cycle
        if (cleanupScanActive) {
          console.log('[Clarity] ⏸️ Skipping autoLoadChat — cleanup scan active');
          return;
        }

        // FIX D: Clear previous chat's accumulated data before loading new one
        resetForNewChat();

        // FIX E: Reset loaded flag for new chat page
        _chatLoaded = false;
        _chatLoadUrl = currentUrl;

        const tryLoad = () => {
          if (_chatLoaded || window.location.href !== _chatLoadUrl || cleanupScanActive) return;
          autoLoadChat();
          // autoLoadChat sets messages if found — check by seeing if it worked
          // We mark as loaded to skip redundant extractions
          _chatLoaded = true;
        };

        console.log('[Clarity] Entered chat page, scheduling message extraction...');
        setTimeout(() => { tryLoad(); startDraftObserver(); }, 500);
        setTimeout(() => { tryLoad(); startDraftObserver(); }, 1500);
        setTimeout(() => { tryLoad(); sendDraftState(); startDraftObserver(); }, 3000);
      } else {
        // Left chat page — stop draft observer and clear draft state
        _chatLoaded = false;
        stopDraftObserver();
        chrome.runtime.sendMessage({ type: 'CHAT_DRAFT_STATE', data: null }).catch(() => {});
      }
      
    });
    
    // Initial load — already on a chat page when extension starts
    if (isOnChatPage()) {
      _chatLoaded = false;
      _chatLoadUrl = window.location.href;

      const tryLoad = () => {
        if (_chatLoaded || window.location.href !== _chatLoadUrl || cleanupScanActive) return;
        autoLoadChat();
        _chatLoaded = true;
      };

      setTimeout(() => { tryLoad(); startDraftObserver(); }, 500);
      setTimeout(() => { tryLoad(); startDraftObserver(); }, 1500);
      setTimeout(() => { tryLoad(); sendDraftState(); startDraftObserver(); }, 3000);
      // Extra late retry for slow-loading pages (draft observer only)
      setTimeout(() => {
        if (!cleanupScanActive) { sendDraftState(); startDraftObserver(); }
      }, 6000);
    }
  }
  
  // ============================================================
  // HELPERS
  // ============================================================
  
  function isOnChatPage() {
    const url = window.location.href;
    const isChatUrl = url.includes('/my/chats/chat/') || url.includes('/messages/');
    const hasChat = !!document.querySelector('.b-chat__messages-wrapper, .b-chat__content');
    return isChatUrl || hasChat;
  }
  
  // Check if chat page is fully loaded (for reliable message sending)
  function isChatFullyLoaded() {
    // Check 1: URL must be a chat page
    const url = window.location.href;
    if (!url.includes('/my/chats/chat/')) {
      return false;
    }
    
    // Check 2: Chat messages container must exist
    const messagesContainer = document.querySelector(
      '.b-chat__messages-wrapper, ' +
      '.b-chat__content, ' +
      '[class*="chat__messages"], ' +
      '.m-native-custom-scrollbar'
    );
    if (!messagesContainer) {
      return false;
    }
    
    // Check 3: Chat input field must exist and be visible
    const chatInput = findChatInput();
    if (!chatInput) {
      return false;
    }
    
    // Check 4: Input must be interactable (not disabled, has some dimensions)
    if (chatInput.disabled) {
      return false;
    }
    
    // Check 5: Chat header with name should exist (indicates chat fully loaded)
    const chatHeader = document.querySelector(
      '.b-chat__header, ' +
      '.g-user-name, ' +
      '[class*="chat-header"], ' +
      '.b-username'
    );
    if (!chatHeader) {
      return false;
    }
    
    // All checks passed - chat is ready!
    return true;
  }
  
  // ============================================================
  // START
  // ============================================================
  
  init();
})();