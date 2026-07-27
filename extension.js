const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { version: extensionVersion } = require('./package.json');

let outputChannel;

function formatError(error) {
    if (!error) return '';
    return error.stack || error.message || String(error);
}

function logInfo(message) {
    const line = `[${new Date().toISOString()}] INFO ${message}`;
    outputChannel?.appendLine(line);
    console.log(`[extensions-bookmark] ${message}`);
}

function logError(message, error) {
    const detail = formatError(error);
    const line = `[${new Date().toISOString()}] ERROR ${message}${detail ? `\n${detail}` : ''}`;
    outputChannel?.appendLine(line);
    console.error(`[extensions-bookmark] ${message}`, error || '');
}

function createNonce() {
    return crypto.randomBytes(16).toString('base64');
}

// Runtime set of installed extension ids (lowercased) for status detection.
function computeInstalledSet() {
    return new Set(vscode.extensions.all.map(e => e.id.toLowerCase()));
}

// Extensions installed locally but absent from the bookmarks list.
// Returned as pseudo-bookmarks so they render through the same tree pipeline.
// In-memory cache (rebuilt each refresh) lets the details view look them up.
const extraBookmarksCache = new Map(); // lowercased id -> bookmark

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

function decorateExtra(bookmark) {
    return { bookmark, want: undefined, actual: true, status: 'extra-installed', extra: true };
}

// Case-insensitive bookmark lookup used by the details view. Falls back to the
// in-memory extra (unbookmarked) cache so details can render those too.
function lookupBookmark(bookmarkId) {
    if (!bookmarkId) return undefined;
    const lower = String(bookmarkId).toLowerCase();
    const bookmark = store.get('bookmarks', []).find(b => String(b.id).toLowerCase() === lower);
    if (bookmark) return bookmark;
    return extraBookmarksCache.get(lower);
}

// Determine the 4-state status of a bookmark vs. actual install state.
// wantedInstall is optional (defaults to true for backward compat).
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

// Status → { icon, color, desc }. desc is shown on the right (emoji marker).
// icon/color only used when a bookmark has no marketplace icon of its own.
const STATUS_VISUALS = {
    'ok-installed':    { codicon: 'check',       color: 'testing.iconPassed',    desc: '✅' },
    'want-install':    { codicon: 'arrow-down',  color: 'editorInfo.foreground', desc: '⚠️' },
    'want-uninstall':  { codicon: 'x',           color: 'editorError.foreground', desc: '🗑️' },
    'ok-uninstalled':  { codicon: 'check',       color: 'testing.iconPassed',    desc: '' },
    // Installed locally but not in any bookmark — surfaced in the Diff bucket.
    'extra-installed': { codicon: 'add',         color: 'editorWarning.foreground', desc: '🆕' }
};

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

function getRecentHours() {
    const hours = vscode.workspace.getConfiguration('extensionsBookmark').get('recentHours', 12);
    return Number.isFinite(hours) && hours > 0 ? hours : 12;
}

function wasAddedWithin(bookmark, hours) {
    const addedAt = new Date(bookmark.dateAdded).getTime();
    const age = Date.now() - addedAt;
    return Number.isFinite(addedAt) && age >= 0 && age <= hours * 60 * 60 * 1000;
}

function isDiffStatus(d) {
    return d.status === 'want-install'
        || d.status === 'want-uninstall'
        || d.status === 'extra-installed';
}

function passesFilter(d, statusFilter, recentHours) {
    // Extra (installed-but-unbookmarked) items are always visible regardless
    // of the active filter, so they always surface in the Diff bucket.
    if (d.extra) return true;
    switch (statusFilter) {
        case 'recent':     return wasAddedWithin(d.bookmark, recentHours);
        case 'installed':  return d.actual;
        case 'not-wanted': return d.want === false;
        case 'diff':       return isDiffStatus(d);
        case 'all':
        default:           return true;
    }
}

function parseExtensionIds(value) {
    const seen = new Set();
    const ids = [];
    const invalid = [];
    for (const raw of String(value || '').split(/[\s,;]+/)) {
        const id = raw.trim();
        if (!id) continue;
        if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/i.test(id)) {
            invalid.push(id);
            continue;
        }
        const key = id.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            ids.push(id);
        }
    }
    return { ids, invalid };
}

async function fetchMarketplaceBookmark(extensionId, category) {
    // Load Axios only when Marketplace access is needed. Provider registration
    // remains available even if a packaged HTTP dependency is damaged.
    const axios = require('axios');
    const response = await axios.post(
        'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
        {
            filters: [{
                criteria: [{ filterType: 7, value: extensionId }]
            }],
            flags: 914
        },
        {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json;api-version=3.0-preview.1'
            }
        }
    );
    const extension = response.data.results?.[0]?.extensions?.[0];
    if (!extension) return null;

    const version = extension.versions[0];
    const iconFile = (version.files || []).find(file => file.assetType === 'Microsoft.VisualStudio.Services.Icons.Default');
    const downloadCount = (extension.statistics || []).find(stat => stat.statisticName === 'install');
    const rating = (extension.statistics || []).find(stat => stat.statisticName === 'averagerating');
    return {
        id: extensionId,
        displayName: extension.displayName,
        icon: iconFile ? iconFile.source : 'https://raw.githubusercontent.com/jaypume/extensions-bookmark/main/media/default-bookmark-icon.png',
        category,
        dateAdded: new Date().toLocaleString('en-US', {
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric'
        }),
        downloadCount: downloadCount ? downloadCount.value.toLocaleString() : 'N/A',
        rating: rating ? rating.value.toFixed(1) : 'N/A',
        lastUpdate: new Date(version.lastUpdated).toLocaleString('en-US', {
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric'
        }),
        wantedInstall: true
    };
}

// Build a bookmark from a locally-installed extension without hitting the
// Marketplace. Used for "installed but not bookmarked" items so private or
// unpublished extensions can still be bookmarked. Falls back gracefully —
// only id/displayName/category are required; the rest default to 'N/A'.
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

function toBookmarkTreeItem(d) {
    const bookmark = d.bookmark;
    const treeItem = new vscode.TreeItem(bookmark.displayName);
    treeItem.bookmarkId = bookmark.id;
    treeItem.category = bookmark.category;
    let details = `ID: ${bookmark.id}\nName: ${bookmark.displayName}\nCategory: ${bookmark.category}\nExpected: ${d.want ? 'wanted' : 'not wanted'}`;
    if (bookmark.tags && bookmark.tags.length > 0) {
        details += `\nTags: ${bookmark.tags.sort().join(', ')}`; // Sort tags A-Z
    }
    details += `\nAdded: ${bookmark.dateAdded}\n\nDownloads: ${bookmark.downloadCount}\nRating: ${bookmark.rating}\nUpdated: ${bookmark.lastUpdate}`;
    if (bookmark.note) {
        details += `\n\nNote: ${bookmark.note}`;
    }
    treeItem.tooltip = details;
    treeItem.description = STATUS_VISUALS[d.status].desc;
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
    treeItem.contextValue = d.extra ? 'extraExtension' : 'bookmarkedExtension';
    // Prefer the bookmark's marketplace icon; otherwise use a colored status icon.
    if (bookmark.icon) {
        treeItem.iconPath = vscode.Uri.parse(bookmark.icon);
    } else {
        const v = STATUS_VISUALS[d.status];
        treeItem.iconPath = new vscode.ThemeIcon(v.codicon, new vscode.ThemeColor(v.color));
    }
    return treeItem;
}

class BookmarkDataProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.viewMode = store.get('viewMode', 'by-category');
        this.statusFilter = store.get('statusFilter', 'recent');
        this.categoryItems = new Map();
        this.bookmarkItems = new Map();
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element) {
        return element;
    }

    getParent(element) {
        if (this.viewMode === 'by-category' && element?.contextValue === 'bookmarkedExtension') {
            return this.getCategoryItem(element.category);
        }
        return undefined;
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
        return treeItem;
    }

    getBookmarkItem(bookmark, installedSet = computeInstalledSet(), scope = 'category') {
        const bookmarkId = String(bookmark.id).toLowerCase();
        const key = `${scope}:${bookmarkId}`;
        // Extra (unbookmarked) items come pre-decorated; don't re-derive their status.
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

    async getChildren(element) {
        const categories = store.get('categories', []);
        const bookmarks = store.get('bookmarks', []);
        const sortingOption = store.get('sortingOption', 'A-Z');
        const installedSet = computeInstalledSet();

        const decorate = (bm) => decorateBookmark(bm, installedSet);
        const recentHours = getRecentHours();
        const visible = (d) => passesFilter(d, this.statusFilter, recentHours);

        // Installed-but-not-bookmarked extensions, surfaced as pseudo-bookmarks.
        const extraBookmarks = computeExtraBookmarks(installedSet);
        const decorateExtraAll = () => extraBookmarks.map(decorateExtra);

        if (element) {
            let inGroup;
            let itemScope;
            if (element.contextValue === 'statusGroup') {
                itemScope = `status:${element.statusKey}`;
                // Grouped by status: filter by the group's bucket key.
                inGroup = bookmarks
                    .map(decorate)
                    .filter(d => {
                        if (!visible(d)) return false;
                        if (element.statusKey === '__wanted__')    return d.want === true;
                        if (element.statusKey === '__notwanted__') return d.want === false;
                        return isDiffStatus(d);
                    });
                // Extra (installed, not bookmarked) items belong to the Diff bucket.
                if (element.statusKey === '__diff__') {
                    inGroup = inGroup.concat(decorateExtraAll().filter(visible));
                }
            } else {
                itemScope = `category:${element.label}`;
                // Grouped by category. Extra items have no category, so they
                // land under 'Default'.
                inGroup = bookmarks
                    .filter(bm => bm.category === element.label)
                    .map(decorate)
                    .filter(visible);
                if (element.label === 'Default') {
                    inGroup = inGroup.concat(decorateExtraAll().filter(visible));
                }
            }
            // Sort by status priority (wanted&installed → diff → unwanted),
            // then by the user's chosen sorting option within each tier.
            const statusRank = (d) => {
                if (d.status === 'ok-installed')   return 0; // wanted & installed
                if (d.status === 'want-install')   return 1; // diff: to install
                if (d.status === 'want-uninstall') return 1; // diff: to remove
                if (d.status === 'extra-installed') return 1; // diff: not bookmarked
                return 2;                                    // unwanted (ok-uninstalled)
            };
            const tierKey = (d) => statusRank(d);
            // Secondary sort key mirrors sortBookmarks but on decorated items.
            const secondary = (a, b) => {
                const da = a.bookmark, db = b.bookmark;
                switch (sortingOption) {
                    case 'Z-A':      return db.displayName.localeCompare(da.displayName);
                    case 'New-Old':  return new Date(db.dateAdded) - new Date(da.dateAdded);
                    case 'Old-New':  return new Date(da.dateAdded) - new Date(db.dateAdded);
                    case 'A-Z':
                    default:         return da.displayName.localeCompare(db.displayName);
                }
            };
            return inGroup.slice().sort((a, b) => {
                const r = tierKey(a) - tierKey(b);
                return r !== 0 ? r : secondary(a, b);
            }).map(d => this.getBookmarkItem(d.bookmark, installedSet, itemScope));
        }

        // Root level.
        if (this.viewMode === 'flat') {
            const flat = bookmarks.map(decorate).concat(decorateExtraAll()).filter(visible);
            return sortBookmarks(flat.map(d => d.bookmark), 'A-Z')
                .map(bm => this.getBookmarkItem(bm, installedSet, 'flat'));
        }

        if (this.viewMode === 'by-status') {
            // Three fixed buckets, always shown (even if empty).
            // Wanted = expected to install; Not Wanted = expected to uninstall;
            // Diff = expectation != actual, plus extra installed-but-unbookmarked.
            const all = bookmarks.map(decorate).concat(decorateExtraAll());
            const buckets = [
                { label: 'Wanted',     key: '__wanted__' },
                { label: 'Not Wanted', key: '__notwanted__' },
                { label: 'Diff',       key: '__diff__' }
            ];
            return buckets.map(b => {
                const inBucket = (d) => {
                    if (b.key === '__wanted__')    return d.want === true;
                    if (b.key === '__notwanted__') return d.want === false;
                    return isDiffStatus(d);
                };
                const count = all.filter(d => visible(d) && inBucket(d)).length;
                const treeItem = new vscode.TreeItem(`${b.label} (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
                treeItem.contextValue = 'statusGroup';
                treeItem.statusKey = b.key;
                return treeItem;
            });
        }

        // by-category root: category list, 'Default' pinned first.
        // Ensure 'Default' exists so extra (unbookmarked) items always render.
        const catSet = categories.slice();
        if (!catSet.includes('Default')) catSet.push('Default');
        const sortedCategories = catSet.sort((a, b) => {
            if (a === 'Default') return -1;
            if (b === 'Default') return 1;
            return a.localeCompare(b);
        });
        return sortedCategories.map(category => this.getCategoryItem(category));
    }
}

// Webview view that renders a details card for the selected bookmark.
class DetailsViewProvider {
    constructor(context, bookmarkDataProvider) {
        this.context = context;
        this.bookmarkDataProvider = bookmarkDataProvider;
        this.view = null;
        this.bookmarkId = null;
        this.assets = null;
    }

    resolveWebviewView(view) {
        this.view = view;
        const nk = (p) => view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...p)).toString();
        this.assets = {
            codiconTtf: nk(['node_modules', '@vscode', 'codicons', 'dist', 'codicon.ttf'])
        };
        view.webview.options = { enableScripts: true };
        const bookmark = lookupBookmark(this.bookmarkId);
        view.webview.html = bookmark ? this._renderCard(bookmark) : this._renderEmpty();
        view.webview.onDidReceiveMessage(async (msg) => {
            if (msg && msg.type === 'saveNote' && this.bookmarkId) {
                const bookmarks = store.get('bookmarks', []);
                const bm = bookmarks.find(b => b.id === this.bookmarkId);
                if (bm) {
                    bm.note = msg.value;
                    store.update('bookmarks', bookmarks);
                    this.bookmarkDataProvider.refresh();
                }
            } else if (msg && msg.type === 'openMarket' && this.bookmarkId) {
                vscode.commands.executeCommand('extension.open', this.bookmarkId);
            }
        });
    }

    show(bookmarkId) {
        this.bookmarkId = bookmarkId;
        if (this.view) {
            const bookmark = lookupBookmark(bookmarkId);
            if (bookmark) this.view.webview.html = this._renderCard(bookmark);
            this.view.show?.(true);
        }
    }

    // Shared <head>: codicons font (self-declared with absolute webview URI
    // so the relative path in codicon.css resolves correctly) + base CSS.
    _head(nonce) {
        const a = this.assets || {};
        return `<meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${this.view.webview.cspSource}; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <style>
          @font-face {
            font-family: "codicon";
            font-display: block;
            src: url("${a.codiconTtf}") format("truetype");
          }
          ${DETAILS_CSS}
        </style>`;
    }

    _renderEmpty() {
        const nonce = createNonce();
        return `<!DOCTYPE html><html><head>${this._head(nonce)}</head>
        <body><div class="empty">Select a bookmark to view details.</div></body></html>`;
    }

    _renderCard(bm) {
        const installedSet = computeInstalledSet();
        const d = decorateBookmark(bm, installedSet);
        const esc = (s) => String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const nonce = createNonce();
        const iconHtml = bm.icon
            ? `<img class="icon" src="${esc(bm.icon)}" alt="">`
            : `<div class="icon icon-placeholder"></div>`;
        const tags = (bm.tags && bm.tags.length) ? bm.tags.slice().sort().join(', ') : '—';
        const wantIco = d.want ? 'codicon-check' : 'codicon-close';
        const wantLabel = d.want ? 'Wanted' : 'Not wanted';
        const wantCls = d.want ? 'st-ok' : 'st-bad';
        const actualIco = d.actual ? 'codicon-passed' : 'codicon-circle-slash';
        const actualLabel = d.actual ? 'Installed' : 'Not installed';
        const actualCls = d.actual ? 'st-ok' : 'st-mute';
        const tableRow = (k, v) => `<tr><td class="k">${k}</td><td class="v">${esc(v)}</td></tr>`;
        return `<!DOCTYPE html><html><head>${this._head(nonce)}</head>
        <body>
        <div class="card">
          <header class="head">
            ${iconHtml}
            <div class="title">
              <div class="name">${esc(bm.displayName)}</div>
                  <div class="id">${esc(bm.id)}</div>
            </div>
          </header>

          <div class="status">
            <span class="status-chip ${wantCls}">
              <span class="codicon ${wantIco}"></span><span>${wantLabel}</span>
            </span>
            <span class="status-chip ${actualCls}">
              <span class="codicon ${actualIco}"></span><span>${actualLabel}</span>
            </span>
          </div>

          <table class="grid">
            <tbody>
              ${tableRow('Category', bm.category)}
              ${tableRow('Tags', tags)}
              ${tableRow('Added', bm.dateAdded)}
              ${tableRow('Downloads', bm.downloadCount || '—')}
              ${tableRow('Rating', bm.rating || '—')}
              ${tableRow('Updated', bm.lastUpdate || '—')}
            </tbody>
          </table>

          <div class="note-wrap">
            <label class="note-label" for="note">Note</label>
            <textarea id="note" placeholder="Add a personal note…">${esc(bm.note || '')}</textarea>
          </div>

          <button id="openMarket" class="btn">
            <span class="codicon codicon-extensions"></span>
            <span>Open in Marketplace</span>
          </button>
        </div>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          const ta = document.getElementById('note');
          ta.addEventListener('blur', () => vscode.postMessage({ type: 'saveNote', value: ta.value }));
          document.getElementById('openMarket').addEventListener('click', () => {
            vscode.postMessage({ type: 'openMarket' });
          });
        </script>
        </body></html>`;
    }
}

const DETAILS_CSS = `
  body { margin: 0; padding: 16px 20px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .codicon { font: normal normal normal 16px/1 codicon; display: inline-block; }
  .empty { color: var(--vscode-descriptionForeground); padding: 8px 0; }
  .card { display: flex; flex-direction: column; gap: 16px; }
  .head { display: flex; align-items: center; gap: 14px; }
  .icon { width: 56px; height: 56px; object-fit: contain; flex-shrink: 0; background: var(--vscode-editorWidget-background); border-radius: 6px; padding: 4px; box-sizing: border-box; }
  .icon-placeholder { background: var(--vscode-editorWidget-background); }
  .title { flex: 1; min-width: 0; }
  .name { font-weight: 600; word-break: break-word; }
  .id { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 2px; }
  .status { display: flex; flex-wrap: wrap; gap: 10px; }
  .status-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 0.9em; }
  .status-chip .codicon { font-size: 1em; }
  .st-ok { color: var(--vscode-testing-iconPassed); }
  .st-bad { color: var(--vscode-errorForeground); }
  .st-mute { color: var(--vscode-descriptionForeground); }
  table.grid { width: 100%; border-collapse: collapse; border-spacing: 0; }
  table.grid td { padding: 4px 0; vertical-align: top; border: none; }
  table.grid tr { border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.15)); }
  table.grid tr:last-child { border-bottom: none; }
  td.k { color: var(--vscode-descriptionForeground); white-space: nowrap; padding-right: 12px; }
  td.v { text-align: right; word-break: break-word; }
  .note-wrap { display: flex; flex-direction: column; gap: 6px; }
  .note-label { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  textarea { width: 100%; min-height: 90px; resize: vertical; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 8px; font-family: inherit; font-size: inherit; }
  textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
  .btn { display: inline-flex; align-items: center; gap: 6px; width: 100%; justify-content: center; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 2px; padding: 6px 12px; font-family: inherit; font-size: inherit; cursor: pointer; }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn .codicon { font-size: 1em; }
`;

function activate(context) {
    outputChannel = vscode.window.createOutputChannel('Extensions Bookmark');
    context.subscriptions.push(outputChannel);
    logInfo(`Activating v${extensionVersion}`);
    logInfo(`Data directory: ${context.globalStorageUri.fsPath}`);

    try {
    // Backing store: standalone JSON file under globalStorage, migrated from
    // settings.json on first run. See store.js. The data file is written
    // synchronously; clearing legacy settings.json keys is best-effort async.
    store.init(context);
    store.migrate().catch(error => logError('Data migration failed', error));

    const bookmarkDataProvider = new BookmarkDataProvider();
    logInfo('Registering List tree data provider');
    const bookmarkTreeView = vscode.window.createTreeView('extensionsBookmarkView', {
        treeDataProvider: bookmarkDataProvider
    });
    context.subscriptions.push(bookmarkTreeView);
    logInfo('List tree data provider registered');

    const detailsProvider = new DetailsViewProvider(context, bookmarkDataProvider);
    logInfo('Registering Details webview provider');
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('extensionsBookmarkDetails', detailsProvider)
    );
    logInfo('Details webview provider registered');

    // Sync the view-mode context key so the toggle button shows the right icon.
    vscode.commands.executeCommand('setContext', 'extensions-bookmark.viewMode', bookmarkDataProvider.viewMode);
    // Reflect external install/uninstall changes automatically.
    context.subscriptions.push(vscode.extensions.onDidChange(() => bookmarkDataProvider.refresh()));

    // Initialize categories if not already initialized
    let categories = store.get('categories', []);
    if (!Array.isArray(categories)) {
        store.update('categories', []);
    }

    // Initialize tags if not already initialized
    let tags = store.get('tags', []);
    if (!Array.isArray(tags)) {
        store.update('tags', []);
    }

    // Command to select adding a bookmark, adding a category, search, import or export, filter, sort, remove all data
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.add', async () => {
        const options = [
            { label: 'Add Bookmark', command: 'extensions-bookmark.addBookmark' },
            { label: 'Add from List', command: 'extensions-bookmark.addFromList' },
            { label: 'Add Category', command: 'extensions-bookmark.addCategory' },
            { label: 'Add Tag', command: 'extensions-bookmark.addTagToList' },
            { label: 'Rename Tag', command: 'extensions-bookmark.renameTagInList' },
            { label: 'Remove Tag', command: 'extensions-bookmark.removeTagFromList' },
            { label: 'Sort Bookmarks', command: 'extensions-bookmark.sortBookmarks' },
            { label: 'Filter Bookmarks', command: 'extensions-bookmark.filterByTag' },
            { label: 'Sync to Data', command: 'extensions-bookmark.syncToData' },
            { label: 'Sync from Data', command: 'extensions-bookmark.syncFromData' },
            { label: 'Import Data', command: 'extensions-bookmark.importData' },
            { label: 'Export Data', command: 'extensions-bookmark.exportData' },
            { label: 'Remove All Data', command: 'extensions-bookmark.removeAllData' }
        ];
        const selected = await vscode.window.showQuickPick(options, { placeHolder: 'Select an option' });
        if (selected) vscode.commands.executeCommand(selected.command);
    }));

    // Command to refresh the bookmark tree view (re-read from the store)
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.refresh', () => {
        bookmarkDataProvider.refresh();
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('extensionsBookmark.recentHours')) {
            bookmarkDataProvider.refresh();
        }
    }));

    // Cycle view modes: by-category → by-status → flat → by-category.
    async function setViewMode(mode) {
        bookmarkDataProvider.viewMode = mode;
        await store.update('viewMode', mode);
        await vscode.commands.executeCommand('setContext', 'extensions-bookmark.viewMode', mode);
        bookmarkDataProvider.refresh();
    }

    async function locateBookmark(bookmarkId) {
        const bookmarks = store.get('bookmarks', []);
        const bookmark = bookmarks.find(b => b.id === bookmarkId);
        if (!bookmark) return;

        if (bookmarkDataProvider.viewMode !== 'by-category') {
            await setViewMode('by-category');
        }

        const decorated = decorateBookmark(bookmark, computeInstalledSet());
        if (!passesFilter(decorated, bookmarkDataProvider.statusFilter, getRecentHours())) {
            bookmarkDataProvider.statusFilter = 'all';
            await store.update('statusFilter', 'all');
            bookmarkDataProvider.refresh();
            logInfo(`Changed filter to All to reveal ${bookmark.id}`);
        }

        await vscode.commands.executeCommand('extensionsBookmarkView.focus');
        const categoryItem = bookmarkDataProvider.getCategoryItem(bookmark.category);
        await bookmarkTreeView.reveal(categoryItem, { expand: true });
        const bookmarkItem = bookmarkDataProvider.getBookmarkItem(
            bookmark,
            undefined,
            `category:${bookmark.category}`
        );
        await bookmarkTreeView.reveal(bookmarkItem, { select: true, focus: true });
        detailsProvider.show(bookmark.id);
    }
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.switchToByStatus', () => setViewMode('by-status')));
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.switchToFlat', () => setViewMode('flat')));
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.switchToByCategory', () => setViewMode('by-category')));

    // Filter bookmarks by added time or install/wanted status.
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.filterStatus', async () => {
        const recentHours = getRecentHours();
        const recentUnit = recentHours === 1 ? 'hour' : 'hours';
        const options = [
            { label: `Added Recently (${recentHours} ${recentUnit})`, value: 'recent' },
            { label: 'All', value: 'all' },
            { label: 'Installed', value: 'installed' },
            { label: 'Expected to Uninstall', value: 'not-wanted' },
            { label: 'Diff Only (out of sync)', value: 'diff' }
        ];
        const picked = await vscode.window.showQuickPick(options, { placeHolder: 'Filter bookmarks' });
        if (!picked) return;
        bookmarkDataProvider.statusFilter = picked.value;
        store.update('statusFilter', picked.value);
        bookmarkDataProvider.refresh();
    }));

    // Toggle a bookmark's wantedInstall flag (wanted ↔ not wanted).
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.toggleWanted', (item) => {
        const id = item && item.command && item.command.arguments && item.command.arguments[0];
        if (!id) return;
        const bookmarks = store.get('bookmarks', []);
        const bookmark = bookmarks.find(b => b.id === id);
        if (!bookmark) return;
        bookmark.wantedInstall = bookmark.wantedInstall === false;
        store.update('bookmarks', bookmarks);
        bookmarkDataProvider.refresh();
        vscode.window.showInformationMessage(`${bookmark.displayName}: ${bookmark.wantedInstall === false ? 'not wanted' : 'wanted'}`);
    }));

    // Sync helpers — install/uninstall based on wantedInstall vs actual status.
    function isInstalled(id) {
        return vscode.extensions.all.some(e => e.id.toLowerCase() === String(id).toLowerCase());
    }

    async function applySync(bookmark) {
        const want = bookmark.wantedInstall !== false;
        const actual = isInstalled(bookmark.id);
        if (want && !actual) {
            await vscode.commands.executeCommand('workbench.extensions.installExtension', bookmark.id);
            return 'installed';
        }
        if (!want && actual) {
            await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', bookmark.id);
            return 'uninstalled';
        }
        return 'noop';
    }

    // Refresh progressively after an install/uninstall: vscode.extensions.all
    // updates asynchronously and can lag by several seconds, so a single
    // refresh leaves stale status (e.g. a "to remove" item stuck in Diff).
    function refreshAfterSync() {
        bookmarkDataProvider.refresh();
        [1000, 2000, 4000].forEach(ms => setTimeout(() => bookmarkDataProvider.refresh(), ms));
    }

    // Sync a single bookmark from its context menu.
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.syncExtension', async (item) => {
        const id = item && item.command && item.command.arguments && item.command.arguments[0];
        if (!id) return;
        const bookmark = store.get('bookmarks', []).find(b => b.id === id);
        if (!bookmark) return;
        try {
            const result = await applySync(bookmark);
            if (result === 'noop') {
                vscode.window.showInformationMessage(`${bookmark.displayName}: already in sync`);
            } else if (result === 'uninstalled') {
                // Uninstall may not fully reflect until the window reloads.
                const reload = 'Reload Window';
                const choice = await vscode.window.showInformationMessage(
                    `${bookmark.displayName}: uninstalled. Reload window to fully apply?`, reload);
                if (choice === reload) {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            } else {
                vscode.window.showInformationMessage(`${bookmark.displayName}: ${result}`);
            }
            refreshAfterSync();
        } catch (e) {
            vscode.window.showErrorMessage(`Sync failed for ${bookmark.displayName}: ${e.message || e}`);
        }
    }));

    // Sync to Data: write current actual install state into data.json.
    // Each bookmark's wantedInstall = whether it is currently installed.
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.syncToData', async () => {
        const bookmarks = store.get('bookmarks', []);
        let installedCount = 0;
        for (const bm of bookmarks) {
            const actual = isInstalled(bm.id);
            bm.wantedInstall = actual;
            if (actual) installedCount++;
        }
        store.update('bookmarks', bookmarks);
        bookmarkDataProvider.refresh();
        vscode.window.showInformationMessage(
            `Synced to data: ${installedCount}/${bookmarks.length} installed.`
        );
    }));

    // Sync from Data: install/uninstall to match data.json's wantedInstall.
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.syncFromData', async () => {
        const bookmarks = store.get('bookmarks', []);
        const needInstall = [];
        const needUninstall = [];
        for (const bm of bookmarks) {
            const want = bm.wantedInstall !== false;
            const actual = isInstalled(bm.id);
            if (want && !actual) needInstall.push(bm);
            if (!want && actual) needUninstall.push(bm);
        }
        const total = needInstall.length + needUninstall.length;
        if (total === 0) {
            vscode.window.showInformationMessage('Everything is in sync.');
            return;
        }
        let done = 0, failed = 0;
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Syncing extensions', cancellable: false },
            async (progress) => {
                const run = async (bm, action) => {
                    progress.report({ increment: (1 / total) * 100, message: `${action} ${bm.displayName}…` });
                    try {
                        await applySync(bm);
                    } catch (e) {
                        failed++;
                        console.warn(`[extensions-bookmark] sync ${action} failed for ${bm.id}:`, e);
                    }
                    done++;
                };
                // Install all first, then uninstall (re-checking state each time).
                for (const bm of needInstall) await run(bm, 'Installing');
                for (const bm of needUninstall) await run(bm, 'Removing');
            }
        );
        const msg = `Sync complete: ${done - failed}/${total} ok${failed ? `, ${failed} failed` : ''}.`;
        if (needUninstall.length > 0) {
            // Uninstalls may not fully reflect until the window reloads.
            const reload = 'Reload Window';
            const choice = await vscode.window.showInformationMessage(`${msg} Reload window to fully apply uninstalls?`, reload);
            if (choice === reload) {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        } else {
            vscode.window.showInformationMessage(msg);
        }
        refreshAfterSync();
    }));

    // Command to add a bookmark
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.addBookmark', async () => {
        const categories = store.get('categories', []);
        const bookmarks = store.get('bookmarks', []);
        const input = await vscode.window.showInputBox({
            prompt: 'Enter the identifier of the extension (publisher.extensionname)'
        });
        const selectedExtension = input?.trim();
        if (!selectedExtension) return;

        const parsed = parseExtensionIds(selectedExtension);
        if (parsed.ids.length !== 1 || parsed.invalid.length > 0) {
            vscode.window.showWarningMessage(`Invalid extension ID: ${selectedExtension}`);
            return;
        }
        if (bookmarks.some(bookmark => bookmark.id.toLowerCase() === selectedExtension.toLowerCase())) {
            vscode.window.showInformationMessage(`Bookmark ${selectedExtension} already exists.`);
            return;
        }

        const sortedCategories = categories.slice().sort((a, b) => {
            if (a === 'Default') return -1;
            if (b === 'Default') return 1;
            return a.localeCompare(b);
        });
        const selectedCategory = await vscode.window.showQuickPick(sortedCategories, {
            placeHolder: 'Select a category for the bookmark'
        });
        if (!selectedCategory) return;

        try {
            const bookmark = await fetchMarketplaceBookmark(selectedExtension, selectedCategory);
            if (!bookmark) {
                vscode.window.showErrorMessage(`Extension ${selectedExtension} not found.`);
                return;
            }
            bookmarks.push(bookmark);
            await store.update('bookmarks', bookmarks, vscode.ConfigurationTarget.Global);
            bookmarkDataProvider.refresh();
            vscode.window.showInformationMessage(`Extension ${selectedExtension} has been bookmarked.`);
        } catch (error) {
            logError(`Failed to add bookmark ${selectedExtension}`, error);
            vscode.window.showErrorMessage(`Failed to add bookmark for ${selectedExtension}: ${error}`);
        }
    }));

    // Bookmark an installed extension surfaced via the Diff bucket (🆕).
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.addExtraToBookmarks', async (itemOrId) => {
        // Context-menu invocations pass the TreeItem; click invocations pass
        // the id string directly. Normalize to the extension id.
        const extensionId = typeof itemOrId === 'string'
            ? itemOrId
            : itemOrId?.command?.arguments?.[0] || itemOrId?.bookmarkId;
        if (!extensionId) return;
        const categories = store.get('categories', []);
        const bookmarks = store.get('bookmarks', []);
        if (bookmarks.some(bookmark => String(bookmark.id).toLowerCase() === extensionId.toLowerCase())) {
            vscode.window.showInformationMessage(`Bookmark ${extensionId} already exists.`);
            return;
        }
        const sortedCategories = categories.slice().sort((a, b) => {
            if (a === 'Default') return -1;
            if (b === 'Default') return 1;
            return a.localeCompare(b);
        });
        const selectedCategory = await vscode.window.showQuickPick(sortedCategories, {
            placeHolder: `Select a category for ${extensionId}`
        });
        if (!selectedCategory) return;
        try {
            // Prefer Marketplace data (downloads/rating); fall back to local
            // metadata so private/unpublished extensions still bookmark.
            let bookmark = null;
            try {
                bookmark = await fetchMarketplaceBookmark(extensionId, selectedCategory);
            } catch (marketError) {
                logError(`Marketplace lookup failed for ${extensionId}, using local data`, marketError);
            }
            if (!bookmark) bookmark = buildBookmarkFromLocal(extensionId, selectedCategory);
            bookmarks.push(bookmark);
            await store.update('bookmarks', bookmarks, vscode.ConfigurationTarget.Global);
            bookmarkDataProvider.refresh();
            vscode.window.showInformationMessage(`Extension ${extensionId} has been bookmarked.`);
        } catch (error) {
            logError(`Failed to add bookmark ${extensionId}`, error);
            vscode.window.showErrorMessage(`Failed to add bookmark for ${extensionId}: ${error?.message || error}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.addFromList', async () => {
        const clipboard = await vscode.env.clipboard.readText();
        const clipboardItems = parseExtensionIds(clipboard);
        let input;

        if (clipboardItems.ids.length > 0) {
            const source = await vscode.window.showQuickPick([
                {
                    label: `Use Clipboard (${clipboardItems.ids.length} IDs)`,
                    value: 'clipboard',
                    description: clipboardItems.ids.slice(0, 3).join(', ')
                },
                {
                    label: 'Enter IDs',
                    value: 'manual',
                    description: 'Separate IDs with spaces, commas, or semicolons'
                }
            ], { placeHolder: 'Choose the extension list source' });
            if (!source) return;
            input = source.value === 'clipboard'
                ? clipboard
                : await vscode.window.showInputBox({
                    prompt: 'Enter extension IDs separated by spaces, commas, or semicolons'
                });
        } else {
            input = await vscode.window.showInputBox({
                prompt: 'Enter extension IDs separated by spaces, commas, or semicolons'
            });
        }
        if (!input) return;

        const { ids, invalid } = parseExtensionIds(input);
        if (ids.length === 0) {
            vscode.window.showWarningMessage('No valid extension IDs found.');
            return;
        }

        const bookmarks = store.get('bookmarks', []);
        const existing = new Set(bookmarks.map(bookmark => String(bookmark.id).toLowerCase()));
        const skipped = ids.filter(id => existing.has(id.toLowerCase()));
        const pending = ids.filter(id => !existing.has(id.toLowerCase()));
        const added = [];
        const failed = [...invalid];
        const notify = () => {
            const examples = skipped.slice(0, 3).join(', ');
            const more = skipped.length > 3 ? `, +${skipped.length - 3} more` : '';
            const skippedDetails = examples ? ` Skipped: ${examples}${more}.` : '';
            const summary = `Added ${added.length}, skipped ${skipped.length} existing, failed ${failed.length}.${skippedDetails}`;
            if (failed.length > 0) {
                vscode.window.showWarningMessage(summary);
            } else {
                vscode.window.showInformationMessage(summary);
            }
        };
        if (pending.length === 0) {
            notify();
            return;
        }

        const categories = store.get('categories', []);
        const sortedCategories = categories.slice().sort((a, b) => {
            if (a === 'Default') return -1;
            if (b === 'Default') return 1;
            return a.localeCompare(b);
        });
        const category = await vscode.window.showQuickPick(sortedCategories, {
            placeHolder: 'Select a category for the bookmarks'
        });
        if (!category) return;

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Adding bookmarks from list',
                cancellable: false
            },
            async progress => {
                for (let index = 0; index < pending.length; index++) {
                    const id = pending[index];
                    progress.report({
                        increment: pending.length ? 100 / pending.length : 100,
                        message: `${index + 1}/${pending.length}: ${id}`
                    });
                    try {
                        const bookmark = await fetchMarketplaceBookmark(id, category);
                        if (bookmark) {
                            bookmarks.push(bookmark);
                            added.push(id);
                        } else {
                            failed.push(id);
                        }
                    } catch (error) {
                        logError(`Failed to add bookmark ${id}`, error);
                        failed.push(id);
                    }
                }
            }
        );

        if (added.length > 0) {
            await store.update('bookmarks', bookmarks, vscode.ConfigurationTarget.Global);
            bookmarkDataProvider.refresh();
        }

        notify();
    }));

    // Command to view all bookmarks
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.viewBookmarks', async () => {
        const bookmarks = store.get('bookmarks', []);
        const sortedBookmarks = bookmarks.sort((a, b) => a.displayName.localeCompare(b.displayName));
        const selectedBookmark = await vscode.window.showQuickPick(sortedBookmarks.map(bookmark => bookmark.displayName), { placeHolder: 'Select a bookmark to view details' });
        if (selectedBookmark) {
            const selectedBookmarkId = sortedBookmarks.find(bookmark => bookmark.displayName === selectedBookmark).id;
            vscode.commands.executeCommand('workbench.extensions.search', selectedBookmarkId);
        }
    }));

    // Command to open a bookmarked extension in the Extensions view
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.openExtension', (itemOrId) => {
        const extensionId = typeof itemOrId === 'string' ? itemOrId : itemOrId?.bookmarkId;
        if (extensionId) vscode.commands.executeCommand('extension.open', extensionId);
    }));

    // Show the details card for a bookmark (single click + viewDetails).
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.showDetails', (extensionId) => {
        if (extensionId) detailsProvider.show(extensionId);
    }));

    // Command to remove a bookmark
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.removeBookmark', async (item) => {
        const bookmarks = store.get('bookmarks', []);
        let bookmark;
        if (item) {
            bookmark = bookmarks.find(bookmark => bookmark.id === item.command.arguments[0]);
        } else {
            const sortedBookmarks = bookmarks.sort((a, b) => a.displayName.localeCompare(b.displayName));
            const selectedBookmark = await vscode.window.showQuickPick(sortedBookmarks.map(bookmark => bookmark.displayName), { placeHolder: 'Select a bookmark to remove' });
            bookmark = bookmarks.find(bookmark => bookmark.displayName === selectedBookmark);
        }
        if (bookmark) {
            const index = bookmarks.indexOf(bookmark);
            bookmarks.splice(index, 1);
            await store.update('bookmarks', bookmarks, vscode.ConfigurationTarget.Global);
            bookmarkDataProvider.refresh();
            vscode.window.showInformationMessage(`Bookmark ${bookmark.displayName} has been removed.`);
        }
    }));

    // Command to add a category
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.addCategory', async () => {
        const categories = store.get('categories', []);
        const quickPick = vscode.window.createQuickPick();
        quickPick.items = categories.sort().map(category => ({ label: category }));
        quickPick.placeholder = 'Enter a new category';
        quickPick.onDidChangeValue(value => {
            if (value && !categories.map(category => category.toLowerCase()).includes(value.toLowerCase())) {
                quickPick.items = [{ label: value }, ...categories.sort().map(category => ({ label: category }))];
            } else {
                quickPick.items = categories.sort((a, b) => {
                    if (a === 'Default') return -1;
                    if (b === 'Default') return 1;
                    return a.localeCompare(b);
                }).map(category => ({ label: category }));
            }
        });
        quickPick.onDidAccept(async () => {
            const newCategory = quickPick.value;
            if (newCategory && newCategory.trim() !== '' && !categories.map(category => category.toLowerCase()).includes(newCategory.toLowerCase())) {
                categories.push(newCategory);
                await store.update('categories', categories, vscode.ConfigurationTarget.Global);
                bookmarkDataProvider.refresh();
                vscode.window.showInformationMessage(`Category ${newCategory} has been added.`);
            } else if (newCategory && newCategory.trim() !== '') {
                vscode.window.showErrorMessage(`Category ${newCategory} already exists.`);
            }
            quickPick.hide();
        });
        quickPick.show();
    }));

    // Command to rename a category
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.renameCategory', async (item) => {
        let categories = store.get('categories', []);
        const bookmarks = store.get('bookmarks', []);
        let selectedCategory;

        // Sort categories alphabetically, but keep 'Default' at the top
        categories = categories.sort((a, b) => {
            if (a === 'Default') return -1;
            if (b === 'Default') return 1;
            return a.localeCompare(b);
        });

        if (item) {
            selectedCategory = item.label;
        } else {
            selectedCategory = await vscode.window.showQuickPick(categories, { placeHolder: 'Select a category to rename' });
        }

        if (selectedCategory) {
            const quickPick = vscode.window.createQuickPick();
            quickPick.items = categories.map(category => ({ label: category }));
            quickPick.value = selectedCategory;
            quickPick.placeholder = 'Enter the new name of the category';
            quickPick.onDidChangeValue(value => {
                if (value && !categories.filter(category => category.toLowerCase() !== selectedCategory.toLowerCase()).map(category => category.toLowerCase()).includes(value.toLowerCase())) {
                    quickPick.items = [{ label: value }, ...categories.map(category => ({ label: category }))];
                } else {
                    quickPick.items = categories.map(category => ({ label: category }));
                }
            });
            quickPick.onDidAccept(async () => {
                const newCategoryName = quickPick.value;
                if (newCategoryName && newCategoryName.trim() !== '' && newCategoryName !== selectedCategory && (!categories.filter(category => category.toLowerCase() !== selectedCategory.toLowerCase()).map(category => category.toLowerCase()).includes(newCategoryName.toLowerCase()))) {
                    const index = categories.indexOf(selectedCategory);
                    if (index > -1) {
                        categories[index] = newCategoryName;
                        bookmarks.forEach(bookmark => {
                            if (bookmark.category === selectedCategory) {
                                bookmark.category = newCategoryName;
                            }
                        });
                        await store.update('categories', categories, vscode.ConfigurationTarget.Global);
                        await store.update('bookmarks', bookmarks, vscode.ConfigurationTarget.Global);
                        bookmarkDataProvider.refresh();
                        vscode.window.showInformationMessage(`Category ${selectedCategory} has been renamed to ${newCategoryName}.`);
                    }
                } else if (newCategoryName && newCategoryName.trim() !== '') {
                    if (newCategoryName === selectedCategory) {
                        vscode.window.showErrorMessage(`New category name cannot be the same as the old name.`);
                    } else {
                        vscode.window.showErrorMessage(`Category ${newCategoryName} already exists.`);
                    }
                }
                quickPick.hide();
            });
            quickPick.show();
        }
    }));

    // Command to remove a category
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.removeCategory', async (item) => {
        const categories = store.get('categories', []);
        const bookmarks = store.get('bookmarks', []);
        let selectedCategory;

        // Sort categories alphabetically, but keep 'Default' at the top
        const sortedCategories = categories.sort((a, b) => {
            if (a === 'Default') return -1;
            if (b === 'Default') return 1;
            return a.localeCompare(b);
        });

        if (item) {
            selectedCategory = item.label;
        } else {
            selectedCategory = await vscode.window.showQuickPick(sortedCategories, { placeHolder: 'Select a category to remove' });
        }

        if (selectedCategory) {
            const index = categories.indexOf(selectedCategory);
            if (index > -1) {
                categories.splice(index, 1);
                const bookmarksToReassign = bookmarks.filter(bookmark => bookmark.category === selectedCategory);
                bookmarksToReassign.forEach(bookmark => {
                    const bookmarkIndex = bookmarks.indexOf(bookmark);
                    bookmarks[bookmarkIndex].category = "Default"; // Reassign the category to "Default"
                });
                await store.update('categories', categories, vscode.ConfigurationTarget.Global);
                await store.update('bookmarks', bookmarks, vscode.ConfigurationTarget.Global);
                bookmarkDataProvider.refresh();
                if (bookmarksToReassign.length > 0) {
                    vscode.window.showInformationMessage(`Category ${selectedCategory} has been removed and its bookmarks have been moved to the Default category.`);
                } else {
                    vscode.window.showInformationMessage(`Category ${selectedCategory} has been removed.`);
                }
            }
        }
    }));

    // Command to move a bookmark
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.moveBookmark', async (item) => {
        const categories = store.get('categories', []);
        const bookmarks = store.get('bookmarks', []);
        let bookmark;
        if (item) {
            bookmark = bookmarks.find(bookmark => bookmark.id === item.command.arguments[0]);
        } else {
            const selectedBookmark = await vscode.window.showQuickPick(bookmarks.map(bookmark => bookmark.displayName), { placeHolder: 'Select a bookmark to move' });
            bookmark = bookmarks.find(bookmark => bookmark.displayName === selectedBookmark);
        }
        if (bookmark) {
            // Sort categories alphabetically, but keep 'Default' at the top
            const sortedCategories = categories.sort((a, b) => {
                if (a === 'Default') return -1;
                if (b === 'Default') return 1;
                return a.localeCompare(b);
            }).filter(category => category !== bookmark.category); // Exclude current category of the bookmark
            // Check if there are any categories other than the current category of the bookmark
            if (sortedCategories.length < 1) {
                vscode.window.showInformationMessage(`There are no other categories to move ${bookmark.displayName} to.`);
                return;
            }
            const selectedCategory = await vscode.window.showQuickPick(sortedCategories, { placeHolder: 'Select a new category for the bookmark' });
            if (selectedCategory) {
                bookmark.category = selectedCategory;
                await store.update('bookmarks', bookmarks, vscode.ConfigurationTarget.Global);
                bookmarkDataProvider.refresh();
                vscode.window.showInformationMessage(`Bookmark ${bookmark.displayName} has been moved to ${selectedCategory}.`);
            }
        }
    }));

    // Command to search bookmarks
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.searchBookmarks', async () => {
        const bookmarks = store.get('bookmarks', []);
        const quickPick = vscode.window.createQuickPick();
        const toItem = bookmark => ({
            label: bookmark.displayName,
            description: bookmark.id,
            bookmarkId: bookmark.id
        });
        quickPick.items = bookmarks.slice()
            .sort((a, b) => a.displayName.localeCompare(b.displayName))
            .map(toItem);
        quickPick.placeholder = 'Enter a bookmark name or select an existing one';
        quickPick.onDidChangeValue(value => {
            if (value) {
                quickPick.items = bookmarks.filter(bookmark => bookmark.displayName.toLowerCase().includes(value.toLowerCase()))
                    .sort((a, b) => a.displayName.localeCompare(b.displayName))
                    .map(toItem);
            } else {
                quickPick.items = bookmarks.slice()
                    .sort((a, b) => a.displayName.localeCompare(b.displayName))
                    .map(toItem);
            }
        });
        quickPick.onDidAccept(async () => {
            const selectedBookmark = quickPick.selectedItems[0];
            if (selectedBookmark) {
                logInfo(`Opening local details from search: ${selectedBookmark.bookmarkId}`);
                try {
                    await locateBookmark(selectedBookmark.bookmarkId);
                } catch (error) {
                    logError(`Failed to locate bookmark ${selectedBookmark.bookmarkId}`, error);
                    detailsProvider.show(selectedBookmark.bookmarkId);
                }
            }
            quickPick.hide();
        });
        quickPick.show();
    }));

    // Command to add a tag to list
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.addTagToList', async () => {
        const tags = store.get('tags', []);
        const quickPick = vscode.window.createQuickPick();
        quickPick.items = tags.sort().map(tag => ({ label: tag }));
        quickPick.placeholder = 'Enter a new tag';
        quickPick.onDidChangeValue(value => {
            if (value && !tags.includes(value.toLowerCase())) {
                quickPick.items = [{ label: value }, ...tags.sort().map(tag => ({ label: tag }))];
            } else {
                quickPick.items = tags.sort().map(tag => ({ label: tag }));
            }
        });
        quickPick.onDidAccept(() => {
            const newTag = quickPick.value;
            if (newTag && newTag.trim() !== '' && !tags.includes(newTag.toLowerCase())) {
                tags.push(newTag.toLowerCase());
                store.update('tags', tags, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Tag ${newTag} has been added.`);
            } else if (newTag && newTag.trim() !== '') {
                vscode.window.showErrorMessage(`Tag ${newTag} already exists.`);
            }
            quickPick.hide();
        });
        quickPick.show();
    }));

    // Command to rename a tag in the list
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.renameTagInList', async () => {
        const tags = store.get('tags', []);
        const bookmarks = store.get('bookmarks', []);
        if (tags.length > 0) {
            const selectedTagToRename = await vscode.window.showQuickPick(tags.sort(), { placeHolder: 'Select a tag to rename' });
            if (selectedTagToRename) {
                const quickPick = vscode.window.createQuickPick();
                quickPick.items = tags.map(tag => ({ label: tag }));
                quickPick.value = selectedTagToRename;
                quickPick.placeholder = 'Enter a new name for the tag';
                quickPick.onDidChangeValue(value => {
                    if (value && !tags.map(tag => tag.toLowerCase()).includes(value.toLowerCase())) {
                        quickPick.items = [{ label: value }, ...tags.map(tag => ({ label: tag }))];
                    } else {
                        quickPick.items = tags.map(tag => ({ label: tag }));
                    }
                });
                quickPick.onDidAccept(async () => {
                    const newTagName = quickPick.value;
                    if (newTagName && newTagName.trim() !== '' && !tags.map(tag => tag.toLowerCase()).includes(newTagName.toLowerCase())) {
                        const index = tags.indexOf(selectedTagToRename);
                        if (index > -1) {
                            tags[index] = newTagName.toLowerCase();
                            bookmarks.forEach(bookmark => {
                                if (bookmark.tags) {
                                    const tagIndex = bookmark.tags.indexOf(selectedTagToRename);
                                    if (tagIndex > -1) {
                                        bookmark.tags[tagIndex] = newTagName.toLowerCase();
                                    }
                                }
                            });
                            await store.update('tags', tags, vscode.ConfigurationTarget.Global);
                            await store.update('bookmarks', bookmarks, vscode.ConfigurationTarget.Global);
                            bookmarkDataProvider.refresh(); // Refresh the TreeView
                            vscode.window.showInformationMessage(`Tag ${selectedTagToRename} has been renamed to ${newTagName}.`);
                        }
                    } else if (newTagName && newTagName.trim() !== '') {
                        vscode.window.showErrorMessage(`Tag ${newTagName} already exists.`);
                    }
                    quickPick.hide();
                });
                quickPick.show();
            }
        } else {
            vscode.window.showInformationMessage(`There are no tags in the list.`);
        }
    }));

    // Command to remove a tag from list
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.removeTagFromList', async () => {
        const tags = store.get('tags', []);
        const bookmarks = store.get('bookmarks', []);
        if (tags.length > 0) {
            // Sort the tags in A-Z order
            const sortedTags = tags.sort();
            const selectedTagToRemove = await vscode.window.showQuickPick(sortedTags, { placeHolder: 'Select a tag to remove' });
            if (selectedTagToRemove) {
                const index = sortedTags.indexOf(selectedTagToRemove);
                if (index > -1) {
                    sortedTags.splice(index, 1);
                    bookmarks.forEach(bookmark => {
                        if (bookmark.tags) {
                            const tagIndex = bookmark.tags.indexOf(selectedTagToRemove);
                            if (tagIndex > -1) {
                                bookmark.tags.splice(tagIndex, 1);
                            }
                        }
                    });
                    await store.update('tags', sortedTags, vscode.ConfigurationTarget.Global);
                    await store.update('bookmarks', bookmarks, vscode.ConfigurationTarget.Global);
                    bookmarkDataProvider.refresh(); // Refresh the TreeView
                    vscode.window.showInformationMessage(`Tag ${selectedTagToRemove} has been removed.`);
                }
            }
        } else {
            vscode.window.showInformationMessage(`There are no tags in the list.`);
        }
    }));

    // Command to add a tag to a bookmark
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.addTagToBookmark', async (item) => {
        const bookmarks = store.get('bookmarks', []);
        const tags = store.get('tags', []);
        let bookmark;
        if (item) {
            bookmark = bookmarks.find(bookmark => bookmark.id === item.command.arguments[0]);
        } else {
            const sortedBookmarks = bookmarks.sort((a, b) => a.displayName.localeCompare(b.displayName)); // Sort bookmarks A-Z
            const selectedBookmark = await vscode.window.showQuickPick(sortedBookmarks.map(bookmark => bookmark.displayName), { placeHolder: 'Select a bookmark to add a tag' });
            bookmark = bookmarks.find(bookmark => bookmark.displayName === selectedBookmark);
        }
        if (bookmark) {
            bookmark.tags = bookmark.tags || [];
            const availableTags = tags.filter(tag => !bookmark.tags.includes(tag)).sort(); // Exclude tags that are already added to the bookmark and sort them
            if (availableTags.length > 0) {
                const selectedTag = await vscode.window.showQuickPick(availableTags, { placeHolder: 'Select a tag to add' });
                if (selectedTag) {
                    bookmark.tags.push(selectedTag);
                    await store.update('bookmarks', bookmarks, vscode.ConfigurationTarget.Global);
                    bookmarkDataProvider.refresh(); // Refresh the TreeView
                    vscode.window.showInformationMessage(`Tag ${selectedTag} has been added to ${bookmark.displayName}.`);
                }
            } else {
                if (tags.length === 0) {
                    vscode.window.showInformationMessage(`No tags available to add to ${bookmark.displayName}.`);
                } else {
                    vscode.window.showInformationMessage(`All tags are already added to ${bookmark.displayName}.`);
                }
            }
        }
    }));

    // Command to remove a tag from a bookmark
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.removeTagFromBookmark', async (item) => {
        const bookmarks = store.get('bookmarks', []);
        let bookmark;
        if (item) {
            bookmark = bookmarks.find(bookmark => bookmark.id === item.command.arguments[0]);
        } else {
            const sortedBookmarks = bookmarks.sort((a, b) => a.displayName.localeCompare(b.displayName)); // Sort bookmarks A-Z
            const selectedBookmark = await vscode.window.showQuickPick(sortedBookmarks.map(bookmark => bookmark.displayName), { placeHolder: 'Select a bookmark to remove a tag' });
            bookmark = bookmarks.find(bookmark => bookmark.displayName === selectedBookmark);
        }
        if (bookmark && bookmark.tags && bookmark.tags.length > 0) {
            const sortedTags = bookmark.tags.sort(); // Sort tags A-Z
            const selectedTag = await vscode.window.showQuickPick(sortedTags, { placeHolder: 'Select a tag to remove' });
            if (selectedTag) {
                const index = bookmark.tags.indexOf(selectedTag);
                bookmark.tags.splice(index, 1);
                await store.update('bookmarks', bookmarks, vscode.ConfigurationTarget.Global);
                bookmarkDataProvider.refresh(); // Refresh the TreeView
                vscode.window.showInformationMessage(`Tag ${selectedTag} has been removed from ${bookmark.displayName}.`);
            }
        } else {
            vscode.window.showInformationMessage(`Bookmark ${bookmark.displayName} does not have any tags.`);
        }
    }));

    // Command to filter bookmarks by tag
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.filterByTag', async () => {
        const bookmarks = store.get('bookmarks', []);
        const allTags = [...new Set(bookmarks.flatMap(bookmark => bookmark.tags || []))];
        const sortedTags = allTags.sort((a, b) => a.localeCompare(b));

        if (allTags.length === 0) {
            vscode.window.showInformationMessage('No tags found.');
            return;
        }

        const selectedTag = await vscode.window.showQuickPick(sortedTags, { placeHolder: 'Select a tag to filter by' });
        if (selectedTag) {
            const filteredBookmarks = bookmarks.filter(bookmark => bookmark.tags && bookmark.tags.includes(selectedTag));
            const sortedFilteredBookmarks = filteredBookmarks.sort((a, b) => a.displayName.localeCompare(b.displayName));
            vscode.window.showQuickPick(sortedFilteredBookmarks.map(bookmark => bookmark.displayName), { placeHolder: 'Select a bookmark to view details' })
                .then(selectedBookmark => {
                    if (selectedBookmark) {
                        const selectedBookmarkId = sortedFilteredBookmarks.find(bookmark => bookmark.displayName === selectedBookmark).id;
                        vscode.commands.executeCommand('workbench.extensions.search', `${selectedBookmarkId}`);
                    }
                });
        }
    }));

    // Command to change the sorting option
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.sortBookmarks', async () => {
        const options = ['A-Z', 'Z-A', 'New-Old', 'Old-New'];
        const selectedOption = await vscode.window.showQuickPick(options, { placeHolder: 'Select a sorting option' });
        if (selectedOption) {
            await store.update('sortingOption', selectedOption, vscode.ConfigurationTarget.Global);
            bookmarkDataProvider.refresh();
            vscode.window.showInformationMessage(`Sorting option has been changed to ${selectedOption}.`);
        }
    }));

    // Command to add a note to a bookmark
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.addNote', async (item) => {
        const bookmarks = store.get('bookmarks', []);
        let bookmark;
        if (item) {
            bookmark = bookmarks.find(bookmark => bookmark.id === item.command.arguments[0]);
        } else {
            const sortedBookmarks = bookmarks.sort((a, b) => a.displayName.localeCompare(b.displayName)); // Sort bookmarks A-Z
            const selectedBookmark = await vscode.window.showQuickPick(sortedBookmarks.map(bookmark => bookmark.displayName), { placeHolder: 'Select a bookmark to add a note' });
            bookmark = bookmarks.find(bookmark => bookmark.displayName === selectedBookmark);
        }
        if (bookmark) {
            if (bookmark.note) {
                vscode.window.showInformationMessage(`Bookmark ${bookmark.displayName} already has a note.`);
            } else {
                const newNote = await vscode.window.showInputBox({ prompt: 'Enter the note for the bookmark' });
                if (newNote) {
                    bookmark.note = newNote;
                    await store.update('bookmarks', bookmarks, vscode.ConfigurationTarget.Global);
                    bookmarkDataProvider.refresh();
                    vscode.window.showInformationMessage(`Note has been added to ${bookmark.displayName}.`);
                }
            }
        }
    }));

    // Command to edit a note of a bookmark
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.editNote', async (item) => {
        const bookmarks = store.get('bookmarks', []);
        let bookmark;
        if (item) {
            bookmark = bookmarks.find(bookmark => bookmark.id === item.command.arguments[0]);
        } else {
            const sortedBookmarks = bookmarks.sort((a, b) => a.displayName.localeCompare(b.displayName)); // Sort bookmarks A-Z
            const selectedBookmark = await vscode.window.showQuickPick(sortedBookmarks.map(bookmark => bookmark.displayName), { placeHolder: 'Select a bookmark to edit a note' });
            bookmark = bookmarks.find(bookmark => bookmark.displayName === selectedBookmark);
        }
        if (bookmark) {
            if (bookmark.note) {
                const newNote = await vscode.window.showInputBox({ prompt: 'Enter the new note for the bookmark', value: bookmark.note });
                if (newNote) {
                    bookmark.note = newNote;
                    await store.update('bookmarks', bookmarks, vscode.ConfigurationTarget.Global);
                    bookmarkDataProvider.refresh();
                    vscode.window.showInformationMessage(`Note has been updated for ${bookmark.displayName}.`);
                }
            } else {
                vscode.window.showInformationMessage(`Bookmark ${bookmark.displayName} does not have a note to edit.`);
            }
        }
    }));

    // Command to remove a note from a bookmark
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.removeNote', async (item) => {
        const bookmarks = store.get('bookmarks', []);
        let bookmark;
        if (item) {
            bookmark = bookmarks.find(bookmark => bookmark.id === item.command.arguments[0]);
        } else {
            const sortedBookmarks = bookmarks.sort((a, b) => a.displayName.localeCompare(b.displayName)); // Sort bookmarks A-Z
            const selectedBookmark = await vscode.window.showQuickPick(sortedBookmarks.map(bookmark => bookmark.displayName), { placeHolder: 'Select a bookmark to remove a note' });
            bookmark = bookmarks.find(bookmark => bookmark.displayName === selectedBookmark);
        }
        if (bookmark) {
            if (bookmark.note) {
                delete bookmark.note;
                await store.update('bookmarks', bookmarks, vscode.ConfigurationTarget.Global);
                bookmarkDataProvider.refresh();
                vscode.window.showInformationMessage(`Note has been removed from ${bookmark.displayName}.`);
            } else {
                vscode.window.showInformationMessage(`Bookmark ${bookmark.displayName} does not have a note.`);
            }
        }
    }));

    // Command to view a bookmark's details - text document
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.viewDetails', async (item) => {
        const bookmarks = store.get('bookmarks', []);
        let id;
        if (item) {
            id = item.command.arguments[0];
        } else {
            const sortedBookmarks = bookmarks.slice().sort((a, b) => a.displayName.localeCompare(b.displayName)); // Sort bookmarks A-Z
            const selectedBookmark = await vscode.window.showQuickPick(sortedBookmarks.map(bookmark => bookmark.displayName), { placeHolder: 'Select a bookmark to view details' });
            const bookmark = bookmarks.find(bookmark => bookmark.displayName === selectedBookmark);
            id = bookmark && bookmark.id;
        }
        if (id) detailsProvider.show(id);
    }));

    // Command to import data
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.importData', async () => {
        const filePath = await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(vscode.workspace.rootPath), canSelectMany: false, filters: { 'JSON': ['json'] } });
        if (filePath && filePath[0]) {
            fs.readFile(filePath[0].fsPath, (err, data) => {
                if (err) {
                    vscode.window.showErrorMessage(`Failed to import data: ${err}`);
                } else {
                    try {
                        const parsedData = JSON.parse(data);
                        if (!parsedData || typeof parsedData !== 'object' || Array.isArray(parsedData) || !parsedData.categories || !parsedData.bookmarks || !parsedData.tags) {
                            vscode.window.showErrorMessage('Invalid data structure. The file should contain an object with "categories", "bookmarks", and "tags" arrays.');
                            return;
                        }
                        const { categories: importedCategories, bookmarks: importedBookmarks, tags: importedTags } = parsedData;
                        if (!Array.isArray(importedCategories) || !Array.isArray(importedBookmarks) || !Array.isArray(importedTags)) {
                            vscode.window.showErrorMessage('Invalid data structure. "categories", "bookmarks", and "tags" should be arrays.');
                            return;
                        }
                        const existingCategories = store.get('categories', []);
                        const existingBookmarks = store.get('bookmarks', []);
                        const existingTags = store.get('tags', []);

                        // Merge categories, bookmarks, and tags, removing duplicates
                        const mergedCategories = [...new Set([...existingCategories, ...importedCategories])];
                        const mergedBookmarks = [...existingBookmarks, ...importedBookmarks.filter((importedBookmark) =>
                            !existingBookmarks.some(existingBookmark => existingBookmark.id === importedBookmark.id)
                        )];
                        const mergedTags = [...new Set([...existingTags, ...importedTags])];

                        Promise.all([
                            store.update('categories', mergedCategories, vscode.ConfigurationTarget.Global),
                            store.update('bookmarks', mergedBookmarks, vscode.ConfigurationTarget.Global),
                            store.update('tags', mergedTags, vscode.ConfigurationTarget.Global) // Update tags
                        ]).then(() => {
                            bookmarkDataProvider.refresh(); // Refresh the data provider
                            vscode.window.showInformationMessage(`Data has been imported from ${filePath[0].fsPath}`);
                        }).catch(err => {
                            vscode.window.showErrorMessage(`Failed to update data: ${err}`);
                        });
                    } catch (err) {
                        vscode.window.showErrorMessage(`Failed to parse data: ${err}`);
                    }
                }
            });
        }
    }));

    // Command to export data
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.exportData', async () => {
        const categories = store.get('categories', []);
        const bookmarks = store.get('bookmarks', []);
        const tags = store.get('tags', []);
        if ((categories.length === 1 && categories[0] === 'Default') && bookmarks.length === 0 && tags.length === 0) {
            vscode.window.showInformationMessage('No data to export.');
            return;
        }
        const data = { categories, bookmarks, tags };
        const filePath = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(vscode.workspace.rootPath, 'extensions-bookmark-data.json')) });
        if (filePath) {
            fs.writeFile(filePath.fsPath, JSON.stringify(data, null, 2), (err) => {
                if (err) {
                    vscode.window.showErrorMessage(`Failed to export data: ${err}`);
                } else {
                    vscode.window.showInformationMessage(`Data has been exported to ${filePath.fsPath}`);
                }
            });
        }
    }));

    // Command to remove all data
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.removeAllData', async () => {
        const categories = store.get('categories', []);
        const bookmarks = store.get('bookmarks', []);
        const tags = store.get('tags', []);
        if ((categories.length === 1 && categories[0] === 'Default') && bookmarks.length === 0 && tags.length === 0) {
            vscode.window.showInformationMessage('No data to remove.');
            return;
        }
        const confirmation = await vscode.window.showInputBox({ prompt: 'Type "remove all data" to confirm' });
        if (confirmation === 'remove all data') {
            await store.update('categories', ["Default"], vscode.ConfigurationTarget.Global);
            await store.update('bookmarks', [], vscode.ConfigurationTarget.Global);
            await store.update('tags', [], vscode.ConfigurationTarget.Global); // Remove all tags
            bookmarkDataProvider.refresh();
            vscode.window.showInformationMessage(`All data has been removed.`);
        } else {
            vscode.window.showInformationMessage('Data removal cancelled.');
        }
    }));
    logInfo('Activation completed');
    } catch (error) {
        logError('Activation failed', error);
        vscode.window.showErrorMessage(
            'Extensions Bookmark failed to activate. See Output → Extensions Bookmark.',
            'Show Log'
        ).then(action => {
            if (action === 'Show Log') outputChannel?.show(true);
        });
        throw error;
    }
}

// This method is called when the extension is deactivated
function deactivate() {
    logInfo('Deactivated');
    outputChannel = undefined;
}

module.exports = {
    activate,
    deactivate
};
