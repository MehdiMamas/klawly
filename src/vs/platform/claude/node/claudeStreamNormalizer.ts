/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentFailureKind, classifyTool, ClaudeSubagentRun, ClaudeSubagentState, NormalizedClaudeEvent, TodoItem, ToolCall, ToolResult, UsageInfo } from '../common/claudeProtocol.js';
import { claudeEstimateCostUsd } from '../common/claudeModelPricing.js';
import { ClaudeFastModeStatus, normalizeClaudeFastMode, sameClaudeFastModeStatus } from '../common/claudeFastMode.js';
import { ClaudeUsageLimit, claudeUsageLimitFromRateLimitInfo } from '../common/claudeAccounts.js';
import { classifyAssistantError, failureMessage } from './claudeFailure.js';
import { createsGitHubReference, findGitHubReferences } from './claudeGitHubReferences.js';
import { claudeSandboxFailureMessage } from './claudeSecurityOptions.js';

export interface ClaudeInitMetadata {
	readonly slashCommands: readonly string[];
	readonly skills: readonly string[];
	readonly model?: string;
	readonly claudeCodeVersion?: string;
}

export interface ClaudeNormalizeResult {
	readonly events: readonly NormalizedClaudeEvent[];
	readonly init?: ClaudeInitMetadata;
	readonly sdkSessionId?: string;
	/** `tool_use` id to SDK task id, so one subagent can be stopped. `agentId` is the sub-agent id. */
	readonly taskBindings?: readonly { readonly runId: string; readonly taskId: string; readonly agentId: string }[];
	/** Set when this message ends the current turn. */
	readonly endedTurn?: 'success' | 'error';
	/**
	 * Set when Claude Code reported a rate-limit change, whatever its status, so
	 * the runner asks for the plan limits again.
	 */
	readonly rateLimitChanged?: true;
}

export interface ClaudeNormalizerState {
	sessionStarted: boolean;
	turn: number;
	readonly startedRuns: Set<string>;
	readonly finishedRuns: Set<string>;
	readonly completedText: Set<string>;
	readonly streamedText: Map<string, string>;
	/** Stream block indexes of thinking blocks still streaming, by turn, subagent and index. */
	readonly thinkingBlocks: Set<string>;
	/** Thinking blocks streamed but not yet seen in an assistant message, so they are not shown twice. */
	readonly streamedThinking: Map<string, number>;
	assistantCount: number;
	lastCompletedText?: string;
	/** Context size and model of the last main-loop assistant message, for the context ring. */
	lastContext?: { readonly tokens: number; readonly model?: string };
	/** Bash and GitHub create tool calls whose output can link a pull request or issue, by id: true when the call creates it (issue 430). */
	readonly githubTools: Map<string, boolean>;
	/** Pull request and issue URLs already sent, and whether as created by this session. */
	readonly githubReferences: Map<string, boolean>;
	/** The last plan limit Claude Code reported, so a turn that stops on it can say which and when it resets (issue 450). */
	lastRateLimit?: ClaudeUsageLimit;
	/** The last fast mode status sent, so only a change is sent again (issue 456). */
	lastFastMode?: ClaudeFastModeStatus;
}

export function createClaudeNormalizerState(): ClaudeNormalizerState {
	return {
		sessionStarted: false,
		turn: 0,
		startedRuns: new Set(),
		finishedRuns: new Set(),
		completedText: new Set(),
		streamedText: new Map(),
		thinkingBlocks: new Set(),
		streamedThinking: new Map(),
		assistantCount: 0,
		githubTools: new Map(),
		githubReferences: new Map(),
	};
}

function textKey(parentRunId: string | undefined, state: ClaudeNormalizerState): string {
	return `${state.turn}\n${parentRunId ?? ''}`;
}

/**
 * Maps one SDK message into normalized events. Unknown messages are logged
 * and dropped. This function does not throw.
 */
export function normalizeClaudeMessage(message: unknown, sessionId: string, state: ClaudeNormalizerState, log: (line: string) => void = () => undefined): ClaudeNormalizeResult {
	try {
		return normalizeKnown(message, sessionId, state, log);
	} catch (error) {
		log(`Dropped a Claude message that failed to normalize (${errorName(error)})`);
		return { events: [] };
	}
}

