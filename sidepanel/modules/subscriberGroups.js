// ============================================================
// SUBSCRIBER GROUPS — Custom group management for subscribers
// Persistent localStorage storage, integrates with Notes + Broadcast
// ============================================================

import Store from '../state/store.js';
import { $, escapeHtml } from '../utils/dom.js';
import { showNotification } from '../utils/notify.js';

// ============================================================
// CONSTANTS
// ============================================================

const STORAGE_KEY_GROUPS = 'clarity_subscriber_groups';
const STORAGE_KEY_MAP = 'clarity_subscriber_group_map';

const PRESET_COLORS = [
  '#4ade80', // green
  '#38bdf8', // blue
  '#a855f7', // purple
  '#f472b6', // pink
  '#fb923c', // orange
  '#facc15', // yellow
  '#ef4444', // red
  '#2dd4bf', // teal
];

const PRESET_ICONS = ['⭐', '💎', '🔥', '💕', '👑', '🎯', '💰', '🌙', '🦋', '🎀', '🏆', '💫'];

// ============================================================
// DATA LAYER — localStorage backed
// ============================================================

let groups = [];
let groupMap = {}; // { subscriberId: groupId }

/** Load groups + map from localStorage */
const loadData = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_GROUPS);
    groups = raw ? JSON.parse(raw) : [];
  } catch (_) { groups = []; }

  try {
    const raw = localStorage.getItem(STORAGE_KEY_MAP);
    groupMap = raw ? JSON.parse(raw) : {};
  } catch (_) { groupMap = {}; }
};

/** Persist groups to localStorage */
const saveGroups = () => {
  try { localStorage.setItem(STORAGE_KEY_GROUPS, JSON.stringify(groups)); } catch (_) {}
};

/** Persist group map to localStorage */
const saveMap = () => {
  try { localStorage.setItem(STORAGE_KEY_MAP, JSON.stringify(groupMap)); } catch (_) {}
};

// ============================================================
// GROUP CRUD
// ============================================================

/** Get all groups */
export const getGroups = () => [...groups];

/** Get a single group by ID */
export const getGroup = (groupId) => groups.find(g => g.id === groupId) || null;

