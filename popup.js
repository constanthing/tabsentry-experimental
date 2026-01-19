import DB from './background/db.js';
import { checkForRecovery } from './recovery-ui.js';

const db = new DB();

const DEFAULT_FAVICON = 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><rect fill=%22%23e5e7eb%22 width=%2216%22 height=%2216%22 rx=%222%22/></svg>';

function getSafeFaviconUrl(url) {
    if (!url || url.startsWith('chrome://')) {
        return DEFAULT_FAVICON;
    }
    return url;
}
let currentSort = 'recent';
let currentView = 'all';
let currentFilter = null; // null means "All Tabs"

// Built-in Chats filter for the floating chat button
const CHATS_FILTER = {
  id: '__chats__',
  name: 'Chats',
  property: 'url',
  operator: 'includes',
  values: [
    'chatgpt.com',
    'perplexity.ai',
    'wave.ai',
    'claude.ai',
    'gemini.google.com',
    'notebooklm.google.com'
  ]
};
let showTimeAccumulated = true;
let tabTimeData = new Map(); // Map of tabId -> timeAccumulated
let nicknamesMap = new Map(); // Map of url -> nickname
let bookmarkedUrls = new Set(); // Set of bookmarked URLs
let pinnedOnTop = false; // Whether to show pinned tabs at the top in All Tabs view
let currentSearchQuery = ''; // Current search query for filtering tabs
let selectedTabIndex = -1; // Currently selected tab index for keyboard navigation
let selectedTabs = new Set(); // Set of selected tab IDs for multi-select drag

// Context menu state
let contextMenuTabId = null;
let contextMenuTabData = null;

// New window modal state
let newWindowTabsToMove = [];

// Get tabs to move - respects multi-selection
function getTabsToMove() {
  if (selectedTabs.size > 0 && selectedTabs.has(contextMenuTabId)) {
    return Array.from(selectedTabs);
  }
  return [contextMenuTabId];
}

// Get tab data for multiple tab IDs
async function getTabDataForIds(tabIds) {
  const tabs = await chrome.tabs.query({});
  return tabs.filter(tab => tabIds.includes(tab.id));
}

// Chrome tab group colors mapping
const TAB_GROUP_COLORS = {
  grey: '#5f6368',
  blue: '#1a73e8',
  red: '#d93025',
  yellow: '#f9ab00',
  green: '#1e8e3e',
  pink: '#d01884',
  purple: '#9334e6',
  cyan: '#007b83',
  orange: '#e8710a'
};

// Keyboard navigation functions
function getVisibleTabItems() {
  return Array.from(document.querySelectorAll('#tab-list .tab-item'));
}

function updateTabSelection(newIndex) {
  const tabItems = getVisibleTabItems();
  const keyboardHint = document.getElementById('keyboard-nav-hint');

  // Remove selection from all tabs
  tabItems.forEach(item => item.classList.remove('selected'));

  // Clamp index to valid range
  if (tabItems.length === 0) {
    selectedTabIndex = -1;
    keyboardHint?.classList.add('hidden');
    return;
  }

  if (newIndex < 0) {
    selectedTabIndex = -1;
    keyboardHint?.classList.add('hidden');
    return;
  }

  if (newIndex >= tabItems.length) {
    newIndex = tabItems.length - 1;
  }

  selectedTabIndex = newIndex;

  // Add selection to new tab
  if (selectedTabIndex >= 0 && selectedTabIndex < tabItems.length) {
    const selectedItem = tabItems[selectedTabIndex];
    selectedItem.classList.add('selected');
    selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    keyboardHint?.classList.remove('hidden');
  }
}

function activateSelectedTab() {
  const tabItems = getVisibleTabItems();
  if (selectedTabIndex < 0 || selectedTabIndex >= tabItems.length) return;

  const selectedItem = tabItems[selectedTabIndex];
  // Trigger click event to open the tab
  selectedItem.click();
}

function clearTabSelection() {
  const tabItems = getVisibleTabItems();
  tabItems.forEach(item => item.classList.remove('selected'));
  selectedTabIndex = -1;
  document.getElementById('keyboard-nav-hint')?.classList.add('hidden');
}

function clearMultiSelection() {
  selectedTabs.clear();
  document.querySelectorAll('.tab-item.multi-selected').forEach(el => {
    el.classList.remove('multi-selected');
  });
}

function updateMultiSelectInfoBar() {
  const infoBar = document.getElementById('multi-select-info');
  if (!infoBar) return;

  if (selectedTabs.size > 0) {
    const countEl = infoBar.querySelector('.multi-select-count');
    if (countEl) {
      countEl.textContent = `${selectedTabs.size} tab${selectedTabs.size > 1 ? 's' : ''} selected`;
    }
    infoBar.classList.remove('hidden');
  } else {
    infoBar.classList.add('hidden');
  }
}

function initKeyboardNavigation() {
  document.addEventListener('keydown', (e) => {
    const isSearchInput = e.target.classList.contains('search-input');
    const isNavigationKey = ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key);

    // Skip if user is typing in an input field (except navigation keys in search)
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      if (!isSearchInput || !isNavigationKey) {
        return;
      }
    }

    // Skip if modal is open
    const modal = document.getElementById('confirm-modal');
    if (modal && !modal.classList.contains('hidden')) {
      return;
    }

    const tabItems = getVisibleTabItems();
    if (tabItems.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (selectedTabIndex < 0) {
          updateTabSelection(0);
        } else {
          updateTabSelection(selectedTabIndex + 1);
        }
        break;

      case 'ArrowUp':
        e.preventDefault();
        if (selectedTabIndex <= 0) {
          updateTabSelection(0);
        } else {
          updateTabSelection(selectedTabIndex - 1);
        }
        break;

      case 'Enter':
        if (selectedTabIndex >= 0) {
          e.preventDefault();
          activateSelectedTab();
        }
        break;

      case 'Escape':
        e.preventDefault();
        if (selectedTabs.size > 0) {
          clearMultiSelection();
          updateMultiSelectInfoBar();
        } else if (selectedTabIndex >= 0) {
          clearTabSelection();
        }
        break;
    }
  });
}

// Close window modal state
let pendingWindowId = null;
let pendingWindowElement = null;

function showCloseWindowModal(windowId, tabCount, windowElement) {
  pendingWindowId = windowId;
  pendingWindowElement = windowElement;
  const modal = document.getElementById('confirm-modal');
  const tabCountEl = document.getElementById('modal-tab-count');
  tabCountEl.textContent = tabCount;
  modal.classList.remove('hidden');
}

function hideCloseWindowModal() {
  const modal = document.getElementById('confirm-modal');
  modal.classList.add('hidden');
  pendingWindowId = null;
  pendingWindowElement = null;
}

function initCloseWindowModal() {
  const modal = document.getElementById('confirm-modal');
  const cancelBtn = document.getElementById('modal-cancel');
  const confirmBtn = document.getElementById('modal-confirm');

  cancelBtn.addEventListener('click', hideCloseWindowModal);

  confirmBtn.addEventListener('click', async () => {
    if (pendingWindowId !== null) {
      await chrome.windows.remove(pendingWindowId);
      hideCloseWindowModal();
      // Reload the view to update the pinned tabs container
      // (pinned tabs from the closed window need to be removed)
      if (currentView === 'windows') {
        loadWindowsView();
      } else {
        loadTabs();
      }
    }
  });

  // Close on overlay click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      hideCloseWindowModal();
    }
  });

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      hideCloseWindowModal();
    }
  });
}

// History pagination state
const HISTORY_PAGE_SIZE = 50;
let historyEndTime = Date.now();
let isLoadingHistory = false;
let hasMoreHistory = true;
let displayedUrls = new Set(); // Track all displayed URLs to prevent duplicates

// Listen for anchor recovery completion to reload the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANCHOR_RESTORED') {
    console.log('[TabSentry] Anchor restored, reloading popup...');
    location.reload();
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  // Load and apply theme
  await loadTheme();

  // Show welcome modal for first-time users
  await initWelcomeModal();

  // Load showTimeAccumulated setting
  const savedShowTime = await db.getSetting('showTimeAccumulated');
  showTimeAccumulated = savedShowTime !== undefined ? savedShowTime : true;

  const savedSort = await db.getSetting('sortPreference');
  currentSort = savedSort || 'recent';

  const savedView = await db.getSetting('viewPreference');
  currentView = savedView || 'all';

  const savedPinnedOnTop = await db.getSetting('pinnedOnTop');
  pinnedOnTop = savedPinnedOnTop || false;

  updateSortMenuSelection();
  updateViewMenuSelection();
  initSortMenu();
  initViewMenu();
  initInfiniteScroll();
  initCloseWindowModal();
  initWindowsViewButtons();
  await loadFilterMenu();
  initFilterMenu();
  initChatButton();
  initSearch();
  initKeyboardNavigation();
  initSmartOrganizerBanner();
  initContextMenu();
  initExpandButton();

  // Focus search input by default
  const searchInput = document.querySelector('.search-input');
  if (searchInput) searchInput.focus();
  // Initialize filter label
  const filterLabel = document.getElementById('current-filter-label');
  if (filterLabel) filterLabel.innerHTML = '<i class="fa-regular fa-filter-slash filter-label-icon"></i>None';
  loadCurrentView();

  // Reload view when a window is removed (closed from outside popup)
  chrome.windows.onRemoved.addListener(() => {
    loadCurrentView();
  });

  // Check for session recovery
  checkForRecovery();
});

// Initialize view-specific buttons
function initWindowsViewButtons() {
  // --- All Tabs View Buttons ---
  const pinnedOnTopBtn = document.getElementById('pinned-on-top-btn');
  const pinnedOnTopBtnWindows = document.getElementById('pinned-on-top-btn-windows');

  // Set initial button states from loaded setting
  pinnedOnTopBtn?.classList.toggle('active', pinnedOnTop);
  pinnedOnTopBtnWindows?.classList.toggle('active', pinnedOnTop);

  // Pinned Tabs on Top toggle
  pinnedOnTopBtn?.addEventListener('click', async () => {
    pinnedOnTop = !pinnedOnTop;
    pinnedOnTopBtn.classList.toggle('active', pinnedOnTop);
    pinnedOnTopBtnWindows?.classList.toggle('active', pinnedOnTop);
    await db.setSetting('pinnedOnTop', pinnedOnTop);
    loadTabs(); // Reload to apply the change
  });

  // --- Windows View Buttons ---

  // Pinned Tabs on Top toggle for Windows view
  pinnedOnTopBtnWindows?.addEventListener('click', async () => {
    pinnedOnTop = !pinnedOnTop;
    pinnedOnTopBtnWindows.classList.toggle('active', pinnedOnTop);
    pinnedOnTopBtn?.classList.toggle('active', pinnedOnTop);
    await db.setSetting('pinnedOnTop', pinnedOnTop);
    loadWindowsView(); // Reload to apply the change
  });
  const collapseAllBtn = document.getElementById('collapse-all-btn');
  const expandAllBtn = document.getElementById('expand-all-btn');
  const showPinnedBtn = document.getElementById('show-pinned-btn');
  const showSavedBtn = document.getElementById('show-saved-btn');

  // Collapse All windows
  collapseAllBtn?.addEventListener('click', () => {
    const windowGroups = document.querySelectorAll('.window-group');
    windowGroups.forEach(group => group.classList.add('collapsed'));
  });

  // Expand All windows
  expandAllBtn?.addEventListener('click', () => {
    const windowGroups = document.querySelectorAll('.window-group');
    windowGroups.forEach(group => group.classList.remove('collapsed'));
  });

  // Show Pinned Window (scroll to/highlight window with pinned tabs)
  showPinnedBtn?.addEventListener('click', () => {
    const pinnedTabs = document.querySelectorAll('.tab-item.pinned-tab');
    if (pinnedTabs.length > 0) {
      // Find the window group containing pinned tabs
      const windowGroup = pinnedTabs[0].closest('.window-group');
      if (windowGroup) {
        windowGroup.classList.remove('collapsed');
        windowGroup.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Flash highlight effect
        windowGroup.style.transition = 'box-shadow 0.3s';
        windowGroup.style.boxShadow = '0 0 0 2px var(--primary-color)';
        setTimeout(() => {
          windowGroup.style.boxShadow = '';
        }, 1500);
      }
    }
  });

  // Show Saved Windows
  showSavedBtn?.addEventListener('click', async () => {
    await showSavedWindowsModal();
  });

}