/**
 * The id of a main-thread chain entry (an assistant or user message outside any
 * subagent), the point a resume can stop at. Anything else is undefined.
 */
export function claudeChainAnchor(message: unknown): string | undefined {
	if (!isRecord(message) || (message.type !== 'assistant' && message.type !== 'user')) {
		return undefined;
	}
	if (typeof message.parent_tool_use_id === 'string' || typeof message.uuid !== 'string' || !message.uuid) {
		return undefined;
	}
	return message.uuid;
}

function normalizeKnown(message: unknown, sessionId: string, state: ClaudeNormalizerState, log: (line: string) => void): ClaudeNormalizeResult {
	if (!isRecord(message) || typeof message.type !== 'string') {
		log('Dropped a Claude message with no type');
		return { events: [] };
	}
	const sdkSessionId = typeof message.session_id === 'string' ? message.session_id : undefined;
	const parentRunId = typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : undefined;
	const events: NormalizedClaudeEvent[] = [];
	const taskBindings: { runId: string; taskId: string; agentId: string }[] = [];
	let endedTurn: 'success' | 'error' | undefined;

	switch (message.type) {
		case 'system':
			normalizeSystem(message, sessionId, parentRunId, state, events, taskBindings, log);
			break;
		case 'stream_event':
			appendStreamEvent(message, sessionId, parentRunId, state, events);
			break;
		case 'assistant':
			normalizeAssistant(message, sessionId, parentRunId, state, events);
			break;
		case 'user':
			normalizeUser(message, sessionId, parentRunId, state, events);
			break;
		case 'result':
			endedTurn = normalizeResult(message, sessionId, parentRunId, state, events);
			break;
		case 'rate_limit_event':
			normalizeRateLimit(message, sessionId, parentRunId, state, events);
			break;
		case 'auth_status':
			normalizeAuthStatus(message, sessionId, parentRunId, events);
			break;
		default:
			log(`Dropped unknown Claude message type ${message.type}`);
			break;
	}

	const init = message.type === 'system' && message.subtype === 'init' ? readInit(message) : undefined;
	return {
		events,
		init,
		sdkSessionId,
		taskBindings: taskBindings.length > 0 ? taskBindings : undefined,
		endedTurn: endedTurn ?? (events.some(item => item.type === 'session.failed') ? 'error' : undefined),
		rateLimitChanged: message.type === 'rate_limit_event' ? true : undefined,
	};
}

/** Sends fast mode's state when this message carries one and it differs from the last (issue 456). */
function pushFastMode(message: Record<string, unknown>, sessionId: string, parentRunId: string | undefined, state: ClaudeNormalizerState, events: NormalizedClaudeEvent[]): void {
	if (parentRunId !== undefined) {
		return;
	}
	const status = normalizeClaudeFastMode(message);
	if (!status || sameClaudeFastModeStatus(status, state.lastFastMode)) {
		return;
	}
	const previous = state.lastFastMode;
	state.lastFastMode = status;
	events.push(event(sessionId, parentRunId, previous ? { type: 'session.fastMode', status, previous } : { type: 'session.fastMode', status }));
}

