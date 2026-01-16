const GROUP_REMOVAL_DELAY_MINUTES = 1;

export function registerTabGroupListeners(db, getSessionId) {
    chrome.tabGroups.onCreated.addListener(async (group) => {
        // Cancel any pending removal alarm for this group ID
        await chrome.alarms.clear(`remove-group-${group.id}`);

        const sessionId = await getSessionId();
        await db.addTabGroup({
            id: group.id,
            windowId: group.windowId,
            sessionId,
            isOrphan: 0,
            title: group.title || "",
            color: group.color,
            collapsed: group.collapsed
        });
        console.log("[TabSentry] Tab group created:", group.id, group.title);
    });

    chrome.tabGroups.onUpdated.addListener(async (group) => {
        await db.updateTabGroup(group.id, {
            title: group.title || "",
            color: group.color,
            collapsed: group.collapsed
        });
        console.log("[TabSentry] Tab group updated:", group.id, group.title);
    });

    chrome.tabGroups.onRemoved.addListener(async (group) => {
        // Schedule removal after delay - if browser quits, alarm won't fire
        console.log("[TabSentry] Tab group removed:", group.id, `(scheduling removal in ${GROUP_REMOVAL_DELAY_MINUTES} min)`);
        await chrome.alarms.create(`remove-group-${group.id}`, {
            delayInMinutes: GROUP_REMOVAL_DELAY_MINUTES
        });
    });

    // Handle alarm for delayed group removal
    chrome.alarms.onAlarm.addListener(async (alarm) => {
        if (alarm.name.startsWith('remove-group-')) {
            const groupId = parseInt(alarm.name.replace('remove-group-', ''), 10);
            console.log("[TabSentry] Removing tab group after delay:", groupId);
            await db.removeTabGroup(groupId);
        }
    });
}
