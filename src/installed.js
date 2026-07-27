'use strict';

// Installed-extension set + extra (installed-but-unbookmarked) cache.
// The cache is rebuilt on each refresh and also serves details lookups so the
// Details view can render unbookmarked items.

const vscode = require('vscode');
const store = require('./store');

// lowercased id -> bookmark
const extraBookmarksCache = new Map();

function computeInstalledSet() {
    return new Set(vscode.extensions.all.map(e => e.id.toLowerCase()));
}

function isInstalled(id) {
    return vscode.extensions.all.some(e => e.id.toLowerCase() === String(id).toLowerCase());
}

// Extensions installed locally but absent from the bookmarks list, returned as
// pseudo-bookmarks so they render through the same tree pipeline.
function computeExtraBookmarks(installedSet) {
    const bookmarks = store.get('bookmarks', []);
    const known = new Set(bookmarks.map(b => String(b.id).toLowerCase()));
    const result = [];
    for (const ext of vscode.extensions.all) {
        const id = String(ext.id);
        const lower = id.toLowerCase();
        // Skip editor built-ins shipped under the vscode.* namespace.
        if (lower.startsWith('vscode.')) continue;
        if (known.has(lower)) continue;
        if (!installedSet.has(lower)) continue;
        const pkg = ext.packageJSON || {};
        const displayName = pkg.displayName || id;
        const iconPath = pkg.icon
            ? vscode.Uri.joinPath(ext.extensionUri, pkg.icon).toString()
            : undefined;
        result.push({
            id, displayName,
            icon: iconPath,
            category: 'Default',
            extra: true,
            dateAdded: ''
        });
    }
    extraBookmarksCache.clear();
    for (const bm of result) extraBookmarksCache.set(bm.id.toLowerCase(), bm);
    return result;
}

// Case-insensitive bookmark lookup. Falls back to the extra cache so details
// can render unbookmarked items too.
function lookupBookmark(bookmarkId) {
    if (!bookmarkId) return undefined;
    const lower = String(bookmarkId).toLowerCase();
    const bookmark = store.get('bookmarks', []).find(b => String(b.id).toLowerCase() === lower);
    if (bookmark) return bookmark;
    return extraBookmarksCache.get(lower);
}

// Build a bookmark from a locally-installed extension without hitting the
// Marketplace. Lets private/unpublished extensions still be bookmarked.
function buildBookmarkFromLocal(extensionId, category) {
    const ext = vscode.extensions.all.find(e => e.id.toLowerCase() === String(extensionId).toLowerCase());
    const pkg = (ext && ext.packageJSON) || {};
    const id = ext ? ext.id : extensionId;
    const dateAdded = new Date().toLocaleString('en-US', {
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric'
    });
    const lastUpdated = pkg.lastUpdated
        ? new Date(pkg.lastUpdated).toLocaleString('en-US', {
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric'
        })
        : 'N/A';
    return {
        id,
        displayName: pkg.displayName || id,
        icon: pkg.icon
            ? vscode.Uri.joinPath(ext.extensionUri, pkg.icon).toString()
            : 'https://raw.githubusercontent.com/jaypume/extensions-bookmark/main/media/default-bookmark-icon.png',
        category,
        dateAdded,
        downloadCount: 'N/A',
        rating: 'N/A',
        lastUpdate: lastUpdated,
        wantedInstall: true
    };
}

module.exports = {
    extraBookmarksCache,
    computeInstalledSet,
    computeExtraBookmarks,
    lookupBookmark,
    buildBookmarkFromLocal,
    isInstalled
};
