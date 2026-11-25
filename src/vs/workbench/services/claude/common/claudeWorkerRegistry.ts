/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ClaudeEscalation } from '../../../../platform/claude/common/claudeDelegateLadder.js';
import { UsageInfo } from '../../../../platform/claude/common/claudeProtocol.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export const IClaudeWorkerRegistry = createDecorator<IClaudeWorkerRegistry>('claudeWorkerRegistry');

/** Where the registry keeps its runs across a window reload (issue 835), per workspace. */
export const CLAUDE_WORKER_REGISTRY_STORAGE_KEY = 'claude.workers.runs';

/** Finished, failed and stopped runs older than this are dropped when the registry restores. */
export const CLAUDE_WORKER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** What started the run. Subagents are added by their own producer (issue 848). */
export type ClaudeWorkerKind = 'delegate' | 'multitask' | 'background' | 'subagent';

/** How capable a model the run was given: small, medium or large. */
export type ClaudeWorkerTier = 'small' | 'medium' | 'large';

/** The run's state in plain words. `waiting` is a run held up by something outside it (CI, you, a free slot). */
export type ClaudeWorkerState = 'queued' | 'working' | 'waiting' | 'finished' | 'failed' | 'stopped';

/** Tokens summed over a run and its descendants. */
export interface ClaudeWorkerTokens {
	readonly inputTokens: number;
	readonly outputTokens: number;
}

/** What the runs a chat started cost in all. */
export interface ClaudeWorkerTotals extends ClaudeWorkerTokens {
	readonly costUsd: number;
	readonly runs: number;
}

/** One record per worker run, whichever feature started it. */
export interface IClaudeWorkerRun {
	readonly id: string;
	/** Position in the tree: `1`, `1-2`, `1-2-3`. A child's number starts with its parent's. */
	readonly number: string;
	readonly parentId?: string;
	/** The chat that owns the run. */
	readonly ownerSessionId: string;
	readonly name: string;
	readonly kind: ClaudeWorkerKind;
	readonly tier?: ClaudeWorkerTier;
	/** The delegate template the run started from, such as `watch-ci` (issue 1110). */
	readonly template?: string;
	readonly model: string;
	readonly effort?: string;
	readonly state: ClaudeWorkerState;
	/** The state in plain words, such as `waiting for CI` or `failed: budget reached`. */
	readonly stateDetail?: string;
	/** Each time the run moved up a tier after failed calls (issue 839), oldest first. */
	readonly escalations?: readonly ClaudeEscalation[];
	readonly contextTokens?: number;
	readonly costUsd?: number;
	/** Tokens the run's own chat used (issue 836). */
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly startedAt: number;
	readonly lastEventAt: number;
	readonly endedAt?: number;
	/** The run's final answer or report. */
	readonly report?: string;
	readonly repo?: string;
	readonly worktree?: string;
	/** The contract's goal, acceptance and budget (issue 837). */
	readonly objective?: string;
	readonly acceptance?: string;
	readonly budgetUsd?: number;
	readonly budgetCalls?: number;
	/** The worker had nothing to report (`[[quiet]]`). */
	readonly quiet?: boolean;
	/** Messages sent to the run that it has not read yet (issue 840). */
	readonly messagesWaiting?: number;
}

/** What a producer gives `create`. The registry fills in the number and the times. */
export type ClaudeWorkerRunInput = Omit<IClaudeWorkerRun, 'id' | 'number' | 'startedAt' | 'lastEventAt' | 'state'> & {
	/** A producer that mirrors an id from elsewhere (such as `background-<task>`) passes it, so the same id is never recorded twice. */
	readonly id?: string;
	readonly state?: ClaudeWorkerState;
	readonly startedAt?: number;
	readonly lastEventAt?: number;
};

/** The fields `update` may change. */
export type ClaudeWorkerRunPatch = Partial<Omit<IClaudeWorkerRun, 'id' | 'number' | 'parentId' | 'kind' | 'ownerSessionId' | 'startedAt'>>;

