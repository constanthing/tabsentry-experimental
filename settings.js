import DB from './background/db.js';

const db = new DB();

// Default settings values
const defaultSettings = {
  // Auto-Close
  autoCloseEnabled: false,
  autoCloseTimeLimit: 24,
  protectPinnedTabs: true,
  keepOpenThreshold: 5,
  thresholdScope: 'browser-wide',
  quickAccumulate: false,
  showTimeAccumulated: true,
  // Appearance
  raisePinnedTabs: false,
  showRecentSearches: true,
  theme: 'light',
  // AI
  aiTaggingEnabled: false,
  // Smart Organizer
  smartOrganizerEnabled: false,
  // Backup
  backupMethod: [],
  backupContent: ['everything'],
  exportFormats: ['json']
};

document.addEventListener('DOMContentLoaded', async () => {
  await loadAllSettings();
  initNavigation();
  initThemeToggle();
  initToggleSwitches();
  initNumberInputs();
  initDropdowns();
  initCheckboxes();
  initActionButtons();
  initBackButton();
  await loadFilters();
  initFilterUI();
});

// Load all settings from the database
async function loadAllSettings() {
  // Load theme first and apply it
  const savedTheme = await db.getSetting('theme');
  const theme = savedTheme || defaultSettings.theme;
  applyTheme(theme);
  updateThemeToggleSelection(theme);

  // Load toggle switches
  const toggles = document.querySelectorAll('.toggle-switch input[data-setting]');
  for (const toggle of toggles) {
    const settingName = toggle.dataset.setting;
    const savedValue = await db.getSetting(settingName);
    toggle.checked = savedValue !== null ? savedValue : defaultSettings[settingName];
  }

  // Load number inputs
  const numberInputs = document.querySelectorAll('.number-input[data-setting]');
  for (const input of numberInputs) {
    const settingName = input.dataset.setting;
    const savedValue = await db.getSetting(settingName);
    input.value = savedValue !== null ? savedValue : defaultSettings[settingName];
  }

  // Load dropdowns
  const dropdowns = document.querySelectorAll('.select-dropdown[data-setting]');
  for (const dropdown of dropdowns) {
    const settingName = dropdown.dataset.setting;
    const savedValue = await db.getSetting(settingName);
    dropdown.value = savedValue !== null ? savedValue : defaultSettings[settingName];
  }

  // Load checkbox groups
  const checkboxSettings = ['backupMethod', 'backupContent', 'exportFormats'];
  for (const settingName of checkboxSettings) {
    const savedValue = await db.getSetting(settingName);
    const values = savedValue !== null ? savedValue : defaultSettings[settingName];
    const checkboxes = document.querySelectorAll(`input[data-setting="${settingName}"]`);
    checkboxes.forEach(checkbox => {
      checkbox.checked = values.includes(checkbox.value);
    });
  }
}

// Navigation between sections
function initNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const panels = document.querySelectorAll('.settings-panel');

  function switchToSection(sectionId) {
    const targetNav = document.querySelector(`.nav-item[data-section="${sectionId}"]`);
    if (!targetNav) return;

    // Update active nav item
    navItems.forEach(nav => nav.classList.remove('active'));
    targetNav.classList.add('active');

    // Update active panel
    panels.forEach(panel => {
      panel.classList.toggle('active', panel.dataset.section === sectionId);
    });
  }

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const sectionId = item.dataset.section;
      switchToSection(sectionId);
    });
  });

  // Handle hash navigation on page load
  const hash = window.location.hash.slice(1);
  if (hash) {
    switchToSection(hash);
  }
}

// Theme toggle (special handling for button group)
function initThemeToggle() {
  const themeToggle = document.getElementById('theme-toggle');
  if (!themeToggle) return;

  themeToggle.addEventListener('click', async (e) => {
    const themeOption = e.target.closest('.theme-option');
    if (!themeOption) return;

    const theme = themeOption.dataset.theme;
    await db.setSetting('theme', theme);
    applyTheme(theme);
    updateThemeToggleSelection(theme);
  });
}

function applyTheme(theme) {
  if (theme === 'dark') {
    document.body.classList.add('dark-mode');
  } else {
    document.body.classList.remove('dark-mode');
  }
}

function updateThemeToggleSelection(theme) {
  const themeOptions = document.querySelectorAll('.theme-option');
  themeOptions.forEach(option => {
    option.classList.toggle('active', option.dataset.theme === theme);
  });
}

