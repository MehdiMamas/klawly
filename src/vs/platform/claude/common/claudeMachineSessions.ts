/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * Every Claude Code session on this PC (issue 1251): the ones Klawly started and the ones other
 * windows, terminals and tools started. The list comes from Claude Code's own `claude agents`;
 * the node side adds the parent link and the git facts that decide what is safe to delete.
 */
export interface IClaudeMachineSession {
	/** The short id `claude stop|kill|rm|respawn` take. */
	readonly id: string;
	readonly sessionId: string;
	readonly name: string;
	readonly cwd: string;
	readonly kind: 'interactive' | 'background';
	/** `claude agents` state: working, blocked, done, stopped, failed. Absent for an interactive session. */
	readonly rawState: string | undefined;
	readonly startedAt: number;
	/** When the session last did anything; the idle time counts from here. */
	readonly updatedAt: number | undefined;
	/** The manager that started it, when one is known. */
	readonly parentSessionId: string | undefined;
	readonly contextTokens: number | undefined;
	readonly model: string | undefined;
	readonly costUsd: number | undefined;
	/** Commits in its worktree that exist nowhere else. */
	readonly unpushed: number;
	/** Uncommitted changes in its folder. */
	readonly dirty: boolean;
	/** A CI watch it started has not answered yet. */
	readonly waitingOnCi: boolean;
}

export interface IClaudeMachineSessionResult {
	readonly ok: boolean;
	/** What the command printed, in plain words. */
	readonly message: string;
}

export const IClaudeMachineSessionService = createDecorator<IClaudeMachineSessionService>('claudeMachineSessionService');

/** Shared-process service behind the Agents window list. The UI never spawns anything itself. */
export interface IClaudeMachineSessionService {
	readonly _serviceBrand: undefined;
	/** The list is cached for 10 s machine-wide (the same cache the session manager uses). */
	list(): Promise<readonly IClaudeMachineSession[]>;
	/** Ends the process; the conversation is kept. */
	stop(id: string): Promise<IClaudeMachineSessionResult>;
	kill(id: string): Promise<IClaudeMachineSessionResult>;
	/** Deletes the session and its folder; refuses when it holds unpushed work. */
	remove(id: string): Promise<IClaudeMachineSessionResult>;
	/** Starts a stopped or failed background session again. */
	resume(id: string): Promise<IClaudeMachineSessionResult>;
}

/** A working session that has done nothing for this long counts as idle. */
export const MACHINE_SESSION_IDLE_MS = 10 * 60_000;
/** A session waiting on a decision stays this long before cleanup may take it (same as the session manager). */
export const MACHINE_SESSION_WAIT_KEEP_MS = 24 * 3_600_000;

export type MachineSessionPhase = 'working' | 'idle' | 'waiting' | 'finished' | 'stopped' | 'failed';

export interface IMachineSessionState {
	readonly phase: MachineSessionPhase;
	/** The state in plain words. */
	readonly text: string;
}

function minutesOf(ms: number): number {
	return Math.max(1, Math.round(ms / 60_000));
}

/** Plain-word state of one session: working, idle for N min, waiting on you, finished, stopped, failed. */
export function machineSessionState(session: IClaudeMachineSession, now: number): IMachineSessionState {
	switch ((session.rawState ?? '').toLowerCase()) {
		case 'blocked':
		case 'waiting':
			return { phase: 'waiting', text: localize('claude.machine.state.waiting', "Waiting on you") };
		case 'done':
			return { phase: 'finished', text: localize('claude.machine.state.finished', "Finished") };
		case 'stopped':
			return { phase: 'stopped', text: localize('claude.machine.state.stopped', "Stopped") };
		case 'failed':
			return { phase: 'failed', text: localize('claude.machine.state.failed', "Failed") };
	}
	const since = session.updatedAt ?? session.startedAt;
	if (now - since >= MACHINE_SESSION_IDLE_MS) {
		return { phase: 'idle', text: localize('claude.machine.state.idle', "Idle for {0} min", minutesOf(now - since)) };
	}
	return { phase: 'working', text: localize('claude.machine.state.working', "Working") };
}

export function isMachineSessionRunning(phase: MachineSessionPhase): boolean {
	return phase === 'working' || phase === 'idle' || phase === 'waiting';
}

export interface IMachineSessionRow {
	readonly session: IClaudeMachineSession;
	readonly depth: number;
	readonly state: IMachineSessionState;
	/** Workers under this row, all levels. */
	readonly workerCount: number;
	/** The facts that make the row readable at a glance: model, context, cost. */
	readonly meta: string;
	/** What the user can do next, in plain words. */
	readonly next: string;
	readonly canStop: boolean;
	readonly canKill: boolean;
	readonly canResume: boolean;
	readonly canDelete: boolean;
	/** Why cleanup keeps it, or undefined. */
	readonly keep: string | undefined;
}

/** Why bulk cleanup must leave a session alone, or undefined when it may go. Mirrors the session manager's rules. */
export function machineSessionKeepReason(session: IClaudeMachineSession, now: number): string | undefined {
	if (session.unpushed > 0) {
		return localize('claude.machine.keep.unpushed', "its worktree has {0} unpushed commit(s)", session.unpushed);
	}
	if (session.dirty) {
		return localize('claude.machine.keep.dirty', "its folder has uncommitted changes");
	}
	if (session.waitingOnCi) {
		return localize('claude.machine.keep.ci', "it waits on CI");
	}
	const state = machineSessionState(session, now);
	if (state.phase === 'waiting' && now - (session.updatedAt ?? session.startedAt) < MACHINE_SESSION_WAIT_KEEP_MS) {
		return localize('claude.machine.keep.waiting', "it waits on a merge or a decision");
	}
	if (state.phase === 'working') {
		return localize('claude.machine.keep.working', "it is working");
	}
	return undefined;
}