export interface IClaudeWorkerRegistry {
	readonly _serviceBrand: undefined;
	/** Fires with the ids of the runs that were created, changed or removed. */
	readonly onDidChange: Event<readonly string[]>;
	/** Records a run and numbers it. An id that already exists returns that run unchanged. */
	create(input: ClaudeWorkerRunInput): IClaudeWorkerRun;
	/** Changes a run and moves `lastEventAt` forward. An ended state also sets `endedAt`. Unknown ids return undefined. */
	update(id: string, patch: ClaudeWorkerRunPatch): IClaudeWorkerRun | undefined;
	get(id: string): IClaudeWorkerRun | undefined;
	/** Direct children, in the order they started. */
	children(id: string): readonly IClaudeWorkerRun[];
	/** Runs with no parent, in the order they started. */
	roots(): readonly IClaudeWorkerRun[];
	all(): readonly IClaudeWorkerRun[];
	/** The run's own cost plus every descendant's. */
	subtreeCost(id: string): number;
	/** The run's own context tokens: the largest of its own and every descendant's, since each run has its own window. */
	subtreeContextTokens(id: string): number;
	/** The run's own tokens plus every descendant's. */
	subtreeTokens(id: string): ClaudeWorkerTokens;
	/** What every run a chat started has cost, nested runs included. `runs` is how many runs that is. */
	sessionTotals(ownerSessionId: string): ClaudeWorkerTotals;
	/** Drops a run and everything under it. */
	remove(id: string): void;
}

/** What a chat's usage report adds to its run: cost, context size and tokens. Absent fields stay as they were (issue 836). */
export function workerUsagePatch(usage: UsageInfo | undefined): ClaudeWorkerRunPatch {
	if (!usage) {
		return {};
	}
	return {
		...usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {},
		...usage.contextTokens !== undefined ? { contextTokens: usage.contextTokens } : {},
		...usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {},
		...usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {},
	};
}

/** True when the state is one the run does not leave. */
export function isEndedWorkerState(state: ClaudeWorkerState): boolean {
	return state === 'finished' || state === 'failed' || state === 'stopped';
}

/** The workspace's persisted registry: every run is saved as it changes and comes back after a reload. */
export class ClaudeWorkerRegistry extends Disposable implements IClaudeWorkerRegistry {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<readonly string[]>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _runs = new Map<string, IClaudeWorkerRun>();
	/** The JSON last written to storage, so unchanged state is not written again. */
	private _saved: string | undefined;

	constructor(@IStorageService private readonly _storage: IStorageService) {
		super();
		this._restore();
	}

	create(input: ClaudeWorkerRunInput): IClaudeWorkerRun {
		const existing = input.id ? this._runs.get(input.id) : undefined;
		if (existing) {
			return existing;
		}
		const now = Date.now();
		const parent = input.parentId ? this._runs.get(input.parentId) : undefined;
		const run: IClaudeWorkerRun = {
			...input,
			id: input.id ?? generateUuid(),
			number: this._nextNumber(parent?.id),
			parentId: parent ? parent.id : undefined,
			state: input.state ?? 'queued',
			startedAt: input.startedAt ?? now,
			lastEventAt: input.lastEventAt ?? input.startedAt ?? now,
		};
		this._runs.set(run.id, run);
		this._changed([run.id]);
		return run;
	}

	update(id: string, patch: ClaudeWorkerRunPatch): IClaudeWorkerRun | undefined {
		const run = this._runs.get(id);
		if (!run) {
			return undefined;
		}
		const now = Date.now();
		const next: IClaudeWorkerRun = { ...run, ...patch, lastEventAt: patch.lastEventAt ?? now };
		if (patch.state && isEndedWorkerState(patch.state) && patch.endedAt === undefined && run.endedAt === undefined) {
			(next as { endedAt?: number }).endedAt = now;
		} else if (patch.state && !isEndedWorkerState(patch.state) && patch.endedAt === undefined) {
			(next as { endedAt?: number }).endedAt = undefined;
		}
		this._runs.set(id, next);
		this._changed([id]);
		return next;
	}

	get(id: string): IClaudeWorkerRun | undefined {
		return this._runs.get(id);
	}

	children(id: string): readonly IClaudeWorkerRun[] {
		return this.all().filter(run => run.parentId === id);
	}

	roots(): readonly IClaudeWorkerRun[] {
		return this.all().filter(run => !run.parentId);
	}

	all(): readonly IClaudeWorkerRun[] {
		return [...this._runs.values()].sort((a, b) => a.startedAt - b.startedAt);
	}