// Initialize Smart Window Organizer banner
async function initSmartOrganizerBanner() {
  const banner = document.getElementById('smart-organizer-banner');
  if (!banner) return;

  // Check if smart organizer is enabled
  const smartOrganizerEnabled = await db.getSetting('smartOrganizerEnabled');

  if (smartOrganizerEnabled) {
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  // Click handler to open smart organizer settings
  banner.addEventListener('click', () => {
    window.location.href = 'settings.html#smart-organizer';
  });

  // Keyboard accessibility
  banner.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      window.location.href = 'settings.html#smart-organizer';
    }
  });
}

// Initialize Welcome Modal for first-time users
async function initWelcomeModal() {
  const modal = document.getElementById('welcome-modal');
  if (!modal) return;

  // Check if user has already seen the welcome modal
  const hasSeenWelcome = await db.getSetting('hasSeenWelcomeModal');
  if (hasSeenWelcome) return;

  // Show the modal
  modal.classList.remove('hidden');

  const dismissBtn = document.getElementById('welcome-dismiss');

  const dismissModal = async () => {
    modal.classList.add('hidden');
    await db.setSetting('hasSeenWelcomeModal', true);
  };

  // Dismiss on button click
  dismissBtn?.addEventListener('click', dismissModal);

  // Dismiss on overlay click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      dismissModal();
    }
  });

  // Dismiss on Escape key
  const handleEscape = (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      dismissModal();
      document.removeEventListener('keydown', handleEscape);
    }
  };
  document.addEventListener('keydown', handleEscape);
}

async function loadTheme() {
  const savedTheme = await db.getSetting('theme');
  const theme = savedTheme || 'dark';
  if (theme === 'dark') {
    document.body.classList.add('dark-mode');
  } else {
    document.body.classList.remove('dark-mode');
  }
}

async function loadTabTimeData() {
  tabTimeData.clear();
  const allDbTabs = await db.getNonOrphanTabs();
  allDbTabs.forEach(tab => {
    tabTimeData.set(tab.id, tab.timeAccumulated || 0);
  });
}

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
    console.error('[TabSentry] Failed to load nicknames:', error);
  }
}

async function loadBookmarkedUrls() {
  bookmarkedUrls.clear();
  try {
    const bookmarks = await chrome.bookmarks.search({});
    bookmarks.forEach(bookmark => {
      if (bookmark.url) {
        bookmarkedUrls.add(bookmark.url);
      }
    });
  } catch (error) {
    console.error('[TabSentry] Failed to load bookmarks:', error);
  }
}

// Sync all Chrome bookmarks to the database with folder paths
async function syncBookmarksToDatabase() {
  try {
    const tree = await chrome.bookmarks.getTree();
    const bookmarksArray = [];

    // Recursively traverse bookmark tree
    function traverseNode(node, folderPath = '') {
      if (node.url) {
        // This is a bookmark (not a folder)
        bookmarksArray.push({
          url: node.url,
          bookmarkId: node.id,
          title: node.title || '',
          parentId: node.parentId || '',
          folderPath: folderPath,
          dateAdded: node.dateAdded || Date.now()
        });
      }

      if (node.children) {
        // This is a folder - traverse children
        const newPath = node.title
          ? (folderPath ? `${folderPath}/${node.title}` : node.title)
          : folderPath;

        for (const child of node.children) {
          traverseNode(child, newPath);
        }
      }
    }

    // Start traversal from root nodes
    for (const root of tree) {
      traverseNode(root, '');
    }

    // Sync to database
    await db.syncBookmarks(bookmarksArray);
    console.log(`[TabSentry] Synced ${bookmarksArray.length} bookmarks to database`);
    return bookmarksArray;
  } catch (error) {
    console.error('[TabSentry] Failed to sync bookmarks:', error);
    return [];
  }
}

function formatTimeAccumulated(ms) {
  if (!ms || ms <= 0) return '0m';

  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function initSortMenu() {
  const sortItems = document.querySelectorAll('#sort-menu [data-sort]');
  sortItems.forEach(item => {
    item.addEventListener('click', async (e) => {
      e.preventDefault();
      const sortValue = item.dataset.sort;
      currentSort = sortValue;
      await db.setSetting('sortPreference', sortValue);
      updateSortMenuSelection();
      loadCurrentView();
    });
  });
}

function updateSortMenuSelection() {
  const sortItems = document.querySelectorAll('#sort-menu [data-sort]');
  sortItems.forEach(item => {
    item.classList.toggle('active', item.dataset.sort === currentSort);
  });

  // Update sort label with icon
  const sortLabel = document.getElementById('current-sort-label');
  if (sortLabel) {
    const sortConfig = {
      'recent': { icon: 'fa-arrow-up', name: 'Recent' },
      'oldest': { icon: 'fa-arrow-down', name: 'Oldest' },
      'az': { icon: 'fa-arrow-down-a-z', name: 'A-Z' },
      'za': { icon: 'fa-arrow-up-z-a', name: 'Z-A' }
    };
    const config = sortConfig[currentSort] || sortConfig['recent'];
    sortLabel.innerHTML = `<i class="fa-regular ${config.icon} sort-label-icon"></i>${config.name}`;
  }
}

function initViewMenu() {
  const viewItems = document.querySelectorAll('#view-menu [data-view]');
  viewItems.forEach(item => {
    item.addEventListener('click', async (e) => {
      e.preventDefault();
      const viewValue = item.dataset.view;
      currentView = viewValue;
      await db.setSetting('viewPreference', viewValue);
      updateViewMenuSelection();
      loadCurrentView();
    });
  });
}

function updateViewMenuSelection() {
  const viewItems = document.querySelectorAll('#view-menu [data-view]');
  viewItems.forEach(item => {
    item.classList.toggle('active', item.dataset.view === currentView);
  });

  // Update view label with icon
  const viewLabel = document.getElementById('current-view-label');
  if (viewLabel) {
    const viewConfig = {
      'all': { icon: 'fa-grid-2', name: 'All Tabs' },
      'windows': { icon: 'fa-window-restore', name: 'Windows' },
      'bookmarked': { icon: 'fa-bookmark', name: 'Bookmarked' },
      'nicknamed': { icon: 'fa-at', name: 'Nicknamed' }
    };
    const config = viewConfig[currentView] || viewConfig['all'];
    viewLabel.innerHTML = `<i class="fa-regular ${config.icon} view-label-icon"></i>${config.name}`;
  }
}

// Filter menu functions
async function loadFilterMenu() {
  const customFiltersList = document.getElementById('custom-filters-list');
  if (!customFiltersList) return;

  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ALL_FILTERS' });
    if (response.success && response.filters.length > 0) {
      customFiltersList.innerHTML = response.filters.map(filter => `
        <a href="#" class="dropdown-item" data-filter-id="${filter.id}">
          <svg class="menu-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2 4H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M4 8H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M6 12H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <span>${escapeHtml(filter.name)}</span>
        </a>
      `).join('');
    } else {
      customFiltersList.innerHTML = '<span class="dropdown-hint">No custom filters</span>';
    }
  } catch (e) {
    console.error('[TabSentry] Failed to load filters:', e);
    customFiltersList.innerHTML = '<span class="dropdown-hint">Error loading filters</span>';
  }
}

// Update filter banner visibility and text
function updateFilterBanner(filterName = null) {
  const banner = document.getElementById('filter-banner');
  const nameSpan = document.getElementById('filter-banner-name');
  if (!banner) return;

  if (filterName) {
    if (nameSpan) nameSpan.textContent = filterName;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

// Clear filter helper (used by banner clear button)
function clearFilter() {
  const filterMenu = document.getElementById('filter-menu');
  const filterLabel = document.getElementById('current-filter-label');
  const chatBtn = document.getElementById('chat-fab');

  currentFilter = null;
  if (filterLabel) filterLabel.innerHTML = '<i class="fa-regular fa-filter-slash filter-label-icon"></i>None';
  if (chatBtn) chatBtn.classList.remove('active');

  // Reset filter menu active state to "None"
  if (filterMenu) {
    filterMenu.querySelectorAll('.dropdown-item').forEach(el => el.classList.remove('active'));
    const noneItem = filterMenu.querySelector('[data-filter="all"]');
    if (noneItem) noneItem.classList.add('active');
  }

  updateFilterBanner(null);
  loadCurrentView();
}

function initFilterMenu() {
  const filterMenu = document.getElementById('filter-menu');
  if (!filterMenu) return;

  // Initialize filter banner clear button
  const clearBtn = document.getElementById('filter-banner-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', clearFilter);
  }

  filterMenu.addEventListener('click', async (e) => {
    e.preventDefault();
    const item = e.target.closest('.dropdown-item');
    if (!item) return;

    // Update active state
    filterMenu.querySelectorAll('.dropdown-item').forEach(el => el.classList.remove('active'));
    item.classList.add('active');

    // Clear chat button active state when selecting from dropdown
    const chatBtn = document.getElementById('chat-fab');
    if (chatBtn) chatBtn.classList.remove('active');

    const filterId = item.dataset.filterId;
    const filterLabel = document.getElementById('current-filter-label');

    if (item.dataset.filter === 'all') {
      currentFilter = null;
      if (filterLabel) filterLabel.innerHTML = '<i class="fa-regular fa-filter-slash filter-label-icon"></i>None';
      updateFilterBanner(null);
    } else if (filterId) {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_FILTER',
        filterId: parseInt(filterId)
      });
      if (response.success) {
        currentFilter = response.filter;
        if (filterLabel) filterLabel.innerHTML = `<i class="fa-regular fa-filter filter-label-icon"></i>${escapeHtml(response.filter.name)}`;
        updateFilterBanner(response.filter.name);
      }
    }

    // Reload current view with filter applied
    loadCurrentView();
  });
}

// Chat button initialization
function initChatButton() {
  const chatBtn = document.getElementById('chat-fab');
  if (!chatBtn) return;

  chatBtn.addEventListener('click', () => {
    const filterMenu = document.getElementById('filter-menu');
    const filterLabel = document.getElementById('current-filter-label');

    // Toggle chats filter
    if (currentFilter && currentFilter.id === CHATS_FILTER.id) {
      // Turn off - reset to no filter
      currentFilter = null;
      chatBtn.classList.remove('active');
      if (filterLabel) filterLabel.innerHTML = '<i class="fa-regular fa-filter-slash filter-label-icon"></i>None';
      updateFilterBanner(null);

      // Reset filter menu active state to "None"
      if (filterMenu) {
        filterMenu.querySelectorAll('.dropdown-item').forEach(el => el.classList.remove('active'));
        const noneItem = filterMenu.querySelector('[data-filter="all"]');
        if (noneItem) noneItem.classList.add('active');
      }
    } else {
      // Turn on - apply chats filter
      currentFilter = CHATS_FILTER;
      chatBtn.classList.add('active');
      if (filterLabel) filterLabel.innerHTML = '<i class="fa-regular fa-comment-dots filter-label-icon"></i>Chats';
      updateFilterBanner('Chats');

      // Clear filter menu active state (chats filter is separate)
      if (filterMenu) {
        filterMenu.querySelectorAll('.dropdown-item').forEach(el => el.classList.remove('active'));
      }
    }

    loadCurrentView();
  });
}

// Expand button - opens full page manager
function initExpandButton() {
  const expandBtn = document.getElementById('expand-btn');
  if (!expandBtn) return;

  expandBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') });
    window.close();
  });
}

