/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeAttentionState } from '../../common/claudeAttentionState.js';

suite('Claude attention state', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('permissions: new ones once, answered ones and closed sessions forgotten', () => {
		const state = new ClaudeAttentionState();
		const ids = (items: { id: string }[]) => items.map(item => item.id);
		const seen = [
			ids(state.freshPermissions('a', [{ id: 'p1' }])),
			ids(state.freshPermissions('a', [{ id: 'p1' }, { id: 'p2' }])),
			ids(state.freshPermissions('b', [{ id: 'q1' }])),
		];
		const whilePending = state.size.permissions;
		state.freshPermissions('a', [{ id: 'p2' }]);
		const afterAnswer = state.size.permissions;
		state.freshPermissions('a', []);
		state.retainSessions(new Set(['a']));
		assert.deepStrictEqual({ seen, whilePending, afterAnswer, end: state.size.permissions }, {
			seen: [['p1'], ['p2'], ['q1']],
			whilePending: 3,
			afterAnswer: 2,
			end: 0,
		});
	});

	test('auth failures: once per failed turn, one entry per open session', () => {
		const state = new ClaudeAttentionState();
		const answers = [state.authFailed('a', 't1'), state.authFailed('a', 't1'), state.authFailed('a', 't2'), state.authFailed('b', 't9')];
		const before = state.size.authFailures;
		state.retainSessions(new Set(['b']));
		assert.deepStrictEqual({ answers, before, after: state.size.authFailures }, { answers: [true, false, true, true], before: 2, after: 1 });
	});

	test('tasks: only a change to complete or failed is reported; tasks that go are forgotten', () => {
		const state = new ClaudeAttentionState();
		const ended = [
			state.endedTasks([{ id: 'a', status: 'complete' }, { id: 'b', status: 'running' }]),
			state.endedTasks([{ id: 'a', status: 'complete' }, { id: 'b', status: 'failed' }]),
			state.endedTasks([{ id: 'b', status: 'failed' }]),
		].map(list => list.map(item => item.id));
		assert.deepStrictEqual({ ended, tasks: state.size.tasks }, { ended: [[], ['b'], []], tasks: 1 });
		state.endedTasks([]);
		assert.strictEqual(state.size.tasks, 0);
	});

	test('turns: a running turn that completes or fails is reported once; first sight and stops are not', () => {
		const state = new ClaudeAttentionState();
		const answers = [
			state.endedTurn('a', { id: 't1', status: 'complete' }),
			state.endedTurn('a', { id: 't2', status: 'running' }),
			state.endedTurn('a', { id: 't2', status: 'complete' }),
			state.endedTurn('a', { id: 't2', status: 'complete' }),
			state.endedTurn('a', { id: 't3', status: 'failed' }),
			state.endedTurn('a', { id: 't4', status: 'stopped' }),
			state.endedTurn('b', undefined),
			state.endedTurn('b', { id: 'u1', status: 'complete' }),
		];
		const before = state.size.turns;
		state.retainSessions(new Set(['b']));
		assert.deepStrictEqual({ answers, before, after: state.size.turns }, {
			answers: [false, false, true, false, true, false, false, true],
			before: 2,
			after: 1,
		});
	});
});
