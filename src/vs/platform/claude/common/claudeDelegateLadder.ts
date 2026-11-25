/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeDelegateTier } from './claudeDelegateContract.js';

/** Settings > Agents > Delegation: failed calls in a row that move a delegated worker up one tier (0 turns it off). */
export const CLAUDE_DELEGATION_WORKER_FAILED_CALLS_SETTING = 'klawly.delegation.ladder.workerFailedCalls';
/** Failed calls that send a cheap in-session turn back to the chat's own model (0 turns it off). */
export const CLAUDE_DELEGATION_SESSION_FAILED_CALLS_SETTING = 'klawly.delegation.ladder.sessionFailedCalls';
/** Steps (tool calls) after which a cheap in-session turn goes back to the chat's own model (0 turns it off). */
export const CLAUDE_DELEGATION_SESSION_STEPS_SETTING = 'klawly.delegation.ladder.sessionSteps';

export interface ClaudeDelegationLadderThresholds {
	readonly workerFailedCalls: number;
	readonly sessionFailedCalls: number;
	readonly sessionSteps: number;
}

export const CLAUDE_DELEGATION_LADDER_DEFAULTS: ClaudeDelegationLadderThresholds = { workerFailedCalls: 4, sessionFailedCalls: 3, sessionSteps: 30 };

/** A threshold from settings: a whole number of 0 or more, else the default. */
export function readClaudeDelegationLadderThreshold(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** A tool call as the ladder counts it. Only the state matters. */
export interface ClaudeLadderCall {
	readonly state: 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted';
}

/** Failed calls at the end of the list with no finished call after them. A running call neither fails nor breaks the run; a success or a cancelled call does. */
export function countTrailingFailedCalls(calls: readonly ClaudeLadderCall[]): number {
	let failed = 0;
	for (let index = calls.length - 1; index >= 0; index--) {
		const state = calls[index].state;
		if (state === 'running') {
			continue;
		}
		if (state !== 'failed') {
			break;
		}
		failed++;
	}
	return failed;
}

/** True when `failed` reaches a threshold that is on. */
export function reachedClaudeLadderThreshold(count: number, threshold: number): boolean {
	return threshold > 0 && count >= threshold;
}

/** One step up the worker ladder: Small, then Medium, then Large (the chat's own model by default). Undefined at the top. */
export function nextClaudeDelegateTier(tier: ClaudeDelegateTier | undefined): ClaudeDelegateTier | undefined {
	switch (tier) {
		case 'small': return 'medium';
		case 'medium': return 'large';
		default: return undefined;
	}
}

/**
 * The tier a struggling worker moves to. Tiers whose model is the one it
 * already runs on are skipped, so an escalation always changes the model.
 * `aliasOf` is the tier's model setting: empty means the delegating chat's model.
 */
export function climbClaudeDelegateLadder(tier: ClaudeDelegateTier | undefined, currentAlias: string, aliasOf: (tier: ClaudeDelegateTier) => string): ClaudeDelegateTier | undefined {
	for (let next = nextClaudeDelegateTier(tier); next; next = nextClaudeDelegateTier(next)) {
		if (aliasOf(next) !== currentAlias) {
			return next;
		}
	}
	return undefined;
}

/** What made a turn climb: failed calls in a row, or too many steps. */
export type ClaudeEscalationCause = 'failed-calls' | 'steps';

/** Whether a cheap in-session turn goes back to the chat's own model, and why. */
export function sessionFallbackCause(calls: readonly ClaudeLadderCall[], thresholds: Pick<ClaudeDelegationLadderThresholds, 'sessionFailedCalls' | 'sessionSteps'>): ClaudeEscalationCause | undefined {
	if (reachedClaudeLadderThreshold(countTrailingFailedCalls(calls), thresholds.sessionFailedCalls)) {
		return 'failed-calls';
	}
	if (reachedClaudeLadderThreshold(calls.length, thresholds.sessionSteps)) {
		return 'steps';
	}
	return undefined;
}

/** One escalation, as the decision log and the workers view show it. */
export interface ClaudeEscalation {
	readonly time: number;
	readonly from: string;
	readonly to: string;
	readonly fromTier?: ClaudeDelegateTier;
	readonly toTier?: ClaudeDelegateTier;
	readonly cause: ClaudeEscalationCause;
	/** The count that tripped the threshold: failed calls in a row, or steps. */
	readonly count: number;
}

/** One JSON line for the decision log. */
export function formatEscalationLogLine(escalation: ClaudeEscalation): string {
	return JSON.stringify({ time: new Date(escalation.time).toISOString(), kind: 'escalation', from: escalation.from, to: escalation.to, fromTier: escalation.fromTier, toTier: escalation.toTier, cause: escalation.cause, count: escalation.count });
}
