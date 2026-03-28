// ============================================================
// CHAT VAULT - Media gallery with named vault organisation
// Reads from imagePool, supports create/rename/delete vaults,
// filters by vault + media type, tracks sent per subscriber
// ============================================================

import Store from '../../state/store.js';
import { $ } from '../../utils/dom.js';
import { showNotification } from '../../utils/notify.js';
import {
  getImages,
  addImage,
  deleteImage,
  markImageUsed,
  markImageSentToSubscriber,
  unmarkImageSentToSubscriber,
  hasImageBeenSentToSubscriber,
  getVaults,
  createVault,
  renameVault,
  deleteVault,
  getImagesByVault,
  moveMediaToVault
} from '../imagePool.js';

let currentTab = 'images';   // 'images' | 'videos' | 'sent'
let currentVaultId = 'all';  // 'all' | vault id
let selectMode = false;      // multi-select mode
let selectedIds = new Set();  // selected media IDs

// Helper: check if vault modal is currently visible
const isVaultOpen = () => {
  const modal = $('vaultModal');
  return modal && modal.classList.contains('active');
};

// ============================================================
// OPEN / CLOSE
// ============================================================

export const openVault = () => {
  const modal = $('vaultModal');
  if (!modal) return;
  currentTab = 'images';
  currentVaultId = 'all';
  modal.classList.add('active');
  renderVault();
};

export const closeVault = () => {
  const modal = $('vaultModal');
  if (modal) modal.classList.remove('active');
};

// ============================================================
// TAB SWITCHING
// ============================================================

const switchTab = (tab) => {
  currentTab = tab;
  document.querySelectorAll('.vault-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  renderVaultGrid();
};

// ============================================================
// VAULT SELECTOR (pills row)
// ============================================================

const renderVaultSelector = () => {
  const container = $('vaultSelectorRow');
  if (!container) return;

  const vaults = getVaults();

  // Build pills: "All" + each vault + "+" add button
  let html = `<button class="vault-pill ${currentVaultId === 'all' ? 'active' : ''}" data-vault="all">All</button>`;

  vaults.forEach(v => {
    const isActive = currentVaultId === v.id;
    html += `
      <button class="vault-pill ${isActive ? 'active' : ''}" data-vault="${v.id}" title="${v.name}">
        <span class="vault-pill-name">${v.name}</span>
        ${v.id !== 'default' ? `<span class="vault-pill-menu" data-vault-menu="${v.id}">⋯</span>` : ''}
      </button>`;
  });

  html += `<button class="vault-pill vault-add-pill" id="vaultAddNewBtn" title="Create Vault">+</button>`;

  container.innerHTML = html;

  // Bind pill clicks (select vault)
  container.querySelectorAll('.vault-pill[data-vault]').forEach(pill => {
    pill.addEventListener('click', (e) => {
      // Ignore if clicking the ⋯ menu button
      if (e.target.classList.contains('vault-pill-menu')) return;
      currentVaultId = pill.dataset.vault;
      renderVaultSelector();
      renderVaultGrid();
    });
  });

  // Bind ⋯ menu buttons (rename / delete)
  container.querySelectorAll('.vault-pill-menu').forEach(menuBtn => {
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showVaultContextMenu(menuBtn.dataset.vaultMenu, menuBtn);
    });
  });

  // Bind "+" add vault button
  const addBtn = container.querySelector('#vaultAddNewBtn');
  if (addBtn) {
    addBtn.addEventListener('click', handleCreateVault);
  }
};

// ============================================================
// VAULT CONTEXT MENU (rename / delete)
// ============================================================

const showVaultContextMenu = (vaultId, anchor) => {
  // Remove any existing context menu
  document.querySelectorAll('.vault-context-menu').forEach(m => m.remove());

  const vaults = getVaults();
  const vault = vaults.find(v => v.id === vaultId);
  if (!vault) return;

  const menu = document.createElement('div');
  menu.className = 'vault-context-menu';
  menu.innerHTML = `
    <button class="vault-ctx-btn" data-action="rename">✏️ Rename</button>
    <button class="vault-ctx-btn vault-ctx-danger" data-action="delete">🗑️ Delete</button>
  `;

  // Position near anchor
  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;
  menu.style.zIndex = '1100';

  document.body.appendChild(menu);

  // Handle actions
  menu.querySelector('[data-action="rename"]').addEventListener('click', () => {
    menu.remove();
    handleRenameVault(vaultId, vault.name);
  });

  menu.querySelector('[data-action="delete"]').addEventListener('click', () => {
    menu.remove();
    handleDeleteVault(vaultId, vault.name);
  });

  // Close on outside click
  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
};

