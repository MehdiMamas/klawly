/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A quick question about a chat that does not become part of it (issue 433).
 * The runtime answers it from a fork of the chat's Claude Code conversation
 * that is never saved, so the chat's history and its running turn are untouched.
 * An inline edit card asks the same way about a selection (issue 491): it has no
 * conversation to fork, so it sends the selected code and a fresh query answers.
 * The IPC proxy cannot forward a cancellation token: cancel by `id`.
 */
export interface ClaudeSideQuestionRequest {
	readonly id: string;
	/** Claude Code's conversation id for the chat the question is about. Unset for a question about a selection. */
	readonly claudeSessionId?: string;
	readonly question: string;
	/** The code an inline edit card asks about; the prompt carries it, so the answer needs no read. */
	readonly selection?: ClaudeSideQuestionSelection;
	readonly cwd: string;
	/** Absolute workspace folders the answer may read. Defaults to `cwd`. */
	readonly workspaceFolders?: readonly string[];
	/** Absolute directories the chat may also read. */
	readonly additionalDirectories?: readonly string[];
	readonly model?: string;
}

/** The selected code an inline question is about (issue 491). Lines are 1-based. */
export interface ClaudeSideQuestionSelection {
	/** The file's path in its workspace folder, else its name. */
	readonly path: string;
	readonly languageId: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
}

export type ClaudeSideQuestionResult =
	| { readonly kind: 'answer'; readonly text: string }
	| { readonly kind: 'cancelled' }
	| { readonly kind: 'failed'; readonly message: string };

/** The only tools a side question may run. They read; nothing else is allowed. */
export const CLAUDE_SIDE_QUESTION_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];

/** Tools the SDK refuses before the host is asked. The host denies every other tool too. */
export const CLAUDE_SIDE_QUESTION_DISALLOWED_TOOLS: readonly string[] = [
	'Bash',
	'BashOutput',
	'KillShell',
	'Write',
	'Edit',
	'MultiEdit',
	'NotebookEdit',
	'WebFetch',
	'WebSearch',
	'Skill',
	'Task',
	'Agent',
	'TodoWrite',
	'ExitPlanMode',
];

/** A few reads and the answer. */
export const CLAUDE_SIDE_QUESTION_MAX_TURNS = 8;

/** What the forked conversation receives: the question, framed so Claude answers it and does not resume the chat's task. */
export function claudeSideQuestionPrompt(question: string): string {
	return [
		'This is a side question about our conversation so far. Answer it briefly from the conversation, and read files only if you need to.',
		'Do not change anything and do not continue the earlier task.',
		'',
		question.trim(),
	].join('\n');
}

/** What a question about a selection sends: the file, the lines and the code, then the question. */
export function claudeInlineQuestionPrompt(question: string, selection: ClaudeSideQuestionSelection): string {
	// A fence longer than any backtick run in the code keeps the code in one block.
	const longest = Math.max(2, ...Array.from(selection.text.matchAll(/`+/g), match => match[0].length));
	const fence = '`'.repeat(longest + 1);
	const lines = selection.startLine === selection.endLine ? `line ${selection.startLine}` : `lines ${selection.startLine}-${selection.endLine}`;
	return [
		`This is a question about ${selection.path}, ${lines}. Answer it briefly from the code below, and read other files only if you need to.`,
		'Do not change anything.',
		'',
		`${fence}${selection.languageId}`,
		selection.text.replace(/\r?\n$/, ''),
		fence,
		'',
		question.trim(),
	].join('\n');
}

/** The path a read-only tool call reads, relative paths unresolved. Grep and Glob default to `cwd`. */
export function claudeSideQuestionToolTarget(toolName: string, input: Readonly<Record<string, unknown>>, cwd: string): string | undefined {
	const field = toolName === 'Read' ? input.file_path : input.path;
	if (typeof field === 'string' && field.length > 0) {
		return field;
	}
	return toolName === 'Read' ? undefined : cwd;
}

/** The answer as a Markdown quote for the composer, ending in a blank line for the user's own text. */
export function claudeSideQuestionQuote(answer: string): string {
	const lines = answer.trim().split(/\r?\n/);
	return lines.map(line => line.length > 0 ? `> ${line}` : '>').join('\n') + '\n\n';
}

/** The `/btw` slash command (issue 965): asks a side question without leaving the composer. */
export const CLAUDE_BTW_COMMAND = 'btw';

/**
 * Reads a typed `/btw <question>`. Undefined when the text is not a `/btw`;
 * an empty question for a bare `/btw`, which opens the side question card.
 */
export function parseBtwQuestion(text: string): string | undefined {
	const match = /^\s*\/btw(?:\s+(?<question>[\s\S]*))?$/.exec(text);
	return match ? (match.groups?.question ?? '').trim() : undefined;
}
