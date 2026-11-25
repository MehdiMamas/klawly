/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BackgroundAgentStatus } from '../../../../platform/claude/common/claudeBackground.js';
import { TurnStatus } from '../../../services/claude/common/claudeAgentState.js';

/** What a session with no turns is remembered as. */
const NO_TURN = { id: '', status: 'complete' } as const;

/**
 * What the attention notifier already told the user about (spec 48). Every
 * entry belongs to a pending permission, an open session or a listed background
 * task, so the state never outgrows them.
 */
export class ClaudeAttentionState {
	/** Pending permission ids already seen, by session. An id that is no longer pending is dropped. */
	private readonly _asked = new Map<string, Set<string>>();
	/** Per session, the last turn whose auth failure already asked for a new probe. */
	private readonly _authFailure = new Map<string, string>();
	private readonly _taskStatus = new Map<string, BackgroundAgentStatus>();
	/** Per session, the last turn and its status when last seen. */
	private readonly _turns = new Map<string, { readonly id: string; readonly status: TurnStatus }>();

	/**
	 * Of the permissions pending in a session now, the ones not seen before. Marks
	 * them seen and forgets those that are no longer pending: a request never
	 * becomes pending again once it was answered.
	 */
	freshPermissions<T extends { readonly id: string }>(sessionId: string, pending: readonly T[]): T[] {
		const asked = this._asked.get(sessionId);
		const fresh = pending.filter(entry => !asked?.has(entry.id));
		if (pending.length > 0) {
			this._asked.set(sessionId, new Set(pending.map(entry => entry.id)));
		} else {
			this._asked.delete(sessionId);
		}
		return fresh;
	}

	/** True the first time `turnId` is reported as the session's failed sign-in turn. */
	authFailed(sessionId: string, turnId: string): boolean {
		if (this._authFailure.get(sessionId) === turnId) {
			return false;
		}
		this._authFailure.set(sessionId, turnId);
		return true;
	}

	/**
	 * Tasks that moved to complete or failed since the last call. A task seen for
	 * the first time is remembered, not reported. Tasks no longer listed are forgotten.
	 */
	endedTasks<T extends { readonly id: string; readonly status: BackgroundAgentStatus }>(tasks: readonly T[]): T[] {
		const ended: T[] = [];
		const listed = new Set<string>();
		for (const task of tasks) {
			listed.add(task.id);
			const previous = this._taskStatus.get(task.id);
			this._taskStatus.set(task.id, task.status);
			if ((task.status === 'complete' || task.status === 'failed') && previous !== undefined && previous !== task.status) {
				ended.push(task);
			}
		}
		for (const id of [...this._taskStatus.keys()]) {
			if (!listed.has(id)) {
				this._taskStatus.delete(id);
			}
		}
		return ended;
	}

	/**
	 * True when the session's last turn ended as complete or failed since the
	 * last call. A session seen for the first time is remembered, not reported;
	 * a stopped turn is the user's own doing and is never reported.
	 */
	endedTurn(sessionId: string, turn: { readonly id: string; readonly status: TurnStatus } | undefined): boolean {
		const next = turn ? { id: turn.id, status: turn.status } : NO_TURN;
		const previous = this._turns.get(sessionId);
		this._turns.set(sessionId, next);
		if (!previous || (next.status !== 'complete' && next.status !== 'failed')) {
			return false;
		}
		return previous.id !== next.id || previous.status === 'running';
	}

	/** Forgets everything about sessions that are not open any more. */
	retainSessions(open: ReadonlySet<string>): void {
		for (const map of [this._asked, this._authFailure, this._turns]) {
			for (const sessionId of [...map.keys()]) {
				if (!open.has(sessionId)) {
					map.delete(sessionId);
				}
			}
		}
	}

	/** How many entries are kept, for tests. */
	get size(): { readonly permissions: number; readonly authFailures: number; readonly tasks: number; readonly turns: number } {
		let permissions = 0;
		for (const ids of this._asked.values()) {
			permissions += ids.size;
		}
		return { permissions, authFailures: this._authFailure.size, tasks: this._taskStatus.size, turns: this._turns.size };
	}
}
