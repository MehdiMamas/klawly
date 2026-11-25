/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout } from '../../../base/common/async.js';
import { Disposable, DisposableStore, IDisposable } from '../../../base/common/lifecycle.js';
import { ClaudeQuery, ClaudeQueryPermissionMode } from './claudeQuery.js';
import { ClaudeFlagSettingsPatch } from '../common/claudeSessionSettings.js';
import { ClaudeRemoteControlState, readClaudeRemoteControlResponse } from '../common/claudeRemoteControl.js';

export const DEFAULT_CLAUDE_SESSION_TIMEOUT_MS = 10 * 60 * 1000;

interface TrackedSession {
	readonly query: ClaudeQuery;
	readonly store: DisposableStore;
	readonly timeoutMs: number;
	timer: IDisposable;
	/** The inactivity timer is wanted (a turn is open). */
	armed: boolean;
	/** Tool or worker calls still open; while any are, silence is not inactivity (issue 1252). */
	openCalls: number;
	/** Remote Control while it is on (issue 517). It ends with the query. */
	remoteControl?: ClaudeRemoteControlState;
}

/**
 * Tracks live SDK queries. Interrupt uses the SDK interrupt. If that fails,
 * or the session outlives its timeout, the query is closed.
 */
export class ClaudeProcessRegistry extends Disposable {
	private readonly _sessions = new Map<string, TrackedSession>();
	private readonly _timedOut = new Set<string>();
	/** Chats whose Remote Control was on when their query ended, with the name it had. A new query for the chat turns it back on (issue 863). */
	private readonly _reshare = new Map<string, string | undefined>();

	track(sessionId: string, query: ClaudeQuery, timeoutMs: number): void {
		this.disposeSession(sessionId);
		this._timedOut.delete(sessionId);
		const store = new DisposableStore();
		const tracked: TrackedSession = { query, store, timeoutMs, timer: Disposable.None, armed: false, openCalls: 0 };
		this._sessions.set(sessionId, tracked);
		if (this._reshare.has(sessionId)) {
			const name = this._reshare.get(sessionId);
			this._reshare.delete(sessionId);
			void this.remoteControl(sessionId, true, name).catch(() => undefined);
		}
	}

	/** Starts or resets the inactivity timer for the current turn. */
	arm(sessionId: string): void {
		const tracked = this._sessions.get(sessionId);
		if (!tracked) {
			return;
		}
		tracked.armed = true;
		this.restartTimer(sessionId, tracked);
	}

	/**
	 * Counts the open tool and worker calls of a turn. A long silent Bash run or a
	 * worker that is still going is healthy, so the timer waits until none is open (issue 1252).
	 */
	setOpenCalls(sessionId: string, count: number): void {
		const tracked = this._sessions.get(sessionId);
		if (!tracked || tracked.openCalls === count) {
			return;
		}
		tracked.openCalls = count;
		if (tracked.armed) {
			this.restartTimer(sessionId, tracked);
		}
	}

	private restartTimer(sessionId: string, tracked: TrackedSession): void {
		tracked.timer.dispose();
		tracked.timer = Disposable.None;
		if (tracked.openCalls > 0) {
			return;
		}
		tracked.timer = disposableTimeout(() => {
			this._timedOut.add(sessionId);
			void this.kill(sessionId);
		}, tracked.timeoutMs);
	}

	disarm(sessionId: string): void {
		const tracked = this._sessions.get(sessionId);
		if (!tracked) {
			return;
		}
		tracked.armed = false;
		tracked.timer.dispose();
		tracked.timer = Disposable.None;
	}

	wasTimedOut(sessionId: string): boolean {
		return this._timedOut.has(sessionId);
	}

	get(sessionId: string): ClaudeQuery | undefined {
		return this._sessions.get(sessionId)?.query;
	}

	async interrupt(sessionId: string): Promise<void> {
		const tracked = this._sessions.get(sessionId);
		if (!tracked) {
			return;
		}
		try {
			await tracked.query.interrupt();
		} catch {
			tracked.query.close();
		}
	}

