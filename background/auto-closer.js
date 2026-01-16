const AUTO_CLOSE_ALARM_NAME = 'auto-close-check';
const NORMAL_INTERVAL_MINUTES = 30;
const QUICK_INTERVAL_MINUTES = 10 / 60; // 10 seconds in minutes
const NORMAL_TIME_INCREMENT_MS = 30 * 60 * 1000; // 30 minutes in milliseconds
const QUICK_TIME_INCREMENT_MS = 60 * 60 * 1000; // 1 hour in milliseconds (for quick testing)

export class AutoCloser {
    constructor(db) {
        this.db = db;
        this.timeIncrementMs = NORMAL_TIME_INCREMENT_MS;
    }

    async initialize() {
        // Check if quick accumulate mode is enabled
        const quickAccumulate = await this.db.getSetting('quickAccumulate');
        const intervalMinutes = quickAccumulate ? QUICK_INTERVAL_MINUTES : NORMAL_INTERVAL_MINUTES;
        this.timeIncrementMs = quickAccumulate ? QUICK_TIME_INCREMENT_MS : NORMAL_TIME_INCREMENT_MS;

        // Create the recurring alarm
        await chrome.alarms.create(AUTO_CLOSE_ALARM_NAME, {
            periodInMinutes: intervalMinutes
        });

        // Register the alarm listener
        chrome.alarms.onAlarm.addListener(async (alarm) => {
            if (alarm.name === AUTO_CLOSE_ALARM_NAME) {
                await this.processAutoClose();
            }
        });

        const intervalDisplay = quickAccumulate ? '10-second' : '30-minute';
        console.log(`[TabSentry] AutoCloser initialized with ${intervalDisplay} interval`);
    }

    async recreateAlarm() {
        // Clear existing alarm
        await chrome.alarms.clear(AUTO_CLOSE_ALARM_NAME);

        // Check current setting and recreate with appropriate interval
        const quickAccumulate = await this.db.getSetting('quickAccumulate');
        const intervalMinutes = quickAccumulate ? QUICK_INTERVAL_MINUTES : NORMAL_INTERVAL_MINUTES;
        this.timeIncrementMs = quickAccumulate ? QUICK_TIME_INCREMENT_MS : NORMAL_TIME_INCREMENT_MS;

        await chrome.alarms.create(AUTO_CLOSE_ALARM_NAME, {
            periodInMinutes: intervalMinutes
        });

        const intervalDisplay = quickAccumulate ? '10-second' : '30-minute';
        console.log(`[TabSentry] AutoCloser alarm recreated with ${intervalDisplay} interval`);
    }

    async processAutoClose() {
        console.log('[TabSentry] Running auto-close check...');

        // Get settings
        const autoCloseEnabled = await this.db.getSetting('autoCloseEnabled');
        if (!autoCloseEnabled) {
            console.log('[TabSentry] Auto-close is disabled, skipping');
            return;
        }

        // Check if quickAccumulate setting changed and update interval if needed
        const quickAccumulate = await this.db.getSetting('quickAccumulate');
        const expectedIncrement = quickAccumulate ? QUICK_TIME_INCREMENT_MS : NORMAL_TIME_INCREMENT_MS;
        if (this.timeIncrementMs !== expectedIncrement) {
            await this.recreateAlarm();
        }

        // Get all non-orphan tabs
        const tabs = await this.db.getNonOrphanTabs();

        // Add time increment to timeAccumulated for all tabs
        for (const tab of tabs) {
            const newTimeAccumulated = (tab.timeAccumulated || 0) + this.timeIncrementMs;
            await this.db.updateTab(tab.id, { timeAccumulated: newTimeAccumulated });
        }

        const incrementDisplay = this.timeIncrementMs >= 60000
            ? `${Math.round(this.timeIncrementMs / 60000)} minutes`
            : `${Math.round(this.timeIncrementMs / 1000)} seconds`;
        console.log(`[TabSentry] Added ${incrementDisplay} to ${tabs.length} tabs`);

        // Now check which tabs should be closed
        await this.evaluateTabsForClosure();
    }

