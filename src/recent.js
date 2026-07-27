'use strict';

// Recently-touched bookmark history. Tracks the last N extension ids the user
// acted on (install/uninstall/remove/toggle/...), newest first. Kept in a
// standalone file under globalStorage so it never pollutes data.json and is
// not synced. Resolved lazily after init(context).

const fs = require('fs');
const path = require('path');

const FILE = 'recent.json';
const LIMIT = 20;

let file = null;

function init(context) {
    file = path.join(context.globalStorageUri.fsPath, FILE);
}

function read() {
    if (!file) return [];
    try {
        if (fs.existsSync(file)) {
            const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (Array.isArray(arr)) return arr;
        }
    } catch (e) {
        console.warn('[extensions-bookmark] read recent failed:', e);
    }
    return [];
}

function write(list) {
    if (!file) return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
    } catch (e) {
        console.warn('[extensions-bookmark] write recent failed:', e);
    }
}

/**
 * Record that `id` was just touched. Moves it to the front (dedup), caps at
 * LIMIT. Returns the new list.
 */
function touch(id) {
    if (!id) return read();
    const lower = String(id).toLowerCase();
    const list = read().filter(entry => String(entry.id).toLowerCase() !== lower);
    list.unshift({ id: String(id), at: new Date().toISOString() });
    const capped = list.slice(0, LIMIT);
    write(capped);
    return capped;
}

/** Newer entries first. */
function list() {
    return read();
}

module.exports = { init, touch, list, LIMIT };