// ============================================================
// VAULT CRUD HANDLERS
// ============================================================

const handleCreateVault = () => {
  const name = prompt('New vault name:');
  if (!name || !name.trim()) return;

  const vault = createVault(name);
  currentVaultId = vault.id;
  showNotification(`Vault "${vault.name}" created`);
  renderVaultSelector();
  renderVaultGrid();
};

const handleRenameVault = (vaultId, currentName) => {
  const newName = prompt('Rename vault:', currentName);
  if (!newName || !newName.trim() || newName.trim() === currentName) return;

  renameVault(vaultId, newName);
  showNotification('Vault renamed');
  renderVaultSelector();
};

const handleDeleteVault = (vaultId, vaultName) => {
  const count = getImagesByVault(vaultId).length;
  const msg = count > 0
    ? `Delete "${vaultName}"? ${count} item(s) will be moved to General.`
    : `Delete "${vaultName}"?`;

  if (!confirm(msg)) return;

  deleteVault(vaultId);
  if (currentVaultId === vaultId) currentVaultId = 'all';
  showNotification(`Vault "${vaultName}" deleted`);
  renderVaultSelector();
  renderVaultGrid();
};

// ============================================================
// RENDER
// ============================================================

const renderVault = () => {
  // Tabs
  document.querySelectorAll('.vault-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === currentTab);
  });
  updateSubscriberContext();
  renderVaultSelector();
  renderVaultGrid();
};

// ============================================================
// SUBSCRIBER CONTEXT — shows who "Sent" tracking applies to
// ============================================================

const updateSubscriberContext = () => {
  const subscriberName = Store.get('subscriberName') || '';
  const subscriberId = Store.get('currentSubscriberId');

  // Update the "Sent" tab label to show subscriber name
  const sentTab = document.querySelector('.vault-tab-btn[data-tab="sent"]');
  if (sentTab) {
    if (subscriberName) {
      sentTab.textContent = `✅ Sent`;
      sentTab.title = `Media sent to ${subscriberName}`;
    } else {
      sentTab.textContent = '✅ Sent';
      sentTab.title = 'No subscriber selected';
    }
  }

  // Update or create the subscriber context bar below header
  let ctxBar = document.getElementById('vaultSubscriberCtx');
  const header = document.querySelector('.vault-header');
  if (!header) return;

  if (!ctxBar) {
    ctxBar = document.createElement('div');
    ctxBar.id = 'vaultSubscriberCtx';
    ctxBar.className = 'vault-subscriber-ctx';
    header.after(ctxBar);
  }

  if (subscriberId && subscriberName) {
    ctxBar.innerHTML = `<span class="vault-ctx-dot"></span> Tracking sent for: <strong>${subscriberName}</strong>`;
    ctxBar.classList.remove('vault-ctx-none');
  } else if (subscriberId) {
    ctxBar.innerHTML = `<span class="vault-ctx-dot"></span> Tracking sent for: <strong>${subscriberId}</strong>`;
    ctxBar.classList.remove('vault-ctx-none');
  } else {
    ctxBar.innerHTML = `<span class="vault-ctx-warn">⚠</span> No subscriber selected — sent tracking inactive`;
    ctxBar.classList.add('vault-ctx-none');
  }
};

