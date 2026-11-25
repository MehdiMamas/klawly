/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { isActiveBackgroundStatus, IClaudeWorktreeService } from '../../../../platform/claude/common/claudeBackground.js';
import { CLAUDE_WORKTREES_CLEANUP_DAYS_SETTING, ClaudeWorktreeRecord, ClaudeWorktreeUsage, expiredWorktrees, parseWorktreeRecords, readClaudeWorktreeCleanupDays } from '../../../../platform/claude/common/claudeWorktreeRetention.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IClaudeBackgroundAgentService, isAbsentWorktreeError } from './claudeBackgroundAgent.js';

const STORAGE_KEY = 'claude.worktrees.registry';

export const IClaudeWorktreeKeeper = createDecorator<IClaudeWorktreeKeeper>('claudeWorktreeKeeper');

export interface ClaudeWorktreeSweepResult {
	/** Worktrees removed, or already gone. */
	readonly removed: readonly ClaudeWorktreeRecord[];
	/** Old worktrees left alone: they have changes, commits not in their base, or could not be checked. */
	readonly kept: readonly ClaudeWorktreeRecord[];
}

/**
 * Remembers every worktree Klawly made, with its age, across restarts (issue 865), so old ones
 * can be removed and the disk they use can be shown. Background tasks alone cannot: they live in
 * memory and are gone after a restart while their worktrees stay on disk.
 */
export interface IClaudeWorktreeKeeper {
	readonly _serviceBrand: undefined;
	/** Fires when the registry changes. */
	readonly onDidChange: Event<void>;
	records(): readonly ClaudeWorktreeRecord[];
	/** Removes worktrees idle for `claude.worktrees.cleanupAfterDays` days, keeping any that hold work. */
	sweep(now?: number): Promise<ClaudeWorktreeSweepResult>;
	/** Bytes on disk of each kept worktree. */
	usage(): Promise<readonly ClaudeWorktreeUsage[]>;
}

export class ClaudeWorktreeKeeper extends Disposable implements IClaudeWorktreeKeeper {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _records: ClaudeWorktreeRecord[];
	/** Task ids seen in memory this session. A record only drops when its task is deleted, not just absent after a restart. */
	private readonly _seen = new Set<string>();
	private _sweeping: Promise<ClaudeWorktreeSweepResult> | undefined;

	constructor(
		private readonly _userDataPath: string,
		@IStorageService private readonly _storage: IStorageService,
		@IClaudeWorktreeService private readonly _git: IClaudeWorktreeService,
		@IClaudeBackgroundAgentService private readonly _background: IClaudeBackgroundAgentService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IFileService private readonly _files: IFileService,
	) {
		super();
		this._records = parseWorktreeRecords(this._storage.get(STORAGE_KEY, StorageScope.APPLICATION));
		this.observe();
		this._register(this._background.onDidChangeTasks(() => this.observe()));
	}

	records(): readonly ClaudeWorktreeRecord[] {
		return this._records;
	}

	private observe(): void {
		const now = Date.now();
		const tasks = this._background.getTasks();
		const live = new Set(tasks.map(task => task.id));
		let changed = false;
		for (const task of tasks) {
			this._seen.add(task.id);
			const index = this._records.findIndex(record => record.id === task.id);
			const active = isActiveBackgroundStatus(task.status);
			if (index < 0) {
				this._records.push({
					id: task.id,
					title: task.title,
					repoRoot: task.repoRoot,
					worktreePath: task.worktreePath,
					branchName: task.branchName,
					baseRef: task.baseRef,
					createdAt: now,
					finishedAt: active ? undefined : now,
				});
				changed = true;
				continue;
			}
			const record = this._records[index];
			const finishedAt = active ? undefined : (record.finishedAt ?? now);
			if (finishedAt !== record.finishedAt || record.title !== task.title) {
				this._records[index] = { ...record, title: task.title, finishedAt };
				changed = true;
			}
		}
		const before = this._records.length;
		this._records = this._records.filter(record => !this._seen.has(record.id) || live.has(record.id));
		if (this._records.length !== before) {
			changed = true;
		}
		if (changed) {
			this.save();
		}
	}

	private save(): void {
		this._storage.store(STORAGE_KEY, JSON.stringify(this._records), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire();
	}

	private drop(id: string): void {
		this._records = this._records.filter(record => record.id !== id);
		this.save();
	}

	sweep(now: number = Date.now()): Promise<ClaudeWorktreeSweepResult> {
		// One sweep at a time: a second call shares the first one's result.
		this._sweeping ??= this.runSweep(now).finally(() => { this._sweeping = undefined; });
		return this._sweeping;
	}

	private async runSweep(now: number): Promise<ClaudeWorktreeSweepResult> {
		const days = readClaudeWorktreeCleanupDays(this._configuration.getValue(CLAUDE_WORKTREES_CLEANUP_DAYS_SETTING));
		const running = new Set(this._background.getTasks().filter(task => isActiveBackgroundStatus(task.status)).map(task => task.id));
		const removed: ClaudeWorktreeRecord[] = [];
		const kept: ClaudeWorktreeRecord[] = [];
		for (const record of expiredWorktrees(this._records, now, days, running)) {
			if (await this.removeIfEmpty(record)) {
				removed.push(record);
			} else {
				kept.push(record);
			}
		}
		return { removed, kept };
	}

	/**
	 * True when the worktree is gone. A worktree with edits, untracked files or commits beyond its
	 * base is never removed, and neither is one that cannot be checked. Git's own non-forced
	 * remove refuses a dirty tree a second time.
	 */
	private async removeIfEmpty(record: ClaudeWorktreeRecord): Promise<boolean> {
		try {
			if (await this._git.hasChanges(record.worktreePath, record.baseRef)) {
				return false;
			}
		} catch (error) {
			if (!isAbsentWorktreeError(error) && !await this.folderIsGone(record)) {
				return false;
			}
			// The folder is already gone: tidy git's leftovers, then the record and scratch files.
			try {
				await this._git.remove(record.repoRoot, record.worktreePath, record.branchName, false);
			} catch {
				// Nothing left for git to remove.
			}
			await this.deleteScratch(record.id);
			this.drop(record.id);
			return true;
		}
		try {
			if (this._background.getTasks().some(task => task.id === record.id)) {
				await this._background.delete(record.id, { confirmed: true });
			} else {
				await this._git.remove(record.repoRoot, record.worktreePath, record.branchName, false);
			}
		} catch (error) {
			if (!isAbsentWorktreeError(error)) {
				return false;
			}
		}
		await this.deleteScratch(record.id);
		this.drop(record.id);
		return true;
	}

	private async folderIsGone(record: ClaudeWorktreeRecord): Promise<boolean> {
		try {
			return this._git.diskUsage !== undefined && await this._git.diskUsage(record.worktreePath) === undefined;
		} catch {
			return false;
		}
	}

	private async deleteScratch(id: string): Promise<void> {
		for (const name of ['preview', 'merge']) {
			try {
				await this._files.del(URI.file(join(this._userDataPath, 'worktrees', name, id)), { recursive: true });
			} catch {
				// The scratch folder is already gone.
			}
		}
	}

	async usage(): Promise<readonly ClaudeWorktreeUsage[]> {
		const usages: ClaudeWorktreeUsage[] = [];
		for (const record of this._records) {
			let bytes: number | undefined;
			try {
				bytes = await this._git.diskUsage?.(record.worktreePath);
			} catch {
				bytes = undefined;
			}
			usages.push({ record, bytes });
		}
		return usages;
	}
}
