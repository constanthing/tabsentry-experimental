export class TimeTracker {
    constructor(db) {
        this.db = db;
        this.activeTabId = null;
        this.activeWindowId = null;
        this.lastActiveTime = null;
        this.isWindowFocused = true;
        this.onTimeFlush = null;
        this.isInitialized = false;
    }

    setOnTimeFlush(callback) {
        this.onTimeFlush = callback;
    }

    async initialize() {
        // Get currently active tab
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab) {
            this.activeTabId = activeTab.id;
            this.activeWindowId = activeTab.windowId;
            this.lastActiveTime = Date.now();
        }

        // Check if any window is focused
        const focusedWindow = await chrome.windows.getLastFocused();
        this.isWindowFocused = focusedWindow.focused;

        this.isInitialized = true;
    }

    async onTabActivated(tabId, windowId) {
        // Flush time for previous tab before switching
        await this.flushTime();

        // Start tracking new tab
        this.activeTabId = tabId;
        this.activeWindowId = windowId;
        this.lastActiveTime = Date.now();
    }

    async onWindowFocusChanged(windowId) {
        if (windowId === chrome.windows.WINDOW_ID_NONE) {
            // Browser lost focus - pause tracking
            await this.flushTime();
            this.isWindowFocused = false;
        } else {
            // Browser gained focus
            this.isWindowFocused = true;
            this.activeWindowId = windowId;

            // Get active tab in the newly focused window
            const [activeTab] = await chrome.tabs.query({ active: true, windowId });
            if (activeTab) {
                this.activeTabId = activeTab.id;
                this.lastActiveTime = Date.now();
            }
        }
    }

    async flushTime() {
        if (!this.activeTabId || !this.lastActiveTime || !this.isWindowFocused) {
            return;
        }

        const now = Date.now();
        const elapsed = now - this.lastActiveTime;

        // Only update if meaningful time elapsed (at least 1 second)
        if (elapsed >= 1000) {
            try {
                const tab = await this.db.getTab(this.activeTabId);
                if (tab && !tab.isOrphan) {
                    const newAccumulated = (tab.timeAccumulated || 0) + elapsed;
                    await this.db.updateTab(this.activeTabId, {
                        timeAccumulated: newAccumulated
                    });

                    // Notify listener that time was flushed for this window
                    if (this.onTimeFlush) {
                        await this.onTimeFlush(this.activeWindowId);
                    }
                }
            } catch (e) {
                // Tab may no longer exist, ignore error
            }
        }

        this.lastActiveTime = now;
    }

    async onTabRemoved(tabId) {
        // Flush time if the removed tab was active
        if (tabId === this.activeTabId) {
            await this.flushTime();
            this.activeTabId = null;
            this.lastActiveTime = null;
        }
    }
}