	subtreeCost(id: string): number {
		const run = this._runs.get(id);
		if (!run) {
			return 0;
		}
		return (run.costUsd ?? 0) + this.children(id).reduce((sum, child) => sum + this.subtreeCost(child.id), 0);
	}

	subtreeContextTokens(id: string): number {
		const run = this._runs.get(id);
		if (!run) {
			return 0;
		}
		return Math.max(run.contextTokens ?? 0, ...this.children(id).map(child => this.subtreeContextTokens(child.id)));
	}

	subtreeTokens(id: string): ClaudeWorkerTokens {
		const run = this._runs.get(id);
		if (!run) {
			return { inputTokens: 0, outputTokens: 0 };
		}
		let inputTokens = run.inputTokens ?? 0;
		let outputTokens = run.outputTokens ?? 0;
		for (const child of this.children(id)) {
			const below = this.subtreeTokens(child.id);
			inputTokens += below.inputTokens;
			outputTokens += below.outputTokens;
		}
		return { inputTokens, outputTokens };
	}

	sessionTotals(ownerSessionId: string): ClaudeWorkerTotals {
		let costUsd = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		let runs = 0;
		for (const run of this.roots()) {
			if (run.ownerSessionId !== ownerSessionId) {
				continue;
			}
			const tokens = this.subtreeTokens(run.id);
			costUsd += this.subtreeCost(run.id);
			inputTokens += tokens.inputTokens;
			outputTokens += tokens.outputTokens;
			runs += 1 + this._descendantCount(run.id);
		}
		return { costUsd, inputTokens, outputTokens, runs };
	}

	private _descendantCount(id: string): number {
		return this.children(id).reduce((sum, child) => sum + 1 + this._descendantCount(child.id), 0);
	}

	remove(id: string): void {
		if (!this._runs.has(id)) {
			return;
		}
		const removed: string[] = [];
		const drop = (runId: string) => {
			for (const child of this.children(runId)) {
				drop(child.id);
			}
			this._runs.delete(runId);
			removed.push(runId);
		};
		drop(id);
		this._changed(removed);
	}

	/** The next free number under a parent: `1`, `2` at the top, `1-1`, `1-2` below run `1`. */
	private _nextNumber(parentId: string | undefined): string {
		const parent = parentId ? this._runs.get(parentId) : undefined;
		const prefix = parent ? `${parent.number}-` : '';
		let highest = 0;
		for (const run of this._runs.values()) {
			if (run.parentId === parent?.id && run.number.startsWith(prefix)) {
				const last = Number(run.number.slice(prefix.length));
				if (last > highest) {
					highest = last;
				}
			}
		}
		return `${prefix}${highest + 1}`;
	}

	private _changed(ids: readonly string[]): void {
		this._save();
		this._onDidChange.fire(ids);
	}

	private _restore(): void {
		const raw = this._storage.get(CLAUDE_WORKER_REGISTRY_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return;
		}
		let stored: unknown;
		try {
			stored = JSON.parse(raw);
		} catch {
			return;
		}
		if (!Array.isArray(stored)) {
			return;
		}
		const now = Date.now();
		for (const entry of stored as IClaudeWorkerRun[]) {
			if (!entry || typeof entry.id !== 'string' || typeof entry.number !== 'string') {
				continue;
			}
			if (isEndedWorkerState(entry.state) && now - (entry.endedAt ?? entry.lastEventAt) > CLAUDE_WORKER_RETENTION_MS) {
				continue;
			}
			// A run that was live when Klawly closed has nothing running behind it now.
			const live = !isEndedWorkerState(entry.state);
			this._runs.set(entry.id, live
				? { ...entry, state: 'stopped', stateDetail: 'stopped when Klawly closed', endedAt: entry.lastEventAt }
				: entry);
		}
		// A child whose parent was pruned becomes a top-level run.
		for (const [id, run] of this._runs) {
			if (run.parentId && !this._runs.has(run.parentId)) {
				this._runs.set(id, { ...run, parentId: undefined });
			}
		}
		this._saved = raw;
	}

	private _save(): void {
		const value = this._runs.size ? JSON.stringify(this.all()) : undefined;
		if (value === this._saved) {
			return;
		}
		this._saved = value;
		if (value) {
			this._storage.store(CLAUDE_WORKER_REGISTRY_STORAGE_KEY, value, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this._storage.remove(CLAUDE_WORKER_REGISTRY_STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}
}
