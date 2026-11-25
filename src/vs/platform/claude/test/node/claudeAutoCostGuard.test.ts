/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_AUTO_COST_NOTIFY_USD_SETTING, CLAUDE_AUTO_COST_STOP_USD_SETTING, claudeAutoCostNotifyLabel, claudeAutoCostState, formatClaudeAutoCostLogLine, formatClaudeAutoCostUsd, raiseClaudeAutoCostStop, readClaudeAutoCostNotify, readClaudeAutoCostStop } from '../../common/claudeAutoCostGuard.js';

suite('Claude Auto cost guard (issue 1218)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ok below the notify amount, and when no cost is known', () => {
		assert.strictEqual(claudeAutoCostState(undefined, 25, 50), 'ok');
		assert.strictEqual(claudeAutoCostState(0, 25, 50), 'ok');
		assert.strictEqual(claudeAutoCostState(24.99, 25, 50), 'ok');
		assert.strictEqual(claudeAutoCostState(Number.NaN, 25, 50), 'ok');
	});

	test('notify from the notify amount until the stop amount', () => {
		assert.strictEqual(claudeAutoCostState(25, 25, 50), 'notify');
		assert.strictEqual(claudeAutoCostState(49.99, 25, 50), 'notify');
	});

	test('stop at and above the stop amount', () => {
		assert.strictEqual(claudeAutoCostState(50, 25, 50), 'stop');
		assert.strictEqual(claudeAutoCostState(300, 25, 50), 'stop');
		assert.strictEqual(claudeAutoCostState(30, 40, 20), 'stop');
	});

	test('raising the limit adds one step', () => {
		assert.strictEqual(raiseClaudeAutoCostStop(50, 50), 100);
		assert.strictEqual(claudeAutoCostState(60, 25, raiseClaudeAutoCostStop(50, 50)), 'notify');
	});

	test('settings fall back to the defaults when not a number in range', () => {
		assert.strictEqual(readClaudeAutoCostNotify(() => undefined), 25);
		assert.strictEqual(readClaudeAutoCostStop(() => undefined), 50);
		assert.strictEqual(readClaudeAutoCostStop(() => 0), 50);
		assert.strictEqual(readClaudeAutoCostStop(() => '80'), 50);
		assert.strictEqual(readClaudeAutoCostStop(() => 1e9), 50);
		assert.strictEqual(readClaudeAutoCostNotify(key => key === CLAUDE_AUTO_COST_NOTIFY_USD_SETTING ? 10 : 99), 10);
		assert.strictEqual(readClaudeAutoCostStop(key => key === CLAUDE_AUTO_COST_STOP_USD_SETTING ? 120 : 1), 120);
	});

	test('label and log line', () => {
		assert.strictEqual(claudeAutoCostNotifyLabel(25), '$25 Used');
		assert.strictEqual(formatClaudeAutoCostLogLine('s1', 50.4, 50), '[auto] cost stop: session s1 stopped at $50.40 of $50');
	});

	test('cost formatting: two decimals under $10, whole dollars from $10', () => {
		assert.deepStrictEqual([0.4, 1.6, 9.99, 12.3].map(formatClaudeAutoCostUsd), ['$0.40', '$1.60', '$9.99', '$12']);
		assert.strictEqual(claudeAutoCostNotifyLabel(1.6), '$1.60 Used');
	});
});
