/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { join } from '../../../base/common/path.js';
import { CLAUDE_MCP_LOG_MAX_LINES, claudeCacheName, claudeMcpLogFolder, ClaudeMcpLog, formatClaudeMcpLogLine } from '../common/claudeMcpControl.js';

/**
 * The newest log Claude Code wrote for an MCP server (issue 512): first in the
 * session folder's cache, else in any project's, since a session may run in a
 * worktree. Files are named by their start time, so the last name is the newest.
 * Never rejects; a server with no log reads as no lines.
 */
export async function readClaudeMcpLog(cacheRoot: string, cwd: string, server: string): Promise<ClaudeMcpLog> {
	const folders = [join(cacheRoot, claudeMcpLogFolder(cwd, server))];
	const projects = await fs.readdir(cacheRoot).catch((): string[] => []);
	const serverFolder = `mcp-logs-${claudeCacheName(server)}`;
	folders.push(...projects.map(project => join(cacheRoot, project, serverFolder)).filter(folder => folder !== folders[0]));
	for (const [index, folder] of folders.entries()) {
		const files = (await fs.readdir(folder).catch((): string[] => [])).filter(name => name.endsWith('.jsonl') || name.endsWith('.txt')).sort();
		const newest = files.at(-1);
		if (!newest) {
			continue;
		}
		// Past the session's own folder, the newest file across projects wins.
		const file = index === 0 ? join(folder, newest) : await newestAcross(folders.slice(1)) ?? join(folder, newest);
		const text = await fs.readFile(file, 'utf8').catch(() => '');
		const lines = text.split(/\r?\n/).slice(-CLAUDE_MCP_LOG_MAX_LINES - 1).map(formatClaudeMcpLogLine).filter((line): line is string => line !== undefined);
		return { file, lines: lines.slice(-CLAUDE_MCP_LOG_MAX_LINES) };
	}
	return { lines: [] };
}

async function newestAcross(folders: readonly string[]): Promise<string | undefined> {
	let best: { readonly file: string; readonly name: string } | undefined;
	for (const folder of folders) {
		for (const name of await fs.readdir(folder).catch((): string[] => [])) {
			if ((name.endsWith('.jsonl') || name.endsWith('.txt')) && (!best || name > best.name)) {
				best = { file: join(folder, name), name };
			}
		}
	}
	return best?.file;
}
