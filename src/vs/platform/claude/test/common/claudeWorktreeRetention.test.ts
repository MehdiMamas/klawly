/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeWorktreeRecord, expiredWorktrees, parseWorktreeRecords, readClaudeWorktreeCleanupDays, totalWorktreeUsage, worktreeAgeDays } from '../../common/claudeWorktreeRetention.js';

const DAY = 24 * 60 * 60 * 1000;

function record(id: string, createdAt: number, finishedAt?: number): ClaudeWorktreeRecord {
	return { id, title: id, repoRoot: '/r', worktreePath: `/w/${id}`, branchName: `klawly/${id}`, baseRef: 'abc', createdAt, finishedAt };
}

suite('Claude worktree retention', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('days: a number from 0 up is kept, anything else is the default', () => {
		assert.deepStrictEqual([0, 7, 7.9, 99999, -1, NaN, '7', undefined].map(readClaudeWorktreeCleanupDays), [0, 7, 7, 3650, 30, 30, 30, 30]);
	});

	test('the registry survives damage: bad JSON, wrong shapes and duplicates are dropped', () => {
		assert.deepStrictEqual(parseWorktreeRecords(undefined), []);
		assert.deepStrictEqual(parseWorktreeRecords('{nope'), []);
		assert.deepStrictEqual(parseWorktreeRecords('{"a":1}'), []);
		const good = record('a', 5, 9);
		const parsed = parseWorktreeRecords(JSON.stringify([good, good, null, 3, { id: 'x' }, { ...good, id: 'b', createdAt: 'soon' }]));
		assert.deepStrictEqual(parsed, [good]);
	});

	test('age counts from the finish time, else the start', () => {
		assert.strictEqual(worktreeAgeDays(record('a', 0, 3 * DAY), 5 * DAY + 5), 2);
		assert.strictEqual(worktreeAgeDays(record('a', 2 * DAY), 5 * DAY), 3);
		assert.strictEqual(worktreeAgeDays(record('a', 9 * DAY), 5 * DAY), 0);
	});

	test('only worktrees idle for the full N days that are not running are due', () => {
		const now = 100 * DAY;
		const records = [record('old', 0, 60 * DAY), record('edge', 0, 70 * DAY), record('young', 0, 71 * DAY), record('running', 0)];
		assert.deepStrictEqual(expiredWorktrees(records, now, 30, new Set(['running'])).map(r => r.id), ['old', 'edge']);
		assert.deepStrictEqual(expiredWorktrees(records, now, 0, new Set()), []);
	});

	test('the total counts what could be read and reports the rest', () => {
		const a = record('a', 0);
		assert.deepStrictEqual(totalWorktreeUsage([{ record: a, bytes: 10 }, { record: a, bytes: undefined }, { record: a, bytes: 5 }]), { bytes: 15, unreadable: 1 });
	});
});
