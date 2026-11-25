/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_AUTO_REVIEW_MAX_ROUNDS_SETTING, claudeAutoReviewHandoffMessage, formatClaudeAutoReviewLogLine, nextClaudeAutoReviewStep, readClaudeAutoReviewMaxRounds } from '../../common/claudeAutoReviewRounds.js';

suite('Claude Auto review rounds (issue 1219)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const changes = { verdict: 'changes' as const, openPoints: ['Missing test', ' '] };

	test('stops after 2 rounds by default and hands the open points to the user', () => {
		const max = readClaudeAutoReviewMaxRounds(() => undefined);
		assert.strictEqual(max, 2);
		assert.deepStrictEqual(nextClaudeAutoReviewStep(1, changes, max), { kind: 'rework', round: 1, openPoints: ['Missing test'] });
		assert.deepStrictEqual(nextClaudeAutoReviewStep(2, changes, max), { kind: 'handToUser', round: 2, openPoints: ['Missing test'] });
	});

	test('a ready verdict ends the loop at any round', () => {
		assert.strictEqual(nextClaudeAutoReviewStep(1, { verdict: 'ready' }, 2).kind, 'done');
		assert.strictEqual(nextClaudeAutoReviewStep(2, { verdict: 'ready' }, 2).kind, 'done');
	});

	test('the setting changes the cap', () => {
		const get = (value: unknown) => (key: string) => key === CLAUDE_AUTO_REVIEW_MAX_ROUNDS_SETTING ? value : undefined;
		assert.strictEqual(nextClaudeAutoReviewStep(2, changes, readClaudeAutoReviewMaxRounds(get(3))).kind, 'rework');
		assert.strictEqual(nextClaudeAutoReviewStep(3, changes, readClaudeAutoReviewMaxRounds(get(3))).kind, 'handToUser');
		assert.strictEqual(nextClaudeAutoReviewStep(1, changes, readClaudeAutoReviewMaxRounds(get(1))).kind, 'handToUser');
		for (const bad of [0, 6, 1.5, '3', null]) {
			assert.strictEqual(readClaudeAutoReviewMaxRounds(get(bad)), 2);
		}
	});

	test('the handoff message lists the points and the log line names the round', () => {
		assert.strictEqual(claudeAutoReviewHandoffMessage(2, ['A', 'B']).split('\n').length, 3);
		assert.ok(formatClaudeAutoReviewLogLine({ time: 0, sessionId: 's', round: 2, maxRounds: 2, next: 'handToUser' }).includes('round=2/2 next=handToUser'));
	});
});