const renderVaultGrid = () => {
  const grid = $('vaultGrid');
  if (!grid) return;

  const subscriberId = Store.get('currentSubscriberId');

  // Get media for selected vault
  const vaultMedia = getImagesByVault(currentVaultId);

  // Filter by current tab
  let filtered;
  if (currentTab === 'images') {
    filtered = vaultMedia.filter(m => m.mediaType !== 'video');
  } else if (currentTab === 'videos') {
    filtered = vaultMedia.filter(m => m.mediaType === 'video');
  } else {
    // 'sent' tab — only items sent to this subscriber
    filtered = vaultMedia.filter(m => subscriberId && hasImageBeenSentToSubscriber(subscriberId, m));
  }

  if (filtered.length === 0) {
    const emptyMsg = currentTab === 'sent'
      ? 'No media sent to this subscriber yet'
      : `No ${currentTab} in ${currentVaultId === 'all' ? 'your vault' : 'this vault'}`;
    grid.innerHTML = `
      <div class="vault-empty">
        <span>${currentTab === 'videos' ? '🎬' : currentTab === 'sent' ? '✅' : '📷'}</span>
        <p>${emptyMsg}</p>
      </div>`;
    updateSelectionBar();
    return;
  }

  const vaults = getVaults();

  grid.innerHTML = filtered.map(item => {
    const isSent = subscriberId && hasImageBeenSentToSubscriber(subscriberId, item);
    const isVideo = item.mediaType === 'video';
    const isSelected = selectedIds.has(item.id);
    const thumbSrc = item.imageData || item.downloadURL || '';
    const itemVault = vaults.find(v => v.id === (item.vaultId || 'default'));
    const vaultLabel = itemVault ? itemVault.name : 'General';

    return `
      <div class="vault-item ${isSent ? 'sent' : ''} ${selectMode ? 'select-mode' : ''} ${isSelected ? 'selected' : ''}" data-id="${item.id}">
        ${isVideo
          ? `<video src="${thumbSrc}" muted preload="metadata"></video>
             <div class="vault-play-icon">▶</div>`
          : `<img src="${thumbSrc}" alt="${item.name || ''}" loading="lazy">`
        }
        ${selectMode ? `<div class="vault-select-check">${isSelected ? '✓' : ''}</div>` : ''}
        ${isSent ? '<div class="vault-sent-badge">✓</div>' : ''}
        ${!selectMode ? `<button class="vault-item-menu-btn" data-id="${item.id}" title="More options">⋮</button>` : ''}
        ${!selectMode ? `<div class="vault-item-actions">
          <button class="vault-send-btn" data-id="${item.id}" title="Send to chat">Send</button>
        </div>` : ''}
      </div>`;
  }).join('');

  if (selectMode) {
    // In select mode: tap to select/deselect
    grid.querySelectorAll('.vault-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        if (selectedIds.has(id)) {
          selectedIds.delete(id);
          el.classList.remove('selected');
          el.querySelector('.vault-select-check').textContent = '';
        } else {
          selectedIds.add(id);
          el.classList.add('selected');
          el.querySelector('.vault-select-check').textContent = '✓';
        }
        updateSelectionBar();
      });
    });
  } else {
    // Normal mode: send + delete buttons
    grid.querySelectorAll('.vault-send-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        sendMediaToChat(btn.dataset.id);
      });
    });

    grid.querySelectorAll('.vault-item-menu-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        showItemContextMenu(btn.dataset.id, btn);
      });
    });
  }

  updateSelectionBar();
};

// ============================================================
// MULTI-SELECT MODE
// ============================================================

const toggleSelectMode = () => {
  selectMode = !selectMode;
  selectedIds.clear();
  const btn = $('vaultSelectBtn');
  if (btn) btn.textContent = selectMode ? 'Cancel' : 'Select';
  renderVaultGrid();
};

const exitSelectMode = () => {
  selectMode = false;
  selectedIds.clear();
  const btn = $('vaultSelectBtn');
  if (btn) btn.textContent = 'Select';
  renderVaultGrid();
};

const updateSelectionBar = () => {
  let bar = document.getElementById('vaultSelectionBar');
  
  if (!selectMode || selectedIds.size === 0) {
    if (bar) bar.classList.add('hidden');
    return;
  }

  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'vaultSelectionBar';
    bar.className = 'vault-selection-bar';
    const footer = document.querySelector('.vault-footer');
    if (footer) footer.parentNode.insertBefore(bar, footer);
  }

  bar.innerHTML = `
    <span class="vault-sel-count">${selectedIds.size} selected</span>
    <button class="btn btn-primary btn-small vault-move-btn" id="vaultMoveSelectedBtn">📂 Move</button>
    <button class="btn btn-small vault-mark-sent-sel-btn" id="vaultMarkSentSelectedBtn">✓ Sent</button>
    <button class="btn btn-secondary btn-small vault-del-sel-btn" id="vaultDeleteSelectedBtn">🗑️</button>
  `;
  bar.classList.remove('hidden');

  document.getElementById('vaultMoveSelectedBtn')?.addEventListener('click', showMoveVaultPicker);
  document.getElementById('vaultMarkSentSelectedBtn')?.addEventListener('click', markSelectedAsSent);
  document.getElementById('vaultDeleteSelectedBtn')?.addEventListener('click', deleteSelected);
};

