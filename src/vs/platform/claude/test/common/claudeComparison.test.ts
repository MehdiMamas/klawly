/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { applyClaudeComparisonEvent, CLAUDE_COMPARE_JUDGE_DIFF_LIMIT, claudeComparisonJudgePrompt, claudeComparisonRunsProblem, claudeComparisonTaskId, isClaudeComparisonSettled, readClaudeCompareBudget, readClaudeComparisons, readClaudeComparisonVerdict, serializeClaudeComparisons } from '../../common/claudeComparison.js';
import { isBackgroundTaskId } from '../../common/claudeBackground.js';

suite('Claude Compare Models helpers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('run lists, budgets, task ids and verdicts are checked', () => {
		const opus = { modelId: 'opus', effort: 'high' as const, label: 'Opus, High' };
		assert.deepStrictEqual({
			one: claudeComparisonRunsProblem([opus]),
			five: claudeComparisonRunsProblem([1, 2, 3, 4, 5].map(n => ({ modelId: `m${n}`, label: `M${n}` }))),
			duplicate: claudeComparisonRunsProblem([opus, { ...opus, label: 'Again' }]),
			otherEffort: claudeComparisonRunsProblem([opus, { ...opus, effort: 'low' }]),
			budgets: [readClaudeCompareBudget(0.5), readClaudeCompareBudget(0), readClaudeCompareBudget('3'), readClaudeCompareBudget(undefined)],
			taskId: claudeComparisonTaskId('ab12cd34', 2),
			taskIdIsSafe: isBackgroundTaskId(claudeComparisonTaskId('ab12cd34', 2)),
			unsafeIds: ['../x', 'a..b', 'x.lock', '-x', ''].map(isBackgroundTaskId),
			missingRun: readClaudeComparisonVerdict({ ranking: [{ run: 1, score: 1, reasons: '' }], summary: '' }, 2),
			twice: readClaudeComparisonVerdict({ ranking: [{ run: 1, score: 1, reasons: '' }, { run: 1, score: 2, reasons: '' }], summary: '' }, 2),
			unknownRun: readClaudeComparisonVerdict({ ranking: [{ run: 1, score: 1, reasons: '' }, { run: 3, score: 2, reasons: '' }], summary: '' }, 2),
			clamped: readClaudeComparisonVerdict({ ranking: [{ run: 1, score: 14, reasons: 'a' }, { run: 2, score: 3, reasons: 'b' }], summary: ' s ' }, 2),
		}, {
			one: 'count',
			five: 'count',
			duplicate: 'duplicate',
			otherEffort: undefined,
			budgets: [0.5, 2, 2, 2],
			taskId: 'compare-ab12cd34-2',
			taskIdIsSafe: true,
			unsafeIds: [false, false, false, false, false],
			missingRun: undefined,
			twice: undefined,
			unknownRun: undefined,
			clamped: { ranking: [{ run: 1, score: 10, reasons: 'a' }, { run: 2, score: 3, reasons: 'b' }], summary: 's' },
		});
	});

	test('events fold into the view, and a run is settled once nothing is running', () => {
		let view = applyClaudeComparisonEvent(undefined, { type: 'comparison.started', comparisonId: 'c', prompt: 'Go', runs: [{ modelId: 'opus', label: 'Opus' }, { modelId: 'sonnet', label: 'Sonnet' }] });
		const settled: boolean[] = [isClaudeComparisonSettled(view!)];
		view = applyClaudeComparisonEvent(view, { type: 'comparison.runUpdated', comparisonId: 'c', run: 1, state: 'failed', sessionId: 's1', message: 'Out of budget.' });
		view = applyClaudeComparisonEvent(view, { type: 'comparison.runUpdated', comparisonId: 'other', run: 2, state: 'complete' });
		view = applyClaudeComparisonEvent(view, { type: 'comparison.runUpdated', comparisonId: 'c', run: 9, state: 'complete' });
		settled.push(isClaudeComparisonSettled(view!));
		view = applyClaudeComparisonEvent(view, { type: 'comparison.runUpdated', comparisonId: 'c', run: 2, state: 'complete', sessionId: 's2', diffStat: { filesChanged: 1, added: 2, removed: 3 } });
		settled.push(isClaudeComparisonSettled(view!));
		view = applyClaudeComparisonEvent(view, { type: 'comparison.judgeFailed', comparisonId: 'c', message: 'No answer.' });
		assert.deepStrictEqual({ settled, view }, {
			settled: [false, false, true],
			view: {
				id: 'c',
				prompt: 'Go',
				runs: [
					{ modelId: 'opus', label: 'Opus', run: 1, state: 'failed', sessionId: 's1', diffStat: undefined, message: 'Out of budget.', costUsd: undefined, durationMs: undefined },
					{ modelId: 'sonnet', label: 'Sonnet', run: 2, state: 'complete', sessionId: 's2', diffStat: { filesChanged: 1, added: 2, removed: 3 }, message: undefined, costUsd: undefined, durationMs: undefined },
				],
				judgeError: 'No answer.',
			},
		});
	});

	test('the judge prompt cuts a long diff', () => {
		const prompt = claudeComparisonJudgePrompt({ prompt: 'Go', runs: [{ run: 1, label: 'Opus', diff: 'x'.repeat(CLAUDE_COMPARE_JUDGE_DIFF_LIMIT + 10) }] });
		assert.deepStrictEqual({
			cut: prompt.includes(`(The diff is ${CLAUDE_COMPARE_JUDGE_DIFF_LIMIT + 10} characters; the rest is cut.)`),
			kept: prompt.includes('x'.repeat(CLAUDE_COMPARE_JUDGE_DIFF_LIMIT + 1)),
		}, { cut: true, kept: false });
	});

	test('stored comparisons round-trip; a run cut off by a closed window reads as failed; bad entries drop', () => {
		const started = applyClaudeComparisonEvent(undefined, { type: 'comparison.started', comparisonId: 'c1', prompt: 'Fix it', runs: [{ modelId: 'opus', effort: 'high', label: 'Opus, High' }, { modelId: 'sonnet', label: 'Sonnet' }] })!;
		const done = applyClaudeComparisonEvent(started, { type: 'comparison.runUpdated', comparisonId: 'c1', run: 1, state: 'complete', sessionId: 's1', diffStat: { filesChanged: 1, added: 3, removed: 1 }, costUsd: 0.25, durationMs: 4000 })!;
		const running = applyClaudeComparisonEvent(done, { type: 'comparison.runUpdated', comparisonId: 'c1', run: 2, state: 'running', sessionId: 's2' })!;
		const text = serializeClaudeComparisons([{ view: running, createdAt: 1, updatedAt: 2 }]);
		const withJunk = JSON.stringify({ version: 1, comparisons: [...JSON.parse(text).comparisons, { view: { id: 7 }, createdAt: 1, updatedAt: 1 }, 'junk'] });
		assert.deepStrictEqual({
			read: readClaudeComparisons(withJunk, 'Klawly closed first.'),
			broken: readClaudeComparisons('{', 'x'),
			empty: readClaudeComparisons(undefined, 'x'),
		}, {
			read: [{
				view: {
					id: 'c1',
					prompt: 'Fix it',
					runs: [
						{ run: 1, modelId: 'opus', effort: 'high', label: 'Opus, High', state: 'complete', sessionId: 's1', diffStat: { filesChanged: 1, added: 3, removed: 1 }, message: undefined, costUsd: 0.25, durationMs: 4000 },
						{ run: 2, modelId: 'sonnet', effort: undefined, label: 'Sonnet', state: 'failed', sessionId: 's2', diffStat: undefined, message: 'Klawly closed first.', costUsd: undefined, durationMs: undefined },
					],
					verdict: undefined,
					judgeError: undefined,
				},
				createdAt: 1,
				updatedAt: 2,
			}],
			broken: [],
			empty: [],
		});
	});
});
