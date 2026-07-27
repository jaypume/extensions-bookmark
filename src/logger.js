'use strict';

// Output channel + log helpers. Single shared channel, init() once in activate.

const vscode = require('vscode');

let outputChannel;

function initLogger(context) {
    outputChannel = vscode.window.createOutputChannel('Extensions Bookmark');
    context.subscriptions.push(outputChannel);
    return outputChannel;
}

function formatError(error) {
    if (!error) return '';
    return error.stack || error.message || String(error);
}

function logInfo(message) {
    const line = `[${new Date().toISOString()}] INFO ${message}`;
    outputChannel?.appendLine(line);
    console.log(`[extensions-bookmark] ${message}`);
}

function logError(message, error) {
    const detail = formatError(error);
    const line = `[${new Date().toISOString()}] ERROR ${message}${detail ? `\n${detail}` : ''}`;
    outputChannel?.appendLine(line);
    console.error(`[extensions-bookmark] ${message}`, error || '');
}

function showLog() {
    outputChannel?.show(true);
}

module.exports = { initLogger, logInfo, logError, showLog };