// Filter matching logic (simplified version for popup)
function normalizeUrl(url) {
  if (!url) return '';
  return url
    .replace(/^https?:\/\//, '')
    .replace(/\/\*$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function matchTabWithFilter(tab, filter) {
  if (!filter) return true; // No filter = match all

  const { property, operator, value, values } = filter;

  // Support both single value and array of values
  const valueList = values && Array.isArray(values) && values.length > 0
    ? values
    : (value ? [value] : []);

  if (valueList.length === 0) return true;

  let tabValue;
  if (property === 'url') {
    tabValue = normalizeUrl(tab.url);
  } else if (property === 'title') {
    tabValue = (tab.title || '').toLowerCase();
  } else {
    return true;
  }

  // Check if any value in the list matches (OR logic)
  return valueList.some(val => {
    const filterValue = property === 'url'
      ? normalizeUrl(val)
      : val.toLowerCase();

    if (operator === 'equals') {
      return tabValue === filterValue;
    } else if (operator === 'includes') {
      return tabValue.includes(filterValue);
    }
    return false;
  });
}

function applyFilter(tabs) {
  if (!currentFilter) return tabs;
  return tabs.filter(tab => matchTabWithFilter(tab, currentFilter));
}

// Search functionality
function initSearch() {
  const searchInput = document.querySelector('.search-input');
  const clearBtn = document.querySelector('.search-clear-btn');
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
      loadCurrentView();
    }, 150); // Debounce for 150ms
  });

  // Handle Escape: deselect tab first, then clear search, then allow popup close
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Priority 1: Deselect tab if selected
      if (selectedTabIndex >= 0) {
        e.preventDefault();
        e.stopPropagation();
        clearTabSelection();
        return;
      }
      // Priority 2: Clear search if has text
      if (searchInput.value) {
        e.preventDefault();
        e.stopPropagation();
        searchInput.value = '';
        currentSearchQuery = '';
        updateClearButton();
        loadCurrentView();
        return;
      }
      // Priority 3: No selection, no search - allow default (popup close)
    }
  });

  // Clear button click handler
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      currentSearchQuery = '';
      updateClearButton();
      searchInput.focus();
      loadCurrentView();
    });
  }
}

function matchesSearchQuery(item) {
  if (!currentSearchQuery) return true;

  const title = (item.title || '').toLowerCase();
  const url = (item.url || '').toLowerCase();

  return title.includes(currentSearchQuery) || url.includes(currentSearchQuery);
}

function applySearch(tabs) {
  if (!currentSearchQuery) return tabs;
  return tabs.filter(matchesSearchQuery);
}

function highlightSearchMatch(text) {
  if (!currentSearchQuery || !text) return escapeHtml(text || '');

  const escaped = escapeHtml(text);
  const query = currentSearchQuery;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');

  return escaped.replace(regex, '<mark class="search-highlight">$1</mark>');
}

function loadCurrentView() {
  // Reset keyboard selection when view changes
  selectedTabIndex = -1;
  // Clear multi-selection when view changes
  clearMultiSelection();
  updateMultiSelectInfoBar();

  const tabList = document.getElementById('tab-list');
  tabList.classList.remove('view-windows', 'view-all');
  tabList.classList.add(`view-${currentView}`);

  // Show/hide view-specific buttons based on current view
  const windowsViewButtons = document.getElementById('windows-view-buttons');
  const allTabsViewButtons = document.getElementById('all-tabs-view-buttons');

  if (windowsViewButtons) {
    windowsViewButtons.style.display = currentView === 'windows' ? 'flex' : 'none';
  }
  if (allTabsViewButtons) {
    allTabsViewButtons.style.display = currentView === 'all' ? 'flex' : 'none';
  }

  switch (currentView) {
    case 'windows':
      loadWindowsView();
      break;
    case 'bookmarked':
      loadBookmarkedView();
      break;
    case 'nicknamed':
      loadNicknamedView();
      break;
    case 'all':
    default:
      loadTabs();
      break;
  }
}

function initInfiniteScroll() {
  const mainContent = document.querySelector('.main-content');
  mainContent.addEventListener('scroll', () => {
    // Only load more history in 'all' view, not in 'windows' view
    if (currentView === 'windows') return;
    if (isLoadingHistory || !hasMoreHistory) return;

    const { scrollTop, scrollHeight, clientHeight } = mainContent;
    // Load more when user scrolls to within 100px of the bottom
    if (scrollTop + clientHeight >= scrollHeight - 100) {
      loadMoreHistory();
    }
  });
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

async function loadTabs() {
  const tabList = document.getElementById('tab-list');

  // Reset history pagination state
  historyEndTime = Date.now();
  hasMoreHistory = true;
  isLoadingHistory = false;
  displayedUrls = new Set();

  try {
    // Load time accumulated data if setting is enabled
    if (showTimeAccumulated) {
      await loadTabTimeData();
    }

    // Load nicknames
    await loadNicknames();

    // Load bookmarked URLs
    await loadBookmarkedUrls();

    let tabs = await chrome.tabs.query({});

    // Store open tab URLs to prevent duplicates in history
    tabs.forEach(tab => displayedUrls.add(tab.url));

    // Apply filter and search
    tabs = applyFilter(tabs);
    tabs = applySearch(tabs);

    tabs = sortTabs(tabs, currentSort);

    // If pinnedOnTop is enabled, move pinned tabs to the top while preserving sort order
    if (pinnedOnTop) {
      const pinnedTabs = tabs.filter(tab => tab.pinned);
      const unpinnedTabs = tabs.filter(tab => !tab.pinned);
      tabs = [...pinnedTabs, ...unpinnedTabs];
    }

    tabList.innerHTML = '';

    // Render open tabs
    tabs.forEach(tab => {
      const tabItem = document.createElement('div');
      tabItem.className = 'tab-item';
      if (tab.pinned) tabItem.classList.add('pinned-tab');

      const lastAccessed = tab.lastAccessed
        ? formatLastAccessed(tab.lastAccessed)
        : 'N/A';

      const favicon = getSafeFaviconUrl(tab.favIconUrl);

      const timeAccumulated = showTimeAccumulated ? tabTimeData.get(tab.id) || 0 : 0;
      const timeAccumulatedHtml = showTimeAccumulated
        ? `<span class="tab-time-accumulated" title="Time accumulated">${formatTimeAccumulated(timeAccumulated)}</span>`
        : '';

      const pinIconHtml = tab.pinned
        ? '<svg class="pin-icon" width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M9.5 2L14 6.5L12 8.5L12.5 12.5L8 8L3.5 12.5L4 8.5L2 6.5L6.5 2L8 3.5L9.5 2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'
        : '';

      const isBookmarked = bookmarkedUrls.has(tab.url);
      const bookmarkIconHtml = isBookmarked
        ? '<svg class="bookmark-icon" width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M4 2.5H12C12.2761 2.5 12.5 2.72386 12.5 3V13.5L8 10.5L3.5 13.5V3C3.5 2.72386 3.72386 2.5 4 2.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'
        : '';

      const audibleIconHtml = tab.audible
        ? '<svg class="audible-icon" width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M8 3L4 6H2V10H4L8 13V3Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M11 5.5C11.8 6.3 12 7.1 12 8C12 8.9 11.8 9.7 11 10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13 3.5C14.3 4.8 15 6.4 15 8C15 9.6 14.3 11.2 13 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
        : '';

      const nickname = nicknamesMap.get(tab.url);
      const nicknameHtml = nickname
        ? `<span class="tab-nickname">${highlightSearchMatch(nickname)}</span>`
        : '';

      tabItem.innerHTML = `
        ${pinIconHtml}
        ${bookmarkIconHtml}
        ${audibleIconHtml}
        <img class="tab-favicon" src="${favicon}" alt="">
        ${nicknameHtml}
        <span class="tab-title">${highlightSearchMatch(tab.title || 'Untitled')}</span>
        <span class="tab-url">${highlightSearchMatch(truncateUrl(tab.url))}</span>
        ${timeAccumulatedHtml}
        <span class="tab-last-accessed">${lastAccessed}</span>
      `;

      const faviconImg = tabItem.querySelector('.tab-favicon');
      if (faviconImg) {
        faviconImg.addEventListener('error', () => { faviconImg.src = DEFAULT_FAVICON; }, { once: true });
      }

      tabItem.addEventListener('click', () => {
        chrome.tabs.update(tab.id, { active: true });
        chrome.windows.update(tab.windowId, { focused: true });
      });

      // Right-click context menu
      tabItem.addEventListener('contextmenu', (e) => {
        handleTabRightClick(e, tab);
      });

      tabList.appendChild(tabItem);
    });

    // Update stats
    updateStats(tabs);

    // Load closed tabs (history) after open tabs
    await loadMoreHistory();
  } catch (error) {
    tabList.innerHTML = `<div class="empty-state">Error loading tabs: ${error.message}</div>`;
  }
}

async function loadBookmarkedView() {
  const tabList = document.getElementById('tab-list');
  tabList.innerHTML = '<div class="loading-state">Loading bookmarks...</div>';

  try {
    // Sync bookmarks from Chrome to database
    await syncBookmarksToDatabase();

    // Load nicknames
    await loadNicknames();

    // Get all bookmarks from database
    let bookmarks = await db.getAllBookmarks();

    // Get currently open tabs to check which bookmarks are open
    const openTabs = await chrome.tabs.query({});
    const openTabsByUrl = new Map();
    openTabs.forEach(tab => {
      openTabsByUrl.set(tab.url, tab);
    });

    // Apply search filter
    if (currentSearchQuery) {
      const query = currentSearchQuery.toLowerCase();
      bookmarks = bookmarks.filter(bookmark =>
        (bookmark.title && bookmark.title.toLowerCase().includes(query)) ||
        (bookmark.url && bookmark.url.toLowerCase().includes(query)) ||
        (bookmark.folderPath && bookmark.folderPath.toLowerCase().includes(query))
      );
    }

    // Apply current filter
    if (currentFilter) {
      bookmarks = bookmarks.filter(bookmark => matchTabWithFilter(bookmark, currentFilter));
    }

    // Sort bookmarks
    bookmarks = sortBookmarks(bookmarks, currentSort);

    tabList.innerHTML = '';

    if (bookmarks.length === 0) {
      tabList.innerHTML = '<div class="empty-state">No bookmarks found</div>';
      updateBookmarkStats(0);
      return;
    }

    // Render all bookmarks
    bookmarks.forEach(bookmark => {
      const tabItem = document.createElement('div');
      tabItem.className = 'tab-item bookmark-item';

      const openTab = openTabsByUrl.get(bookmark.url);
      const isOpen = !!openTab;
      if (isOpen) tabItem.classList.add('bookmark-open');

      const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(bookmark.url).hostname)}&sz=32`;

      const bookmarkIconHtml = '<svg class="bookmark-icon" width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M4 2.5H12C12.2761 2.5 12.5 2.72386 12.5 3V13.5L8 10.5L3.5 13.5V3C3.5 2.72386 3.72386 2.5 4 2.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';

      const openIndicatorHtml = isOpen
        ? '<svg class="open-indicator" width="10" height="10" viewBox="0 0 16 16" fill="none" title="Currently open"><circle cx="8" cy="8" r="4" fill="var(--success-color, #22c55e)"/></svg>'
        : '';

      const nickname = nicknamesMap.get(bookmark.url);
      const nicknameHtml = nickname
        ? `<span class="tab-nickname">${highlightSearchMatch(nickname)}</span>`
        : '';

      const folderPathHtml = bookmark.folderPath
        ? `<span class="bookmark-folder-path" title="${escapeHtml(bookmark.folderPath)}">${highlightSearchMatch(bookmark.folderPath)}</span>`
        : '';

      const dateAdded = bookmark.dateAdded
        ? formatLastAccessed(bookmark.dateAdded)
        : '';

      tabItem.innerHTML = `
        ${bookmarkIconHtml}
        ${openIndicatorHtml}
        <img class="tab-favicon" src="${favicon}" alt="">
        ${nicknameHtml}
        <span class="tab-title">${highlightSearchMatch(bookmark.title || 'Untitled')}</span>
        <span class="tab-url">${highlightSearchMatch(truncateUrl(bookmark.url))}</span>
        ${folderPathHtml}
        <span class="tab-last-accessed">${dateAdded}</span>
      `;

      const faviconImg = tabItem.querySelector('.tab-favicon');
      if (faviconImg) {
        faviconImg.addEventListener('error', () => { faviconImg.src = DEFAULT_FAVICON; }, { once: true });
      }

      tabItem.addEventListener('click', () => {
        if (isOpen && openTab) {
          // Switch to the open tab
          chrome.tabs.update(openTab.id, { active: true });
          chrome.windows.update(openTab.windowId, { focused: true });
        } else {
          // Open bookmark in new tab
          chrome.tabs.create({ url: bookmark.url });
        }
      });

      // Right-click context menu - pass bookmark data as tab-like object
      tabItem.addEventListener('contextmenu', (e) => {
        const tabLikeData = {
          id: openTab?.id || null,
          url: bookmark.url,
          title: bookmark.title,
          favIconUrl: favicon,
          pinned: openTab?.pinned || false,
          windowId: openTab?.windowId || null
        };
        handleTabRightClick(e, tabLikeData);
      });

      tabList.appendChild(tabItem);
    });

    // Update stats for bookmarks view
    updateBookmarkStats(bookmarks.length);
  } catch (error) {
    console.error('[TabSentry] Error loading bookmarks:', error);
    tabList.innerHTML = `<div class="empty-state">Error loading bookmarks: ${error.message}</div>`;
  }
}

function sortBookmarks(bookmarks, sortBy) {
  const sorted = [...bookmarks];
  switch (sortBy) {
    case 'recent':
      sorted.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
      break;
    case 'oldest':
      sorted.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
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

function updateBookmarkStats(count) {
  const tabsCount = document.querySelectorAll('.stat-value')[1];
  if (tabsCount) tabsCount.textContent = count;
}

async function loadNicknamedView() {
  const tabList = document.getElementById('tab-list');
  tabList.innerHTML = '<div class="loading-state">Loading nicknamed tabs...</div>';

  try {
    // Load all nicknames from database
    const nicknames = await db.getAllNicknames();

    // Get currently open tabs to check which nicknamed URLs are open
    const openTabs = await chrome.tabs.query({});
    const openTabsByUrl = new Map();
    openTabs.forEach(tab => {
      openTabsByUrl.set(tab.url, tab);
    });

    // Load bookmarked URLs for bookmark indicator
    await loadBookmarkedUrls();

    // Apply search filter
    let filteredNicknames = nicknames;
    if (currentSearchQuery) {
      const query = currentSearchQuery.toLowerCase();
      filteredNicknames = nicknames.filter(item =>
        (item.nickname && item.nickname.toLowerCase().includes(query)) ||
        (item.url && item.url.toLowerCase().includes(query))
      );
    }

    // Apply current filter
    if (currentFilter) {
      filteredNicknames = filteredNicknames.filter(item => matchTabWithFilter(item, currentFilter));
    }

    // Sort nicknames
    filteredNicknames = sortNicknames(filteredNicknames, currentSort);

    tabList.innerHTML = '';

    if (filteredNicknames.length === 0) {
      tabList.innerHTML = '<div class="empty-state">No nicknamed tabs found</div>';
      updateNicknameStats(0);
      return;
    }

    // Render all nicknamed items
    filteredNicknames.forEach(item => {
      const tabItem = document.createElement('div');
      tabItem.className = 'tab-item nicknamed-item';

      const openTab = openTabsByUrl.get(item.url);
      const isOpen = !!openTab;
      if (isOpen) tabItem.classList.add('nicknamed-open');

      const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(item.url).hostname)}&sz=32`;

      const nicknameIconHtml = '<svg class="nickname-icon" width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M13.5 8C13.5 10.5 11 13.5 8 13.5C5 13.5 2.5 10.5 2.5 8C2.5 5.5 5 2.5 8 2.5H12.5L10 5H8C6.34315 5 5 6.34315 5 8C5 9.65685 6.34315 11 8 11C9.65685 11 11 9.65685 11 8V7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

      const openIndicatorHtml = isOpen
        ? '<svg class="open-indicator" width="10" height="10" viewBox="0 0 16 16" fill="none" title="Currently open"><circle cx="8" cy="8" r="4" fill="var(--success-color, #22c55e)"/></svg>'
        : '';

      const isBookmarked = bookmarkedUrls.has(item.url);
      const bookmarkIconHtml = isBookmarked
        ? '<svg class="bookmark-icon" width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M4 2.5H12C12.2761 2.5 12.5 2.72386 12.5 3V13.5L8 10.5L3.5 13.5V3C3.5 2.72386 3.72386 2.5 4 2.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'
        : '';

      // Get title from open tab or try to extract from URL
      const title = openTab?.title || item.url;

      tabItem.innerHTML = `
        ${nicknameIconHtml}
        ${openIndicatorHtml}
        ${bookmarkIconHtml}
        <img class="tab-favicon" src="${favicon}" alt="">
        <span class="tab-nickname">${highlightSearchMatch(item.nickname)}</span>
        <span class="tab-title">${highlightSearchMatch(truncateUrl(item.url))}</span>
        <span class="tab-url">${highlightSearchMatch(truncateUrl(item.url))}</span>
      `;

      const faviconImg = tabItem.querySelector('.tab-favicon');
      if (faviconImg) {
        faviconImg.addEventListener('error', () => { faviconImg.src = DEFAULT_FAVICON; }, { once: true });
      }

      tabItem.addEventListener('click', () => {
        if (isOpen && openTab) {
          // Switch to the open tab
          chrome.tabs.update(openTab.id, { active: true });
          chrome.windows.update(openTab.windowId, { focused: true });
        } else {
          // Open URL in new tab
          chrome.tabs.create({ url: item.url });
        }
      });

      // Right-click context menu
      tabItem.addEventListener('contextmenu', (e) => {
        const tabLikeData = {
          id: openTab?.id || null,
          url: item.url,
          title: title,
          favIconUrl: favicon,
          pinned: openTab?.pinned || false,
          windowId: openTab?.windowId || null
        };
        handleTabRightClick(e, tabLikeData);
      });

      tabList.appendChild(tabItem);
    });

    // Update stats
    updateNicknameStats(filteredNicknames.length);
  } catch (error) {
    console.error('[TabSentry] Error loading nicknamed tabs:', error);
    tabList.innerHTML = `<div class="empty-state">Error loading nicknamed tabs: ${error.message}</div>`;
  }
}

