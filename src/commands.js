'use strict';

// All command registrations. registerCommands(deps) wires every command onto
// the given providers/views and returns disposables.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const store = require('./store');
const { logInfo, logError } = require('./logger');
const { decorateBookmark, decorateExtra, statusDescription } = require('./visuals');
const { getRecentHours, passesFilter } = require('./provider');
const { parseExtensionIds, fetchMarketplaceBookmark } = require('./marketplace');
const { buildBookmarkFromLocal, isInstalled, lookupBookmark, computeInstalledSet } = require('./installed');

const NS = 'extensions-bookmark';
const cmd = (name) => `${NS}.${name}`;
const CTX_GROUP_BY = `${NS}.groupBy`;

function sortedCategories(categories) {
    return categories.slice().sort((a, b) => {
        if (a === 'Default') return -1;
        if (b === 'Default') return 1;
        return a.localeCompare(b);
    });
}

function idFromItem(item) {
    return item?.command?.arguments?.[0] ?? item?.bookmarkId;
}

/**
 * Collect bookmark ids from a context-menu/inline invocation. Supports multi-
 * selection: VSCode passes (item, selectedItems). Falls back to the single
 * item, or undefined when invoked from the command palette.
 */
function idsFromArgs(item, selection) {
    const list = Array.isArray(selection) && selection.length ? selection : (item ? [item] : []);
    const ids = [];
    const seen = new Set();
    for (const node of list) {
        const id = idFromItem(node);
        if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
    }
    return ids;
}

/** Look up bookmark records for the given ids (extras excluded). */
function bookmarksForIds(ids) {
    const bookmarks = store.get('bookmarks', []);
    const set = new Set(ids.map(id => String(id).toLowerCase()));
    return bookmarks.filter(b => set.has(String(b.id).toLowerCase()));
}

