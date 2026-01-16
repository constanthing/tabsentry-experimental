import Dexie from "./dexie.mjs";

export default class DB {
    constructor() {
        this.db = new Dexie("tabsentry-db");
        this.db.version(1).stores({
            openTabs: "id, title, url, faviconUrl, lastAccessed, timeAccumulated, index, groupId, windowId",
            openWindows: "id, title, createdAt, lastAccessed",
            settings: "++id, title, value"
        });
        this.db.version(2).stores({
            openTabs: "id, windowId, sessionId, isOrphan, title, url, faviconUrl, lastAccessed, timeAccumulated, index, groupId",
            openWindows: "id, sessionId, isOrphan, title, urlSignature, createdAt, lastAccessed",
            sessions: "++id, startedAt, active",
            settings: "++id, title, value"
        }).upgrade(async tx => {
            // Migrate existing records to have isOrphan = 0
            await tx.table("openTabs").toCollection().modify(tab => {
                if (tab.isOrphan === undefined) {
                    tab.isOrphan = 0;
                    tab.sessionId = 0;
                }
            });
            await tx.table("openWindows").toCollection().modify(win => {
                if (win.isOrphan === undefined) {
                    win.isOrphan = 0;
                    win.sessionId = 0;
                    win.urlSignature = "";
                }
            });
        });

        this.db.version(3).stores({
            openTabs: "id, windowId, sessionId, isOrphan, title, url, faviconUrl, lastAccessed, timeAccumulated, index, groupId",
            openWindows: "id, sessionId, isOrphan, title, urlSignature, createdAt, lastAccessed",
            tabGroups: "id, windowId, sessionId, isOrphan, title, color, collapsed",
            sessions: "++id, startedAt, active",
            settings: "++id, title, value"
        });

        this.db.version(4).stores({
            openTabs: "id, windowId, sessionId, isOrphan, title, url, faviconUrl, lastAccessed, timeAccumulated, index, groupId, pinned",
            openWindows: "id, sessionId, isOrphan, title, urlSignature, createdAt, lastAccessed",
            tabGroups: "id, windowId, sessionId, isOrphan, title, color, collapsed",
            sessions: "++id, startedAt, active",
            settings: "++id, title, value"
        }).upgrade(async tx => {
            // Migrate existing tabs to have pinned = false
            await tx.table("openTabs").toCollection().modify(tab => {
                if (tab.pinned === undefined) {
                    tab.pinned = false;
                }
            });
        });

        this.db.version(5).stores({
            openTabs: "id, windowId, sessionId, isOrphan, title, url, faviconUrl, lastAccessed, timeAccumulated, index, groupId, pinned",
            openWindows: "id, sessionId, isOrphan, title, urlSignature, createdAt, lastAccessed",
            tabGroups: "id, windowId, sessionId, isOrphan, title, color, collapsed",
            sessions: "++id, startedAt, active",
            settings: "++id, title, value",
            filters: "++id, name, property, operator, value, smartWindowAction, createdAt, updatedAt"
        });

        this.db.version(6).stores({
            openTabs: "id, windowId, sessionId, isOrphan, title, url, faviconUrl, lastAccessed, timeAccumulated, index, groupId, pinned",
            openWindows: "id, sessionId, isOrphan, title, urlSignature, createdAt, lastAccessed",
            tabGroups: "id, windowId, sessionId, isOrphan, title, color, collapsed",
            sessions: "++id, startedAt, active",
            settings: "++id, title, value",
            filters: "++id, name, property, operator, value, smartWindowAction, createdAt, updatedAt",
            automovedTabs: "++id, tabId, url, title, favicon, targetWindow, movedAt"
        });

        this.db.version(7).stores({
            openTabs: "id, windowId, sessionId, isOrphan, title, url, faviconUrl, lastAccessed, timeAccumulated, index, groupId, pinned",
            openWindows: "id, sessionId, isOrphan, title, urlSignature, createdAt, lastAccessed",
            tabGroups: "id, windowId, sessionId, isOrphan, title, color, collapsed",
            sessions: "++id, startedAt, active",
            settings: "++id, title, value",
            filters: "++id, name, property, operator, value, smartWindowAction, createdAt, updatedAt",
            automovedTabs: "++id, tabId, url, title, favicon, targetWindow, movedAt",
            anchorWindow: "++id, windowTitle, tabs, tabGroups, createdAt, updatedAt"
        });

        this.db.open();
        return this;
    }


    async getAllTabs() {
        return await this.db.openTabs.toArray();
    }
    async getTab(id) {
        return await this.db.openTabs.get(id);
    }
    async addTab(data) {
        return await this.db.openTabs.put(data);
    }
    async removeTab(id) {
        return await this.db.openTabs.delete(id);
    }
    async updateTab(id, data) {
        return await this.db.openTabs.update(id, data);
    }

    async getAllWindows() {
        return await this.db.openWindows.toArray();
    }
    async getWindow(id) {
        return await this.db.openWindows.get(id);
    }
    async addWindow(data) {
        return await this.db.openWindows.put(data);
    }
    async removeWindow(id) {
        return await this.db.openWindows.delete(id);
    }
    async updateWindow(id, data) {
        return await this.db.openWindows.update(id, data);
    }

    async getSetting(title) {
        const setting = await this.db.settings.where("title").equals(title).first();
        return setting ? setting.value : null;
    }
    async addSetting(title, value) {
        // do not allow duplicate titles
        const existing = await this.db.settings.where("title").equals(title).first();
        if (existing) {
            return existing.id;
        }
        return await this.db.settings.add({ title, value });
    }
    async setSetting(title, value) {
        const existing = await this.db.settings.where("title").equals(title).first();
        if (existing) {
            await this.db.settings.update(existing.id, { value });
            return existing.id;
        }
        return await this.db.settings.add({ title, value });
    }
    async removeSetting(id) {
        return await this.db.settings.delete(id);
    }
    async updateSetting(id, value) {
        return await this.db.settings.update(id, { value });
    }

