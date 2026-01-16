const WINDOW_REMOVAL_DELAY_MINUTES = 1;

export function registerWindowListeners(db, timeTracker, getSessionId) {
    chrome.windows.onCreated.addListener(async (window) => {
        // Cancel any pending removal alarm for this window ID (in case of reuse)
        await chrome.alarms.clear(`remove-window-${window.id}`);

        const sessionId = await getSessionId();
        await db.addWindow({
            id: window.id,
            sessionId,
            isOrphan: 0,
            title: "",
            urlSignature: "",
            createdAt: Date.now(),
            lastAccessed: Date.now()
        });
    });

    chrome.windows.onRemoved.addListener(async (windowId) => {
        // Schedule removal after delay - if browser quits, alarm won't fire
        console.log("[TabSentry] Window closed:", windowId, `(scheduling removal in ${WINDOW_REMOVAL_DELAY_MINUTES} min)`);
        await chrome.alarms.create(`remove-window-${windowId}`, {
            delayInMinutes: WINDOW_REMOVAL_DELAY_MINUTES
        });

        // If the closed window was the anchor window, clear the active ID
        // (but keep the anchor config preserved for next recovery)
        const activeAnchorWindowId = await db.getSetting('activeAnchorWindowId');
        // Use == for type coercion (DB might store as string or number)
        if (activeAnchorWindowId && activeAnchorWindowId == windowId) {
            console.log("[TabSentry] Anchor window closed, clearing active ID");
            await db.setSetting('activeAnchorWindowId', null);
        }
    });

    // Handle alarm for delayed window removal
    chrome.alarms.onAlarm.addListener(async (alarm) => {
        if (alarm.name.startsWith('remove-window-')) {
            const windowId = parseInt(alarm.name.replace('remove-window-', ''), 10);
            console.log("[TabSentry] Removing window after delay:", windowId);
            await db.removeWindow(windowId);
            // Also remove tabs associated with this window
            const tabs = await db.getTabsByWindowId(windowId);
            for (const tab of tabs) {
                await db.removeTab(tab.id);
            }
        }
    });

    chrome.windows.onFocusChanged.addListener(async (windowId) => {
        // Notify time tracker
        if (timeTracker) {
            await timeTracker.onWindowFocusChanged(windowId);
        }

        if (windowId !== chrome.windows.WINDOW_ID_NONE) {
            await db.updateWindow(windowId, { lastAccessed: Date.now() });
        }
    });
}
