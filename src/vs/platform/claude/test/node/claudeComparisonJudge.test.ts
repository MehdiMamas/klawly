/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { tmpdir } from 'os';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_COMPARISON_JUDGE_SCHEMA, ClaudeComparisonJudgeRequest } from '../../common/claudeComparison.js';
import { runClaudeComparisonJudge } from '../../node/claudeComparisonJudge.js';
import { ClaudeQuery, ClaudeQueryStart } from '../../node/claudeQuery.js';

const REQUEST: ClaudeComparisonJudgeRequest = {
	id: 'judge-1',
	prompt: 'Fix the parser',
	cwd: tmpdir(),
	modelId: 'opus',
	runs: [
		{ run: 1, label: 'Opus, High', diff: 'diff --git a/one.ts b/one.ts', finalMessage: 'Fixed it.' },
		{ run: 2, label: 'Sonnet, Medium', diff: 'diff --git a/two.ts b/two.ts' },
		{ run: 3, label: 'Haiku', diff: '', failure: 'Claude Code stopped this run at its spending limit.' },
	],
};

suite('Claude Compare Models judge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('one tool-less structured query reads every diff and ranks every run, best first', async () => {
		let captured: ClaudeQueryStart | undefined;
		const outcome = await runClaudeComparisonJudge({
			queryFactory: async start => {
				captured = start;
				return scriptedQuery([result({
					subtype: 'success', structured_output: {
						ranking: [
							{ run: 3, score: -2, reasons: 'Stopped early.' },
							{ run: 1, score: 7, reasons: 'Works.' },
							{ run: 2, score: 9, reasons: ' Smallest fix. ' },
						],
						summary: 'Run 2 is best.',
					},
				})]);
			},
			request: REQUEST,
			abort: new AbortController(),
			env: {},
		});
		const options = captured!.options;
		const prompt = String((await captured!.prompt[Symbol.asyncIterator]().next()).value?.message.content);
		assert.deepStrictEqual({
			outcome,
			model: options.model,
			allowedTools: options.allowedTools,
			outputFormat: options.outputFormat,
			readsEveryRun: REQUEST.runs.map(run => prompt.includes(`## Run ${run.run} (${run.label})`) && (!run.diff || prompt.includes(run.diff))),
			failureShown: prompt.includes('The run did not finish: Claude Code stopped this run at its spending limit.'),
			emptyDiff: prompt.includes('(no changes)'),
		}, {
			outcome: {
				ok: true, verdict: {
					ranking: [
						{ run: 2, score: 9, reasons: 'Smallest fix.' },
						{ run: 1, score: 7, reasons: 'Works.' },
						{ run: 3, score: 0, reasons: 'Stopped early.' },
					],
					summary: 'Run 2 is best.',
				},
			},
			model: 'opus',
			allowedTools: [],
			outputFormat: { type: 'json_schema', schema: CLAUDE_COMPARISON_JUDGE_SCHEMA },
			readsEveryRun: [true, true, true],
			failureShown: true,
			emptyDiff: true,
		});
	});

	test('a ranking that leaves a run out, and a failed query, come back as messages, not throws', async () => {
		const malformed = await runClaudeComparisonJudge({
			queryFactory: async () => scriptedQuery([result({ subtype: 'success', structured_output: { ranking: [{ run: 1, score: 5, reasons: 'Only one.' }], summary: 'x' } })]),
			request: REQUEST,
			abort: new AbortController(),
			env: {},
		});
		const failed = await runClaudeComparisonJudge({
			queryFactory: async () => { throw new Error('Claude Code exited.'); },
			request: REQUEST,
			abort: new AbortController(),
			env: {},
		});
		assert.deepStrictEqual({ malformed: malformed.ok, failed }, { malformed: false, failed: { ok: false, message: 'Claude Code exited.' } });
	});
});

function result(fields: Record<string, unknown>): unknown {
	return { type: 'result', is_error: fields.subtype !== 'success', session_id: 'sdk', ...fields };
}

function scriptedQuery(messages: readonly unknown[]): ClaudeQuery {
	return {
		async *[Symbol.asyncIterator]() {
			yield* messages;
		},
		interrupt: async () => undefined,
		setModel: async () => undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => undefined,
	};
}
