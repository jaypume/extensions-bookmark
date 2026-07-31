'use strict';

// collapse-all / expand-all factory for a tree view.
// Two commands share one title slot; a context key toggles which icon shows.

const vscode = require('vscode');
const uiState = require('./uiState');

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

    // 记住各分组节点（category / status group）的展开态，重启后逐个恢复。
    // toolbar 的 expand/collapse 总开关只保留内存 context（不持久化）。
    const readExpanded = () => new Set(uiState.get('expandedNodes', []));
    const writeExpanded = (set) => uiState.set('expandedNodes', [...set]);
    const recordExpand = (el) => {
        const id = el && el.id;
        if (!id) return;
        const set = readExpanded();
        if (!set.has(id)) { set.add(id); writeExpanded(set); }
    };
    const recordCollapse = (el) => {
        const id = el && el.id;
        if (!id) return;
        const set = readExpanded();
        if (set.has(id)) { set.delete(id); writeExpanded(set); }
    };

    const expandAll = async () => {
        try {
            const roots = await provider.getChildren();
            const set = readExpanded();
            for (const root of roots) {
                if (root && root.collapsibleState !== undefined) {
                    try { await view.reveal(root, { expand: 3 }); } catch (_) { /* ignore */ }
                    if (root.id) set.add(root.id);
                }
            }
            writeExpanded(set);
        } catch (_) { /* ignore */ }
        setCtx(true);
    };

    const collapseAll = async () => {
        await vscode.commands.executeCommand(`workbench.actions.treeView.${viewId}.collapseAll`);
        writeExpanded(new Set());
        setCtx(false);
    };

    const subs = [
        vscode.commands.registerCommand(expandCmd, expandAll),
        vscode.commands.registerCommand(collapseCmd, collapseAll)
    ];
    // Keep the toggle icon in sync with manual expand/collapse by the user.
    if (typeof view.onDidExpandElement === 'function') {
        subs.push(view.onDidExpandElement((e) => { setCtx(true); recordExpand(e.element); }));
    }
    if (typeof view.onDidCollapseElement === 'function') {
        subs.push(view.onDidCollapseElement((e) => { setCtx(false); recordCollapse(e.element); }));
    }

    // 启动恢复：对上次展开过的分组节点重新 reveal(expand)。
    setCtx(false);
    (async () => {
        try {
            const expanded = readExpanded();
            if (!expanded.size) return;
            const roots = await provider.getChildren();
            let any = false;
            for (const root of roots) {
                if (root && root.id && expanded.has(root.id)) {
                    try { await view.reveal(root, { expand: true }); any = true; } catch (_) { /* ignore */ }
                }
            }
            if (any) setCtx(true);
        } catch (_) { /* ignore */ }
    })();
    return subs;
}

module.exports = { registerTreeExpansion };
