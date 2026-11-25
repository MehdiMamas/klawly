/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Issue 462: how Claude shapes its replies. `adhd` asks for a TL;DR first, short bullets and folded detail. */
export const CLAUDE_AGENT_REPLY_STYLE_SETTING = 'claude.agent.replyStyle';

export type ClaudeReplyStyle = 'default' | 'adhd';

/** Anything but `adhd` is the default style, so a bad value never changes the prompt. */
export function readClaudeReplyStyle(value: unknown): ClaudeReplyStyle {
	return value === 'adhd' ? 'adhd' : 'default';
}

/**
 * The text added to Claude Code's system prompt for ADHD mode. It is an instruction to Claude,
 * not UI text, so it is not localized. Folded detail uses `<details>`, which the chat renders
 * collapsed (see `claudeFoldedMarkdown.ts`).
 */
export const CLAUDE_ADHD_REPLY_INSTRUCTIONS = [
	'# Reply style: ADHD mode',
	'The user turned on ADHD mode in Klawly. Write every reply for a reader with ADHD:',
	'- Start with a line `**TL;DR:**` followed by the point in one or two short lines.',
	'- Put the answer or the result first, and the detail after it.',
	// Issue 741: "next action first" read as handing steps back to the user.
	'- Leave a next step to the user only when it needs them. A step you can take yourself (run a check, fix what it finds), take it instead of listing it.',
	'- Use short bullets instead of long paragraphs. One idea per bullet.',
	'- Keep it short: no filler, no recaps of what you did or what the user said, no preambles.',
	'- Fold long detail (explanations, logs, alternatives, step-by-step reasoning) into a collapsed section, so it is there only if wanted:',
	'  <details>',
	'  <summary>Short label</summary>',
	'',
	'  The detail, in Markdown.',
	'',
	'  </details>',
	'This shapes your replies only. Code, files, commit messages and tool input stay as they would be.',
].join('\n');

/** The system prompt addition for a reply style, or undefined when the style adds nothing. */
export function claudeReplyStyleInstructions(style: ClaudeReplyStyle | undefined): string | undefined {
	return style === 'adhd' ? CLAUDE_ADHD_REPLY_INSTRUCTIONS : undefined;
}

/** Joins system prompt additions with a blank line, skipping empty ones. Undefined when none is left. */
export function joinClaudeSystemPrompt(...parts: readonly (string | undefined)[]): string | undefined {
	const kept = parts.filter((part): part is string => !!part && part.trim().length > 0);
	return kept.length ? kept.join('\n\n') : undefined;
}