function normalizeSystem(message: Record<string, unknown>, sessionId: string, parentRunId: string | undefined, state: ClaudeNormalizerState, events: NormalizedClaudeEvent[], taskBindings: { runId: string; taskId: string; agentId: string }[], log: (line: string) => void): void {
	const subtype = typeof message.subtype === 'string' ? message.subtype : '';
	switch (subtype) {
		case 'init': {
			if (state.sessionStarted) {
				return;
			}
			state.sessionStarted = true;
			const init = readInit(message);
			events.push(event(sessionId, parentRunId, {
				type: 'session.started',
				claudeSessionId: typeof message.session_id === 'string' ? message.session_id : undefined,
				model: init.model,
				slashCommands: init.slashCommands,
				skills: init.skills,
			}));
			pushFastMode(message, sessionId, parentRunId, state, events);
			return;
		}
		case 'compact_boundary': {
			const metadata = isRecord(message.compact_metadata) ? message.compact_metadata : undefined;
			events.push(event(sessionId, parentRunId, {
				type: 'session.compacted',
				info: metadata ? {
					trigger: metadata.trigger,
					preTokens: metadata.pre_tokens,
				} : undefined,
			}));
			return;
		}
		case 'task_started':
			normalizeTaskStarted(message, sessionId, parentRunId, state, events, taskBindings);
			return;
		case 'task_notification':
			normalizeTaskNotification(message, sessionId, parentRunId, state, events);
			return;
		case 'permission_denied':
			normalizePermissionDenied(message, sessionId, parentRunId, events);
			return;
		case 'elicitation_complete':
			// An MCP server says a URL sign-in finished (issue 428).
			if (typeof message.mcp_server_name === 'string' && typeof message.elicitation_id === 'string') {
				events.push(event(sessionId, parentRunId, { type: 'elicitation.completed', server: message.mcp_server_name, elicitationId: message.elicitation_id }));
			}
			return;
		case 'thinking_tokens': {
			// Claude Code's running estimate of the open thinking block (issue 740).
			// It counts up even when the runtime omits the thinking text.
			const prefix = `${textKey(parentRunId, state)}\n`;
			const open = [...state.thinkingBlocks].some(key => key.startsWith(prefix));
			if (open && typeof message.estimated_tokens === 'number' && message.estimated_tokens > 0) {
				events.push(event(sessionId, parentRunId, { type: 'thinking.delta', text: '', at: Date.now(), tokens: message.estimated_tokens }));
			}
			return;
		}
		default:
			log(`Dropped unknown Claude system subtype ${subtype || 'unknown'}`);
	}
}

function normalizeTaskStarted(message: Record<string, unknown>, sessionId: string, parentRunId: string | undefined, state: ClaudeNormalizerState, events: NormalizedClaudeEvent[], taskBindings: { runId: string; taskId: string; agentId: string }[]): void {
	if (message.ambient === true || message.skip_transcript === true) {
		return;
	}
	const taskId = typeof message.task_id === 'string' ? message.task_id : undefined;
	const toolUseId = typeof message.tool_use_id === 'string' ? message.tool_use_id : undefined;
	const runId = toolUseId ?? taskId;
	if (!runId || !taskId) {
		return;
	}
	const agentId = typeof message.agent_id === 'string' && message.agent_id.length > 0 ? message.agent_id : taskId;
	taskBindings.push({ runId, taskId, agentId });
	if (state.startedRuns.has(runId)) {
		return;
	}
	const agentType = typeof message.subagent_type === 'string' ? message.subagent_type : typeof message.task_type === 'string' ? message.task_type : undefined;
	if (!agentType) {
		return;
	}
	state.startedRuns.add(runId);
	const run: ClaudeSubagentRun = {
		id: runId,
		parentRunId,
		agentType,
		description: typeof message.description === 'string' ? message.description : '',
		background: message.is_backgrounded === true,
		state: 'running',
		startedAt: Date.now(),
		toolCallCount: 0,
	};
	events.push(event(sessionId, parentRunId, { type: 'subagent.started', run }));
}

function normalizeTaskNotification(message: Record<string, unknown>, sessionId: string, parentRunId: string | undefined, state: ClaudeNormalizerState, events: NormalizedClaudeEvent[]): void {
	if (message.ambient === true || message.skip_transcript === true) {
		return;
	}
	const toolUseId = typeof message.tool_use_id === 'string' ? message.tool_use_id : undefined;
	const taskId = typeof message.task_id === 'string' ? message.task_id : undefined;
	const runId = toolUseId ?? taskId;
	if (!runId || state.finishedRuns.has(runId)) {
		return;
	}
	const status = message.status;
	if (status !== 'completed' && status !== 'failed' && status !== 'stopped') {
		return;
	}
	state.finishedRuns.add(runId);
	const stateName: ClaudeSubagentState = status === 'completed' ? 'success' : status;
	const resultText = typeof message.summary === 'string' ? message.summary : undefined;
	events.push(event(sessionId, parentRunId, { type: 'subagent.finished', runId, state: stateName, resultText }));
}

function normalizePermissionDenied(message: Record<string, unknown>, sessionId: string, parentRunId: string | undefined, events: NormalizedClaudeEvent[]): void {
	const callId = typeof message.tool_use_id === 'string' ? message.tool_use_id : undefined;
	if (!callId) {
		return;
	}
	const result: ToolResult = {
		ok: false,
		error: typeof message.message === 'string' ? message.message : failureMessage('permission-denied'),
	};
	events.push(event(sessionId, parentRunId, { type: 'tool.completed', callId, result }));
}

