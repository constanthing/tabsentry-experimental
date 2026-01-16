export class RecoveryUI {
    constructor() {
        this.banner = document.getElementById('recovery-banner');
        this.matchedContainer = document.getElementById('matched-windows');
        this.unmatchedContainer = document.getElementById('unmatched-windows');
        this.dismissBtn = document.getElementById('dismiss-recovery');

        this.dismissBtn?.addEventListener('click', () => this.dismiss());
    }

    async dismiss() {
        try {
            await chrome.runtime.sendMessage({ type: 'DISMISS_RECOVERY' });
        } catch (e) {
            // Ignore
        }
        this.hide();
    }

    show(recoveryResult) {
        if (!recoveryResult) return;

        const hasMatched = recoveryResult.matched && recoveryResult.matched.length > 0;
        const hasUnmatched = recoveryResult.unmatchedOrphans && recoveryResult.unmatchedOrphans.length > 0;

        if (!hasMatched && !hasUnmatched) return;

        this.renderMatched(recoveryResult.matched || []);
        this.renderUnmatched(recoveryResult.unmatchedOrphans || []);
        this.banner.classList.remove('hidden');
    }

    hide() {
        this.banner.classList.add('hidden');
    }

    renderMatched(matched) {
        if (matched.length === 0) {
            this.matchedContainer.innerHTML = '';
            return;
        }

        const html = `
            <div class="matched-summary">
                <svg class="check-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M4 8L7 11L12 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <span>TabSentry automatically matched ${matched.length} window(s):</span>
            </div>
            <ul class="matched-list">
                ${matched.map((m, idx) => `
                    <li class="matched-item">
                        <div class="matched-item-header">
                            <button class="tabs-toggle collapsed" data-target="matched-tabs-${idx}" aria-expanded="false">
                                <svg class="toggle-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none">
                                    <path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <span class="matched-title">${this.escapeHtml(m.title || 'Untitled Window')}</span>
                            <span class="matched-confidence">${Math.round(m.confidence * 100)}% match</span>
                            <span class="matched-tabs">${m.tabCount} tabs</span>
                        </div>
                        <ul class="tabs-list collapsed" id="matched-tabs-${idx}">
                            ${(m.tabs || []).map(tab => `
                                <li class="tab-preview-item">
                                    <img class="tab-favicon" src="${this.escapeHtml(tab.faviconUrl) || 'icons/default-favicon.png'}" alt="">
                                    <span class="tab-preview-title" title="${this.escapeHtml(tab.url)}">${this.escapeHtml(tab.title || tab.url || 'New Tab')}</span>
                                </li>
                            `).join('')}
                        </ul>
                    </li>
                `).join('')}
            </ul>
        `;
        this.matchedContainer.innerHTML = html;
        this.bindFaviconErrorHandlers(this.matchedContainer);
        this.bindTabsToggle(this.matchedContainer);
    }

    bindFaviconErrorHandlers(container) {
        const favicons = container.querySelectorAll('.tab-favicon');
        favicons.forEach(img => {
            img.addEventListener('error', () => { img.src = 'icons/default-favicon.png'; }, { once: true });
        });
    }

    bindTabsToggle(container) {
        const toggleButtons = container.querySelectorAll('.tabs-toggle');
        toggleButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const targetId = btn.dataset.target;
                const tabsList = document.getElementById(targetId);
                const isCollapsed = btn.classList.contains('collapsed');

                if (isCollapsed) {
                    btn.classList.remove('collapsed');
                    btn.setAttribute('aria-expanded', 'true');
                    tabsList.classList.remove('collapsed');
                } else {
                    btn.classList.add('collapsed');
                    btn.setAttribute('aria-expanded', 'false');
                    tabsList.classList.add('collapsed');
                }
            });
        });
    }

    renderUnmatched(unmatched) {
        if (unmatched.length === 0) {
            this.unmatchedContainer.innerHTML = '';
            this.unmatchedContainer.classList.add('hidden');
            return;
        }

        this.unmatchedContainer.classList.remove('hidden');

        const html = `
            <div class="unmatched-header">
                <span>What do you want to do with these windows?</span>
                <button class="btn-recover-all" id="recover-all-btn">Recover All</button>
            </div>
            <div class="unmatched-list">
                ${unmatched.map((w, idx) => `
                    <div class="unmatched-window" data-window-id="${w.windowId}">
                        <div class="unmatched-window-main">
                            <div class="unmatched-info">
                                <button class="tabs-toggle collapsed" data-target="unmatched-tabs-${idx}" aria-expanded="false">
                                    <svg class="toggle-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none">
                                        <path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                </button>
                                <span class="unmatched-title">${this.escapeHtml(w.title || 'Untitled Window')}</span>
                                <span class="unmatched-meta">${w.tabCount} tabs</span>
                            </div>
                            <div class="unmatched-actions">
                                <button class="btn-restore" data-action="restore">Restore</button>
                                <button class="btn-discard" data-action="discard">Discard</button>
                                <button class="btn-keep" data-action="keep">Keep for Later</button>
                            </div>
                        </div>
                        <ul class="tabs-list collapsed" id="unmatched-tabs-${idx}">
                            ${(w.tabs || []).map(tab => `
                                <li class="tab-preview-item">
                                    <img class="tab-favicon" src="${this.escapeHtml(tab.faviconUrl) || 'icons/default-favicon.png'}" alt="">
                                    <span class="tab-preview-title" title="${this.escapeHtml(tab.url)}">${this.escapeHtml(tab.title || tab.url || 'New Tab')}</span>
                                </li>
                            `).join('')}
                        </ul>
                    </div>
                `).join('')}
            </div>
        `;
        this.unmatchedContainer.innerHTML = html;
        this.bindFaviconErrorHandlers(this.unmatchedContainer);
        this.bindUnmatchedActions();
        this.bindTabsToggle(this.unmatchedContainer);
    }

    bindUnmatchedActions() {
        const buttons = this.unmatchedContainer.querySelectorAll('button[data-action]');
        buttons.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const action = btn.dataset.action;
                const windowEl = btn.closest('.unmatched-window');
                const windowId = parseInt(windowEl.dataset.windowId, 10);

                switch (action) {
                    case 'restore':
                        await this.restoreWindow(windowId, windowEl);
                        break;
                    case 'discard':
                        await this.discardWindow(windowId, windowEl);
                        break;
                    case 'keep':
                        await this.keepForLater(windowId, windowEl);
                        break;
                }
            });
        });

        const recoverAllBtn = document.getElementById('recover-all-btn');
        recoverAllBtn?.addEventListener('click', () => this.restoreAllWindows());
    }

    async restoreAllWindows() {
        const windowElements = this.unmatchedContainer.querySelectorAll('.unmatched-window');
        const recoverAllBtn = document.getElementById('recover-all-btn');

        if (windowElements.length === 0) return;

        recoverAllBtn.disabled = true;
        recoverAllBtn.textContent = 'Recovering...';

        for (const element of windowElements) {
            const windowId = parseInt(element.dataset.windowId, 10);
            await this.restoreWindow(windowId, element);
        }

        recoverAllBtn.disabled = false;
        recoverAllBtn.textContent = 'Recover All';
    }

    async restoreWindow(windowId, element) {
        try {
            const result = await chrome.runtime.sendMessage({
                type: 'RESTORE_UNMATCHED_WINDOW',
                windowId
            });

            if (result.success) {
                element.remove();
                this.checkEmpty();
            } else {
                alert('Failed to restore window: ' + (result.error || 'Unknown error'));
            }
        } catch (error) {
            alert('Failed to restore window: ' + error.message);
        }
    }

    async discardWindow(windowId, element) {
        try {
            const result = await chrome.runtime.sendMessage({
                type: 'DISCARD_UNMATCHED_WINDOW',
                windowId
            });

            if (result.success) {
                element.remove();
                this.checkEmpty();
            }
        } catch (error) {
            console.error('Failed to discard window:', error);
        }
    }

    async keepForLater(windowId, element) {
        try {
            const result = await chrome.runtime.sendMessage({
                type: 'KEEP_UNMATCHED_FOR_LATER',
                windowId
            });

            if (result.success) {
                element.remove();
                this.checkEmpty();
            }
        } catch (error) {
            console.error('Failed to keep window for later:', error);
        }
    }

    checkEmpty() {
        const remaining = this.unmatchedContainer.querySelectorAll('.unmatched-window');
        if (remaining.length === 0) {
            this.unmatchedContainer.classList.add('hidden');
            // If no unmatched windows left, check if we should hide the whole banner
            // Keep showing if there were matched windows (informational)
            // User can dismiss manually
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

export async function checkForRecovery() {
    try {
        console.log("[TabSentry Popup] Checking for recovery...");
        const response = await chrome.runtime.sendMessage({ type: 'GET_RECOVERY_RESULT' });
        console.log("[TabSentry Popup] Recovery response:", response);
        if (response.success && response.result) {
            console.log("[TabSentry Popup] Showing recovery banner");
            const ui = new RecoveryUI();
            ui.show(response.result);
        } else {
            console.log("[TabSentry Popup] No recovery result to show");
        }
    } catch (error) {
        console.error('[TabSentry Popup] Failed to check for recovery:', error);
    }
}
