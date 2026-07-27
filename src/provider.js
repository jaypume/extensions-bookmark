'use strict';

// Main bookmark tree provider with a generic grouping engine.
// Three groupBy dimensions: 'category' | 'status' | 'flat'.
// contextValue keeps the legacy simple values so existing view/item/context
// `when` clauses keep working unchanged.

const vscode = require('vscode');
const store = require('./store');
const {
    decorateBookmark, decorateExtra,
    isDiffStatus, statusRank, statusDescription, decoratedSecondary, sortDecorated,
    buildIconPath
} = require('./visuals');
const { computeInstalledSet, computeExtraBookmarks } = require('./installed');

function getRecentHours() {
    const hours = vscode.workspace.getConfiguration('extensionsBookmark').get('recentHours', 12);
    return Number.isFinite(hours) && hours > 0 ? hours : 12;
}

function wasAddedWithin(bookmark, hours) {
    const addedAt = new Date(bookmark.dateAdded).getTime();
    const age = Date.now() - addedAt;
    return Number.isFinite(addedAt) && age >= 0 && age <= hours * 60 * 60 * 1000;
}

function wasAddedBefore(bookmark, days) {
    const t = new Date(bookmark.dateAdded).getTime();
    if (!Number.isFinite(t)) return false;
    return Date.now() - t <= days * 24 * 60 * 60 * 1000;
}

function passesFilter(d, statusFilter) {
    switch (statusFilter) {
        case 'installed':    return d.actual;
        case 'uninstalled':  return !d.actual;
        case 'wanted':       return d.want !== false && !d.extra;
        case 'unwanted':     return d.want === false;
        case 'added-1d':     return wasAddedBefore(d.bookmark, 1);
        case 'added-1w':     return wasAddedBefore(d.bookmark, 7);
        case 'added-1m':     return wasAddedBefore(d.bookmark, 30);
        case 'all':
        default:             return true;
    }
}

function bookmarkContextValue(d) {
    if (d.extra) return 'extra.installed';
    return `bookmark.${d.want ? 'wanted' : 'unwanted'}.${d.actual ? 'installed' : 'missing'}`;
}

function toBookmarkTreeItem(d) {
    const bookmark = d.bookmark;
    const treeItem = new vscode.TreeItem(bookmark.displayName);
    treeItem.bookmarkId = bookmark.id;
    treeItem.category = bookmark.category;
    const wantTxt = d.extra ? 'unbookmarked' : (d.want ? 'wanted' : 'not wanted');
    const installedTxt = d.actual ? 'installed' : 'not installed';
    treeItem.tooltip = `ID: ${bookmark.id}\nName: ${bookmark.displayName}\nCategory: ${bookmark.category}\nExpected: ${wantTxt} / ${installedTxt}\nAdded: ${bookmark.dateAdded}\n\nDownloads: ${bookmark.downloadCount}\nRating: ${bookmark.rating}\nUpdated: ${bookmark.lastUpdate}${bookmark.note ? `\n\nNote: ${bookmark.note}` : ''}`;
    // Status lives in the row's inline icon buttons + the leading iconPath;
    // the description is kept free of emoji (rendering is unreliable there).
    treeItem.description = d.extra ? bookmark.id : '';
    if (d.extra) {
        // Clicking an installed-but-unbookmarked item offers to bookmark it.
        treeItem.command = {
            command: 'extensions-bookmark.addExtraToBookmarks',
            arguments: [bookmark.id],
            title: 'Add to Bookmarks'
        };
    } else {
        treeItem.command = {
            command: 'extensions-bookmark.showDetails',
            arguments: [bookmark.id],
            title: 'Show Details'
        };
    }
    treeItem.contextValue = bookmarkContextValue(d);
    treeItem.iconPath = buildIconPath(bookmark, d.status);
    return treeItem;
}

// --- generic grouping engine (category | status | age | flat) ---

const DAY = 24 * 60 * 60 * 1000;
const AGE_BUCKETS = ['__lt1d__', '__lt1w__', '__lt1m__', '__gt1m__'];

function ageKey(dateAdded) {
    const t = new Date(dateAdded).getTime();
    if (!Number.isFinite(t)) return '__gt1m__'; // unknown age → oldest bucket
    const age = Date.now() - t;
    if (age < 1 * DAY) return '__lt1d__';
    if (age < 7 * DAY) return '__lt1w__';
    if (age < 30 * DAY) return '__lt1m__';
    return '__gt1m__';
}

