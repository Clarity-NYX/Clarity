// AI Test Media Panel - For OnlyFans image sending testing
import Store from '../../state/store.js';
import { $, escapeHtml } from '../../utils/dom.js';
import { showNotification, showError } from '../../utils/notify.js';
import { blobToBase64 } from './helpers.js';

// Currently selected image for sending
let selectedTestMediaImage = null;

// Load and render images in the test media grid
export const loadTestMediaGrid = () => {
  const grid = $('testMediaGrid');
  if (!grid) return;

  const profile = Store.get('currentProfile');
  const currentScript = Store.get('currentScript');

  // Get images from script pool first, then profile pool
  const scriptImages = currentScript?.imagePool || [];
  const profileImages = profile?.imagePool || [];
  const imagePool = scriptImages.length > 0 ? scriptImages : profileImages;

  if (!imagePool || imagePool.length === 0) {
    grid.innerHTML = '<div class="test-media-empty">No images in pool. Add images in Scripts → Image Pool</div>';
    const sendBtn = $('testSendSelectedBtn');
    if (sendBtn) sendBtn.disabled = true;
    return;
  }

  console.log('[Test Media] 📸 Found', imagePool.length, 'images in pool');

  // Render image grid - escape user-controlled names to prevent XSS
  grid.innerHTML = imagePool.map((img, index) => {
    const imageUrl = img.downloadURL || img.imageData;
    const safeName = escapeHtml(img.name || 'Image ' + (index + 1));
    const safeAlt = escapeHtml(img.name || 'Image');
    return `
      <div class="test-media-item" data-index="${index}" data-id="${img.id || index}">
        <img src="${imageUrl}" alt="${safeAlt}">
        <div class="test-media-item-name">${safeName}</div>
      </div>
    `;
  }).join('');

  // Add click handlers for selection
  grid.querySelectorAll('.test-media-item').forEach(item => {
    item.addEventListener('click', () => {
      // Remove selection from all items
      grid.querySelectorAll('.test-media-item').forEach(i => i.classList.remove('selected'));

      // Select this item
      item.classList.add('selected');

      const index = parseInt(item.dataset.index);
      selectedTestMediaImage = imagePool[index];

      console.log('[Test Media] Selected:', selectedTestMediaImage.name);

      // Enable send button
      const sendBtn = $('testSendSelectedBtn');
      if (sendBtn) sendBtn.disabled = false;
    });
  });
};

// Toggle the test media panel
export const toggleTestMediaPanel = () => {
  const panel = $('testMediaPanel');
  const body = $('testMediaBody');
  const arrow = $('testMediaArrow');

  if (!panel || !body) return;

  const isCollapsed = panel.classList.contains('collapsed');

  if (isCollapsed) {
    panel.classList.remove('collapsed');
    body.classList.remove('hidden');
    if (arrow) arrow.textContent = '▼';

    // Load images when panel opens
    loadTestMediaGrid();
  } else {
    panel.classList.add('collapsed');
    body.classList.add('hidden');
    if (arrow) arrow.textContent = '▶';
  }
};

// Test send media from image pool (for OnlyFans testing)
export const testSendMedia = async () => {
  if (!selectedTestMediaImage) {
    showError('Please select an image first!');
    return;
  }

  const imageToSend = selectedTestMediaImage;
  console.log('[Test Media] 📸 Sending image:', imageToSend.name);

  // Get image data
  let imageData = imageToSend.imageData;

  if (!imageData && imageToSend.downloadURL) {
    console.log('[Test Media] 📸 Fetching from Firebase URL...');
    try {
      const response = await fetch(imageToSend.downloadURL);
      if (response.ok) {
        const blob = await response.blob();
        imageData = await blobToBase64(blob);
        console.log('[Test Media] ✅ Converted to base64');
      } else {
        throw new Error('Failed to fetch image');
      }
    } catch (err) {
      showError('Failed to load image: ' + err.message);
      return;
    }
  }

  if (!imageData) {
    showError('No image data found for: ' + imageToSend.name);
    return;
  }

  // Send to OnlyFans via content script
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id || !tab.url?.includes('onlyfans.com')) {
      showError('Please open an OnlyFans chat first!');
      return;
    }

    showNotification('📸 Sending test image: ' + imageToSend.name);

    const sendBtn = $('testSendSelectedBtn');
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.textContent = '⏳ Sending...';
    }

    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'SEND_IMAGE',
      imageUrl: imageData,
      caption: null
    });

    console.log('[Test Media] Result:', result);

    if (result?.success) {
      showNotification('✅ Image sent successfully!');
      if (sendBtn) sendBtn.textContent = '✅ Sent!';

      // Reset after 2 seconds
      setTimeout(() => {
        if (sendBtn) {
          sendBtn.textContent = '📤 Send Selected';
          sendBtn.disabled = !selectedTestMediaImage;
        }
      }, 2000);
    } else {
      showError('Failed: ' + (result?.error || 'Unknown error'));
      if (sendBtn) {
        sendBtn.textContent = '❌ Failed';
        setTimeout(() => {
          sendBtn.textContent = '📤 Send Selected';
          sendBtn.disabled = false;
        }, 2000);
      }
    }
  } catch (err) {
    console.error('[Test Media] Error:', err);
    showError('Send failed: ' + err.message);

    const sendBtn = $('testSendSelectedBtn');
    if (sendBtn) {
      sendBtn.textContent = '📤 Send Selected';
      sendBtn.disabled = false;
    }
  }
};

// Setup test media panel listeners
export const setupTestMediaListeners = () => {
  // Panel toggle
  $('testMediaHeaderToggle')?.addEventListener('click', toggleTestMediaPanel);

  // Send button
  $('testSendSelectedBtn')?.addEventListener('click', testSendMedia);

  // Refresh button
  $('testRefreshPoolBtn')?.addEventListener('click', loadTestMediaGrid);
};