// Toggle switches auto-save
function initToggleSwitches() {
  const toggles = document.querySelectorAll('.toggle-switch input[data-setting]');

  toggles.forEach(toggle => {
    toggle.addEventListener('change', async () => {
      const settingName = toggle.dataset.setting;
      await db.setSetting(settingName, toggle.checked);
    });
  });
}

// Number inputs auto-save
function initNumberInputs() {
  const numberInputs = document.querySelectorAll('.number-input[data-setting]');

  numberInputs.forEach(input => {
    input.addEventListener('change', async () => {
      const settingName = input.dataset.setting;
      const value = parseInt(input.value, 10);

      // Ensure value is within bounds
      const min = parseInt(input.min, 10) || 1;
      const max = parseInt(input.max, 10) || 9999;
      const clampedValue = Math.max(min, Math.min(max, value));

      input.value = clampedValue;
      await db.setSetting(settingName, clampedValue);
    });
  });
}

// Dropdowns auto-save
function initDropdowns() {
  const dropdowns = document.querySelectorAll('.select-dropdown[data-setting]');

  dropdowns.forEach(dropdown => {
    dropdown.addEventListener('change', async () => {
      const settingName = dropdown.dataset.setting;
      await db.setSetting(settingName, dropdown.value);
    });
  });
}

// Checkbox groups auto-save
function initCheckboxes() {
  const checkboxSettings = ['backupMethod', 'backupContent', 'exportFormats'];

  checkboxSettings.forEach(settingName => {
    const checkboxes = document.querySelectorAll(`input[data-setting="${settingName}"]`);

    checkboxes.forEach(checkbox => {
      checkbox.addEventListener('change', async () => {
        // Gather all checked values for this setting
        const checkedValues = [];
        checkboxes.forEach(cb => {
          if (cb.checked) {
            checkedValues.push(cb.value);
          }
        });

        await db.setSetting(settingName, checkedValues);
      });
    });
  });
}

// Action buttons (Backup Now, Restore from File)
function initActionButtons() {
  const backupBtn = document.getElementById('backup-now');
  const restoreBtn = document.getElementById('restore-file');
  const fileInput = document.getElementById('restore-file-input');

  if (backupBtn) {
    backupBtn.addEventListener('click', handleBackupNow);
  }

  if (restoreBtn && fileInput) {
    restoreBtn.addEventListener('click', () => {
      fileInput.click();
    });

    fileInput.addEventListener('change', handleRestoreFile);
  }
}

async function handleBackupNow() {
  try {
    // Get backup preferences
    const backupContent = await db.getSetting('backupContent') || ['everything'];
    const exportFormats = await db.getSetting('exportFormats') || ['json'];

    const backupData = {
      version: 1,
      timestamp: new Date().toISOString(),
      data: {}
    };

    // Determine what to backup
    const backupEverything = backupContent.includes('everything');

    if (backupEverything || backupContent.includes('systemSettings')) {
      const settings = await db.db.settings.toArray();
      backupData.data.settings = settings;
    }

    if (backupEverything || backupContent.includes('closedTabs')) {
      const closedTabs = await db.db.closedTabs?.toArray() || [];
      backupData.data.closedTabs = closedTabs;
    }

    if (backupEverything || backupContent.includes('windows')) {
      const windows = await db.db.windows?.toArray() || [];
      backupData.data.windows = windows;
    }

    if (backupEverything || backupContent.includes('savedForLater')) {
      const savedForLater = await db.db.savedForLater?.toArray() || [];
      backupData.data.savedForLater = savedForLater;
    }

    if (backupEverything || backupContent.includes('nicknames')) {
      const nicknames = await db.db.nicknames?.toArray() || [];
      backupData.data.nicknames = nicknames;
    }

    // Export based on format
    if (exportFormats.includes('json')) {
      const jsonString = JSON.stringify(backupData, null, 2);
      downloadFile(jsonString, `tabsentry-backup-${formatDate(new Date())}.json`, 'application/json');
    }

    if (exportFormats.includes('csv')) {
      // Convert to CSV format (simplified version)
      const csvContent = convertToCSV(backupData);
      downloadFile(csvContent, `tabsentry-backup-${formatDate(new Date())}.csv`, 'text/csv');
    }
  } catch (error) {
    console.error('Backup failed:', error);
    alert('Backup failed. Please try again.');
  }
}

