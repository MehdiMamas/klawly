/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { chatReferenceSummary, continueSessionSummary } from '../../../../platform/claude/common/claudeChatReference.js';
import { AgentReducerEvent, AgentViewState, EMPTY_AGENT_VIEW_STATE, reduceAgentState, SubagentViewModel, turnParts, TurnViewModel } from './claudeAgentState.js';
import { redactSecrets } from './claudeAgentLog.js';

export interface TranscriptExport {
	readonly markdown: string;
	readonly json: string;
	readonly summary: string;
	readonly changedFiles: readonly string[];
	readonly openTodos: readonly string[];
	readonly turnCount: number;
}

/**
 * Replay persisted events. A running turn or tool is marked interrupted and is not resumed.
 * Interrupted stays until a later `turn.submitted`. A second reopen still sees it, because
 * `session.recovered` is the last word until the user sends again.
 */
export function replayDurableEvents(events: readonly AgentReducerEvent[]): { readonly state: AgentViewState; readonly events: readonly AgentReducerEvent[]; readonly interrupted: boolean } {
	let state = EMPTY_AGENT_VIEW_STATE;
	for (const event of events) {
		state = reduceAgentState(state, event);
	}
	const running = state.turns.some(turn => turn.status === 'running') || state.subagents.some(subagent => subagent.run.state === 'running');
	if (!running) {
		return { state, events, interrupted: interruptionStillOpen(events) };
	}
	const recovered: AgentReducerEvent = { type: 'session.recovered' };
	return { state: reduceAgentState(state, recovered), events: [...events, recovered], interrupted: true };
}

function interruptionStillOpen(events: readonly AgentReducerEvent[]): boolean {
	let recovered = -1;
	let submitted = -1;
	for (let index = 0; index < events.length; index++) {
		const event = events[index];
		if (event.type === 'session.recovered') {
			recovered = index;
		} else if (event.type === 'turn.submitted') {
			submitted = index;
		}
	}
	return recovered > submitted;
}

/** Events from the start of the session through the end of `turnId`. */
export function eventsThroughTurn(events: readonly AgentReducerEvent[], turnId: string): AgentReducerEvent[] {
	let seen = false;
	let cut = events.length;
	for (let index = 0; index < events.length; index++) {
		const event = events[index];
		if (event.type !== 'turn.submitted') {
			continue;
		}
		if (seen) {
			cut = index;
			break;
		}
		if (event.turnId === turnId) {
			seen = true;
		}
	}
	return seen ? events.slice(0, cut) : [];
}

/** User-visible transcript. Secrets are removed. Raw tool input is omitted unless `raw` is set. */
export function exportTranscript(state: AgentViewState, title: string, options: { readonly raw?: boolean; readonly summaryChars?: number; readonly asOfTurn?: number; readonly turnRange?: readonly [number, number]; readonly subagentId?: string } = {}): TranscriptExport {
	const end = options.turnRange?.[1] ?? options.asOfTurn ?? state.turns.length;
	const start = Math.max(0, (options.turnRange?.[0] ?? 1) - 1);
	const turns = state.turns.slice(start, end);
	const subagent = options.subagentId ? state.subagents.find(candidate => candidate.run.id === options.subagentId) : undefined;
	const visible = subagent ? [subagent.chat] : turns;
	const changed = unique(visible.flatMap(turn => turn.changedFiles));
	const todos = openTodos(state);
	const blocks: string[] = [`# ${title}`];
	const jsonTurns: unknown[] = [];
	for (const turn of visible) {
		blocks.push(turnMarkdown(turn, options.raw === true));
		jsonTurns.push(turnJson(turn, options.raw === true));
	}
	if (!subagent) {
		for (const nested of state.subagents.filter(candidate => turns.some(turn => turn.id === candidate.parentTurnId))) {
			blocks.push(subagentMarkdown(nested, options.raw === true));
			jsonTurns.push({ subagent: nested.run.id, parentRunId: nested.run.parentRunId, agentType: nested.run.agentType, description: nested.run.description, ...turnJson(nested.chat, options.raw === true) });
		}
	}
	const first = visible[0]?.user.text ?? '';
	const last = [...visible].reverse().find(turn => turn.assistantText.trim())?.assistantText ?? '';
	const summary = chatReferenceSummary({
		title,
		firstUser: first,
		finalAssistant: last,
		changedFiles: changed,
		openTodos: todos,
	}, options.summaryChars ?? 1500);
	return {
		markdown: redactSecrets(blocks.join('\n\n')),
		json: redactSecrets(JSON.stringify({ title, turns: jsonTurns }, null, 2)),
		summary: redactSecrets(summary),
		changedFiles: changed,
		openTodos: todos,
		turnCount: visible.length,
	};
}

export function continueSummaryFor(state: AgentViewState, title: string, workspaceName: string, turnRange?: readonly [number, number]): string {
	const exported = exportTranscript(state, title, { turnRange });
	const end = turnRange?.[1] ?? state.turns.length;
	const start = Math.max(0, (turnRange?.[0] ?? 1) - 1);
	const turns = state.turns.slice(start, end);
	const first = turns[0]?.user.text ?? '';
	const last = [...turns].reverse().find(turn => turn.assistantText.trim())?.assistantText ?? '';
	return redactSecrets(continueSessionSummary({
		title,
		workspaceName,
		firstUser: first,
		finalAssistant: last,
		changedFiles: exported.changedFiles,
	}));
}

function turnMarkdown(turn: TurnViewModel, raw: boolean): string {
	const lines = [`## ${turn.user.text}`];
	// Text and tools in the order they happened, like the timeline.
	for (const part of turnParts(turn)) {
		if (part.kind === 'text' || part.kind === 'plan') {
			if (part.text.trim()) {
				lines.push(part.text.trim());
			}
			continue;
		}
		const card = part.kind === 'tool' ? turn.cards.find(candidate => candidate.id === part.id) : undefined;
		if (card) {
			lines.push(`- ${card.verb} ${card.target} (${card.state})`);
			if (raw && card.command) {
				lines.push(`  command: ${card.command}`);
			}
		}
	}
	if (turn.failure) {
		lines.push(`Failed: ${turn.failure.message}`);
	}
	return lines.join('\n');
}

function turnJson(turn: TurnViewModel, raw: boolean) {
	return {
		id: turn.id,
		user: turn.user.text,
		assistant: turn.assistantText,
		...(raw && turn.user.sent?.compiled ? { sent: turn.user.sent.compiled } : {}),
		tools: turn.cards.map(card => ({
			label: card.label,
			state: card.state,
			target: card.target,
			...(raw && card.command ? { command: card.command } : {}),
		})),
		changedFiles: turn.changedFiles,
		failure: turn.failure?.message,
	};
}

function subagentMarkdown(subagent: SubagentViewModel, raw: boolean): string {
	const parent = subagent.run.parentRunId ? ` parent ${subagent.run.parentRunId}` : '';
	return `### Subagent ${subagent.run.agentType}${parent}\n${subagent.run.description}\n\n${turnMarkdown(subagent.chat, raw)}`;
}

function openTodos(state: AgentViewState): string[] {
	const plan = [...state.turns].reverse().find(turn => turn.plan)?.plan;
	if (!plan) {
		return [];
	}
	return plan.steps.filter(step => step.status !== 'done').map(step => step.title);
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}
