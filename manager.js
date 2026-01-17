import DB from './background/db.js';

const db = new DB();

// Default favicon SVG
const DEFAULT_FAVICON = 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><rect fill=%22%23e5e7eb%22 width=%2216%22 height=%2216%22 rx=%222%22/></svg>';

// State
let allWindows = [];
let allTabs = [];
let selectedWindowId = null; // null means "All Tabs"
let selectedTabIds = new Set();
let currentSearchQuery = '';
let currentSort = 'recent';
let nicknamesMap = new Map();
let draggedTabIds = [];

// Utility Functions
function getSafeFaviconUrl(url) {
  if (!url || url.startsWith('chrome://')) {
    return DEFAULT_FAVICON;
  }
  return url;
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function highlightSearchMatch(text) {
  if (!currentSearchQuery || !text) return escapeHtml(text || '');

  const escaped = escapeHtml(text);
  const query = currentSearchQuery;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');

  return escaped.replace(regex, '<mark class="search-highlight">$1</mark>');
}

function formatLastAccessed(timestamp) {
  if (!timestamp) return '';

  const now = Date.now();
  const diff = now - timestamp;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return new Date(timestamp).toLocaleDateString();
}

function sortTabs(tabs, sortBy) {
  const sorted = [...tabs];
  switch (sortBy) {
    case 'recent':
      sorted.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      break;
    case 'oldest':
      sorted.sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0));
      break;
    case 'az':
      sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      break;
    case 'za':
      sorted.sort((a, b) => (b.title || '').localeCompare(a.title || ''));
      break;
  }
  return sorted;
}

// Get window display name from DB title
function getWindowDisplayName(window) {
  // If window has a title from DB, use it
  if (window.dbTitle) {
    return window.dbTitle;
  }

  return 'Untitled Window';
}

// Theme Management
async function loadTheme() {
  const savedTheme = await db.getSetting('theme');
  const theme = savedTheme || 'dark';
  if (theme === 'dark') {
    document.body.classList.add('dark-mode');
  } else {
    document.body.classList.remove('dark-mode');
  }
}

// Load Nicknames
async function loadNicknames() {
  nicknamesMap.clear();
  try {
    const nicknames = await db.getAllNicknames();
    if (nicknames && nicknames.length > 0) {
      nicknames.forEach(item => {
        nicknamesMap.set(item.url, item.nickname);
      });
    }
  } catch (error) {
    console.error('[TabManager] Failed to load nicknames:', error);
  }
}

// Data Loading
async function loadAllData() {
  try {
    // Get all windows
    const windows = await chrome.windows.getAll({ populate: true });
    allWindows = windows.filter(w => w.type === 'normal');

    // Flatten all tabs
    allTabs = [];
    for (const window of allWindows) {
      for (const tab of window.tabs || []) {
        allTabs.push({
          ...tab,
          windowId: window.id
        });
      }
    }

    // Load window titles from DB
    for (const window of allWindows) {
      try {
        const dbWindow = await db.getWindow(window.id);
        if (dbWindow && dbWindow.title) {
          window.dbTitle = dbWindow.title;
        }
      } catch (e) {
        // Window might not exist in DB yet
      }
    }

    renderSidebar();
    renderTabs();
    updateStats();
  } catch (error) {
    console.error('[TabManager] Failed to load data:', error);
  }
}