function sortNicknames(nicknames, sortBy) {
  const sorted = [...nicknames];
  switch (sortBy) {
    case 'recent':
      // No date for nicknames, sort by nickname alphabetically as default
      sorted.sort((a, b) => (a.nickname || '').localeCompare(b.nickname || ''));
      break;
    case 'oldest':
      sorted.sort((a, b) => (b.nickname || '').localeCompare(a.nickname || ''));
      break;
    case 'az':
      sorted.sort((a, b) => (a.nickname || '').localeCompare(b.nickname || ''));
      break;
    case 'za':
      sorted.sort((a, b) => (b.nickname || '').localeCompare(a.nickname || ''));
      break;
  }
  return sorted;
}

function updateNicknameStats(count) {
  const tabsCount = document.querySelectorAll('.stat-value')[1];
  if (tabsCount) tabsCount.textContent = count;
}

function formatLastAccessed(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'Just now';
}

function truncateUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname + urlObj.pathname.substring(0, 20) + (urlObj.pathname.length > 20 ? '...' : '');
  } catch {
    return url.substring(0, 40) + (url.length > 40 ? '...' : '');
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function updateStats(tabs) {
  const windows = await chrome.windows.getAll();

  const windowsCount = document.querySelector('.stat-value');
  const tabsCount = document.querySelectorAll('.stat-value')[1];
  const autoclosedCount = document.querySelectorAll('.stat-value')[2];
  const automovedCount = document.querySelectorAll('.stat-value')[3];

  if (windowsCount) windowsCount.textContent = windows.length;
  if (tabsCount) tabsCount.textContent = tabs.length;

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);
  weekStart.setHours(0, 0, 0, 0);

  // Get autoclosed tabs from database and calculate week count
  if (autoclosedCount) {
    try {
      const autoclosedTabs = await db.getAutoclosedTabsSince(weekStart.getTime());
      autoclosedCount.textContent = autoclosedTabs.length;
    } catch (e) {
      autoclosedCount.textContent = '0';
    }
  }

  // Get automoved tabs from database and calculate week count
  if (automovedCount) {
    try {
      const automovedTabs = await db.getAutomovedTabsSince(weekStart.getTime());
      automovedCount.textContent = automovedTabs.length;
    } catch (e) {
      automovedCount.textContent = '0';
    }
  }
}

async function loadWindowsView() {
  const tabList = document.getElementById('tab-list');
  tabList.innerHTML = '<div class="loading-state">Loading windows...</div>';

  try {
    // Load time accumulated data if setting is enabled
    if (showTimeAccumulated) {
      await loadTabTimeData();
    }

    // Load nicknames
    await loadNicknames();

    // Load bookmarked URLs
    await loadBookmarkedUrls();

    // Get all windows and tabs
    const windows = await chrome.windows.getAll({ populate: true });
    const allTabs = await chrome.tabs.query({});

    // Get tab groups (Chrome 89+)
    let tabGroups = [];
    try {
      tabGroups = await chrome.tabGroups.query({});
    } catch (e) {
      // Tab groups API not available
    }

    // Create a map of tab group info by id
    const tabGroupMap = new Map();
    tabGroups.forEach(group => {
      tabGroupMap.set(group.id, group);
    });

    // Get window data (title, lastAccessed, createdAt) from DB
    const windowData = await getWindowData(windows.map(w => w.id));

    // Get anchor window info
    let anchorWindowId = null;
    try {
      const anchorResponse = await chrome.runtime.sendMessage({ type: 'GET_ANCHOR_WINDOW' });
      if (anchorResponse.success && anchorResponse.activeAnchorWindowId) {
        anchorWindowId = anchorResponse.activeAnchorWindowId;
      }
    } catch (e) {
      console.error('[TabSentry] Failed to get anchor window:', e);
    }

    tabList.innerHTML = '';

    // Collect all pinned tabs from all windows if pinnedOnTop is enabled
    let allPinnedTabs = [];
    if (pinnedOnTop) {
      windows.forEach(window => {
        const windowPinnedTabs = (window.tabs || []).filter(tab => tab.pinned);
        allPinnedTabs = allPinnedTabs.concat(windowPinnedTabs);
      });
      // Apply filter to pinned tabs
      allPinnedTabs = applyFilter(allPinnedTabs);
      // Sort pinned tabs
      allPinnedTabs = sortTabs(allPinnedTabs, currentSort);
    }

    // Create Pinned window container if there are pinned tabs and pinnedOnTop is enabled
    if (pinnedOnTop && allPinnedTabs.length > 0) {
      const pinnedWindowEl = createPinnedWindowGroup(allPinnedTabs);
      tabList.appendChild(pinnedWindowEl);
    }

    // Sort windows: focused window first, then by lastAccessed (or createdAt as fallback)
    const sortedWindows = [...windows].sort((a, b) => {
      if (a.focused) return -1;
      if (b.focused) return 1;
      const aData = windowData[a.id] || {};
      const bData = windowData[b.id] || {};
      const aTime = aData.lastAccessed || aData.createdAt || 0;
      const bTime = bData.lastAccessed || bData.createdAt || 0;
      return bTime - aTime; // Most recent first
    });

    // Separate anchor window from other windows
    const anchorWindow = anchorWindowId ? sortedWindows.find(w => w.id === anchorWindowId) : null;
    const otherWindows = sortedWindows.filter(w => w.id !== anchorWindowId);

    // Render anchor window first (after pinned container)
    if (anchorWindow) {
      const windowTitle = windowData[anchorWindow.id]?.title || '';
      const windowTitleMatches = currentSearchQuery &&
        windowTitle.toLowerCase().includes(currentSearchQuery);

      let filteredTabs = applyFilter(anchorWindow.tabs || []);
      if (!windowTitleMatches) {
        filteredTabs = applySearch(filteredTabs);
      }
      // Always show anchor window unless filter/search completely hides it
      if (!((currentFilter || currentSearchQuery) && filteredTabs.length === 0 && !windowTitleMatches)) {
        const filteredWindow = { ...anchorWindow, tabs: filteredTabs };
        const windowEl = createWindowGroup(filteredWindow, 0, tabGroupMap, windowTitle, true);
        tabList.appendChild(windowEl);
      }
    }

    // Render other windows
    otherWindows.forEach((window, index) => {
      const windowTitle = windowData[window.id]?.title || '';

      // Check if window title matches search query
      const windowTitleMatches = currentSearchQuery &&
        windowTitle.toLowerCase().includes(currentSearchQuery);

      // Apply filter and search to tabs within each window
      let filteredTabs = applyFilter(window.tabs || []);

      // If window title matches, show all tabs (after filter); otherwise filter by search
      if (!windowTitleMatches) {
        filteredTabs = applySearch(filteredTabs);
      }

      // Skip windows with no matching tabs AND no matching title if filter or search is active
      if ((currentFilter || currentSearchQuery) && filteredTabs.length === 0 && !windowTitleMatches) return;

      // Create a copy of window with filtered tabs
      const filteredWindow = { ...window, tabs: filteredTabs };

      const windowEl = createWindowGroup(filteredWindow, index + (anchorWindow ? 1 : 0), tabGroupMap, windowTitle, false);
      tabList.appendChild(windowEl);
    });

    // Add Recently Visited group at the bottom
    const recentlyVisitedGroup = await createRecentlyVisitedGroup(windows);
    if (recentlyVisitedGroup) {
      tabList.appendChild(recentlyVisitedGroup);
    }

    // Update stats
    updateStats(allTabs);

  } catch (error) {
    tabList.innerHTML = `<div class="empty-state">Error loading windows: ${error.message}</div>`;
  }
}

