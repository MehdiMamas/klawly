/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createRegExp } from '../../../../base/common/strings.js';
import { AgentViewState } from '../../../services/claude/common/claudeAgentState.js';

/** One place in an open chat where the searched text occurs (issue 685). */
export interface ClaudeChatFindMatch {
	/** The turn to scroll to. */
	readonly turnId: string;
	/** Whose text matched: a message, or a tool call's command, output or file edit (issue 890). */
	readonly from: 'prompt' | 'reply' | 'command' | 'output' | 'edit';
	/** The tool card the match is in, for `from` of command, output or edit. */
	readonly targetId?: string;
	/** The matching line, shortened around the match. */
	readonly snippet: string;
}

const SNIPPET_AROUND = 40;

/** What the matching text looked like once shortened around the match. */
function snippetAround(text: string, at: number, length: number): string {
	const start = Math.max(0, at - SNIPPET_AROUND);
	const end = Math.min(text.length, at + length + SNIPPET_AROUND);
	return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

/** Every place in a chat whose text contains the query, case-insensitive: prompts and replies, then the commands, output and edits of the turn's tool calls. A turn can match more than once. */
export function claudeChatFind(state: AgentViewState, query: string): ClaudeChatFindMatch[] {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return [];
	}
	const matches: ClaudeChatFindMatch[] = [];
	for (const turn of state.turns) {
		for (const [from, text] of [['prompt', turn.user.text], ['reply', turn.assistantText]] as const) {
			const at = text.toLowerCase().indexOf(needle);
			if (at >= 0) {
				matches.push({ turnId: turn.id, from, snippet: snippetAround(text, at, needle.length) });
			}
		}
		for (const card of turn.cards) {
			// A command and its output, or the file an edit changed and the lines it wrote: the first hit of each kind stands for the card.
			const sources: readonly (readonly [ClaudeChatFindMatch['from'], readonly string[]])[] = card.kind === 'edit'
				? [['edit', [card.file ?? card.target, ...card.lines]]]
				: [['command', [card.command ?? '', card.description ?? '', card.target, card.query ?? '']], ['output', [...card.lines, card.error ?? '']]];
			for (const [from, lines] of sources) {
				for (const line of lines) {
					const at = line.toLowerCase().indexOf(needle);
					if (at >= 0) {
						matches.push({ turnId: turn.id, from, targetId: card.id, snippet: snippetAround(line, at, needle.length) });
						break;
					}
				}
			}
		}
	}
	return matches;
}

/** The pattern for the typed text and the toggles, or undefined for empty text or an invalid expression. */
export function claudeFindRegExp(text: string, options: { readonly isRegex: boolean; readonly matchCase: boolean; readonly wholeWord: boolean }): RegExp | undefined {
	if (!text) {
		return undefined;
	}
	try {
		return createRegExp(text, options.isRegex, { matchCase: options.matchCase, wholeWord: options.wholeWord, global: true, multiline: true });
	} catch {
		return undefined;
	}
}