// Sidebar Rendering
function renderSidebar() {
  const windowsList = document.getElementById('windows-list');
  const windowCount = document.getElementById('window-count');

  if (!windowsList) return;

  windowCount.textContent = allWindows.length;

  let html = '';

  // "All Tabs" item
  html += `
    <div class="window-item all-tabs ${selectedWindowId === null ? 'active' : ''}" data-window-id="all">
      <svg class="window-item-icon" width="18" height="18" viewBox="0 0 16 16" fill="none">
        <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
        <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
        <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
        <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
      </svg>
      <div class="window-item-info">
        <div class="window-item-name">All Tabs</div>
        <div class="window-item-meta">${allTabs.length} tabs</div>
      </div>
    </div>
  `;

  // Individual windows
  for (const window of allWindows) {
    const tabCount = window.tabs?.length || 0;
    const windowName = getWindowDisplayName(window);
    const isFocused = window.focused;
    const isActive = selectedWindowId === window.id;

    html += `
      <div class="window-item ${isActive ? 'active' : ''}" data-window-id="${window.id}">
        <svg class="window-item-icon" width="18" height="18" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
          <path d="M2 6H14" stroke="currentColor" stroke-width="1.5"/>
          <circle cx="4" cy="4.5" r="0.5" fill="currentColor"/>
          <circle cx="6" cy="4.5" r="0.5" fill="currentColor"/>
        </svg>
        <div class="window-item-info">
          <div class="window-item-name">${escapeHtml(windowName)}</div>
          <div class="window-item-meta">${tabCount} tab${tabCount !== 1 ? 's' : ''}</div>
        </div>
        ${isFocused ? '<span class="window-item-badge">Current</span>' : ''}
        <button class="window-item-close" data-window-id="${window.id}" title="Close window">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M4 4L12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    `;
  }

  windowsList.innerHTML = html;

  // Add click handlers
  windowsList.querySelectorAll('.window-item').forEach(item => {
    item.addEventListener('click', (e) => {
      // Don't select if clicking close button
      if (e.target.closest('.window-item-close')) return;

      const windowId = item.dataset.windowId;
      selectedWindowId = windowId === 'all' ? null : parseInt(windowId);
      selectedTabIds.clear();
      updateSelectionUI();
      renderSidebar();
      renderTabs();
    });
  });

  // Add close button handlers
  windowsList.querySelectorAll('.window-item-close').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const windowId = parseInt(btn.dataset.windowId);
      if (confirm(`Close this window and all its tabs?`)) {
        await chrome.windows.remove(windowId);
        loadAllData();
      }
    });
  });

  // Add drag-over and drop handlers for window items
  windowsList.querySelectorAll('.window-item').forEach(item => {
    const windowId = item.dataset.windowId;

    // Skip "All Tabs" item - can't drop there
    if (windowId === 'all') return;

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('drag-over');
    });

    item.addEventListener('dragleave', (e) => {
      // Only remove if leaving the item entirely
      if (!item.contains(e.relatedTarget)) {
        item.classList.remove('drag-over');
      }
    });

    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');

      const targetWindowId = parseInt(windowId);

      if (draggedTabIds.length === 0) return;

      // Move tabs to target window
      try {
        for (const tabId of draggedTabIds) {
          await chrome.tabs.move(tabId, { windowId: targetWindowId, index: -1 });
        }

        // Clear selection after move
        selectedTabIds.clear();
        updateSelectionUI();

        // Reload data
        loadAllData();
      } catch (error) {
        console.error('[TabManager] Failed to move tabs:', error);
      }
    });
  });
}

