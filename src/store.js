'use strict';

// Backing store for extensions-bookmark.
//   data.json — synced data: schemaVersion, categories, bookmarks (sorted by id)
// Session state (groupBy, sortingOption, statusFilter, inputQuery) is kept
// purely in-memory — it resets to defaults on window reload and never touches
// disk, so it can't pollute version control.
//
// Module-level singleton: call init(context) once in activate(), then use
// get()/update() anywhere.

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const DATA_FILE = 'data.json';
const SCHEMA_VERSION = 2;

const GROUP_BY_VALUES = ['recent', 'category', 'wanted', 'installed', 'age', 'flat'];
const SORTING_VALUES = ['A-Z', 'Z-A', 'New-Old', 'Old-New', 'Wanted', 'Unwanted', 'Installed', 'Missing'];
const FILTER_VALUES = ['all', 'installed', 'uninstalled', 'wanted', 'unwanted', 'no-category', 'added-1d', 'added-1w', 'added-1m', 'input'];

// Keys persisted to data.json.
const DATA_KEYS = new Set(['schemaVersion', 'categories', 'bookmarks']);
// In-memory session keys (never persisted).
const STATE_KEYS = new Set(['sortingOption', 'groupBy', 'statusFilter', 'inputQuery']);

const DATA_DEFAULTS = {
    schemaVersion: SCHEMA_VERSION,
    categories: ['Default'],
    bookmarks: []
};
const STATE_DEFAULTS = {
    sortingOption: 'A-Z',
    groupBy: 'category',
    statusFilter: 'all',
    inputQuery: ''
};

// Keys previously stored in settings.json; migrated once then cleared.
const LEGACY_KEYS = ['categories', 'bookmarks', 'sortingOption', 'groupBy', 'viewMode', 'statusFilter', 'statusFilterVersion'];

let dataFile = null;
// In-memory session state, initialized at activate() and never written to disk.
const memoryState = { ...STATE_DEFAULTS };

function init(context) {
    dataFile = path.join(context.globalStorageUri.fsPath, DATA_FILE);
    Object.assign(memoryState, STATE_DEFAULTS);
    console.log('[extensions-bookmark] data path:', dataFile);
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

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
        return Object.keys(value)
            .sort((a, b) => a.localeCompare(b))
            .reduce((sorted, key) => { sorted[key] = sortKeys(value[key]); return sorted; }, {});
    }
    return value;
}

/** Read+normalize data.json (bookmarks/categories). */
function readData() {
    if (!dataFile) return clone(DATA_DEFAULTS);
    try {
        if (fs.existsSync(dataFile)) return normalizeData(JSON.parse(fs.readFileSync(dataFile, 'utf8')));
    } catch (e) {
        console.warn('[extensions-bookmark] read data failed:', e);
    }
    return clone(DATA_DEFAULTS);
}

/** Combined view: data.json + in-memory session state. */
function read() {
    return { ...readData(), ...memoryState };
}

/** Persist data.json; bookmarks sorted by id for a stable, diff-friendly file. */
function write(merged) {
    if (!dataFile) return;
    const data = {};
    for (const k of Object.keys(DATA_DEFAULTS)) if (k in merged) data[k] = merged[k];
    if (data.schemaVersion === undefined) data.schemaVersion = SCHEMA_VERSION;
    try {
        const sorted = sortKeys(data);
        if (Array.isArray(sorted.bookmarks)) {
            sorted.bookmarks = sorted.bookmarks
                .slice()
                .sort((a, b) => String(a?.id || '').localeCompare(String(b?.id || '')));
        }
        fs.mkdirSync(path.dirname(dataFile), { recursive: true });
        fs.writeFileSync(dataFile, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
    } catch (e) {
        console.warn('[extensions-bookmark] write data failed:', e);
    }
}

function writeData(data) { write(data); }

function get(key, fallback) {
    if (STATE_KEYS.has(key)) {
        const v = memoryState[key];
        return v === undefined ? fallback : v;
    }
    const v = readData()[key];
    return v === undefined ? fallback : v;
}

function update(key, value /*, target ignored */) {
    if (STATE_KEYS.has(key)) {
        memoryState[key] = value;
        return Promise.resolve();
    }
    const data = readData();
    data[key] = value;
    writeData(data);
    return Promise.resolve();
}

/**
 * One-time migration from settings.json → file store. Runs only when data.json
 * does not yet exist. Legacy keys are cleared from settings.json afterwards.
 */
function migrate() {
    if (!dataFile || fs.existsSync(dataFile)) {
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
    // Only persist data keys; session keys would come from legacy settings.json
    // but we drop them now (in-memory defaults instead).
    write(legacy);
    return hasLegacy ? clearLegacy(cfg) : Promise.resolve();
}

/**
 * Schema migration: when data.json's schemaVersion is older than current,
 * re-normalize and drop any session-state keys that older versions persisted
 * into data.json (groupBy/sortingOption/statusFilter/inputQuery).
 */
function migrateStoredState() {
    if (!dataFile || !fs.existsSync(dataFile)) return;
    try {
        const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        let touched = false;
        // Drop any session-state keys leaked into data.json by older versions.
        for (const k of Object.keys(raw)) {
            if (STATE_KEYS.has(k)) { delete raw[k]; touched = true; }
        }
        if (raw.schemaVersion !== SCHEMA_VERSION) {
            console.log(`[extensions-bookmark] migrating data schema ${raw.schemaVersion} → ${SCHEMA_VERSION}`);
            Object.assign(raw, normalizeData(raw));
            touched = true;
        }
        if (touched) {
            raw.schemaVersion = SCHEMA_VERSION;
            writeData(raw);
            console.log('[extensions-bookmark] cleaned session keys from data.json');
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

function normalizeData(o) {
    const out = clone(DATA_DEFAULTS);
    if (Array.isArray(o.categories)) out.categories = o.categories;
    if (Array.isArray(o.bookmarks)) {
        out.bookmarks = o.bookmarks.map(cleanBookmark).filter(Boolean);
    }
    out.schemaVersion = SCHEMA_VERSION;
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

/** Combined normalize (back-compat for callers). */
function normalize(o) {
    const out = normalizeData(o);
    if (isSorting(o.sortingOption)) out.sortingOption = o.sortingOption;
    const gb = o.groupBy ?? mapLegacyViewMode(o.viewMode);
    if (isGroupBy(gb)) out.groupBy = gb;
    if (isFilter(o.statusFilter)) out.statusFilter = o.statusFilter;
    if (typeof o.inputQuery === 'string') out.inputQuery = o.inputQuery;
    return out;
}

module.exports = {
    init, migrate, migrateStoredState, read, write, get, update, normalize,
    DATA_DEFAULTS, STATE_DEFAULTS, SCHEMA_VERSION, memoryState
};
