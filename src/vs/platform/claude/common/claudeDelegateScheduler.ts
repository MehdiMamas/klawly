/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';

/**
 * The delegation scheduler (issue 842): how many helpers work in one repository
 * at once, and which of them wait. A helper that owns files (the contract's
 * `files`) waits while another running helper owns an overlapping path, unless
 * it works in its own worktree. The rest queue in order, per repository.
 */

/** Most helpers working in one repository at once. */
export const CLAUDE_DELEGATE_CODING_CAP_SETTING = 'klawly.delegation.codingCap';
export const CLAUDE_DELEGATE_CODING_CAP_DEFAULT = 4;
export const CLAUDE_DELEGATE_CODING_CAP_MAX = 16;

/** Each coding helper (one that owns files) works in its own Git worktree. */
export const CLAUDE_DELEGATE_HELPER_WORKTREES_SETTING = 'klawly.delegation.helperWorktrees';

/** On unless the setting is false. */
export function readClaudeDelegateHelperWorktrees(value: unknown): boolean {
	return value !== false;
}

/** The task id a helper's worktree and branch are named by. */
export function claudeDelegateWorktreeId(cardId: string): string {
	return `helper-${cardId}`;
}

/** How deep helpers nest. 2 is manager, coordinator, helper. */
export const CLAUDE_DELEGATE_DEPTH_SETTING = 'klawly.delegation.maxDepth';
export const CLAUDE_DELEGATE_DEPTH_DEFAULT = 2;
/** The deepest a helper may sit, even with a reason. */
export const CLAUDE_DELEGATE_DEPTH_HARD_MAX = 4;

/** The cap a setting value names, between 1 and the maximum; the default for anything else. */
export function readClaudeDelegateCodingCap(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 1
		? Math.min(Math.floor(value), CLAUDE_DELEGATE_CODING_CAP_MAX)
		: CLAUDE_DELEGATE_CODING_CAP_DEFAULT;
}

/**
 * How deep a chat may delegate. The configured depth (default 2) holds unless
 * the delegating call gives a reason, which allows up to the hard maximum of 4.
 */
export function claudeDelegateDepthLimit(configured: unknown, reason: string | undefined): number {
	const base = typeof configured === 'number' && Number.isFinite(configured) && configured >= 1
		? Math.min(Math.floor(configured), CLAUDE_DELEGATE_DEPTH_HARD_MAX)
		: CLAUDE_DELEGATE_DEPTH_DEFAULT;
	return reason?.trim() ? CLAUDE_DELEGATE_DEPTH_HARD_MAX : base;
}

function normalizeOwned(path: string): string {
	let result = path.trim().split(String.fromCharCode(92)).join('/');
	if (result.startsWith('./')) {
		result = result.slice(2);
	}
	while (result.endsWith('/')) {
		result = result.slice(0, -1);
	}
	return result;
}

/** True when two owned path lists share a path, or one holds a folder the other has a path in. */
export function claudeOwnedFilesOverlap(a: readonly string[], b: readonly string[]): boolean {
	const left = a.map(normalizeOwned).filter(Boolean);
	const right = b.map(normalizeOwned).filter(Boolean);
	return left.some(x => right.some(y => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
}

/** One helper asking for a slot. */
export interface ClaudeDelegateSlotRequest {
	readonly id: string;
	/** The repository the helper works in. Helpers in different repositories never wait for each other. */
	readonly repo: string;
	/** The paths the helper owns. */
	readonly files?: readonly string[];
	/** The helper has its own worktree, so overlapping files cannot collide. */
	readonly ownWorktree?: boolean;
}

/** Why a queued helper waits, in plain words, and where it stands. */
export interface ClaudeDelegateQueued {
	readonly id: string;
	/** 1 is next in the repository's queue. */
	readonly position: number;
	readonly reason: 'cap' | 'files';
	/** The running helper whose files overlap, for the `files` reason. */
	readonly blockedBy?: string;
}

interface Entry extends ClaudeDelegateSlotRequest {
	readonly resolve: (started: boolean) => void;
}

export class ClaudeDelegateScheduler {
	private readonly _running = new Map<string, ClaudeDelegateSlotRequest>();
	private _queue: Entry[] = [];
	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly _cap: () => number) { }

	/** Resolves true when the helper may start, or false when it was cancelled while it waited. */
	acquire(request: ClaudeDelegateSlotRequest): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			this._queue.push({ ...request, resolve });
			this.pump();
		});
	}

	/** A helper finished, failed or was stopped: its slot and files go free. */
	release(id: string): void {
		if (this._running.delete(id)) {
			this.pump();
		}
	}

	/** A queued helper no longer waits (it was stopped). A running one is untouched. */
	cancel(id: string): void {
		const entry = this._queue.find(item => item.id === id);
		if (entry) {
			this._queue = this._queue.filter(item => item !== entry);
			entry.resolve(false);
			this.pump();
		}
	}

	runningCount(repo: string): number {
		return [...this._running.values()].filter(item => item.repo === repo).length;
	}

	/** The waiting helpers with their place in their repository's queue. */
	queued(): readonly ClaudeDelegateQueued[] {
		const seen = new Map<string, number>();
		const result: ClaudeDelegateQueued[] = [];
		for (const entry of this._queue) {
			const position = (seen.get(entry.repo) ?? 0) + 1;
			seen.set(entry.repo, position);
			const blocker = this.blocker(entry, this._queue.slice(0, position - 1));
			result.push({ id: entry.id, position, reason: blocker ? 'files' : 'cap', ...(blocker ? { blockedBy: blocker } : {}) });
		}
		return result;
	}

	/** The running or earlier-queued helper in the same repository that owns an overlapping path. */
	private blocker(entry: ClaudeDelegateSlotRequest, earlier: readonly ClaudeDelegateSlotRequest[]): string | undefined {
		if (entry.ownWorktree || !entry.files?.length) {
			return undefined;
		}
		const others = [...this._running.values(), ...earlier];
		return others.find(other => other.repo === entry.repo && !other.ownWorktree && other.files?.length && claudeOwnedFilesOverlap(entry.files!, other.files))?.id;
	}

	private pump(): void {
		const waiting: Entry[] = [];
		const started: Entry[] = [];
		for (const entry of this._queue) {
			const full = this.runningCount(entry.repo) >= this._cap();
			if (!full && !this.blocker(entry, waiting)) {
				const { resolve, ...request } = entry;
				void resolve;
				this._running.set(entry.id, request);
				started.push(entry);
			} else {
				waiting.push(entry);
			}
		}
		this._queue = waiting;
		for (const entry of started) {
			entry.resolve(true);
		}
		this._onDidChange.fire();
	}
}
