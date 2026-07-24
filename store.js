'use strict';

// File-backed store for extensions-bookmark data.
// Keeps bookmarks/categories/tags/sortingOption in a standalone JSON file
// under the extension's globalStorage directory, instead of polluting
// settings.json. Mirrors the subset of vscode.WorkspaceConfiguration the
// extension uses: get(key, fallback) and update(key, value).
//
// Module-level singleton: call init(context) once in activate(), then use
// get()/update() anywhere. The data file lives at
//   <globalStorageUri>/data.json
// i.e. User/globalStorage/pujie.extensions-bookmark/data.json

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const DATA_FILE = 'data.json';

const DEFAULTS = {
    categories: ['Default'],
    bookmarks: [],
    tags: [],
    sortingOption: 'A-Z',
    viewMode: 'by-category',   // 'by-category' | 'by-status' | 'flat'
    statusFilter: 'recent',    // 'all' | 'recent' | 'installed' | 'not-wanted' | 'diff'
    statusFilterVersion: 1
};

// Keys previously stored in settings.json; migrated once then cleared.
const LEGACY_KEYS = Object.keys(DEFAULTS);

let file = null; // absolute path to the data file, set by init()

function init(context) {
    file = path.join(context.globalStorageUri.fsPath, DATA_FILE);
    console.log('[extensions-bookmark] store path:', file);
}

/** Read+normalize the whole state, falling back to defaults. */
function read() {
    if (!file) return { ...DEFAULTS };
    try {
        if (fs.existsSync(file)) {
            return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
        }
    } catch (e) {
        console.warn('[extensions-bookmark] read store failed:', e);
    }
    return { ...DEFAULTS };
}

function sortKeys(value) {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }
    if (value && typeof value === 'object') {
        return Object.keys(value)
            .sort((a, b) => a.localeCompare(b))
            .reduce((sorted, key) => {
                sorted[key] = sortKeys(value[key]);
                return sorted;
            }, {});
    }
    return value;
}

/** Persist the whole state atomically. */
function write(state) {
    if (!file) return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(sortKeys(state), null, 2)}\n`, 'utf8');
    } catch (e) {
        console.warn('[extensions-bookmark] write store failed:', e);
    }
}

function get(key, fallback) {
    const v = read()[key];
    return v === undefined ? fallback : v;
}

function update(key, value /*, target ignored */) {
    const state = read();
    state[key] = value;
    write(state);
    return Promise.resolve();
}

/**
 * One-time migration from settings.json → file store. Runs only when the
 * data file does not yet exist. Legacy keys are cleared from settings.json
 * afterwards so they no longer pollute it. Returns a Promise (clearing the
 * keys is async); the data file itself is written synchronously before it
 * resolves, so reads are safe immediately after.
 */
function migrate() {
    if (!file || fs.existsSync(file)) {
        console.log('[extensions-bookmark] migrate: skip (already initialized)');
        return Promise.resolve(); // already initialized
    }

    // Legacy data was stored under the 'extension-bookmarker' config section
    // (the original fork's id). Keep this literal so existing settings.json
    // data is picked up; the extension's own settings schema was removed.
    const cfg = vscode.workspace.getConfiguration('extension-bookmarker');
    const legacy = {};
    let hasLegacy = false;
    for (const k of LEGACY_KEYS) {
        const v = cfg.get(k, undefined);
        if (v !== undefined) { legacy[k] = v; hasLegacy = true; }
    }
    console.log('[extensions-bookmark] migrate:', hasLegacy
        ? `found legacy data (${Object.keys(legacy).join(', ')})`
        : 'no legacy data, seeding defaults');
    write(normalize(hasLegacy ? legacy : {}));
    return hasLegacy ? clearLegacy(cfg) : Promise.resolve();
}

async function clearLegacy(cfg) {
    for (const k of LEGACY_KEYS) {
        try {
            const inspect = cfg.inspect(k);
            if (inspect && inspect.globalValue !== undefined) {
                await cfg.update(k, undefined, vscode.ConfigurationTarget.Global);
            }
        } catch (e) {
            console.warn(`[extensions-bookmark] failed to clear legacy key ${k}:`, e);
        }
    }
}

function normalize(o) {
    const out = { ...DEFAULTS };
    if (Array.isArray(o.categories)) out.categories = o.categories;
    if (Array.isArray(o.bookmarks)) out.bookmarks = o.bookmarks;
    if (Array.isArray(o.tags)) out.tags = o.tags;
    if (typeof o.sortingOption === 'string') out.sortingOption = o.sortingOption;
    if (typeof o.viewMode === 'string') out.viewMode = o.viewMode;
    if (o.statusFilterVersion === 1 && typeof o.statusFilter === 'string') {
        out.statusFilter = o.statusFilter;
    }
    return out;
}

module.exports = { init, migrate, read, write, get, update, DEFAULTS };
