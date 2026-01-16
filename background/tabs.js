import { getSafeFaviconUrl, updateBadge } from "./utils.js";
import { URLMatcher } from "./url-matcher.js";
import { FilterEngine } from "./filter-engine.js";

const urlMatcher = new URLMatcher();
const TAB_REMOVAL_DELAY_MINUTES = 1;
const TAB_STABILIZE_DELAY_MINUTES = 5 / 60; // 5 seconds

async function updateWindowSignature(db, windowId) {
    try {
        const window = await db.getWindow(windowId);
        if (!window || window.isOrphan === 1) return;

        const tabs = await db.getTabsByWindowId(windowId);
        const nonOrphanTabs = tabs.filter(t => t.isOrphan !== 1);
        const signature = urlMatcher.generateWindowSignature(nonOrphanTabs);
        await db.updateWindow(windowId, { urlSignature: signature.signature });
    } catch (e) {
        // Window may no longer exist
    }
}

async function syncAnchorWindowIfNeeded(db, windowId) {
    try {
        const activeAnchorWindowId = await db.getSetting('activeAnchorWindowId');
        // Use == for type coercion (DB might store as string or number)
        if (!activeAnchorWindowId || activeAnchorWindowId != windowId) return;

        // This is the anchor window, sync the config
        const tabs = await chrome.tabs.query({ windowId });
        let tabGroups = [];
        try {
            tabGroups = await chrome.tabGroups.query({ windowId });
        } catch (e) {
            // Tab groups API not available
        }

        const windowData = await db.getWindow(windowId);
        const windowTitle = windowData?.title || "";

        // Get timeAccumulated for each tab from DB
        const tabsWithTime = await Promise.all(tabs.map(async (tab) => {
            const dbTab = await db.getTab(tab.id);
            return {
                url: tab.url || tab.pendingUrl || "",
                title: tab.title || "",
                faviconUrl: tab.favIconUrl || "",
                index: tab.index,
                pinned: tab.pinned || false,
                groupId: tab.groupId || -1,
                timeAccumulated: dbTab?.timeAccumulated || 0
            };
        }));

        await db.updateAnchorWindow({
            windowTitle,
            tabs: tabsWithTime,
            tabGroups: tabGroups.map(g => ({
                id: g.id,
                title: g.title || "",
                color: g.color,
                collapsed: g.collapsed
            }))
        });

        console.log("[TabSentry] Synced anchor window config");
    } catch (e) {
        console.error("[TabSentry] Failed to sync anchor window:", e);
    }
}

