/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Longest title a chat takes. A longer reply is clipped at a word. */
export const CLAUDE_SESSION_TITLE_MAX_LENGTH = 60;

/** Model alias for the title request: small and fast, like Claude Code's own titles. */
export const CLAUDE_SESSION_TITLE_MODEL = 'haiku';

/** How much of the first request the title prompt quotes. */
const TITLE_PROMPT_REQUEST_LIMIT = 2000;

/** The one-turn prompt that asks Claude for a chat title. */
export function claudeSessionTitlePrompt(firstPrompt: string): string {
	return [
		'Write a short title for a coding chat that starts with the request below.',
		'Use 2 to 6 words in sentence case and name what the work is about.',
		'Reply with the title only: no quotes, no period, no preamble.',
		'',
		'<request>',
		firstPrompt.trim().slice(0, TITLE_PROMPT_REQUEST_LIMIT),
		'</request>',
	].join('\n');
}

/**
 * Turns a model reply or a stored title into a chat title: the first line, without
 * quotes, Markdown marks, a `Title:` label or a final period. Undefined when nothing is left.
 */
export function readClaudeSessionTitle(text: string | undefined): string | undefined {
	const line = text?.split(/\r?\n/).map(candidate => candidate.trim()).find(candidate => candidate.length > 0);
	if (!line) {
		return undefined;
	}
	const title = line
		.replace(/^#+\s*/, '')
		.replace(/^title\s*:\s*/i, '')
		.replace(/^["'`*_]+|["'`*_]+$/g, '')
		.replace(/\.+$/, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!title) {
		return undefined;
	}
	if (title.length <= CLAUDE_SESSION_TITLE_MAX_LENGTH) {
		return title;
	}
	const cut = title.slice(0, CLAUDE_SESSION_TITLE_MAX_LENGTH - 1);
	const space = cut.lastIndexOf(' ');
	return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
