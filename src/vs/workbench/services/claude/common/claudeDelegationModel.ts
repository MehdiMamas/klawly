/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeDelegateBudget, ClaudeDelegateBudgetState, ClaudeDelegateContract, ClaudeDelegateTier } from '../../../../platform/claude/common/claudeDelegateContract.js';
import { ClaudeDelegateToolResult } from '../../../../platform/claude/common/claudeDelegate.js';
import { localize } from '../../../../nls.js';
import { ClaudeEscalation } from '../../../../platform/claude/common/claudeDelegateLadder.js';
import { ClaudeEffortLevel } from '../../../../platform/claude/common/claudeSessionSettings.js';

/**
 * Delegation in the window (issue 693): what a delegate card shows, how Auto
 * decides to delegate, and what the parent chat reads back. Pure, so both the
 * agent service and the delegation service use it without a cycle.
 */

export type ClaudeDelegateState = 'running' | 'done' | 'stopped' | 'failed';

/** One delegated chat, as its card in the parent chat shows it. */
export interface ClaudeDelegateCard {
	readonly id: string;
	/** The chat that delegated. */
	readonly parentSessionId: string;
	/** The parent chat's turn the card belongs to. */
	readonly parentTurnId: string;
	/** The read-only delegated chat. */
	readonly childSessionId: string;
	readonly task: string;
	/** The user's own message when Auto delegated it. Rerun sends it to the top-level chat again. */
	readonly prompt?: string;
	readonly title: string;
	readonly modelId?: string;
	readonly modelLabel: string;
	readonly effort?: ClaudeEffortLevel;
	/** Auto delegated the whole message; otherwise Claude called the delegate tool. */
	readonly auto: boolean;
	readonly state: ClaudeDelegateState;
	/** The user pressed Stop on this card or on a card above it. */
	readonly stoppedByUser?: boolean;
	/** The delegated chat's answer, once done. */
	readonly result?: string;
	/** Why it failed. */
	readonly message?: string;
	/** What the delegated chat and every chat under it cost, in US dollars. */
	readonly costUsd?: number;
	/** The user kept Auto after a stop, so the card offers Rerun. It never reruns on its own. */
	readonly rerun?: boolean;
	/** Chats this delegated chat delegated to, nested under its card. */
	readonly children: readonly ClaudeDelegateCard[];
	readonly startedAt: number;
	readonly endedAt?: number;
	/** The contract's goal (issue 837). */
	readonly objective?: string;
	/** How the worker's job is checked. */
	readonly acceptance?: string;
	readonly tier?: ClaudeDelegateTier;
	/** Why it went to this tier: the reason given with it or the classifier's (issue 987). */
	readonly routeReason?: string;
	/** How the router decided, such as "tier and reason given". */
	readonly routeWhy?: string;
	/** Each time the worker moved up a tier after failed calls (issue 839), oldest first. */
	readonly escalations?: readonly ClaudeEscalation[];
	readonly budget?: ClaudeDelegateBudget;
	/** Tool calls the worker has made, so the card shows budget used. */
	readonly callsUsed?: number;
	/** Where the worker stands against its budget; `stop` once it was stopped for it. */
	readonly budgetState?: ClaudeDelegateBudgetState;
	/** The helper waits on the user: a permission or a form is pending in its chat (#1501). */
	readonly waiting?: boolean;
	/** What it asks, when it can be said in a line. */
	readonly waitingQuestion?: string;
	/** The worker's report, at most 300 words. */
	readonly report?: string;
	/** The worker had nothing to say: the parent is not told. */
	readonly quiet?: boolean;
}

/** What `delegate` needs to start a delegated chat. */
export interface ClaudeDelegateRequest extends ClaudeDelegateContract {
	readonly parentSessionId: string;
	/** The parent turn the card goes in. Absent uses the parent's newest turn. */
	readonly parentTurnId?: string;
	readonly task: string;
	/** The user's own message when Auto delegated it, without the context `task` adds. */
	readonly prompt?: string;
	/** A model id or alias. Absent keeps the parent chat's model. */
	readonly model?: string;
	readonly effort?: ClaudeEffortLevel;
	readonly title?: string;
	/** The template (issue 1110) the call came from, such as `watch-ci`. */
	readonly template?: string;
	readonly auto: boolean;
}

/**
 * The agent service hands delegation to this handler, which the delegation
 * service registers, so neither service depends on the other through DI.
 */
export interface ClaudeAgentDelegateHandler {
	delegate(request: ClaudeDelegateRequest): Promise<ClaudeDelegateToolResult>;
	/**
	 * The chat was stopped from its own Stop button or closed: every delegated
	 * chat under it stops, and no question is asked.
	 */
	stopUnder(sessionId: string, closing: boolean): void;
}

/**
 * How Auto handles one message (issue 693).
 * - `switch`: no delegation here (no handler, or a delegated chat), so the turn runs on the pick as before.
 * - `adopt`: the chat has no conversation yet, so it starts on the pick.
 * - `stay`: the pick is the chat's model, or the chat's model is unknown; the chat answers.
 * - `delegate`: a delegated chat on the pick answers; the chat keeps its model and cache.
 */
export type ClaudeAutoRoute = 'switch' | 'adopt' | 'stay' | 'delegate';

