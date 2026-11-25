/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeEffortLevel } from './claudeSessionSettings.js';
import { ClaudeDelegateContract, claudeDelegateContractProblem } from './claudeDelegateContract.js';
import { CLAUDE_KLAWLY_MCP_SERVER } from './claudeTerminalRun.js';
import { claudeDelegateTemplateProblem, CLAUDE_DELEGATE_TEMPLATE_DESCRIPTION } from './claudeDelegateTemplates.js';

/**
 * Delegation (issue 693): a chat hands one task to a read-only delegated chat
 * on another model, waits for it, and reads the result back. Auto delegates
 * this way instead of switching the chat's model, so the chat keeps its model
 * and its prompt cache.
 *
 * Two parts ship with Klawly and are versioned with the app:
 * - the `klawly-delegate` Claude Code plugin, loaded into every local session,
 *   whose skill tells Claude when and how to delegate;
 * - the `klawly_delegate` tool on Klawly's own MCP server, which asks the window
 *   that owns the session to run the delegated chat.
 */
export const CLAUDE_DELEGATE_TOOL = 'klawly_delegate';
export const CLAUDE_DELEGATE_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_DELEGATE_TOOL}`;

/** The tool that sends a message to a helper this chat delegated to (issue 1380). */
export const CLAUDE_MESSAGE_HELPER_TOOL = 'klawly_message_helper';
export const CLAUDE_MESSAGE_HELPER_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_MESSAGE_HELPER_TOOL}`;
export const CLAUDE_MESSAGE_HELPER_TOOL_DESCRIPTION = 'Sends a message to a helper you delegated to, running or finished, and returns at once without waiting for its answer. The helper reads it next: a running helper gets it queued behind its current step, an idle one starts a turn on it. Its reply arrives in this chat as its report. helper is the card id or its title; text is the whole message, written for a chat that does not see this conversation.';

/** The bundled plugin's name, as Claude Code lists it. */
export const CLAUDE_DELEGATE_PLUGIN = 'klawly-delegate';

/** The folder under the data folder that holds the bundled plugin, one subfolder per Klawly version. */
export const CLAUDE_DELEGATE_PLUGIN_FOLDER = 'bundled-plugins';

/** How deep delegated chats may nest: manager, coordinator, helper: a helper at this depth delegates no further. */
export const CLAUDE_DELEGATE_MAX_DEPTH = 2;

/** The result text a delegated chat hands back is cut at this many characters. */
export const CLAUDE_DELEGATE_RESULT_MAX_CHARS = 8000;

export const CLAUDE_DELEGATE_TOOL_DESCRIPTION = [
	'Hands one self-contained task to a delegated Klawly chat on another Claude model and waits for its answer.',
	'The delegated chat works in the same folder with the same permissions and mode as this chat, and with the lean profile only the file and shell tools, or with the full profile the same tools, MCP servers and skills, and the user watches it live.',
	'Use it for a task that fits a smaller or larger model better than yours: give the whole task, because the delegated chat does not see this conversation.',
	'model is an alias (haiku, sonnet, opus) or a full model id; effort is low, medium, high, xhigh or max.',
	'Optional contract: objective (the goal in one sentence), files (paths it owns), approach, acceptance (how to check it is done), budget {calls, usd}, retries, tier (small, medium, large) and reason (large needs a reason; under an Opus chat it runs Sonnet unless orchestrates is true), and without tier or model the task is rated for you. profile is lean (file and shell tools plus delegation tools, a small start) or full (browser, MCP servers, plugins; pick it when the task needs them). The delegated chat reports back in at most 300 words; at 80% of its budget it is told to wrap up, at 100% it is stopped.',
	CLAUDE_DELEGATE_TEMPLATE_DESCRIPTION,
	'If the user stops the delegated chat, do not delegate the same task again unless the user asks.',
].join(' ');

/** What Claude passes to `klawly_delegate`. */
export interface ClaudeDelegateToolArgs extends ClaudeDelegateContract {
	/** The whole task, written so a chat without this conversation can do it. */
	readonly task: string;
	/** A model alias or id. Absent keeps the chat's own model. */
	readonly model?: string;
	readonly effort?: ClaudeEffortLevel;
	/** A short title for the card, such as "Rename the helpers". */
	readonly title?: string;
	/** A template (issue 845) instead of a written task: watch-ci, run-tests, merge-pr or find. */
	readonly template?: string;
	/** What the template works on: a pull request number, a command or a question. */
	readonly args?: string;
	/** A message for a helper this chat delegated to (issue 1380), instead of a new delegated chat. */
	readonly messageHelper?: { readonly helper: string; readonly text: string };
}

