'use strict';

// collapse-all / expand-all factory for a tree view.
// Two commands share one title slot; a context key toggles which icon shows.

const vscode = require('vscode');

/**
 * @param {vscode.TreeView} view
 * @param {object} provider - exposes getChildren()
 * @param {string} viewId - the tree view id (for the built-in collapseAll command)
 * @param {string} ctxKey - context key reflecting expanded state
 * @param {string} expandCmd - command id for expand-all
 * @param {string} collapseCmd - command id for collapse-all
 */
function registerTreeExpansion(view, provider, viewId, ctxKey, expandCmd, collapseCmd) {
    const setCtx = (v) => vscode.commands.executeCommand('setContext', ctxKey, v);

    const expandAll = async () => {
        try {
            const roots = await provider.getChildren();
            for (const root of roots) {
                if (root && root.collapsibleState !== undefined) {
                    try { await view.reveal(root, { expand: 3 }); } catch (_) { /* ignore */ }
                }
            }
        } catch (_) { /* ignore */ }
        setCtx(true);
    };

    const collapseAll = async () => {
        await vscode.commands.executeCommand(`workbench.actions.treeView.${viewId}.collapseAll`);
        setCtx(false);
    };

    // Keep the toggle icon in sync with manual expand/collapse by the user.
    const subs = [
        vscode.commands.registerCommand(expandCmd, expandAll),
        vscode.commands.registerCommand(collapseCmd, collapseAll)
    ];
    // Keep the toggle icon in sync with manual expand/collapse by the user.
    if (typeof view.onDidExpandElement === 'function') {
        subs.push(view.onDidExpandElement(() => setCtx(true)));
    }
    if (typeof view.onDidCollapseElement === 'function') {
        subs.push(view.onDidCollapseElement(() => setCtx(false)));
    }

    setCtx(false);
    return subs;
}

module.exports = { registerTreeExpansion };