async function handleRestoreFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const content = await file.text();
    const backupData = JSON.parse(content);

    // Detect format: array = new format, object = old format
    if (Array.isArray(backupData)) {
      await restoreFromNewFormat(backupData);
    } else {
      // Old format validation
      if (!backupData.version || !backupData.data) {
        throw new Error('Invalid backup file format');
      }

      // Restore settings
      if (backupData.data.settings) {
        for (const setting of backupData.data.settings) {
          await db.setSetting(setting.title, setting.value);
        }
      }

      // Restore other data tables
      if (backupData.data.closedTabs && db.db.closedTabs) {
        await db.db.closedTabs.bulkPut(backupData.data.closedTabs);
      }

      if (backupData.data.windows && db.db.windows) {
        await db.db.windows.bulkPut(backupData.data.windows);
      }

      if (backupData.data.savedForLater && db.db.savedForLater) {
        await db.db.savedForLater.bulkPut(backupData.data.savedForLater);
      }

      if (backupData.data.nicknames && db.db.nicknames) {
        await db.db.nicknames.bulkPut(backupData.data.nicknames);
      }
    }

    // Reload settings to reflect changes
    await loadAllSettings();

    alert('Restore completed successfully!');
  } catch (error) {
    console.error('Restore failed:', error);
    alert('Restore failed. Please check the file format and try again.');
  }

  // Reset file input
  event.target.value = '';
}

// New format restore functions
async function restoreFromNewFormat(backupArray) {
  for (const item of backupArray) {
    switch (item.type) {
      case 'nicknames':
        await restoreNicknames(item.data);
        break;
      case 'saved-for-later':
        await restoreSavedForLater(item.data);
        break;
      case 'windows':
        await restoreWindows(item.data);
        break;
      case 'system-settings':
        await restoreSystemSettings(item.data);
        break;
      case 'filters':
        await restoreFilters(item.data);
        break;
    }
  }
}

async function restoreNicknames(data) {
  if (!data || !db.db.nicknames) return;

  const nicknames = data.map(item => ({
    url: item.url,
    nickname: item.nickname
  }));

  await db.db.nicknames.bulkPut(nicknames);
}

async function restoreSavedForLater(data) {
  if (!data || !db.db.savedWindows) return;

  await db.db.savedWindows.bulkPut(data);
}

async function restoreWindows(data) {
  if (!data) return;

  // Get all currently open Chrome windows
  const openWindows = await chrome.windows.getAll();
  const openWindowIds = new Set(openWindows.map(w => w.id));

  // Get current anchor window info
  const anchorResponse = await chrome.runtime.sendMessage({ type: 'GET_ANCHOR_WINDOW' });
  const currentAnchorWindowId = anchorResponse?.success ? anchorResponse.activeAnchorWindowId : null;

  for (const backupWindow of data) {
    const windowId = backupWindow._windowId;

    // Only process if window is currently open
    if (!openWindowIds.has(windowId)) continue;

    // Determine title to use: prefer title, fall back to aiTitle if title is empty
    const titleToUse = backupWindow.title || backupWindow.aiTitle;
    if (titleToUse) {
      await db.updateWindow(windowId, { title: titleToUse });
    }

    // Set as anchor window if anchored: 1
    if (backupWindow.anchored === 1) {
      // Skip if this window is already the anchor
      if (currentAnchorWindowId === windowId) continue;

      // Clear current anchor window and snapshots first
      await chrome.runtime.sendMessage({ type: 'CLEAR_ANCHOR_WINDOW' });

      // Set new anchor window
      await chrome.runtime.sendMessage({
        type: 'SET_ANCHOR_WINDOW',
        windowId
      });
    }
  }
}

async function restoreSystemSettings(data) {
  if (!data) return;

  // Mapping from backup names to DB setting names
  const settingsMap = {
    'auto-close-threshold': 'keepOpenThreshold',
    'auto-close-threshold-source': 'thresholdScope',
    'autoClose': 'autoCloseEnabled'
  };

  for (const setting of data) {
    const dbSettingName = settingsMap[setting.name];

    // Only restore allowed settings
    if (dbSettingName) {
      await db.setSetting(dbSettingName, setting.value);
    }
  }
}