/** Create a new group */
export const createGroup = (name, color, icon) => {
  const id = `g_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const group = {
    id,
    name: name.trim().slice(0, 30),
    color: color || PRESET_COLORS[groups.length % PRESET_COLORS.length],
    icon: icon || PRESET_ICONS[groups.length % PRESET_ICONS.length],
    createdAt: Date.now()
  };
  groups.push(group);
  saveGroups();
  return group;
};

/** Rename a group */
export const renameGroup = (groupId, newName) => {
  const group = groups.find(g => g.id === groupId);
  if (!group) return false;
  group.name = newName.trim().slice(0, 30);
  saveGroups();
  return true;
};

/** Update group color */
export const updateGroupColor = (groupId, color) => {
  const group = groups.find(g => g.id === groupId);
  if (!group) return false;
  group.color = color;
  saveGroups();
  return true;
};

/** Update group icon */
export const updateGroupIcon = (groupId, icon) => {
  const group = groups.find(g => g.id === groupId);
  if (!group) return false;
  group.icon = icon;
  saveGroups();
  return true;
};

/** Delete a group — removes all subscriber assignments */
export const deleteGroup = (groupId) => {
  groups = groups.filter(g => g.id !== groupId);
  saveGroups();

  // Remove all subscribers from this group
  let changed = false;
  for (const [subId, gId] of Object.entries(groupMap)) {
    if (gId === groupId) {
      delete groupMap[subId];
      changed = true;
    }
  }
  if (changed) saveMap();
  return true;
};

// ============================================================
// SUBSCRIBER ↔ GROUP MAPPING
// ============================================================

/** Assign a subscriber to a group (or null to remove) */
export const setSubscriberGroup = (subscriberId, groupId) => {
  if (!subscriberId) return;
  if (groupId) {
    groupMap[subscriberId] = groupId;
  } else {
    delete groupMap[subscriberId];
  }
  saveMap();
};

/** Get the group for a subscriber (returns group object or null) */
export const getSubscriberGroup = (subscriberId) => {
  if (!subscriberId) return null;
  const groupId = groupMap[subscriberId];
  if (!groupId) return null;
  return groups.find(g => g.id === groupId) || null;
};

/** Get the group ID for a subscriber */
export const getSubscriberGroupId = (subscriberId) => {
  return groupMap[subscriberId] || null;
};

/** Remove a subscriber from their group */
export const removeSubscriberFromGroup = (subscriberId) => {
  if (!subscriberId) return;
  delete groupMap[subscriberId];
  saveMap();
};

/** Get all subscriber IDs in a group */
export const getSubscribersByGroup = (groupId) => {
  return Object.entries(groupMap)
    .filter(([, gId]) => gId === groupId)
    .map(([subId]) => subId);
};

/** Get the full group map (for broadcast filtering) */
export const getGroupMap = () => ({ ...groupMap });

// ============================================================
// NOTES TAB UI — Group picker at top of notes
// ============================================================

/** Render the group picker section in notes tab */
export const renderGroupPicker = () => {
  const container = $('subscriberGroupSection');
  if (!container) return;

  const subscriberId = Store.get('currentSubscriberId');
  const subscriberName = Store.get('subscriberName') || '';

  // No subscriber selected
  if (!subscriberId) {
    container.innerHTML = `
      <div class="sg-section">
        <div class="sg-header">
          <span class="sg-title">👥 Group</span>
          <button class="sg-manage-btn" id="sgManageBtn" title="Manage Groups">⚙️</button>
        </div>
        <div class="sg-empty">No subscriber selected</div>
      </div>
    `;
    $('sgManageBtn')?.addEventListener('click', openGroupManager);
    return;
  }

  const currentGroup = getSubscriberGroup(subscriberId);

  container.innerHTML = `
    <div class="sg-section">
      <div class="sg-header">
        <span class="sg-title">👥 Group</span>
        <button class="sg-manage-btn" id="sgManageBtn" title="Manage Groups">⚙️</button>
      </div>
      <div class="sg-current">
        ${currentGroup
          ? `<span class="sg-badge" style="--sg-color: ${currentGroup.color}">
               <span class="sg-badge-icon">${currentGroup.icon}</span>
               <span class="sg-badge-name">${escapeHtml(currentGroup.name)}</span>
               <button class="sg-badge-remove" id="sgRemoveGroup" title="Remove from group">✕</button>
             </span>`
          : `<span class="sg-no-group">No group assigned</span>`
        }
        <button class="sg-assign-btn" id="sgAssignBtn">
          ${currentGroup ? 'Change' : '+ Assign'}
        </button>
      </div>
    </div>
  `;

  // Bind events
  $('sgManageBtn')?.addEventListener('click', openGroupManager);
  $('sgAssignBtn')?.addEventListener('click', () => openGroupAssignDropdown(subscriberId));
  $('sgRemoveGroup')?.addEventListener('click', () => {
    removeSubscriberFromGroup(subscriberId);
    showNotification('Removed from group');
    renderGroupPicker();
  });
};

/** Dropdown to assign subscriber to a group */
const openGroupAssignDropdown = (subscriberId) => {
  // Remove any existing dropdown
  document.querySelectorAll('.sg-dropdown').forEach(d => d.remove());

  const currentGroupId = getSubscriberGroupId(subscriberId);
  const allGroups = getGroups();

  if (allGroups.length === 0) {
    showNotification('No groups yet — create one first');
    openGroupManager();
    return;
  }

  const dropdown = document.createElement('div');
  dropdown.className = 'sg-dropdown';
  dropdown.innerHTML = `
    ${allGroups.map(g => `
      <button class="sg-dropdown-item ${g.id === currentGroupId ? 'active' : ''}" data-gid="${g.id}" style="--sg-color: ${g.color}">
        <span class="sg-dropdown-icon">${g.icon}</span>
        <span class="sg-dropdown-name">${escapeHtml(g.name)}</span>
        ${g.id === currentGroupId ? '<span class="sg-dropdown-check">✓</span>' : ''}
      </button>
    `).join('')}
    ${currentGroupId ? `
      <button class="sg-dropdown-item sg-dropdown-none" data-gid="">
        <span class="sg-dropdown-icon">🚫</span>
        <span class="sg-dropdown-name">Remove from group</span>
      </button>
    ` : ''}
    <div class="sg-dropdown-divider"></div>
    <button class="sg-dropdown-item sg-dropdown-new" id="sgDropdownNew">
      <span class="sg-dropdown-icon">➕</span>
      <span class="sg-dropdown-name">New Group...</span>
    </button>
  `;

  const assignBtn = $('sgAssignBtn');
  if (assignBtn) {
    const section = $('subscriberGroupSection');
    if (section) section.appendChild(dropdown);
  }

  // Position dropdown
  requestAnimationFrame(() => dropdown.classList.add('open'));

  // Bind group selection
  dropdown.querySelectorAll('.sg-dropdown-item[data-gid]').forEach(item => {
    item.addEventListener('click', () => {
      const gid = item.dataset.gid;
      if (gid) {
        setSubscriberGroup(subscriberId, gid);
        const group = getGroup(gid);
        showNotification(`Assigned to "${group?.name || 'group'}"`);
      } else {
        removeSubscriberFromGroup(subscriberId);
        showNotification('Removed from group');
      }
      dropdown.remove();
      renderGroupPicker();
    });
  });

  // New group from dropdown
  dropdown.querySelector('#sgDropdownNew')?.addEventListener('click', () => {
    dropdown.remove();
    quickCreateGroup(subscriberId);
  });

  // Close on outside click
  const closeDropdown = (e) => {
    if (!dropdown.contains(e.target) && e.target.id !== 'sgAssignBtn') {
      dropdown.remove();
      document.removeEventListener('click', closeDropdown, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeDropdown, true), 0);
};

/** Quick-create a group and assign the current subscriber */
const quickCreateGroup = (subscriberId) => {
  const name = prompt('New group name:');
  if (!name || !name.trim()) return;

  const group = createGroup(name.trim());
  if (subscriberId) {
    setSubscriberGroup(subscriberId, group.id);
  }
  showNotification(`Group "${group.name}" created`);
  renderGroupPicker();
};

// ============================================================
// GROUP MANAGER MODAL — Full CRUD panel
// ============================================================

const openGroupManager = () => {
  // Remove any existing manager
  document.querySelectorAll('.sg-manager-overlay').forEach(m => m.remove());

  const overlay = document.createElement('div');
  overlay.className = 'sg-manager-overlay';
  overlay.innerHTML = `
    <div class="sg-manager">
      <div class="sg-manager-header">
        <h3>👥 Manage Groups</h3>
        <button class="sg-manager-close icon-btn" id="sgManagerClose">✕</button>
      </div>
      <div class="sg-manager-body" id="sgManagerBody">
        <!-- Populated by renderManagerList -->
      </div>
      <div class="sg-manager-footer">
        <button class="btn btn-primary btn-small" id="sgCreateGroupBtn">➕ New Group</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('active'));

  renderManagerList();

  // Close
  const close = () => {
    overlay.classList.remove('active');
    setTimeout(() => overlay.remove(), 200);
    renderGroupPicker(); // Refresh notes picker
  };

  overlay.querySelector('#sgManagerClose')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  // Create button
  overlay.querySelector('#sgCreateGroupBtn')?.addEventListener('click', () => {
    openGroupEditor(null, overlay);
  });
};