    // Session methods
    async createSession() {
        // Deactivate any existing active session
        const activeSession = await this.db.sessions.where("active").equals(1).first();
        if (activeSession) {
            await this.db.sessions.update(activeSession.id, { active: 0 });
        }
        return await this.db.sessions.add({
            startedAt: Date.now(),
            active: 1
        });
    }

    async getActiveSession() {
        return await this.db.sessions.where("active").equals(1).first();
    }

    async getLatestSession() {
        return await this.db.sessions.orderBy("id").last();
    }

    async updateSession(id, data) {
        return await this.db.sessions.update(id, data);
    }

    // Orphan management methods
    async getOrphanTabs() {
        const all = await this.db.openTabs.toArray();
        return all.filter(t => t.isOrphan === 1);
    }

    async getOrphanWindows() {
        const all = await this.db.openWindows.toArray();
        return all.filter(w => w.isOrphan === 1);
    }

    async getOrphanTabsByWindowId(windowId) {
        return await this.db.openTabs
            .where("windowId").equals(windowId)
            .and(tab => tab.isOrphan === 1)
            .toArray();
    }

    async markAllCurrentAsOrphans() {
        await this.db.openTabs.toCollection().modify(tab => {
            if (tab.isOrphan !== 1) {
                tab.isOrphan = 1;
            }
        });
        await this.db.openWindows.toCollection().modify(win => {
            if (win.isOrphan !== 1) {
                win.isOrphan = 1;
            }
        });
        // Also mark tab groups
        if (this.db.tabGroups) {
            await this.db.tabGroups.toCollection().modify(group => {
                if (group.isOrphan !== 1) {
                    group.isOrphan = 1;
                }
            });
        }
    }

    async deleteOrphanWindow(windowId) {
        await this.db.openTabs.where("windowId").equals(windowId).delete();
        await this.db.openWindows.delete(windowId);
    }

    async deleteOrphansBySessionId(sessionId) {
        await this.db.openTabs.where("sessionId").equals(sessionId).delete();
        await this.db.openWindows.where("sessionId").equals(sessionId).delete();
    }

    async getTabsByWindowId(windowId) {
        return await this.db.openTabs.where("windowId").equals(windowId).toArray();
    }

    async getNonOrphanTabs() {
        const all = await this.db.openTabs.toArray();
        return all.filter(t => t.isOrphan !== 1);
    }

    async getNonOrphanWindows() {
        const all = await this.db.openWindows.toArray();
        return all.filter(w => w.isOrphan !== 1);
    }

    // Tab Group methods
    async getAllTabGroups() {
        return await this.db.tabGroups.toArray();
    }

    async getTabGroup(id) {
        return await this.db.tabGroups.get(id);
    }

    async addTabGroup(data) {
        return await this.db.tabGroups.put(data);
    }

    async removeTabGroup(id) {
        return await this.db.tabGroups.delete(id);
    }

    async updateTabGroup(id, data) {
        return await this.db.tabGroups.update(id, data);
    }

    async getTabGroupsByWindowId(windowId) {
        return await this.db.tabGroups.where("windowId").equals(windowId).toArray();
    }

    async getOrphanTabGroups() {
        const all = await this.db.tabGroups.toArray();
        return all.filter(g => g.isOrphan === 1);
    }

    async getNonOrphanTabGroups() {
        const all = await this.db.tabGroups.toArray();
        return all.filter(g => g.isOrphan !== 1);
    }

    async getOrphanTabGroupsByWindowId(windowId) {
        const groups = await this.db.tabGroups.where("windowId").equals(windowId).toArray();
        return groups.filter(g => g.isOrphan === 1);
    }

    // Filter methods
    async getAllFilters() {
        return await this.db.filters.toArray();
    }

    async getFilter(id) {
        return await this.db.filters.get(id);
    }

    async addFilter(data) {
        return await this.db.filters.add({
            ...data,
            createdAt: Date.now(),
            updatedAt: Date.now()
        });
    }

    async updateFilter(id, data) {
        return await this.db.filters.update(id, {
            ...data,
            updatedAt: Date.now()
        });
    }

    async removeFilter(id) {
        return await this.db.filters.delete(id);
    }

    // Automoved tabs methods
    async addAutomovedTab(data) {
        return await this.db.automovedTabs.add({
            ...data,
            movedAt: Date.now()
        });
    }

    async getAutomovedTabs() {
        return await this.db.automovedTabs.toArray();
    }

    async getAutomovedTabsSince(timestamp) {
        return await this.db.automovedTabs.where("movedAt").aboveOrEqual(timestamp).toArray();
    }

    async clearAutomovedTabs() {
        return await this.db.automovedTabs.clear();
    }

    // Anchor Window methods
    async getAnchorWindow() {
        // Returns the single anchor window config (or null if none)
        return await this.db.anchorWindow.toCollection().first();
    }

    async setAnchorWindow(data) {
        // Clear any existing anchor config first, then save new one
        await this.db.anchorWindow.clear();
        return await this.db.anchorWindow.add({
            ...data,
            createdAt: Date.now(),
            updatedAt: Date.now()
        });
    }

    async updateAnchorWindow(data) {
        const existing = await this.getAnchorWindow();
        if (existing) {
            return await this.db.anchorWindow.update(existing.id, {
                ...data,
                updatedAt: Date.now()
            });
        }
        return null;
    }

    async clearAnchorWindow() {
        return await this.db.anchorWindow.clear();
    }
}