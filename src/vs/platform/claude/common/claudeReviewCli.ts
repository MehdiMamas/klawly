/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeReviewDepth } from './claudeReviewDepth.js';
import { CLAUDE_REVIEW_SEVERITIES, ClaudeReviewFinding, ClaudeReviewSeverity } from './claudeReviewLoop.js';
import { ClaudePersistedFinding, ClaudePersistedReview } from './claudeReviewPersist.js';

/**
 * Issue 930: `klawly review` from a terminal, a hook or another agent. Everything here is pure: argument parsing, exit
 * codes, the text and JSON output, and what the MCP tools answer from the stored review.
 */

export type ClaudeReviewCliFormat = 'text' | 'json';

/** 0 clean, 1 findings at or above `--fail-on`, 2 wrong usage, 3 the review could not run. */
export const enum ClaudeReviewCliExit {
	Clean = 0,
	Findings = 1,
	Usage = 2,
	Failed = 3,
}

export interface ClaudeReviewCliArgs {
	readonly command: 'review' | 'status';
	readonly base: string;
	readonly depth: ClaudeReviewDepth;
	readonly format: ClaudeReviewCliFormat;
	/** The lowest severity that makes the exit code non-zero. */
	readonly failOn: ClaudeReviewSeverity;
}

export const CLAUDE_REVIEW_CLI_USAGE = 'Usage: klawly review [status] [--base <branch>] [--depth quick|deep] [--json|--text] [--fail-on critical|high|medium|low]';

/** Reads the arguments after `klawly review`. `error` is set for anything unknown; the defaults follow the app. */
export function parseClaudeReviewCliArgs(argv: readonly string[], stdoutIsTerminal = false): ClaudeReviewCliArgs | { readonly error: string } {
	let command: ClaudeReviewCliArgs['command'] = 'review';
	let base = 'main';
	let depth: ClaudeReviewDepth = 'quick';
	let format: ClaudeReviewCliFormat = stdoutIsTerminal ? 'text' : 'json';
	let failOn: ClaudeReviewSeverity = 'high';
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const inline = arg.startsWith('--') ? arg.indexOf('=') : -1;
		const name = inline > 0 ? arg.slice(0, inline) : arg;
		const value = (): string | undefined => inline > 0 ? arg.slice(inline + 1) : argv[++index];
		switch (name) {
			case 'status':
				command = 'status';
				break;
			case '--json':
				format = 'json';
				break;
			case '--text':
				format = 'text';
				break;
			case '--base': {
				const given = value();
				if (!given || !/^\w[\w./-]*$/.test(given)) {
					return { error: '--base needs a branch name' };
				}
				base = given;
				break;
			}
			case '--depth': {
				const given = value();
				if (given !== 'quick' && given !== 'deep') {
					return { error: '--depth is quick or deep' };
				}
				depth = given;
				break;
			}
			case '--fail-on': {
				const given = value();
				const severity = CLAUDE_REVIEW_SEVERITIES.find(known => known === given);
				if (!severity) {
					return { error: '--fail-on is critical, high, medium or low' };
				}
				failOn = severity;
				break;
			}
			default:
				return { error: `Unknown argument ${arg}` };
		}
	}
	return { command, base, depth, format, failOn };
}

/** The findings still to look at. */
export function claudeOpenFindings(review: ClaudePersistedReview | undefined): readonly ClaudePersistedFinding[] {
	return review?.findings.filter(entry => entry.status === 'open') ?? [];
}