async function restoreFilters(data) {
  if (!data || !db.db.filters) return;

  for (const filter of data) {
    // Skip if no conditions
    if (!filter.conditions || filter.conditions.length === 0) continue;

    // Extract properties from the first condition
    const condition = filter.conditions[0];

    // Normalize value to array format (values)
    const values = Array.isArray(condition.value)
      ? condition.value
      : [condition.value];

    const filterData = {
      name: filter.name,
      property: condition.property,
      operator: condition.operator,
      values: values,
      smartWindowAction: 'none'
    };

    await db.db.filters.add({
      ...filterData,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function convertToCSV(backupData) {
  let csv = 'Category,Key,Value\n';

  // Convert settings to CSV
  if (backupData.data.settings) {
    backupData.data.settings.forEach(setting => {
      const value = typeof setting.value === 'object'
        ? JSON.stringify(setting.value)
        : setting.value;
      csv += `Settings,${escapeCSV(setting.title)},${escapeCSV(String(value))}\n`;
    });
  }

  // Add other data as needed
  if (backupData.data.closedTabs) {
    backupData.data.closedTabs.forEach(tab => {
      csv += `ClosedTab,${escapeCSV(tab.title || '')},${escapeCSV(tab.url || '')}\n`;
    });
  }

  return csv;
}

function escapeCSV(value) {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function initBackButton() {
  const backBtn = document.getElementById('back-btn');
  backBtn.addEventListener('click', () => {
    window.location.href = 'popup.html';
  });
}

// Filter management
let editingFilterId = null;

async function loadFilters() {
  const filterList = document.getElementById('filter-list');
  if (!filterList) return;

  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ALL_FILTERS' });

    if (!response.success) {
      filterList.innerHTML = '<div class="empty-state">Error loading filters</div>';
      return;
    }

    if (response.filters.length === 0) {
      filterList.innerHTML = '<div class="empty-state">No filters created yet</div>';
      return;
    }

    filterList.innerHTML = response.filters.map(filter => {
      // Support both single value (backwards compatibility) and array of values
      const values = filter.values && filter.values.length > 0
        ? filter.values
        : (filter.value ? [filter.value] : []);
      const valuesDisplay = values.map(v => `"${escapeHtml(v)}"`).join(', ');

      return `
      <div class="filter-item" data-filter-id="${filter.id}">
        <div class="filter-info">
          <span class="filter-name">${escapeHtml(filter.name)}</span>
          <span class="filter-condition">
            ${filter.property} ${filter.operator} ${valuesDisplay}
          </span>
          <span class="filter-action-badge filter-action-${filter.smartWindowAction}">
            ${getActionLabel(filter.smartWindowAction)}
          </span>
        </div>
        <div class="filter-actions">
          <button class="filter-edit-btn" title="Edit filter">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M11.5 2.5L13.5 4.5L5 13H3V11L11.5 2.5Z" stroke="currentColor" stroke-width="1.5"/>
            </svg>
          </button>
          <button class="filter-delete-btn" title="Delete filter">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M4 4L12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <path d="M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </div>
    `;
    }).join('');

    // Attach event listeners
    filterList.querySelectorAll('.filter-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const filterId = parseInt(e.target.closest('.filter-item').dataset.filterId);
        openEditFilterModal(filterId);
      });
    });

    filterList.querySelectorAll('.filter-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const filterId = parseInt(e.target.closest('.filter-item').dataset.filterId);
        if (confirm('Are you sure you want to delete this filter?')) {
          await chrome.runtime.sendMessage({ type: 'DELETE_FILTER', filterId });
          await loadFilters();
        }
      });
    });
  } catch (e) {
    filterList.innerHTML = '<div class="empty-state">Error loading filters</div>';
    console.error('[TabSentry] Failed to load filters:', e);
  }
}

function getActionLabel(action) {
  switch (action) {
    case 'move': return 'Auto-move';
    case 'delete': return 'Auto-close';
    default: return 'Filter only';
  }
}

