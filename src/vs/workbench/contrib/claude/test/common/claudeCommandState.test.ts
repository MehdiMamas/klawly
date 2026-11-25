/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeCommandState, claudeSessionTurnKey, claudeTurnsToOpenAfterEdit, forgetClosedSessionTurns } from '../../common/claudeCommandState.js';

suite('Claude command state', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const review = (turnId: string, ...states: string[]) => ({ turnId, files: states.map(state => ({ state })) });

	test('preconditions follow the current session', () => {
		assert.deepStrictEqual(claudeCommandState([], [], []), {
			running: false, hasTurns: false, hasPendingChanges: false, hasSubagents: false, hasRunningSubagent: false,
		});
		assert.deepStrictEqual(claudeCommandState(
			[{ id: 't1', status: 'complete' }, { id: 't2', status: 'running' }],
			[{ run: { state: 'success' } }, { run: { state: 'running' } }],
			[review('t1', 'accepted', 'mixed')],
		), {
			running: true, hasTurns: true, hasPendingChanges: true, hasSubagents: true, hasRunningSubagent: true,
		});
		assert.strictEqual(claudeCommandState([{ id: 't1', status: 'complete' }], [], [review('t1', 'accepted', 'rejected')]).hasPendingChanges, false);
	});

	test('openAfterAgentEdit opens turns seen running once, never inline edits or replayed history', () => {
		const turns = [
			{ id: 'replayed', status: 'complete' },
			{ id: 'live', status: 'complete' },
			{ id: 'inline', status: 'complete' },
			{ id: 'busy', status: 'running' },
			{ id: 'done', status: 'complete' },
		];
		const seen = new Set(['live', 'inline', 'busy', 'done']);
		assert.deepStrictEqual(claudeTurnsToOpenAfterEdit(turns, seen, new Set(['done']), id => id === 'inline'), ['live']);
	});

	test('per-turn pane state of a closed session is forgotten', () => {
		const seen = new Set([claudeSessionTurnKey('a', 't1'), claudeSessionTurnKey('a', 't2'), claudeSessionTurnKey('b', 't3')]);
		const attempts = new Map([[claudeSessionTurnKey('a', 't1'), 'complete'], [claudeSessionTurnKey('b', 't3'), 'running']]);
		forgetClosedSessionTurns(seen, new Set(['b']));
		forgetClosedSessionTurns(attempts, new Set(['b']));
		assert.deepStrictEqual({ seen: [...seen], attempts: [...attempts.keys()] }, { seen: [claudeSessionTurnKey('b', 't3')], attempts: [claudeSessionTurnKey('b', 't3')] });
		forgetClosedSessionTurns(seen, new Set());
		assert.strictEqual(seen.size, 0);
	});
});