/** Render the list inside the manager */
const renderManagerList = () => {
  const body = $('sgManagerBody');
  if (!body) return;

  const allGroups = getGroups();

  if (allGroups.length === 0) {
    body.innerHTML = `
      <div class="sg-manager-empty">
        <span class="sg-manager-empty-icon">👥</span>
        <p>No groups yet</p>
        <small>Create groups to organize your subscribers</small>
      </div>
    `;
    return;
  }

  body.innerHTML = allGroups.map(g => {
    const memberCount = getSubscribersByGroup(g.id).length;
    return `
      <div class="sg-manager-item" data-gid="${g.id}" style="--sg-color: ${g.color}">
        <div class="sg-manager-item-left">
          <span class="sg-manager-icon">${g.icon}</span>
          <div class="sg-manager-info">
            <span class="sg-manager-name">${escapeHtml(g.name)}</span>
            <span class="sg-manager-count">${memberCount} subscriber${memberCount !== 1 ? 's' : ''}</span>
          </div>
        </div>
        <div class="sg-manager-actions">
          <button class="sg-action-btn" data-action="edit" data-gid="${g.id}" title="Edit">✏️</button>
          <button class="sg-action-btn sg-action-danger" data-action="delete" data-gid="${g.id}" title="Delete">🗑️</button>
        </div>
      </div>
    `;
  }).join('');

  // Bind edit/delete
  body.querySelectorAll('.sg-action-btn[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const overlay = document.querySelector('.sg-manager-overlay');
      openGroupEditor(btn.dataset.gid, overlay);
    });
  });

  body.querySelectorAll('.sg-action-btn[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const gid = btn.dataset.gid;
      const group = getGroup(gid);
      const count = getSubscribersByGroup(gid).length;
      const msg = count > 0
        ? `Delete "${group.name}"? ${count} subscriber(s) will be unassigned.`
        : `Delete "${group.name}"?`;
      if (!confirm(msg)) return;
      deleteGroup(gid);
      showNotification(`Group "${group.name}" deleted`);
      renderManagerList();
    });
  });
};

