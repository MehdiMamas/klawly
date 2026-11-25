/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_AUTOCOMPLETE_DISALLOWED_TOOLS } from './claudeAutocompleteQuery.js';
import { ClaudePromptMessage, ClaudeQuery, ClaudeQueryFactory, ClaudeQueryOptions } from './claudeQuery.js';

/** Turns a structured query may take when the caller does not choose: enough to read a few files. */
export const CLAUDE_STRUCTURED_DEFAULT_MAX_TURNS = 12;

export interface ClaudeStructuredQueryRun<T> {
	readonly queryFactory: ClaudeQueryFactory;
	readonly prompt: string;
	readonly cwd: string;
	/** JSON schema the final answer must match (`outputFormat: { type: 'json_schema' }`). */
	readonly schema: Record<string, unknown>;
	/**
	 * Checks the parsed answer and narrows it to `T`. Returns `undefined` when the
	 * answer does not have the expected shape, which fails the query as `malformed`.
	 */
	readonly validate: (value: unknown) => T | undefined;
	readonly model?: string;
	/**
	 * Tools the query may run. Every other tool is refused before and in
	 * `canUseTool`. Empty means no tools.
	 */
	readonly tools: readonly string[];
	readonly maxTurns?: number;
	readonly abort: AbortController;
	readonly env: Readonly<Record<string, string>>;
	readonly executablePath?: string;
	/** Absolute folders the query may read besides `cwd` (the tools stay read-only). */
	readonly additionalDirectories?: readonly string[];
}

/**
 * Why a structured query has no result. `malformed` carries the assistant's
 * last text, when it wrote any, so a caller can show it as a plain message.
 */
export type ClaudeStructuredQueryFailure =
	| { readonly kind: 'cancelled' }
	| { readonly kind: 'failed'; readonly message: string }
	| { readonly kind: 'malformed'; readonly text?: string };

export type ClaudeStructuredQueryResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly failure: ClaudeStructuredQueryFailure };

/**
 * One schema-constrained `query()`. The SDK puts the answer on the result
 * message as `structured_output`; a result with no usable answer, or one that
 * `validate` rejects, is `malformed`. Never throws.
 */
export async function runClaudeStructuredQuery<T>(run: ClaudeStructuredQueryRun<T>): Promise<ClaudeStructuredQueryResult<T>> {
	if (run.abort.signal.aborted) {
		return { ok: false, failure: { kind: 'cancelled' } };
	}
	let query: ClaudeQuery;
	try {
		query = await run.queryFactory({ prompt: promptOnce(run.prompt), options: structuredQueryOptions(run) });
	} catch (error) {
		return { ok: false, failure: { kind: 'failed', message: errorMessage(error) } };
	}
	let text: string | undefined;
	let result: ResultMessage | undefined;
	try {
		for await (const message of query) {
			if (run.abort.signal.aborted) {
				await query.interrupt().catch(() => undefined);
				return { ok: false, failure: { kind: 'cancelled' } };
			}
			text = assistantText(message) ?? text;
			if (isResultMessage(message)) {
				result = message;
			}
		}
	} catch (error) {
		return run.abort.signal.aborted
			? { ok: false, failure: { kind: 'cancelled' } }
			: { ok: false, failure: { kind: 'failed', message: errorMessage(error) } };
	} finally {
		query.close();
	}
	if (run.abort.signal.aborted) {
		return { ok: false, failure: { kind: 'cancelled' } };
	}
	if (!result) {
		return { ok: false, failure: { kind: 'failed', message: 'Claude Code ended without a result.' } };
	}
	if (result.subtype !== 'success' && result.subtype !== 'error_max_structured_output_retries') {
		return { ok: false, failure: { kind: 'failed', message: result.errors?.join('\n') || result.subtype } };
	}
	const value = result.structured_output !== undefined ? run.validate(result.structured_output) : undefined;
	if (value === undefined) {
		return { ok: false, failure: { kind: 'malformed', text: text ?? (typeof result.result === 'string' && result.result ? result.result : undefined) } };
	}
	return { ok: true, value };
}

export function structuredQueryOptions<T>(run: ClaudeStructuredQueryRun<T>): ClaudeQueryOptions {
	const allowed = new Set(run.tools);
	const refusal = 'This review can only read files.';
	return {
		cwd: run.cwd,
		additionalDirectories: run.additionalDirectories?.length ? [...run.additionalDirectories] : undefined,
		allowedTools: [...run.tools],
		disallowedTools: CLAUDE_AUTOCOMPLETE_DISALLOWED_TOOLS.filter(tool => !allowed.has(tool)),
		maxTurns: run.maxTurns ?? CLAUDE_STRUCTURED_DEFAULT_MAX_TURNS,
		model: run.model,
		// Klawly never hands the SDK another mode: read-only is the tool allowlist below.
		permissionMode: 'default',
		outputFormat: { type: 'json_schema', schema: run.schema },
		pathToClaudeCodeExecutable: run.executablePath,
		env: run.env,
		abortController: run.abort,
		canUseTool: async toolName => allowed.has(toolName)
			? { behavior: 'allow' }
			: { behavior: 'deny', message: refusal },
		screenTool: async toolName => allowed.has(toolName) ? undefined : { decision: 'deny', message: refusal },
	};
}

interface ResultMessage {
	readonly type: 'result';
	readonly subtype: string;
	readonly result?: unknown;
	readonly errors?: readonly string[];
	readonly structured_output?: unknown;
}

function isResultMessage(message: unknown): message is ResultMessage {
	return typeof message === 'object' && message !== null
		&& (message as { type?: unknown }).type === 'result'
		&& typeof (message as { subtype?: unknown }).subtype === 'string';
}

/** The text blocks of a top-level assistant message, joined; `undefined` for anything else. */
function assistantText(message: unknown): string | undefined {
	if (typeof message !== 'object' || message === null) {
		return undefined;
	}
	const candidate = message as { type?: unknown; parent_tool_use_id?: unknown; message?: { content?: unknown } };
	const content: unknown = candidate.message?.content;
	if (candidate.type !== 'assistant' || candidate.parent_tool_use_id || !Array.isArray(content)) {
		return undefined;
	}
	const text = (content as unknown[])
		.filter((block): block is { type: 'text'; text: string } => typeof block === 'object' && block !== null
			&& (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')
		.map(block => block.text)
		.join('')
		.trim();
	return text || undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function* promptOnce(text: string): AsyncGenerator<ClaudePromptMessage> {
	yield {
		type: 'user',
		message: { role: 'user', content: text },
		parent_tool_use_id: null,
	};
}
