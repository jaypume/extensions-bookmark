'use strict';

// Local bookmark-icon cache. TreeViews only consume local file URIs; remote
// Marketplace icons are refreshed in the background at most once per week.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const { fetchMarketplaceIcon, DEFAULT_ICON, MARKETPLACE_TIMEOUT_MS } = require('./marketplace');
const { logInfo, logError } = require('./logger');

const META_FILE = 'icon-cache.json';
const ICON_DIR = 'icons';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const MAX_ICON_SIZE = 5 * 1024 * 1024;
const REFRESH_CONCURRENCY = 4;
const ALLOWED_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp']);

let cacheDir = null;
let metaFile = null;
let extensionUri = null;
let entries = {};
let installedVersions = new Map();
const inflight = new Map();
const failedThisSession = new Set();

function installedSnapshot() {
    return new Map(vscode.extensions.all.map(extension => [
        extension.id.toLowerCase(),
        installedSignature(extension)
    ]));
}

function installedSignature(extension) {
    const icon = localIconSource(extension);
    let iconStamp = '';
    if (icon) {
        try {
            const stat = fs.statSync(vscode.Uri.parse(icon).fsPath);
            iconStamp = `${stat.size}:${stat.mtimeMs}`;
        } catch (_) { /* a missing local icon will be handled during refresh */ }
    }
    return `${extension.packageJSON?.version || ''}:${extension.extensionUri.fsPath}:${iconStamp}`;
}

function init(context) {
    cacheDir = path.join(context.globalStorageUri.fsPath, ICON_DIR);
    metaFile = path.join(context.globalStorageUri.fsPath, META_FILE);
    extensionUri = context.extensionUri;
    entries = readEntries();
    installedVersions = installedSnapshot();
    failedThisSession.clear();
}

function readEntries() {
    if (!metaFile) return {};
    try {
        if (!fs.existsSync(metaFile)) return {};
        const value = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        return value && typeof value.entries === 'object' ? value.entries : {};
    } catch (error) {
        logError('Failed to read icon cache metadata', error);
        return {};
    }
}

