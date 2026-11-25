/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { ClaudeAutoComplexity } from './claudeAutoModel.js';
import { CLAUDE_MODEL_PRICES, claudeModelFamily } from './claudeModelPricing.js';

/**
 * Cost watcher (issue 847): watches an expensive chat's tool calls and nudges
 * it to hand mechanical runs to a worker (`klawly_delegate`). The more each
 * call costs, the sooner it nudges. Small-model (Haiku) chats are never
 * nudged. With refusal on, after three ignored nudges the next tool call is
 * refused until the chat delegates or gives a reason a cheap model accepts.
 *
 * Break-even: tool calls N* above which a worker is cheaper than running the
 * calls in the chat itself. Measured 2026-10-14 by session-manager
 * (a session-manager measurement, Claude Code on
 * Windows, real `claude -p` runs, about $0.75 spent), warm worker cache,
 * mechanical calls of about 1.8k new tokens and 90 output tokens:
 *
 * | Chat model | Chat context | Haiku worker | Sonnet worker |
 * |---|---|---|---|
 * | Opus   |  50k | 2 |  3 |
 * | Opus   | 150k | 2 |  3 |
 * | Sonnet |  50k | 2 | 27 |
 * | Sonnet | 150k | 2 |  4 |
 *
 * Cold worker cache (no session of that model in the last hour): Opus chat
 * 14 (50k) to 7 (150k) calls for a Sonnet worker; Sonnet chat 239 to 19.
 * Measured too: a worker's start-up prefix is about 41k tokens.
 *
 * From docs, not measured here: the prices in {@link CLAUDE_MODEL_PRICES}
 * (Anthropic's list prices, $ per million tokens), and the model of a call's
 * cost used below: every call re-reads the whole context from the cache, so
 * a call costs about `context × cache-read price + output × output price`.
 * Klawly's own numbers (cost per call in real chats) are not measured yet;
 * the decision log records each nudge with the cost it assumed so they can be.
 */

/** Settings > Agents > Delegation: the cost watcher is on. */
export const CLAUDE_DELEGATION_COST_WATCHER_ENABLED_SETTING = 'klawly.delegation.costWatcher.enabled';
/** Tool calls between nudges for a call of {@link CLAUDE_COST_WATCHER_REFERENCE_CALL_USD}; dearer calls nudge sooner. */
export const CLAUDE_DELEGATION_COST_WATCHER_CADENCE_SETTING = 'klawly.delegation.costWatcher.cadence';
/** After three ignored nudges, refuse the next tool call until the chat delegates or gives a reason. */
export const CLAUDE_DELEGATION_COST_WATCHER_REFUSE_SETTING = 'klawly.delegation.costWatcher.refuse';

export const CLAUDE_COST_WATCHER_DEFAULT_CADENCE = 10;
/** The per-call cost the cadence is set for: an Opus call at about 30k context. */
export const CLAUDE_COST_WATCHER_REFERENCE_CALL_USD = 0.05;
/** Never nudge more often than this: below it a worker does not pay back (break-even table above). */
export const CLAUDE_COST_WATCHER_MIN_INTERVAL = 3;
/** Ignored nudges after which the next call is refused, when refusal is on. */
export const CLAUDE_COST_WATCHER_IGNORED_LIMIT = 3;
/** Output tokens of a mechanical call (break-even measurement). */
const CALL_OUTPUT_TOKENS = 90;

export interface ClaudeCostWatcherSettings {
	readonly enabled: boolean;
	readonly cadence: number;
	readonly refuse: boolean;
}

export function readClaudeCostWatcherSettings(enabled: unknown, cadence: unknown, refuse: unknown): ClaudeCostWatcherSettings {
	return {
		enabled: enabled !== false,
		cadence: typeof cadence === 'number' && Number.isFinite(cadence) && cadence >= 1 ? Math.floor(cadence) : CLAUDE_COST_WATCHER_DEFAULT_CADENCE,
		refuse: refuse === true,
	};
}

