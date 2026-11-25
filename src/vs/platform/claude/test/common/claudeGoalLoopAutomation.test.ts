/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { parseClaudeCron } from '../../common/claudeAutomation.js';
import { claudeGoalAutomation, claudeGoalLoopAutomationId, claudeIntervalCron, claudeLoopAutomation } from '../../common/claudeGoalLoopAutomation.js';

suite('Claude goal and loop automations (issue 1026)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('an interval becomes a cron expression the scheduler reads', () => {
		const crons = [30_000, 60_000, 5 * 60_000, 10 * 60_000, 3_600_000, 2 * 3_600_000, 48 * 3_600_000].map(claudeIntervalCron);
		assert.deepStrictEqual({ crons, parsed: crons.every(cron => !!parseClaudeCron(cron)) }, {
			crons: ['* * * * *', '* * * * *', '*/5 * * * *', '*/10 * * * *', '0 * * * *', '0 */2 * * *', '0 0 * * *'],
			parsed: true,
		});
	});

	test('a loop is a schedule on its interval, a self-paced one waits ten minutes', () => {
		const timed = claudeLoopAutomation({ kind: 'loop', prompt: 'check the deploy', intervalMs: 300_000 }, 'loop-a');
		const paced = claudeLoopAutomation({ kind: 'loop', prompt: 'check the deploy' }, 'loop-b');
		assert.deepStrictEqual({ trigger: [timed.trigger, paced.trigger], name: timed.name, prompt: timed.prompt, mode: timed.permissionMode, allowed: timed.allowedTools }, {
			trigger: [{ type: 'schedule', cron: '*/5 * * * *' }, { type: 'schedule', cron: '*/10 * * * *' }],
			name: 'Loop: check the deploy',
			prompt: 'check the deploy',
			mode: 'agent',
			allowed: [],
		});
	});

	test('a goal is a manual run within the goal limits, without the chat-only check', () => {
		const automation = claudeGoalAutomation({ kind: 'goal', outcome: 'make npm test pass', check: 'npm test' }, 'goal-a', { maxTurns: 7, maxBudgetUsd: 3 });
		assert.deepStrictEqual({ trigger: automation.trigger, maxTurns: automation.maxTurns, budget: automation.budgetUsd, runsCheck: automation.prompt.includes('`npm test`') }, {
			trigger: { type: 'manual' },
			maxTurns: 7,
			budget: 3,
			runsCheck: false,
		});
	});

	test('ids are safe and names are short', () => {
		const long = claudeLoopAutomation({ kind: 'loop', prompt: 'x'.repeat(200) }, claudeGoalLoopAutomationId('loop', 'a b/c-1'));
		assert.deepStrictEqual({ id: long.id, nameLength: long.name.length }, { id: 'loop-abc-1', nameLength: 66 });
	});
});
