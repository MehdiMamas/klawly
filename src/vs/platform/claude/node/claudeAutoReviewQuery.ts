/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_AUTO_REVIEW_MODEL, CLAUDE_AUTO_REVIEW_SCHEMA, CLAUDE_AUTO_REVIEW_TIMEOUT_MS, ClaudeAutoReviewInstructions, ClaudeAutoReviewRequest, ClaudeAutoReviewToggles, ClaudeAutoReviewVerdict, claudeAutoReviewPrompt, readClaudeAutoReviewVerdict } from '../common/claudeAutoReview.js';
import { ClaudeQueryFactory } from './claudeQuery.js';
import { runClaudeStructuredQuery } from './claudeStructuredQuery.js';

export interface ClaudeAutoReviewRun extends ClaudeAutoReviewRequest {
	readonly queryFactory: ClaudeQueryFactory;
	readonly instructions: ClaudeAutoReviewInstructions;
	readonly toggles?: ClaudeAutoReviewToggles;
	readonly env: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
}

const TIMED_OUT: ClaudeAutoReviewVerdict = { decision: 'ask', reason: 'Auto mode could not check this in time.' };
const NO_ANSWER: ClaudeAutoReviewVerdict = { decision: 'ask', reason: 'Auto mode could not check this.' };

/**
 * The Auto level's classifier (issue 510). The SDK runs Claude Code's own auto
 * mode only as a permission mode that approves without asking the host, which
 * Klawly refuses, so this is a one-turn Haiku query with no tools and a JSON
 * answer. A timeout, failure, cancel or odd answer reads as ask. Never throws.
 */
export async function runClaudeAutoReview(run: ClaudeAutoReviewRun): Promise<ClaudeAutoReviewVerdict> {
	const abort = new AbortController();
	const stop = () => abort.abort();
	run.signal.addEventListener('abort', stop, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<ClaudeAutoReviewVerdict>(resolve => {
		timer = setTimeout(() => {
			abort.abort();
			resolve(TIMED_OUT);
		}, run.timeoutMs ?? CLAUDE_AUTO_REVIEW_TIMEOUT_MS);
	});
	try {
		if (run.signal.aborted) {
			return NO_ANSWER;
		}
		const answer = runClaudeStructuredQuery({
			queryFactory: run.queryFactory,
			prompt: claudeAutoReviewPrompt(run.toolName, run.input, run.cwd, run.instructions, run.toggles),
			cwd: run.cwd,
			schema: CLAUDE_AUTO_REVIEW_SCHEMA,
			validate: readClaudeAutoReviewVerdict,
			model: CLAUDE_AUTO_REVIEW_MODEL,
			tools: [],
			maxTurns: 3,
			abort,
			env: run.env,
			executablePath: run.executablePath,
		}).then(result => result.ok ? result.value : NO_ANSWER, () => NO_ANSWER);
		return await Promise.race([answer, timeout]);
	} finally {
		clearTimeout(timer);
		run.signal.removeEventListener('abort', stop);
		abort.abort();
	}
}
