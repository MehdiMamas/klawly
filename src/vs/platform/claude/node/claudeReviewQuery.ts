/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Limiter } from '../../../base/common/async.js';
import { CLAUDE_REVIEW_FAN_OUT_CONCURRENCY, ClaudeReviewDepth, mergeClaudeReviewFindings, splitClaudeReviewDiff } from '../common/claudeReviewDepth.js';
import { CLAUDE_REVIEW_FINDINGS_SCHEMA, CLAUDE_REVIEW_TOOLS, ClaudeReviewCategory, ClaudeReviewFinding, claudeReviewPrompt, ClaudeReviewStrictness, ClaudeReviewSummary, ClaudeReviewSummaryMode, readClaudeReviewFindings, readClaudeReviewSummary } from '../common/claudeReviewLoop.js';
import { ClaudeReviewReadiness, readClaudeReviewReadiness } from '../common/claudeReviewReadiness.js';
import { ClaudeReviewDiagramKind } from '../common/claudeReviewDiagram.js';
import { ClaudeReviewTicketRequest, claudeReviewTicketReadOnlyTools } from '../common/claudeReviewTickets.js';
import { ClaudeQueryFactory } from './claudeQuery.js';
import { ClaudeStructuredQueryResult, runClaudeStructuredQuery } from './claudeStructuredQuery.js';

export interface ClaudeReviewQueryRun {
	readonly queryFactory: ClaudeQueryFactory;
	readonly diff: string;
	readonly cwd: string;
	readonly model?: string;
	readonly instructions?: string;
	readonly strictness?: ClaudeReviewStrictness;
	readonly categories?: readonly ClaudeReviewCategory[];
	/** Whether the answer carries a summary (issue 918). */
	readonly summary?: ClaudeReviewSummaryMode;
	/** Forces a diagram of this kind in the summary (issue 919). */
	readonly diagramKind?: ClaudeReviewDiagramKind;
	/** Whether the answer carries a merge-readiness score (issue 920). */
	readonly readiness?: boolean;
	/** Canonical related repository folders, read only (issue 934). */
	readonly relatedRepos?: readonly string[];
	/** Quick or Deep (issue 926); Deep fans out by top-level folder. */
	readonly depth?: ClaudeReviewDepth;
	/** The most turns one pass may take (issue 926). */
	readonly maxTurns?: number;
	/** The ticket check (issue 935); its read-only tracker tools join the allow-list. */
	readonly tickets?: ClaudeReviewTicketRequest;
	readonly abort: AbortController;
	readonly env: Readonly<Record<string, string>>;
	readonly executablePath?: string;
}

type ClaudeReviewQueryResult = ClaudeStructuredQueryResult<readonly ClaudeReviewFinding[]> & { readonly summary?: ClaudeReviewSummary; readonly readiness?: ClaudeReviewReadiness };

/**
 * The structured review pass (issue 431): a read-only query over the diff whose
 * answer is a list of findings. A `malformed` failure keeps Claude's text so the
 * caller can fall back to a chat message.
 *
 * A Deep review of a diff that spans several top-level folders (issue 926) runs one
 * pass over the whole diff, which also carries the summary and readiness, plus one
 * pass per folder, a few at a time, and merges their findings without duplicates.
 */
export async function runClaudeReviewQuery(run: ClaudeReviewQueryRun): Promise<ClaudeReviewQueryResult> {
	const parts = run.depth === 'deep' ? splitClaudeReviewDiff(run.diff) : [run.diff];
	if (parts.length <= 1) {
		return runClaudeReviewPass(run);
	}
	const limiter = new Limiter<ClaudeReviewQueryResult>(CLAUDE_REVIEW_FAN_OUT_CONCURRENCY);
	try {
		const [whole, ...rest] = await Promise.all([
			limiter.queue(() => runClaudeReviewPass(run)),
			...parts.map(diff => limiter.queue(() => runClaudeReviewPass({ ...run, diff, summary: undefined, readiness: undefined, tickets: undefined }))),
		]);
		if (!whole.ok) {
			return whole;
		}
		const value = mergeClaudeReviewFindings([whole.value, ...rest.map(part => part.ok ? part.value : [])]);
		return { ...whole, value };
	} finally {
		limiter.dispose();
	}
}

async function runClaudeReviewPass(run: ClaudeReviewQueryRun): Promise<ClaudeReviewQueryResult> {
	let summary: ClaudeReviewSummary | undefined;
	let readiness: ClaudeReviewReadiness | undefined;
	const outcome = await runClaudeStructuredQuery({
		queryFactory: run.queryFactory,
		prompt: claudeReviewPrompt(run.diff, run.instructions, { strictness: run.strictness, categories: run.categories, relatedRepos: run.relatedRepos, summary: run.summary, diagramKind: run.diagramKind, readiness: run.readiness, depth: run.depth, tickets: run.tickets }),
		cwd: run.cwd,
		schema: CLAUDE_REVIEW_FINDINGS_SCHEMA,
		validate: value => {
			summary = run.summary && run.summary !== 'off' ? readClaudeReviewSummary(value) : undefined;
			const findings = readClaudeReviewFindings(value);
			readiness = run.readiness && findings ? readClaudeReviewReadiness(value, findings) : undefined;
			return findings;
		},
		model: run.model,
		maxTurns: run.maxTurns,
		tools: [...CLAUDE_REVIEW_TOOLS, ...claudeReviewTicketReadOnlyTools(run.tickets)],
		abort: run.abort,
		env: run.env,
		executablePath: run.executablePath,
		additionalDirectories: run.relatedRepos,
	});
	return outcome.ok && (summary || readiness) ? { ...outcome, ...(summary ? { summary } : {}), ...(readiness ? { readiness } : {}) } : outcome;
}
