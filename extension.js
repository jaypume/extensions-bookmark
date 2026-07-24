const vscode = require('vscode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const store = require('./store');

// Runtime set of installed extension ids (lowercased) for status detection.
function computeInstalledSet() {
    return new Set(vscode.extensions.all.map(e => e.id.toLowerCase()));
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
    'ok-uninstalled':  { codicon: 'check',       color: 'testing.iconPassed',    desc: '' }
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

function passesFilter(d, statusFilter) {
    switch (statusFilter) {
        case 'installed':  return d.actual;
        case 'not-wanted': return d.want === false;
        case 'diff':       return d.status === 'want-install' || d.status === 'want-uninstall';
        case 'all':
        default:           return true;
    }
}

function toBookmarkTreeItem(d) {
    const bookmark = d.bookmark;
    const treeItem = new vscode.TreeItem(bookmark.displayName);
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
    treeItem.command = {
        command: 'extensions-bookmark.showDetails',
        arguments: [bookmark.id],
        title: 'Show Details'
    };
    treeItem.contextValue = 'bookmarkedExtension';
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
        this.statusFilter = store.get('statusFilter', 'all');
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element) {
        return element;
    }

    async getChildren(element) {
        const categories = store.get('categories', []);
        const bookmarks = store.get('bookmarks', []);
        const sortingOption = store.get('sortingOption', 'A-Z');
        const installedSet = computeInstalledSet();

        const decorate = (bm) => decorateBookmark(bm, installedSet);
        const visible = (d) => passesFilter(d, this.statusFilter);

        if (element) {
            let inGroup;
            if (element.contextValue === 'statusGroup') {
                // Grouped by status: filter by the group's bucket key.
                inGroup = bookmarks
                    .map(decorate)
                    .filter(d => {
                        if (!visible(d)) return false;
                        if (element.statusKey === '__wanted__')    return d.want === true;
                        if (element.statusKey === '__notwanted__') return d.want === false;
                        return d.status === 'want-install' || d.status === 'want-uninstall';
                    });
            } else {
                // Grouped by category.
                inGroup = bookmarks
                    .filter(bm => bm.category === element.label)
                    .map(decorate)
                    .filter(visible);
            }
            // Sort by status priority (wanted&installed → diff → unwanted),
            // then by the user's chosen sorting option within each tier.
            const statusRank = (d) => {
                if (d.status === 'ok-installed')   return 0; // wanted & installed
                if (d.status === 'want-install')   return 1; // diff: to install
                if (d.status === 'want-uninstall') return 1; // diff: to remove
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
            }).map(d => toBookmarkTreeItem(d));
        }

        // Root level.
        if (this.viewMode === 'flat') {
            const flat = bookmarks.map(decorate).filter(visible);
            return sortBookmarks(flat.map(d => d.bookmark), 'A-Z')
                .map(bm => toBookmarkTreeItem(decorate(bm)));
        }

        if (this.viewMode === 'by-status') {
            // Three fixed buckets, always shown (even if empty).
            // Wanted = expected to install; Not Wanted = expected to uninstall;
            // Diff = expectation != actual (subset shown in both above).
            const buckets = [
                { label: 'Wanted',     key: '__wanted__' },
                { label: 'Not Wanted', key: '__notwanted__' },
                { label: 'Diff',       key: '__diff__' }
            ];
            return buckets.map(b => {
                const inBucket = (d) => {
                    if (b.key === '__wanted__')    return d.want === true;
                    if (b.key === '__notwanted__') return d.want === false;
                    return d.status === 'want-install' || d.status === 'want-uninstall';
                };
                const count = bookmarks.map(decorate).filter(d => visible(d) && inBucket(d)).length;
                const treeItem = new vscode.TreeItem(`${b.label} (${count})`, vscode.TreeItemCollapsibleState.Collapsed);
                treeItem.contextValue = 'statusGroup';
                treeItem.statusKey = b.key;
                return treeItem;
            });
        }

        // by-category root: category list, 'Default' pinned first.
        const sortedCategories = categories.sort((a, b) => {
            if (a === 'Default') return -1;
            if (b === 'Default') return 1;
            return a.localeCompare(b);
        });
        return sortedCategories.map(category => {
            let treeItem = new vscode.TreeItem(category, vscode.TreeItemCollapsibleState.Collapsed);
            treeItem.contextValue = category === 'Default' ? 'defaultCategory' : 'category';
            return treeItem;
        });
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
        view.webview.html = this._renderEmpty();
        view.webview.onDidReceiveMessage(async (msg) => {
            if (msg && msg.type === 'saveNote' && this.bookmarkId) {
                const bookmarks = store.get('bookmarks', []);
                const bm = bookmarks.find(b => b.id === this.bookmarkId);
                if (bm) {
                    bm.note = msg.value;
                    store.update('bookmarks', bookmarks);
                    this.bookmarkDataProvider.refresh();
                }
            } else if (msg && msg.type === 'openMarket' && msg.id) {
                vscode.commands.executeCommand('extension.open', msg.id);
            }
        });
    }

    show(bookmarkId) {
        this.bookmarkId = bookmarkId;
        if (this.view) {
            const bookmarks = store.get('bookmarks', []);
            const bookmark = bookmarks.find(b => b.id === bookmarkId);
            if (bookmark) this.view.webview.html = this._renderCard(bookmark);
            this.view.show?.(true);
        }
    }

    // Shared <head>: codicons font (self-declared with absolute webview URI
    // so the relative path in codicon.css resolves correctly) + base CSS.
    _head() {
        const a = this.assets || {};
        return `<meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
        return `<!DOCTYPE html><html><head>${this._head()}</head>
        <body><div class="empty">Select a bookmark to view details.</div></body></html>`;
    }

    _renderCard(bm) {
        const installedSet = computeInstalledSet();
        const d = decorateBookmark(bm, installedSet);
        const esc = (s) => String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
        return `<!DOCTYPE html><html><head>${this._head()}</head>
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
        <script>
          const vscode = acquireVsCodeApi();
          const ta = document.getElementById('note');
          ta.addEventListener('blur', () => vscode.postMessage({ type: 'saveNote', value: ta.value }));
          document.getElementById('openMarket').addEventListener('click', () => {
            vscode.postMessage({ type: 'openMarket', id: ${JSON.stringify(bm.id)} });
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
    // Backing store: standalone JSON file under globalStorage, migrated from
    // settings.json on first run. See store.js. The data file is written
    // synchronously; clearing legacy settings.json keys is best-effort async.
    store.init(context);
    store.migrate().catch(e => console.warn('[extensions-bookmark] migrate failed:', e));

    const bookmarkDataProvider = new BookmarkDataProvider();
    vscode.window.registerTreeDataProvider('extensionsBookmarkView', bookmarkDataProvider);

    const detailsProvider = new DetailsViewProvider(context, bookmarkDataProvider);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('extensionsBookmarkDetails', detailsProvider)
    );

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
        const options = ['Add Bookmark', 'Add Category', 'Add Tag', 'Rename Tag', 'Remove Tag', 'Sort Bookmarks', 'Filter Bookmarks', 'Sync to Data', 'Sync from Data', 'Import Data', 'Export Data', 'Remove All Data'];
        const selectedOption = await vscode.window.showQuickPick(options, { placeHolder: 'Select an option' });
        if (selectedOption === options[0]) {
            vscode.commands.executeCommand('extensions-bookmark.addBookmark');
        } else if (selectedOption === options[1]) {
            vscode.commands.executeCommand('extensions-bookmark.addCategory');
        } else if (selectedOption === options[2]) {
            vscode.commands.executeCommand('extensions-bookmark.addTagToList');
        } else if (selectedOption === options[3]) {
            vscode.commands.executeCommand('extensions-bookmark.renameTagInList');
        } else if (selectedOption === options[4]) {
            vscode.commands.executeCommand('extensions-bookmark.removeTagFromList');
        } else if (selectedOption === options[5]) {
            vscode.commands.executeCommand('extensions-bookmark.sortBookmarks');
        } else if (selectedOption === options[6]) {
            vscode.commands.executeCommand('extensions-bookmark.filterByTag');
        } else if (selectedOption === options[7]) {
            vscode.commands.executeCommand('extensions-bookmark.syncToData');
        } else if (selectedOption === options[8]) {
            vscode.commands.executeCommand('extensions-bookmark.syncFromData');
        } else if (selectedOption === options[9]) {
            vscode.commands.executeCommand('extensions-bookmark.importData');
        } else if (selectedOption === options[10]) {
            vscode.commands.executeCommand('extensions-bookmark.exportData');
        } else if (selectedOption === options[11]) {
            vscode.commands.executeCommand('extensions-bookmark.removeAllData');
        }
    }));

    // Command to refresh the bookmark tree view (re-read from the store)
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.refresh', () => {
        bookmarkDataProvider.refresh();
    }));

    // Cycle view modes: by-category → by-status → flat → by-category.
    function setViewMode(mode) {
        bookmarkDataProvider.viewMode = mode;
        store.update('viewMode', mode);
        vscode.commands.executeCommand('setContext', 'extensions-bookmark.viewMode', mode);
        bookmarkDataProvider.refresh();
    }
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.switchToByStatus', () => setViewMode('by-status')));
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.switchToFlat', () => setViewMode('flat')));
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.switchToByCategory', () => setViewMode('by-category')));

    // Filter bookmarks by install/wanted status.
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.filterStatus', async () => {
        const options = [
            { label: 'All', value: 'all' },
            { label: 'Installed', value: 'installed' },
            { label: 'Expected to Uninstall', value: 'not-wanted' },
            { label: 'Diff Only (out of sync)', value: 'diff' }
        ];
        const picked = await vscode.window.showQuickPick(options, { placeHolder: 'Filter bookmarks by status' });
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
        const selectedExtension = await vscode.window.showInputBox({ prompt: 'Enter the identifier of the extension (publisher.extensionname)' });

        if (selectedExtension && selectedExtension.trim() !== '' && !bookmarks.find(bookmark => bookmark.id === selectedExtension)) {
            // Sort categories alphabetically, but keep 'Default' at the top
            const sortedCategories = categories.sort((a, b) => {
                if (a === 'Default') return -1;
                if (b === 'Default') return 1;
                return a.localeCompare(b);
            });
            const selectedCategory = await vscode.window.showQuickPick(sortedCategories, { placeHolder: 'Select a category for the bookmark' });

            if (selectedCategory) {
                let [publisher, extensionName] = selectedExtension.split('.');
                try {
                    let response = await axios.create().post('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
                        filters: [{
                            criteria: [
                                { filterType: 7, value: `${publisher}.${extensionName}` }
                            ]
                        }],
                        flags: 914
                    }, {
                        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json;api-version=3.0-preview.1' }
                    });

                    if (response.data.results[0].extensions.length > 0) {
                        let extensionData = response.data.results[0].extensions[0];
                        let displayName = extensionData.displayName;
                        let iconFile = extensionData.versions[0].files.find(file => file.assetType === "Microsoft.VisualStudio.Services.Icons.Default");
                        let icon = iconFile ? iconFile.source : 'https://raw.githubusercontent.com/jaypume/extensions-bookmark/main/media/default-bookmark-icon.png';
                        let downloadCountStat = extensionData.statistics.find(stat => stat.statisticName === "install");
                        let downloadCount = downloadCountStat ? downloadCountStat.value.toLocaleString() : 'N/A';
                        let ratingStat = extensionData.statistics.find(stat => stat.statisticName === "averagerating");
                        let rating = ratingStat ? ratingStat.value.toFixed(1) : 'N/A';
                        let dateAdded = new Date().toLocaleString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
                        let lastUpdate = new Date(extensionData.versions[0].lastUpdated).toLocaleString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
                        bookmarks.push({ id: selectedExtension, displayName: displayName, icon: icon, category: selectedCategory, dateAdded: dateAdded, downloadCount: downloadCount, rating: rating, lastUpdate: lastUpdate, wantedInstall: true });
                        await store.update('bookmarks', bookmarks, vscode.ConfigurationTarget.Global);
                        bookmarkDataProvider.refresh();
                        vscode.window.showInformationMessage(`Extension ${selectedExtension} has been bookmarked.`);
                    } else {
                        vscode.window.showErrorMessage(`Extension ${selectedExtension} not found.`);
                    }
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to add bookmark for ${selectedExtension}: ${error}`);
                }
            }
        } else if (selectedExtension && selectedExtension.trim() !== '') {
            vscode.window.showErrorMessage(`Bookmark ${selectedExtension} already exists.`);
        }
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
    context.subscriptions.push(vscode.commands.registerCommand('extensions-bookmark.openExtension', (extensionId) => {
        vscode.commands.executeCommand('extension.open', extensionId);
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
        quickPick.items = bookmarks.sort((a, b) => a.displayName.localeCompare(b.displayName)).map(bookmark => ({ label: bookmark.displayName }));
        quickPick.placeholder = 'Enter a bookmark name or select an existing one';
        quickPick.onDidChangeValue(value => {
            if (value) {
                quickPick.items = bookmarks.filter(bookmark => bookmark.displayName.toLowerCase().includes(value.toLowerCase()))
                    .sort((a, b) => a.displayName.localeCompare(b.displayName))
                    .map(bookmark => ({ label: bookmark.displayName }));
            } else {
                quickPick.items = bookmarks.sort((a, b) => a.displayName.localeCompare(b.displayName)).map(bookmark => ({ label: bookmark.displayName }));
            }
        });
        quickPick.onDidAccept(() => {
            const selectedBookmark = quickPick.selectedItems[0];
            if (selectedBookmark) {
                const selectedBookmarkId = bookmarks.find(bookmark => bookmark.displayName === selectedBookmark.label).id;
                vscode.commands.executeCommand('workbench.extensions.search', `${selectedBookmarkId}`);
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
}

// This method is called when the extension is deactivated
function deactivate() { }

module.exports = {
    activate,
    deactivate
};
