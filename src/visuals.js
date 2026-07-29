'use strict';

// Status visuals + emoji + sorting helpers.
// Status is derived from wantedInstall × actual install (4 states) plus a 5th
// `extra-installed` for installed-but-unbookmarked extensions.

const vscode = require('vscode');
const iconCache = require('./iconCache');

// Status → { codicon, color }. Used for fallback iconPath (when a bookmark has
// no marketplace icon) and the Details status icon. The dual-emoji description
// is produced separately by statusDescription().
const STATUS_VISUALS = {
    'ok-installed':    { codicon: 'check',      color: 'testing.iconPassed' },
    'want-install':    { codicon: 'arrow-down', color: 'editorInfo.foreground' },
    'want-uninstall':  { codicon: 'x',          color: 'editorError.foreground' },
    'ok-uninstalled':  { codicon: 'check',      color: 'testing.iconPassed' },
    'extra-installed': { codicon: 'add',        color: 'editorWarning.foreground' }
};

function wantedEmoji(wanted) { return wanted ? '⭐' : '🚫'; }
function installedEmoji(installed) { return installed ? '✅' : '❌'; }

/** Dual-emoji description shown to the right of the label. Extra → single 🆕. */
function statusDescription(d) {
    if (d.extra) return '🆕';
    return `${wantedEmoji(d.want)} ${installedEmoji(d.actual)}`;
}

/** Determine the 4-state status of a bookmark vs. actual install state. */
function decorateBookmark(bookmark, installedSet) {
    const want = bookmark.wantedInstall !== false; // true unless explicitly false
    const actual = installedSet.has(String(bookmark.id).toLowerCase());
    let status;
    if (want) {
        status = actual ? 'ok-installed' : 'want-install';
    } else {
        status = actual ? 'want-uninstall' : 'ok-uninstalled';
    }
    return { bookmark, want, actual, status };
}

function decorateExtra(bookmark) {
    return { bookmark, want: undefined, actual: true, status: 'extra-installed', extra: true };
}

function isDiffStatus(d) {
    return d.status === 'want-install'
        || d.status === 'want-uninstall'
        || d.status === 'extra-installed';
}

/** Layered sort rank within a bucket: clean states first, diffs next, unwanted last. */
function statusRank(d) {
    if (d.status === 'ok-installed') return 0;
    if (d.status === 'want-install') return 1;
    if (d.status === 'want-uninstall') return 1;
    if (d.status === 'extra-installed') return 1;
    return 2; // unwanted (ok-uninstalled)
}

const byNameAsc = (a, b) => (a.bookmark?.displayName || '').localeCompare(b.bookmark?.displayName || '');
const byNameDesc = (a, b) => byNameAsc(b, a);
const byDateDesc = (a, b) => new Date(b.bookmark?.dateAdded || 0) - new Date(a.bookmark?.dateAdded || 0);
const byDateAsc = (a, b) => byDateDesc(b, a);
// Cluster booleans: true-first when asc, false-first when desc.
const byWanted = (asc) => (a, b) => {
    const va = a.want === true ? 0 : 1;
    const vb = b.want === true ? 0 : 1;
    return asc ? va - vb : vb - va;
};
const byInstalled = (asc) => (a, b) => {
    const va = a.actual ? 0 : 1;
    const vb = b.actual ? 0 : 1;
    return asc ? va - vb : vb - va;
};

/**
 * Unified decorated-item sort. Each option is a primary key; tie-breaks fall
 * back to name A→Z, then added New→Old. The old forced statusRank prefix is
 * gone — Wanted/Installed options cluster explicitly, others sort purely.
 */
function sortDecorated(list, option) {
    const cmp = comparatorsFor(option);
    return list.slice().sort((a, b) => {
        for (const fn of cmp) {
            const r = fn(a, b);
            if (r !== 0) return r;
        }
        return 0;
    });
}

function comparatorsFor(option) {
    switch (option) {
        case 'A-Z':        return [byNameAsc, byDateDesc];
        case 'Z-A':        return [byNameDesc, byDateDesc];
        case 'New-Old':    return [byDateDesc, byNameAsc];
        case 'Old-New':    return [byDateAsc, byNameAsc];
        case 'Wanted':     return [byWanted(true), byNameAsc, byDateDesc];
        case 'Unwanted':   return [byWanted(false), byNameAsc, byDateDesc];
        case 'Installed':  return [byInstalled(true), byNameAsc, byDateDesc];
        case 'Missing':    return [byInstalled(false), byNameAsc, byDateDesc];
        default:           return [byNameAsc, byDateDesc];
    }
}

function sortBookmarks(list, sortingOption) {
    switch (sortingOption) {
        case 'A-Z':
            return list.sort((a, b) => a.displayName.localeCompare(b.displayName));
        case 'Z-A':
            return list.sort((a, b) => b.displayName.localeCompare(a.displayName));
        case 'New-Old':
            return list.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
        case 'Old-New':
            return list.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
        default:
            return list.sort((a, b) => a.displayName.localeCompare(b.displayName));
    }
}

/** Secondary sort key for decorated items, mirroring sortBookmarks. */
function decoratedSecondary(sortingOption) {
    return (a, b) => {
        const da = a.bookmark, db = b.bookmark;
        switch (sortingOption) {
            case 'Z-A':      return db.displayName.localeCompare(da.displayName);
            case 'New-Old':  return new Date(db.dateAdded) - new Date(da.dateAdded);
            case 'Old-New':  return new Date(da.dateAdded) - new Date(db.dateAdded);
            case 'A-Z':
            default:         return da.displayName.localeCompare(db.displayName);
        }
    };
}

function buildIconPath(bookmark, status) {
    const cached = iconCache.cachedUri(bookmark);
    if (cached) return cached;
    if (bookmark.extra && bookmark.icon) return vscode.Uri.parse(bookmark.icon);
    if (bookmark.icon) {
        const uri = vscode.Uri.parse(bookmark.icon);
        if (uri.scheme === 'file') return uri;
    }
    const v = STATUS_VISUALS[status];
    return new vscode.ThemeIcon(v.codicon, new vscode.ThemeColor(v.color));
}

module.exports = {
    STATUS_VISUALS,
    wantedEmoji, installedEmoji, statusDescription,
    decorateBookmark, decorateExtra,
    isDiffStatus, statusRank,
    sortBookmarks, decoratedSecondary, sortDecorated,
    buildIconPath
};