async function getWindowData(windowIds) {
  const data = {};
  for (const id of windowIds) {
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'GET_WINDOW_DATA',
        windowId: id
      });
      console.log('[TabSentry] GET_WINDOW_DATA response for window', id, ':', result);
      data[id] = result || { title: null, lastAccessed: null, createdAt: null };
    } catch (e) {
      console.error('[TabSentry] GET_WINDOW_DATA error for window', id, ':', e);
      data[id] = { title: null, lastAccessed: null, createdAt: null };
    }
  }
  return data;
}

function createWindowGroup(window, index, tabGroupMap, customTitle, isAnchor = false) {
  const windowGroup = document.createElement('div');
  windowGroup.className = 'window-group';
  windowGroup.dataset.windowId = window.id;
  if (window.focused) windowGroup.classList.add('focused');
  if (isAnchor) windowGroup.classList.add('anchor-window');

  // Drag-and-drop handlers for receiving tabs
  windowGroup.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    windowGroup.classList.add('drag-over');
  });

  windowGroup.addEventListener('dragleave', (e) => {
    // Only remove class if leaving the window group entirely
    if (!windowGroup.contains(e.relatedTarget)) {
      windowGroup.classList.remove('drag-over');
    }
  });

  windowGroup.addEventListener('drop', async (e) => {
    e.preventDefault();
    windowGroup.classList.remove('drag-over');

    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      const targetWindowId = window.id;

      // Handle both single and multi-tab drag
      const tabsToMove = data.tabs || [{ tabId: data.tabId, sourceWindowId: data.sourceWindowId }];

      // Filter out tabs already in target window
      const tabsFromOtherWindows = tabsToMove.filter(t =>
        parseInt(t.sourceWindowId) !== targetWindowId
      );

      if (tabsFromOtherWindows.length === 0) return;

      // Move all tabs to end of target window
      const tabIds = tabsFromOtherWindows.map(t => parseInt(t.tabId));
      await chrome.tabs.move(tabIds, { windowId: targetWindowId, index: -1 });

      // Clear multi-selection after successful move
      clearMultiSelection();

      // Reload view to reflect changes
      loadWindowsView();
    } catch (err) {
      console.error('[TabSentry] Failed to move tab(s):', err);
    }
  });

  // Organize tabs by groups and sort them
  const { ungroupedTabs, groupedTabs } = organizeTabsByGroups(window.tabs || [], tabGroupMap, currentSort);

  // Window header
  const windowTitle = customTitle || `Window ${index + 1}`;
  const tabCount = window.tabs?.length || 0;

  // Build badges HTML
  let badgesHtml = '';
  if (isAnchor) badgesHtml += '<span class="window-badge anchor-badge">Anchor</span>';
  if (window.focused) badgesHtml += '<span class="window-badge">Current</span>';

  const header = document.createElement('div');
  header.className = 'window-group-header';
  header.innerHTML = `
    <div class="window-group-title">
      <svg class="window-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <svg class="window-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
        <path d="M2 6H14" stroke="currentColor" stroke-width="1.5"/>
      </svg>
      <span class="window-name">${highlightSearchMatch(windowTitle)}</span>
      ${badgesHtml}
    </div>
    <div class="window-group-meta">
      <span class="window-tab-count">${tabCount} tab${tabCount !== 1 ? 's' : ''}</span>
      <button class="window-anchor-btn ${isAnchor ? 'active' : ''}" title="${isAnchor ? 'Remove anchor' : 'Set as anchor window'}">
        <i class="fa-regular fa-anchor"></i>
      </button>
      <button class="window-edit-btn" title="Edit window title" data-window-id="${window.id}">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M11.5 2.5L13.5 4.5L5 13H3V11L11.5 2.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M9.5 4.5L11.5 6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <button class="window-focus-btn" title="Focus this window">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M2 6V3C2 2.44772 2.44772 2 3 2H6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M10 2H13C13.5523 2 14 2.44772 14 3V6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M14 10V13C14 13.5523 13.5523 14 13 14H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M6 14H3C2.44772 14 2 13.5523 2 13V10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
      <button class="window-save-btn" title="Save this window">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M4 2.5H12C12.2761 2.5 12.5 2.72386 12.5 3V13.5L8 10.5L3.5 13.5V3C3.5 2.72386 3.72386 2.5 4 2.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
      </button>
      <button class="window-delete-btn" title="Close this window">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M4 4L12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  `;

  // Anchor button handler
  header.querySelector('.window-anchor-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      let response;
      if (isAnchor) {
        // Remove anchor designation
        response = await chrome.runtime.sendMessage({ type: 'CLEAR_ANCHOR_WINDOW' });
      } else {
        // Set this window as anchor
        response = await chrome.runtime.sendMessage({ type: 'SET_ANCHOR_WINDOW', windowId: window.id });
      }

      if (response?.success) {
        // Reload the view to reflect changes
        loadWindowsView();
      } else {
        console.error('[TabSentry] Anchor operation failed:', response?.error);
      }
    } catch (error) {
      console.error('[TabSentry] Failed to toggle anchor:', error);
    }
  });

  // Focus button handler
  header.querySelector('.window-focus-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.windows.update(window.id, { focused: true });
  });

  // Edit button handler
  header.querySelector('.window-edit-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const windowNameEl = header.querySelector('.window-name');
    const currentTitle = windowNameEl.textContent;

    // Create input for inline editing
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'window-name-input';
    input.value = currentTitle;

    windowNameEl.style.display = 'none';
    windowNameEl.parentNode.insertBefore(input, windowNameEl.nextSibling);
    input.focus();
    input.select();

    const saveTitle = async () => {
      const newTitle = input.value.trim() || `Window ${index + 1}`;
      windowNameEl.textContent = newTitle;
      windowNameEl.style.display = '';
      input.remove();

      // Save to database via background script
      await chrome.runtime.sendMessage({
        type: 'UPDATE_WINDOW_TITLE',
        windowId: window.id,
        title: newTitle
      });
    };

    input.addEventListener('blur', saveTitle);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        windowNameEl.style.display = '';
        input.remove();
      }
    });
  });

  // Save button handler
  header.querySelector('.window-save-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SAVE_WINDOW',
        windowId: window.id
      });

      if (response?.success) {
        // Visual feedback - briefly change icon color
        btn.style.color = '#10b981';
        setTimeout(() => {
          btn.style.color = '';
          btn.disabled = false;
        }, 1000);
      } else {
        console.error('[TabSentry] Failed to save window:', response?.error || 'No response from background');
        btn.disabled = false;
      }
    } catch (error) {
      console.error('[TabSentry] Error saving window:', error);
      btn.disabled = false;
    }
  });

  // Delete button handler
  header.querySelector('.window-delete-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    showCloseWindowModal(window.id, tabCount, windowGroup);
  });

  // Collapse/expand handler
  header.addEventListener('click', () => {
    windowGroup.classList.toggle('collapsed');
  });

  windowGroup.appendChild(header);

  // Window content (tabs)
  const content = document.createElement('div');
  content.className = 'window-group-content';

  // Render tab groups first
  for (const [groupId, tabs] of groupedTabs) {
    const groupInfo = tabGroupMap.get(groupId);
    const tabGroupEl = createTabGroup(groupInfo, tabs);
    content.appendChild(tabGroupEl);
  }

  // Render ungrouped tabs
  ungroupedTabs.forEach(tab => {
    const tabEl = createTabItem(tab);
    content.appendChild(tabEl);
  });

  windowGroup.appendChild(content);

  return windowGroup;
}

function createPinnedWindowGroup(pinnedTabs) {
  const windowGroup = document.createElement('div');
  windowGroup.className = 'window-group pinned-window';

  const tabCount = pinnedTabs.length;

  const header = document.createElement('div');
  header.className = 'window-group-header';
  header.innerHTML = `
    <div class="window-group-title">
      <svg class="window-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <svg class="window-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M9.5 2L14 6.5L12 8.5L12.5 12.5L8 8L3.5 12.5L4 8.5L2 6.5L6.5 2L8 3.5L9.5 2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <span class="window-name">Pinned</span>
    </div>
    <div class="window-group-meta">
      <span class="window-tab-count">${tabCount} tab${tabCount !== 1 ? 's' : ''}</span>
    </div>
  `;

  // Collapse/expand handler
  header.addEventListener('click', () => {
    windowGroup.classList.toggle('collapsed');
  });

  windowGroup.appendChild(header);

  // Window content (tabs)
  const content = document.createElement('div');
  content.className = 'window-group-content';

  // Render pinned tabs
  pinnedTabs.forEach(tab => {
    const tabEl = createTabItem(tab);
    content.appendChild(tabEl);
  });

  windowGroup.appendChild(content);

  return windowGroup;
}

// Get recently visited items from history, filtering out currently open tabs
async function getRecentlyVisitedItems(openWindows, limit = 5, searchQuery = '') {
  // Collect all currently open tab URLs to exclude from history
  const openTabUrls = new Set();
  openWindows.forEach(window => {
    (window.tabs || []).forEach(tab => {
      openTabUrls.add(tab.url);
    });
  });

  // Fetch recent history items using history API search
  // The 'text' parameter searches both URL and title
  const historyItems = await chrome.history.search({
    text: searchQuery,
    startTime: 0,
    endTime: Date.now(),
    maxResults: limit * 3  // Fetch extra to account for filtering open tabs
  });

  // Filter out currently open tabs and limit to requested count
  return historyItems
    .filter(item => !openTabUrls.has(item.url))
    .slice(0, limit);
}

// Create a tab item for a recently visited history item
function createRecentlyVisitedItem(historyItem) {
  const tabItem = document.createElement('div');
  tabItem.className = 'tab-item';

  const lastVisited = historyItem.lastVisitTime
    ? formatLastAccessed(historyItem.lastVisitTime)
    : '';

  const faviconUrl = getFaviconFromUrl(historyItem.url);

  const isBookmarked = bookmarkedUrls.has(historyItem.url);
  const bookmarkIconHtml = isBookmarked
    ? '<svg class="bookmark-icon" width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M4 2.5H12C12.2761 2.5 12.5 2.72386 12.5 3V13.5L8 10.5L3.5 13.5V3C3.5 2.72386 3.72386 2.5 4 2.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'
    : '';

  const nickname = nicknamesMap.get(historyItem.url);
  const nicknameHtml = nickname
    ? `<span class="tab-nickname">${highlightSearchMatch(nickname)}</span>`
    : '';

  tabItem.innerHTML = `
    ${bookmarkIconHtml}
    <img class="tab-favicon" src="${faviconUrl}" alt="">
    ${nicknameHtml}
    <span class="tab-title">${highlightSearchMatch(historyItem.title || 'Untitled')}</span>
    <span class="tab-url">${highlightSearchMatch(truncateUrl(historyItem.url))}</span>
    ${lastVisited ? `<span class="tab-last-accessed">${lastVisited}</span>` : ''}
  `;

  // Handle favicon loading errors
  const faviconImg = tabItem.querySelector('.tab-favicon');
  if (faviconImg) {
    faviconImg.addEventListener('error', () => {
      faviconImg.src = DEFAULT_FAVICON;
    }, { once: true });
  }

  // Click handler - opens URL in new tab in current window
  tabItem.addEventListener('click', async () => {
    const currentWindow = await chrome.windows.getCurrent();
    chrome.tabs.create({
      url: historyItem.url,
      windowId: currentWindow.id
    });
  });

  return tabItem;
}