function appendStreamEvent(message: Record<string, unknown>, sessionId: string, parentRunId: string | undefined, state: ClaudeNormalizerState, events: NormalizedClaudeEvent[]): void {
	const streamEvent = isRecord(message.event) ? message.event : undefined;
	if (!streamEvent) {
		return;
	}
	const blockKey = `${textKey(parentRunId, state)}
${typeof streamEvent.index === 'number' ? streamEvent.index : ''}`;
	if (streamEvent.type === 'content_block_start') {
		const block = isRecord(streamEvent.content_block) ? streamEvent.content_block : undefined;
		if (block && isThinkingBlock(block.type)) {
			const key = textKey(parentRunId, state);
			state.thinkingBlocks.add(blockKey);
			state.streamedThinking.set(key, (state.streamedThinking.get(key) ?? 0) + 1);
			events.push(event(sessionId, parentRunId, { type: 'thinking.delta', text: '', at: Date.now() }));
		}
		return;
	}
	if (streamEvent.type === 'content_block_stop') {
		if (state.thinkingBlocks.delete(blockKey)) {
			events.push(event(sessionId, parentRunId, { type: 'thinking.delta', text: '', at: Date.now(), done: true }));
		}
		return;
	}
	if (streamEvent.type !== 'content_block_delta') {
		return;
	}
	const delta = isRecord(streamEvent.delta) ? streamEvent.delta : undefined;
	if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0 && state.thinkingBlocks.has(blockKey)) {
		events.push(event(sessionId, parentRunId, { type: 'thinking.delta', text: delta.thinking, at: Date.now() }));
		return;
	}
	if (!delta || delta.type !== 'text_delta' || typeof delta.text !== 'string' || delta.text.length === 0) {
		return;
	}
	const key = textKey(parentRunId, state);
	state.streamedText.set(key, (state.streamedText.get(key) ?? '') + delta.text);
	events.push(event(sessionId, parentRunId, { type: 'assistant.delta', text: delta.text }));
}

function normalizeAssistant(message: Record<string, unknown>, sessionId: string, parentRunId: string | undefined, state: ClaudeNormalizerState, events: NormalizedClaudeEvent[]): void {
	const assistantError = typeof message.error === 'string' ? message.error : undefined;
	const failureKind = classifyAssistantError(assistantError);
	if (failureKind && (failureKind === 'auth' || failureKind === 'usage-limit' || failureKind === 'network')) {
		// Out of Console credits is its own limit; a plan limit is the one Claude Code last reported.
		const limit = failureKind !== 'usage-limit' ? undefined : assistantError === 'billing_error' ? { window: 'credits', status: 'rejected' } satisfies ClaudeUsageLimit : state.lastRateLimit;
		events.push(event(sessionId, parentRunId, { type: 'session.failed', message: failureMessage(failureKind), kind: failureKind, ...(limit ? { limit } : {}) }));
	}
	const body = isRecord(message.message) ? message.message : undefined;
	const messageId = typeof body?.id === 'string' && body.id.length > 0 ? body.id : `assistant-${state.assistantCount++}`;
	const key = `${messageId}\n${parentRunId ?? ''}`;
	if (parentRunId === undefined) {
		const tokens = contextTokens(body?.usage);
		if (tokens !== undefined) {
			state.lastContext = { tokens, model: typeof body?.model === 'string' ? body.model : undefined };
		}
	}
	adoptStreamedText(key, parentRunId, state);
	const content = body?.content;
	if (typeof content === 'string') {
		pushAssistantText(content, key, sessionId, parentRunId, state, events);
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (!isRecord(block) || typeof block.type !== 'string') {
				continue;
			}
			if (block.type === 'text' && typeof block.text === 'string') {
				pushAssistantText(block.text, key, sessionId, parentRunId, state, events);
			} else if (isThinkingBlock(block.type)) {
				pushThinking(block, sessionId, parentRunId, state, events);
			} else if (block.type === 'tool_use') {
				const call = toolCallFromBlock(block);
				if (call) {
					events.push(event(sessionId, parentRunId, { type: 'tool.started', call }));
					if (call.name === 'Bash' || createsGitHubReference(call.name, call.input)) {
						state.githubTools.set(call.id, createsGitHubReference(call.name, call.input));
					}
					if ((call.name === 'Agent' || call.name === 'Task') && !state.startedRuns.has(call.id)) {
						state.startedRuns.add(call.id);
						events.push(event(sessionId, parentRunId, { type: 'subagent.started', run: subagentFromTool(call, parentRunId) }));
					}
				}
			}
		}
	}
	const streamed = state.streamedText.get(key);
	if (streamed && streamed.length > 0) {
		pushCompleted(streamed, key, sessionId, parentRunId, state, events);
		state.streamedText.delete(key);
	}
}

