/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BackgroundAgentTask, IClaudeWorktreeService } from '../../../../../platform/claude/common/claudeBackground.js';
import { CLAUDE_WORKTREES_CLEANUP_DAYS_SETTING } from '../../../../../platform/claude/common/claudeWorktreeRetention.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IClaudeBackgroundAgentService } from '../../common/claudeBackgroundAgent.js';
import { ClaudeWorktreeKeeper } from '../../common/claudeWorktreeKeeper.js';

const DAY = 24 * 60 * 60 * 1000;

function task(id: string, status: string = 'complete'): BackgroundAgentTask {
	return { id, sessionId: `s-${id}`, repoRoot: '/r', baseRef: 'abc', worktreePath: `/w/${id}`, branchName: `klawly/${id}`, status, title: `Task ${id}` } as unknown as BackgroundAgentTask;
}

suite('Claude worktree keeper', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	class Harness {
		readonly storage = store.add(new InMemoryStorageService());
		readonly changed = store.add(new Emitter<void>());
		tasks: BackgroundAgentTask[] = [];
		dirty = new Set<string>();
		hasChangesError = new Map<string, Error>();
		gone = new Set<string>();
		ops: string[] = [];
		days: unknown = 30;
		deleteError: Error | undefined;

		readonly git = {
			hasChanges: async (path: string) => {
				const error = this.hasChangesError.get(path);
				if (error) {
					throw error;
				}
				return this.dirty.has(path);
			},
			remove: async (_repo: string, path: string, _branch: string, force?: boolean) => {
				this.ops.push(`git.remove ${path} force=${!!force}`);
				if (this.dirty.has(path) && !force) {
					throw new Error('contains modified or untracked files');
				}
			},
			diskUsage: async (path: string) => this.gone.has(path) ? undefined : 100,
		} as unknown as IClaudeWorktreeService;

		readonly background = {
			onDidChangeTasks: this.changed.event,
			getTasks: () => this.tasks,
			delete: async (id: string, options?: { confirmed?: boolean }) => {
				if (this.deleteError) {
					throw this.deleteError;
				}
				this.ops.push(`background.delete ${id} confirmed=${!!options?.confirmed}`);
				this.tasks = this.tasks.filter(t => t.id !== id);
				this.changed.fire();
			},
		} as unknown as IClaudeBackgroundAgentService;

		readonly files = { del: async () => { /* scratch folders */ } } as unknown as IFileService;

		keeper(): ClaudeWorktreeKeeper {
			const configuration = new TestConfigurationService({ [CLAUDE_WORKTREES_CLEANUP_DAYS_SETTING]: this.days });
			return store.add(new ClaudeWorktreeKeeper('/u', this.storage, this.git, this.background, configuration, this.files));
		}
	}

	test('a new task is recorded, and finishing it stamps the finish time once', () => {
		const h = new Harness();
		h.tasks = [task('a', 'running')];
		const keeper = h.keeper();
		assert.strictEqual(keeper.records().length, 1);
		assert.strictEqual(keeper.records()[0].finishedAt, undefined);
		h.tasks = [task('a', 'complete')];
		h.changed.fire();
		const finishedAt = keeper.records()[0].finishedAt;
		assert.ok(finishedAt);
		h.changed.fire();
		assert.strictEqual(keeper.records()[0].finishedAt, finishedAt);
	});

	test('the registry is kept across a restart, and a record not seen again is not dropped', () => {
		const h = new Harness();
		h.tasks = [task('a')];
		h.keeper();
		h.tasks = [];
		const restarted = h.keeper();
		assert.deepStrictEqual(restarted.records().map(r => r.id), ['a']);
	});

	test('a task deleted this session drops its record', () => {
		const h = new Harness();
		h.tasks = [task('a')];
		const keeper = h.keeper();
		h.tasks = [];
		h.changed.fire();
		assert.deepStrictEqual(keeper.records(), []);
	});

	test('sweep removes a clean worktree idle long enough, through its task when it has one', async () => {
		const h = new Harness();
		h.tasks = [task('a')];
		const keeper = h.keeper();
		const result = await keeper.sweep(Date.now() + 31 * DAY);
		assert.deepStrictEqual(result.removed.map(r => r.id), ['a']);
		assert.deepStrictEqual(h.ops, ['background.delete a confirmed=true']);
		assert.deepStrictEqual(keeper.records(), []);
	});

	test('sweep removes an orphan after a restart with a plain, non-forced git remove', async () => {
		const h = new Harness();
		h.tasks = [task('a')];
		h.keeper();
		h.tasks = [];
		const restarted = h.keeper();
		const result = await restarted.sweep(Date.now() + 31 * DAY);
		assert.deepStrictEqual(result.removed.map(r => r.id), ['a']);
		assert.deepStrictEqual(h.ops, ['git.remove /w/a force=false']);
		assert.deepStrictEqual(restarted.records(), []);
	});

	test('sweep keeps worktrees with work, ones that cannot be checked, young ones and running ones', async () => {
		const h = new Harness();
		h.tasks = [task('dirty'), task('broken'), task('running', 'running')];
		const keeper = h.keeper();
		h.dirty.add('/w/dirty');
		h.hasChangesError.set('/w/broken', new Error('Git took too long.'));
		const result = await keeper.sweep(Date.now() + 31 * DAY);
		assert.deepStrictEqual(result.removed.map(r => r.id), []);
		assert.deepStrictEqual(result.kept.map(r => r.id), ['dirty', 'broken']);
		assert.deepStrictEqual(h.ops, []);
		const soon = await keeper.sweep(Date.now() + DAY);
		assert.deepStrictEqual([soon.removed.length, soon.kept.length], [0, 0]);
		assert.strictEqual(keeper.records().length, 3);
	});

	test('git refusing a worktree keeps it even when the check said clean', async () => {
		const h = new Harness();
		h.tasks = [task('a')];
		h.deleteError = new Error('contains modified or untracked files');
		const keeper = h.keeper();
		const result = await keeper.sweep(Date.now() + 31 * DAY);
		assert.deepStrictEqual([result.removed.length, result.kept.map(r => r.id)], [0, ['a']]);
		assert.strictEqual(keeper.records().length, 1);
	});

	test('a worktree whose folder is already gone loses its record', async () => {
		const h = new Harness();
		h.tasks = [task('a')];
		h.keeper();
		h.tasks = [];
		const restarted = h.keeper();
		h.gone.add('/w/a');
		h.hasChangesError.set('/w/a', new Error('spawn git ENOENT'));
		const result = await restarted.sweep(Date.now() + 31 * DAY);
		assert.deepStrictEqual(result.removed.map(r => r.id), ['a']);
		assert.deepStrictEqual(restarted.records(), []);
	});

	test('0 days turns the sweep off', async () => {
		const h = new Harness();
		h.days = 0;
		h.tasks = [task('a')];
		const keeper = h.keeper();
		const result = await keeper.sweep(Date.now() + 400 * DAY);
		assert.deepStrictEqual([result.removed.length, result.kept.length, h.ops.length], [0, 0, 0]);
	});

	test('usage reads each worktree, and says undefined for a folder that is gone', async () => {
		const h = new Harness();
		h.tasks = [task('a'), task('b')];
		const keeper = h.keeper();
		h.gone.add('/w/b');
		assert.deepStrictEqual((await keeper.usage()).map(u => [u.record.id, u.bytes]), [['a', 100], ['b', undefined]]);
	});
});
