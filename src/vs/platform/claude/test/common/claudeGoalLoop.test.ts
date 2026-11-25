/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { addClaudeQueryCost, claudeGoalContinuePrompt, claudeGoalPillOutcome, claudeGoalStartPrompt, claudeGoalVerdictFromReply, claudeLoopPacingFromReply, claudeLoopPrompt, claudeWakeupDelayMs, formatClaudeInterval, parseClaudeGoalLoopCommand } from '../../common/claudeGoalLoop.js';

suite('Claude goals and loops (issue 486)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads /goal and /loop, their checks, intervals and stop words, and leaves other text alone', () => {
		const inputs = [
			'/goal make npm test pass',
			'/goal the login page works --check "pnpm run e2e"',
			'/goal fix the types so `tsc --noEmit` is clean',
			'/goal cargo test passes',
			'/goal all lint warnings are gone',
			'/goal',
			'/goal stop',
			'/loop 10m check the build',
			'/loop every 2 hours summarize new issues',
			'/loop 5s too fast',
			'/loop watch the deploy',
			'/loop 10m',
			'/loop off',
			'/goal ship the release --turns 4 --budget $2.5',
			'/goal --budget=0 tidy up --turns=20 --check "npm test"',
			'/goals are nice',
			'please /goal x',
		];
		assert.deepStrictEqual(inputs.map(parseClaudeGoalLoopCommand), [
			{ kind: 'goal', outcome: 'make npm test pass', check: 'npm test' },
			{ kind: 'goal', outcome: 'the login page works', check: 'pnpm run e2e' },
			{ kind: 'goal', outcome: 'fix the types so `tsc --noEmit` is clean', check: 'tsc --noEmit' },
			{ kind: 'goal', outcome: 'cargo test passes', check: 'cargo test' },
			{ kind: 'goal', outcome: 'all lint warnings are gone' },
			{ kind: 'invalid', message: 'Say what should be true when the goal is done, for example: /goal make npm test pass' },
			{ kind: 'stop', target: 'goal' },
			{ kind: 'loop', prompt: 'check the build', intervalMs: 600_000 },
			{ kind: 'loop', prompt: 'summarize new issues', intervalMs: 7_200_000 },
			{ kind: 'loop', prompt: 'too fast', intervalMs: 60_000 },
			{ kind: 'loop', prompt: 'watch the deploy' },
			{ kind: 'invalid', message: 'Say what to repeat, for example: /loop 10m check the build' },
			{ kind: 'stop', target: 'loop' },
			{ kind: 'goal', outcome: 'ship the release', maxTurns: 4, maxBudgetUsd: 2.5 },
			{ kind: 'goal', outcome: 'tidy up', check: 'npm test', maxTurns: 20, maxBudgetUsd: 0 },
			undefined,
			undefined,
		]);
	});

	test('goal and loop prompts tell Claude how the next turn is decided', () => {
		const checked = { kind: 'goal', outcome: 'make npm test pass', check: 'npm test' } as const;
		const judged = { kind: 'goal', outcome: 'the README explains setup' } as const;
		assert.deepStrictEqual([
			claudeGoalStartPrompt(checked),
			claudeGoalContinuePrompt(checked, { met: false, exitCode: 1, output: '2 failing' }),
			claudeGoalContinuePrompt(judged, { met: false, output: 'the Windows steps' }),
			claudeLoopPrompt({ kind: 'loop', prompt: 'check the build', intervalMs: 600_000 }, 3),
			claudeLoopPrompt({ kind: 'loop', prompt: 'watch the deploy' }, 1),
		], [
			'Work toward this goal until it is done: make npm test pass\n\nAfter each of your turns, Klawly runs `npm test` and sends you another turn until it exits with code 0. Don\'t ask the user whether to go on; keep working until the check passes.',
			'Continue toward the goal: make npm test pass\n\nThe check `npm test` still fails (exit code 1).\nLast output:\n```\n2 failing\n```\n\nAfter each of your turns, Klawly runs `npm test` and sends you another turn until it exits with code 0. Don\'t ask the user whether to go on; keep working until the check passes.',
			'Continue toward the goal: the README explains setup\n\nYou said the goal is not met yet: the Windows steps\n\nAfter each of your turns, Klawly sends you another turn until the goal is met. Check the outcome yourself before you answer, then end your reply with one line: "Goal met" when it is true now, or "Goal not met: <what is left>" when it is not.',
			'check the build\n\nThis prompt repeats in a Klawly loop every 10m (run 3).',
			'watch the deploy\n\nThis prompt repeats in a Klawly loop (run 1). When you finish, pick when to run it again: call ScheduleWakeup with delaySeconds if you have that tool, or end your reply with a line "Next run in: <N> minutes" (1 to 60). End with "Loop done" when there is nothing left to watch.',
		]);
	});

	test('reads verdicts, wake-ups, pacing and spend, and formats the labels', () => {
		assert.deepStrictEqual({
			verdicts: ['Done.\n\n**Goal met**', 'Goal not met: two tests fail', 'I changed a file.'].map(claudeGoalVerdictFromReply),
			wakeups: [{ delaySeconds: 30 }, { delaySeconds: 900 }, { delaySeconds: 7200 }, { delaySeconds: '60' }, undefined].map(claudeWakeupDelayMs),
			pacing: ['All green.\nLoop done.', 'Still deploying.\nNext run in: 5 minutes', 'Next check in 2h', 'nothing'].map(claudeLoopPacingFromReply),
			spend: [
				addClaudeQueryCost({ spentUsd: 0 }, 0.4),
				addClaudeQueryCost({ lastCostUsd: 0.4, spentUsd: 0.4 }, 0.9),
				addClaudeQueryCost({ lastCostUsd: 0.9, spentUsd: 0.9 }, 0.2),
			],
			intervals: [45_000, 600_000, 7_200_000, 5_400_000].map(formatClaudeInterval),
			pills: [claudeGoalPillOutcome('make npm test pass'), claudeGoalPillOutcome('a'.repeat(50)), claudeGoalPillOutcome('first line\nsecond')],
		}, {
			verdicts: [{ met: true }, { met: false, output: 'two tests fail' }, { met: false, output: undefined }],
			wakeups: [60_000, 900_000, 3_600_000, undefined, undefined],
			pacing: [{ done: true }, { done: false, delayMs: 300_000 }, { done: false, delayMs: 3_600_000 }, undefined],
			spend: [{ lastCostUsd: 0.4, spentUsd: 0.4 }, { lastCostUsd: 0.9, spentUsd: 0.9 }, { lastCostUsd: 0.2, spentUsd: 1.1 }],
			intervals: ['45s', '10m', '2h', '1h 30m'],
			pills: ['make npm test pass', `${'a'.repeat(39)}…`, 'first line'],
		});
	});
});
