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

        // Tab Nicknames message handlers
        if (message.type === "GET_TAB_NICKNAME") {
            (async () => {
                try {
                    const result = await db.getTabNickname(message.tabId);
                    sendResponse({ success: true, nickname: result?.nickname || null });
                } catch (error) {
                    console.error("[TabSentry] GET_TAB_NICKNAME error:", error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            return true;
        }

        if (message.type === "SET_TAB_NICKNAME") {
            (async () => {
                try {
                    await db.setTabNickname(message.tabId, message.nickname, message.url);
                    sendResponse({ success: true });
                } catch (error) {
                    console.error("[TabSentry] SET_TAB_NICKNAME error:", error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            return true;
        }

        if (message.type === "REMOVE_TAB_NICKNAME") {
            (async () => {
                try {
                    await db.removeTabNickname(message.tabId);
                    sendResponse({ success: true });
                } catch (error) {
                    console.error("[TabSentry] REMOVE_TAB_NICKNAME error:", error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            return true;
        }

        // URL-based Nicknames message handlers
        if (message.type === "GET_NICKNAME") {
            (async () => {
                try {
                    const result = await db.getNickname(message.url);
                    sendResponse({ success: true, nickname: result?.nickname || null });
                } catch (error) {
                    console.error("[TabSentry] GET_NICKNAME error:", error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            return true;
        }

        if (message.type === "SET_NICKNAME") {
            (async () => {
                try {
                    await db.setNickname(message.url, message.nickname);
                    sendResponse({ success: true });
                } catch (error) {
                    console.error("[TabSentry] SET_NICKNAME error:", error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            return true;
        }

        if (message.type === "REMOVE_NICKNAME") {
            (async () => {
                try {
                    await db.removeNickname(message.url);
                    sendResponse({ success: true });
                } catch (error) {
                    console.error("[TabSentry] REMOVE_NICKNAME error:", error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            return true;
        }

        if (message.type === "GET_ALL_NICKNAMES") {
            (async () => {
                try {
                    const nicknames = await db.getAllNicknames();
                    sendResponse({ success: true, nicknames });
                } catch (error) {
                    console.error("[TabSentry] GET_ALL_NICKNAMES error:", error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            return true;
        }

        // Saved Windows message handlers
        if (message.type === "SAVE_WINDOW") {
            console.log("[TabSentry] SAVE_WINDOW handler triggered for window:", message.windowId);
            (async () => {
                try {
                    const windowId = message.windowId;

                    // Get current window tabs
                    const tabs = await chrome.tabs.query({ windowId });
                    console.log("[TabSentry] Got tabs:", tabs.length);

                    // Get tab groups (may not be available in all browsers)
                    let tabGroups = [];
                    try {
                        if (chrome.tabGroups) {
                            tabGroups = await chrome.tabGroups.query({ windowId });
                        }
                    } catch (e) {
                        console.log("[TabSentry] Tab groups not available:", e);
                    }

                    // Get window title from DB
                    const windowData = await db.getWindow(windowId);
                    const windowTitle = windowData?.title || `Window ${windowId}`;

                    // Build tabs snapshot
                    const tabsSnapshot = tabs.map(tab => ({
                        url: tab.url || tab.pendingUrl || "",
                        title: tab.title || "",
                        favIconUrl: tab.favIconUrl || "",
                        index: tab.index,
                        pinned: tab.pinned || false,
                        groupId: tab.groupId || -1
                    }));

                    // Build tab groups snapshot
                    const tabGroupsSnapshot = tabGroups.map(g => ({
                        id: g.id,
                        title: g.title || "",
                        color: g.color,
                        collapsed: g.collapsed
                    }));

                    // Save to database
                    const id = await db.addSavedWindow({
                        name: windowTitle,
                        tabs: tabsSnapshot,
                        tabGroups: tabGroupsSnapshot
                    });

                    sendResponse({ success: true, id });
                } catch (error) {
                    console.error("[TabSentry] SAVE_WINDOW error:", error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            return true;
        }

        if (message.type === "GET_SAVED_WINDOWS") {
            console.log("[TabSentry] GET_SAVED_WINDOWS handler triggered");
            (async () => {
                try {
                    const savedWindows = await db.getAllSavedWindows();
                    console.log("[TabSentry] Found saved windows:", savedWindows.length, savedWindows);
                    sendResponse({ success: true, savedWindows });
                } catch (error) {
                    console.error("[TabSentry] GET_SAVED_WINDOWS error:", error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            return true;
        }

        if (message.type === "DELETE_SAVED_WINDOW") {
            (async () => {
                try {
                    await db.deleteSavedWindow(message.savedWindowId);
                    sendResponse({ success: true });
                } catch (error) {
                    console.error("[TabSentry] DELETE_SAVED_WINDOW error:", error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            return true;
        }

        if (message.type === "RESTORE_SAVED_WINDOW") {
            (async () => {
                try {
                    const savedWindow = await db.getSavedWindow(message.savedWindowId);
                    if (!savedWindow) {
                        sendResponse({ success: false, error: "Saved window not found" });
                        return;
                    }

                    // Create new window with the first tab
                    const firstTab = savedWindow.tabs[0];
                    const newWindow = await chrome.windows.create({
                        url: firstTab?.url || "chrome://newtab",
                        focused: true
                    });

                    // Create remaining tabs
                    const tabIdMap = new Map(); // Maps old groupId to array of new tab ids
                    for (let i = 1; i < savedWindow.tabs.length; i++) {
                        const tabData = savedWindow.tabs[i];
                        const newTab = await chrome.tabs.create({
                            windowId: newWindow.id,
                            url: tabData.url,
                            pinned: tabData.pinned,
                            index: tabData.index
                        });

                        // Track tabs by their original groupId for group recreation
                        if (tabData.groupId && tabData.groupId !== -1) {
                            if (!tabIdMap.has(tabData.groupId)) {
                                tabIdMap.set(tabData.groupId, []);
                            }
                            tabIdMap.get(tabData.groupId).push(newTab.id);
                        }
                    }

                    // Handle first tab's group membership
                    if (firstTab?.groupId && firstTab.groupId !== -1) {
                        const firstTabId = (await chrome.tabs.query({ windowId: newWindow.id }))[0].id;
                        if (!tabIdMap.has(firstTab.groupId)) {
                            tabIdMap.set(firstTab.groupId, []);
                        }
                        tabIdMap.get(firstTab.groupId).unshift(firstTabId);
                    }

                    // Recreate tab groups
                    for (const savedGroup of savedWindow.tabGroups) {
                        const tabIds = tabIdMap.get(savedGroup.id);
                        if (tabIds && tabIds.length > 0) {
                            const groupId = await chrome.tabs.group({
                                tabIds,
                                createProperties: { windowId: newWindow.id }
                            });
                            await chrome.tabGroups.update(groupId, {
                                title: savedGroup.title,
                                color: savedGroup.color,
                                collapsed: savedGroup.collapsed
                            });
                        }
                    }

                    sendResponse({ success: true, windowId: newWindow.id });
                } catch (error) {
                    console.error("[TabSentry] RESTORE_SAVED_WINDOW error:", error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            return true;
        }

        if (message.type === "UPDATE_SAVED_WINDOW") {
            (async () => {
                try {
                    await db.updateSavedWindow(message.savedWindowId, { name: message.name });
                    sendResponse({ success: true });
                } catch (error) {
                    console.error("[TabSentry] UPDATE_SAVED_WINDOW error:", error);
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