function metaText(session: IClaudeMachineSession): string {
	const parts: string[] = [];
	if (session.model) {
		parts.push(session.model);
	}
	if (session.contextTokens !== undefined) {
		parts.push(localize('claude.machine.meta.context', "{0}k tokens", Math.round(session.contextTokens / 1000)));
	}
	parts.push(session.costUsd === undefined
		? localize('claude.machine.meta.noCost', "cost not reported")
		: localize('claude.machine.meta.cost', "${0}", session.costUsd.toFixed(2)));
	return parts.join(' · ');
}

function nextText(phase: MachineSessionPhase, kind: 'interactive' | 'background'): string {
	switch (phase) {
		case 'waiting': return localize('claude.machine.next.waiting', "Open it and answer");
		case 'idle': return localize('claude.machine.next.idle', "Stop it or open it");
		case 'working': return localize('claude.machine.next.working', "Nothing to do; Stop if it is wrong");
		case 'failed': return kind === 'background'
			? localize('claude.machine.next.failed', "Resume it or delete it")
			: localize('claude.machine.next.failedOpen', "Open it");
		case 'stopped': return kind === 'background'
			? localize('claude.machine.next.stopped', "Resume it or delete it")
			: localize('claude.machine.next.stoppedOpen', "Open it");
		case 'finished': return localize('claude.machine.next.finished', "Read the result, then delete it");
	}
}

/**
 * Managers first, each followed by its workers. A session whose manager is not in the list is shown at
 * the top level; a parent cycle is cut at the first repeat. Newest first among siblings.
 */
export function buildMachineSessionRows(sessions: readonly IClaudeMachineSession[], now: number): readonly IMachineSessionRow[] {
	const byId = new Map(sessions.map(session => [session.sessionId, session]));
	const children = new Map<string, IClaudeMachineSession[]>();
	const roots: IClaudeMachineSession[] = [];
	for (const session of sessions) {
		const parent = session.parentSessionId;
		if (parent && parent !== session.sessionId && byId.has(parent)) {
			const list = children.get(parent) ?? [];
			list.push(session);
			children.set(parent, list);
		} else {
			roots.push(session);
		}
	}
	const newestFirst = (a: IClaudeMachineSession, b: IClaudeMachineSession) => b.startedAt - a.startedAt;
	const countWorkers = (session: IClaudeMachineSession, visiting: Set<string>): number => {
		let total = 0;
		for (const child of children.get(session.sessionId) ?? []) {
			if (!visiting.has(child.sessionId)) {
				visiting.add(child.sessionId);
				total += 1 + countWorkers(child, visiting);
			}
		}
		return total;
	};
	const seen = new Set<string>();
	const rows: IMachineSessionRow[] = [];
	const visit = (session: IClaudeMachineSession, depth: number) => {
		if (seen.has(session.sessionId)) {
			return;
		}
		seen.add(session.sessionId);
		const state = machineSessionState(session, now);
		const running = isMachineSessionRunning(state.phase);
		const background = session.kind === 'background';
		rows.push({
			session,
			depth,
			state,
			workerCount: countWorkers(session, new Set(seen)),
			meta: metaText(session),
			next: nextText(state.phase, session.kind),
			canStop: running && background,
			canKill: running && background,
			canResume: !running && background && state.phase !== 'finished',
			canDelete: !running && background,
			keep: machineSessionKeepReason(session, now),
		});
		for (const child of (children.get(session.sessionId) ?? []).slice().sort(newestFirst)) {
			visit(child, depth + 1);
		}
	};
	for (const root of roots.slice().sort(newestFirst)) {
		visit(root, 0);
	}
	// A parent cycle has no root; show what is left rather than hide it.
	for (const session of sessions) {
		visit(session, 0);
	}
	return rows;
}

export interface IMachineCleanupStep {
	readonly session: IClaudeMachineSession;
	/** An idle session is stopped before it is deleted. */
	readonly stopFirst: boolean;
}

export interface IMachineCleanupPlan {
	readonly steps: readonly IMachineCleanupStep[];
	readonly kept: readonly { readonly session: IClaudeMachineSession; readonly reason: string }[];
}

/** What "Clean Up Finished and Idle" would delete, and what it keeps and why. */
export function planMachineCleanup(rows: readonly IMachineSessionRow[], now: number): IMachineCleanupPlan {
	const steps: IMachineCleanupStep[] = [];
	const kept: { session: IClaudeMachineSession; reason: string }[] = [];
	for (const { session, state } of rows) {
		if (session.kind !== 'background') {
			continue;
		}
		const eligible = state.phase === 'finished' || state.phase === 'stopped' || state.phase === 'failed' || state.phase === 'idle';
		if (!eligible) {
			continue;
		}
		const reason = machineSessionKeepReason(session, now);
		if (reason) {
			kept.push({ session, reason });
		} else {
			steps.push({ session, stopFirst: state.phase === 'idle' });
		}
	}
	return { steps, kept };
}
