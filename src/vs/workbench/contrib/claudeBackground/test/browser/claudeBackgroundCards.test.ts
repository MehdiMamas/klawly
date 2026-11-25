/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { backgroundAgentCard } from '../../../../services/claude/common/claudeBackgroundCards.js';
import { BackgroundAgentTask } from '../../../../../platform/claude/common/claudeBackground.js';
import { renderBackgroundAgentCard } from '../../browser/claudeBackgroundCard.js';

function task(status: BackgroundAgentTask['status']): BackgroundAgentTask {
	return {
		id: 'task',
		sessionId: 'session',
		repoRoot: '/repo',
		baseRef: 'abc',
		worktreePath: '/user/worktrees/hash/task',
		branchName: 'agent/task',
		status,
		title: 'Add coupon expiry handling',
		filesChanged: 2,
		added: 120,
		removed: 14,
		testStatus: status === 'complete' ? 'npm test exited 0' : 'tests not run',
		conflicts: [],
		stopped: false,
	};
}

suite('Claude background agent cards', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a running card offers review, open, and stop', () => {
		const parent = document.createElement('div');
		const store = new DisposableStore();
		const actions: string[] = [];
		try {
			const root = renderBackgroundAgentCard(parent, backgroundAgentCard(task('running')), store, action => actions.push(action));
			assert.strictEqual(root.classList.contains('claude-bg-agent'), true);
			const buttons = [...root.getElementsByTagName('button')];
			const labels = buttons.map(button => button.textContent ?? '');
			assert.ok(labels.some(label => label.includes('Open worktree')));
			assert.ok(labels.some(label => label.includes('Review')));
			assert.ok(labels.some(label => label.includes('Stop')));
			assert.ok(root.textContent?.includes('tests not run'));
			assert.ok(root.textContent?.includes('2 files'));
			buttons.find(button => button.textContent?.includes('Stop'))?.click();
			assert.deepStrictEqual(actions, ['stop']);
		} finally {
			store.dispose();
		}
	});

	test('a finished card offers review and apply, then delete', () => {
		const parent = document.createElement('div');
		const store = new DisposableStore();
		const actions: string[] = [];
		try {
			const root = renderBackgroundAgentCard(parent, backgroundAgentCard(task('complete')), store, action => actions.push(action));
			const buttons = [...root.getElementsByTagName('button')];
			const labels = buttons.map(button => button.textContent ?? '');
			assert.ok(labels.some(label => label.includes('Review & apply')));
			assert.ok(labels.some(label => label.includes('Delete')));
			assert.ok(root.textContent?.includes('npm test exited 0'));
			assert.ok(root.textContent?.includes('+120'));
			assert.ok(root.textContent?.includes('-14'));
			assert.strictEqual(root.textContent?.includes('\u2212'), false);
			buttons.find(button => button.textContent?.includes('Review & apply'))?.click();
			assert.deepStrictEqual(actions, ['apply']);
		} finally {
			store.dispose();
		}
	});
});
