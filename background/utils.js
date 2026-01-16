// Filter out chrome:// favicon URLs which can't be loaded
export function getSafeFaviconUrl(url) {
    if (!url || url.startsWith("chrome://")) {
        return "";
    }
    return url;
}

// Debounced badge update
let badgeUpdateTimeout = null;
const BADGE_DEBOUNCE_MS = 500;

// Update badge with current tab count (debounced)
export function updateBadge() {
    // Clear any pending update
    if (badgeUpdateTimeout) {
        clearTimeout(badgeUpdateTimeout);
    }

    // Schedule new update
    badgeUpdateTimeout = setTimeout(async () => {
        badgeUpdateTimeout = null;
        const tabs = await chrome.tabs.query({});
        chrome.action.setBadgeText({ text: String(tabs.length) });
        chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });
    }, BADGE_DEBOUNCE_MS);
}

// Force immediate badge update (use after recovery)
export async function updateBadgeImmediate() {
    // Clear any pending debounced update
    if (badgeUpdateTimeout) {
        clearTimeout(badgeUpdateTimeout);
        badgeUpdateTimeout = null;
    }

    const tabs = await chrome.tabs.query({});
    chrome.action.setBadgeText({ text: String(tabs.length) });
    chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });
}
