'use strict';

// 本地 UI 偏好持久化（ui-state.json）。
//   存 groupBy / sortingOption / statusFilter / inputQuery / treeExpanded 等
//   session 状态，让窗口重载后恢复上次选择。与 recent.json 一样放在
//   globalStorage 下——不进 data.json（同步数据）、不参与 Settings Sync。
//
// Module-level singleton: init(context) 一次，之后 load()/set() 任意调用。

const fs = require('fs');
const path = require('path');

const FILE = 'ui-state.json';
const KEYS = new Set(['groupBy', 'sortingOption', 'statusFilter', 'inputQuery', 'expandedNodes']);

let file = null;

function init(context) {
    file = path.join(context.globalStorageUri.fsPath, FILE);
}

/** 读取并仅保留已知 key；失败返回 {}。 */
function read() {
    if (!file) return {};
    try {
        if (fs.existsSync(file)) {
            const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (obj && typeof obj === 'object') {
                const out = {};
                for (const k of KEYS) if (k in obj) out[k] = obj[k];
                return out;
            }
        }
    } catch (e) {
        console.warn('[extensions-bookmark] read ui-state failed:', e);
    }
    return {};
}

function write(state) {
    if (!file) return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } catch (e) {
        console.warn('[extensions-bookmark] write ui-state failed:', e);
    }
}

/** 全量读取（用于 init 时 merge 进内存默认值）。 */
function load() {
    return read();
}

function get(key, fallback) {
    const v = read()[key];
    return v === undefined ? fallback : v;
}

/** 合并写入单个 key（仅限已知 key）。 */
function set(key, value) {
    if (!KEYS.has(key)) return;
    const next = { ...read(), [key]: value };
    const cleaned = {};
    for (const k of KEYS) if (k in next) cleaned[k] = next[k];
    write(cleaned);
}

module.exports = { init, load, get, set, KEYS };