// Tabs Rendering
function renderTabs() {
  const tabsList = document.getElementById('tabs-list');
  const contentTitle = document.getElementById('content-title');
  const tabCount = document.getElementById('tab-count');

  if (!tabsList) return;

  // Filter tabs by window
  let tabs = selectedWindowId === null
    ? allTabs
    : allTabs.filter(t => t.windowId === selectedWindowId);

  // Apply search filter
  if (currentSearchQuery) {
    tabs = tabs.filter(tab => {
      const title = (tab.title || '').toLowerCase();
      const url = (tab.url || '').toLowerCase();
      return title.includes(currentSearchQuery) || url.includes(currentSearchQuery);
    });
  }

  // Sort tabs
  tabs = sortTabs(tabs, currentSort);

  // Update header
  if (selectedWindowId === null) {
    contentTitle.textContent = 'All Tabs';
  } else {
    const window = allWindows.find(w => w.id === selectedWindowId);
    contentTitle.textContent = window ? getWindowDisplayName(window) : 'Window';
  }
  tabCount.textContent = `${tabs.length} tab${tabs.length !== 1 ? 's' : ''}`;

  // Render tabs
  if (tabs.length === 0) {
    tabsList.innerHTML = `
      <div class="empty-state">
        <svg class="empty-state-icon" width="48" height="48" viewBox="0 0 48 48" fill="none">
          <rect x="8" y="12" width="32" height="24" rx="2" stroke="currentColor" stroke-width="2"/>
          <path d="M8 18H40" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span>${currentSearchQuery ? 'No tabs match your search' : 'No tabs in this window'}</span>
      </div>
    `;
    return;
  }

  let html = '';

  // Add hint at the top
  html += `
    <div class="tabs-hint">
      <kbd>Shift</kbd>+Click to select tabs, drag to move between windows
    </div>
  `;

  for (const tab of tabs) {
    const isSelected = selectedTabIds.has(tab.id);
    const nickname = nicknamesMap.get(tab.url);
    const displayTitle = nickname || tab.title || 'Untitled';
    const favicon = getSafeFaviconUrl(tab.favIconUrl);

    html += `
      <div class="tab-item ${isSelected ? 'selected' : ''}" data-tab-id="${tab.id}" data-window-id="${tab.windowId}" draggable="true">
        <div class="tab-item-checkbox">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M3 8L6.5 11.5L13 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <img class="tab-item-favicon" src="${favicon}" alt="" onerror="this.src='${DEFAULT_FAVICON}'">
        <div class="tab-item-info">
          <div class="tab-item-title">${highlightSearchMatch(displayTitle)}</div>
          <div class="tab-item-url">${highlightSearchMatch(tab.url || '')}</div>
        </div>
        <div class="tab-item-meta">
          ${tab.pinned ? '<span class="tab-item-badge pinned">Pinned</span>' : ''}
          <span class="tab-item-time">${formatLastAccessed(tab.lastAccessed)}</span>
        </div>
        <button class="tab-item-close" data-tab-id="${tab.id}" title="Close tab">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M4 4L12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    `;
  }

  tabsList.innerHTML = html;

  // Add click handlers for tab items
  tabsList.querySelectorAll('.tab-item').forEach(item => {
    item.addEventListener('click', (e) => {
      // Don't select if clicking close button
      if (e.target.closest('.tab-item-close')) return;

      const tabId = parseInt(item.dataset.tabId);
      const windowId = parseInt(item.dataset.windowId);

      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        // Multi-select mode
        if (selectedTabIds.has(tabId)) {
          selectedTabIds.delete(tabId);
          item.classList.remove('selected');
        } else {
          selectedTabIds.add(tabId);
          item.classList.add('selected');
        }
        updateSelectionUI();
      } else {
        // Single click - focus the tab
        chrome.tabs.update(tabId, { active: true });
        chrome.windows.update(windowId, { focused: true });
      }
    });
  });

  // Add close button handlers
  tabsList.querySelectorAll('.tab-item-close').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tabId = parseInt(btn.dataset.tabId);
      await chrome.tabs.remove(tabId);
      loadAllData();
    });
  });

  // Add drag handlers for tab items
  tabsList.querySelectorAll('.tab-item').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      const tabId = parseInt(item.dataset.tabId);

      // If dragging a selected tab, drag all selected tabs
      if (selectedTabIds.has(tabId) && selectedTabIds.size > 1) {
        draggedTabIds = Array.from(selectedTabIds);
      } else {
        draggedTabIds = [tabId];
      }

      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedTabIds.join(','));
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      draggedTabIds = [];

      // Remove drag-over class from all windows
      document.querySelectorAll('.window-item').forEach(w => {
        w.classList.remove('drag-over');
      });
    });
  });
}

// Update Stats
function updateStats() {
  const windowCount = document.getElementById('window-count');
  if (windowCount) {
    windowCount.textContent = allWindows.length;
  }
}