function isThinkingBlock(type: unknown): boolean {
	return type === 'thinking' || type === 'redacted_thinking';
}

/** A whole thinking block from an assistant message, unless it already streamed. Redacted thinking has no text. */
function pushThinking(block: Record<string, unknown>, sessionId: string, parentRunId: string | undefined, state: ClaudeNormalizerState, events: NormalizedClaudeEvent[]): void {
	const key = textKey(parentRunId, state);
	const streamed = state.streamedThinking.get(key) ?? 0;
	if (streamed > 0) {
		if (streamed === 1) {
			state.streamedThinking.delete(key);
		} else {
			state.streamedThinking.set(key, streamed - 1);
		}
		return;
	}
	const text = block.type === 'thinking' && typeof block.thinking === 'string' ? block.thinking : '';
	events.push(event(sessionId, parentRunId, { type: 'thinking.delta', text, at: Date.now(), done: true }));
}

function adoptStreamedText(key: string, parentRunId: string | undefined, state: ClaudeNormalizerState): void {
	const streamedKey = textKey(parentRunId, state);
	const streamed = state.streamedText.get(streamedKey);
	if (!streamed || state.streamedText.has(key)) {
		return;
	}
	state.streamedText.set(key, streamed);
	state.streamedText.delete(streamedKey);
}

function pushCompleted(text: string, key: string, sessionId: string, parentRunId: string | undefined, state: ClaudeNormalizerState, events: NormalizedClaudeEvent[]): void {
	if (!text || state.completedText.has(key) || state.lastCompletedText === text) {
		return;
	}
	state.completedText.add(key);
	state.lastCompletedText = text;
	events.push(event(sessionId, parentRunId, { type: 'assistant.completed', text }));
	pushGitHubReferences(text, false, sessionId, parentRunId, state, events);
}

/** A message names at most this many pull requests and issues as cards; a long list stays text. */
const MAX_GITHUB_REFERENCES = 5;

/** Sends each new pull request or issue `text` links to, and again when this session turns out to have created it. */
function pushGitHubReferences(text: string, createdBySession: boolean, sessionId: string, parentRunId: string | undefined, state: ClaudeNormalizerState, events: NormalizedClaudeEvent[]): void {
	for (const reference of findGitHubReferences(text, createdBySession).slice(0, MAX_GITHUB_REFERENCES)) {
		const sent = state.githubReferences.get(reference.url);
		if (sent === true || (sent === false && !createdBySession)) {
			continue;
		}
		state.githubReferences.set(reference.url, createdBySession);
		events.push(event(sessionId, parentRunId, { type: 'github.referenceDetected', reference }));
	}
}

function pushAssistantText(text: string, key: string, sessionId: string, parentRunId: string | undefined, state: ClaudeNormalizerState, events: NormalizedClaudeEvent[]): void {
	if (!text) {
		return;
	}
	const existing = state.streamedText.get(key);
	if (existing !== undefined) {
		if (existing.endsWith(text)) {
			return;
		}
		state.streamedText.set(key, existing + text);
		events.push(event(sessionId, parentRunId, { type: 'assistant.delta', text }));
		return;
	}
	state.streamedText.set(key, text);
	events.push(event(sessionId, parentRunId, { type: 'assistant.delta', text }));
}

