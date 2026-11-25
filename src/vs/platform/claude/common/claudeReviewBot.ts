/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { claudeReviewedShaMarker } from './claudeReviewPersist.js';
import { claudeLineReference, ClaudeReviewExportOptions, ClaudeReviewFilter, ClaudeReviewFinding, compareClaudeReviewFindings, filterClaudeReviewFindings, formatClaudeReviewSummary, normalizeClaudeFindingPath } from './claudeReviewLoop.js';
import { claudeReviewDepthPromptLines } from './claudeReviewDepth.js';

/**
 * The review bot (issue 872): the pure parts. Posting goes through the person's own GitHub
 * sign-in after they confirm the comments (claudeReviewBotService); nothing here talks to GitHub.
 */

/** One inline comment of a GitHub pull request review. */
export interface ClaudeGitHubReviewComment {
	readonly path: string;
	readonly line: number;
	readonly side: 'RIGHT';
	readonly start_line?: number;
	readonly start_side?: 'RIGHT';
	readonly body: string;
}

/** The body of `POST /repos/{owner}/{repo}/pulls/{number}/reviews`. */
export interface ClaudeGitHubReview {
	readonly body: string;
	readonly event: 'COMMENT';
	readonly comments: readonly ClaudeGitHubReviewComment[];
}

/** A suggestion block replaces exactly the commented lines, so its fence must be longer than any inside it. */
function suggestionBlock(suggestion: string): string {
	const text = suggestion.replace(/\r\n/g, '\n').replace(/\n+$/, '');
	let fence = '```';
	while (text.includes(fence)) {
		fence += '`';
	}
	return `${fence}suggestion\n${text}\n${fence}`;
}

/**
 * The review as GitHub takes it: the summary and score as the top comment and one inline comment
 * per finding that passes the filter, with a suggestion block when the finding has a fix. Pure.
 */
export function formatClaudeGitHubReview(findings: readonly ClaudeReviewFinding[], filter: ClaudeReviewFilter, options: ClaudeReviewExportOptions = {}): ClaudeGitHubReview {
	const shown = [...filterClaudeReviewFindings(findings, filter)].sort(compareClaudeReviewFindings);
	const top = ['## Klawly Review'];
	if (options.readinessScore !== undefined) {
		top.push('', `Readiness: ${options.readinessScore}/100`);
	}
	if (options.summary) {
		top.push('', formatClaudeReviewSummary(options.summary));
	}
	top.push('', shown.length ? `${shown.length} finding${shown.length === 1 ? '' : 's'}, inline below.` : 'No findings.');
	if (options.commitSha) {
		// Issue 927: the next review of this pull request starts from here.
		top.push('', `Reviewed up to ${options.commitSha.slice(0, 7)}.`, claudeReviewedShaMarker(options.commitSha));
	}
	const comments = shown.map((finding): ClaudeGitHubReviewComment => {
		const label = finding.kind === 'question' ? 'Question' : finding.severity.toUpperCase();
		const parts = [`**${label}: ${finding.title}** · ${finding.category}`, '', finding.body];
		if (finding.suggestion) {
			parts.push('', suggestionBlock(finding.suggestion));
		}
		const multi = finding.endLine > finding.startLine;
		return {
			path: normalizeClaudeFindingPath(finding.file),
			line: multi ? finding.endLine : finding.startLine,
			side: 'RIGHT',
			...(multi ? { start_line: finding.startLine, start_side: 'RIGHT' as const } : {}),
			body: parts.join('\n'),
		};
	});
	return { body: top.join('\n') + '\n', event: 'COMMENT', comments };
}

/** The most lines of one comment body the confirm dialog shows before it cuts the body short. */
const CONFIRM_BODY_LINES = 6;

/**
 * What the confirm dialog lists before anything is posted: the top comment, then every inline comment
 * as `path:line` with its body, exactly as GitHub will get it, cut short only after a few lines. Pure.
 */
export function claudeReviewConfirmDetail(review: ClaudeGitHubReview): string {
	const clip = (body: string) => {
		const lines = body.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
		return lines.length > CONFIRM_BODY_LINES ? [...lines.slice(0, CONFIRM_BODY_LINES), '…'] : lines;
	};
	const parts = [...clip(review.body)];
	for (const comment of review.comments) {
		const where = comment.start_line !== undefined ? `${comment.path}:${comment.start_line}-${comment.line}` : `${comment.path}:${comment.line}`;
		parts.push('', `${where}`, ...clip(comment.body).map(line => `  ${line}`));
	}
	return parts.join('\n');
}

/** The pull request a fix runs against: its repository, number and head branch. */
export interface ClaudeFixTarget {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	/** The pull request's head branch, when the details service has it. */
	readonly headRef?: string;
}

/**
 * The prompt for Fix on PR Branch (issue 872). The agent runs in a new worktree, so it first puts the worktree
 * on the pull request's head branch, fixes only this finding and commits locally; it never pushes. Pure.
 */
