/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeRuntimeState } from '../../../../platform/claude/common/claude.js';
import { NormalizedClaudeEvent } from '../../../../platform/claude/common/claudeProtocol.js';
import { redactClaudeSecrets } from '../../../../platform/claude/common/claudeSecretPatterns.js';

/** Output channel id for Claude Agent logs. */
export const CLAUDE_AGENT_OUTPUT_CHANNEL_ID = 'claudeAgent';

/** Full command output. The card keeps a capped preview. */
export const CLAUDE_COMMAND_LOG_CHANNEL_ID = 'claudeCommandLog';

const MAX_LOG_TEXT = 300;

/**
 * Redact credential-shaped text. The output channel may keep versions, lifecycle,
 * tool names, timings, and errors. It must not keep tokens or file bodies.
 * The patterns live in `claudeSecretPatterns.ts`, shared with the attachment scanner.
 */
export function redactSecrets(text: string): string {
	return redactClaudeSecrets(text);
}

/** One output-channel line from a free-form message: redacted, ending in a newline. */
export function formatClaudeLogLine(message: string): string {
	const redacted = redactSecrets(message);
	return redacted.endsWith('\n') ? redacted : `${redacted}\n`;
}

function clip(text: string): string {
	const redacted = redactSecrets(text).replace(/\s+/g, ' ').trim();
	return redacted.length > MAX_LOG_TEXT ? `${redacted.slice(0, MAX_LOG_TEXT)}…` : redacted;
}

export function formatClaudeRuntimeState(state: ClaudeRuntimeState): string {
	const version = state.version ? redactSecrets(state.version) : 'unknown';
	const authMode = state.authMode ?? 'unknown';
	let line = `[claude] runtime installed=${state.installed} authenticated=${state.authenticated} version=${version} authMode=${authMode}`;
	if (state.error) {
		line += ` error=${clip(state.error)}`;
	}
	return line;
}

/**
 * One output line for a normalized event. Tool inputs, file bodies, assistant and
 * thinking text, and subagent result text are omitted.
 */
export function formatClaudeAgentEvent(event: NormalizedClaudeEvent, elapsedMs: number): string {
	const parent = event.parentRunId ? ` parent=${event.parentRunId}` : '';
	const head = `[claude] +${elapsedMs}ms ${event.type} session=${event.sessionId}${parent}`;
	switch (event.type) {
		case 'session.started':
			return event.model ? `${head} model=${redactSecrets(event.model)}` : head;
		case 'assistant.delta':
		case 'assistant.completed':
			return `${head} chars=${event.text.length}`;
		case 'thinking.delta':
			// The thinking text stays out of the log, like assistant text.
			return `${head} chars=${event.text.length}${event.tokens !== undefined ? ` tokens=${event.tokens}` : ''}${event.done ? ' done' : ''}`;
		case 'tool.started':
			return `${head} tool=${redactSecrets(event.call.name)} category=${event.call.category}`;
		case 'tool.updated':
			return `${head} callId=${event.callId}`;
		case 'tool.completed':
			return `${head} callId=${event.callId} ok=${event.result.ok}`;
		case 'permission.requested':
			return `${head} tool=${redactSecrets(event.request.toolName)}`;
		case 'permission.resolved':
			// The command or path is left out: it can carry a secret.
			return `${head} tool=${redactSecrets(event.outcome.toolName)} decision=${event.outcome.decision} source=${event.outcome.source}${event.outcome.scope ? ` scope=${event.outcome.scope}` : ''}`;
		case 'file.beforeWrite':
		case 'file.afterWrite':
			return `${head} uri=${clip(event.uri)}`;
		case 'todo.changed':
			return `${head} count=${event.items.length}`;
		case 'usage.changed':
			return `${head} inputTokens=${event.usage.inputTokens ?? ''} outputTokens=${event.usage.outputTokens ?? ''}`;
		case 'session.failed':
			return `${head} kind=${event.kind ?? 'unknown'} message=${clip(event.message)}`;
		case 'session.modelChanged':
			return `${head} model=${redactSecrets(event.modelId)}`;
		case 'session.settingsChanged':
			return `${head} effort=${event.settings.effort ?? 'default'} fast=${event.settings.fastMode === true} ultracode=${event.settings.ultracode === true} thinking=${event.settings.thinking !== false}`;
		case 'session.fastMode':
			return `${head} state=${event.status.state}${event.status.state === 'unavailable' ? ` reason=${event.status.reason}` : ''}`;
		case 'session.catalog':
			return `${head} commands=${event.commands.length} agents=${event.agents.length}`;
		case 'session.titled':
			return `${head} chars=${event.title.length}`;
		case 'subagent.started':
			return `${head} run=${event.run.id} agent=${redactSecrets(event.run.agentType)} state=${event.run.state}`;
		case 'subagent.finished':
			return `${head} run=${event.runId} state=${event.state}`;
		case 'session.usageLimits':
			return `${head} windows=${event.windows.map(window => `${window.kind}:${Math.round(window.percent)}`).join(',')}`;
		case 'github.referenceDetected':
			return `${head} kind=${event.reference.kind} created=${event.reference.createdBySession}`;
		case 'elicitation.requested':
			// The message, form and URL stay out of the log: a server can put a secret in any of them.
			return `${head} server=${redactSecrets(event.request.server)} mode=${event.request.mode}`;
		case 'elicitation.resolved':
			return `${head} server=${redactSecrets(event.outcome.server)} action=${event.outcome.action} source=${event.outcome.source}`;
		case 'elicitation.completed':
			return `${head} server=${redactSecrets(event.server)}`;
		case 'review.findings':
			return `${head} review=${event.reviewId} findings=${event.findings.length}`;
		case 'session.compacted':
		case 'session.completed':
			return head;
	}
}

export function formatClaudeAgentFailure(message: string): string {
	return `[claude] test session failed: ${clip(message)}`;
}
