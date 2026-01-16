import DB from "./db.js";
import { registerTabListeners } from "./tabs.js";
import { registerWindowListeners } from "./windows.js";
import { registerTabGroupListeners } from "./tab-groups.js";
import { registerRuntimeListeners } from "./runtime.js";
import { TimeTracker } from "./time-tracker.js";
import { SessionManager } from "./session-manager.js";
import { AutoCloser } from "./auto-closer.js";

const db = new DB();
const timeTracker = new TimeTracker(db);
const sessionManager = new SessionManager(db);
const autoCloser = new AutoCloser(db);

// Helper to get current session ID
const getSessionId = () => sessionManager.getSessionId();

// Register runtime listeners immediately (for message handling)
registerRuntimeListeners(db, sessionManager);

// Initialize session manager FIRST, then register tab/window listeners
// This ensures restart detection sees old data before new windows are added
(async () => {
    console.log("[TabSentry] Starting initialization...");

    // Detect restart and perform recovery BEFORE registering listeners
    await sessionManager.initialize();

    console.log("[TabSentry] Initialization complete, registering listeners...");

    // Now register listeners - any new windows/tabs will be added to current session
    registerTabListeners(db, timeTracker, getSessionId, sessionManager);
    registerWindowListeners(db, timeTracker, getSessionId);
    registerTabGroupListeners(db, getSessionId);

    // Initialize time tracker
    await timeTracker.initialize();

    // Initialize auto-closer
    await autoCloser.initialize();

    console.log("[TabSentry] Listeners registered, ready.");
})();