function initFilterUI() {
  const addBtn = document.getElementById('add-filter-btn');
  const modal = document.getElementById('filter-modal');
  const closeBtn = document.getElementById('filter-modal-close');
  const cancelBtn = document.getElementById('filter-modal-cancel');
  const saveBtn = document.getElementById('filter-modal-save');
  const addValueBtn = document.getElementById('add-filter-value');

  if (!addBtn || !modal) return;

  addBtn.addEventListener('click', () => openAddFilterModal());
  closeBtn?.addEventListener('click', () => closeFilterModal());
  cancelBtn?.addEventListener('click', () => closeFilterModal());

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeFilterModal();
  });

  saveBtn?.addEventListener('click', () => saveFilter());
  addValueBtn?.addEventListener('click', () => addFilterValueRow());

  // Delegate click handler for remove buttons
  const valuesContainer = document.getElementById('filter-values-container');
  valuesContainer?.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.filter-value-remove');
    if (removeBtn) {
      const row = removeBtn.closest('.filter-value-row');
      const rows = valuesContainer.querySelectorAll('.filter-value-row');
      // Keep at least one row
      if (rows.length > 1) {
        row.remove();
      }
    }
  });
}

function addFilterValueRow(value = '') {
  const container = document.getElementById('filter-values-container');
  if (!container) return;

  const row = document.createElement('div');
  row.className = 'filter-value-row';
  row.innerHTML = `
    <input type="text" class="form-input filter-value-input" placeholder="Value to match" value="${escapeHtml(value)}">
    <button type="button" class="filter-value-remove" title="Remove value">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M4 4L12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <path d="M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>
  `;
  container.appendChild(row);
}

function setFilterValues(values) {
  const container = document.getElementById('filter-values-container');
  if (!container) return;

  // Clear existing rows
  container.innerHTML = '';

  // Ensure we have at least one value
  const valueList = values && values.length > 0 ? values : [''];

  valueList.forEach(value => {
    const row = document.createElement('div');
    row.className = 'filter-value-row';
    row.innerHTML = `
      <input type="text" class="form-input filter-value-input" placeholder="Value to match" value="${escapeHtml(value)}">
      <button type="button" class="filter-value-remove" title="Remove value">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M4 4L12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    `;
    container.appendChild(row);
  });
}

function getFilterValues() {
  const container = document.getElementById('filter-values-container');
  if (!container) return [];

  const inputs = container.querySelectorAll('.filter-value-input');
  const values = [];
  inputs.forEach(input => {
    const val = input.value.trim();
    if (val) values.push(val);
  });
  return values;
}

function openAddFilterModal() {
  editingFilterId = null;
  document.getElementById('filter-modal-title').textContent = 'Add Filter';
  document.getElementById('filter-name').value = '';
  document.getElementById('filter-property').value = 'url';
  document.getElementById('filter-operator').value = 'includes';
  setFilterValues(['']);
  document.getElementById('filter-action').value = 'none';
  document.getElementById('filter-modal').classList.remove('hidden');
}

async function openEditFilterModal(filterId) {
  const response = await chrome.runtime.sendMessage({ type: 'GET_FILTER', filterId });
  if (!response.success || !response.filter) return;

  const filter = response.filter;
  editingFilterId = filterId;

  document.getElementById('filter-modal-title').textContent = 'Edit Filter';
  document.getElementById('filter-name').value = filter.name;
  document.getElementById('filter-property').value = filter.property;
  document.getElementById('filter-operator').value = filter.operator;

  // Support both single value (backwards compatibility) and array of values
  const values = filter.values && filter.values.length > 0
    ? filter.values
    : (filter.value ? [filter.value] : ['']);
  setFilterValues(values);

  document.getElementById('filter-action').value = filter.smartWindowAction;
  document.getElementById('filter-modal').classList.remove('hidden');
}

function closeFilterModal() {
  document.getElementById('filter-modal').classList.add('hidden');
  editingFilterId = null;
}

async function saveFilter() {
  const name = document.getElementById('filter-name').value.trim();
  const property = document.getElementById('filter-property').value;
  const operator = document.getElementById('filter-operator').value;
  const values = getFilterValues();
  const smartWindowAction = document.getElementById('filter-action').value;

  // Validation
  if (!name) {
    alert('Please enter a filter name');
    return;
  }
  if (values.length === 0) {
    alert('Please enter at least one value to match');
    return;
  }

  const filterData = { name, property, operator, values, smartWindowAction };

  try {
    if (editingFilterId) {
      await chrome.runtime.sendMessage({
        type: 'UPDATE_FILTER',
        filterId: editingFilterId,
        filterData
      });
    } else {
      await chrome.runtime.sendMessage({
        type: 'ADD_FILTER',
        filterData
      });
    }

    closeFilterModal();
    await loadFilters();
  } catch (e) {
    console.error('[TabSentry] Failed to save filter:', e);
    alert('Failed to save filter. Please try again.');
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
