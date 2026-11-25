/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { pathsInDiff } from './claudeBackground.js';
import { claudeFindingFeedback, ClaudeReviewFinding, ClaudeReviewSeverity, formatClaudeReviewFeedback } from './claudeReviewLoop.js';

/**
 * Review after each commit (issue 502): when a commit lands while Klawly is open,
 * a read-only Claude review of that commit runs on its own, and its findings show
 * in the Problems panel on the lines they are about.
 */
export const CLAUDE_REVIEW_AFTER_COMMIT_SETTING = 'claude.git.reviewAfterCommit';

/** Whether Fix All and Fix with Agent send the finding at once instead of leaving it as a draft (issue 960). */
export const CLAUDE_REVIEW_FIX_SENDS_SETTING = 'claude.git.reviewFixSendsAtOnce';

export type ClaudeReviewAfterCommit = 'off' | 'quick' | 'deep';

/** The marker owner of commit review findings; a new review replaces the last one's. */
export const CLAUDE_COMMIT_REVIEW_MARKER_OWNER = 'claude.commitReview';

/** Most diff text one commit review sends; a larger commit is cut and says so. */
export const CLAUDE_COMMIT_REVIEW_MAX_DIFF = 200_000;

/** The project's own review notes, first one found wins. */
export const CLAUDE_REVIEW_NOTES_FILES: readonly string[] = ['REVIEW.md', '.claude/review.md'];

/** Only `quick` and `deep` turn it on. */
export function readClaudeReviewAfterCommit(value: unknown): ClaudeReviewAfterCommit {
	return value === 'quick' || value === 'deep' ? value : 'off';
}

/**
 * The commit a `.git/logs/HEAD` line records: `<old> <new> <who> <time> <zone>\t<action>: <message>`.
 * Only commits count (plain, initial, amend, merge); a checkout, reset or rebase step does not.
 */
export function readClaudeReflogCommit(line: string): { readonly sha: string; readonly message: string } | undefined {
	const match = /^[0-9a-f]{40,64} (?<sha>[0-9a-f]{40,64}) [^\t]*\t(?<action>commit(?: \([a-z]+\))?): ?(?<message>.*)$/.exec(line.trim());
	return match?.groups ? { sha: match.groups.sha, message: match.groups.message } : undefined;
}

/** The last commit a reflog's text records, if its last line is one. */
export function lastClaudeReflogCommit(text: string): { readonly sha: string; readonly message: string } | undefined {
	const lines = text.split(/\r?\n/).filter(line => line.trim());
	return lines.length ? readClaudeReflogCommit(lines[lines.length - 1]) : undefined;
}

/** Marker severity numbers (`MarkerSeverity`): Error 8, Warning 4, Info 2. */
export function claudeFindingMarkerSeverity(severity: ClaudeReviewSeverity): 8 | 4 | 2 {
	return severity === 'critical' || severity === 'high' ? 8 : severity === 'medium' ? 4 : 2;
}

/** The diff a commit review sends, cut to the limit with a note. */
export function claudeCommitReviewDiff(diff: string): string {
	return diff.length > CLAUDE_COMMIT_REVIEW_MAX_DIFF ? `${diff.slice(0, CLAUDE_COMMIT_REVIEW_MAX_DIFF)}\n[The diff is cut here; read the rest with git show.]` : diff;
}

/** The short form of a commit hash that the notices, the status bar and the chat show. */
export function claudeShortSha(sha: string): string {
	return sha.slice(0, 7);
}

/**
 * The text Fix All (and Fix with Agent on one thread) puts in a new chat's
 * composer: which commit the review was about, then every finding as a
 * `path:line` block, the way Send to Agent words them. It is a draft; nothing
 * runs until the user sends it, so the chat's own permission mode applies.
 */
export function claudeCommitFixDraft(sha: string, findings: readonly ClaudeReviewFinding[]): string {
	const items = findings.map((finding, index) => claudeFindingFeedback(finding, String(index)));
	const intro = `Claude reviewed commit ${claudeShortSha(sha)} and left ${items.length === 1 ? 'a finding' : 'findings'} on it.`;
	return formatClaudeReviewFeedback(items).replace(/^I left (?:a review comment|review comments) on your changes\./, intro);
}

/** Drops the files of a unified diff that `isIgnored` says to skip (issue 922). Order and text of the rest are kept. */
export function claudeDiffWithoutIgnored(diff: string, isIgnored: (path: string) => boolean): string {
	return diff.split(/^(?=diff --git )/m).filter(part => {
		const path = pathsInDiff(part.split(/\r?\n/, 1)[0])[0];
		return !path || !isIgnored(path);
	}).join('');
}