export function claudeFixOnBranchPrompt(finding: ClaudeReviewFinding, target: ClaudeFixTarget): string {
	const where = claudeLineReference(finding.file, finding.startLine, finding.endLine);
	const branch = target.headRef && /^[\w./-]+$/.test(target.headRef)
		? `Put this worktree on the head branch \`${target.headRef}\` of pull request ${target.owner}/${target.repo}#${target.number}: fetch it from origin and check it out (\`git fetch origin ${target.headRef}\` then \`git checkout -B ${target.headRef} FETCH_HEAD\`).`
		: `Put this worktree on the head branch of pull request ${target.owner}/${target.repo}#${target.number}: run \`gh pr checkout ${target.number}\`.`;
	const lines = [
		`Fix one review finding on pull request ${target.owner}/${target.repo}#${target.number}.`,
		branch,
		'',
		`Finding (${finding.severity}, ${finding.category}) at ${where}: ${finding.title}`,
		finding.body,
	];
	if (finding.suggestion) {
		lines.push('', 'Suggested change:', suggestionBlock(finding.suggestion).replace(/^(`+)suggestion/, '$1'));
	}
	lines.push('', 'Change only what this finding needs, run the tests next to the file, then commit on that branch. Do not push: ask me first.');
	return lines.join('\n');
}

/** The rules of every `@klawly remember <rule>` among pull request comments, in order and once each. Pure. */
export function claudeRememberRules(comments: readonly string[]): readonly string[] {
	const rules: string[] = [];
	const seen = new Set<string>();
	for (const comment of comments) {
		const mention = parseClaudeReviewMention(comment);
		if (mention?.kind !== 'remember') {
			continue;
		}
		const key = mention.rule.replace(/\s+/g, ' ').toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			rules.push(mention.rule);
		}
	}
	return rules;
}

/** What an `@klawly` comment asked for. */
export type ClaudeReviewMention =
	| { readonly kind: 'review'; readonly depth?: 'quick' | 'deep'; readonly question?: string }
	| { readonly kind: 'remember'; readonly rule: string };

/**
 * Reads a pull request comment for `@klawly review [quick|deep|<question>]` or `@klawly remember <rule>` (issue 872).
 * Returns undefined when the comment does not mention the bot. Pure.
 */
export function parseClaudeReviewMention(comment: string): ClaudeReviewMention | undefined {
	const match = /(?:^|\s)@klawly\s+(review|remember)\b[ \t]*([^\r\n]*)/i.exec(comment);
	if (!match) {
		return undefined;
	}
	const rest = match[2].trim();
	if (match[1].toLowerCase() === 'remember') {
		return rest ? { kind: 'remember', rule: rest } : undefined;
	}
	const word = rest.toLowerCase().replace(/[.!]+$/, '');
	if (word === 'quick' || word === 'deep') {
		return { kind: 'review', depth: word };
	}
	return rest ? { kind: 'review', question: rest } : { kind: 'review' };
}

/** The line a review prompt gets for a mention: the depth, or the question as an extra focus. Empty for a plain review. Pure. */
export function claudeMentionPromptLines(mention: ClaudeReviewMention | undefined): readonly string[] {
	if (!mention || mention.kind !== 'review') {
		return [];
	}
	if (mention.depth) {
		return claudeReviewDepthPromptLines(mention.depth);
	}
	return mention.question ? [`Focus on this question as well: ${mention.question}`] : [];
}

/**
 * REVIEW.md with a rule added as a bullet (issue 872). The rule is one line of plain text, and one already there
 * (same words, any case) is not added twice. The caller writes it as a local edit and never commits it. Pure.
 */
export function appendClaudeReviewRule(current: string | undefined, rule: string): { readonly text: string; readonly added: boolean } {
	const line = rule.replace(/\s+/g, ' ').trim().replace(/^[-*]\s+/, '');
	const base = current ?? '';
	if (!line) {
		return { text: base, added: false };
	}
	const exists = base.split(/\r?\n/).some(existing => existing.replace(/^\s*[-*]\s+/, '').trim().toLowerCase() === line.toLowerCase());
	if (exists) {
		return { text: base, added: false };
	}
	const head = base.length ? base.replace(/\s+$/, '') + '\n' : '# Review rules\n\n';
	return { text: `${head}- ${line}\n`, added: true };
}

/** A pull request link on github.com: owner, repository and number. The rest of the URL (`/files`, a fragment) is ignored. */
const PULL_REQUEST_URL = /^\s*https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9]\d{0,9})(?![\w])/;

/** The pull request a link the person typed names, or undefined. Shape only: no network call. Pure. */
export function parseClaudePullRequestUrl(text: string): { readonly owner: string; readonly repo: string; readonly number: number; readonly url: string } | undefined {
	const match = PULL_REQUEST_URL.exec(text);
	const repo = match?.[2].replace(/\.git$/, '');
	if (!match || !repo || repo === '.' || repo === '..') {
		return undefined;
	}
	const number = Number(match[3]);
	return { owner: match[1], repo, number, url: `https://github.com/${match[1]}/${repo}/pull/${number}` };
}