// Selection UI
function updateSelectionUI() {
  const selectionInfo = document.getElementById('selection-info');
  const selectionCount = document.getElementById('selection-count');
  const closeSelectedBtn = document.getElementById('close-selected-btn');

  if (selectedTabIds.size > 0) {
    selectionInfo?.classList.remove('hidden');
    if (selectionCount) {
      selectionCount.textContent = `${selectedTabIds.size} tab${selectedTabIds.size !== 1 ? 's' : ''} selected`;
    }
    if (closeSelectedBtn) {
      closeSelectedBtn.disabled = false;
    }
  } else {
    selectionInfo?.classList.add('hidden');
    if (closeSelectedBtn) {
      closeSelectedBtn.disabled = true;
    }
  }
}

// Search
function initSearch() {
  const searchInput = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear-btn');

  if (!searchInput) return;

  const updateClearButton = () => {
    if (clearBtn) {
      clearBtn.classList.toggle('hidden', !searchInput.value);
    }
  };

  let debounceTimer;
  searchInput.addEventListener('input', (e) => {
    updateClearButton();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentSearchQuery = e.target.value.trim().toLowerCase();
      renderTabs();
    }, 150);
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      currentSearchQuery = '';
      updateClearButton();
      searchInput.focus();
      renderTabs();
    });
  }
}

// Sort Menu
function initSortMenu() {
  const sortItems = document.querySelectorAll('#sort-menu [data-sort]');
  const sortLabel = document.getElementById('current-sort-label');

  sortItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      currentSort = item.dataset.sort;

      // Update active state
      sortItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      // Update label
      const sortNames = { recent: 'Recent', oldest: 'Oldest', az: 'A-Z', za: 'Z-A' };
      if (sortLabel) {
        sortLabel.textContent = sortNames[currentSort] || 'Recent';
      }

      renderTabs();
    });
  });
}

// Back Button
function initBackButton() {
  const backBtn = document.getElementById('back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      window.close();
    });
  }
}

// Close Selected Button
function initCloseSelectedButton() {
  const closeSelectedBtn = document.getElementById('close-selected-btn');
  const modal = document.getElementById('confirm-modal');
  const modalCancel = document.getElementById('modal-cancel');
  const modalConfirm = document.getElementById('modal-confirm');
  const modalMessage = document.getElementById('modal-message');

  if (closeSelectedBtn) {
    closeSelectedBtn.addEventListener('click', () => {
      if (selectedTabIds.size === 0) return;

      if (modalMessage) {
        modalMessage.textContent = `Are you sure you want to close ${selectedTabIds.size} selected tab${selectedTabIds.size !== 1 ? 's' : ''}?`;
      }
      modal?.classList.remove('hidden');
    });
  }

  if (modalCancel) {
    modalCancel.addEventListener('click', () => {
      modal?.classList.add('hidden');
    });
  }

  if (modalConfirm) {
    modalConfirm.addEventListener('click', async () => {
      const tabIds = Array.from(selectedTabIds);
      await chrome.tabs.remove(tabIds);
      selectedTabIds.clear();
      updateSelectionUI();
      modal?.classList.add('hidden');
      loadAllData();
    });
  }

  // Close modal on overlay click
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
    }
  });
}

// Keyboard Navigation
function initKeyboardNavigation() {
  document.addEventListener('keydown', (e) => {
    // Skip if typing in input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      if (e.key === 'Escape') {
        e.target.blur();
      }
      return;
    }

    if (e.key === 'Escape') {
      if (selectedTabIds.size > 0) {
        selectedTabIds.clear();
        updateSelectionUI();
        renderTabs();
      }
    }
  });
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadTheme();
  await loadNicknames();
  await loadAllData();

  initSearch();
  initSortMenu();
  initBackButton();
  initCloseSelectedButton();
  initKeyboardNavigation();

  // Focus search input
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.focus();

  // Listen for tab changes
  chrome.tabs.onCreated.addListener(loadAllData);
  chrome.tabs.onRemoved.addListener(loadAllData);
  chrome.tabs.onUpdated.addListener(loadAllData);
  chrome.windows.onCreated.addListener(loadAllData);
  chrome.windows.onRemoved.addListener(loadAllData);
});