/** A `klawly_delegate` call waiting for the window that owns the session. */
export type ClaudeDelegateToolRequest = ClaudeDelegateToolArgs & {
	readonly sessionId: string;
	/** Id `resolveDelegateRequest` answers with. */
	readonly requestId: string;
};

export type ClaudeDelegateToolResult =
	| { readonly kind: 'done'; readonly text: string; readonly model: string; readonly costUsd?: number }
	| { readonly kind: 'stopped' }
	| { readonly kind: 'messaged'; readonly helper: string }
	| { readonly kind: 'failed'; readonly message: string };

/** The text Claude reads back from a delegated chat. */
export function claudeDelegateToolText(result: ClaudeDelegateToolResult): { readonly text: string; readonly isError: boolean } {
	switch (result.kind) {
		case 'done': {
			const text = result.text.trim() || 'The delegated chat finished without an answer.';
			const cut = text.length > CLAUDE_DELEGATE_RESULT_MAX_CHARS ? `${text.slice(0, CLAUDE_DELEGATE_RESULT_MAX_CHARS)}\n\n[The answer is cut here.]` : text;
			return { text: `The delegated chat on ${result.model} answered:\n\n${cut}`, isError: false };
		}
		case 'messaged':
			return { text: `The message is with ${result.helper}. Its reply arrives in this chat as its report.`, isError: false };
		case 'stopped':
			return { text: 'The user stopped the delegated chat before it finished. Do not delegate this task again unless the user asks.', isError: true };
		case 'failed':
			return { text: `Klawly could not run the delegated chat: ${result.message}`, isError: true };
	}
}

/** Why the arguments cannot become a delegated chat, or undefined when they can. */
export function claudeDelegateArgsProblem(args: ClaudeDelegateToolArgs): string | undefined {
	if (args.template !== undefined) {
		return claudeDelegateTemplateProblem(args.template, args.args) ?? claudeDelegateContractProblem(args);
	}
	if (!args.task.trim()) {
		return 'Give the task to delegate.';
	}
	return claudeDelegateContractProblem(args);
}

/**
 * How to use the delegate tool, as plain text. The bundled plugin carries it as a skill; a remote target cannot read that plugin, so the runner adds it to the system prompt there instead (issue 1406).
 */
export function claudeDelegateGuidance(): string {
	return [
		'# Delegate a task',
		'',
		`Klawly runs a delegated chat when you call \`${CLAUDE_DELEGATE_TOOL_ID}\`. The user sees it as a card in this chat and can open it read-only.`,
		'',
		'- Write the whole task in `task`: the delegated chat does not see this conversation. Name the files, the goal and what "done" means.',
		'- Pick `model`: `haiku` for small, mechanical work; `sonnet` for most coding; `opus` for hard reasoning. Leave it out to keep your own model.',
		'- For work you will check, add the contract: `objective`, `files` it owns, `approach`, `acceptance` (a command and its expected result), `budget` and `retries`. The worker ends with a report of at most 300 words.',
		'- Pick `effort` only when the task needs more or less thinking than usual.',
		'- The delegated chat has your folder, permissions, tools, MCP servers, skills and mode. Its file changes are real.',
		'- Wait for the answer, check it, and tell the user what changed.',
		'- If the user stopped it, do not run the same task again unless they ask.',
		'',
	].join('\n');
}

/**
 * The bundled plugin's files, by path relative to the plugin folder. Its
 * version is Klawly's, so a new Klawly writes a new folder and Claude Code
 * never reads a stale copy.
 */
export function claudeDelegatePluginFiles(version: string): Readonly<Record<string, string>> {
	const manifest = {
		name: CLAUDE_DELEGATE_PLUGIN,
		version,
		description: 'Ships with Klawly: hands a task to a delegated chat on another Claude model.',
		author: { name: 'Klawly' },
	};
	const skill = [
		'---',
		'name: delegate',
		`description: Hand a self-contained task to a delegated Klawly chat on another Claude model with the ${CLAUDE_DELEGATE_TOOL} tool. Use when a task fits a smaller or larger model better, or when the user asks to delegate.`,
		'---',
		'',
		claudeDelegateGuidance(),
	].join('\n');
	return {
		'.claude-plugin/plugin.json': JSON.stringify(manifest, undefined, '\t'),
		'skills/delegate/SKILL.md': skill,
	};
}
