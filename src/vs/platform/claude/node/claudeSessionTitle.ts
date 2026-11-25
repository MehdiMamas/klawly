/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { open } from 'fs/promises';
import { homedir } from 'os';
import { join } from '../../../base/common/path.js';

/** How much of the end of a transcript is searched. Claude Code rewrites the title line as the chat grows. */
const TAIL_BYTES = 1024 * 1024;

/** The folder Claude Code keeps a project's transcripts in: the path with every non-alphanumeric character a dash. */
export function claudeProjectFolderName(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** The last `custom-title` entry in transcript text, which is what `/rename` writes. */
export function lastClaudeCustomTitle(transcript: string): string | undefined {
	let title: string | undefined;
	for (const line of transcript.split('\n')) {
		if (!line.includes('"custom-title"')) {
			continue;
		}
		try {
			const entry = JSON.parse(line) as { type?: unknown; customTitle?: unknown };
			if (entry.type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim()) {
				title = entry.customTitle.trim();
			}
		} catch {
			// A line cut by the tail read, or one written mid-flush.
		}
	}
	return title;
}

/**
 * Claude Code's own title for a conversation: the one the user set with
 * `/rename`. Undefined when the transcript has none. Read from the transcript
 * file Claude Code keeps, since the CLI has no command that prints it.
 */
export async function readClaudeCodeSessionTitle(claudeSessionId: string, cwd: string, configDirectory: string | undefined = process.env.CLAUDE_CONFIG_DIR): Promise<string | undefined> {
	if (!/^[0-9a-fA-F-]{8,64}$/.test(claudeSessionId)) {
		return undefined;
	}
	const file = join(configDirectory || join(homedir(), '.claude'), 'projects', claudeProjectFolderName(cwd), `${claudeSessionId}.jsonl`);
	let handle;
	try {
		handle = await open(file, 'r');
	} catch {
		return undefined;
	}
	try {
		const { size } = await handle.stat();
		const length = Math.min(size, TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, size - length);
		return lastClaudeCustomTitle(buffer.toString('utf8'));
	} finally {
		await handle.close();
	}
}
