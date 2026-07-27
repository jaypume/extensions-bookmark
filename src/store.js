'use strict';

// File-backed store for extensions-bookmark data.
// Keeps bookmarks/categories/sortingOption in a standalone JSON file under the
// extension's globalStorage directory, instead of polluting settings.json.
// Mirrors the subset of vscode.WorkspaceConfiguration the extension uses:
// get(key, fallback) and update(key, value).
//
// Module-level singleton: call init(context) once in activate(), then use
// get()/update() anywhere. The data file lives at <globalStorageUri>/data.json.

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const DATA_FILE = 'data.json';
const SCHEMA_VERSION = 2;

const GROUP_BY_VALUES = ['recent', 'category', 'wanted', 'installed', 'age', 'flat'];
const SORTING_VALUES = ['A-Z', 'Z-A', 'New-Old', 'Old-New', 'Wanted', 'Unwanted', 'Installed', 'Missing'];
const FILTER_VALUES = ['all', 'installed', 'uninstalled', 'wanted', 'unwanted', 'no-category', 'added-1d', 'added-1w', 'added-1m', 'input'];

const DEFAULTS = {
    schemaVersion: SCHEMA_VERSION,
    categories: ['Default'],
    bookmarks: [],
    sortingOption: 'A-Z',
    groupBy: 'category',       // 'category' | 'status' | 'flat'
    statusFilter: 'all',
    inputQuery: '',
    statusFilterVersion: 1
};

// Keys previously stored in settings.json; migrated once then cleared.
// NOTE: 'tags' is intentionally absent — legacy tag data is dropped on migrate.
const LEGACY_KEYS = ['categories', 'bookmarks', 'sortingOption', 'groupBy', 'viewMode', 'statusFilter', 'statusFilterVersion'];

let file = null; // absolute path to the data file, set by init()

function init(context) {
    file = path.join(context.globalStorageUri.fsPath, DATA_FILE);
    console.log('[extensions-bookmark] store path:', file);
}

function isGroupBy(v) { return typeof v === 'string' && GROUP_BY_VALUES.includes(v); }
function isSorting(v) { return typeof v === 'string' && SORTING_VALUES.includes(v); }
function isFilter(v) { return typeof v === 'string' && FILTER_VALUES.includes(v); }

/** Strip the deprecated per-bookmark `tags` array and keep the clean shape. */
function cleanBookmark(bm) {
    if (!bm || typeof bm !== 'object') return undefined;
    const out = { ...bm };
    delete out.tags;
    return out;
}

/** Read+normalize the whole state, falling back to defaults. */
function read() {
    if (!file) return cloneDefaults();
    try {
        if (fs.existsSync(file)) {
            return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
        }
    } catch (e) {
        console.warn('[extensions-bookmark] read store failed:', e);
    }
    return cloneDefaults();
}

function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULTS));
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

/** Persist the whole state atomically. Bookmarks are sorted by id for a
 *  stable, diff-friendly file; other arrays (e.g. categories) keep insertion order. */
function write(state) {
    if (!file) return;
    try {
        const sorted = sortKeys(state);
        if (Array.isArray(sorted.bookmarks)) {
            sorted.bookmarks = sorted.bookmarks
                .slice()
                .sort((a, b) => String(a?.id || '').localeCompare(String(b?.id || '')));
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
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
 * One-time migration from settings.json → file store. Runs only when the data
 * file does not yet exist. Legacy keys are cleared from settings.json afterwards.
 */
function migrate() {
    if (!file || fs.existsSync(file)) {
        console.log('[extensions-bookmark] migrate: skip (already initialized)');
        return Promise.resolve();
    }

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

/**
 * Schema migration on load: when the stored schemaVersion is older than the
 * current one, re-write the normalized state once. normalize() drops tags and
 * renames viewMode → groupBy, so this transparently upgrades old data files.
 */
function migrateStoredState() {
    if (!file || !fs.existsSync(file)) return;
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw.schemaVersion !== SCHEMA_VERSION) {
            console.log(`[extensions-bookmark] migrating store schema ${raw.schemaVersion} → ${SCHEMA_VERSION}`);
            write(normalize(raw));
        }
    } catch (e) {
        console.warn('[extensions-bookmark] schema migration failed:', e);
    }
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
    const out = cloneDefaults();
    if (Array.isArray(o.categories)) out.categories = o.categories;
    if (Array.isArray(o.bookmarks)) {
        out.bookmarks = o.bookmarks.map(cleanBookmark).filter(Boolean);
    }
    if (isSorting(o.sortingOption)) out.sortingOption = o.sortingOption;
    // Accept both new `groupBy` and legacy `viewMode` ('by-category' etc.).
    const gb = o.groupBy ?? mapLegacyViewMode(o.viewMode);
    if (isGroupBy(gb)) out.groupBy = gb;
    if (o.statusFilterVersion === 1 && isFilter(o.statusFilter)) {
        out.statusFilter = o.statusFilter;
    }
    if (typeof o.inputQuery === 'string') out.inputQuery = o.inputQuery;
    return out;
}

function mapLegacyViewMode(v) {
    switch (v) {
        case 'by-category': return 'category';
        case 'by-status': return 'wanted';
        case 'flat': return 'flat';
        default: return undefined;
    }
}

module.exports = {
    init, migrate, migrateStoredState, read, write, get, update, normalize,
    DEFAULTS, SCHEMA_VERSION
};
