/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ContextAttachment } from '../../../../platform/claude/common/claudeContext.js';

type PastedText = Extract<ContextAttachment, { kind: 'pasted-text' }>;

/** A paste that sits in the message as `[label]`, the way Claude Code shows `[Pasted text #1 +12 lines]` (issue 737). */
export type ClaudePastePill = PastedText & { readonly label: string };

/** Pasted text the message shows inline as a pill, not as a chip above it. */
export function isClaudePastePill(attachment: ContextAttachment): attachment is ClaudePastePill {
	return attachment.kind === 'pasted-text' && !!attachment.label;
}

/** The text a pill stands for in the composer. */
export function claudePastePillToken(pill: ClaudePastePill): string {
	return `[${pill.label}]`;
}

/** The label for the next pasted text: numbered after the pills already in the message. */
export function claudePastePillLabel(attachments: readonly ContextAttachment[], lineCount: number): string {
	const numbers = attachments.filter(isClaudePastePill).map(pill => /#(?<n>\d+)/.exec(pill.label)?.groups?.n).map(Number).filter(n => n > 0);
	const next = Math.max(0, ...numbers) + 1;
	return lineCount > 1
		? localize('claudePastePillLines', "Pasted text #{0} +{1} lines", next, lineCount)
		: localize('claudePastePill', "Pasted text #{0}", next);
}

/** The attachments without the pills whose token the user deleted from the message, or undefined when none was. */
export function pruneClaudePastePills(value: string, attachments: readonly ContextAttachment[]): readonly ContextAttachment[] | undefined {
	const kept = attachments.filter(attachment => !isClaudePastePill(attachment) || value.includes(claudePastePillToken(attachment)));
	return kept.length === attachments.length ? undefined : kept;
}

/**
 * The pill that ends at the cursor (Backspace) or starts there (Delete), so the
 * key removes all of it at once.
 */
export function claudePastePillAt(value: string, cursor: number, direction: 'before' | 'after', attachments: readonly ContextAttachment[]): { readonly start: number; readonly end: number } | undefined {
	for (const pill of attachments.filter(isClaudePastePill)) {
		const token = claudePastePillToken(pill);
		const start = direction === 'before' ? cursor - token.length : cursor;
		if (start >= 0 && value.startsWith(token, start)) {
			return { start, end: start + token.length };
		}
	}
	return undefined;
}

/** The message cut into plain runs and pill runs, for drawing the pills behind the text. */
export function claudePastePillRuns(value: string, attachments: readonly ContextAttachment[]): readonly { readonly text: string; readonly pill: boolean }[] {
	const tokens = attachments.filter(isClaudePastePill).map(claudePastePillToken);
	const runs: { text: string; pill: boolean }[] = [];
	let from = 0;
	while (tokens.length > 0) {
		let next: { index: number; token: string } | undefined;
		for (const token of tokens) {
			const index = value.indexOf(token, from);
			if (index !== -1 && (!next || index < next.index)) {
				next = { index, token };
			}
		}
		if (!next) {
			break;
		}
		if (next.index > from) {
			runs.push({ text: value.slice(from, next.index), pill: false });
		}
		runs.push({ text: next.token, pill: true });
		from = next.index + next.token.length;
	}
	if (from < value.length) {
		runs.push({ text: value.slice(from), pill: false });
	}
	return runs;
}