function normalizeUser(message: Record<string, unknown>, sessionId: string, parentRunId: string | undefined, state: ClaudeNormalizerState, events: NormalizedClaudeEvent[]): void {
	const body = isRecord(message.message) ? message.message : undefined;
	const content = body?.content;
	if (!Array.isArray(content)) {
		return;
	}
	let emittedTodos = false;
	for (const block of content) {
		if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
			continue;
		}
		const output = toolResultText(block.content);
		const extras = toolResultExtras(block.content, message.tool_use_result);
		const result: ToolResult = block.is_error === true
			? { ok: false, error: output, ...extras }
			: { ok: true, output, ...extras };
		events.push(event(sessionId, parentRunId, { type: 'tool.completed', callId: block.tool_use_id, result }));
		const createsReference = state.githubTools.get(block.tool_use_id);
		if (createsReference !== undefined) {
			state.githubTools.delete(block.tool_use_id);
			if (result.ok && output) {
				pushGitHubReferences(output, createsReference, sessionId, parentRunId, state, events);
			}
		}
		if (state.startedRuns.has(block.tool_use_id) && !state.finishedRuns.has(block.tool_use_id)) {
			state.finishedRuns.add(block.tool_use_id);
			events.push(event(sessionId, parentRunId, {
				type: 'subagent.finished',
				runId: block.tool_use_id,
				state: result.ok ? 'success' : 'failed',
				resultText: output,
			}));
		}
		if (!emittedTodos) {
			const todos = todosFromToolResult(message.tool_use_result);
			if (todos) {
				emittedTodos = true;
				events.push(event(sessionId, parentRunId, { type: 'todo.changed', items: todos }));
			}
		}
	}
}

/** The failure a session shows when Claude Code stopped it at its `maxBudgetUsd`. */
export const CLAUDE_BUDGET_STOP_MESSAGE = 'Claude Code stopped this run at its spending limit.';

function normalizeResult(message: Record<string, unknown>, sessionId: string, parentRunId: string | undefined, state: ClaudeNormalizerState, events: NormalizedClaudeEvent[]): 'success' | 'error' {
	const usage = readUsage(message.usage);
	if (usage) {
		if (parentRunId === undefined && state.lastContext) {
			usage.contextTokens = state.lastContext.tokens;
			usage.contextWindow = contextWindow(message.modelUsage, state.lastContext.model);
		}
		if (parentRunId === undefined && typeof message.total_cost_usd === 'number' && Number.isFinite(message.total_cost_usd)) {
			usage.costUsd = message.total_cost_usd;
		}
		// Claude Code prices only the main loop, so a subagent's cost is estimated from its tokens (issue 836).
		if (parentRunId !== undefined && usage.costUsd === undefined) {
			usage.costUsd = claudeEstimateCostUsd(state.lastContext?.model, usage);
		}
		events.push(event(sessionId, parentRunId, { type: 'usage.changed', usage }));
	}
	let ended: 'success' | 'error' = 'success';
	if (message.subtype === 'success' && message.is_error !== true) {
		if (typeof message.result === 'string' && message.result.length > 0) {
			pushCompleted(message.result, `result:${state.turn}\n${parentRunId ?? ''}`, sessionId, parentRunId, state, events);
		}
	} else if (message.subtype === 'success') {
		const text = typeof message.result === 'string' ? message.result : failureMessage('unknown');
		events.push(event(sessionId, parentRunId, { type: 'session.failed', message: text, kind: classifyResultFailure(text) }));
		ended = 'error';
	} else if (message.subtype === 'error_max_turns') {
		// The query reached its `maxTurns` cap (issues 696, 707): a calm stop that Continue resumes, not an error.
		const turns = typeof message.num_turns === 'number' && Number.isInteger(message.num_turns) && message.num_turns > 0 ? message.num_turns : undefined;
		events.push(event(sessionId, parentRunId, { type: 'session.failed', message: failureMessage('turn-limit'), kind: 'turn-limit', ...(turns !== undefined ? { turns } : {}) }));
		ended = 'error';
	} else {
		const errors = Array.isArray(message.errors) ? message.errors.filter((item): item is string => typeof item === 'string') : [];
		// A run that hit `maxBudgetUsd` (issue 424) ends as a failed turn that says why, not as an unknown error.
		const text = errors[0] || (message.subtype === 'error_max_budget_usd' ? CLAUDE_BUDGET_STOP_MESSAGE : failureMessage('unknown'));
		events.push(event(sessionId, parentRunId, { type: 'session.failed', message: claudeSandboxFailureMessage(text, process.platform) ?? text, kind: classifyResultFailure(text) }));
		ended = 'error';
	}
	pushFastMode(message, sessionId, parentRunId, state, events);
	// Thinking bookkeeping is per turn; nothing still open belongs to the next one.
	state.thinkingBlocks.clear();
	state.streamedThinking.clear();
	state.turn++;
	state.lastCompletedText = undefined;
	if (parentRunId === undefined) {
		// The next turn reports its own context size; a turn with no main-loop assistant message reports none.
		state.lastContext = undefined;
	}
	return ended;
}

