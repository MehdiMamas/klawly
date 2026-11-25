/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeWorktreeRecord } from '../../../../../platform/claude/common/claudeWorktreeRetention.js';
import { worktreeDiskPickItems, worktreeDiskSummary } from '../../browser/claudeWorktreeRetention.js';

const DAY = 24 * 60 * 60 * 1000;

function record(id: string, finishedAt: number): ClaudeWorktreeRecord {
	return { id, title: `Task ${id}`, repoRoot: '/r', worktreePath: `/w/${id}`, branchName: `klawly/${id}`, baseRef: 'abc', createdAt: 0, finishedAt };
}

suite('Claude worktree disk use', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the biggest worktree is listed first, with its size and age', () => {
		const now = 10 * DAY;
		const items = worktreeDiskPickItems([
			{ record: record('a', now), bytes: 2048 },
			{ record: record('b', now - 3 * DAY), bytes: 5 * 1024 * 1024 },
			{ record: record('c', now - DAY), bytes: undefined },
		], now);
		assert.deepStrictEqual(items.map(item => item.label), ['Task b', 'Task a', 'Task c']);
		assert.ok(items[0].description?.includes('MB'));
		assert.ok(items[0].detail?.includes('3 days'));
		assert.ok(items[1].detail?.includes('today'));
		assert.ok(items[2].description?.includes('unknown'));
	});

	test('the summary gives the count and total, and says what could not be read', () => {
		const a = record('a', 0);
		assert.ok(worktreeDiskSummary([{ record: a, bytes: 1024 }]).includes('1'));
		assert.ok(worktreeDiskSummary([{ record: a, bytes: 1024 }, { record: a, bytes: undefined }]).includes('could not be read'));
	});
});
