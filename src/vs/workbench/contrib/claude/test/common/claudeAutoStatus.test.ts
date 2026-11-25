/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeAutoNoticeSeverity, claudeAutoStatus } from '../../common/claudeAutoStatus.js';

/** DL-109 and DL-110: each Auto state in plain words with its cost and one main action. */
suite('Claude Auto status', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const ids = (s: ReturnType<typeof claudeAutoStatus>) => s.actions.map(a => a.id);
	const primaries = (s: ReturnType<typeof claudeAutoStatus>) => s.actions.filter(a => a.primary).map(a => a.id);

	test('working: helpers, model, cost and Stop', () => {
		const s = claudeAutoStatus({ state: 'working', modelLabel: 'Sonnet', helpers: 2, costUsd: 1.87 });
		assert.strictEqual(s.label, 'Working');
		assert.strictEqual(s.detail, '2 helpers on Sonnet');
		assert.strictEqual(s.cost, '$1.87');
		assert.deepStrictEqual(ids(s), ['stop']);
		assert.ok(s.aria.includes('Working') && s.aria.includes('$1.87'));
	});

	test('working on CI costs $0 while waiting', () => {
		const s = claudeAutoStatus({ state: 'working', waitingOnCi: true, costUsd: 2.31 });
		assert.strictEqual(s.cost, '$0 while waiting · $2.31 total');
		assert.strictEqual(s.detail, 'waiting on CI, no model running');
	});

	test('waiting shows the question and the answer action', () => {
		const s = claudeAutoStatus({ state: 'waiting', question: 'Use the new API?', modelLabel: 'Opus', costUsd: 0.5 });
		assert.strictEqual(s.label, 'Waiting for you');
		assert.strictEqual(s.detail, 'Use the new API?');
		assert.deepStrictEqual(primaries(s), ['answer']);
		assert.ok(s.aria.includes('Opus'));
	});

	test('done offers Open PR, or View Changes without a PR', () => {
		assert.deepStrictEqual(ids(claudeAutoStatus({ state: 'done', hasPr: true, filesChanged: 4, minutes: 6 })), ['openPr']);
		const s = claudeAutoStatus({ state: 'done', filesChanged: 1 });
		assert.deepStrictEqual(ids(s), ['viewChanges']);
		assert.strictEqual(s.detail, '1 file changed');
	});

	test('failed always gives a reason; Retry on Opus only when Opus was not tried', () => {
		const first = claudeAutoStatus({ state: 'failed', reason: 'Tests failed twice', hasLog: true });
		assert.strictEqual(first.detail, 'Tests failed twice');
		assert.deepStrictEqual(ids(first), ['retryOnOpus', 'retry', 'openLog']);
		assert.deepStrictEqual(primaries(first), ['retryOnOpus']);
		const again = claudeAutoStatus({ state: 'failed', opusTried: true });
		assert.strictEqual(again.detail, 'No reason was reported');
		assert.deepStrictEqual(ids(again), ['retry']);
	});

	test('guard hit names the limit and offers Continue and Stop', () => {
		const cost = claudeAutoStatus({ state: 'guard', guard: 'cost', costUsd: 25 });
		assert.strictEqual(cost.detail, '$25.00 used');
		assert.deepStrictEqual(ids(cost), ['continue', 'stop']);
		assert.strictEqual(claudeAutoStatus({ state: 'guard', guard: 'context' }).detail, 'Context is nearly full');
	});

	test('every state has exactly one primary action', () => {
		for (const state of ['working', 'waiting', 'done', 'failed', 'guard'] as const) {
			assert.strictEqual(primaries(claudeAutoStatus({ state })).length, 1, state);
		}
	});

	test('a notification fires once when the run starts waiting, fails or finishes, never on the first paint', () => {
		assert.deepStrictEqual({
			first: claudeAutoNoticeSeverity(undefined, 'done'),
			same: claudeAutoNoticeSeverity('working', 'working'),
			waiting: claudeAutoNoticeSeverity('working', 'waiting'),
			failed: claudeAutoNoticeSeverity('working', 'failed'),
			done: claudeAutoNoticeSeverity('working', 'done'),
			doneAfterWaiting: claudeAutoNoticeSeverity('waiting', 'done'),
			backToWork: claudeAutoNoticeSeverity('waiting', 'working'),
		}, {
			first: undefined,
			same: undefined,
			waiting: 'warn',
			failed: 'error',
			done: 'info',
			doneAfterWaiting: undefined,
			backToWork: undefined,
		});
	});
});