function normalizeRateLimit(message: Record<string, unknown>, sessionId: string, parentRunId: string | undefined, state: ClaudeNormalizerState, events: NormalizedClaudeEvent[]): void {
	const limit = claudeUsageLimitFromRateLimitInfo(message.rate_limit_info);
	if (limit) {
		state.lastRateLimit = limit;
	}
	if (limit?.status === 'rejected') {
		events.push(event(sessionId, parentRunId, { type: 'session.failed', message: failureMessage('usage-limit'), kind: 'usage-limit', limit }));
	}
}

function normalizeAuthStatus(message: Record<string, unknown>, sessionId: string, parentRunId: string | undefined, events: NormalizedClaudeEvent[]): void {
	if (message.isAuthenticating === true) {
		return;
	}
	if (typeof message.error === 'string' && message.error.length > 0) {
		events.push(event(sessionId, parentRunId, { type: 'session.failed', message: failureMessage('auth'), kind: 'auth' }));
	}
}

function readInit(message: Record<string, unknown>): ClaudeInitMetadata {
	return {
		slashCommands: stringList(message.slash_commands),
		skills: stringList(message.skills),
		model: typeof message.model === 'string' ? message.model : undefined,
		claudeCodeVersion: typeof message.claude_code_version === 'string' ? message.claude_code_version : undefined,
	};
}

function toolCallFromBlock(block: Record<string, unknown>): ToolCall | undefined {
	if (typeof block.id !== 'string' || typeof block.name !== 'string') {
		return undefined;
	}
	const input = block.input ?? {};
	const record = isRecord(input) ? input : {};
	const file = stringField(record, 'file_path') ?? stringField(record, 'path') ?? stringField(record, 'notebook_path');
	const query = stringField(record, 'pattern') ?? stringField(record, 'query');
	const command = stringField(record, 'command');
	return {
		id: block.id,
		name: block.name,
		category: classifyTool(block.name),
		input,
		display: {
			label: block.name,
			file,
			query,
			command,
		},
	};
}

function subagentFromTool(call: ToolCall, parentRunId: string | undefined): ClaudeSubagentRun {
	const input = isRecord(call.input) ? call.input : {};
	return {
		id: call.id,
		parentRunId,
		agentType: stringField(input, 'subagent_type') ?? stringField(input, 'name') ?? call.name,
		description: stringField(input, 'description') ?? stringField(input, 'prompt') ?? '',
		model: stringField(input, 'model'),
		background: input.run_in_background === true || input.background === true,
		state: 'running',
		startedAt: Date.now(),
		toolCallCount: 0,
	};
}

function todosFromToolResult(value: unknown): TodoItem[] | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const list = Array.isArray(value.newTodos) ? value.newTodos : Array.isArray(value.todos) ? value.todos : undefined;
	if (!list) {
		return undefined;
	}
	const items: TodoItem[] = [];
	for (const entry of list) {
		if (!isRecord(entry) || typeof entry.content !== 'string') {
			continue;
		}
		const status = entry.status === 'in_progress' || entry.status === 'completed' || entry.status === 'pending' ? entry.status : undefined;
		if (!status) {
			continue;
		}
		items.push({
			id: typeof entry.id === 'string' ? entry.id : String(items.length),
			content: entry.content,
			status,
		});
	}
	return items.length > 0 ? items : undefined;
}

