/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** One change an agent made to a file: the text it replaced and the text it wrote (empty `old` for a new file). */
export interface ClaudeLiveDiffHunk {
	readonly old: string;
	readonly new: string;
}

/** What an agent changed in one file so far, in the order it made the changes (issue 1367). */
export type ClaudeLiveDiffState = ReadonlyMap<string, readonly ClaudeLiveDiffHunk[]>;

export const EMPTY_CLAUDE_LIVE_DIFF_STATE: ClaudeLiveDiffState = new Map();

/** The changes one Edit, MultiEdit or Write call makes; none for any other tool or an input it cannot read. */
export function claudeLiveDiffHunksOf(toolName: string, input: unknown): readonly ClaudeLiveDiffHunk[] {
	if (!input || typeof input !== 'object') {
		return [];
	}
	const record = input as { readonly old_string?: unknown; readonly new_string?: unknown; readonly content?: unknown; readonly edits?: unknown };
	switch (toolName) {
		case 'Edit':
			return typeof record.new_string === 'string' ? [{ old: typeof record.old_string === 'string' ? record.old_string : '', new: record.new_string }] : [];
		case 'Write':
			return typeof record.content === 'string' ? [{ old: '', new: record.content }] : [];
		case 'MultiEdit':
			return Array.isArray(record.edits)
				? record.edits.flatMap(edit => claudeLiveDiffHunksOf('Edit', edit))
				: [];
		default:
			return [];
	}
}

/** The key of one agent's changes to one file. */
export function claudeLiveDiffKey(agentId: string, file: string): string {
	return `${agentId}\n${file}`;
}

/** The state after the agent made more changes to the file. */
export function claudeLiveDiffAppend(state: ClaudeLiveDiffState, key: string, hunks: readonly ClaudeLiveDiffHunk[]): ClaudeLiveDiffState {
	if (!hunks.length) {
		return state;
	}
	const next = new Map(state);
	next.set(key, [...(state.get(key) ?? []), ...hunks]);
	return next;
}

/** The state without the agent's changes to the file, once the agent stopped. */
export function claudeLiveDiffClear(state: ClaudeLiveDiffState, agentId: string): ClaudeLiveDiffState {
	const keys = [...state.keys()].filter(key => key.startsWith(`${agentId}\n`));
	if (!keys.length) {
		return state;
	}
	const next = new Map(state);
	keys.forEach(key => next.delete(key));
	return next;
}

/** The two sides of the diff editor: every replaced text, then every written text, one blank line between changes. */
export function claudeLiveDiffTexts(hunks: readonly ClaudeLiveDiffHunk[]): { readonly original: string; readonly modified: string } {
	return {
		original: hunks.map(hunk => hunk.old).join('\n\n'),
		modified: hunks.map(hunk => hunk.new).join('\n\n'),
	};
}