	/**
	 * Stops one SDK task. Returns false when the query is gone or `stopTask` fails,
	 * which tells the caller to interrupt the parent turn instead.
	 */
	async stopTask(sessionId: string, taskId: string): Promise<boolean> {
		const tracked = this._sessions.get(sessionId);
		if (!tracked) {
			return false;
		}
		try {
			await tracked.query.stopTask(taskId);
			return true;
		} catch {
			return false;
		}
	}

	async setModel(sessionId: string, modelId: string): Promise<boolean> {
		const tracked = this._sessions.get(sessionId);
		if (!tracked) {
			return false;
		}
		await tracked.query.setModel(modelId);
		return true;
	}

	/**
	 * Switches the permission mode of a tracked query (issue 694). Resolves false for an
	 * unknown session or a query that cannot switch, so the runner restarts it instead.
	 */
	async setPermissionMode(sessionId: string, mode: ClaudeQueryPermissionMode): Promise<boolean> {
		const tracked = this._sessions.get(sessionId);
		if (!tracked?.query.setPermissionMode) {
			return false;
		}
		await tracked.query.setPermissionMode(mode);
		return true;
	}

	/**
	 * Changes the flag settings of a tracked query. Resolves false for an
	 * unknown session; rejects when the query cannot change settings.
	 */
	async applyFlagSettings(sessionId: string, patch: ClaudeFlagSettingsPatch): Promise<boolean> {
		const tracked = this._sessions.get(sessionId);
		if (!tracked) {
			return false;
		}
		if (!tracked.query.applyFlagSettings) {
			throw new Error('This Claude Code query cannot change its settings.');
		}
		await tracked.query.applyFlagSettings(patch);
		return true;
	}

	/**
	 * Turns Claude Code's Remote Control on or off for a tracked query. Resolves
	 * undefined for an unknown session; rejects when the query cannot do it or
	 * Claude Code refuses (no claude.ai sign-in, an org policy).
	 */
	async remoteControl(sessionId: string, enabled: boolean, name?: string): Promise<ClaudeRemoteControlState | undefined> {
		const tracked = this._sessions.get(sessionId);
		if (!tracked) {
			return undefined;
		}
		if (!tracked.query.remoteControl) {
			throw new Error('This Claude Code query cannot start Remote Control.');
		}
		if (!enabled) {
			this._reshare.delete(sessionId);
		}
		const state = readClaudeRemoteControlResponse(await tracked.query.remoteControl(enabled, name), enabled, name);
		if (this._sessions.get(sessionId) === tracked) {
			tracked.remoteControl = state.enabled ? state : undefined;
		}
		return state;
	}

	/** The query's Remote Control while it is on. */
	remoteControlState(sessionId: string): ClaudeRemoteControlState | undefined {
		return this._sessions.get(sessionId)?.remoteControl;
	}

	async kill(sessionId: string): Promise<void> {
		const tracked = this._sessions.get(sessionId);
		if (!tracked) {
			return;
		}
		try {
			await tracked.query.interrupt();
		} catch {
			// The close below ends the process when interrupt is unavailable.
		}
		tracked.query.close();
	}

	/** Drops the bookkeeping for a query that has already ended. */
	untrack(sessionId: string): void {
		const tracked = this._sessions.get(sessionId);
		if (!tracked) {
			return;
		}
		this._sessions.delete(sessionId);
		this._timedOut.delete(sessionId);
		this.rememberShared(sessionId, tracked);
		tracked.timer.dispose();
		tracked.store.dispose();
	}

	/** Notes that a chat was shared when its query ended, so the next query shares it again. */
	private rememberShared(sessionId: string, tracked: TrackedSession): void {
		if (tracked.remoteControl?.enabled) {
			this._reshare.set(sessionId, tracked.remoteControl.name);
		}
	}

	disposeSession(sessionId: string): void {
		const tracked = this._sessions.get(sessionId);
		if (!tracked) {
			return;
		}
		this._sessions.delete(sessionId);
		this._timedOut.delete(sessionId);
		this.rememberShared(sessionId, tracked);
		tracked.timer.dispose();
		try {
			tracked.query.close();
		} catch {
			// The query may already have closed itself.
		}
		tracked.store.dispose();
	}

	override dispose(): void {
		for (const sessionId of [...this._sessions.keys()]) {
			this.disposeSession(sessionId);
		}
		this._reshare.clear();
		super.dispose();
	}
}
