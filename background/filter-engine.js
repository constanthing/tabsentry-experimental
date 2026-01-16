/**
 * FilterEngine - Handles filter matching logic for tabs
 */
export class FilterEngine {
    constructor(db) {
        this.db = db;
    }

    /**
     * Normalizes a URL for matching by removing protocol and trailing patterns
     * @param {string} url - The URL to normalize
     * @returns {string} - Normalized URL
     */
    normalizeUrl(url) {
        if (!url) return '';

        return url
            .replace(/^https?:\/\//, '')  // Remove http:// or https://
            .replace(/\/\*$/, '')          // Remove trailing /*
            .replace(/\/$/, '')            // Remove trailing /
            .toLowerCase();
    }

    /**
     * Checks if a tab matches a filter condition
     * @param {Object} tab - Tab object with title and url
     * @param {Object} filter - Filter object
     * @returns {boolean}
     */
    matchTab(tab, filter) {
        const { property, operator, value, values } = filter;

        // Support both single value (backwards compatibility) and array of values
        const valueList = values && Array.isArray(values) && values.length > 0
            ? values
            : (value ? [value] : []);

        if (valueList.length === 0) return false;

        let tabValue;
        if (property === 'url') {
            tabValue = this.normalizeUrl(tab.url);
        } else if (property === 'title') {
            tabValue = (tab.title || '').toLowerCase();
        } else {
            return false;
        }

        // Check if any value in the list matches (OR logic)
        return valueList.some(val => {
            const filterValue = property === 'url'
                ? this.normalizeUrl(val)
                : val.toLowerCase();

            if (operator === 'equals') {
                return tabValue === filterValue;
            } else if (operator === 'includes') {
                return tabValue.includes(filterValue);
            }
            return false;
        });
    }

    /**
     * Finds all filters that match a given tab
     * @param {Object} tab - Tab object
     * @returns {Promise<Array>} - Array of matching filters
     */
    async findMatchingFilters(tab) {
        const allFilters = await this.db.getAllFilters();
        return allFilters.filter(filter => this.matchTab(tab, filter));
    }

    /**
     * Filters an array of tabs based on a filter
     * @param {Array} tabs - Array of tab objects
     * @param {Object} filter - Filter object
     * @returns {Array} - Filtered tabs
     */
    filterTabs(tabs, filter) {
        return tabs.filter(tab => this.matchTab(tab, filter));
    }

    /**
     * Processes a tab update event for Smart Window Organizer
     * @param {Object} tab - The updated tab
     * @returns {Promise<{action: string, filter: Object|null}>}
     */
    async processTabUpdate(tab) {
        const matchingFilters = await this.findMatchingFilters(tab);

        // Priority: delete > move > none
        const deleteFilter = matchingFilters.find(f => f.smartWindowAction === 'delete');
        if (deleteFilter) {
            return { action: 'delete', filter: deleteFilter };
        }

        const moveFilter = matchingFilters.find(f => f.smartWindowAction === 'move');
        if (moveFilter) {
            return { action: 'move', filter: moveFilter };
        }

        return { action: 'none', filter: null };
    }

    /**
     * Finds or creates a window with the given title
     * @param {string} windowTitle - The target window title
     * @returns {Promise<{windowId: number, defaultTabId: number|null}>} - The window ID and default tab to close
     */
    async findOrCreateWindowByTitle(windowTitle) {
        // First, check existing windows in the database (case-insensitive match)
        const allWindows = await this.db.getNonOrphanWindows();
        const matchingWindow = allWindows.find(w =>
            w.title && w.title.toLowerCase() === windowTitle.toLowerCase()
        );

        if (matchingWindow) {
            // Verify window still exists in Chrome
            try {
                await chrome.windows.get(matchingWindow.id);
                console.log('[TabSentry] Found existing window with title:', windowTitle, 'windowId:', matchingWindow.id);
                return { windowId: matchingWindow.id, defaultTabId: null };
            } catch {
                // Window no longer exists, will create new one
                console.log('[TabSentry] Window in DB no longer exists, creating new one');
            }
        }

        // Create new window (Chrome creates it with a default new tab)
        const newWindow = await chrome.windows.create({});
        const defaultTabId = newWindow.tabs?.[0]?.id || null;

        // Wait for onCreated listener to add window to DB, then update title
        // Retry a few times to handle race condition with onCreated listener
        let retries = 10;
        while (retries > 0) {
            const windowInDb = await this.db.getWindow(newWindow.id);
            if (windowInDb) {
                await this.db.updateWindow(newWindow.id, { title: windowTitle });
                console.log('[TabSentry] Set window title to:', windowTitle);
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
            retries--;
        }

        return { windowId: newWindow.id, defaultTabId };
    }

    /**
     * Executes the move action for a tab
     * @param {number} tabId - The tab ID to move
     * @param {Object} filter - The filter triggering the move
     */
    async executeMove(tabId, filter) {
        try {
            // Get current tab to check if it's already in target window
            const tab = await chrome.tabs.get(tabId);

            const { windowId: targetWindowId, defaultTabId } = await this.findOrCreateWindowByTitle(filter.name);

            if (tab.windowId === targetWindowId) {
                return; // Already in correct window
            }

            // Check for existing tab with same URL in target window and remove it
            const targetWindowTabs = await chrome.tabs.query({ windowId: targetWindowId });
            const movingTabUrl = this.normalizeUrl(tab.url);
            for (const existingTab of targetWindowTabs) {
                if (existingTab.id !== tabId && this.normalizeUrl(existingTab.url) === movingTabUrl) {
                    try {
                        await chrome.tabs.remove(existingTab.id);
                        console.log('[TabSentry] Removed duplicate tab in target window:', existingTab.id);
                    } catch {
                        // Tab may already be closed
                    }
                }
            }

            // Move tab to end of tabs list in target window
            await chrome.tabs.move(tabId, { windowId: targetWindowId, index: -1 });
            console.log('[TabSentry] Moved tab to window:', filter.name);

            // Track automoved tab
            await this.trackAutomovedTab(tab, filter.name);

            // Close the default new tab that Chrome created with the window
            if (defaultTabId) {
                try {
                    await chrome.tabs.remove(defaultTabId);
                    console.log('[TabSentry] Closed default new tab:', defaultTabId);
                } catch {
                    // Tab may already be closed or doesn't exist
                }
            }
        } catch (e) {
            console.error('[TabSentry] Failed to move tab:', e);
        }
    }

    /**
     * Executes the delete action for a tab
     * @param {number} tabId - The tab ID to close
     */
    async executeDelete(tabId) {
        try {
            await chrome.tabs.remove(tabId);
            console.log('[TabSentry] Auto-closed tab:', tabId);
        } catch (e) {
            console.error('[TabSentry] Failed to close tab:', e);
        }
    }

    /**
     * Tracks an automoved tab in the database
     * @param {Object} tab - The tab that was moved
     * @param {string} targetWindow - The window name it was moved to
     */
    async trackAutomovedTab(tab, targetWindow) {
        try {
            await this.db.addAutomovedTab({
                tabId: tab.id,
                url: tab.url,
                title: tab.title,
                favicon: tab.favIconUrl,
                targetWindow: targetWindow
            });
            console.log('[TabSentry] Tracked automoved tab');
        } catch (e) {
            console.error('[TabSentry] Failed to track automoved tab:', e);
        }
    }
}
