export class URLMatcher {
    extractDomain(url) {
        try {
            const parsed = new URL(url);
            return parsed.hostname;
        } catch {
            return null;
        }
    }

    extractPath(url) {
        try {
            const parsed = new URL(url);
            return parsed.hostname + parsed.pathname;
        } catch {
            return null;
        }
    }

    isValidUrl(url) {
        if (!url) return false;
        return !url.startsWith('chrome://') &&
               !url.startsWith('chrome-extension://') &&
               !url.startsWith('about:') &&
               !url.startsWith('edge://') &&
               !url.startsWith('brave://');
    }

    generateWindowSignature(tabs) {
        const validTabs = tabs.filter(t => this.isValidUrl(t.url));

        const domains = validTabs
            .map(t => this.extractDomain(t.url))
            .filter(d => d)
            .sort();

        const domainCounts = {};
        domains.forEach(d => {
            domainCounts[d] = (domainCounts[d] || 0) + 1;
        });

        // Create deterministic signature
        const sortedEntries = Object.entries(domainCounts)
            .sort((a, b) => a[0].localeCompare(b[0]));

        const signature = JSON.stringify(sortedEntries);

        return {
            signature: this.hashString(signature),
            topDomains: this.getTopDomains(domainCounts, 5),
            domainCounts,
            tabCount: validTabs.length
        };
    }

    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(36);
    }

    getTopDomains(domainCounts, n) {
        return Object.entries(domainCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([domain]) => domain);
    }

    jaccardSimilarity(set1, set2) {
        const intersection = new Set([...set1].filter(x => set2.has(x)));
        const union = new Set([...set1, ...set2]);

        if (union.size === 0) return 1;
        return intersection.size / union.size;
    }

    calculateMatchScore(prevTabs, currTabs) {
        const prevValidTabs = prevTabs.filter(t => this.isValidUrl(t.url));
        const currValidTabs = currTabs.filter(t => this.isValidUrl(t.url));

        if (prevValidTabs.length === 0 && currValidTabs.length === 0) {
            return 1;
        }
        if (prevValidTabs.length === 0 || currValidTabs.length === 0) {
            return 0;
        }

        // Component 1: Domain Jaccard Similarity (40% weight)
        const prevDomains = new Set(prevValidTabs.map(t => this.extractDomain(t.url)).filter(Boolean));
        const currDomains = new Set(currValidTabs.map(t => this.extractDomain(t.url)).filter(Boolean));
        const domainScore = this.jaccardSimilarity(prevDomains, currDomains);

        // Component 2: URL Path Similarity (30% weight)
        const prevPaths = new Set(prevValidTabs.map(t => this.extractPath(t.url)).filter(Boolean));
        const currPaths = new Set(currValidTabs.map(t => this.extractPath(t.url)).filter(Boolean));
        const pathScore = this.jaccardSimilarity(prevPaths, currPaths);

        // Component 3: Tab Count Similarity (15% weight)
        const countDiff = Math.abs(prevValidTabs.length - currValidTabs.length);
        const maxCount = Math.max(prevValidTabs.length, currValidTabs.length);
        const countScore = maxCount > 0 ? 1 - (countDiff / maxCount) : 1;

        // Component 4: Exact URL Matches (15% weight)
        const prevUrls = new Set(prevValidTabs.map(t => t.url));
        const currUrls = new Set(currValidTabs.map(t => t.url));
        const exactScore = this.jaccardSimilarity(prevUrls, currUrls);

        // Weighted final score
        return (domainScore * 0.4) + (pathScore * 0.3) + (countScore * 0.15) + (exactScore * 0.15);
    }

    groupTabsByWindow(tabs) {
        const grouped = {};
        for (const tab of tabs) {
            const windowId = tab.windowId;
            if (!grouped[windowId]) {
                grouped[windowId] = [];
            }
            grouped[windowId].push(tab);
        }
        return grouped;
    }

    findBestMatches(orphanWindows, currentWindows, orphanTabs, currentTabs) {
        const orphanTabsByWindow = this.groupTabsByWindow(orphanTabs);
        const currentTabsByWindow = this.groupTabsByWindow(currentTabs);

        // Calculate all pairwise scores
        const scores = [];
        for (const orphanWin of orphanWindows) {
            for (const currWin of currentWindows) {
                const score = this.calculateMatchScore(
                    orphanTabsByWindow[orphanWin.id] || [],
                    currentTabsByWindow[currWin.id] || []
                );
                scores.push({
                    orphanWindow: orphanWin,
                    currentWindow: currWin,
                    score
                });
            }
        }

        // Sort by score descending
        scores.sort((a, b) => b.score - a.score);

        // Greedy matching - each window can only be matched once
        const matched = [];
        const usedOrphan = new Set();
        const usedCurrent = new Set();

        const MATCH_THRESHOLD = 0.35;

        for (const { orphanWindow, currentWindow, score } of scores) {
            if (score < MATCH_THRESHOLD) continue;
            if (usedOrphan.has(orphanWindow.id) || usedCurrent.has(currentWindow.id)) continue;

            matched.push({
                orphanWindow,
                currentWindow,
                confidence: score,
                orphanTabs: orphanTabsByWindow[orphanWindow.id] || [],
                currentTabs: currentTabsByWindow[currentWindow.id] || []
            });

            usedOrphan.add(orphanWindow.id);
            usedCurrent.add(currentWindow.id);
        }

        // Identify unmatched
        const unmatchedOrphans = orphanWindows.filter(w => !usedOrphan.has(w.id));
        const unmatchedCurrent = currentWindows.filter(w => !usedCurrent.has(w.id));

        return { matched, unmatchedOrphans, unmatchedCurrent };
    }
}