    async evaluateTabsForClosure() {
        // Get settings
        const autoCloseTimeLimit = await this.db.getSetting('autoCloseTimeLimit') || 24; // hours
        const protectPinnedTabs = await this.db.getSetting('protectPinnedTabs') ?? true;
        const keepOpenThreshold = await this.db.getSetting('keepOpenThreshold') || 5;
        const thresholdScope = await this.db.getSetting('thresholdScope') || 'browser-wide';

        const timeLimitMs = autoCloseTimeLimit * 60 * 60 * 1000; // Convert hours to ms

        // Get fresh tab data after time update
        const allTabs = await this.db.getNonOrphanTabs();

        if (thresholdScope === 'browser-wide') {
            await this.closeTabsBrowserWide(allTabs, timeLimitMs, protectPinnedTabs, keepOpenThreshold);
        } else {
            await this.closeTabsPerWindow(allTabs, timeLimitMs, protectPinnedTabs, keepOpenThreshold);
        }
    }

    async closeTabsBrowserWide(allTabs, timeLimitMs, protectPinnedTabs, keepOpenThreshold) {
        // Filter tabs that are candidates for closing
        const closeCandidates = allTabs.filter(tab => {
            // Skip pinned tabs if protected
            if (protectPinnedTabs && tab.pinned) {
                return false;
            }
            // Check if tab exceeds time limit
            return (tab.timeAccumulated || 0) >= timeLimitMs;
        });

        // Sort by timeAccumulated descending (oldest first)
        closeCandidates.sort((a, b) => (b.timeAccumulated || 0) - (a.timeAccumulated || 0));

        // Calculate how many tabs we can close while respecting threshold
        const tabsToKeep = keepOpenThreshold;
        const currentTabCount = allTabs.length;
        const maxToClose = Math.max(0, currentTabCount - tabsToKeep);
        const tabsToClose = closeCandidates.slice(0, maxToClose);

        // Close the tabs
        for (const tab of tabsToClose) {
            await this.closeTab(tab);
        }

        if (tabsToClose.length > 0) {
            console.log(`[TabSentry] Auto-closed ${tabsToClose.length} tabs (browser-wide)`);
        }
    }

    async closeTabsPerWindow(allTabs, timeLimitMs, protectPinnedTabs, keepOpenThreshold) {
        // Group tabs by window
        const tabsByWindow = new Map();
        for (const tab of allTabs) {
            if (!tabsByWindow.has(tab.windowId)) {
                tabsByWindow.set(tab.windowId, []);
            }
            tabsByWindow.get(tab.windowId).push(tab);
        }

        let totalClosed = 0;

        // Process each window separately
        for (const [windowId, windowTabs] of tabsByWindow) {
            // Filter candidates for this window
            const closeCandidates = windowTabs.filter(tab => {
                if (protectPinnedTabs && tab.pinned) {
                    return false;
                }
                return (tab.timeAccumulated || 0) >= timeLimitMs;
            });

            // Sort by timeAccumulated descending
            closeCandidates.sort((a, b) => (b.timeAccumulated || 0) - (a.timeAccumulated || 0));

            // Calculate how many we can close for this window
            const currentWindowTabCount = windowTabs.length;
            const maxToClose = Math.max(0, currentWindowTabCount - keepOpenThreshold);
            const tabsToClose = closeCandidates.slice(0, maxToClose);

            // Close the tabs
            for (const tab of tabsToClose) {
                await this.closeTab(tab);
            }

            totalClosed += tabsToClose.length;
        }

        if (totalClosed > 0) {
            console.log(`[TabSentry] Auto-closed ${totalClosed} tabs (per-window)`);
        }
    }

    async closeTab(tab) {
        try {
            // Close the actual Chrome tab
            await chrome.tabs.remove(tab.id);
            console.log(`[TabSentry] Auto-closed tab: ${tab.title} (accumulated: ${Math.round(tab.timeAccumulated / 60000)} mins)`);
        } catch (e) {
            // Tab may already be closed
            console.log(`[TabSentry] Could not close tab ${tab.id}: ${e.message}`);
        }
    }
}
