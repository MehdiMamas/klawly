/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Worktree retention (issue 865). Background tasks live in memory, so each worktree gets a
 * persisted record with its age. Klawly removes a worktree after `claude.worktrees.cleanupAfterDays`
 * days, but only one with nothing left to apply: no edits, no untracked files and no commits
 * beyond its base. Everything else stays until the user deletes it.
 */
export const CLAUDE_WORKTREES_CLEANUP_DAYS_SETTING = 'claude.worktrees.cleanupAfterDays';
export const CLAUDE_WORKTREES_CLEANUP_DAYS_DEFAULT = 30;
export const CLAUDE_WORKTREES_CLEANUP_DAYS_MAX = 3650;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the registry remembers about one worktree. */
export interface ClaudeWorktreeRecord {
	readonly id: string;
	readonly title: string;
	readonly repoRoot: string;
	readonly worktreePath: string;
	readonly branchName: string;
	readonly baseRef: string;
	readonly createdAt: number;
	/** When the agent last finished or failed. Unset while it runs. */
	readonly finishedAt?: number;
}

/** Days after which an idle worktree is removed. 0 turns it off; anything unusable is the default. */
export function readClaudeWorktreeCleanupDays(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		return CLAUDE_WORKTREES_CLEANUP_DAYS_DEFAULT;
	}
	return Math.min(Math.floor(value), CLAUDE_WORKTREES_CLEANUP_DAYS_MAX);
}

/** Reads the stored registry. A damaged entry is dropped, never thrown on. */
export function parseWorktreeRecords(raw: string | undefined): ClaudeWorktreeRecord[] {
	if (!raw) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	const records: ClaudeWorktreeRecord[] = [];
	const seen = new Set<string>();
	for (const entry of parsed) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const e = entry as Record<string, unknown>;
		if (typeof e.id !== 'string' || typeof e.repoRoot !== 'string' || typeof e.worktreePath !== 'string' || typeof e.branchName !== 'string' || typeof e.baseRef !== 'string'
			|| !e.id || !e.worktreePath || !e.baseRef || typeof e.createdAt !== 'number' || !Number.isFinite(e.createdAt) || seen.has(e.id)) {
			continue;
		}
		seen.add(e.id);
		records.push({
			id: e.id,
			title: typeof e.title === 'string' ? e.title : e.id,
			repoRoot: e.repoRoot,
			worktreePath: e.worktreePath,
			branchName: e.branchName,
			baseRef: e.baseRef,
			createdAt: e.createdAt,
			finishedAt: typeof e.finishedAt === 'number' && Number.isFinite(e.finishedAt) ? e.finishedAt : undefined,
		});
	}
	return records;
}

/** When the worktree last had work: its finish time, or its creation if it never finished. */
export function worktreeLastActive(record: ClaudeWorktreeRecord): number {
	return record.finishedAt ?? record.createdAt;
}

/** Whole days since the worktree last had work. */
export function worktreeAgeDays(record: ClaudeWorktreeRecord, now: number): number {
	return Math.max(0, Math.floor((now - worktreeLastActive(record)) / DAY_MS));
}

/**
 * The records idle for at least `days` days. `runningIds` are never due: an agent that is
 * still working keeps its worktree however old it is.
 */
export function expiredWorktrees(records: readonly ClaudeWorktreeRecord[], now: number, days: number, runningIds: ReadonlySet<string>): ClaudeWorktreeRecord[] {
	if (days <= 0) {
		return [];
	}
	return records.filter(record => !runningIds.has(record.id) && now - worktreeLastActive(record) >= days * DAY_MS);
}

export interface ClaudeWorktreeUsage {
	readonly record: ClaudeWorktreeRecord;
	/** Bytes on disk, or undefined when the folder is gone or could not be read. */
	readonly bytes: number | undefined;
}

/** The total of the sizes that could be read, and how many could not. */
export function totalWorktreeUsage(usages: readonly ClaudeWorktreeUsage[]): { readonly bytes: number; readonly unreadable: number } {
	let bytes = 0;
	let unreadable = 0;
	for (const usage of usages) {
		if (usage.bytes === undefined) {
			unreadable++;
		} else {
			bytes += usage.bytes;
		}
	}
	return { bytes, unreadable };
}