function registerCommands(deps) {
    const { provider, details, treeView } = deps;
    const subs = [];
    const reg = (name, fn) => subs.push(vscode.commands.registerCommand(cmd(name), fn));

    // --- groupBy (submenu): category / status / flat ---
    async function setGroupBy(mode) {
        provider.groupBy = mode;
        await store.update('groupBy', mode);
        await vscode.commands.executeCommand('setContext', CTX_GROUP_BY, mode);
        provider.refresh();
    }
    reg('groupByCategory', () => setGroupBy('category'));
    reg('groupByWanted', () => setGroupBy('wanted'));
    reg('groupByInstalled', () => setGroupBy('installed'));
    reg('groupByAge', () => setGroupBy('age'));
    reg('groupByFlat', () => setGroupBy('flat'));
    reg('groupByCategoryCurrent', () => setGroupBy('category'));
    reg('groupByWantedCurrent', () => setGroupBy('wanted'));
    reg('groupByInstalledCurrent', () => setGroupBy('installed'));
    reg('groupByAgeCurrent', () => setGroupBy('age'));
    reg('groupByFlatCurrent', () => setGroupBy('flat'));

    // --- filter by status (submenu; one command per option + Current marker) ---
    const CTX_FILTER = `${NS}.filter`;
    async function setFilter(value) {
        provider.statusFilter = value;
        await store.update('statusFilter', value);
        await vscode.commands.executeCommand('setContext', CTX_FILTER, value);
        provider.refresh();
    }
    reg('filterAll', () => setFilter('all'));
    reg('filterInstalled', () => setFilter('installed'));
    reg('filterUninstalled', () => setFilter('uninstalled'));
    reg('filterWanted', () => setFilter('wanted'));
    reg('filterUnwanted', () => setFilter('unwanted'));
    reg('filterAdded1d', () => setFilter('added-1d'));
    reg('filterAdded1w', () => setFilter('added-1w'));
    reg('filterAdded1m', () => setFilter('added-1m'));
    reg('filterAllCurrent', () => setFilter('all'));
    reg('filterInstalledCurrent', () => setFilter('installed'));
    reg('filterUninstalledCurrent', () => setFilter('uninstalled'));
    reg('filterWantedCurrent', () => setFilter('wanted'));
    reg('filterUnwantedCurrent', () => setFilter('unwanted'));
    reg('filterAdded1dCurrent', () => setFilter('added-1d'));
    reg('filterAdded1wCurrent', () => setFilter('added-1w'));
    reg('filterAdded1mCurrent', () => setFilter('added-1m'));

    // --- toggle wanted (multi-select aware) ---
    reg('toggleWanted', async (item, selection) => {
        const ids = idsFromArgs(item, selection);
        if (ids.length === 0) return;
        const bookmarks = store.get('bookmarks', []);
        const targets = bookmarks.filter(b => ids.includes(b.id));
        if (targets.length === 0) return;
        for (const bookmark of targets) {
            bookmark.wantedInstall = bookmark.wantedInstall === false;
        }
        store.update('bookmarks', bookmarks);
        provider.refresh();
        details.refresh();
        if (targets.length === 1) {
            const b = targets[0];
            vscode.window.showInformationMessage(`${b.displayName}: ${b.wantedInstall === false ? 'not wanted' : 'wanted'}`);
        } else {
            vscode.window.showInformationMessage(`Toggled wanted for ${targets.length} bookmarks.`);
        }
    });

    // --- sync helpers ---
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

    function refreshAfterSync() {
        provider.refresh();
        details.refresh();
        [1000, 2000, 4000].forEach(ms => setTimeout(() => { provider.refresh(); details.refresh(); }, ms));
    }

    // --- install / uninstall single or multiple bookmarks to match wantedInstall ---
    async function syncMany(ids, action) {
        const bookmarks = bookmarksForIds(ids);
        if (bookmarks.length === 0) return;
        let uninstalled = false;
        const results = [];
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `${action} extensions`, cancellable: false },
            async (progress) => {
                for (let i = 0; i < bookmarks.length; i++) {
                    const bm = bookmarks[i];
                    progress.report({ increment: bookmarks.length ? 100 / bookmarks.length : 100, message: `${i + 1}/${bookmarks.length}: ${bm.displayName}` });
                    try {
                        const r = await applySync(bm);
                        if (r === 'uninstalled') uninstalled = true;
                        results.push(r);
                    } catch (e) {
                        results.push('error');
                        console.warn(`[extensions-bookmark] sync ${bm.id}:`, e);
                    }
                }
            }
        );
        refreshAfterSync();
        if (uninstalled) {
            const reload = 'Reload Window';
            const choice = await vscode.window.showInformationMessage(
                `${action} complete. Reload window to fully apply uninstalls?`, reload);
            if (choice === reload) vscode.commands.executeCommand('workbench.action.reloadWindow');
        } else {
            vscode.window.showInformationMessage(`${action} complete (${bookmarks.length}).`);
        }
    }

    // Directly install/uninstall the given ids (bypass wantedInstall), with
    // optional wantedInstall override so data stays consistent after the action.
    async function applyMany(ids, action, setWanted) {
        const bookmarks = store.get('bookmarks', []);
        const lower = new Set(ids.map(id => String(id).toLowerCase()));
        const targets = bookmarks.filter(b => lower.has(String(b.id).toLowerCase()));
        if (targets.length === 0) return;
        if (setWanted !== undefined) {
            for (const bm of targets) bm.wantedInstall = setWanted;
            await store.update('bookmarks', bookmarks);
        }
        let uninstalled = false;
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `${action} extensions`, cancellable: false },
            async (progress) => {
                for (let i = 0; i < targets.length; i++) {
                    const bm = targets[i];
                    progress.report({ increment: targets.length ? 100 / targets.length : 100, message: `${i + 1}/${targets.length}: ${bm.displayName}` });
                    try {
                        if (action === 'Install') {
                            await vscode.commands.executeCommand('workbench.extensions.installExtension', bm.id);
                        } else if (action === 'Uninstall') {
                            await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', bm.id);
                            uninstalled = true;
                        }
                    } catch (e) {
                        console.warn(`[extensions-bookmark] ${action} ${bm.id}:`, e);
                    }
                }
            }
        );
        refreshAfterSync();
        if (uninstalled) {
            const reload = 'Reload Window';
            const choice = await vscode.window.showInformationMessage(
                `${action} complete. Reload window to fully apply uninstalls?`, reload);
            if (choice === reload) vscode.commands.executeCommand('workbench.action.reloadWindow');
        } else {
            vscode.window.showInformationMessage(`${action} complete (${targets.length}).`);
        }
    }

    reg('syncExtension', async (item, selection) => {
        const ids = idsFromArgs(item, selection);
        if (ids.length === 0) return;
        await syncMany(ids, 'Sync');
    });
    reg('installSelected', (item, selection) => {
        const ids = idsFromArgs(item, selection);
        if (ids.length === 0) return Promise.resolve();
        return applyMany(ids, 'Install', true);
    });
    reg('uninstallSelected', (item, selection) => {
        const ids = idsFromArgs(item, selection);
        if (ids.length === 0) return Promise.resolve();
        return applyMany(ids, 'Uninstall', false);
    });

    reg('syncToData', async () => {
        const bookmarks = store.get('bookmarks', []);
        let installedCount = 0;
        for (const bm of bookmarks) {
            const actual = isInstalled(bm.id);
            bm.wantedInstall = actual;
            if (actual) installedCount++;
        }
        store.update('bookmarks', bookmarks);
        provider.refresh();
        vscode.window.showInformationMessage(`Synced to data: ${installedCount}/${bookmarks.length} installed.`);
    });

    reg('syncFromData', async () => {
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
                    try { await applySync(bm); } catch (e) { failed++; console.warn(`[extensions-bookmark] sync ${action} failed for ${bm.id}:`, e); }
                    done++;
                };
                for (const bm of needInstall) await run(bm, 'Installing');
                for (const bm of needUninstall) await run(bm, 'Removing');
            }
        );
        const msg = `Sync complete: ${done - failed}/${total} ok${failed ? `, ${failed} failed` : ''}.`;
        if (needUninstall.length > 0) {
            const reload = 'Reload Window';
            const choice = await vscode.window.showInformationMessage(`${msg} Reload window to fully apply uninstalls?`, reload);
            if (choice === reload) vscode.commands.executeCommand('workbench.action.reloadWindow');
        } else {
            vscode.window.showInformationMessage(msg);
        }
        refreshAfterSync();
    });

    // --- add bookmark ---
    reg('addBookmark', async () => {
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

        const selectedCategory = await vscode.window.showQuickPick(sortedCategories(categories), {
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
            await store.update('bookmarks', bookmarks);
            provider.refresh();
            vscode.window.showInformationMessage(`Extension ${selectedExtension} has been bookmarked.`);
        } catch (error) {
            logError(`Failed to add bookmark ${selectedExtension}`, error);
            vscode.window.showErrorMessage(`Failed to add bookmark for ${selectedExtension}: ${error}`);
        }
    });

    // Bookmark an installed-but-unbookmarked extension surfaced via the Diff bucket.
    reg('addExtraToBookmarks', async (itemOrId) => {
        const extensionId = typeof itemOrId === 'string'
            ? itemOrId
            : idFromItem(itemOrId);
        if (!extensionId) return;
        const categories = store.get('categories', []);
        const bookmarks = store.get('bookmarks', []);
        if (bookmarks.some(bookmark => String(bookmark.id).toLowerCase() === extensionId.toLowerCase())) {
            vscode.window.showInformationMessage(`Bookmark ${extensionId} already exists.`);
            return;
        }
        const selectedCategory = await vscode.window.showQuickPick(sortedCategories(categories), {
            placeHolder: `Select a category for ${extensionId}`
        });
        if (!selectedCategory) return;
        try {
            let bookmark = null;
            try {
                bookmark = await fetchMarketplaceBookmark(extensionId, selectedCategory);
            } catch (marketError) {
                logError(`Marketplace lookup failed for ${extensionId}, using local data`, marketError);
            }
            if (!bookmark) bookmark = buildBookmarkFromLocal(extensionId, selectedCategory);
            bookmarks.push(bookmark);
            await store.update('bookmarks', bookmarks);
            provider.refresh();
            vscode.window.showInformationMessage(`Extension ${extensionId} has been bookmarked.`);
        } catch (error) {
            logError(`Failed to add bookmark ${extensionId}`, error);
            vscode.window.showErrorMessage(`Failed to add bookmark for ${extensionId}: ${error?.message || error}`);
        }
    });

    reg('addFromList', async () => {
        const clipboard = await vscode.env.clipboard.readText();
        const clipboardItems = parseExtensionIds(clipboard);
        let input;

        if (clipboardItems.ids.length > 0) {
            const source = await vscode.window.showQuickPick([
                { label: `Use Clipboard (${clipboardItems.ids.length} IDs)`, value: 'clipboard', description: clipboardItems.ids.slice(0, 3).join(', ') },
                { label: 'Enter IDs', value: 'manual', description: 'Separate IDs with spaces, commas, or semicolons' }
            ], { placeHolder: 'Choose the extension list source' });
            if (!source) return;
            input = source.value === 'clipboard'
                ? clipboard
                : await vscode.window.showInputBox({ prompt: 'Enter extension IDs separated by spaces, commas, or semicolons' });
        } else {
            input = await vscode.window.showInputBox({ prompt: 'Enter extension IDs separated by spaces, commas, or semicolons' });
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
            if (failed.length > 0) vscode.window.showWarningMessage(summary);
            else vscode.window.showInformationMessage(summary);
        };
        if (pending.length === 0) { notify(); return; }

        const categories = store.get('categories', []);
        const category = await vscode.window.showQuickPick(sortedCategories(categories), {
            placeHolder: 'Select a category for the bookmarks'
        });
        if (!category) return;

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Adding bookmarks from list', cancellable: false },
            async progress => {
                for (let index = 0; index < pending.length; index++) {
                    const id = pending[index];
                    progress.report({ increment: pending.length ? 100 / pending.length : 100, message: `${index + 1}/${pending.length}: ${id}` });
                    try {
                        const bookmark = await fetchMarketplaceBookmark(id, category);
                        if (bookmark) { bookmarks.push(bookmark); added.push(id); }
                        else failed.push(id);
                    } catch (error) {
                        logError(`Failed to add bookmark ${id}`, error);
                        failed.push(id);
                    }
                }
            }
        );

        if (added.length > 0) {
            await store.update('bookmarks', bookmarks);
            provider.refresh();
        }
        notify();
    });

    reg('viewBookmarks', async () => {
        const bookmarks = store.get('bookmarks', []);
        const sortedBookmarks = bookmarks.sort((a, b) => a.displayName.localeCompare(b.displayName));
        const selectedBookmark = await vscode.window.showQuickPick(sortedBookmarks.map(bookmark => bookmark.displayName), { placeHolder: 'Select a bookmark to view details' });
        if (selectedBookmark) {
            const selectedBookmarkId = sortedBookmarks.find(bookmark => bookmark.displayName === selectedBookmark).id;
            vscode.commands.executeCommand('workbench.extensions.search', selectedBookmarkId);
        }
    });

    reg('openExtension', (itemOrId) => {
        const extensionId = typeof itemOrId === 'string' ? itemOrId : idFromItem(itemOrId);
        if (extensionId) vscode.commands.executeCommand('extension.open', extensionId);
    });

    reg('showDetails', (extensionId) => {
        if (extensionId) details.show(extensionId);
    });

    reg('removeBookmark', async (item, selection) => {
        let ids = idsFromArgs(item, selection);
        let bookmarks = store.get('bookmarks', []);
        if (ids.length === 0) {
            const sortedBookmarks = bookmarks.slice().sort((a, b) => a.displayName.localeCompare(b.displayName));
            const selected = await vscode.window.showQuickPick(sortedBookmarks.map(b => b.displayName), { placeHolder: 'Select a bookmark to remove' });
            const bm = bookmarks.find(b => b.displayName === selected);
            if (!bm) return;
            ids = [bm.id];
        }
        bookmarks = store.get('bookmarks', []);
        const lower = new Set(ids.map(id => String(id).toLowerCase()));
        const removed = bookmarks.filter(b => lower.has(String(b.id).toLowerCase()));
        const next = bookmarks.filter(b => !lower.has(String(b.id).toLowerCase()));
        await store.update('bookmarks', next);
        provider.refresh();
        if (details.bookmarkId && lower.has(String(details.bookmarkId).toLowerCase())) details.show(null);
        const names = removed.map(b => b.displayName).join(', ');
        vscode.window.showInformationMessage(`Removed: ${names || '(none)'}`);
    });

    reg('addCategory', async () => {
        const categories = store.get('categories', []);
        const quickPick = vscode.window.createQuickPick();
        quickPick.items = categories.sort().map(category => ({ label: category }));
        quickPick.placeholder = 'Enter a new category';
        quickPick.onDidChangeValue(value => {
            if (value && !categories.map(c => c.toLowerCase()).includes(value.toLowerCase())) {
                quickPick.items = [{ label: value }, ...categories.sort().map(c => ({ label: c }))];
            } else {
                quickPick.items = sortedCategories(categories).map(c => ({ label: c }));
            }
        });
        quickPick.onDidAccept(async () => {
            const newCategory = quickPick.value;
            if (newCategory && newCategory.trim() !== '' && !categories.map(c => c.toLowerCase()).includes(newCategory.toLowerCase())) {
                categories.push(newCategory);
                await store.update('categories', categories);
                provider.refresh();
                vscode.window.showInformationMessage(`Category ${newCategory} has been added.`);
            } else if (newCategory && newCategory.trim() !== '') {
                vscode.window.showErrorMessage(`Category ${newCategory} already exists.`);
            }
            quickPick.hide();
        });
        quickPick.show();
    });

    reg('renameCategory', async (item) => {
        let categories = store.get('categories', []);
        const bookmarks = store.get('bookmarks', []);
        let selectedCategory;
        categories = sortedCategories(categories);

        if (item) selectedCategory = item.label;
        else selectedCategory = await vscode.window.showQuickPick(categories, { placeHolder: 'Select a category to rename' });
        if (!selectedCategory) return;

        const quickPick = vscode.window.createQuickPick();
        quickPick.items = categories.map(c => ({ label: c }));
        quickPick.value = selectedCategory;
        quickPick.placeholder = 'Enter the new name of the category';
        quickPick.onDidChangeValue(value => {
            if (value && !categories.filter(c => c.toLowerCase() !== selectedCategory.toLowerCase()).map(c => c.toLowerCase()).includes(value.toLowerCase())) {
                quickPick.items = [{ label: value }, ...categories.map(c => ({ label: c }))];
            } else {
                quickPick.items = categories.map(c => ({ label: c }));
            }
        });
        quickPick.onDidAccept(async () => {
            const newCategoryName = quickPick.value;
            if (newCategoryName && newCategoryName.trim() !== '' && newCategoryName !== selectedCategory
                && (!categories.filter(c => c.toLowerCase() !== selectedCategory.toLowerCase()).map(c => c.toLowerCase()).includes(newCategoryName.toLowerCase()))) {
                const index = categories.indexOf(selectedCategory);
                if (index > -1) {
                    categories[index] = newCategoryName;
                    bookmarks.forEach(b => { if (b.category === selectedCategory) b.category = newCategoryName; });
                    await store.update('categories', categories);
                    await store.update('bookmarks', bookmarks);
                    provider.refresh();
                    vscode.window.showInformationMessage(`Category ${selectedCategory} has been renamed to ${newCategoryName}.`);
                }
            } else if (newCategoryName && newCategoryName.trim() !== '') {
                if (newCategoryName === selectedCategory) vscode.window.showErrorMessage('New category name cannot be the same as the old name.');
                else vscode.window.showErrorMessage(`Category ${newCategoryName} already exists.`);
            }
            quickPick.hide();
        });
        quickPick.show();
    });

    reg('removeCategory', async (item) => {
        const categories = store.get('categories', []);
        const bookmarks = store.get('bookmarks', []);
        const sortedCats = sortedCategories(categories);
        let selectedCategory;
        if (item) selectedCategory = item.label;
        else selectedCategory = await vscode.window.showQuickPick(sortedCats, { placeHolder: 'Select a category to remove' });
        if (!selectedCategory) return;

        const index = categories.indexOf(selectedCategory);
        if (index > -1) {
            categories.splice(index, 1);
            const toReassign = bookmarks.filter(b => b.category === selectedCategory);
            toReassign.forEach(b => { bookmarks[bookmarks.indexOf(b)].category = 'Default'; });
            await store.update('categories', categories);
            await store.update('bookmarks', bookmarks);
            provider.refresh();
            vscode.window.showInformationMessage(toReassign.length > 0
                ? `Category ${selectedCategory} has been removed and its bookmarks moved to Default.`
                : `Category ${selectedCategory} has been removed.`);
        }
    });

    reg('moveBookmark', async (item, selection) => {
        const categories = store.get('categories', []);
        const ids = idsFromArgs(item, selection);
        let bookmarks = store.get('bookmarks', []);
        let targets;
        if (ids.length > 0) {
            targets = bookmarks.filter(b => ids.includes(b.id));
        } else {
            const selected = await vscode.window.showQuickPick(bookmarks.map(b => b.displayName), { placeHolder: 'Select a bookmark to move' });
            targets = bookmarks.filter(b => b.displayName === selected);
        }
        if (targets.length === 0) return;
        const currentCat = targets[0].category;
        const otherCats = sortedCategories(categories).filter(c => c !== currentCat);
        if (otherCats.length < 1) {
            vscode.window.showInformationMessage(`There are no other categories to move to.`);
            return;
        }
        const selectedCategory = await vscode.window.showQuickPick(otherCats, { placeHolder: `Move ${targets.length} bookmark(s) to category` });
        if (!selectedCategory) return;
        bookmarks = store.get('bookmarks', []);
        const idSet = new Set(targets.map(t => t.id));
        for (const b of bookmarks) if (idSet.has(b.id)) b.category = selectedCategory;
        await store.update('bookmarks', bookmarks);
        provider.refresh();
        vscode.window.showInformationMessage(`Moved ${targets.length} bookmark(s) to ${selectedCategory}.`);
    });

    // --- search: QuickPick showing id + dual-emoji status, matches label/id/detail ---
    async function locateBookmark(bookmarkId) {
        const bookmarks = store.get('bookmarks', []);
        const bookmark = bookmarks.find(b => b.id === bookmarkId);
        if (!bookmark) return;

        if (provider.groupBy !== 'category') await setGroupBy('category');

        const decorated = decorateBookmark(bookmark, computeInstalledSet());
        if (!passesFilter(decorated, provider.statusFilter)) {
            provider.statusFilter = 'all';
            await store.update('statusFilter', 'all');
            await vscode.commands.executeCommand('setContext', `${NS}.filter`, 'all');
            provider.refresh();
            logInfo(`Changed filter to All to reveal ${bookmark.id}`);
        }

        await vscode.commands.executeCommand('extensionsBookmarkView.focus');
        const categoryItem = provider.getCategoryItem(bookmark.category);
        await treeView.reveal(categoryItem, { expand: true });
        const bookmarkItem = provider.getBookmarkItem(bookmark, undefined, `category:${bookmark.category}`);
        await treeView.reveal(bookmarkItem, { select: true, focus: true });
        details.show(bookmark.id);
    }

    reg('searchBookmarks', async () => {
        const bookmarks = store.get('bookmarks', []);
        const installedSet = computeInstalledSet();
        const decorated = bookmarks
            .map(bm => decorateBookmark(bm, installedSet))
            .filter(d => passesFilter(d, provider.statusFilter));

        const items = decorated.map(d => ({
            id: d.bookmark.id,
            label: d.bookmark.displayName,
            description: d.bookmark.id,
            detail: `${d.bookmark.id} · ${statusDescription(d)}`,
        })).sort((a, b) => a.label.localeCompare(b.label));

        const quickPick = vscode.window.createQuickPick();
        quickPick.items = items;
        quickPick.placeholder = 'Enter a bookmark name or id';
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;
        quickPick.onDidChangeValue(value => {
            const q = value.toLowerCase();
            quickPick.items = value
                ? items.filter(it =>
                    it.label.toLowerCase().includes(q) ||
                    it.id.toLowerCase().includes(q) ||
                    it.detail.toLowerCase().includes(q))
                : items;
        });
        quickPick.onDidAccept(async () => {
            const selected = quickPick.selectedItems[0];
            if (selected) {
                logInfo(`Locating bookmark from search: ${selected.id}`);
                try { await locateBookmark(selected.id); }
                catch (error) {
                    logError(`Failed to locate bookmark ${selected.id}`, error);
                    details.show(selected.id);
                }
            }
            quickPick.hide();
        });
        quickPick.show();
    });

    // --- sort by (submenu; one command per option + Current marker) ---
    const CTX_SORT = `${NS}.sort`;
    async function setSort(value) {
        await store.update('sortingOption', value);
        await vscode.commands.executeCommand('setContext', CTX_SORT, value);
        provider.refresh();
    }
    reg('sortAZ', () => setSort('A-Z'));
    reg('sortZA', () => setSort('Z-A'));
    reg('sortNewOld', () => setSort('New-Old'));
    reg('sortOldNew', () => setSort('Old-New'));
    reg('sortWanted', () => setSort('Wanted'));
    reg('sortUnwanted', () => setSort('Unwanted'));
    reg('sortInstalled', () => setSort('Installed'));
    reg('sortMissing', () => setSort('Missing'));
    reg('sortAZCurrent', () => setSort('A-Z'));
    reg('sortZACurrent', () => setSort('Z-A'));
    reg('sortNewOldCurrent', () => setSort('New-Old'));
    reg('sortOldNewCurrent', () => setSort('Old-New'));
    reg('sortWantedCurrent', () => setSort('Wanted'));
    reg('sortUnwantedCurrent', () => setSort('Unwanted'));
    reg('sortInstalledCurrent', () => setSort('Installed'));
    reg('sortMissingCurrent', () => setSort('Missing'));

    // --- note editing: single InputBox flow (add/edit/remove converge here) ---
    async function editNoteFlow(bookmark) {
        if (!bookmark) return;
        const value = await vscode.window.showInputBox({
            title: `Note — ${bookmark.displayName}`,
            prompt: 'Add your personal note (clear to remove)',
            value: bookmark.note ?? '',
        });
        if (value === undefined) return; // Esc cancelled
        const trimmed = value.trim();
        if (trimmed) bookmark.note = trimmed;
        else delete bookmark.note;
        const bookmarks = store.get('bookmarks', []);
        const idx = bookmarks.findIndex(b => b.id === bookmark.id);
        if (idx > -1) {
            if (trimmed) bookmarks[idx].note = trimmed;
            else delete bookmarks[idx].note;
            await store.update('bookmarks', bookmarks);
            provider.refresh();
            details.refresh();
        }
    }

    async function pickBookmark(placeHolder) {
        const bookmarks = store.get('bookmarks', []);
        const sorted = bookmarks.slice().sort((a, b) => a.displayName.localeCompare(b.displayName));
        const selected = await vscode.window.showQuickPick(sorted.map(b => b.displayName), { placeHolder });
        return sorted.find(b => b.displayName === selected);
    }

    reg('addNote', async (item) => {
        const bookmark = item
            ? store.get('bookmarks', []).find(b => b.id === idFromItem(item))
            : await pickBookmark('Select a bookmark to add a note');
        if (bookmark) await editNoteFlow(bookmark);
    });
    reg('editNote', async (item) => {
        const bookmark = item
            ? store.get('bookmarks', []).find(b => b.id === idFromItem(item))
            : await pickBookmark('Select a bookmark to edit a note');
        if (bookmark) await editNoteFlow(bookmark);
    });
    reg('removeNote', async (item) => {
        const bookmark = item
            ? store.get('bookmarks', []).find(b => b.id === idFromItem(item))
            : await pickBookmark('Select a bookmark to remove a note');
        if (!bookmark) return;
        if (bookmark.note) {
            delete bookmark.note;
            const bookmarks = store.get('bookmarks', []);
            const idx = bookmarks.findIndex(b => b.id === bookmark.id);
            if (idx > -1) delete bookmarks[idx].note;
            await store.update('bookmarks', bookmarks);
            provider.refresh();
            details.refresh();
            vscode.window.showInformationMessage(`Note has been removed from ${bookmark.displayName}.`);
        } else {
            vscode.window.showInformationMessage(`Bookmark ${bookmark.displayName} does not have a note.`);
        }
    });

    reg('viewDetails', async (item) => {
        let id;
        if (item) id = idFromItem(item);
        else {
            const bookmark = await pickBookmark('Select a bookmark to view details');
            id = bookmark && bookmark.id;
        }
        if (id) details.show(id);
    });

    // --- Details-only commands ---
    reg('copyDetailValue', async (value) => {
        if (value === undefined || value === null) return;
        await vscode.env.clipboard.writeText(String(value));
        const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
        sb.text = `$(check) Copied: ${String(value).slice(0, 40)}`;
        sb.show();
        setTimeout(() => sb.dispose(), 1500);
    });

    reg('editNoteFromDetails', async (bookmarkId) => {
        const bookmark = lookupBookmark(bookmarkId);
        if (!bookmark || bookmark.extra) return; // extras have no note
        const current = store.get('bookmarks', []).find(b => b.id === bookmarkId);
        if (current) await editNoteFlow(current);
    });

    // --- import / export / remove all (no tags) ---
    reg('importData', async () => {
        const filePath = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'JSON': ['json'] } });
        if (!filePath || !filePath[0]) return;
        fs.readFile(filePath[0].fsPath, (err, data) => {
            if (err) { vscode.window.showErrorMessage(`Failed to import data: ${err}`); return; }
            try {
                const parsed = JSON.parse(data);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.categories || !parsed.bookmarks) {
                    vscode.window.showErrorMessage('Invalid data structure. The file should contain an object with "categories" and "bookmarks" arrays.');
                    return;
                }
                const { categories: importedCategories = [], bookmarks: importedBookmarks = [] } = parsed;
                const existingCategories = store.get('categories', []);
                const existingBookmarks = store.get('bookmarks', []);
                const mergedCategories = [...new Set([...existingCategories, ...importedCategories])];
                const mergedBookmarks = [...existingBookmarks, ...importedBookmarks.filter(b =>
                    !existingBookmarks.some(e => e.id === b.id))];
                Promise.all([
                    store.update('categories', mergedCategories),
                    store.update('bookmarks', mergedBookmarks)
                ]).then(() => {
                    provider.refresh();
                    vscode.window.showInformationMessage(`Data has been imported from ${filePath[0].fsPath}`);
                }).catch(e => vscode.window.showErrorMessage(`Failed to update data: ${e}`));
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to parse data: ${e}`);
            }
        });
    });

    reg('exportData', async () => {
        const categories = store.get('categories', []);
        const bookmarks = store.get('bookmarks', []);
        if ((categories.length === 1 && categories[0] === 'Default') && bookmarks.length === 0) {
            vscode.window.showInformationMessage('No data to export.');
            return;
        }
        const data = { categories, bookmarks };
        const filePath = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(require('os').homedir(), 'extensions-bookmark-data.json')) });
        if (!filePath) return;
        fs.writeFile(filePath.fsPath, JSON.stringify(data, null, 2), (err) => {
            if (err) vscode.window.showErrorMessage(`Failed to export data: ${err}`);
            else vscode.window.showInformationMessage(`Data has been exported to ${filePath.fsPath}`);
        });
    });

    reg('removeAllData', async () => {
        const categories = store.get('categories', []);
        const bookmarks = store.get('bookmarks', []);
        if ((categories.length === 1 && categories[0] === 'Default') && bookmarks.length === 0) {
            vscode.window.showInformationMessage('No data to remove.');
            return;
        }
        const confirmation = await vscode.window.showInputBox({ prompt: 'Type "remove all data" to confirm' });
        if (confirmation === 'remove all data') {
            await store.update('categories', ['Default']);
            await store.update('bookmarks', []);
            provider.refresh();
            details.show(null);
            vscode.window.showInformationMessage('All data has been removed.');
        } else {
            vscode.window.showInformationMessage('Data removal cancelled.');
        }
    });

    // --- inline action buttons on each bookmark row (forward to the commands above) ---
    // wanted row shows ⭐ → toggle to unwanted; unwanted row shows 🚫 → toggle to wanted.
    reg('inlineWanted', (item, selection) => vscode.commands.executeCommand(cmd('toggleWanted'), item, selection));
    reg('inlineUnwanted', (item, selection) => vscode.commands.executeCommand(cmd('toggleWanted'), item, selection));
    // installed row shows ✅ → uninstall; missing row shows ❌ → install.
    reg('inlineInstalled', (item, selection) => vscode.commands.executeCommand(cmd('uninstallSelected'), item, selection));
    reg('inlineMissing', (item, selection) => vscode.commands.executeCommand(cmd('installSelected'), item, selection));

    return subs;
}

module.exports = { registerCommands };
