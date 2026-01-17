import { URLMatcher } from "./url-matcher.js";
import { updateBadgeImmediate } from "./utils.js";

export class SessionManager {
    constructor(db) {
        this.db = db;
        this.urlMatcher = new URLMatcher();
        this.currentSessionId = null;
        this.restoringTabIds = new Map();
        this.isInitialized = false;
    }

    markTabAsRestoring(tabId) {
        // Store timestamp - tab is considered "restoring" for 10 seconds
        this.restoringTabIds.set(tabId, Date.now());
    }

    isTabRestoring(tabId) {
        const timestamp = this.restoringTabIds.get(tabId);
        if (!timestamp) return false;

        // Consider restoring for 10 seconds after marking
        const elapsed = Date.now() - timestamp;
        if (elapsed > 10000) {
            this.restoringTabIds.delete(tabId);
            return false;
        }
        return true;
    }

    async initialize() {
        const detection = await this.detectBrowserRestart();
        console.log("[TabSentry] Browser restart detection:", detection);

        // No normal windows open (e.g., profile picker only) - defer initialization
        if (detection.reason === 'no_normal_windows') {
            console.log("[TabSentry] Deferring initialization until normal window opens");
            return;
        }

        if (detection.isRestart) {
            console.log("[TabSentry] Browser restart detected, performing recovery...");
            try {
                const recoveryResult = await this.performRecovery(detection);
                console.log("[TabSentry] Recovery result:", recoveryResult);
                // Persist recovery result to DB
                const jsonResult = JSON.stringify(recoveryResult);
                console.log("[TabSentry] Saving recovery result, length:", jsonResult.length);
                await this.db.setSetting('recoveryResult', jsonResult);
                // Verify it was saved
                const verify = await this.db.getSetting('recoveryResult');
                console.log("[TabSentry] Recovery result saved to DB, verified:", verify ? "yes" : "no");
                // Update badge after recovery
                await updateBadgeImmediate();
            } catch (error) {
                console.error("[TabSentry] Recovery failed:", error);
            }
        } else {
            console.log("[TabSentry] No browser restart detected, syncing state...");
            // Ensure we have an active session
            let session = await this.db.getActiveSession();
            if (!session) {
                this.currentSessionId = await this.db.createSession();
            } else {
                this.currentSessionId = session.id;
            }

            console.log("[TabSentry] Current session ID:", this.currentSessionId);
            // Sync current browser state to DB (handles fresh install and service worker restart)
            await this.syncCurrentBrowserState();
            console.log("[TabSentry] State sync complete");
            // Update badge after sync
            await updateBadgeImmediate();
        }

        // Always check anchor window - regardless of restart detection
        // This handles cases where restart wasn't detected but anchor should still be restored
        await this.restoreAnchorWindowIfNeeded();

        // Mark as initialized
        this.isInitialized = true;
    }

