import { updateBadge } from "./utils.js";

export function registerRuntimeListeners(db, sessionManager) {
    // Handle messages from popup
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === "GET_RECOVERY_RESULT") {
            console.log("[TabSentry] GET_RECOVERY_RESULT message received");
            sessionManager.getRecoveryResult().then(result => {
                console.log("[TabSentry] Sending recovery result:", result);
                sendResponse({ success: true, result });
            });
            return true; // Keep channel open for async response
        }

        if (message.type === "RESTORE_UNMATCHED_WINDOW") {
            sessionManager.restoreUnmatchedWindow(message.windowId).then(result => {
                sendResponse(result);
            });
            return true;
        }

        if (message.type === "DISCARD_UNMATCHED_WINDOW") {
            sessionManager.discardUnmatchedWindow(message.windowId).then(result => {
                sendResponse(result);
            });
            return true;
        }

        if (message.type === "KEEP_UNMATCHED_FOR_LATER") {
            sessionManager.keepUnmatchedForLater(message.windowId).then(result => {
                sendResponse(result);
            });
            return true;
        }

        if (message.type === "DISMISS_RECOVERY") {
            sessionManager.dismissRecovery().then(() => {
                sendResponse({ success: true });
            });
            return true;
        }

        if (message.type === "UPDATE_WINDOW_TITLE") {
            (async () => {
                await db.updateWindow(message.windowId, { title: message.title });

                // If this is the anchor window, update anchor config
                const activeAnchorWindowId = await db.getSetting('activeAnchorWindowId');
                if (activeAnchorWindowId === message.windowId) {
                    const anchorConfig = await db.getAnchorWindow();
                    if (anchorConfig) {
                        await db.updateAnchorWindow({ windowTitle: message.title });
                    }
                }

                sendResponse({ success: true });
            })();
            return true;
        }

        if (message.type === "GET_WINDOW_TITLE") {
            db.getWindow(message.windowId).then(window => {
                sendResponse({ success: true, title: window?.title || "" });
            });
            return true;
        }

        if (message.type === "GET_WINDOW_DATA") {
            db.getWindow(message.windowId).then(window => {
                console.log('[TabSentry] GET_WINDOW_DATA for window', message.windowId, ':', window);
                sendResponse({
                    title: window?.title || null,
                    lastAccessed: window?.lastAccessed || null,
                    createdAt: window?.createdAt || null
                });
            });
            return true;
        }

        // Filter CRUD message handlers
        if (message.type === "GET_ALL_FILTERS") {
            db.getAllFilters().then(filters => {
                sendResponse({ success: true, filters });
            });
            return true;
        }

        if (message.type === "GET_FILTER") {
            db.getFilter(message.filterId).then(filter => {
                sendResponse({ success: true, filter });
            });
            return true;
        }

        if (message.type === "ADD_FILTER") {
            db.addFilter(message.filterData).then(id => {
                sendResponse({ success: true, id });
            });
            return true;
        }

        if (message.type === "UPDATE_FILTER") {
            db.updateFilter(message.filterId, message.filterData).then(() => {
                sendResponse({ success: true });
            });
            return true;
        }

        if (message.type === "DELETE_FILTER") {
            db.removeFilter(message.filterId).then(() => {
                sendResponse({ success: true });
            });
            return true;
        }

        // Anchor Window message handlers
        if (message.type === "SET_ANCHOR_WINDOW") {
            (async () => {
                try {
                    const windowId = message.windowId;

                    // Get current window tabs
                    const tabs = await chrome.tabs.query({ windowId });
                    const tabGroups = await chrome.tabGroups.query({ windowId });

                    // Get window title from DB
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

                    // Save anchor config
                    await db.setAnchorWindow({
                        windowTitle,
                        tabs: tabsWithTime,
                        tabGroups: tabGroups.map(g => ({
                            id: g.id,
                            title: g.title || "",
                            color: g.color,
                            collapsed: g.collapsed
                        }))
                    });

                    // Store active anchor window ID
                    await db.setSetting('activeAnchorWindowId', windowId);

                    sendResponse({ success: true });
                } catch (error) {
                    console.error("[TabSentry] SET_ANCHOR_WINDOW error:", error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            return true;
        }

        if (message.type === "CLEAR_ANCHOR_WINDOW") {
            (async () => {
                try {
                    await db.clearAnchorWindow();
                    await db.setSetting('activeAnchorWindowId', null);
                    sendResponse({ success: true });
                } catch (error) {
                    console.error("[TabSentry] CLEAR_ANCHOR_WINDOW error:", error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            return true;
        }

        if (message.type === "GET_ANCHOR_WINDOW") {
            (async () => {
                try {
                    const anchorConfig = await db.getAnchorWindow();
                    const activeWindowId = await db.getSetting('activeAnchorWindowId');
                    sendResponse({
                        success: true,
                        anchorConfig,
                        activeAnchorWindowId: activeWindowId
                    });
                } catch (error) {
                    console.error("[TabSentry] GET_ANCHOR_WINDOW error:", error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            return true;
        }

        if (message.type === "UPDATE_ANCHOR_TABS") {
            (async () => {
                try {
                    const windowId = message.windowId;

                    // Get current window tabs
                    const tabs = await chrome.tabs.query({ windowId });
                    const tabGroups = await chrome.tabGroups.query({ windowId });

                    // Get window title from DB
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

                    // Update anchor config
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

                    sendResponse({ success: true });
                } catch (error) {
                    console.error("[TabSentry] UPDATE_ANCHOR_TABS error:", error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            return true;
        }
    });

    // Sync on install/update (for extension updates)
    chrome.runtime.onInstalled.addListener(async (details) => {
        if (details.reason === "install") {
            // Fresh install - session manager handles initial setup
            updateBadge();
        } else if (details.reason === "update") {
            // Extension updated - badge update
            updateBadge();
        }
    });
}