/** What one more tool call costs this chat, in dollars. Undefined for a model the price table does not know. */
export function claudeCostWatcherCallCost(model: string | undefined, contextTokens: number | undefined): number | undefined {
	const family = claudeModelFamily(model);
	if (!family) {
		return undefined;
	}
	const price = CLAUDE_MODEL_PRICES[family];
	const context = contextTokens !== undefined && Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : 0;
	return (context * price.cacheRead + CALL_OUTPUT_TOKENS * price.output) / 1_000_000;
}

/** Tool calls between nudges: the cadence at the reference cost, fewer for dearer calls. */
export function claudeCostWatcherInterval(cadence: number, callCostUsd: number): number {
	if (!(callCostUsd > 0)) {
		return Number.POSITIVE_INFINITY;
	}
	const scaled = Math.round(cadence * CLAUDE_COST_WATCHER_REFERENCE_CALL_USD / callCostUsd);
	return Math.min(Math.max(scaled, CLAUDE_COST_WATCHER_MIN_INTERVAL), cadence * 10);
}

export interface ClaudeCostWatchState {
	/** Tool calls the chat had made when the watcher last looked. */
	readonly calls: number;
	readonly callsSinceNudge: number;
	/** A nudge was sent and the chat has not delegated since. */
	readonly nudged: boolean;
	/** Nudges in a row the chat went on past without delegating. */
	readonly ignored: number;
	/** The next tool calls are refused until a delegation or an accepted reason. */
	readonly refusing: boolean;
}

export function newClaudeCostWatchState(calls: number): ClaudeCostWatchState {
	return { calls, callsSinceNudge: 0, nudged: false, ignored: 0, refusing: false };
}

export type ClaudeCostWatchAction =
	| { readonly kind: 'none' }
	| { readonly kind: 'nudge'; readonly interval: number; readonly callCostUsd: number; readonly ignored: number }
	| { readonly kind: 'refuse'; readonly interval: number; readonly callCostUsd: number; readonly ignored: number };

export interface ClaudeCostWatchInput {
	/** Tool calls the chat has made so far. */
	readonly calls: number;
	readonly model: string | undefined;
	readonly contextTokens: number | undefined;
	readonly settings: ClaudeCostWatcherSettings;
}

/** True for a chat the watcher never nudges: Haiku, or a model with no price. */
export function isClaudeCostWatcherExempt(model: string | undefined): boolean {
	const family = claudeModelFamily(model);
	return family === undefined || family === 'haiku';
}

/** One look at the chat: counts the new calls and decides whether to nudge or refuse. */
export function stepClaudeCostWatcher(state: ClaudeCostWatchState, input: ClaudeCostWatchInput): { readonly state: ClaudeCostWatchState; readonly action: ClaudeCostWatchAction } {
	const added = Math.max(0, input.calls - state.calls);
	let next: ClaudeCostWatchState = { ...state, calls: input.calls, callsSinceNudge: state.callsSinceNudge + added };
	const none = { kind: 'none' } as const;
	if (!input.settings.enabled || isClaudeCostWatcherExempt(input.model) || added === 0 || next.refusing) {
		return { state: next, action: none };
	}
	const callCostUsd = claudeCostWatcherCallCost(input.model, input.contextTokens) ?? 0;
	const interval = claudeCostWatcherInterval(input.settings.cadence, callCostUsd);
	if (next.callsSinceNudge < interval) {
		return { state: next, action: none };
	}
	const ignored = next.nudged ? next.ignored + 1 : next.ignored;
	if (input.settings.refuse && ignored >= CLAUDE_COST_WATCHER_IGNORED_LIMIT) {
		next = { ...next, callsSinceNudge: 0, ignored, refusing: true };
		return { state: next, action: { kind: 'refuse', interval, callCostUsd, ignored } };
	}
	next = { ...next, callsSinceNudge: 0, nudged: true, ignored };
	return { state: next, action: { kind: 'nudge', interval, callCostUsd, ignored } };
}

