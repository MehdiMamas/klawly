/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute } from '../../../base/common/path.js';
import { CLAUDE_SIDE_QUESTION_DISALLOWED_TOOLS, CLAUDE_SIDE_QUESTION_MAX_TURNS, CLAUDE_SIDE_QUESTION_TOOLS, claudeInlineQuestionPrompt, claudeSideQuestionPrompt, claudeSideQuestionToolTarget, ClaudeSideQuestionRequest, ClaudeSideQuestionResult } from '../common/claudeSideQuestion.js';
import { assessPath, isCredentialPath, PathRealpath } from '../common/claudeToolPolicy.js';
import { ClaudePromptMessage, ClaudeQuery, ClaudeQueryFactory, ClaudeQueryOptions } from './claudeQuery.js';
import { createClaudeNormalizerState, normalizeClaudeMessage } from './claudeStreamNormalizer.js';

export interface ClaudeSideQuestionRun {
	readonly queryFactory: ClaudeQueryFactory;
	readonly request: ClaudeSideQuestionRequest;
	readonly abort: AbortController;
	readonly env: Readonly<Record<string, string>>;
	readonly executablePath?: string;
	readonly realpath?: PathRealpath;
}

const READ_ONLY_MESSAGE = 'A side question only reads files in the workspace.';

/**
 * One forked, unsaved `query()` on the chat's conversation: it resumes the
 * chat's Claude Code session with `forkSession` and `persistSession: false`, in
 * plan mode, and may only read workspace files. It runs beside the chat's own
 * query and never touches it, so it also works while a turn is running.
 * A question about a selection has no chat: it starts a fresh unsaved query.
 */
export async function runClaudeSideQuestion(run: ClaudeSideQuestionRun): Promise<ClaudeSideQuestionResult> {
	if (run.abort.signal.aborted) {
		return { kind: 'cancelled' };
	}
	let query: ClaudeQuery;
	try {
		query = await run.queryFactory({
			prompt: promptOnce(run.request.selection ? claudeInlineQuestionPrompt(run.request.question, run.request.selection) : claudeSideQuestionPrompt(run.request.question)),
			options: sideQuestionQueryOptions(run),
		});
	} catch (error) {
		return { kind: 'failed', message: errorMessage(error) };
	}
	const state = createClaudeNormalizerState();
	let text: string | undefined;
	try {
		for await (const message of query) {
			if (run.abort.signal.aborted) {
				await query.interrupt().catch(() => undefined);
				return { kind: 'cancelled' };
			}
			for (const event of normalizeClaudeMessage(message, run.request.id, state).events) {
				if (event.type === 'session.failed') {
					return { kind: 'failed', message: event.message };
				}
				// Each assistant message after a read replaces the last: the final one is the answer.
				if (event.type === 'assistant.completed' && event.text.trim().length > 0) {
					text = event.text;
				}
			}
		}
	} catch (error) {
		return run.abort.signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', message: errorMessage(error) };
	} finally {
		query.close();
	}
	if (run.abort.signal.aborted) {
		return { kind: 'cancelled' };
	}
	return text === undefined ? { kind: 'failed', message: 'Claude did not answer the side question.' } : { kind: 'answer', text };
}

export function sideQuestionQueryOptions(run: ClaudeSideQuestionRun): ClaudeQueryOptions {
	const { request } = run;
	return {
		cwd: request.cwd,
		// No settings, hooks or MCP servers: the fork only needs the conversation.
		strictMcpConfig: true,
		resume: request.claudeSessionId,
		forkSession: request.claudeSessionId !== undefined ? true : undefined,
		persistSession: false,
		allowedTools: [],
		disallowedTools: CLAUDE_SIDE_QUESTION_DISALLOWED_TOOLS,
		additionalDirectories: request.additionalDirectories,
		maxTurns: CLAUDE_SIDE_QUESTION_MAX_TURNS,
		model: request.model,
		permissionMode: 'plan',
		pathToClaudeCodeExecutable: run.executablePath,
		env: run.env,
		abortController: run.abort,
		canUseTool: async (toolName, input) => {
			const denial = await sideQuestionToolDenial(toolName, input, run);
			return denial ? { behavior: 'deny', message: denial } : { behavior: 'allow', updatedInput: input };
		},
		screenTool: async (toolName, input) => {
			const denial = await sideQuestionToolDenial(toolName, input, run);
			return denial ? { decision: 'deny', message: denial } : undefined;
		},
	};
}

/** Why a tool call is refused, or undefined for a read inside the workspace that is not a credential file. */
export async function sideQuestionToolDenial(toolName: string, input: Readonly<Record<string, unknown>>, run: Pick<ClaudeSideQuestionRun, 'request' | 'realpath'>): Promise<string | undefined> {
	if (!CLAUDE_SIDE_QUESTION_TOOLS.includes(toolName)) {
		return READ_ONLY_MESSAGE;
	}
	const { request } = run;
	const targets = [claudeSideQuestionToolTarget(toolName, input, request.cwd)];
	// An absolute Glob pattern names its own folder.
	if (toolName === 'Glob' && typeof input.pattern === 'string' && isAbsolute(input.pattern)) {
		targets.push(input.pattern.split(/[*?[{]/)[0]);
	}
	for (const target of targets) {
		if (target === undefined || target.startsWith('~')) {
			return READ_ONLY_MESSAGE;
		}
		const assessed = await assessPath(target, {
			cwd: request.cwd,
			workspaceFolders: request.workspaceFolders ?? [request.cwd],
			additionalDirectories: request.additionalDirectories ?? [],
			realpath: run.realpath,
		});
		if (!assessed.readable || isCredentialPath(assessed.absolute) || isCredentialPath(assessed.real)) {
			return READ_ONLY_MESSAGE;
		}
	}
	return undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message ? error.message : 'Claude could not answer the side question.';
}

async function* promptOnce(text: string): AsyncGenerator<ClaudePromptMessage> {
	yield {
		type: 'user',
		message: { role: 'user', content: text },
		parent_tool_use_id: null,
	};
}