    async syncCurrentBrowserState() {
        // Get current browser state
        const [browserWindows, browserTabs, browserGroups] = await Promise.all([
            chrome.windows.getAll(),
            chrome.tabs.query({}),
            chrome.tabGroups.query({})
        ]);
        console.log("[TabSentry] Sync - browser windows:", browserWindows.length, "tabs:", browserTabs.length, "groups:", browserGroups.length);

        // Get stored state
        const [storedWindows, storedTabs, storedGroups] = await Promise.all([
            this.db.getNonOrphanWindows(),
            this.db.getNonOrphanTabs(),
            this.db.getNonOrphanTabGroups()
        ]);
        console.log("[TabSentry] Sync - stored windows:", storedWindows.length, "tabs:", storedTabs.length, "groups:", storedGroups.length);

        const browserWindowIds = new Set(browserWindows.map(w => w.id));
        const browserTabIds = new Set(browserTabs.map(t => t.id));
        const storedWindowIds = new Set(storedWindows.map(w => w.id));
        const storedTabIds = new Set(storedTabs.map(t => t.id));

        // Add missing windows
        let windowsAdded = 0;
        for (const window of browserWindows) {
            if (!storedWindowIds.has(window.id)) {
                const windowTabs = browserTabs.filter(t => t.windowId === window.id);
                const signature = this.urlMatcher.generateWindowSignature(windowTabs);

                try {
                    await this.db.addWindow({
                        id: window.id,
                        sessionId: this.currentSessionId,
                        isOrphan: 0,
                        title: "",
                        urlSignature: signature.signature,
                        createdAt: Date.now(),
                        lastAccessed: Date.now()
                    });
                    windowsAdded++;
                } catch (e) {
                    console.error("[TabSentry] Failed to add window:", window.id, e);
                }
            }
        }
        console.log("[TabSentry] Sync - windows added:", windowsAdded);

        // Add missing tabs
        let tabsAdded = 0;
        for (const tab of browserTabs) {
            if (!storedTabIds.has(tab.id)) {
                try {
                    await this.db.addTab({
                        id: tab.id,
                        windowId: tab.windowId,
                        sessionId: this.currentSessionId,
                        isOrphan: 0,
                        title: tab.title || "",
                        url: tab.url || tab.pendingUrl || "",
                        faviconUrl: this.getSafeFaviconUrl(tab.favIconUrl),
                        lastAccessed: Date.now(),
                        timeAccumulated: 0,
                        index: tab.index,
                        groupId: tab.groupId || -1,
                        pinned: tab.pinned || false
                    });
                    tabsAdded++;
                } catch (e) {
                    console.error("[TabSentry] Failed to add tab:", tab.id, e);
                }
            }
        }
        console.log("[TabSentry] Sync - tabs added:", tabsAdded);

        // Add missing tab groups
        const browserGroupIds = new Set(browserGroups.map(g => g.id));
        const storedGroupIds = new Set(storedGroups.map(g => g.id));
        let groupsAdded = 0;

        for (const group of browserGroups) {
            if (!storedGroupIds.has(group.id)) {
                try {
                    await this.db.addTabGroup({
                        id: group.id,
                        windowId: group.windowId,
                        sessionId: this.currentSessionId,
                        isOrphan: 0,
                        title: group.title || "",
                        color: group.color,
                        collapsed: group.collapsed
                    });
                    groupsAdded++;
                } catch (e) {
                    console.error("[TabSentry] Failed to add tab group:", group.id, e);
                }
            }
        }
        console.log("[TabSentry] Sync - groups added:", groupsAdded);

        // Remove tabs that no longer exist in browser
        for (const storedTab of storedTabs) {
            if (!browserTabIds.has(storedTab.id)) {
                await this.db.removeTab(storedTab.id);
            }
        }

        // Remove windows that no longer exist in browser
        for (const storedWindow of storedWindows) {
            if (!browserWindowIds.has(storedWindow.id)) {
                await this.db.removeWindow(storedWindow.id);
            }
        }

        // Remove tab groups that no longer exist in browser
        for (const storedGroup of storedGroups) {
            if (!browserGroupIds.has(storedGroup.id)) {
                await this.db.removeTabGroup(storedGroup.id);
            }
        }
    }

    async getSessionId() {
        if (this.currentSessionId) {
            return this.currentSessionId;
        }
        const session = await this.db.getActiveSession();
        if (session) {
            this.currentSessionId = session.id;
            return this.currentSessionId;
        }
        this.currentSessionId = await this.db.createSession();
        return this.currentSessionId;
    }

