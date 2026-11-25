/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** What the spec 45 command preconditions need to know about the current agent session. */
export interface ClaudeCommandState {
	readonly running: boolean;
	readonly hasTurns: boolean;
	readonly hasPendingChanges: boolean;
	readonly hasSubagents: boolean;
	readonly hasRunningSubagent: boolean;
}

interface TurnLike {
	readonly id: string;
	readonly status: string;
}

interface SubagentLike {
	readonly run: { readonly state: string };
}

interface ReviewLike {
	readonly turnId: string;
	readonly files: readonly { readonly state: string }[];
}

/** A file still has something to accept or reject. */
function needsReview(review: ReviewLike): boolean {
	return review.files.some(file => file.state === 'pending' || file.state === 'mixed' || file.state === 'conflicted');
}

export function claudeCommandState(turns: readonly TurnLike[], subagents: readonly SubagentLike[], reviews: readonly ReviewLike[]): ClaudeCommandState {
	return {
		running: turns.length > 0 && turns[turns.length - 1].status === 'running',
		hasTurns: turns.length > 0,
		hasPendingChanges: reviews.some(needsReview),
		hasSubagents: subagents.length > 0,
		hasRunningSubagent: subagents.some(subagent => subagent.run.state === 'running'),
	};
}

/**
 * Turns whose review should open on their own after the agent edits files
 * (`claude.review.openAfterAgentEdit`): seen running in this window, now
 * finished, not started by inline edit, and not opened before.
 */
export function claudeTurnsToOpenAfterEdit(turns: readonly TurnLike[], seenRunning: ReadonlySet<string>, opened: ReadonlySet<string>, isInlineEdit: (turnId: string) => boolean): string[] {
	return turns
		.filter(turn => turn.status !== 'running' && seenRunning.has(turn.id) && !opened.has(turn.id) && !isInlineEdit(turn.id))
		.map(turn => turn.id);
}

/** Key of per-turn pane state: the session id, a newline, and the turn id. */
export function claudeSessionTurnKey(sessionId: string, turnId: string): string {
	return `${sessionId}\n${turnId}`;
}

/** Deletes the per-turn keys (see `claudeSessionTurnKey`) of sessions that are not open any more. */
export function forgetClosedSessionTurns(keys: { keys(): Iterable<string>; delete(key: string): boolean }, openSessionIds: ReadonlySet<string>): void {
	for (const key of [...keys.keys()]) {
		const end = key.indexOf('\n');
		if (!openSessionIds.has(end < 0 ? key : key.slice(0, end))) {
			keys.delete(key);
		}
	}
}