function bucketKey(d, dim) {
    if (dim === 'wanted') {
        if (d.extra) return '__extra__';
        return d.want === false ? '__notwanted__' : '__wanted__';
    }
    if (dim === 'installed') {
        return d.actual ? '__installed__' : '__missing__';
    }
    if (dim === 'age') {
        if (d.extra) return '__gt1m__'; // unbookmarked items have no dateAdded
        return ageKey(d.bookmark.dateAdded);
    }
    if (dim === 'category') return d.bookmark.category || 'Default';
    return ''; // flat
}

// Canonical ordering of fixed buckets; ad-hoc keys (custom categories) sort
// alphabetically after the fixed ones.
function bucketOrder(dim) {
    if (dim === 'wanted') return ['__wanted__', '__notwanted__', '__extra__'];
    if (dim === 'installed') return ['__installed__', '__missing__'];
    if (dim === 'age') return AGE_BUCKETS;
    if (dim === 'category') return ['Default'];
    return [];
}

function bucketLabel(dim, key) {
    if (dim === 'wanted') {
        if (key === '__wanted__') return 'Wanted';
        if (key === '__notwanted__') return 'Not Wanted';
        if (key === '__extra__') return 'Unbookmarked';
    }
    if (dim === 'installed') {
        if (key === '__installed__') return 'Installed';
        if (key === '__missing__') return 'Missing';
    }
    if (dim === 'age') {
        if (key === '__lt1d__') return '< 1 day';
        if (key === '__lt1w__') return '< 1 week';
        if (key === '__lt1m__') return '< 1 month';
        if (key === '__gt1m__') return '> 1 month';
    }
    return key;
}

function groupIcon(dim, key) {
    if (dim === 'wanted') {
        if (key === '__wanted__') return new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'));
        if (key === '__notwanted__') return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
        if (key === '__extra__') return new vscode.ThemeIcon('add', new vscode.ThemeColor('editorWarning.foreground'));
    }
    if (dim === 'installed') {
        if (key === '__installed__') return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
        if (key === '__missing__') return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
    }
    if (dim === 'age') {
        return new vscode.ThemeIcon('history', new vscode.ThemeColor('charts.purple'));
    }
    if (dim === 'category') {
        return new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.blue'));
    }
    return undefined;
}

class BookmarkTreeProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.groupBy = store.get('groupBy', 'category');
        this.statusFilter = store.get('statusFilter', 'all');
        this.categoryItems = new Map();
        this.groupItems = new Map();
        this.bookmarkItems = new Map();
        this._selection = null;
    }

    refresh() {
        // Clear node caches so stale items (renamed categories, switched
        // dimensions, removed bookmarks) don't leak into reveal/selection.
        this.categoryItems.clear();
        this.groupItems.clear();
        this.bookmarkItems.clear();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element) {
        return element;
    }

    getParent(element) {
        if (!element?.contextValue) return undefined;
        const isBookmark = element.contextValue.startsWith('bookmark.');
        if (!isBookmark) return undefined;
        if (this.groupBy === 'category') return this.getCategoryItem(element.category);
        if (this.groupBy === 'wanted' || this.groupBy === 'installed' || this.groupBy === 'age') {
            return this.getGroupItem(this.groupBy, this._bucketKeyForBookmark(element.bookmarkId));
        }
        return undefined;
    }

    _bucketKeyForBookmark(id) {
        const bookmarks = store.get('bookmarks', []);
        const bm = bookmarks.find(b => String(b.id).toLowerCase() === String(id).toLowerCase());
        const d = bm ? decorateBookmark(bm, computeInstalledSet()) : decorateExtra({ id, extra: true });
        return bucketKey(d, this.groupBy);
    }

    getCategoryItem(category) {
        let treeItem = this.categoryItems.get(category);
        if (!treeItem) {
            treeItem = new vscode.TreeItem(category, vscode.TreeItemCollapsibleState.Collapsed);
            treeItem.id = `category:${category}`;
            treeItem.category = category;
            this.categoryItems.set(category, treeItem);
        }
        treeItem.contextValue = category === 'Default' ? 'defaultCategory' : 'category';
        treeItem.iconPath = groupIcon('category', category);
        return treeItem;
    }

    getGroupItem(dim, key) {
        const mapKey = `${dim}:${key}`;
        let treeItem = this.groupItems.get(mapKey);
        if (!treeItem) {
            treeItem = new vscode.TreeItem(bucketLabel(dim, key), vscode.TreeItemCollapsibleState.Collapsed);
            treeItem.id = `group:${mapKey}`;
            treeItem.contextValue = 'statusGroup';
            treeItem.groupDim = dim;
            treeItem.statusKey = key;
            treeItem.iconPath = groupIcon(dim, key);
            this.groupItems.set(mapKey, treeItem);
        }
        return treeItem;
    }

    getBookmarkItem(bookmark, installedSet = computeInstalledSet(), scope = 'category') {
        const bookmarkId = String(bookmark.id).toLowerCase();
        const key = `${scope}:${bookmarkId}`;
        // Extra items come pre-decorated; don't re-derive their status.
        const decorated = bookmark.extra
            ? decorateExtra(bookmark)
            : decorateBookmark(bookmark, installedSet);
        const next = toBookmarkTreeItem(decorated);
        next.id = `bookmark:${key}`;
        const treeItem = this.bookmarkItems.get(key);
        if (treeItem) {
            Object.assign(treeItem, next);
            return treeItem;
        }
        this.bookmarkItems.set(key, next);
        return next;
    }

    /** All decorated bookmarks + extras, filtered by the active status filter. */
    _visibleDecorated(installedSet) {
        const bookmarks = store.get('bookmarks', []);
        const decorate = (bm) => decorateBookmark(bm, installedSet);
        const extraBookmarks = computeExtraBookmarks(installedSet);
        const all = bookmarks.map(decorate).concat(extraBookmarks.map(decorateExtra));
        return all.filter(d => passesFilter(d, this.statusFilter));
    }

    _sortGroup(decorated, sortingOption) {
        return sortDecorated(decorated, sortingOption);
    }

    async getChildren(element) {
        const installedSet = computeInstalledSet();

        if (element) {
            const sortingOption = store.get('sortingOption', 'A-Z');
            const visible = this._visibleDecorated(installedSet); // compute once
            let scope;
            let inGroup;
            if (element.contextValue === 'statusGroup') {
                const dim = element.groupDim || 'status';
                scope = `${dim}:${element.statusKey}`;
                inGroup = visible.filter(d => bucketKey(d, dim) === element.statusKey);
            } else {
                // category group
                scope = `category:${element.label}`;
                inGroup = visible.filter(d => (d.bookmark.category || 'Default') === element.label);
            }
            return this._sortGroup(inGroup, sortingOption)
                .map(d => this.getBookmarkItem(d.bookmark, installedSet, scope));
        }

        // Root level.
        if (this.groupBy === 'flat') {
            const sortingOption = store.get('sortingOption', 'A-Z');
            const visible = this._visibleDecorated(installedSet);
            return this._sortGroup(visible, sortingOption)
                .map(d => this.getBookmarkItem(d.bookmark, installedSet, 'flat'));
        }

        if (this.groupBy === 'wanted' || this.groupBy === 'installed' || this.groupBy === 'age') {
            const dim = this.groupBy;
            const visible = this._visibleDecorated(installedSet);
            // Single pass to count members per bucket (avoid O(buckets × items)).
            const counts = new Map();
            for (const d of visible) {
                const k = bucketKey(d, dim);
                counts.set(k, (counts.get(k) || 0) + 1);
            }
            return bucketOrder(dim).map(key => {
                const node = this.getGroupItem(dim, key);
                node.label = `${bucketLabel(dim, key)} (${counts.get(key) || 0})`;
                return node;
            });
        }

        // category root: 'Default' pinned first; ensure it exists for extras.
        const categories = store.get('categories', []);
        const catSet = categories.slice();
        if (!catSet.includes('Default')) catSet.push('Default');
        return catSet.sort((a, b) => {
            if (a === 'Default') return -1;
            if (b === 'Default') return 1;
            return a.localeCompare(b);
        }).map(category => this.getCategoryItem(category));
    }
}

module.exports = {
    BookmarkTreeProvider,
    toBookmarkTreeItem,
    getRecentHours,
    passesFilter,
    bucketKey, bucketOrder, bucketLabel, groupIcon
};