    async waitForBrowserWindow(retries = 50, delay = 100) {
        // Wait for at least one normal browser window to exist
        // (filters out profile picker, devtools, popup windows, etc.)
        for (let i = 0; i < retries; i++) {
            const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
            if (windows.length > 0) {
                console.log("[TabSentry] Waited for normal browser windows:", i * delay, "ms, found:", windows.length);
                return windows;
            }
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        console.log("[TabSentry] No normal browser windows found after", retries * delay, "ms");
        return []; // Return empty if no normal windows found
    }

    async detectBrowserRestart() {
        // Get stored windows (non-orphan)
        const storedWindows = await this.db.getNonOrphanWindows();
        console.log("[TabSentry] Stored windows:", storedWindows.length, storedWindows.map(w => w.id));

        // If no stored windows, this is first run or clean state
        if (storedWindows.length === 0) {
            console.log("[TabSentry] No stored windows, skipping restart detection");
            return { isRestart: false };
        }

        // Wait for and get current browser windows (normal windows only)
        const browserWindows = await this.waitForBrowserWindow();

        // No normal windows open - skip recovery (e.g., profile picker only)
        if (browserWindows.length === 0) {
            console.log("[TabSentry] No normal windows detected, skipping recovery");
            return { isRestart: false, reason: 'no_normal_windows' };
        }

        const browserWindowIds = new Set(browserWindows.map(w => w.id));
        console.log("[TabSentry] Browser windows:", browserWindows.length, [...browserWindowIds]);

        // Check if any of our stored window IDs still exist in browser
        const storedIds = storedWindows.map(w => w.id);
        const matchingIds = storedIds.filter(id => browserWindowIds.has(id));
        console.log("[TabSentry] Matching IDs:", matchingIds);

        // If none of our stored IDs exist, browser has restarted
        if (matchingIds.length === 0) {
            console.log("[TabSentry] No matching IDs - browser restart detected!");
            return {
                isRestart: true,
                storedWindows,
                storedTabs: await this.db.getNonOrphanTabs()
            };
        }

        console.log("[TabSentry] IDs match - no restart");
        return { isRestart: false };
    }

    async performRecovery(detection) {
        const { storedWindows, storedTabs } = detection;

        // Mark all stored records as orphans
        await this.db.markAllCurrentAsOrphans();

        // Create new session
        this.currentSessionId = await this.db.createSession();

        // Wait for browser to be ready with windows
        const browserWindows = await this.waitForBrowserWindow();
        if (browserWindows.length === 0) {
            console.error("[TabSentry] No browser windows available for recovery");
            return { matched: [], unmatchedOrphans: [] };
        }

        // Get current browser state
        const [browserTabs, browserGroups] = await Promise.all([
            chrome.tabs.query({}),
            chrome.tabGroups.query({})
        ]);
        console.log("[TabSentry] Recovery - browser state: windows:", browserWindows.length, "tabs:", browserTabs.length, "groups:", browserGroups.length);

        // Add current browser state to DB
        for (const window of browserWindows) {
            const windowTabs = browserTabs.filter(t => t.windowId === window.id);
            const signature = this.urlMatcher.generateWindowSignature(windowTabs);

            await this.db.addWindow({
                id: window.id,
                sessionId: this.currentSessionId,
                isOrphan: 0,
                title: "",
                urlSignature: signature.signature,
                createdAt: Date.now(),
                lastAccessed: Date.now()
            });
        }

        for (const tab of browserTabs) {
            await this.db.addTab({
                id: tab.id,
                windowId: tab.windowId,
                sessionId: this.currentSessionId,
                isOrphan: 0,
                title: tab.title || "",
                url: tab.url || tab.pendingUrl || "",
                faviconUrl: this.getSafeFaviconUrl(tab.favIconUrl),
                lastAccessed: Date.now(),
                timeAccumulated: 0,
                index: tab.index,
                groupId: tab.groupId || -1,
                pinned: tab.pinned || false
            });
        }

        // Add current browser tab groups to DB
        for (const group of browserGroups) {
            await this.db.addTabGroup({
                id: group.id,
                windowId: group.windowId,
                sessionId: this.currentSessionId,
                isOrphan: 0,
                title: group.title || "",
                color: group.color,
                collapsed: group.collapsed
            });
        }

        // Get orphan windows and tabs (previously stored)
        const orphanWindows = await this.db.getOrphanWindows();
        const orphanTabs = await this.db.getOrphanTabs();

        // Get current windows and tabs from DB
        const currentWindows = await this.db.getNonOrphanWindows();
        const currentTabs = await this.db.getNonOrphanTabs();

        // Run matching algorithm
        const matchResult = this.urlMatcher.findBestMatches(
            orphanWindows,
            currentWindows,
            orphanTabs,
            currentTabs
        );

        // Transfer data from matched orphans to current windows
        for (const match of matchResult.matched) {
            // Transfer window title
            if (match.orphanWindow.title) {
                await this.db.updateWindow(match.currentWindow.id, {
                    title: match.orphanWindow.title
                });
            }

            // Transfer tab accumulated time by URL matching
            await this.transferTabTimeData(match.orphanTabs, match.currentTabs);

            // Restore pinned status for matched tabs
            await this.restoreTabPinnedStatus(match.orphanTabs, match.currentTabs);

            // Restore tab group titles
            await this.restoreTabGroupTitles(match.orphanWindow.id, match.currentWindow.id, match.orphanTabs, match.currentTabs);

            // Delete the matched orphan window and its tabs
            await this.db.deleteOrphanWindow(match.orphanWindow.id);

            // Also delete orphan tab groups for this window
            const orphanGroups = await this.db.getOrphanTabGroupsByWindowId(match.orphanWindow.id);
            for (const group of orphanGroups) {
                await this.db.removeTabGroup(group.id);
            }
        }

        // Keep unmatched orphans in DB for potential later recovery
        // (they remain with isOrphan = 1)

        return {
            matched: matchResult.matched.map(m => ({
                title: m.orphanWindow.title || "Untitled Window",
                confidence: m.confidence,
                tabCount: m.orphanTabs.length,
                tabs: m.orphanTabs.map(t => ({
                    title: t.title || "",
                    url: t.url || "",
                    faviconUrl: t.faviconUrl || ""
                }))
            })),
            unmatchedOrphans: matchResult.unmatchedOrphans.map(w => {
                const windowTabs = orphanTabs.filter(t => t.windowId === w.id);
                return {
                    windowId: w.id,
                    title: w.title || "Untitled Window",
                    tabCount: windowTabs.length,
                    tabs: windowTabs.map(t => ({
                        title: t.title || "",
                        url: t.url || "",
                        faviconUrl: t.faviconUrl || ""
                    }))
                };
            })
        };
    }

    async transferTabTimeData(orphanTabs, currentTabs) {
        // Match tabs by URL and transfer timeAccumulated
        for (const currentTab of currentTabs) {
            const matchingOrphan = orphanTabs.find(ot => ot.url === currentTab.url);
            if (matchingOrphan && matchingOrphan.timeAccumulated > 0) {
                await this.db.updateTab(currentTab.id, {
                    timeAccumulated: matchingOrphan.timeAccumulated
                });
            }
        }
    }

    async restoreTabPinnedStatus(orphanTabs, currentTabs) {
        // Match tabs by URL and restore pinned status from orphan tabs
        for (const currentTab of currentTabs) {
            const matchingOrphan = orphanTabs.find(ot => ot.url === currentTab.url);
            if (matchingOrphan && matchingOrphan.pinned) {
                try {
                    await chrome.tabs.update(currentTab.id, { pinned: true });
                    await this.db.updateTab(currentTab.id, { pinned: true });
                    console.log("[TabSentry] Restored pinned status for tab:", currentTab.id, currentTab.url?.substring(0, 50));
                } catch (e) {
                    console.error("[TabSentry] Failed to restore pinned status for tab:", currentTab.id, e);
                }
            }
        }
    }

    async restoreTabGroupTitles(orphanWindowId, currentWindowId, orphanTabs, currentTabs) {
        // Get orphan tab groups for this window
        const orphanGroups = await this.db.getOrphanTabGroupsByWindowId(orphanWindowId);
        if (orphanGroups.length === 0) return;

        // Get current tab groups for this window
        const currentGroups = await chrome.tabGroups.query({ windowId: currentWindowId });
        if (currentGroups.length === 0) return;

        // Build a map of orphan groupId -> group data
        const orphanGroupMap = new Map(orphanGroups.map(g => [g.id, g]));

        // Build a map of current groupId -> list of tab URLs in that group
        const currentGroupTabs = new Map();
        for (const tab of currentTabs) {
            if (tab.groupId && tab.groupId !== -1) {
                if (!currentGroupTabs.has(tab.groupId)) {
                    currentGroupTabs.set(tab.groupId, []);
                }
                currentGroupTabs.get(tab.groupId).push(tab.url);
            }
        }

        // Build a map of orphan groupId -> list of tab URLs in that group
        const orphanGroupTabs = new Map();
        for (const tab of orphanTabs) {
            if (tab.groupId && tab.groupId !== -1 && orphanGroupMap.has(tab.groupId)) {
                if (!orphanGroupTabs.has(tab.groupId)) {
                    orphanGroupTabs.set(tab.groupId, []);
                }
                orphanGroupTabs.get(tab.groupId).push(tab.url);
            }
        }

        // Match current groups to orphan groups by URL overlap
        // Each orphan group can only match ONE current group (best match)
        const matchedOrphanGroups = new Set();
        const matchedCurrentGroups = new Set();

        // Score all possible matches
        const matches = [];
        for (const [currentGroupId, currentUrls] of currentGroupTabs) {
            for (const [orphanGroupId, orphanUrls] of orphanGroupTabs) {
                const currentUrlSet = new Set(currentUrls);
                const orphanUrlSet = new Set(orphanUrls);

                // Count matching URLs
                let matchCount = 0;
                for (const url of currentUrls) {
                    if (orphanUrlSet.has(url)) matchCount++;
                }

                if (matchCount > 0) {
                    // Score based on proportion of matching URLs in both directions
                    const score = matchCount / Math.max(currentUrls.length, orphanUrls.length);
                    matches.push({
                        currentGroupId,
                        orphanGroupId,
                        score,
                        matchCount
                    });
                }
            }
        }

        // Sort by score descending
        matches.sort((a, b) => b.score - a.score);

        // Greedily assign best matches (each group can only be matched once)
        for (const match of matches) {
            if (matchedCurrentGroups.has(match.currentGroupId)) continue;
            if (matchedOrphanGroups.has(match.orphanGroupId)) continue;

            const orphanGroup = orphanGroupMap.get(match.orphanGroupId);
            if (orphanGroup && orphanGroup.title) {
                try {
                    // Update the current browser tab group with orphan's title
                    await chrome.tabGroups.update(match.currentGroupId, {
                        title: orphanGroup.title,
                        color: orphanGroup.color
                    });
                    console.log("[TabSentry] Restored tab group title:", orphanGroup.title, "with score:", match.score);

                    // Also update in our DB
                    await this.db.updateTabGroup(match.currentGroupId, {
                        title: orphanGroup.title,
                        color: orphanGroup.color
                    });
                } catch (e) {
                    console.error("[TabSentry] Failed to restore tab group:", e);
                }
            }

            matchedCurrentGroups.add(match.currentGroupId);
            matchedOrphanGroups.add(match.orphanGroupId);
        }
    }

    getSafeFaviconUrl(faviconUrl) {
        if (!faviconUrl) return "";
        if (faviconUrl.startsWith("chrome://")) return "";
        return faviconUrl;
    }

    async restoreUnmatchedWindow(orphanWindowId) {
        const orphanWindow = await this.db.getWindow(orphanWindowId);
        const orphanTabs = await this.db.getOrphanTabsByWindowId(orphanWindowId);
        const orphanGroups = await this.db.getOrphanTabGroupsByWindowId(orphanWindowId);

        console.log("[TabSentry] Restoring window:", orphanWindowId, "title:", orphanWindow?.title);
        console.log("[TabSentry] Orphan tabs:", orphanTabs.map(t => ({ id: t.id, groupId: t.groupId, url: t.url?.substring(0, 50) })));
        console.log("[TabSentry] Orphan groups:", orphanGroups);

        if (orphanTabs.length === 0) {
            await this.db.deleteOrphanWindow(orphanWindowId);
            await this.removeUnmatchedFromRecovery(orphanWindowId);
            return { success: false, error: "No tabs to restore" };
        }

        // Filter tabs with valid URLs
        const validTabs = orphanTabs.filter(t => t.url && !t.url.startsWith('chrome://'));

        if (validTabs.length === 0) {
            await this.db.deleteOrphanWindow(orphanWindowId);
            await this.removeUnmatchedFromRecovery(orphanWindowId);
            return { success: false, error: "No valid URLs to restore" };
        }

        try {
            // Create new window with first tab
            const newWindow = await chrome.windows.create({ url: validTabs[0].url });
            const createdTabs = [{ orphanTab: validTabs[0], newTabId: newWindow.tabs[0].id }];

            // Create remaining tabs
            for (let i = 1; i < validTabs.length; i++) {
                const newTab = await chrome.tabs.create({
                    windowId: newWindow.id,
                    url: validTabs[i].url
                });
                createdTabs.push({ orphanTab: validTabs[i], newTabId: newTab.id });
            }

            // Restore pinned status, timeAccumulated, and lastAccessed for tabs
            for (const { orphanTab, newTabId } of createdTabs) {
                if (orphanTab.pinned) {
                    try {
                        await chrome.tabs.update(newTabId, { pinned: true });
                        console.log("[TabSentry] Restored pinned status for tab:", newTabId);
                    } catch (e) {
                        console.error("[TabSentry] Failed to pin tab:", newTabId, e);
                    }
                }
                // Transfer timeAccumulated and lastAccessed from orphan tab
                try {
                    // Mark tab as restoring so URL updates and activation don't reset values
                    this.markTabAsRestoring(newTabId);
                    const updates = {};
                    if (orphanTab.timeAccumulated > 0) {
                        updates.timeAccumulated = orphanTab.timeAccumulated;
                    }
                    if (orphanTab.lastAccessed) {
                        updates.lastAccessed = orphanTab.lastAccessed;
                    }
                    if (Object.keys(updates).length > 0) {
                        await this.db.updateTab(newTabId, updates);
                        console.log("[TabSentry] Restored tab data for:", newTabId, updates);
                    }
                } catch (e) {
                    console.error("[TabSentry] Failed to restore tab data for:", newTabId, e);
                }
            }

            // Recreate tab groups if any
            console.log("[TabSentry] Checking for groups to recreate, orphanGroups.length:", orphanGroups.length);
            if (orphanGroups.length > 0) {
                // Build map of orphan groupId -> group data
                const groupMap = new Map(orphanGroups.map(g => [g.id, g]));
                console.log("[TabSentry] Group map:", [...groupMap.entries()]);

                // Group tabs by their original groupId
                const tabsByGroup = new Map();
                for (const { orphanTab, newTabId } of createdTabs) {
                    console.log("[TabSentry] Checking tab:", orphanTab.id, "groupId:", orphanTab.groupId, "in groupMap:", groupMap.has(orphanTab.groupId));
                    if (orphanTab.groupId && orphanTab.groupId !== -1 && groupMap.has(orphanTab.groupId)) {
                        if (!tabsByGroup.has(orphanTab.groupId)) {
                            tabsByGroup.set(orphanTab.groupId, []);
                        }
                        tabsByGroup.get(orphanTab.groupId).push(newTabId);
                    }
                }
                console.log("[TabSentry] Tabs by group:", [...tabsByGroup.entries()]);

                // Create groups in Chrome
                for (const [orphanGroupId, tabIds] of tabsByGroup) {
                    const orphanGroup = groupMap.get(orphanGroupId);
                    try {
                        const newGroupId = await chrome.tabs.group({
                            tabIds: tabIds,
                            createProperties: { windowId: newWindow.id }
                        });
                        // Set group title and color
                        await chrome.tabGroups.update(newGroupId, {
                            title: orphanGroup.title || "",
                            color: orphanGroup.color || "grey",
                            collapsed: orphanGroup.collapsed || false
                        });
                        console.log("[TabSentry] Restored tab group:", orphanGroup.title);
                    } catch (e) {
                        console.error("[TabSentry] Failed to create tab group:", e);
                    }
                }
            }

            // Restore window title if it exists
            if (orphanWindow && orphanWindow.title) {
                await this.db.updateWindow(newWindow.id, { title: orphanWindow.title });
                console.log("[TabSentry] Restored window title:", orphanWindow.title);
            }

            // Delete the orphan records (window and tabs)
            await this.db.deleteOrphanWindow(orphanWindowId);

            // Delete orphan tab groups for this window
            for (const group of orphanGroups) {
                await this.db.removeTabGroup(group.id);
            }

            // Update recovery result
            await this.removeUnmatchedFromRecovery(orphanWindowId);

            return { success: true, windowId: newWindow.id };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async discardUnmatchedWindow(orphanWindowId) {
        // Delete orphan tab groups for this window
        const orphanGroups = await this.db.getOrphanTabGroupsByWindowId(orphanWindowId);
        for (const group of orphanGroups) {
            await this.db.removeTabGroup(group.id);
        }

        await this.db.deleteOrphanWindow(orphanWindowId);
        await this.removeUnmatchedFromRecovery(orphanWindowId);
        return { success: true };
    }

    async keepUnmatchedForLater(orphanWindowId) {
        // Just remove from recovery UI, but keep orphan data in DB
        await this.removeUnmatchedFromRecovery(orphanWindowId);
        return { success: true };
    }

    async getRecoveryResult() {
        const stored = await this.db.getSetting('recoveryResult');
        console.log("[TabSentry] getRecoveryResult - stored value:", stored);
        if (!stored) return null;
        try {
            return JSON.parse(stored);
        } catch (e) {
            console.error("[TabSentry] Failed to parse recovery result:", e);
            return null;
        }
    }

    async dismissRecovery() {
        // Clear the recovery result from DB
        const existing = await this.db.db.settings.where("title").equals('recoveryResult').first();
        if (existing) {
            await this.db.removeSetting(existing.id);
        }
    }

    async updateRecoveryResult(updatedResult) {
        // Check if there are any unmatched orphans left
        if (!updatedResult.unmatchedOrphans || updatedResult.unmatchedOrphans.length === 0) {
            // No more unmatched windows, clear the recovery banner
            await this.dismissRecovery();
        } else {
            // Update with remaining unmatched windows
            await this.db.setSetting('recoveryResult', JSON.stringify(updatedResult));
        }
    }

    async removeUnmatchedFromRecovery(windowId) {
        const result = await this.getRecoveryResult();
        if (!result) return;

        result.unmatchedOrphans = (result.unmatchedOrphans || []).filter(w => w.windowId !== windowId);
        await this.updateRecoveryResult(result);
    }

    async cleanupOldOrphans(maxAgeDays = 30) {
        const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
        const cutoffTime = Date.now() - maxAgeMs;

        const orphanWindows = await this.db.getOrphanWindows();
        for (const window of orphanWindows) {
            if (window.lastAccessed < cutoffTime) {
                await this.db.deleteOrphanWindow(window.id);
            }
        }
    }

    /**
     * ANCHOR WINDOW RECOVERY
     *
     * This runs AFTER performRecovery(). The anchor config is the source of truth
     * for window title and tab timeAccumulated values.
     *
     * Flow:
     * 1. Find anchor window among current browser windows (by URL matching)
     * 2. If not found, create it from anchor config
     * 3. Force-apply anchor config data (title, timeAccumulated) - overwrites any recovery data
     * 4. Remove anchor from recovery banner
     */
    async restoreAnchorWindowIfNeeded() {
        try {
            const anchorConfig = await this.db.getAnchorWindow();
            if (!anchorConfig) {
                console.log("[TabSentry] No anchor window config found");
                return;
            }

            console.log("[TabSentry] === ANCHOR WINDOW RECOVERY ===");
            console.log("[TabSentry] Anchor config:", {
                windowTitle: anchorConfig.windowTitle,
                tabCount: anchorConfig.tabs?.length,
                tabs: anchorConfig.tabs?.map(t => ({ url: t.url, time: t.timeAccumulated }))
            });

            // Find matching window
            const anchorWindowId = await this.findAnchorWindow(anchorConfig);

            if (anchorWindowId) {
                console.log("[TabSentry] Found existing anchor window:", anchorWindowId);
                await this.forceApplyAnchorData(anchorWindowId, anchorConfig);
            } else {
                console.log("[TabSentry] No matching window, creating anchor window...");
                const newWindowId = await this.createAnchorWindow(anchorConfig);
                if (newWindowId) {
                    await this.forceApplyAnchorData(newWindowId, anchorConfig);
                }
            }

            // Remove from recovery banner
            await this.removeAnchorFromRecoveryBanner(anchorConfig);

            console.log("[TabSentry] === ANCHOR RECOVERY COMPLETE ===");

            // Update badge after anchor recovery (may have created new tabs)
            await updateBadgeImmediate();

            // Notify popup to reload with updated data
            try {
                await chrome.runtime.sendMessage({ type: 'ANCHOR_RESTORED' });
            } catch (e) {
                // Popup may not be open, ignore error
            }

        } catch (error) {
            console.error("[TabSentry] Anchor recovery failed:", error);
        }
    }

    async findAnchorWindow(anchorConfig) {
        const browserWindows = await chrome.windows.getAll({ populate: true });
        const savedUrls = new Set((anchorConfig.tabs || []).map(t => t.url).filter(Boolean));

        if (savedUrls.size === 0) return null;

        let bestMatch = null;
        let bestScore = 0;

        for (const win of browserWindows) {
            const winUrls = new Set((win.tabs || []).map(t => t.url || t.pendingUrl).filter(Boolean));

            let matches = 0;
            for (const url of savedUrls) {
                if (winUrls.has(url)) matches++;
            }

            const score = matches / savedUrls.size;
            console.log(`[TabSentry] Window ${win.id}: ${matches}/${savedUrls.size} URLs (${Math.round(score * 100)}%)`);

            if (score >= 0.5 && score > bestScore) {
                bestMatch = win;
                bestScore = score;
            }
        }

        return bestMatch?.id || null;
    }

    async createAnchorWindow(anchorConfig) {
        // Filter out chrome:// URLs (can't be created programmatically)
        const validTabs = (anchorConfig.tabs || []).filter(t =>
            t.url && !t.url.startsWith('chrome://')
        );

        if (validTabs.length === 0) {
            console.log("[TabSentry] No valid tabs to create anchor window");
            return null;
        }

        // Create window with first tab
        const newWindow = await chrome.windows.create({ url: validTabs[0].url });
        this.markTabAsRestoring(newWindow.tabs[0].id);

        // Create remaining tabs
        for (let i = 1; i < validTabs.length; i++) {
            const tab = await chrome.tabs.create({
                windowId: newWindow.id,
                url: validTabs[i].url
            });
            this.markTabAsRestoring(tab.id);
        }

        // Wait for DB to catch up (longer delay for slower machines)
        await new Promise(r => setTimeout(r, 3000));

        // Restore pinned status
        const currentTabs = await chrome.tabs.query({ windowId: newWindow.id });
        for (const tab of currentTabs) {
            const savedTab = validTabs.find(t => t.url === tab.url || t.url === tab.pendingUrl);
            if (savedTab?.pinned) {
                try {
                    await chrome.tabs.update(tab.id, { pinned: true });
                } catch (e) {}
            }
        }

        // Restore tab groups
        await this.restoreTabGroups(newWindow.id, anchorConfig);

        console.log("[TabSentry] Created anchor window:", newWindow.id);
        return newWindow.id;
    }

    async restoreTabGroups(windowId, anchorConfig) {
        const savedGroups = anchorConfig.tabGroups || [];
        if (savedGroups.length === 0) return;

        const currentTabs = await chrome.tabs.query({ windowId });
        const groupMap = new Map(savedGroups.map(g => [g.id, g]));

        // Group current tabs by their original group
        const tabsByGroup = new Map();
        for (const tab of currentTabs) {
            const savedTab = (anchorConfig.tabs || []).find(t =>
                t.url === tab.url || t.url === tab.pendingUrl
            );
            if (savedTab?.groupId && savedTab.groupId !== -1 && groupMap.has(savedTab.groupId)) {
                if (!tabsByGroup.has(savedTab.groupId)) {
                    tabsByGroup.set(savedTab.groupId, []);
                }
                tabsByGroup.get(savedTab.groupId).push(tab.id);
            }
        }

        // Create groups
        for (const [groupId, tabIds] of tabsByGroup) {
            const group = groupMap.get(groupId);
            try {
                const newGroupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
                await chrome.tabGroups.update(newGroupId, {
                    title: group.title || "",
                    color: group.color || "grey",
                    collapsed: group.collapsed || false
                });
            } catch (e) {
                console.error("[TabSentry] Failed to create tab group:", e);
            }
        }
    }

    async forceApplyAnchorData(windowId, anchorConfig) {
        // This FORCES the anchor config data onto the window
        // It will overwrite whatever the regular recovery might have set

        console.log("[TabSentry] Force-applying anchor data to window:", windowId);

        // Wait for DB to be ready (longer delay for slower machines)
        await new Promise(r => setTimeout(r, 2500));

        // === FORCE WINDOW TITLE ===
        if (anchorConfig.windowTitle) {
            console.log("[TabSentry] Setting window title:", anchorConfig.windowTitle);

            // Ensure window exists in DB first
            let windowInDb = await this.db.getWindow(windowId);
            if (!windowInDb) {
                // Create it if it doesn't exist
                const session = await this.db.getActiveSession();
                await this.db.addWindow({
                    id: windowId,
                    sessionId: session?.id,
                    isOrphan: 0,
                    title: anchorConfig.windowTitle,
                    createdAt: Date.now(),
                    lastAccessed: Date.now()
                });
                console.log("[TabSentry] Created window record with title");
            } else {
                await this.db.updateWindow(windowId, { title: anchorConfig.windowTitle });
                console.log("[TabSentry] Updated window title");
            }
        }

        // === FORCE TAB TIME ACCUMULATED ===
        const currentTabs = await chrome.tabs.query({ windowId });
        const savedTabsByUrl = new Map();
        for (const savedTab of (anchorConfig.tabs || [])) {
            if (savedTab.url) {
                savedTabsByUrl.set(savedTab.url, savedTab);
            }
        }

        console.log("[TabSentry] Restoring timeAccumulated for", currentTabs.length, "tabs");

        for (const tab of currentTabs) {
            const tabUrl = tab.url || tab.pendingUrl;
            const savedTab = savedTabsByUrl.get(tabUrl);

            if (savedTab) {
                this.markTabAsRestoring(tab.id);

                // Ensure tab exists in DB
                let tabInDb = await this.db.getTab(tab.id);
                if (!tabInDb) {
                    const session = await this.db.getActiveSession();
                    await this.db.addTab({
                        id: tab.id,
                        windowId: windowId,
                        sessionId: session?.id,
                        isOrphan: 0,
                        title: tab.title || "",
                        url: tabUrl || "",
                        faviconUrl: tab.favIconUrl || "",
                        lastAccessed: Date.now(),
                        timeAccumulated: savedTab.timeAccumulated || 0,
                        index: tab.index,
                        groupId: tab.groupId || -1,
                        pinned: tab.pinned || false
                    });
                    console.log("[TabSentry] Created tab with timeAccumulated:", tab.id, savedTab.timeAccumulated);
                } else if (savedTab.timeAccumulated > 0) {
                    await this.db.updateTab(tab.id, { timeAccumulated: savedTab.timeAccumulated });
                    console.log("[TabSentry] Updated tab timeAccumulated:", tab.id, savedTab.timeAccumulated);
                }
            }
        }

        // Update active anchor window ID
        await this.db.setSetting('activeAnchorWindowId', windowId);

        // Sync anchor config to current state (preserves timeAccumulated we just set)
        await this.syncAnchorConfig(windowId, anchorConfig.windowTitle);
    }

    async syncAnchorConfig(windowId, windowTitle) {
        const currentTabs = await chrome.tabs.query({ windowId });
        let currentGroups = [];
        try {
            currentGroups = await chrome.tabGroups.query({ windowId });
        } catch (e) {}

        const tabsWithTime = await Promise.all(currentTabs.map(async (tab) => {
            const dbTab = await this.db.getTab(tab.id);
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

        await this.db.updateAnchorWindow({
            windowTitle: windowTitle || "",
            tabs: tabsWithTime,
            tabGroups: currentGroups.map(g => ({
                id: g.id,
                title: g.title || "",
                color: g.color,
                collapsed: g.collapsed
            }))
        });
    }

    async removeAnchorFromRecoveryBanner(anchorConfig) {
        const recoveryResult = await this.getRecoveryResult();
        if (!recoveryResult?.unmatchedOrphans?.length) return;

        const savedUrls = new Set((anchorConfig.tabs || []).map(t => t.url).filter(Boolean));
        if (savedUrls.size === 0) return;

        const updatedUnmatched = [];

        for (const orphan of recoveryResult.unmatchedOrphans) {
            const orphanUrls = new Set((orphan.tabs || []).map(t => t.url).filter(Boolean));

            let matches = 0;
            for (const url of savedUrls) {
                if (orphanUrls.has(url)) matches++;
            }

            const score = savedUrls.size > 0 ? matches / savedUrls.size : 0;

            if (score >= 0.5) {
                console.log("[TabSentry] Removing anchor from recovery banner:", orphan.windowId);
                await this.db.deleteOrphanWindow(orphan.windowId);
            } else {
                updatedUnmatched.push(orphan);
            }
        }

        recoveryResult.unmatchedOrphans = updatedUnmatched;
        await this.updateRecoveryResult(recoveryResult);
    }
}