/** Open inline editor for creating/editing a group */
const openGroupEditor = (groupId, overlay) => {
  const body = $('sgManagerBody');
  if (!body) return;

  const existing = groupId ? getGroup(groupId) : null;
  const defaultColor = PRESET_COLORS[groups.length % PRESET_COLORS.length];
  const defaultIcon = PRESET_ICONS[groups.length % PRESET_ICONS.length];

  body.innerHTML = `
    <div class="sg-editor">
      <h4 class="sg-editor-title">${existing ? 'Edit Group' : 'New Group'}</h4>
      <div class="sg-editor-field">
        <label>Name</label>
        <input type="text" id="sgEditorName" class="sg-editor-input" value="${existing ? escapeHtml(existing.name) : ''}" placeholder="Group name..." maxlength="30" autofocus>
      </div>
      <div class="sg-editor-field">
        <label>Color</label>
        <div class="sg-color-grid" id="sgColorGrid">
          ${PRESET_COLORS.map(c => `
            <button class="sg-color-swatch ${(existing?.color || defaultColor) === c ? 'active' : ''}" data-color="${c}" style="background: ${c}"></button>
          `).join('')}
        </div>
      </div>
      <div class="sg-editor-field">
        <label>Icon</label>
        <div class="sg-icon-grid" id="sgIconGrid">
          ${PRESET_ICONS.map(i => `
            <button class="sg-icon-option ${(existing?.icon || defaultIcon) === i ? 'active' : ''}" data-icon="${i}">${i}</button>
          `).join('')}
        </div>
      </div>
      <div class="sg-editor-actions">
        <button class="btn btn-primary btn-small" id="sgEditorSave">${existing ? 'Save' : 'Create'}</button>
        <button class="btn btn-secondary btn-small" id="sgEditorCancel">Cancel</button>
      </div>
    </div>
  `;

  let selectedColor = existing?.color || defaultColor;
  let selectedIcon = existing?.icon || defaultIcon;

  // Color selection
  body.querySelectorAll('.sg-color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      body.querySelectorAll('.sg-color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      selectedColor = swatch.dataset.color;
    });
  });

  // Icon selection
  body.querySelectorAll('.sg-icon-option').forEach(opt => {
    opt.addEventListener('click', () => {
      body.querySelectorAll('.sg-icon-option').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      selectedIcon = opt.dataset.icon;
    });
  });

  // Save
  body.querySelector('#sgEditorSave')?.addEventListener('click', () => {
    const name = body.querySelector('#sgEditorName')?.value?.trim();
    if (!name) {
      showNotification('Enter a group name');
      return;
    }

    if (existing) {
      renameGroup(groupId, name);
      updateGroupColor(groupId, selectedColor);
      updateGroupIcon(groupId, selectedIcon);
      showNotification(`Group "${name}" updated`);
    } else {
      createGroup(name, selectedColor, selectedIcon);
      showNotification(`Group "${name}" created`);
    }
    renderManagerList();
  });

  // Cancel — back to list
  body.querySelector('#sgEditorCancel')?.addEventListener('click', () => {
    renderManagerList();
  });

  // Auto-focus name input
  setTimeout(() => body.querySelector('#sgEditorName')?.focus(), 50);
};

// ============================================================
// INITIALIZATION
// ============================================================

export const initSubscriberGroups = () => {
  loadData();
  console.log(`[Groups] Loaded ${groups.length} groups, ${Object.keys(groupMap).length} assignments`);

  // Re-render group picker when subscriber changes
  Store.subscribe('currentSubscriberId', () => {
    renderGroupPicker();
  });

  Store.subscribe('subscriberName', () => {
    renderGroupPicker();
  });
};

export default {
  getGroups,
  getGroup,
  createGroup,
  renameGroup,
  deleteGroup,
  setSubscriberGroup,
  getSubscriberGroup,
  getSubscriberGroupId,
  removeSubscriberFromGroup,
  getSubscribersByGroup,
  getGroupMap,
  renderGroupPicker,
  initSubscriberGroups
};
