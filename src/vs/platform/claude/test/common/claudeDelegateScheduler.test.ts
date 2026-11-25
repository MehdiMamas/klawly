/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeDelegateScheduler, claudeDelegateDepthLimit, claudeOwnedFilesOverlap, readClaudeDelegateCodingCap } from '../../common/claudeDelegateScheduler.js';

suite('Claude delegate scheduler', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the cap and the depth read their settings, with a reason lifting the depth to 4', () => {
		assert.deepStrictEqual([
			readClaudeDelegateCodingCap(undefined),
			readClaudeDelegateCodingCap(0),
			readClaudeDelegateCodingCap(3.7),
			readClaudeDelegateCodingCap(99),
			claudeDelegateDepthLimit(undefined, undefined),
			claudeDelegateDepthLimit(3, undefined),
			claudeDelegateDepthLimit(9, undefined),
			claudeDelegateDepthLimit(2, '  '),
			claudeDelegateDepthLimit(2, 'a separate area with its own coordinator'),
		], [4, 4, 3, 16, 2, 3, 4, 2, 4]);
	});

	test('owned files overlap on the same path or a folder holding the other', () => {
		assert.deepStrictEqual([
			claudeOwnedFilesOverlap(['src/a.ts'], ['src/a.ts']),
			claudeOwnedFilesOverlap(['src/'], ['src/a.ts']),
			claudeOwnedFilesOverlap(['.' + String.fromCharCode(92) + 'src' + String.fromCharCode(92) + 'a.ts'], ['src']),
			claudeOwnedFilesOverlap(['src/a.ts'], ['src/ab.ts']),
			claudeOwnedFilesOverlap([], ['src']),
		], [true, true, true, false, false]);
	});

	test('a full repository queues the rest in order, and a free slot starts the next', async () => {
		const scheduler = new ClaudeDelegateScheduler(() => 2);
		const order: string[] = [];
		const run = (id: string, repo = 'r') => scheduler.acquire({ id, repo }).then(started => order.push(`${id}:${started}`));
		const all = [run('a'), run('b'), run('c'), run('d'), run('other', 'r2')];
		await Promise.resolve();
		const first = { running: scheduler.runningCount('r'), queued: scheduler.queued().map(q => `${q.id}#${q.position}:${q.reason}`) };
		scheduler.release('a');
		await Promise.resolve();
		const second = scheduler.queued().map(q => q.id);
		scheduler.release('b');
		scheduler.release('c');
		await Promise.all(all);
		assert.deepStrictEqual({ first, second, order }, {
			first: { running: 2, queued: ['c#1:cap', 'd#2:cap'] },
			second: ['d'],
			order: ['a:true', 'b:true', 'other:true', 'c:true', 'd:true'],
		});
	});

	test('a helper owning overlapping files waits for the running one unless it has its own worktree', async () => {
		const scheduler = new ClaudeDelegateScheduler(() => 4);
		const started: string[] = [];
		const run = (id: string, files: string[], ownWorktree = false) => scheduler.acquire({ id, repo: 'r', files, ownWorktree }).then(() => started.push(id));
		const all = [run('a', ['src/x']), run('b', ['src/x/y.ts']), run('c', ['src/x'], true), run('d', ['docs'])];
		await Promise.resolve();
		const before = { started: [...started], queued: scheduler.queued() };
		scheduler.release('a');
		await Promise.all(all);
		assert.deepStrictEqual({ before, started }, {
			before: { started: ['a', 'c', 'd'], queued: [{ id: 'b', position: 1, reason: 'files', blockedBy: 'a' }] },
			started: ['a', 'c', 'd', 'b'],
		});
	});

	test('cancelling a queued helper resolves it false and frees its place', async () => {
		const scheduler = new ClaudeDelegateScheduler(() => 1);
		const results: Array<boolean | string> = [];
		const all = [
			scheduler.acquire({ id: 'a', repo: 'r' }).then(v => results.push(`a:${v}`)),
			scheduler.acquire({ id: 'b', repo: 'r' }).then(v => results.push(`b:${v}`)),
			scheduler.acquire({ id: 'c', repo: 'r' }).then(v => results.push(`c:${v}`)),
		];
		scheduler.cancel('b');
		scheduler.release('a');
		await Promise.all(all);
		assert.deepStrictEqual({ results, running: scheduler.runningCount('r') }, { results: ['a:true', 'b:false', 'c:true'], running: 1 });
	});
});
