'use strict';

// collapse-all / expand-all factory for a tree view.
// Two commands share one title slot; a context key toggles which icon shows.
// 不记住展开/折叠状态：展开态仅在当前会话内存中维护。
// folder (category) 模式启动时默认只展开 Default 分组。

const vscode = require('vscode');

/**
 * @param {vscode.TreeView} view
 * @param {object} provider - exposes getChildren() 与 groupBy
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

    const subs = [
        vscode.commands.registerCommand(expandCmd, expandAll),
        vscode.commands.registerCommand(collapseCmd, collapseAll)
    ];
    // toolbar 图标跟随用户手动展开/折叠同步（仅内存，不持久化）。
    if (typeof view.onDidExpandElement === 'function') {
        subs.push(view.onDidExpandElement(() => setCtx(true)));
    }
    if (typeof view.onDidCollapseElement === 'function') {
        subs.push(view.onDidCollapseElement(() => setCtx(false)));
    }

    // 启动默认：folder (category) 模式只展开 Default 分组，其余折叠。
    setCtx(false);
    (async () => {
        try {
            if (provider.groupBy !== 'category') return;
            const roots = await provider.getChildren();
            const defaultNode = roots.find(r => r && r.id === 'category:Default');
            if (defaultNode) {
                try { await view.reveal(defaultNode, { expand: true }); setCtx(true); } catch (_) { /* ignore */ }
            }
        } catch (_) { /* ignore */ }
    })();
    return subs;
}

module.exports = { registerTreeExpansion };
