/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeRegistrySession } from './claudeSessionRegistry.js';

/**
 * Issue 1186: the "From the terminal" browser. Claude Code keeps each session as
 * `~/.claude/projects/<folder>/<session id>.jsonl`; Klawly only reads those files to list what can be continued.
 */

const SESSION_FILE = /^(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const MAX_TITLE_LENGTH = 100;

/** The `projects` sub folder Claude Code uses for `folder`: every character that is not a letter or digit becomes `-`. */
export function claudeProjectFolderName(folder: string): string {
	return folder.replace(/[^A-Za-z0-9]/g, '-');
}

/** The session id a transcript file name stands for, or `undefined` when the file is not a session transcript. */
export function claudeTranscriptSessionId(fileName: string): string | undefined {
	return SESSION_FILE.exec(fileName)?.groups?.id;
}

/** A title for a transcript: its first typed prompt, one line. Commands, tags and tool output are skipped. */
export function claudeTranscriptTitle(jsonl: string): string | undefined {
	for (const line of jsonl.split('\n')) {
		if (!line.includes('"type":"user"')) {
			continue;
		}
		let text: string | undefined;
		try {
			const content: unknown = JSON.parse(line)?.message?.content;
			text = typeof content === 'string' ? content : Array.isArray(content) ? content.find(part => part?.type === 'text' && typeof part.text === 'string')?.text : undefined;
		} catch {
			continue; // the read can cut the last line short
		}
		const oneLine = text?.replace(/\s+/g, ' ').trim();
		if (oneLine && !oneLine.startsWith('<')) {
			return oneLine.length > MAX_TITLE_LENGTH ? `${oneLine.slice(0, MAX_TITLE_LENGTH - 1)}…` : oneLine;
		}
	}
	return undefined;
}

export interface ClaudeTranscriptFile {
	readonly name: string;
	readonly mtime: number;
}

/** The newest session transcripts first, at most `limit`; anything that is not `<session id>.jsonl` is ignored. */
export function claudeTranscriptList(files: readonly ClaudeTranscriptFile[], limit = 30): readonly { readonly sessionId: string; readonly mtime: number }[] {
	const sessions: { sessionId: string; mtime: number }[] = [];
	for (const file of files) {
		const sessionId = claudeTranscriptSessionId(file.name);
		if (sessionId) {
			sessions.push({ sessionId, mtime: file.mtime });
		}
	}
	return sessions.sort((a, b) => b.mtime - a.mtime || a.sessionId.localeCompare(b.sessionId)).slice(0, limit);
}

/** The registry-shaped session for a transcript, so it can use the same import link. */
export function claudeTranscriptAsSession(sessionId: string, title: string | undefined, folder: string, mtime: number): ClaudeRegistrySession {
	return { sessionId, name: title ?? sessionId.slice(0, 8), state: 'ended', folder, updatedAt: mtime };
}
