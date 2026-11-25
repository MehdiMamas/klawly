/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Issue 1376: the review tools Klawly's built-in MCP server offers an agent, so `/review-loop`
 * can read findings, fix them and review again. `get_review_findings` and `mark_addressed` only
 * touch Klawly's own review record; `apply_suggestion` edits a file and `run_review` spends a
 * model run, so both ask like a write does.
 */

import { CLAUDE_KLAWLY_MCP_SERVER } from './claudeTerminalRun.js';
import { ClaudeReviewFinding } from './claudeReviewLoop.js';
import { ClaudePersistedReview } from './claudeReviewPersist.js';

export const CLAUDE_REVIEW_FINDINGS_TOOL = 'get_review_findings';
export const CLAUDE_REVIEW_MARK_TOOL = 'mark_addressed';
export const CLAUDE_REVIEW_APPLY_TOOL = 'apply_suggestion';
export const CLAUDE_REVIEW_RUN_TOOL = 'run_review';

/** The names the permission policy sees. */
export const CLAUDE_REVIEW_FINDINGS_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_REVIEW_FINDINGS_TOOL}`;
export const CLAUDE_REVIEW_MARK_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_REVIEW_MARK_TOOL}`;
export const CLAUDE_REVIEW_APPLY_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_REVIEW_APPLY_TOOL}`;
export const CLAUDE_REVIEW_RUN_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_REVIEW_RUN_TOOL}`;

export const CLAUDE_REVIEW_FINDINGS_DESCRIPTION = 'The findings of the last review of this checkout that are still open, each with an id, file, line, severity, title, body and, when there is one, a suggested replacement. Read-only.';
export const CLAUDE_REVIEW_MARK_DESCRIPTION = 'Marks findings as addressed, by id from get_review_findings. Unknown ids are ignored; the answer says how many changed.';
export const CLAUDE_REVIEW_APPLY_DESCRIPTION = 'Applies the suggested replacement of one open finding (by id from get_review_findings) to its file, replacing exactly the finding\'s lines, and marks it addressed. Fails when the finding has no suggestion or the file no longer has those lines. Prefer fixing by hand when the suggestion needs more than a line swap.';
export const CLAUDE_REVIEW_RUN_DESCRIPTION = 'Runs a review of this checkout against a base branch (default main) and stores the findings, as `klawly review` does. This uses a model run, so call it once per round and only after the changes are done. Quick by default; pass depth deep for a wider pass.';

/** What the tools reach: the stored review of one checkout, its files and a new run. */
export interface ClaudeReviewToolHost {
	readonly read: () => Promise<ClaudePersistedReview | undefined>;
	readonly write: (review: ClaudePersistedReview) => Promise<void>;
	/** The text of a file of the checkout; undefined when it cannot be read or lies outside the checkout. */
	readonly readFile: (file: string) => Promise<string | undefined>;
	/** Writes a file of the checkout; false when it lies outside the checkout. */
	readonly writeFile: (file: string, content: string) => Promise<boolean>;
	/** Reconciles a finished review with the stored one and writes it, so a terminal run and an agent share one review. */
	readonly store: (findings: readonly ClaudeReviewFinding[], diff: string) => Promise<{ readonly open: readonly ClaudeReviewFinding[]; readonly sha: string }>;
	readonly run: (args: { readonly base: string; readonly depth: 'quick' | 'deep' }) => Promise<{ readonly text: string; readonly isError?: boolean }>;
}

/** The text with `finding`'s lines replaced by its suggestion; the reason when it cannot be applied. Pure. */
export function applyClaudeReviewSuggestion(content: string, finding: ClaudeReviewFinding): { readonly ok: true; readonly content: string } | { readonly ok: false; readonly reason: string } {
	if (finding.suggestion === undefined) {
		return { ok: false, reason: 'The finding has no suggestion to apply.' };
	}
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const lines = content.split(/\r?\n/);
	if (!Number.isInteger(finding.startLine) || !Number.isInteger(finding.endLine) || finding.startLine < 1 || finding.endLine < finding.startLine || finding.endLine > lines.length) {
		return { ok: false, reason: `The file no longer has lines ${finding.startLine}-${finding.endLine}.` };
	}
	const replacement = finding.suggestion.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
	lines.splice(finding.startLine - 1, finding.endLine - finding.startLine + 1, ...replacement);
	return { ok: true, content: lines.join(eol) };
}

/** True for a path that stays inside the checkout: relative, with no `..` step. Pure. */
export function isClaudeReviewRelativePath(file: string): boolean {
	return !!file && !/^([a-zA-Z]:|[\/])/.test(file) && !file.split(/[\/]/).includes('..');
}