const showMoveVaultPicker = () => {
  // Remove any existing picker
  document.querySelectorAll('.vault-move-picker').forEach(p => p.remove());

  const vaults = getVaults();
  const picker = document.createElement('div');
  picker.className = 'vault-move-picker';
  picker.innerHTML = `
    <div class="vault-move-picker-title">Move ${selectedIds.size} item(s) to:</div>
    ${vaults.map(v => `
      <button class="vault-move-option" data-vault="${v.id}">
        ${v.name}
      </button>
    `).join('')}
    <button class="vault-move-option vault-move-new">+ New Vault</button>
  `;

  const bar = document.getElementById('vaultSelectionBar');
  if (bar) bar.appendChild(picker);

  // Bind vault options
  picker.querySelectorAll('.vault-move-option[data-vault]').forEach(opt => {
    opt.addEventListener('click', () => {
      moveSelectedToVault(opt.dataset.vault);
      picker.remove();
    });
  });

  // Bind "New Vault" option
  picker.querySelector('.vault-move-new')?.addEventListener('click', () => {
    const name = prompt('New vault name:');
    if (!name || !name.trim()) return;
    const vault = createVault(name);
    moveSelectedToVault(vault.id);
    picker.remove();
    renderVaultSelector();
  });

  // Close picker on outside click
  const closePicker = (e) => {
    if (!picker.contains(e.target) && e.target.id !== 'vaultMoveSelectedBtn') {
      picker.remove();
      document.removeEventListener('click', closePicker, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closePicker, true), 0);
};

const moveSelectedToVault = (targetVaultId) => {
  const vaults = getVaults();
  const vaultName = vaults.find(v => v.id === targetVaultId)?.name || 'vault';
  let moved = 0;

  for (const id of selectedIds) {
    moveMediaToVault(id, targetVaultId);
    moved++;
  }

  showNotification(`Moved ${moved} item(s) to ${vaultName}`);
  exitSelectMode();
  renderVaultSelector();
};

const deleteSelected = () => {
  if (!confirm(`Delete ${selectedIds.size} item(s)?`)) return;
  for (const id of selectedIds) {
    deleteImage(id);
  }
  showNotification(`${selectedIds.size} item(s) deleted`);
  exitSelectMode();
};

const markSelectedAsSent = () => {
  const subscriberId = Store.get('currentSubscriberId');
  if (!subscriberId) {
    showNotification('No subscriber selected');
    return;
  }
  let count = 0;
  for (const id of selectedIds) {
    markImageSentToSubscriber(subscriberId, id);
    count++;
  }
  showNotification(`Marked ${count} item(s) as sent ✓`);
  exitSelectMode();
};

// ============================================================
// ITEM CONTEXT MENU (⋮ three-dots per item)
// ============================================================

const showItemContextMenu = (mediaId, anchor) => {
  // Remove any existing context menu
  document.querySelectorAll('.vault-item-context-menu').forEach(m => m.remove());

  const allMedia = getImages();
  const item = allMedia.find(m => m.id === mediaId);
  if (!item) return;

  const subscriberId = Store.get('currentSubscriberId');
  const isSent = subscriberId && hasImageBeenSentToSubscriber(subscriberId, item);
  const vaults = getVaults();
  const currentItemVault = vaults.find(v => v.id === (item.vaultId || 'default'));

  const menu = document.createElement('div');
  menu.className = 'vault-item-context-menu';
  menu.innerHTML = `
    <button class="vault-ctx-btn" data-action="select">☑ Select</button>
    <button class="vault-ctx-btn" data-action="move">📂 Move to…</button>
    <button class="vault-ctx-btn" data-action="sent">${isSent ? '↩ Unmark sent' : '✓ Mark as sent'}</button>
    <button class="vault-ctx-btn vault-ctx-danger" data-action="delete">🗑️ Delete</button>
  `;

  // Position near anchor — keep within vault panel
  const rect = anchor.getBoundingClientRect();
  const vaultPanel = document.querySelector('.vault-panel');
  const panelRect = vaultPanel ? vaultPanel.getBoundingClientRect() : { right: window.innerWidth, bottom: window.innerHeight };

  menu.style.position = 'fixed';
  menu.style.zIndex = '1100';

  // Calculate position: prefer below-left of the button
  let top = rect.bottom + 4;
  let left = rect.right - 140; // menu is ~140px wide, align right edge to button

  // Clamp within panel bounds
  if (left < panelRect.left + 4) left = panelRect.left + 4;
  if (top + 120 > panelRect.bottom) top = rect.top - 120; // flip above if near bottom

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;

  document.body.appendChild(menu);

  // --- Move submenu ---
  menu.querySelector('[data-action="move"]').addEventListener('click', (e) => {
    e.stopPropagation();
    // Show inline vault list
    const moveList = document.createElement('div');
    moveList.className = 'vault-item-move-list';
    moveList.innerHTML = vaults
      .filter(v => v.id !== (item.vaultId || 'default'))
      .map(v => `<button class="vault-ctx-btn" data-move-vault="${v.id}">${v.name}</button>`)
      .join('') +
      `<button class="vault-ctx-btn vault-ctx-new" data-move-vault="__new">+ New Vault</button>`;

    // Replace menu contents with move list
    menu.innerHTML = `<div class="vault-item-move-header">📂 Move to:</div>`;
    menu.appendChild(moveList);

    moveList.querySelectorAll('[data-move-vault]').forEach(opt => {
      opt.addEventListener('click', () => {
        const targetId = opt.dataset.moveVault;
        if (targetId === '__new') {
          const name = prompt('New vault name:');
          if (!name || !name.trim()) { menu.remove(); return; }
          const newVault = createVault(name);
          moveMediaToVault(mediaId, newVault.id);
          showNotification(`Moved to ${newVault.name}`);
          renderVaultSelector();
        } else {
          moveMediaToVault(mediaId, targetId);
          const vName = vaults.find(v => v.id === targetId)?.name || 'vault';
          showNotification(`Moved to ${vName}`);
        }
        menu.remove();
        renderVaultGrid();
      });
    });
  });

  // --- Select multiple ---
  menu.querySelector('[data-action="select"]').addEventListener('click', () => {
    menu.remove();
    selectMode = true;
    selectedIds.clear();
    selectedIds.add(mediaId);
    const btn = $('vaultSelectBtn');
    if (btn) btn.textContent = 'Cancel';
    renderVaultGrid();
  });

  // --- Mark/unmark sent ---
  menu.querySelector('[data-action="sent"]').addEventListener('click', () => {
    menu.remove();
    toggleSentStatus(mediaId);
  });

  // --- Delete ---
  menu.querySelector('[data-action="delete"]').addEventListener('click', () => {
    menu.remove();
    removeMedia(mediaId);
  });

  // Close on outside click
  const closeMenu = (e) => {
    if (!menu.contains(e.target) && !e.target.classList.contains('vault-item-menu-btn')) {
      menu.remove();
      document.removeEventListener('click', closeMenu, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
};

// ============================================================
// TOGGLE SENT STATUS (single item)
// ============================================================

const toggleSentStatus = (mediaId) => {
  const subscriberId = Store.get('currentSubscriberId');
  if (!subscriberId) {
    showNotification('No subscriber selected');
    return;
  }

  const allMedia = getImages();
  const item = allMedia.find(m => m.id === mediaId);
  if (!item) return;

  const isSent = hasImageBeenSentToSubscriber(subscriberId, item);
  if (isSent) {
    unmarkImageSentToSubscriber(subscriberId, mediaId);
    showNotification('Unmarked as sent');
  } else {
    markImageSentToSubscriber(subscriberId, mediaId);
    showNotification('Marked as sent ✓');
  }
  renderVaultGrid();
};

// ============================================================
// SEND MEDIA TO CHAT
// ============================================================

const sendMediaToChat = async (mediaId) => {
  const allMedia = getImages();
  const item = allMedia.find(m => m.id === mediaId);
  if (!item) {
    showNotification('Media not found');
    return;
  }

  // Disable the send button during send
  const btn = document.querySelector(`.vault-send-btn[data-id="${mediaId}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳';
  }

  try {
    // Get base64 data — fetch from Firebase Storage URL if needed
    // (Content script can't fetch Firebase URLs due to CORS, sidepanel can)
    let finalImageData = item.imageData;

    if (!finalImageData && item.downloadURL) {
      console.log('[Vault] 📷 Fetching media from Firebase URL...');
      try {
        const response = await fetch(item.downloadURL);
        if (response.ok) {
          const blob = await response.blob();
          finalImageData = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          console.log('[Vault] ✅ Converted to base64, size:', Math.round(finalImageData.length / 1024), 'KB');
        } else {
          throw new Error(`Fetch failed: ${response.status}`);
        }
      } catch (fetchErr) {
        console.error('[Vault] Failed to fetch media from URL:', fetchErr);
        showNotification('Failed to load media');
        if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
        return;
      }
    }

    if (!finalImageData) {
      showNotification('No media data available');
      if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
      return;
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]?.id) {
      showNotification('No active tab found');
      if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
      return;
    }

    const result = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'SEND_IMAGE',
        imageUrl: finalImageData,
        caption: null,
        price: 0,
        autoSend: false
      }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { success: false, error: 'No response' });
        }
      });
    });

    if (result.success) {
      const subscriberId = Store.get('currentSubscriberId');
      if (subscriberId) {
        markImageSentToSubscriber(subscriberId, item.id);
      }
      markImageUsed(item.id);

      if (result.staged) {
        showNotification('Media ready — click Send in chat ✅');
      } else {
        showNotification('Media sent! ✅');
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Send';
      }
      renderVaultGrid();
    } else {
      showNotification('Send failed: ' + (result.error || 'Unknown error'));
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Send';
      }
    }
  } catch (err) {
    console.error('[Vault] Send error:', err);
    showNotification('Send failed');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Send';
    }
  }
};

// ============================================================
// REMOVE MEDIA
// ============================================================

const removeMedia = (mediaId) => {
  deleteImage(mediaId);
  showNotification('Media removed');
  renderVaultGrid();
};

// ============================================================
// ADD MEDIA — Multi-file picker + Drag & Drop (up to 100 files)
// Adds to currently selected vault
// ============================================================

const MAX_UPLOAD_FILES = 100;
const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
let isUploading = false; // Prevent concurrent batch uploads

const isHeic = (file) => {
  const ext = file.name.toLowerCase();
  return ext.endsWith('.heic') || ext.endsWith('.heif') || file.type === 'image/heic' || file.type === 'image/heif';
};

const isAcceptedFile = (file) => {
  return file.type.startsWith('image/') || file.type.startsWith('video/') || isHeic(file);
};

/** Convert a HEIC/HEIF File to JPEG dataURL via heic2any library */
const heicToJpeg = async (file) => {
  if (!window.heic2any) throw new Error('HEIC converter not loaded');
  const jpegBlob = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  const blob = Array.isArray(jpegBlob) ? jpegBlob[0] : jpegBlob;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Failed to read converted image'));
    reader.readAsDataURL(blob);
  });
};

/** Read a file as base64 dataURL */
const readFileAsDataURL = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => resolve(ev.target.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
};

// ---- Upload Progress UI ----

const showUploadProgress = (current, total) => {
  let bar = document.getElementById('vaultUploadProgress');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'vaultUploadProgress';
    bar.className = 'vault-upload-progress';
    const footer = document.querySelector('.vault-footer');
    if (footer) footer.parentNode.insertBefore(bar, footer);
  }
  const pct = Math.round((current / total) * 100);
  bar.innerHTML = `
    <div class="vault-upload-bar">
      <div class="vault-upload-fill" style="width:${pct}%"></div>
    </div>
    <span class="vault-upload-text">Uploading ${current}/${total}…</span>
  `;
  bar.classList.remove('hidden');
};

const hideUploadProgress = () => {
  const bar = document.getElementById('vaultUploadProgress');
  if (bar) bar.classList.add('hidden');
};

// ---- Batch File Processor ----

const processFiles = async (fileList) => {
  if (isUploading) {
    showNotification('Upload already in progress');
    return;
  }

  // Convert to array and validate
  let files = Array.from(fileList);

  // Filter to accepted types
  files = files.filter(f => isAcceptedFile(f));
  if (files.length === 0) {
    showNotification('No supported files selected (images/videos only)');
    return;
  }

  // Cap at 100
  if (files.length > MAX_UPLOAD_FILES) {
    showNotification(`Max ${MAX_UPLOAD_FILES} files at once — uploading first ${MAX_UPLOAD_FILES}`);
    files = files.slice(0, MAX_UPLOAD_FILES);
  }

  // Filter out oversized files
  const oversized = files.filter(f => f.size > MAX_FILE_SIZE_BYTES);
  if (oversized.length > 0) {
    showNotification(`${oversized.length} file(s) skipped (over ${MAX_FILE_SIZE_MB}MB)`);
    files = files.filter(f => f.size <= MAX_FILE_SIZE_BYTES);
  }

  if (files.length === 0) return;

  const targetVault = (currentVaultId && currentVaultId !== 'all') ? currentVaultId : 'default';
  isUploading = true;
  let successCount = 0;
  let failCount = 0;

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      showUploadProgress(i + 1, files.length);

      try {
        const isVideo = file.type.startsWith('video/');
        const name = file.name.replace(/\.[^.]+$/, '');
        let mediaData;

        if (isHeic(file)) {
          mediaData = await heicToJpeg(file);
        } else {
          mediaData = await readFileAsDataURL(file);
        }

        await addImage(mediaData, isVideo ? 'video' : 'image', name, targetVault);
        successCount++;
      } catch (err) {
        console.error(`[Vault] Failed to upload "${file.name}":`, err);
        failCount++;
      }
    }
  } finally {
    isUploading = false;
    hideUploadProgress();
  }

  // Summary notification
  const vaults = getVaults();
  const vaultName = vaults.find(v => v.id === targetVault)?.name || 'General';
  if (failCount === 0) {
    showNotification(`${successCount} file${successCount > 1 ? 's' : ''} added to ${vaultName} ☁️`);
  } else {
    showNotification(`${successCount} added, ${failCount} failed — ${vaultName}`);
  }
  renderVaultGrid();
};

// ---- File Picker (click "Add Media" button) ----

const openAddMedia = () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,video/*,.heic,.heif';
  input.multiple = true; // Allow selecting up to 100 files
  input.onchange = (e) => processFiles(e.target.files);
  input.click();
};

// ---- Drag & Drop ----

const setupDragAndDrop = () => {
  const panel = document.querySelector('.vault-panel');
  const grid = $('vaultGrid');
  if (!panel || !grid) return;

  let dragCounter = 0; // Track nested enter/leave events

  const showDropZone = () => {
    let overlay = document.getElementById('vaultDropOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'vaultDropOverlay';
      overlay.className = 'vault-drop-overlay';
      overlay.innerHTML = `
        <div class="vault-drop-content">
          <div class="vault-drop-icon">📂</div>
          <div class="vault-drop-text">Drop files here</div>
          <div class="vault-drop-hint">Images & videos (up to 100)</div>
        </div>
      `;
      panel.appendChild(overlay);
    }
    overlay.classList.add('active');
  };

  const hideDropZone = () => {
    const overlay = document.getElementById('vaultDropOverlay');
    if (overlay) overlay.classList.remove('active');
  };

  panel.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter++;
    if (dragCounter === 1) showDropZone();
  });

  panel.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      hideDropZone();
    }
  });

  panel.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  });

  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    hideDropZone();

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      processFiles(files);
    }
  });
};

// ============================================================
// SETUP - Call once from chat/index.js
// ============================================================

export const setupVault = () => {
  // Vault button
  $('vaultBtn')?.addEventListener('click', openVault);

  // Close button
  $('vaultCloseBtn')?.addEventListener('click', closeVault);

  // Select mode toggle
  $('vaultSelectBtn')?.addEventListener('click', toggleSelectMode);

  // Backdrop click
  $('vaultModal')?.querySelector('.vault-backdrop')?.addEventListener('click', closeVault);

  // Tab buttons
  document.querySelectorAll('.vault-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Add media button
  $('vaultAddBtn')?.addEventListener('click', openAddMedia);

  // Drag & drop support
  setupDragAndDrop();

  // Re-render vault when subscriber changes (updates sent badges + sent tab)
  Store.subscribe('currentSubscriberId', () => {
    if (isVaultOpen()) {
      console.log('[Vault] Subscriber changed — refreshing sent status');
      updateSubscriberContext();
      renderVaultGrid();
    }
  });

  // Also listen for subscriberName changes (for the context bar label)
  Store.subscribe('subscriberName', () => {
    if (isVaultOpen()) {
      updateSubscriberContext();
    }
  });
};