/** A stable name for a finding, for `mark_addressed`. */
export function claudeFindingId(finding: ClaudeReviewFinding): string {
	return `${finding.file}:${finding.startLine}:${finding.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
}

/** The exit code for a review: findings at or above `failOn`, questions never count. */
export function claudeReviewCliExitCode(findings: readonly ClaudeReviewFinding[], failOn: ClaudeReviewSeverity): ClaudeReviewCliExit {
	const limit = CLAUDE_REVIEW_SEVERITIES.indexOf(failOn);
	return findings.some(finding => finding.kind !== 'question' && CLAUDE_REVIEW_SEVERITIES.indexOf(finding.severity) <= limit) ? ClaudeReviewCliExit.Findings : ClaudeReviewCliExit.Clean;
}

/** The output of a review or of `review status`: JSON for scripts, plain lines for people. */
export function formatClaudeReviewCliOutput(findings: readonly ClaudeReviewFinding[], format: ClaudeReviewCliFormat, reviewedSha?: string): string {
	if (format === 'json') {
		return JSON.stringify({ reviewedSha: reviewedSha ?? null, count: findings.length, findings: findings.map(finding => ({ id: claudeFindingId(finding), ...finding })) }, undefined, 2);
	}
	if (!findings.length) {
		return 'No findings.';
	}
	return findings.map(finding => `${finding.severity.toUpperCase()} ${finding.file}:${finding.startLine} ${finding.title}\n  ${finding.body.replace(/\s+/g, ' ').trim()}`).join('\n');
}

/** The tools the review MCP server offers. The permission policy asks before `apply_suggestion` (an edit) and `run_review` (a model run). */
export const CLAUDE_REVIEW_MCP_TOOLS: readonly { readonly name: string; readonly description: string }[] = [
	{ name: 'get_review_findings', description: 'The findings of the last review that are still open.' },
	{ name: 'mark_addressed', description: 'Marks findings, by id from get_review_findings, as addressed.' },
	{ name: 'apply_suggestion', description: 'Applies the suggested replacement of one open finding and marks it addressed.' },
	{ name: 'run_review', description: 'Runs a review against a base branch and stores the findings.' },
];

/** What `get_review_findings` answers. Text fields are cut, so a long body cannot flood an agent's context. */
export function claudeReviewMcpFindings(review: ClaudePersistedReview | undefined): { readonly id: string; readonly file: string; readonly line: number; readonly severity: string; readonly title: string; readonly body: string; readonly suggestion?: string }[] {
	return claudeOpenFindings(review).map(({ finding }) => ({ id: claudeFindingId(finding), file: finding.file, line: finding.startLine, severity: finding.severity, title: finding.title.slice(0, 200), body: finding.body.slice(0, 2_000), suggestion: finding.suggestion?.slice(0, 4_000) }));
}

/** `mark_addressed`: the review with those ids addressed. Unknown ids are ignored; the count says how many changed. */
export function claudeReviewMarkAddressed(review: ClaudePersistedReview, ids: readonly unknown[]): { readonly review: ClaudePersistedReview; readonly changed: number } {
	const wanted = new Set(ids.filter((id): id is string => typeof id === 'string'));
	let changed = 0;
	const findings = review.findings.map(entry => {
		if (entry.status === 'open' && wanted.has(claudeFindingId(entry.finding))) {
			changed++;
			return { ...entry, status: 'addressed' as const };
		}
		return entry;
	});
	return { review: { ...review, findings }, changed };
}

/** The most rounds `/review-loop` runs before it stops and says what is left. */
export const CLAUDE_REVIEW_LOOP_MAX_ROUNDS = 5;

/** The body of the bundled `/review-loop` command. */
export function claudeReviewLoopPrompt(maxRounds: number = CLAUDE_REVIEW_LOOP_MAX_ROUNDS): string {
	return [
		`Review this branch, fix what it finds, and review again until it is clean or ${maxRounds} rounds have run.`,
		'1. Before the first edit, tell me the plan and ask me to confirm.',
		'2. Run `klawly review --json --fail-on high`, or call get_review_findings if the review tool is connected.',
		'3. Fix the findings, highest severity first, with the smallest change. Mark each one with mark_addressed when the tool is connected.',
		'4. Run the checks that cover the files you changed, then review again.',
		`5. Stop when the review exits 0, when a round finds nothing new to fix, or after ${maxRounds} rounds. Say which round you stopped at and list what is still open.`,
		'Show each round as: round number, findings found, findings fixed. Never push or merge.',
	].join('\n');
}