/** The chat delegated: the count starts over. */
export function claudeCostWatcherDelegated(state: ClaudeCostWatchState): ClaudeCostWatchState {
	return newClaudeCostWatchState(state.calls);
}

/** A reason was accepted: the refusal lifts and the ignored count starts over. */
export function claudeCostWatcherReasonAccepted(state: ClaudeCostWatchState): ClaudeCostWatchState {
	return { ...state, callsSinceNudge: 0, nudged: false, ignored: 0, refusing: false };
}

const KEEP_REASON = /^\s*keep reason:\s*(.+)$/im;

/** The reason a refused chat gives for keeping the work: a line `Keep reason: …` in its reply. */
export function parseClaudeKeepReason(text: string | undefined): string | undefined {
	const reason = text?.match(KEEP_REASON)?.[1].trim();
	return reason ? reason.slice(0, 1000) : undefined;
}

/** The prompt the judge (the delegation router's cheap classifier) rates. */
export function claudeCostWatcherJudgePrompt(reason: string, recentTools: readonly string[]): string {
	return [
		'A chat on an expensive model wants to keep doing this work itself instead of handing it to a cheaper worker.',
		`Its reason: ${reason}`,
		recentTools.length ? `Its last tool calls: ${recentTools.join(', ')}` : '',
		'Rate the work it keeps: simple if it is mechanical (running commands, tests, lookups, edits spelled out), moderate or complex if it needs the chat\'s own judgment or context.',
	].filter(Boolean).join('\n');
}

/** Mechanical work goes to a worker, so a simple rating rejects the reason. */
export function claudeCostWatcherVerdict(complexity: ClaudeAutoComplexity): 'accepted' | 'rejected' {
	return complexity === 'simple' ? 'rejected' : 'accepted';
}

export function claudeCostWatcherNudge(interval: number, callCostUsd: number): string {
	return localize('claudeCostWatcherNudge', "Cost check: each tool call here costs about ${0}, and this chat made {1} calls since the last check. Hand mechanical runs (commands, tests, lookups, spelled-out edits, watching CI) to a worker with klawly_delegate and keep the judgment here.", callCostUsd.toFixed(3), interval);
}

export function claudeCostWatcherRefusal(): string {
	return localize('claudeCostWatcherRefusal', "Refused by the cost watcher: this chat went past {0} nudges to delegate. Hand the run to a worker with klawly_delegate, or reply with a line \"Keep reason: <why this needs this chat>\" and try again.", CLAUDE_COST_WATCHER_IGNORED_LIMIT);
}

export function claudeCostWatcherRejected(): string {
	return localize('claudeCostWatcherRejected', "Refused by the cost watcher: the reason given reads as mechanical work. Hand it to a worker with klawly_delegate.");
}

export interface ClaudeCostWatchDecision {
	readonly time: number;
	readonly sessionId: string;
	readonly decision: 'nudge' | 'refuse' | 'accepted' | 'rejected';
	readonly model?: string;
	readonly interval?: number;
	readonly callCostUsd?: number;
	readonly ignored?: number;
	readonly reason?: string;
	readonly complexity?: ClaudeAutoComplexity;
	readonly classifierSkipped?: boolean;
}

/** One line of `delegation-decisions.jsonl`. */
export function formatCostWatchLogLine(entry: ClaudeCostWatchDecision): string {
	return JSON.stringify({ time: new Date(entry.time).toISOString(), kind: 'costWatcher', sessionId: entry.sessionId, decision: entry.decision, model: entry.model, interval: entry.interval, callCostUsd: entry.callCostUsd === undefined ? undefined : Number(entry.callCostUsd.toFixed(5)), ignored: entry.ignored, reason: entry.reason, complexity: entry.complexity, classifierSkipped: entry.classifierSkipped || undefined });
}