export function registerTabListeners(db, timeTracker, getSessionId, sessionManager) {
    const filterEngine = new FilterEngine(db);

    chrome.tabs.onCreated.addListener(async (tab) => {
        // Cancel any pending removal alarm for this tab ID (in case of reuse)
        await chrome.alarms.clear(`remove-tab-${tab.id}`);

        const sessionId = await getSessionId();
        await db.addTab({
            id: tab.id,
            windowId: tab.windowId,
            sessionId,
            isOrphan: 0,
            title: tab.title || "",
            url: tab.url || tab.pendingUrl || "",
            faviconUrl: getSafeFaviconUrl(tab.favIconUrl),
            lastAccessed: Date.now(),
            timeAccumulated: 0,
            index: tab.index,
            groupId: tab.groupId || -1,
            pinned: tab.pinned || false
        });
        updateBadge();
        await updateWindowSignature(db, tab.windowId);
        await syncAnchorWindowIfNeeded(db, tab.windowId);
    });

    chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
        // Clear any pending stabilization alarm for this tab
        await chrome.alarms.clear(`stabilize-tab-${tabId}`);

        // Notify time tracker to flush accumulated time
        if (timeTracker) {
            await timeTracker.onTabRemoved(tabId);
        }

        // Schedule removal after delay - if browser quits, alarm won't fire
        // Skip scheduling if whole window is closing (window alarm handles it)
        if (!removeInfo.isWindowClosing) {
            await chrome.alarms.create(`remove-tab-${tabId}`, {
                delayInMinutes: TAB_REMOVAL_DELAY_MINUTES
            });
            await updateWindowSignature(db, removeInfo.windowId);
            await syncAnchorWindowIfNeeded(db, removeInfo.windowId);
        }

        updateBadge();
    });

    // Handle alarm for delayed tab removal and smart organizer stabilization
    chrome.alarms.onAlarm.addListener(async (alarm) => {
        if (alarm.name.startsWith('remove-tab-')) {
            const tabId = parseInt(alarm.name.replace('remove-tab-', ''), 10);
            console.log("[TabSentry] Removing tab after delay:", tabId);
            await db.removeTab(tabId);
        } else if (alarm.name.startsWith('stabilize-tab-')) {
            const tabId = parseInt(alarm.name.replace('stabilize-tab-', ''), 10);

            // Get current tab info from Chrome
            let tab;
            try {
                tab = await chrome.tabs.get(tabId);
            } catch (e) {
                // Tab no longer exists
                return;
            }

            const smartOrganizerEnabled = await db.getSetting('smartOrganizerEnabled');
            if (smartOrganizerEnabled) {
                const { action, filter } = await filterEngine.processTabUpdate(tab);

                if (action === 'delete') {
                    console.log('[TabSentry] Auto-closing tab matching filter:', filter.name);
                    await filterEngine.executeDelete(tabId);
                } else if (action === 'move') {
                    console.log('[TabSentry] Auto-moving tab to window:', filter.name);
                    await filterEngine.executeMove(tabId, filter);
                }
            }
        }
    });

    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
        const updates = {};
        if (changeInfo.title !== undefined) updates.title = changeInfo.title;
        if (changeInfo.url !== undefined) updates.url = changeInfo.url;
        if (changeInfo.favIconUrl !== undefined) updates.faviconUrl = getSafeFaviconUrl(changeInfo.favIconUrl);
        if (changeInfo.pinned !== undefined) updates.pinned = changeInfo.pinned;

        // Reset staleness on URL change (navigation indicates activity)
        // Skip if this is a restored tab loading its URL for the first time
        if (changeInfo.url !== undefined) {
            if (sessionManager && sessionManager.isTabRestoring(tabId)) {
                console.log("[TabSentry] Skipping timeAccumulated reset for restored tab:", tabId);
            } else {
                updates.timeAccumulated = 0;
            }
        }

        if (Object.keys(updates).length > 0) {
            await db.updateTab(tabId, updates);
            // Update window signature if URL changed
            if (changeInfo.url !== undefined) {
                await updateWindowSignature(db, tab.windowId);
            }
        }

        // Sync anchor window if URL or pinned status changed
        if (changeInfo.url !== undefined || changeInfo.pinned !== undefined) {
            await syncAnchorWindowIfNeeded(db, tab.windowId);
        }

        // Smart Window Organizer: schedule check after title/URL stabilizes (5 seconds with no changes)
        // Skip for restored tabs - they're just loading their original URL, not new navigation
        if (changeInfo.url !== undefined || changeInfo.title !== undefined) {
            if (sessionManager && sessionManager.isTabRestoring(tabId)) {
                console.log("[TabSentry] Skipping Smart Organizer for restored tab:", tabId);
            } else {
                // Clear any existing stabilization alarm for this tab
                await chrome.alarms.clear(`stabilize-tab-${tabId}`);
                // Schedule new alarm - will fire after 5 seconds of stability
                await chrome.alarms.create(`stabilize-tab-${tabId}`, {
                    delayInMinutes: TAB_STABILIZE_DELAY_MINUTES
                });
            }
        }
    });

    chrome.tabs.onActivated.addListener(async (activeInfo) => {
        // Notify time tracker
        if (timeTracker) {
            await timeTracker.onTabActivated(activeInfo.tabId, activeInfo.windowId);
        }
        // Reset staleness on activation (user viewed the tab)
        // Skip if this is a restored tab to preserve original lastAccessed and timeAccumulated
        if (sessionManager && sessionManager.isTabRestoring(activeInfo.tabId)) {
            console.log("[TabSentry] Skipping staleness reset for restored tab:", activeInfo.tabId);
        } else {
            await db.updateTab(activeInfo.tabId, { lastAccessed: Date.now(), timeAccumulated: 0 });
        }
    });

    chrome.tabs.onMoved.addListener(async (tabId, moveInfo) => {
        await db.updateTab(tabId, {
            index: moveInfo.toIndex,
            windowId: moveInfo.windowId
        });
    });

    chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
        // Get old windowId before updating
        const tab = await db.getTab(tabId);
        const oldWindowId = tab?.windowId;

        await db.updateTab(tabId, {
            windowId: attachInfo.newWindowId,
            index: attachInfo.newPosition
        });

        // Update signatures for both old and new windows
        if (oldWindowId && oldWindowId !== attachInfo.newWindowId) {
            await updateWindowSignature(db, oldWindowId);
            await syncAnchorWindowIfNeeded(db, oldWindowId);
        }
        await updateWindowSignature(db, attachInfo.newWindowId);
        await syncAnchorWindowIfNeeded(db, attachInfo.newWindowId);
    });

    // Wire up time flush callback to sync anchor window
    if (timeTracker) {
        timeTracker.setOnTimeFlush(async (windowId) => {
            await syncAnchorWindowIfNeeded(db, windowId);
        });
    }
}