function writeEntries() {
    if (!metaFile) return;
    try {
        fs.mkdirSync(path.dirname(metaFile), { recursive: true });
        fs.writeFileSync(metaFile, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8');
    } catch (error) {
        logError('Failed to write icon cache metadata', error);
    }
}

function cacheKey(id) {
    return String(id || '').toLowerCase();
}

function cachedUri(bookmark) {
    if (!bookmark) return undefined;
    if (bookmark.icon === DEFAULT_ICON && extensionUri) {
        return vscode.Uri.joinPath(extensionUri, 'media', 'default-bookmark-icon.png');
    }
    const entry = entries[cacheKey(bookmark.id)];
    if (!entry?.file || !cacheDir) return undefined;
    if (path.basename(entry.file) !== entry.file) return undefined;
    const file = path.join(cacheDir, entry.file);
    return fs.existsSync(file) ? vscode.Uri.file(file) : undefined;
}

function isDue(bookmark, now = Date.now()) {
    const key = cacheKey(bookmark?.id);
    if (failedThisSession.has(key)) return false;
    const checkedAt = new Date(entries[key]?.checkedAt || 0).getTime();
    return !Number.isFinite(checkedAt) || now - checkedAt >= MAX_AGE;
}

function findInstalled(id) {
    const key = cacheKey(id);
    return vscode.extensions.all.find(extension => extension.id.toLowerCase() === key);
}

function localIconSource(extension) {
    const icon = extension?.packageJSON?.icon;
    return icon ? vscode.Uri.joinPath(extension.extensionUri, icon).toString() : undefined;
}

function extensionFor(source, contentType = '') {
    try {
        const ext = path.extname(vscode.Uri.parse(source).path).toLowerCase();
        if (ALLOWED_EXTENSIONS.has(ext)) return ext;
    } catch (_) { /* fall through */ }
    if (contentType.includes('svg')) return '.svg';
    if (contentType.includes('webp')) return '.webp';
    if (contentType.includes('gif')) return '.gif';
    if (contentType.includes('jpeg')) return '.jpg';
    return '.png';
}

async function readSource(source) {
    const uri = vscode.Uri.parse(source);
    if (uri.scheme === 'file') {
        return { bytes: fs.readFileSync(uri.fsPath), contentType: '' };
    }
    if (uri.scheme !== 'http' && uri.scheme !== 'https') {
        throw new Error(`Unsupported icon URI scheme: ${uri.scheme}`);
    }
    const axios = require('axios');
    const response = await axios.get(source, {
        responseType: 'arraybuffer',
        timeout: MARKETPLACE_TIMEOUT_MS,
        maxContentLength: MAX_ICON_SIZE,
        maxBodyLength: MAX_ICON_SIZE
    });
    return {
        bytes: Buffer.from(response.data),
        contentType: String(response.headers?.['content-type'] || '')
    };
}

async function cacheSource(bookmark, source) {
    const key = cacheKey(bookmark.id);
    const { bytes, contentType } = await readSource(source);
    if (bytes.length > MAX_ICON_SIZE) throw new Error(`Icon exceeds ${MAX_ICON_SIZE} bytes`);

    const ext = extensionFor(source, contentType);
    const stem = crypto.createHash('sha256').update(key).digest('hex').slice(0, 20);
    const fileName = `${stem}${ext}`;
    const target = path.join(cacheDir, fileName);
    const temp = `${target}.${process.pid}.tmp`;
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(temp, bytes);
    fs.renameSync(temp, target);

    const previousFile = entries[key]?.file;
    entries[key] = {
        checkedAt: new Date().toISOString(),
        file: fileName,
        source
    };
    if (previousFile && previousFile !== fileName) {
        try {
            if (path.basename(previousFile) === previousFile) {
                fs.unlinkSync(path.join(cacheDir, previousFile));
            }
        }
        catch (_) { /* stale cache cleanup is best-effort */ }
    }
    return true;
}

async function refreshBookmark(bookmark, options = {}) {
    if (!bookmark?.id || !cacheDir) return false;
    const key = cacheKey(bookmark.id);
    const force = options.force === true;
    const persist = options.persist !== false;
    if (!force && !isDue(bookmark)) return false;
    if (inflight.has(key)) return inflight.get(key);

    const task = (async () => {
        const previous = entries[key] ? { ...entries[key] } : undefined;
        entries[key] = {
            ...entries[key],
            checkedAt: new Date().toISOString()
        };
        try {
            const installed = findInstalled(bookmark.id);
            let source = localIconSource(installed);
            if (!source && options.refreshSource) {
                source = await fetchMarketplaceIcon(bookmark.id);
            }
            if (!source) source = bookmark.icon;
            if (!source || source === DEFAULT_ICON) {
                failedThisSession.delete(key);
                return false;
            }
            const changed = await cacheSource(bookmark, source);
            failedThisSession.delete(key);
            return changed;
        } catch (error) {
            if (previous) entries[key] = previous;
            else delete entries[key];
            failedThisSession.add(key);
            if (options.onError) options.onError(error);
            else logError(`Failed to refresh icon for ${bookmark.id}`, error);
            return false;
        } finally {
            if (persist) writeEntries();
        }
    })().finally(() => inflight.delete(key));

    inflight.set(key, task);
    return task;
}

async function refreshBookmarks(bookmarks, options = {}) {
    const queue = (bookmarks || []).filter(bookmark =>
        bookmark?.id && (options.force === true || isDue(bookmark)));
    if (queue.length === 0) return false;

    let cursor = 0;
    let refreshed = 0;
    const failures = new Map();
    const worker = async () => {
        while (cursor < queue.length) {
            const bookmark = queue[cursor++];
            const onError = (error) => {
                const code = String(error?.code || 'error');
                failures.set(code, (failures.get(code) || 0) + 1);
            };
            if (await refreshBookmark(bookmark, { ...options, persist: false, onError })) {
                refreshed++;
            }
        }
    };

    const workers = Array.from(
        { length: Math.min(REFRESH_CONCURRENCY, queue.length) },
        () => worker()
    );
    await Promise.all(workers);
    writeEntries();
    const failed = [...failures.values()].reduce((sum, count) => sum + count, 0);
    if (refreshed > 0 || failed > 0) {
        const reasons = [...failures].map(([code, count]) => `${code}: ${count}`).join(', ');
        const retry = failed > 0 ? '; failed icons will retry after restart' : '';
        logInfo(`Icon cache refresh: ${refreshed} cached, ${failed} skipped${reasons ? ` (${reasons})` : ''}${retry}`);
    }
    return refreshed > 0;
}

function refreshStale(bookmarks) {
    return refreshBookmarks(bookmarks, { refreshSource: true });
}

async function refreshInstalledChanges(bookmarks) {
    const next = installedSnapshot();
    const changedIds = new Set();
    for (const [id, version] of next) {
        if (installedVersions.get(id) !== version) changedIds.add(id);
    }
    installedVersions = next;
    const changedBookmarks = (bookmarks || []).filter(bookmark => changedIds.has(cacheKey(bookmark.id)));
    return refreshBookmarks(changedBookmarks, { force: true });
}

module.exports = {
    init,
    cachedUri,
    isDue,
    refreshBookmark,
    refreshBookmarks,
    refreshStale,
    refreshInstalledChanges,
    MAX_AGE,
    REFRESH_CONCURRENCY
};
