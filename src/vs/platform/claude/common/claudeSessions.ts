/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IClaudeTranscriptMessage } from './claudeRuntime.js';

/** The folder name the CLI uses under `~/.claude/projects` for a working folder: every character that is not a letter or digit becomes `-`. */
export function claudeProjectFolderName(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function messageText(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content.map(block => block?.type === 'text' && typeof block.text === 'string' ? block.text : '').join('');
	}
	return '';
}

/**
 * Reads the user and assistant text of one stored session (a JSONL file). Tool calls, tool results and
 * lines that are not plain text are skipped; a broken line is skipped like the CLI does.
 */
export function parseClaudeTranscript(text: string): IClaudeTranscriptMessage[] {
	const messages: IClaudeTranscriptMessage[] = [];
	for (const line of text.split('\n')) {
		let entry: { type?: string; isSidechain?: boolean; isMeta?: boolean; message?: { content?: unknown } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isSidechain || entry.isMeta) {
			continue;
		}
		const body = messageText(entry.message?.content).trim();
		// slash-command and system wrappers are not something the person typed
		if (body && !body.startsWith('<')) {
			messages.push({ role: entry.type, text: body });
		}
	}
	return messages;
}

/** The number of distinct files a stored session edited or wrote (Edit, MultiEdit and Write calls). */
export function countClaudeEditedFiles(text: string): number {
	const files = new Set<string>();
	for (const line of text.split('\n')) {
		if (!line.includes('"tool_use"')) {
			continue;
		}
		try {
			const content = JSON.parse(line)?.message?.content;
			for (const block of Array.isArray(content) ? content : []) {
				if (block?.type === 'tool_use' && ['Edit', 'MultiEdit', 'Write'].includes(block.name) && typeof block.input?.file_path === 'string') {
					files.add(block.input.file_path);
				}
			}
		} catch {
			// a broken line is skipped
		}
	}
	return files.size;
}
