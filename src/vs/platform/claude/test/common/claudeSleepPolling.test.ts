/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeSleepPollingProblem } from '../../common/claudeNoModelTools.js';

suite('Claude sleep polling block (issue 1110)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const bash = (command: unknown) => claudeSleepPollingProblem('Bash', { command });

	test('refuses sleep loops and sleep-then-check, pointing to Watch CI', () => {
		for (const command of ['sleep 60 && gh run view 1', 'while ! gh run view 1 | grep done; do sleep 30; done', 'until gh pr checks 3; do sleep 5; done']) {
			assert.ok(bash(command)?.includes('ci_wait'), command);
		}
	});

	test('allows ordinary commands, a lone sleep, other tools and a missing command', () => {
		assert.deepStrictEqual([bash('npm test'), bash('sleep 1'), bash('echo sleepy'), bash(undefined), claudeSleepPollingProblem('Read', { command: 'sleep 5 && ls' }), claudeSleepPollingProblem('Bash', undefined)], [undefined, undefined, undefined, undefined, undefined, undefined]);
	});
});
