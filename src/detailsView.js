'use strict';

// Native Details TreeView (replaces the old Webview). Renders the selected
// bookmark as a root node plus a list of property rows. Clicking a property
// row either copies its value or opens an editor (Note / Marketplace).

const vscode = require('vscode');
const { lookupBookmark } = require('./installed');
const { computeInstalledSet } = require('./installed');
const { decorateBookmark, decorateExtra, wantedEmoji, installedEmoji, isDiffStatus, buildIconPath } = require('./visuals');

const COPY_CMD = 'extensions-bookmark.copyDetailValue';
const EDIT_NOTE_CMD = 'extensions-bookmark.editNoteFromDetails';
const OPEN_CMD = 'extensions-bookmark.openExtension';

function propNode(prefix, key, label, value, icon, command, tooltip) {
    const node = new vscode.TreeItem(label);
    node.id = `${prefix}:${key}`;
    node.description = value;
    node.iconPath = icon instanceof vscode.ThemeIcon ? icon : new vscode.ThemeIcon(icon);
    node.tooltip = tooltip;
    node.command = command;
    node.contextValue = 'detailProperty';
    node.propertyKey = key;
    return node;
}

class DetailsTreeProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.bookmarkId = null;
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    show(bookmarkId) {
        this.bookmarkId = bookmarkId || null;
        this.refresh();
    }

    getTreeItem(element) {
        return element;
    }

    async getChildren(element) {
        if (element) return element.children || []; // expanded root → property rows
        const bm = lookupBookmark(this.bookmarkId);
        if (!bm) {
            const empty = new vscode.TreeItem('Select a bookmark to view details');
            empty.iconPath = new vscode.ThemeIcon('info');
            empty.contextValue = 'detailPlaceholder';
            return [empty];
        }

        // Root node carrying the bookmark identity for selection wiring.
        const installedSet = computeInstalledSet();
        const d = bm.extra ? decorateExtra(bm) : decorateBookmark(bm, installedSet);
        const root = new vscode.TreeItem(bm.displayName, vscode.TreeItemCollapsibleState.Expanded);
        root.id = `details:root:${bm.id}`;
        root.description = `${bm.id} · ${wantedEmoji(d.want)} ${installedEmoji(d.actual)}`;
        root.iconPath = buildIconPath(bm, d.status);
        root.contextValue = 'detailRoot';
        root.bookmarkId = bm.id;
        root.tooltip = `${bm.displayName}\n${bm.id}`;
        root.children = this._propertyNodes(bm, d);
        return [root];
    }

    /** Children of the expanded root node. */
    _propertyNodes(bm, d) {
        const prefix = bm.id;
        const wantVal = d.extra ? '—' : `${wantedEmoji(d.want)} ${d.want ? 'yes' : 'no'}${isDiffStatus(d) ? ' ★' : ''}`;
        const wantIcon = d.extra ? 'circle-slash' : (d.want ? 'check' : 'close');
        const installedVal = `${installedEmoji(d.actual)} ${d.actual ? 'yes' : 'no'}${isDiffStatus(d) ? ' ★' : ''}`;
        const installedIcon = d.actual ? 'pass-filled' : 'circle-slash';
        const copy = (key, label, value, icon) => propNode(prefix, key, label, value, icon, {
            command: COPY_CMD, arguments: [String(value ?? '')], title: 'Copy'
        }, `${value ?? ''}\n\nClick to copy`);

        return [
            copy('wanted', 'Favorite', wantVal, wantIcon),
            copy('installed', 'Installed', installedVal, installedIcon),
            copy('id', 'ID', bm.id, 'symbol-key'),
            copy('category', 'Category', bm.category || '—', 'tag'),
            copy('downloads', 'Downloads', bm.downloadCount || '—', 'cloud-download'),
            copy('rating', 'Rating', bm.rating || '—', 'star-half'),
            copy('updated', 'Updated', bm.lastUpdate || '—', 'history'),
            copy('added', 'Added', bm.dateAdded || '—', 'calendar'),
            propNode(prefix, 'note', 'Note', bm.note || '—', 'note', {
                command: EDIT_NOTE_CMD, arguments: [bm.id], title: 'Edit Note'
            }, `${bm.note ? bm.note : '(empty)'}\n\nClick to edit`),
            propNode(prefix, 'open', 'Open in Marketplace', '', 'extensions', {
                command: OPEN_CMD, arguments: [bm.id], title: 'Open in Marketplace'
            }, 'Open this extension in the Marketplace')
        ];
    }
}

module.exports = { DetailsTreeProvider };