function readUsage(value: unknown): UsageInfo | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const inputTokens = numberField(value, 'input_tokens') ?? numberField(value, 'inputTokens');
	const outputTokens = numberField(value, 'output_tokens') ?? numberField(value, 'outputTokens');
	if (inputTokens === undefined && outputTokens === undefined) {
		return undefined;
	}
	const cacheReadTokens = numberField(value, 'cache_read_input_tokens');
	const cacheWriteTokens = numberField(value, 'cache_creation_input_tokens');
	return {
		inputTokens,
		outputTokens,
		...cacheReadTokens !== undefined ? { cacheReadTokens } : {},
		...cacheWriteTokens !== undefined ? { cacheWriteTokens } : {},
	};
}

/** What one model call held: new input, cache reads and writes, and the output it added. */
function contextTokens(value: unknown): number | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const parts = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'].map(key => numberField(value, key));
	if (parts.every(part => part === undefined)) {
		return undefined;
	}
	return parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
}

/**
 * The window of the model that made the last call. With one model in the
 * report that is its window; with several and no match, nothing is guessed.
 */
function contextWindow(value: unknown, model: string | undefined): number | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const entries = Object.entries(value).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]));
	const match = (model ? entries.find(([id]) => id === model) : undefined) ?? (entries.length === 1 ? entries[0] : undefined);
	const window = match ? numberField(match[1], 'contextWindow') : undefined;
	return window !== undefined && window > 0 ? window : undefined;
}

function classifyResultFailure(text: string): AgentFailureKind {
	const lower = text.toLowerCase();
	if (lower.includes('auth') || lower.includes('sign in') || lower.includes('401')) {
		return 'auth';
	}
	if (lower.includes('rate limit') || lower.includes('usage limit') || lower.includes('429')) {
		return 'usage-limit';
	}
	if (lower.includes('network') || lower.includes('econnreset') || lower.includes('fetch failed')) {
		return 'network';
	}
	return 'unknown';
}

function toolResultText(content: unknown): string | undefined {
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return undefined;
	}
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
			parts.push(block.text);
		}
	}
	return parts.length > 0 ? parts.join('') : undefined;
}

/** The most images one tool result keeps, and the most base64 characters each keeps. */
export const CLAUDE_TOOL_RESULT_MAX_IMAGES = 4;
export const CLAUDE_TOOL_RESULT_MAX_IMAGE_CHARS = 6 * 1024 * 1024;

const RESULT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * The raster images and the `structuredContent` of an MCP tool result (issue 897).
 * Images come from base64 `image` blocks in the result's content; an SVG or an
 * image that is too large is left out. `structuredContent` is read from the
 * message's `tool_use_result`, and only when it is an object.
 */
export function toolResultExtras(content: unknown, toolUseResult: unknown): Pick<ToolResult, 'images' | 'structuredContent'> {
	const images: { mimeType: string; data: string }[] = [];
	if (Array.isArray(content)) {
		for (const block of content) {
			if (images.length >= CLAUDE_TOOL_RESULT_MAX_IMAGES || !isRecord(block) || block.type !== 'image' || !isRecord(block.source) || block.source.type !== 'base64') {
				continue;
			}
			const mimeType = block.source.media_type;
			const data = block.source.data;
			if (typeof mimeType === 'string' && typeof data === 'string' && RESULT_IMAGE_TYPES.has(mimeType) && data.length <= CLAUDE_TOOL_RESULT_MAX_IMAGE_CHARS) {
				images.push({ mimeType, data });
			}
		}
	}
	const structured = isRecord(toolUseResult) && isRecord(toolUseResult.structuredContent) ? toolUseResult.structuredContent : undefined;
	return {
		...(images.length ? { images } : {}),
		...(structured ? { structuredContent: structured } : {}),
	};
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === 'string');
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function event<T extends NormalizedClaudeEvent['type']>(sessionId: string, parentRunId: string | undefined, body: { type: T } & Omit<Extract<NormalizedClaudeEvent, { type: T }>, 'sessionId' | 'parentRunId'>): NormalizedClaudeEvent {
	if (parentRunId) {
		// Spreading a generic event body is already checked against that event type.
		// eslint-disable-next-line local/code-no-dangerous-type-assertions
		return { sessionId, parentRunId, ...body } as NormalizedClaudeEvent;
	}
	// eslint-disable-next-line local/code-no-dangerous-type-assertions
	return { sessionId, ...body } as NormalizedClaudeEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : 'Error';
}