export interface ClaudeAutoRouteInput {
	readonly canDelegate: boolean;
	/** The chat is itself a delegated chat. */
	readonly delegated: boolean;
	readonly hasConversation: boolean;
	readonly chatModel: string | undefined;
	readonly pick: string;
}

export function claudeAutoRoute(input: ClaudeAutoRouteInput): ClaudeAutoRoute {
	if (!input.canDelegate || input.delegated) {
		return 'switch';
	}
	if (!input.hasConversation) {
		return 'adopt';
	}
	if (!input.chatModel || sameClaudeModel(input.chatModel, input.pick)) {
		return 'stay';
	}
	return 'delegate';
}

/** True when two ids name the same model: equal, or one is a dated form of the other. */
function sameClaudeModel(a: string, b: string): boolean {
	const left = a.toLowerCase();
	const right = b.toLowerCase();
	return left === right || left.startsWith(`${right}-`) || right.startsWith(`${left}-`) || left.replace(/\[1m\]$/, '') === right.replace(/\[1m\]$/, '');
}

const TITLE_MAX = 60;

/** The card's title: the given one, else the task's first line, cut short. */
export function claudeDelegateTitle(task: string, title?: string): string {
	const line = (title?.trim() || task.trim().split(/\r?\n/)[0] || '').replace(/\s+/g, ' ');
	return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

const CONTEXT_TURNS = 3;
const CONTEXT_CHARS = 600;

/**
 * The task Auto hands over: the message, after the last few exchanges of the
 * chat, because the delegated chat does not see the conversation.
 */
export function claudeDelegateTask(message: string, history: readonly { readonly user: string; readonly assistant: string }[]): string {
	const recent = history.filter(turn => turn.user.trim() || turn.assistant.trim()).slice(-CONTEXT_TURNS);
	if (recent.length === 0) {
		return message;
	}
	const cut = (text: string) => {
		const trimmed = text.trim();
		return trimmed.length > CONTEXT_CHARS ? `${trimmed.slice(0, CONTEXT_CHARS)}…` : trimmed;
	};
	const lines = ['The conversation so far, for context:', ''];
	for (const turn of recent) {
		lines.push(`User: ${cut(turn.user)}`);
		if (turn.assistant.trim()) {
			lines.push(`Assistant: ${cut(turn.assistant)}`);
		}
		lines.push('');
	}
	lines.push('The task:', '', message);
	return lines.join('\n');
}

const NOTE_CHARS = 4000;

/**
 * What the chat's own model reads ahead of its next message after Auto
 * delegated one, so the conversation stays whole.
 */
export function claudeDelegateNote(card: Pick<ClaudeDelegateCard, 'task' | 'modelLabel' | 'state' | 'result' | 'message'>): string {
	const task = card.task.length > NOTE_CHARS ? `${card.task.slice(0, NOTE_CHARS)}…` : card.task;
	switch (card.state) {
		case 'done': {
			const result = (card.result ?? '').trim();
			const cut = result.length > NOTE_CHARS ? `${result.slice(0, NOTE_CHARS)}…` : result;
			return `[Klawly] Auto handed the user's last message to a delegated chat on ${card.modelLabel}. The message:\n${task}\n\nIt answered:\n${cut || '(no answer)'}`;
		}
		case 'stopped':
			return `[Klawly] Auto handed the user's last message to a delegated chat on ${card.modelLabel}, and the user stopped it. Do not redo it unless the user asks. The message:\n${task}`;
		default:
			return `[Klawly] Auto handed the user's last message to a delegated chat on ${card.modelLabel}, and it failed: ${card.message ?? ''}. The message:\n${task}`;
	}
}

/** Puts a changed card in place, by id, in a tree of cards. */
export function replaceClaudeDelegateCard(cards: readonly ClaudeDelegateCard[], card: ClaudeDelegateCard): readonly ClaudeDelegateCard[] {
	const index = cards.findIndex(candidate => candidate.id === card.id);
	if (index < 0) {
		return [...cards, card];
	}
	const next = cards.slice();
	next[index] = card;
	return next;
}

/** An escalation in plain words: "Moved up from Haiku to Sonnet after 4 failed calls in a row." */
export function claudeEscalationSentence(escalation: Pick<ClaudeEscalation, 'from' | 'to' | 'cause' | 'count'>): string {
	return escalation.cause === 'failed-calls'
		? localize('claudeEscalationFailedCalls', "Moved up from {0} to {1} after {2} failed calls in a row.", escalation.from, escalation.to, escalation.count)
		: localize('claudeEscalationSteps', "Moved up from {0} to {1} after {2} steps.", escalation.from, escalation.to, escalation.count);
}

/** A turn's fall back to the chat's own model in plain words: "Went back to your model, Opus, after 3 failed calls in a row." */
export function claudeFallbackSentence(escalation: Pick<ClaudeEscalation, 'to' | 'cause' | 'count'>): string {
	return escalation.cause === 'failed-calls'
		? localize('claudeFallbackFailedCalls', "Went back to your model, {0}, after {1} failed calls in a row.", escalation.to, escalation.count)
		: localize('claudeFallbackSteps', "Went back to your model, {0}, after {1} steps.", escalation.to, escalation.count);
}
