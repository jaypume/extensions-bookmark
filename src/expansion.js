'use strict';

// collapse-all / expand-all factory for a tree view.
// Two commands share one title slot; a context key toggles which icon shows.

const vscode = require('vscode');
const store = require('./store');

/**
 * @param {vscode.TreeView} view
 * @param {object} provider - exposes getChildren()
 * @param {string} viewId - the tree view id (for the built-in collapseAll command)
 * @param {string} ctxKey - context key reflecting expanded state
 * @param {string} expandCmd - command id for expand-all
 * @param {string} collapseCmd - command id for collapse-all
 */
function registerTreeExpansion(view, provider, viewId, ctxKey, expandCmd, collapseCmd) {
    let current = undefined; // 去重缓存：仅当展开态真正变化时才写盘

    const applyCtx = (v) => vscode.commands.executeCommand('setContext', ctxKey, v);
    const persist = (v) => {
        if (current === v) return;
        current = v;
        applyCtx(v);
        store.update('treeExpanded', v);
    };

    const expandAll = async () => {
        try {
            const roots = await provider.getChildren();
            for (const root of roots) {
                if (root && root.collapsibleState !== undefined) {
                    try { await view.reveal(root, { expand: 3 }); } catch (_) { /* ignore */ }
                }
            }
        } catch (_) { /* ignore */ }
        persist(true);
    };

    const collapseAll = async () => {
        await vscode.commands.executeCommand(`workbench.actions.treeView.${viewId}.collapseAll`);
        persist(false);
    };

    const subs = [
        vscode.commands.registerCommand(expandCmd, expandAll),
        vscode.commands.registerCommand(collapseCmd, collapseAll)
    ];
    // Keep the toggle icon in sync with manual expand/collapse by the user.
    if (typeof view.onDidExpandElement === 'function') {
        subs.push(view.onDidExpandElement(() => persist(true)));
    }
    if (typeof view.onDidCollapseElement === 'function') {
        subs.push(view.onDidCollapseElement(() => persist(false)));
    }

    // 启动恢复：从本地 ui-state 读初始展开态；若上次是展开的，补一次 expandAll
    // 让实际节点与图标一致（persist(true) 会被去重，不重复写盘）。
    const initial = store.get('treeExpanded', false);
    current = initial;
    applyCtx(initial);
    if (initial) expandAll();
    return subs;
}

module.exports = { registerTreeExpansion };