// Create the Recently Visited window group
async function createRecentlyVisitedGroup(openWindows) {
  // Pass search query to history API for searching
  let items = await getRecentlyVisitedItems(openWindows, 5, currentSearchQuery || '');

  // Apply filter to history items
  if (currentFilter) {
    items = items.filter(item => matchTabWithFilter(item, currentFilter));
  }

  if (items.length === 0) {
    return null;
  }

  const windowGroup = document.createElement('div');
  windowGroup.className = 'window-group recently-closed-window';

  const header = document.createElement('div');
  header.className = 'window-group-header';
  header.innerHTML = `
    <div class="window-group-title">
      <svg class="window-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <svg class="window-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/>
        <path d="M8 4.5V8L10.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="window-name">Recently Visited</span>
    </div>
    <div class="window-group-meta">
      <span class="window-tab-count">${items.length} item${items.length !== 1 ? 's' : ''}</span>
    </div>
  `;

  // Collapse/expand handler
  header.addEventListener('click', () => {
    windowGroup.classList.toggle('collapsed');
  });

  windowGroup.appendChild(header);

  // Window content
  const content = document.createElement('div');
  content.className = 'window-group-content';

  // Create tab items for each history item
  items.forEach(item => {
    const tabEl = createRecentlyVisitedItem(item);
    content.appendChild(tabEl);
  });

  windowGroup.appendChild(content);

  return windowGroup;
}

function organizeTabsByGroups(tabs, tabGroupMap, sortBy) {
  const ungroupedTabs = [];
  const groupedTabs = new Map();

  // First organize tabs into groups
  tabs.forEach(tab => {
    if (tab.groupId && tab.groupId !== -1 && tabGroupMap.has(tab.groupId)) {
      if (!groupedTabs.has(tab.groupId)) {
        groupedTabs.set(tab.groupId, []);
      }
      groupedTabs.get(tab.groupId).push(tab);
    } else {
      ungroupedTabs.push(tab);
    }
  });

  // Sort ungrouped tabs based on sort preference
  const sortedUngrouped = sortTabs(ungroupedTabs, sortBy);

  // Sort tabs within each group
  for (const [groupId, groupTabs] of groupedTabs) {
    groupedTabs.set(groupId, sortTabs(groupTabs, sortBy));
  }

  return { ungroupedTabs: sortedUngrouped, groupedTabs };
}

function createTabGroup(groupInfo, tabs) {
  const tabGroup = document.createElement('div');
  tabGroup.className = 'tab-group';

  const color = TAB_GROUP_COLORS[groupInfo?.color] || TAB_GROUP_COLORS.grey;
  tabGroup.style.setProperty('--tab-group-color', color);

  const groupTitle = groupInfo?.title || 'Unnamed Group';
  const isCollapsed = groupInfo?.collapsed || false;

  if (isCollapsed) tabGroup.classList.add('collapsed');

  const groupHeader = document.createElement('div');
  groupHeader.className = 'tab-group-header';
  groupHeader.innerHTML = `
    <svg class="tab-group-chevron" width="10" height="10" viewBox="0 0 12 12" fill="none">
      <path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span class="tab-group-color-dot"></span>
    <span class="tab-group-title">${escapeHtml(groupTitle)}</span>
    <span class="tab-group-count">${tabs.length}</span>
  `;

  groupHeader.addEventListener('click', (e) => {
    e.stopPropagation();
    tabGroup.classList.toggle('collapsed');
  });

  tabGroup.appendChild(groupHeader);

  const groupContent = document.createElement('div');
  groupContent.className = 'tab-group-content';

  tabs.forEach(tab => {
    const tabEl = createTabItem(tab, true);
    groupContent.appendChild(tabEl);
  });

  tabGroup.appendChild(groupContent);

  return tabGroup;
}

function createTabItem(tab, isInGroup = false) {
  const tabItem = document.createElement('div');
  tabItem.className = 'tab-item';
  if (isInGroup) tabItem.classList.add('in-group');
  if (tab.active) tabItem.classList.add('active-tab');
  if (tab.pinned) tabItem.classList.add('pinned-tab');

  // Make tab draggable in windows view
  if (currentView === 'windows') {
    tabItem.draggable = true;
    tabItem.dataset.tabId = tab.id;
    tabItem.dataset.windowId = tab.windowId;

    // Shift+click to toggle selection for multi-drag
    tabItem.addEventListener('click', (e) => {
      if (e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (selectedTabs.has(tab.id)) {
          selectedTabs.delete(tab.id);
          tabItem.classList.remove('multi-selected');
        } else {
          selectedTabs.add(tab.id);
          tabItem.classList.add('multi-selected');
        }
        updateMultiSelectInfoBar();
        return;
      }
      // Clear multi-selection on normal click
      clearMultiSelection();
      updateMultiSelectInfoBar();
    }, true);

    tabItem.addEventListener('dragstart', (e) => {
      // If dragging a selected tab, include all selected tabs
      // If dragging an unselected tab, just drag that one
      let tabsToMove = [];
      if (selectedTabs.has(tab.id) && selectedTabs.size > 1) {
        // Dragging from selection - include all selected
        tabsToMove = Array.from(selectedTabs).map(id => ({
          tabId: id,
          sourceWindowId: document.querySelector(`.tab-item[data-tab-id="${id}"]`)?.dataset.windowId
        })).filter(t => t.sourceWindowId);
      } else {
        // Single tab drag
        tabsToMove = [{ tabId: tab.id, sourceWindowId: tab.windowId }];
      }

      e.dataTransfer.setData('text/plain', JSON.stringify({
        tabs: tabsToMove,
        isMulti: tabsToMove.length > 1
      }));
      tabItem.classList.add('dragging');

      // Mark all selected tabs as dragging if multi-select
      if (selectedTabs.has(tab.id) && selectedTabs.size > 1) {
        document.querySelectorAll('.tab-item.multi-selected').forEach(el => {
          el.classList.add('dragging');
        });
      }
    });

    tabItem.addEventListener('dragend', () => {
      // Remove dragging state from all tabs
      document.querySelectorAll('.tab-item.dragging').forEach(el => {
        el.classList.remove('dragging');
      });
      // Remove drag-over state from all windows
      document.querySelectorAll('.window-group.drag-over').forEach(el => {
        el.classList.remove('drag-over');
      });
    });
  }

  const lastAccessed = tab.lastAccessed
    ? formatLastAccessed(tab.lastAccessed)
    : '';

  const favicon = getSafeFaviconUrl(tab.favIconUrl);

  const timeAccumulated = showTimeAccumulated ? tabTimeData.get(tab.id) || 0 : 0;
  const timeAccumulatedHtml = showTimeAccumulated
    ? `<span class="tab-time-accumulated" title="Time accumulated">${formatTimeAccumulated(timeAccumulated)}</span>`
    : '';

  const isBookmarked = bookmarkedUrls.has(tab.url);
  const bookmarkIconHtml = isBookmarked
    ? '<svg class="bookmark-icon" width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M4 2.5H12C12.2761 2.5 12.5 2.72386 12.5 3V13.5L8 10.5L3.5 13.5V3C3.5 2.72386 3.72386 2.5 4 2.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'
    : '';

  const audibleIconHtml = tab.audible
    ? '<svg class="audible-icon" width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M8 3L4 6H2V10H4L8 13V3Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M11 5.5C11.8 6.3 12 7.1 12 8C12 8.9 11.8 9.7 11 10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13 3.5C14.3 4.8 15 6.4 15 8C15 9.6 14.3 11.2 13 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
    : '';

  const nickname = nicknamesMap.get(tab.url);
  const nicknameHtml = nickname
    ? `<span class="tab-nickname">${highlightSearchMatch(nickname)}</span>`
    : '';

  tabItem.innerHTML = `
    ${tab.pinned ? '<svg class="pin-icon" width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M9.5 2L14 6.5L12 8.5L12.5 12.5L8 8L3.5 12.5L4 8.5L2 6.5L6.5 2L8 3.5L9.5 2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>' : ''}
    ${bookmarkIconHtml}
    ${audibleIconHtml}
    <img class="tab-favicon" src="${favicon}" alt="">
    ${nicknameHtml}
    <span class="tab-title">${highlightSearchMatch(tab.title || 'Untitled')}</span>
    <span class="tab-url">${highlightSearchMatch(truncateUrl(tab.url))}</span>
    ${timeAccumulatedHtml}
    ${lastAccessed ? `<span class="tab-last-accessed">${lastAccessed}</span>` : ''}
  `;

  const faviconImg = tabItem.querySelector('.tab-favicon');
  if (faviconImg) {
    faviconImg.addEventListener('error', () => { faviconImg.src = DEFAULT_FAVICON; }, { once: true });
  }

  tabItem.addEventListener('click', () => {
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });
  });

  // Right-click context menu
  tabItem.addEventListener('contextmenu', (e) => {
    handleTabRightClick(e, tab);
  });

  return tabItem;
}

async function loadMoreHistory() {
  // Don't load history list in windows view - it has its own Recently Visited group
  if (currentView === 'windows') return;

  const tabList = document.getElementById('tab-list');

  if (isLoadingHistory || !hasMoreHistory) return;
  isLoadingHistory = true;

  // Show loading indicator at the bottom
  const loadingMore = document.createElement('div');
  loadingMore.className = 'loading-more';
  loadingMore.innerHTML = '<span class="loading-spinner"></span> Loading more...';
  tabList.appendChild(loadingMore);

  try {
    const historyItems = await chrome.history.search({
      text: '',
      startTime: 0,
      endTime: historyEndTime,
      maxResults: HISTORY_PAGE_SIZE
    });

    // Remove loading indicator
    loadingMore.remove();

    if (historyItems.length === 0) {
      hasMoreHistory = false;
      isLoadingHistory = false;
      return;
    }

    // Update endTime for next page (use the oldest item's lastVisitTime)
    const oldestItem = historyItems[historyItems.length - 1];
    if (oldestItem && oldestItem.lastVisitTime) {
      historyEndTime = oldestItem.lastVisitTime - 1;
    }

    // Filter out URLs that have already been displayed (open tabs + previous history)
    // Also apply search filter and current filter to history items
    // Note: History is always shown in recency order (API default) since
    // sorting paginated results would break chronological pagination
    const filteredItems = historyItems
      .filter(item => !displayedUrls.has(item.url))
      .filter(matchesSearchQuery)
      .filter(item => matchTabWithFilter(item, currentFilter));

    // If we got fewer items than requested, we've reached the end
    if (historyItems.length < HISTORY_PAGE_SIZE) {
      hasMoreHistory = false;
    }

    filteredItems.forEach(item => {
      // Track this URL to prevent future duplicates
      displayedUrls.add(item.url);

      const historyEl = document.createElement('div');
      historyEl.className = 'tab-item closed-tab';

      const lastVisited = item.lastVisitTime
        ? formatLastAccessed(item.lastVisitTime)
        : 'Unknown';

      const faviconUrl = getFaviconFromUrl(item.url);

      const isBookmarked = bookmarkedUrls.has(item.url);
      const bookmarkIconHtml = isBookmarked
        ? '<svg class="bookmark-icon" width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M4 2.5H12C12.2761 2.5 12.5 2.72386 12.5 3V13.5L8 10.5L3.5 13.5V3C3.5 2.72386 3.72386 2.5 4 2.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'
        : '';

      const nickname = nicknamesMap.get(item.url);
      const nicknameHtml = nickname
        ? `<span class="tab-nickname">${highlightSearchMatch(nickname)}</span>`
        : '';

      historyEl.innerHTML = `
        ${bookmarkIconHtml}
        <img class="tab-favicon" src="${faviconUrl}" alt="">
        ${nicknameHtml}
        <span class="tab-title">${highlightSearchMatch(item.title || 'Untitled')}</span>
        <span class="tab-url">${highlightSearchMatch(truncateUrl(item.url))}</span>
        <span class="tab-last-accessed">${lastVisited}</span>
      `;

      const faviconImg = historyEl.querySelector('.tab-favicon');
      if (faviconImg) {
        faviconImg.addEventListener('error', () => { faviconImg.src = DEFAULT_FAVICON; }, { once: true });
      }

      historyEl.addEventListener('click', () => {
        chrome.tabs.create({ url: item.url });
      });

      tabList.appendChild(historyEl);
    });

  } catch (error) {
    loadingMore.remove();
    hasMoreHistory = false;
  }

  isLoadingHistory = false;
}

