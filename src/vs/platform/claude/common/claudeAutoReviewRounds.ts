/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';

/**
 * Auto mode review cap (issue 1219, epic 1215): the strong model reviews a
 * helper's result at most this many times, then the open points go to the user.
 * A pure counter: no services, no I/O.
 */

/** How many times the strong model may review one helper's result. */
export const CLAUDE_AUTO_REVIEW_MAX_ROUNDS_SETTING = 'claude.auto.review.maxRounds';
export const CLAUDE_AUTO_REVIEW_MAX_ROUNDS_DEFAULT = 2;
export const CLAUDE_AUTO_REVIEW_MAX_ROUNDS_MIN = 1;
export const CLAUDE_AUTO_REVIEW_MAX_ROUNDS_MAX = 5;

/** Reads the cap. Anything but a whole number from 1 to 5 falls back to the default. */
export function readClaudeAutoReviewMaxRounds(get: (key: string) => unknown): number {
	const value = get(CLAUDE_AUTO_REVIEW_MAX_ROUNDS_SETTING);
	if (typeof value !== 'number' || !Number.isInteger(value) || value < CLAUDE_AUTO_REVIEW_MAX_ROUNDS_MIN || value > CLAUDE_AUTO_REVIEW_MAX_ROUNDS_MAX) {
		return CLAUDE_AUTO_REVIEW_MAX_ROUNDS_DEFAULT;
	}
	return value;
}

/** What one review found: the result is ready to merge, or it needs changes (with the open points). */
export interface ClaudeAutoReviewOutcome {
	readonly verdict: 'ready' | 'changes';
	readonly openPoints?: readonly string[];
}

export type ClaudeAutoReviewNext =
	/** The result is ready: the loop ends, no re-review. */
	| { readonly kind: 'done'; readonly round: number }
	/** Changes are needed and a round is left: send the points to the helper, then review again. */
	| { readonly kind: 'rework'; readonly round: number; readonly openPoints: readonly string[] }
	/** Changes are still needed after the last round: the chat goes to Waiting for you. */
	| { readonly kind: 'handToUser'; readonly round: number; readonly openPoints: readonly string[] };

/** Decides what follows review number `round` (1-based). */
export function nextClaudeAutoReviewStep(round: number, outcome: ClaudeAutoReviewOutcome, maxRounds: number): ClaudeAutoReviewNext {
	if (outcome.verdict === 'ready') {
		return { kind: 'done', round };
	}
	const openPoints = (outcome.openPoints ?? []).map(point => point.trim()).filter(point => point.length > 0);
	return round >= maxRounds ? { kind: 'handToUser', round, openPoints } : { kind: 'rework', round, openPoints };
}

/** The message shown with Waiting for you: the open points in plain words. */
export function claudeAutoReviewHandoffMessage(rounds: number, openPoints: readonly string[]): string {
	const heading = localize('claudeAutoReviewHandoff', "I reviewed the helper's work {0} times and it still needs changes. These points are open:", rounds);
	return [heading, ...openPoints.map(point => `- ${point}`)].join('\n');
}

/** One decision-log line per review round. */
export function formatClaudeAutoReviewLogLine(entry: { readonly time: number; readonly sessionId: string; readonly round: number; readonly maxRounds: number; readonly next: ClaudeAutoReviewNext['kind'] }): string {
	return `${new Date(entry.time).toISOString()} review sessionId=${entry.sessionId} round=${entry.round}/${entry.maxRounds} next=${entry.next}`;
}
