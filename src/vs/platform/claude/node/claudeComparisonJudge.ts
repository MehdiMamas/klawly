/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_COMPARISON_JUDGE_SCHEMA, ClaudeComparisonJudgeRequest, ClaudeComparisonJudgeResult, claudeComparisonJudgePrompt, readClaudeComparisonVerdict } from '../common/claudeComparison.js';
import { ClaudeQueryFactory } from './claudeQuery.js';
import { runClaudeStructuredQuery } from './claudeStructuredQuery.js';

/** The judge reads only what the prompt holds: one answer, plus the SDK's structured-output retries. */
const JUDGE_MAX_TURNS = 3;

export interface ClaudeComparisonJudgeRun {
	readonly queryFactory: ClaudeQueryFactory;
	readonly request: ClaudeComparisonJudgeRequest;
	readonly abort: AbortController;
	readonly env: Readonly<Record<string, string>>;
	readonly executablePath?: string;
}

/**
 * The Compare Models judge (issue 424): one structured query with no tools
 * over the task, each run's final message and its diff, answering with a
 * ranking of every run. Never throws.
 */
export async function runClaudeComparisonJudge(run: ClaudeComparisonJudgeRun): Promise<ClaudeComparisonJudgeResult> {
	const runCount = run.request.runs.length;
	const result = await runClaudeStructuredQuery({
		queryFactory: run.queryFactory,
		prompt: claudeComparisonJudgePrompt(run.request),
		cwd: run.request.cwd,
		schema: CLAUDE_COMPARISON_JUDGE_SCHEMA,
		validate: value => readClaudeComparisonVerdict(value, runCount),
		model: run.request.modelId,
		tools: [],
		maxTurns: JUDGE_MAX_TURNS,
		abort: run.abort,
		env: run.env,
		executablePath: run.executablePath,
	});
	if (result.ok) {
		return { ok: true, verdict: result.value };
	}
	switch (result.failure.kind) {
		case 'cancelled':
			return { ok: false, cancelled: true, message: 'The judge was cancelled.' };
		case 'failed':
			return { ok: false, message: result.failure.message };
		case 'malformed':
			return { ok: false, message: result.failure.text ? `The judge did not rank every run: ${result.failure.text}` : 'The judge did not rank every run.' };
	}
}
