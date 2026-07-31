'use strict';

// Entry point: wires store, providers, commands and expansion state.

const vscode = require('vscode');
const store = require('./src/store');
const iconCache = require('./src/iconCache');
const { initLogger, logInfo, logError, showLog } = require('./src/logger');
const recent = require('./src/recent');
const { BookmarkTreeProvider } = require('./src/provider');
const { DetailsTreeProvider } = require('./src/detailsView');
const { registerCommands } = require('./src/commands');
const { registerTreeExpansion } = require('./src/expansion');
const { version: extensionVersion } = require('./package.json');

function activate(context) {
    initLogger(context);
    logInfo(`Activating v${extensionVersion}`);
    logInfo(`Data directory: ${context.globalStorageUri.fsPath}`);

    try {
        store.init(context);
        store.migrate().catch(error => logError('Data migration failed', error));
        store.migrateStoredState();
        recent.init(context);
        iconCache.init(context);

        const provider = new BookmarkTreeProvider();
        logInfo('Registering List tree data provider');
        const treeView = vscode.window.createTreeView('extensionsBookmarkView', {
            treeDataProvider: provider,
            canSelectMany: true
        });
        context.subscriptions.push(treeView);

        const details = new DetailsTreeProvider();
        logInfo('Registering Details tree data provider');
        const detailsView = vscode.window.createTreeView('extensionsBookmarkDetails', { treeDataProvider: details });
        context.subscriptions.push(detailsView);

        // Selection wiring: clicking a bookmark reveals its details.
        context.subscriptions.push(treeView.onDidChangeSelection(e => {
            const sel = e.selection[0];
            details.show(sel && sel.bookmarkId);
        }));

        // Reflect the active groupBy/filter/sort in their submenu ✓ markers.
        vscode.commands.executeCommand('setContext', 'extensions-bookmark.groupBy', provider.groupBy);
        vscode.commands.executeCommand('setContext', 'extensions-bookmark.filter', provider.statusFilter);
        vscode.commands.executeCommand('setContext', 'extensions-bookmark.sort', store.get('sortingOption', 'New-Old'));
        // Reflect external install/uninstall changes automatically.
        context.subscriptions.push(vscode.extensions.onDidChange(() => {
            provider.refresh();
            iconCache.refreshInstalledChanges(store.get('bookmarks', [])).then(changed => {
                if (changed) {
                    provider.refresh();
                    details.refresh();
                }
            });
        }));
        // Re-render details when config (e.g. recentHours) changes.
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('extensionsBookmark.recentHours')) {
                provider.refresh();
                details.refresh();
            }
        }));

        // Ensure categories array exists.
        if (!Array.isArray(store.get('categories', []))) store.update('categories', []);

        context.subscriptions.push(...registerCommands({ provider, details, treeView, recent, iconCache }));

        context.subscriptions.push(...registerTreeExpansion(
            treeView, provider, 'extensionsBookmarkView',
            'extensions-bookmark.treeExpanded',
            'extensions-bookmark.expandTree',
            'extensions-bookmark.collapseTree'
        ));

        iconCache.refreshStale(store.get('bookmarks', [])).then(changed => {
            if (changed) {
                provider.refresh();
                details.refresh();
            }
        });

        logInfo('Activation completed');
    } catch (error) {
        logError('Activation failed', error);
        vscode.window.showErrorMessage(
            'Extensions Bookmark failed to activate. See Output → Extensions Bookmark.',
            'Show Log'
        ).then(action => { if (action === 'Show Log') showLog(); });
        throw error;
    }
}

function deactivate() {
    logInfo('Deactivated');
}

module.exports = { activate, deactivate };