function getFaviconFromUrl(url) {
  try {
    const urlObj = new URL(url);
    // Use Chrome's favicon service
    return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(url)}&size=16`;
  } catch {
    return DEFAULT_FAVICON;
  }
}

// ========================================
// Context Menu Functions
// ========================================

function initContextMenu() {
  const contextMenu = document.getElementById('tab-context-menu');
  const moveSubmenu = document.getElementById('move-submenu');
  const copySubmenu = document.getElementById('copy-submenu');
  const backdrop = document.getElementById('context-menu-backdrop');
  if (!contextMenu) return;

  // Close context menu when clicking backdrop
  backdrop?.addEventListener('click', () => {
    hideContextMenu();
  });

  // Close context menu when clicking the X button
  const closeBtn = document.getElementById('context-menu-close');
  closeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    hideContextMenu();
  });

  // Close context menu when clicking outside (fallback)
  document.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target) && !moveSubmenu?.contains(e.target) && !copySubmenu?.contains(e.target) && e.target !== backdrop) {
      hideContextMenu();
    }
  });

  // Close context menu on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideContextMenu();
    }
  });

  // Close context menu on scroll
  document.querySelector('.main-content')?.addEventListener('scroll', () => {
    hideContextMenu();
  });

  // Handle context menu item clicks
  contextMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.context-menu-item');
    if (!item) return;

    const action = item.dataset.action;
    if (action) {
      handleContextMenuAction(action);
    }
  });

  // Handle move submenu hover
  const moveItem = contextMenu.querySelector('[data-action="move"]');
  if (moveItem) {
    moveItem.addEventListener('mouseenter', showMoveSubmenu);
  }

  // Handle copy submenu hover
  const copyItem = contextMenu.querySelector('[data-action="copy"]');
  if (copyItem) {
    copyItem.addEventListener('mouseenter', showCopySubmenu);
  }

  // Handle copy submenu item clicks
  copySubmenu?.addEventListener('click', (e) => {
    const item = e.target.closest('.copy-submenu-item');
    if (!item) return;

    const action = item.dataset.copyAction;
    if (action) {
      handleCopyAction(action);
    }
  });
}

function showContextMenu(x, y, tab) {
  const contextMenu = document.getElementById('tab-context-menu');
  const backdrop = document.getElementById('context-menu-backdrop');
  if (!contextMenu) return;

  // Show backdrop
  backdrop?.classList.remove('hidden');

  // Store tab data
  contextMenuTabId = tab.id;
  contextMenuTabData = tab;

  // Update menu header with tab info
  const favicon = contextMenu.querySelector('.context-menu-favicon');
  const title = contextMenu.querySelector('.context-menu-title');
  const url = contextMenu.querySelector('.context-menu-url');

  if (favicon) {
    favicon.src = getSafeFaviconUrl(tab.favIconUrl);
    favicon.onerror = () => { favicon.src = DEFAULT_FAVICON; };
  }
  if (title) title.textContent = tab.title || 'Untitled';
  if (url) url.textContent = truncateUrl(tab.url);

  // Update pin button text and style based on current state
  const pinBtn = contextMenu.querySelector('[data-action="pin"]');
  const pinBtnText = pinBtn?.querySelector('span');
  if (pinBtnText) {
    pinBtnText.textContent = tab.pinned ? 'Unpin' : 'Pin';
  }
  if (pinBtn) {
    pinBtn.classList.toggle('active', tab.pinned);
  }

  // Update bookmark button text and style based on current state
  const isBookmarked = bookmarkedUrls.has(tab.url);
  const bookmarkBtn = contextMenu.querySelector('[data-action="bookmark"]');
  const bookmarkBtnText = bookmarkBtn?.querySelector('span');
  if (bookmarkBtnText) {
    bookmarkBtnText.textContent = isBookmarked ? 'Remove Bookmark' : 'Bookmark';
  }
  if (bookmarkBtn) {
    bookmarkBtn.classList.toggle('active', isBookmarked);
  }

  // Position menu within viewport bounds
  contextMenu.classList.remove('hidden');

  const menuRect = contextMenu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Adjust x position if menu would overflow right
  if (x + menuRect.width > viewportWidth) {
    x = viewportWidth - menuRect.width - 10;
  }
  // Adjust x position if menu would overflow left
  if (x < 10) {
    x = 10;
  }

  // Adjust y position if menu would overflow bottom
  if (y + menuRect.height > viewportHeight) {
    y = viewportHeight - menuRect.height - 10;
  }
  // Adjust y position if menu would overflow top
  if (y < 10) {
    y = 10;
  }

  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
}

function hideContextMenu() {
  const contextMenu = document.getElementById('tab-context-menu');
  const moveSubmenu = document.getElementById('move-submenu');
  const copySubmenu = document.getElementById('copy-submenu');
  const backdrop = document.getElementById('context-menu-backdrop');

  if (contextMenu) {
    contextMenu.classList.add('hidden');
  }
  if (moveSubmenu) {
    moveSubmenu.classList.add('hidden');
  }
  if (copySubmenu) {
    copySubmenu.classList.add('hidden');
  }
  if (backdrop) {
    backdrop.classList.add('hidden');
  }

  contextMenuTabId = null;
  contextMenuTabData = null;
}

async function handleContextMenuAction(action) {
  if (!contextMenuTabId || !contextMenuTabData) return;

  const tabId = contextMenuTabId;
  const tabData = contextMenuTabData;

  switch (action) {
    case 'pin':
      await handlePinAction(tabId, tabData);
      break;
    case 'nickname':
      await handleNicknameAction(tabId, tabData);
      break;
    case 'bookmark':
      await handleBookmarkAction(tabData);
      break;
    case 'move':
      // Move action is handled by submenu hover
      return;
    case 'close':
      await handleCloseAction(tabId);
      break;
    case 'remove-history':
      await handleRemoveFromHistoryAction(tabData);
      break;
  }

  hideContextMenu();
}

async function handlePinAction(tabId, tabData) {
  try {
    await chrome.tabs.update(tabId, { pinned: !tabData.pinned });
    // Reload view to reflect changes
    loadCurrentView();
  } catch (error) {
    console.error('[TabSentry] Failed to pin/unpin tab:', error);
  }
}

async function handleNicknameAction(tabId, tabData) {
  const currentNickname = await getNickname(tabData.url);
  showNicknameModal(tabId, tabData, currentNickname);
}

async function handleRemoveFromHistoryAction(tabData) {
  try {
    if (!tabData.url) return;

    // Remove the URL from Chrome's browsing history
    await chrome.history.deleteUrl({ url: tabData.url });
    console.log('[TabSentry] Removed from history:', tabData.url);
    showToast('Removed from history');
  } catch (error) {
    console.error('[TabSentry] Failed to remove from history:', error);
  }
}

// Saved Windows Modal
async function showSavedWindowsModal() {
  const modal = document.getElementById('saved-windows-modal');
  const listEl = document.getElementById('saved-windows-list');
  const emptyEl = document.getElementById('saved-windows-empty');
  const closeBtn = document.getElementById('saved-windows-close');

  if (!modal || !listEl) return;

  // Fetch saved windows
  const response = await chrome.runtime.sendMessage({ type: 'GET_SAVED_WINDOWS' });
  console.log('[TabSentry] GET_SAVED_WINDOWS response:', response);
  const savedWindows = response?.success ? response.savedWindows : [];

  // Clear and render list
  listEl.innerHTML = '';

  if (savedWindows.length === 0) {
    listEl.classList.add('hidden');
    emptyEl?.classList.remove('hidden');
  } else {
    listEl.classList.remove('hidden');
    emptyEl?.classList.add('hidden');

    // Sort by savedAt descending (newest first)
    savedWindows.sort((a, b) => b.savedAt - a.savedAt);

    for (const sw of savedWindows) {
      const item = document.createElement('div');
      item.className = 'saved-window-item';
      item.innerHTML = `
        <svg class="saved-window-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
          <path d="M2 6H14" stroke="currentColor" stroke-width="1.5"/>
        </svg>
        <div class="saved-window-info">
          <div class="saved-window-name">${escapeHtml(sw.name)}</div>
          <div class="saved-window-meta">${sw.tabs.length} tab${sw.tabs.length !== 1 ? 's' : ''} &middot; ${formatLastAccessed(sw.savedAt)}</div>
        </div>
        <div class="saved-window-actions">
          <button class="saved-window-btn restore-btn" title="Restore window">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M2 8C2 4.68629 4.68629 2 8 2C11.3137 2 14 4.68629 14 8C14 11.3137 11.3137 14 8 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <path d="M5 8L8 11L11 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M8 4V11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
          <button class="saved-window-btn delete-btn" title="Delete saved window">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M4 4L12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <path d="M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      `;

      // Restore handler
      item.querySelector('.restore-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        btn.disabled = true;

        const restoreResponse = await chrome.runtime.sendMessage({
          type: 'RESTORE_SAVED_WINDOW',
          savedWindowId: sw.id
        });

        if (restoreResponse.success) {
          modal.classList.add('hidden');
        } else {
          console.error('[TabSentry] Failed to restore window:', restoreResponse.error);
          btn.disabled = false;
        }
      });

      // Delete handler
      item.querySelector('.delete-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const deleteResponse = await chrome.runtime.sendMessage({
          type: 'DELETE_SAVED_WINDOW',
          savedWindowId: sw.id
        });

        if (deleteResponse.success) {
          item.remove();
          // Check if list is now empty
          if (listEl.children.length === 0) {
            listEl.classList.add('hidden');
            emptyEl?.classList.remove('hidden');
          }
        }
      });

      listEl.appendChild(item);
    }
  }

  // Show modal
  modal.classList.remove('hidden');

  // Close handlers
  closeBtn?.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
    }
  });
}

function showNicknameModal(tabId, tabData, currentNickname) {
  const modal = document.getElementById('nickname-modal');
  const favicon = document.getElementById('nickname-modal-favicon');
  const tabTitle = document.getElementById('nickname-modal-tab-title');
  const input = document.getElementById('nickname-input');
  const cancelBtn = document.getElementById('nickname-cancel');
  const saveBtn = document.getElementById('nickname-save');

  if (!modal) return;

  // Populate modal with tab info
  if (favicon) {
    favicon.src = getSafeFaviconUrl(tabData.favIconUrl);
    favicon.onerror = () => { favicon.src = DEFAULT_FAVICON; };
  }
  if (tabTitle) {
    tabTitle.textContent = tabData.title || 'Untitled';
  }
  if (input) {
    input.value = currentNickname || '';
  }

  // Show modal
  modal.classList.remove('hidden');

  // Focus input
  setTimeout(() => input?.focus(), 50);

  // Clean up previous listeners
  const newCancelBtn = cancelBtn.cloneNode(true);
  const newSaveBtn = saveBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
  saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);

  // Cancel handler
  newCancelBtn.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  // Save handler
  const saveNickname = async () => {
    const nickname = input.value.trim();
    if (nickname) {
      await setNickname(tabData.url, nickname);
    } else {
      await removeNickname(tabData.url);
    }
    modal.classList.add('hidden');
    loadCurrentView();
  };

  newSaveBtn.addEventListener('click', saveNickname);

  // Enter key to save
  const handleKeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveNickname();
    } else if (e.key === 'Escape') {
      modal.classList.add('hidden');
    }
  };

  input.addEventListener('keydown', handleKeydown);

  // Close on overlay click
  const handleOverlayClick = (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
    }
  };

  modal.addEventListener('click', handleOverlayClick);
}

async function getTabNickname(tabId) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_TAB_NICKNAME',
      tabId
    });
    return response?.nickname || null;
  } catch (error) {
    console.error('[TabSentry] Failed to get nickname:', error);
    return null;
  }
}

async function setTabNickname(tabId, nickname, url) {
  try {
    await chrome.runtime.sendMessage({
      type: 'SET_TAB_NICKNAME',
      tabId,
      nickname,
      url
    });
  } catch (error) {
    console.error('[TabSentry] Failed to set nickname:', error);
  }
}

async function removeTabNickname(tabId) {
  try {
    await chrome.runtime.sendMessage({
      type: 'REMOVE_TAB_NICKNAME',
      tabId
    });
  } catch (error) {
    console.error('[TabSentry] Failed to remove nickname:', error);
  }
}

// URL-based nickname functions
async function getNickname(url) {
  try {
    const result = await db.getNickname(url);
    return result?.nickname || null;
  } catch (error) {
    console.error('[TabSentry] Failed to get nickname:', error);
    return null;
  }
}

