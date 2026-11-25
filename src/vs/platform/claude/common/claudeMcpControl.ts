/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { removeClaudeSecrets } from './claudeSecretScan.js';

/**
 * MCP servers: reconnect, turn off and on, and their logs (issue 512). The
 * controls go through the running session's Claude Code query; the logs are the
 * JSONL files Claude Code writes per server and run under its cache folder.
 */
export type ClaudeMcpControlAction = 'reconnect' | 'enable' | 'disable';

/** The output channel Show Logs fills with one server's log. */
export const CLAUDE_MCP_LOG_CHANNEL_ID = 'claudeMcpLogs';

/** Lines of a log Show Logs keeps, from the end. */
export const CLAUDE_MCP_LOG_MAX_LINES = 400;

/** One server's newest log, read for Show Logs. */
export interface ClaudeMcpLog {
	/** The file it came from; absent when Claude Code wrote none for this server. */
	readonly file?: string;
	readonly lines: readonly string[];
}

/** Claude Code's cache folder (`env-paths('claude-cli')`): where it keeps MCP logs. */
export function claudeCacheRoot(platform: string, home: string, env: Readonly<Record<string, string | undefined>>): string {
	if (platform === 'darwin') {
		return `${home}/Library/Caches/claude-cli-nodejs`;
	}
	if (platform === 'win32') {
		return `${env.LOCALAPPDATA || `${home}\\AppData\\Local`}\\claude-cli-nodejs\\Cache`;
	}
	return `${env.XDG_CACHE_HOME || `${home}/.cache`}/claude-cli-nodejs`;
}

/** How Claude Code names a folder after a path or a server: every character but a letter or digit becomes `-`. */
export function claudeCacheName(value: string): string {
	return value.replace(/[^a-zA-Z0-9]/g, '-');
}

/** `<project folder>/mcp-logs-<server>` under the cache root, as a relative path. */
export function claudeMcpLogFolder(cwd: string, server: string): string {
	return `${claudeCacheName(cwd)}/mcp-logs-${claudeCacheName(server)}`;
}

/**
 * One log line for people: `<time> [<level>] <message>` from Claude Code's JSONL
 * (`{ debug | info | error, timestamp }`), with secrets removed. A line that is not
 * that JSON is kept as it is.
 */
export function formatClaudeMcpLogLine(line: string): string | undefined {
	const text = line.trim();
	if (!text) {
		return undefined;
	}
	let entry: Record<string, unknown> | undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		entry = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined;
	} catch {
		entry = undefined;
	}
	if (!entry) {
		return removeClaudeSecrets(text);
	}
	const level = ['error', 'warn', 'info', 'debug'].find(key => typeof entry![key] === 'string');
	const message = level ? String(entry[level]) : JSON.stringify(entry);
	const time = typeof entry.timestamp === 'string' ? entry.timestamp : '';
	return removeClaudeSecrets(`${time}${time ? ' ' : ''}[${level ?? 'log'}] ${message}`);
}
