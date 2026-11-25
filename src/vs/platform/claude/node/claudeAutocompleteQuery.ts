/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeInlineCompletionRequest } from '../common/claudeAutocomplete.js';
import { ClaudePromptMessage, ClaudeQuery, ClaudeQueryFactory, ClaudeQueryOptions } from './claudeQuery.js';
import { createClaudeNormalizerState, normalizeClaudeMessage } from './claudeStreamNormalizer.js';

export const CLAUDE_AUTOCOMPLETE_MAX_TURNS = 1;

/** Tools a completion turn must not run. `allowedTools` is also empty. */
export const CLAUDE_AUTOCOMPLETE_DISALLOWED_TOOLS: readonly string[] = [
	'Bash',
	'Write',
	'Edit',
	'MultiEdit',
	'NotebookEdit',
	'Read',
	'Grep',
	'Glob',
	'WebFetch',
	'WebSearch',
	'Skill',
	'Task',
	'TodoWrite',
	'ToolSearch',
];

export interface ClaudeInlineQueryRun {
	readonly queryFactory: ClaudeQueryFactory;
	readonly request: ClaudeInlineCompletionRequest;
	readonly abort: AbortController;
	readonly env: Readonly<Record<string, string>>;
	readonly executablePath?: string;
}

/**
 * One constrained `query()`: no tools, one turn, plain assistant text.
 * Failures and cancellation return no text.
 */
export async function runClaudeInlineCompletion(run: ClaudeInlineQueryRun): Promise<string | undefined> {
	if (run.abort.signal.aborted) {
		return undefined;
	}
	let query: ClaudeQuery;
	try {
		query = await run.queryFactory({
			prompt: promptOnce(run.request.prompt),
			options: inlineQueryOptions(run),
		});
	} catch {
		return undefined;
	}
	const state = createClaudeNormalizerState();
	let text: string | undefined;
	try {
		for await (const message of query) {
			if (run.abort.signal.aborted) {
				await query.interrupt().catch(() => undefined);
				return undefined;
			}
			const normalized = normalizeClaudeMessage(message, run.request.id, state);
			for (const event of normalized.events) {
				if (event.type === 'session.failed') {
					return undefined;
				}
				if (event.type === 'assistant.completed' && event.text.length > 0) {
					text = event.text;
				}
			}
		}
	} catch {
		return undefined;
	} finally {
		query.close();
	}
	if (run.abort.signal.aborted) {
		return undefined;
	}
	return text;
}

export function inlineQueryOptions(run: ClaudeInlineQueryRun): ClaudeQueryOptions {
	return {
		cwd: run.request.cwd,
		allowedTools: [],
		disallowedTools: CLAUDE_AUTOCOMPLETE_DISALLOWED_TOOLS,
		maxTurns: CLAUDE_AUTOCOMPLETE_MAX_TURNS,
		model: run.request.model,
		permissionMode: 'default',
		pathToClaudeCodeExecutable: run.executablePath,
		env: run.env,
		abortController: run.abort,
		canUseTool: async () => ({ behavior: 'deny', message: 'Autocomplete cannot use tools.' }),
		screenTool: async () => ({ decision: 'deny', message: 'Autocomplete cannot use tools.' }),
	};
}

async function* promptOnce(text: string): AsyncGenerator<ClaudePromptMessage> {
	yield {
		type: 'user',
		message: { role: 'user', content: text },
		parent_tool_use_id: null,
	};
}
