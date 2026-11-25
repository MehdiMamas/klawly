/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_AUTO_CONTEXT_CAP_TOKENS_SETTING, claudeAutoContextState, formatClaudeAutoContextLogLine, readClaudeAutoContextCap, scaleClaudeAutoContextCap } from '../../common/claudeAutoContextGuard.js';

suite('Claude Auto context guard (issue 846)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ok below 80% of the cap', () => {
		assert.strictEqual(claudeAutoContextState(0, 150000), 'ok');
		assert.strictEqual(claudeAutoContextState(119999, 150000), 'ok');
	});

	test('nudge from 80% until the cap', () => {
		assert.strictEqual(claudeAutoContextState(120000, 150000), 'nudge');
		assert.strictEqual(claudeAutoContextState(149999, 150000), 'nudge');
	});

	test('handoff at and above the cap', () => {
		assert.strictEqual(claudeAutoContextState(150000, 150000), 'handoff');
		assert.strictEqual(claudeAutoContextState(400000, 150000), 'handoff');
	});

	test('a smaller window scales the cap down to 80% of the window', () => {
		assert.strictEqual(scaleClaudeAutoContextCap(150000, 1000000), 150000);
		assert.strictEqual(scaleClaudeAutoContextCap(150000, 100000), 80000);
		assert.strictEqual(claudeAutoContextState(80000, 150000, 100000), 'handoff');
		assert.strictEqual(claudeAutoContextState(64000, 150000, 100000), 'nudge');
		assert.strictEqual(claudeAutoContextState(10000, 150000, 100000), 'ok');
	});

	test('bad numbers never trigger', () => {
		assert.strictEqual(claudeAutoContextState(NaN, 150000), 'ok');
		assert.strictEqual(claudeAutoContextState(-1, 150000), 'ok');
		assert.strictEqual(scaleClaudeAutoContextCap(150000, 0), 150000);
	});

	test('the setting falls back to 150000 when out of range', () => {
		assert.strictEqual(readClaudeAutoContextCap(() => undefined), 150000);
		assert.strictEqual(readClaudeAutoContextCap(() => 5), 150000);
		assert.strictEqual(readClaudeAutoContextCap(key => key === CLAUDE_AUTO_CONTEXT_CAP_TOKENS_SETTING ? 90000 : undefined), 90000);
	});

	test('the log line names the session and the numbers', () => {
		assert.strictEqual(formatClaudeAutoContextLogLine('s1', 151000, 150000), '[auto] context handoff: session s1 compacted at 151000 of 150000 tokens');
	});
});