async function setNickname(url, nickname) {
  try {
    await db.setNickname(url, nickname);
  } catch (error) {
    console.error('[TabSentry] Failed to set nickname:', error);
  }
}

async function removeNickname(url) {
  try {
    await db.removeNickname(url);
  } catch (error) {
    console.error('[TabSentry] Failed to remove nickname:', error);
  }
}

async function handleBookmarkAction(tabData) {
  try {
    const isBookmarked = bookmarkedUrls.has(tabData.url);

    if (isBookmarked) {
      // Remove bookmark - find and delete it
      const bookmarks = await chrome.bookmarks.search({ url: tabData.url });
      for (const bookmark of bookmarks) {
        await chrome.bookmarks.remove(bookmark.id);
      }
      bookmarkedUrls.delete(tabData.url);
    } else {
      // Create bookmark
      await chrome.bookmarks.create({
        title: tabData.title,
        url: tabData.url
      });
      bookmarkedUrls.add(tabData.url);
    }

    // Reload view to reflect changes
    loadCurrentView();
  } catch (error) {
    console.error('[TabSentry] Failed to toggle bookmark:', error);
  }
}

async function handleCloseAction(tabId) {
  try {
    await chrome.tabs.remove(tabId);
    // Reload view to reflect changes
    loadCurrentView();
  } catch (error) {
    console.error('[TabSentry] Failed to close tab:', error);
  }
}

async function showMoveSubmenu(e) {
  const moveSubmenu = document.getElementById('move-submenu');
  const contextMenu = document.getElementById('tab-context-menu');
  if (!moveSubmenu || !contextMenu || !contextMenuTabData) return;

  // Hide copy submenu if open
  const copySubmenu = document.getElementById('copy-submenu');
  if (copySubmenu) {
    copySubmenu.classList.add('hidden');
  }

  // Get all windows
  const windows = await chrome.windows.getAll({ populate: true });

  // Get window data from DB for titles
  const windowData = await getWindowData(windows.map(w => w.id));

  // Build submenu HTML
  let html = '<div class="move-submenu-header">Windows</div>';

  windows.forEach((win, index) => {
    const isCurrentWindow = win.id === contextMenuTabData.windowId;
    const windowTitle = windowData[win.id]?.title || `Window ${index + 1}`;
    const tabCount = win.tabs?.length || 0;

    html += `
      <button class="move-submenu-item ${isCurrentWindow ? 'current-window' : ''}"
              data-window-id="${win.id}"
              ${isCurrentWindow ? 'disabled' : ''}>
        <svg class="window-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
          <path d="M2 6H14" stroke="currentColor" stroke-width="1.5"/>
        </svg>
        <span>${escapeHtml(windowTitle)}${isCurrentWindow ? ' (current)' : ''}</span>
        <span class="tab-count">${tabCount}</span>
      </button>
    `;
  });

  html += '<div class="move-submenu-divider"></div>';
  html += `
    <button class="move-submenu-item new-window" data-new-window="true">
      <svg class="window-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
        <path d="M8 6V10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <path d="M6 8H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <span>New Window</span>
    </button>
  `;

  moveSubmenu.innerHTML = html;

  // Add click handlers
  moveSubmenu.querySelectorAll('.move-submenu-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();

      if (item.dataset.newWindow === 'true') {
        await handleMoveToNewWindow();
      } else if (item.dataset.windowId && !item.classList.contains('current-window')) {
        await handleMoveToWindow(parseInt(item.dataset.windowId));
      }
    });
  });

  // Position submenu next to the move button
  const moveItem = contextMenu.querySelector('[data-action="move"]');
  const moveItemRect = moveItem.getBoundingClientRect();
  const contextMenuRect = contextMenu.getBoundingClientRect();

  moveSubmenu.classList.remove('hidden');

  const submenuRect = moveSubmenu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Try to position to the right of the context menu
  let x = contextMenuRect.right + 4;
  let y = moveItemRect.top;

  // If it would overflow right, position to the left instead
  if (x + submenuRect.width > viewportWidth) {
    x = contextMenuRect.left - submenuRect.width - 4;
  }

  // If it would still overflow left, clamp to left edge
  if (x < 10) {
    x = 10;
  }

  // If it would still overflow right after all adjustments, clamp to right edge
  if (x + submenuRect.width > viewportWidth - 10) {
    x = viewportWidth - submenuRect.width - 10;
  }

  // Adjust y position if menu would overflow bottom
  if (y + submenuRect.height > viewportHeight) {
    y = viewportHeight - submenuRect.height - 10;
  }

  // Adjust y position if menu would overflow top
  if (y < 10) {
    y = 10;
  }

  moveSubmenu.style.left = `${x}px`;
  moveSubmenu.style.top = `${y}px`;

  // Hide submenu when mouse leaves both menus
  const hideSubmenuOnLeave = (e) => {
    const target = e.relatedTarget;
    if (!moveSubmenu.contains(target) && !moveItem.contains(target)) {
      moveSubmenu.classList.add('hidden');
    }
  };

  moveSubmenu.addEventListener('mouseleave', hideSubmenuOnLeave);
  moveItem.addEventListener('mouseleave', (e) => {
    // Small delay to allow moving to submenu
    setTimeout(() => {
      if (!moveSubmenu.matches(':hover')) {
        moveSubmenu.classList.add('hidden');
      }
    }, 100);
  });
}

async function handleMoveToWindow(windowId) {
  const tabIds = getTabsToMove();
  if (tabIds.length === 0) return;

  try {
    await chrome.tabs.move(tabIds, { windowId, index: -1 });
    selectedTabs.clear();
    updateMultiSelectInfoBar();
    hideContextMenu();
    loadCurrentView();
  } catch (error) {
    console.error('[TabSentry] Failed to move tabs:', error);
  }
}

async function handleMoveToNewWindow() {
  if (!contextMenuTabId) return;
  await showNewWindowModal();
}

function showCopySubmenu(e) {
  const copySubmenu = document.getElementById('copy-submenu');
  const contextMenu = document.getElementById('tab-context-menu');
  if (!copySubmenu || !contextMenu || !contextMenuTabData) return;

  // Hide move submenu if open
  const moveSubmenu = document.getElementById('move-submenu');
  if (moveSubmenu) {
    moveSubmenu.classList.add('hidden');
  }

  // Position submenu next to the copy button
  const copyItem = contextMenu.querySelector('[data-action="copy"]');
  const copyItemRect = copyItem.getBoundingClientRect();
  const contextMenuRect = contextMenu.getBoundingClientRect();

  copySubmenu.classList.remove('hidden');

  const submenuRect = copySubmenu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Try to position to the right of the context menu
  let x = contextMenuRect.right + 4;
  let y = copyItemRect.top;

  // If it would overflow right, position to the left instead
  if (x + submenuRect.width > viewportWidth) {
    x = contextMenuRect.left - submenuRect.width - 4;
  }

  // If it would still overflow left, clamp to left edge
  if (x < 10) {
    x = 10;
  }

  // If it would overflow bottom, adjust
  if (y + submenuRect.height > viewportHeight) {
    y = viewportHeight - submenuRect.height - 10;
  }

  // If it would overflow top, clamp
  if (y < 10) {
    y = 10;
  }

  copySubmenu.style.left = `${x}px`;
  copySubmenu.style.top = `${y}px`;

  // Hide submenu when mouse leaves both menus
  const hideSubmenuOnLeave = (e) => {
    const target = e.relatedTarget;
    if (!copySubmenu.contains(target) && !copyItem.contains(target)) {
      copySubmenu.classList.add('hidden');
    }
  };

  copySubmenu.addEventListener('mouseleave', hideSubmenuOnLeave);
  copyItem.addEventListener('mouseleave', (e) => {
    // Small delay to allow moving to submenu
    setTimeout(() => {
      if (!copySubmenu.matches(':hover')) {
        copySubmenu.classList.add('hidden');
      }
    }, 100);
  });
}

async function handleCopyAction(action) {
  if (!contextMenuTabData) return;

  let textToCopy = '';
  let toastMessage = '';

  switch (action) {
    case 'url':
      textToCopy = contextMenuTabData.url;
      toastMessage = 'URL copied to clipboard';
      break;
    case 'title-url':
      textToCopy = `${contextMenuTabData.title}\n${contextMenuTabData.url}`;
      toastMessage = 'Title & URL copied to clipboard';
      break;
    default:
      return;
  }

  try {
    await navigator.clipboard.writeText(textToCopy);
    hideContextMenu();
    showToast(toastMessage);
  } catch (error) {
    console.error('[TabSentry] Failed to copy to clipboard:', error);
  }
}

function showToast(message) {
  const toast = document.getElementById('toast');
  const toastMessage = toast?.querySelector('.toast-message');
  if (!toast || !toastMessage) return;

  toastMessage.textContent = message;
  toast.classList.remove('hidden');

  // Trigger reflow to restart animation
  void toast.offsetWidth;
  toast.classList.add('show');

  // Auto-hide after 2 seconds
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      toast.classList.add('hidden');
    }, 200);
  }, 2000);
}

async function showNewWindowModal() {
  const modal = document.getElementById('new-window-modal');
  const nameInput = document.getElementById('new-window-name-input');
  const tabsList = document.getElementById('new-window-tabs-list');
  const tabsCount = document.getElementById('new-window-tabs-count');

  // Get tabs to move
  const tabIds = getTabsToMove();
  const tabsData = await getTabDataForIds(tabIds);
  newWindowTabsToMove = tabsData;

  // Populate tabs list
  tabsList.innerHTML = '';
  tabsCount.textContent = `${tabsData.length} tab${tabsData.length > 1 ? 's' : ''}`;

  tabsData.forEach(tab => {
    const item = document.createElement('div');
    item.className = 'new-window-tab-item';
    item.innerHTML = `
      <img class="new-window-tab-favicon" src="${getSafeFaviconUrl(tab.favIconUrl)}" onerror="this.src='${DEFAULT_FAVICON}'">
      <span class="new-window-tab-title">${tab.title || 'Untitled'}</span>
    `;
    tabsList.appendChild(item);
  });

  nameInput.value = '';
  hideContextMenu();
  modal.classList.remove('hidden');
  setTimeout(() => nameInput?.focus(), 50);

  // Setup handlers (clone buttons to clear old listeners)
  setupNewWindowModalHandlers();
}

function setupNewWindowModalHandlers() {
  const modal = document.getElementById('new-window-modal');
  const nameInput = document.getElementById('new-window-name-input');
  const cancelBtn = document.getElementById('new-window-cancel');
  const confirmBtn = document.getElementById('new-window-confirm');

  const newCancel = cancelBtn.cloneNode(true);
  const newConfirm = confirmBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
  confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);

  const closeModal = () => {
    modal.classList.add('hidden');
    newWindowTabsToMove = [];
  };

  const createWindow = async () => {
    await executeNewWindowCreation(nameInput.value.trim());
    closeModal();
  };

  newCancel.addEventListener('click', closeModal);
  newConfirm.addEventListener('click', createWindow);
  nameInput.onkeydown = (e) => {
    if (e.key === 'Enter') createWindow();
    if (e.key === 'Escape') closeModal();
  };
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };
}

async function executeNewWindowCreation(windowName) {
  if (newWindowTabsToMove.length === 0) return;

  try {
    const firstTab = newWindowTabsToMove[0];
    const newWindow = await chrome.windows.create({ tabId: firstTab.id });

    // Move remaining tabs
    if (newWindowTabsToMove.length > 1) {
      const remainingIds = newWindowTabsToMove.slice(1).map(t => t.id);
      await chrome.tabs.move(remainingIds, { windowId: newWindow.id, index: -1 });
    }

    // Save window name if provided
    if (windowName) {
      await chrome.runtime.sendMessage({
        type: 'UPDATE_WINDOW_TITLE',
        windowId: newWindow.id,
        title: windowName
      });
    }

    // Clear selection and reload
    selectedTabs.clear();
    updateMultiSelectInfoBar();
    loadCurrentView();
  } catch (error) {
    console.error('[TabSentry] Failed to create new window:', error);
  }
}

function handleTabRightClick(e, tab) {
  e.preventDefault();
  e.stopPropagation();
  showContextMenu(e.clientX, e.clientY, tab);
}

