/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { GitHubRequestError } from '../../../../platform/github/common/githubTypes.js';

/**
 * Suggest Reviewers without a model turn (issues 508 and 870). The app reads
 * the changed files, CODEOWNERS and recent history from GitHub, and this file
 * turns them into at most three reviewers and a risk note. Same input, same
 * output: every sort ends in the login or path, and "now" is an argument.
 */

/** The GitHub sign-in to use: one that can read private repositories when there is one, otherwise the first. */
export function pickGitHubSession<T extends { readonly scopes: readonly string[] }>(sessions: readonly T[]): T | undefined {
	return sessions.find(session => session.scopes.includes('repo')) ?? sessions[0];
}

/** Whether any of the GitHub sign-ins can read private repositories (the `repo` scope). */
export function hasRepositoryAccess(sessions: readonly { readonly scopes: readonly string[] }[]): boolean {
	return sessions.some(session => session.scopes.includes('repo'));
}

/** GitHub answers 404 (or 401, 403) for a repository the token can't read; a sign-in with more access may help. */
export function isRepositoryAccessError(error: unknown): boolean {
	return error instanceof GitHubRequestError && (error.kind === 'notFound' || error.kind === 'authentication' || error.kind === 'authorization');
}

/** Where an organization's OAuth app access policy lives; only its owners can open it. */
export function orgOAuthPolicyUrl(org: string): string {
	return `https://github.com/organizations/${encodeURIComponent(org)}/settings/oauth_application_policy`;
}

/** What GitHub's docs say about OAuth app access restrictions; any member can read it. */
export const OAUTH_RESTRICTIONS_DOCS_URL = 'https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions';

/**
 * Whether GitHub refused a call because an organization restricts OAuth app access (issue 1519): REST answers 403 and the
 * GraphQL errors (type FORBIDDEN) carry the same sentence. The organization is the one GitHub names in backticks, otherwise
 * the one that was being queried.
 */
export function orgAccessRestriction(error: unknown, queriedOrg: string): { readonly org: string } | undefined {
	if (!(error instanceof GitHubRequestError)) {
		return undefined;
	}
	const text = [error.message, error.responseBody, ...(error.graphQLErrors ?? []).map(graphQLError => graphQLError.message)].filter(part => !!part).join('\n');
	if (!/OAuth App access restrictions/i.test(text)) {
		return undefined;
	}
	return { org: /`(?<org>[\w.-]+)` organization/.exec(text)?.groups?.org ?? queriedOrg };
}

/** Reviewers suggested at most. */
export const MAX_SUGGESTED_REVIEWERS = 3;
/** History is read for this many changed files, the biggest changes first. */
export const HISTORY_FILE_LIMIT = 8;
/** History looks back this far. */
export const HISTORY_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
/** The places GitHub reads CODEOWNERS from, in order; the first that exists wins. */
export const CODEOWNERS_PATHS: readonly string[] = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/** A file the pull request changes. */
export interface ReviewerChangedFile {
	readonly path: string;
	readonly additions: number;
	readonly deletions: number;
}

/** One commit that touched a changed file in the history window. */
export interface ReviewerHistoryCommit {
	readonly path: string;
	/** The GitHub login of the commit's author; commits GitHub cannot map to an account carry none and are ignored. */
	readonly login: string | undefined;
	readonly bot: boolean;
	/** ISO date of the commit. */
	readonly date: string;
}

export interface ReviewerSuggestionInput {
	readonly author: string;
	readonly files: readonly ReviewerChangedFile[];
	/** The text of CODEOWNERS on the base branch, when the repository has one. */
	readonly codeOwners: string | undefined;
	readonly history: readonly ReviewerHistoryCommit[];
	/** People or teams already asked to review; they are not suggested again. */
	readonly alreadyRequested: readonly string[];
	/** Epoch milliseconds the history is measured against. */
	readonly now: number;
}

export type ReviewerRiskLevel = 'low' | 'medium' | 'high';

export type ReviewerRiskFactor = 'size' | 'manyFiles' | 'sensitive' | 'noTests';

export interface ReviewerRisk {
	readonly level: ReviewerRiskLevel;
	readonly factors: readonly ReviewerRiskFactor[];
	/** The kinds of sensitive area touched, such as `workflows`; sorted. */
	readonly areas: readonly string[];
	readonly lines: number;
	readonly files: number;
}

export interface ReviewerSuggestion {
	/** A user's login, or `org/team` for a team. */
	readonly login: string;
	readonly team: boolean;
	/** Changed files CODEOWNERS gives them. */
	readonly ownedFiles: number;
	/** Changed files they committed to in the window. */
	readonly historyFiles: number;
	readonly commits: number;
	/** ISO date of their latest commit to a changed file, if they have history. */
	readonly lastCommit: string | undefined;
}

export interface ReviewerSuggestions {
	readonly reviewers: readonly ReviewerSuggestion[];
	readonly risk: ReviewerRisk;
}

// -- CODEOWNERS ------------------------------------------------------------

interface CodeOwnersRule {
	readonly matcher: RegExp;
	readonly owners: readonly string[];
}

/** One CODEOWNERS pattern as a regular expression over a repository path, as GitHub reads gitignore-style patterns. */
function patternToRegExp(pattern: string): RegExp {
	let source = pattern;
	const anchored = source.startsWith('/') || source.slice(0, -1).includes('/');
	const directory = source.endsWith('/');
	source = source.replace(/^\//, '').replace(/\/$/, '');
	let out = '';
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (char === '*') {
			if (source[i + 1] === '*') {
				// `**/` matches any directories (or none), a trailing `/**` everything below.
				if (source[i + 2] === '/') {
					out += '(?:.*/)?';
					i += 2;
				} else {
					out += '.*';
					i += 1;
				}
			} else {
				out += '[^/]*';
			}
		} else if (char === '?') {
			out += '[^/]';
		} else if (char === '\\' && i + 1 < source.length) {
			out += escapeRegExp(source[++i]);
		} else {
			out += escapeRegExp(char);
		}
	}
	const prefix = anchored ? '^' : '^(?:.*/)?';
	// A directory (or a pattern naming one) owns everything below it; a file pattern owns that file.
	return new RegExp(`${prefix}${out}${directory ? '/.*$' : '(?:/.*)?$'}`);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parses CODEOWNERS text. Comments and blank lines go; an owner that is an email is ignored. */
export function parseCodeOwners(text: string): readonly CodeOwnersRule[] {
	const rules: CodeOwnersRule[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/(^|\s)#.*$/, '').trim();
		if (!line || line.startsWith('[') || line.startsWith('^[')) {
			// Section headers belong to GitLab; GitHub has none.
			continue;
		}
		const parts = line.split(/\s+/);
		const owners = parts.slice(1).filter(owner => owner.startsWith('@') && owner.length > 1).map(owner => owner.slice(1));
		rules.push({ matcher: patternToRegExp(parts[0]), owners });
	}
	return rules;
}

/** The owners of a path: the last matching rule wins, and a rule without owners means nobody owns it. */
export function ownersOf(rules: readonly CodeOwnersRule[], path: string): readonly string[] {
	for (let i = rules.length - 1; i >= 0; i--) {
		if (rules[i].matcher.test(path)) {
			return rules[i].owners;
		}
	}
	return [];
}

// -- Risk ------------------------------------------------------------------

const SENSITIVE_AREAS: readonly { readonly area: string; readonly test: RegExp }[] = [
	{ area: 'workflows', test: /^\.github\/(workflows|actions)\// },
	{ area: 'dependencies', test: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock)$/ },
	{ area: 'security', test: /(^|\/)(security|auth|authentication|credentials?|secrets?|crypto|permissions?|sandbox)([./_-]|\/|$)/i },
	{ area: 'migrations', test: /(^|\/)(migrations?|schema)([./_-]|\/|$)/i },
	{ area: 'build', test: /(^|\/)(build|scripts|release|dockerfile|docker-compose[^/]*|\.gitlab-ci\.yml)([./_-]|\/|$)/i },
];

const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\/|[._-](test|spec)\.[a-z0-9]+$/i;
const DOC_FILE = /(^|\/)(docs?)\/|\.(md|mdx|txt|rst)$/i;

/** Lines changed from which a pull request counts as medium and large. */
const MEDIUM_LINES = 100;
const LARGE_LINES = 400;
const MANY_FILES = 15;

/**
 * Scores a pull request. Size (lines) adds 1 from 100 lines and 2 from 400;
 * 15 or more files add 1; each sensitive area adds 1, at most 2; code changed
 * without any test adds 1. Under 2 points is Low, 2 or 3 Medium, 4 or more High.
 */
export function assessRisk(files: readonly ReviewerChangedFile[]): ReviewerRisk {
	const lines = files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
	const areas = new Set<string>();
	for (const file of files) {
		for (const { area, test } of SENSITIVE_AREAS) {
			if (test.test(file.path)) {
				areas.add(area);
			}
		}
	}
	const code = files.filter(file => !TEST_FILE.test(file.path) && !DOC_FILE.test(file.path));
	const testsChanged = files.some(file => TEST_FILE.test(file.path));
	const factors: ReviewerRiskFactor[] = [];
	let points = 0;
	if (lines >= LARGE_LINES) {
		points += 2;
		factors.push('size');
	} else if (lines >= MEDIUM_LINES) {
		points += 1;
		factors.push('size');
	}
	if (files.length >= MANY_FILES) {
		points += 1;
		factors.push('manyFiles');
	}
	if (areas.size) {
		points += Math.min(areas.size, 2);
		factors.push('sensitive');
	}
	if (code.length && !testsChanged) {
		points += 1;
		factors.push('noTests');
	}
	return { level: points >= 4 ? 'high' : points >= 2 ? 'medium' : 'low', factors, areas: [...areas].sort(), lines, files: files.length };
}

/** The risk as one plain sentence for the card. */
export function describeRisk(risk: ReviewerRisk): string {
	const level = risk.level === 'high' ? localize('claudeRiskHigh', "High risk") : risk.level === 'medium' ? localize('claudeRiskMedium', "Medium risk") : localize('claudeRiskLow', "Low risk");
	const reasons: string[] = [];
	for (const factor of risk.factors) {
		switch (factor) {
			case 'size':
				reasons.push(localize('claudeRiskSize', "{0} lines changed", risk.lines));
				break;
			case 'manyFiles':
				reasons.push(localize('claudeRiskFiles', "{0} files", risk.files));
				break;
			case 'sensitive':
				reasons.push(localize('claudeRiskSensitive', "touches {0}", risk.areas.join(', ')));
				break;
			case 'noTests':
				reasons.push(localize('claudeRiskNoTests', "no tests changed"));
				break;
		}
	}
	return reasons.length
		? localize('claudeRiskWithReasons', "{0}: {1}.", level, reasons.join(', '))
		: localize('claudeRiskSmall', "{0}: {1} lines in {2} files, tests changed with the code.", level, risk.lines, risk.files);
}

// -- Suggestions -----------------------------------------------------------

function isBotLogin(login: string): boolean {
	return /\[bot\]$/i.test(login);
}

/**
 * The reviewers for a pull request: CODEOWNERS owners of its files first, then
 * the people who changed those files most in the last year. The author, bots
 * and anyone already asked are left out. Ties break by files, then commits,
 * then the latest commit, then the login.
 */
export function suggestReviewers(input: ReviewerSuggestionInput): ReviewerSuggestions {
	const excluded = new Set([input.author, ...input.alreadyRequested].map(login => login.toLowerCase()));
	const candidates = new Map<string, { login: string; team: boolean; owned: Set<string>; history: Set<string>; commits: number; last: string | undefined }>();
	const candidate = (login: string) => {
		const key = login.toLowerCase();
		let entry = candidates.get(key);
		if (!entry) {
			entry = { login, team: login.includes('/'), owned: new Set(), history: new Set(), commits: 0, last: undefined };
			candidates.set(key, entry);
		}
		return entry;
	};

	if (input.codeOwners) {
		const rules = parseCodeOwners(input.codeOwners);
		for (const file of input.files) {
			for (const owner of ownersOf(rules, file.path)) {
				if (!excluded.has(owner.toLowerCase()) && !isBotLogin(owner)) {
					candidate(owner).owned.add(file.path);
				}
			}
		}
	}

	const since = input.now - HISTORY_WINDOW_MS;
	for (const commit of input.history) {
		const time = Date.parse(commit.date);
		if (!commit.login || commit.bot || isBotLogin(commit.login) || excluded.has(commit.login.toLowerCase()) || Number.isNaN(time) || time < since || time > input.now) {
			continue;
		}
		const entry = candidate(commit.login);
		entry.history.add(commit.path);
		entry.commits++;
		if (!entry.last || Date.parse(entry.last) < time) {
			entry.last = commit.date;
		}
	}

	const ranked = [...candidates.values()]
		.sort((a, b) =>
			b.owned.size - a.owned.size
			|| b.history.size - a.history.size
			|| b.commits - a.commits
			|| Date.parse(b.last ?? '') - Date.parse(a.last ?? '') || 0
			|| (a.login.toLowerCase() < b.login.toLowerCase() ? -1 : a.login.toLowerCase() > b.login.toLowerCase() ? 1 : 0));
	const reviewers = ranked.slice(0, MAX_SUGGESTED_REVIEWERS).map((entry): ReviewerSuggestion => ({
		login: entry.login,
		team: entry.team,
		ownedFiles: entry.owned.size,
		historyFiles: entry.history.size,
		commits: entry.commits,
		lastCommit: entry.last,
	}));
	return { reviewers, risk: assessRisk(input.files) };
}

/** Why one reviewer was suggested, in plain words. */
export function describeReviewerReason(reviewer: ReviewerSuggestion, changedFiles: number, now: number): string {
	const parts: string[] = [];
	if (reviewer.ownedFiles) {
		parts.push(localize('claudeReviewerOwns', "owns {0} of {1} changed files", reviewer.ownedFiles, changedFiles));
	}
	if (reviewer.historyFiles && reviewer.lastCommit) {
		const days = Math.max(0, Math.floor((now - Date.parse(reviewer.lastCommit)) / 86_400_000));
		parts.push(days < 1
			? localize('claudeReviewerHistoryToday', "changed {0} of them, last today", reviewer.historyFiles)
			: localize('claudeReviewerHistory', "changed {0} of them, last {1} days ago", reviewer.historyFiles, days));
	}
	return parts.join(', ');
}

// -- GitHub REST -----------------------------------------------------------

/** REST paths for one pull request, relative to the API base. */
export function reviewerRestPaths(owner: string, repo: string, number: number) {
	const repository = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
	return {
		pullRequest: `${repository}/pulls/${number}`,
		files: (page: number) => `${repository}/pulls/${number}/files?per_page=100&page=${page}`,
		codeOwners: (path: string, ref: string) => `${repository}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
		history: (path: string, sinceIso: string) => `${repository}/commits?path=${encodeURIComponent(path)}&since=${encodeURIComponent(sinceIso)}&per_page=30`,
		requestedReviewers: `${repository}/pulls/${number}/requested_reviewers`,
	};
}

/** The pull request's author, base branch and who is already asked, from `GET /pulls/N`. */
export function parsePullRequestForReviewers(data: unknown): { readonly author: string; readonly baseRef: string; readonly requested: readonly string[] } | undefined {
	const pr = data as { user?: { login?: unknown }; base?: { ref?: unknown }; requested_reviewers?: { login?: unknown }[]; requested_teams?: { slug?: unknown; organization?: { login?: unknown } }[] } | undefined;
	if (!pr || typeof pr.user?.login !== 'string' || typeof pr.base?.ref !== 'string') {
		return undefined;
	}
	const requested = [
		...(pr.requested_reviewers ?? []).map(user => user.login).filter((login): login is string => typeof login === 'string'),
		...(pr.requested_teams ?? []).map(team => typeof team.slug === 'string' ? (typeof team.organization?.login === 'string' ? `${team.organization.login}/${team.slug}` : team.slug) : undefined).filter((slug): slug is string => !!slug),
	];
	return { author: pr.user.login, baseRef: pr.base.ref, requested };
}

/** The changed files of one page of `GET /pulls/N/files`. */
export function parseChangedFiles(data: unknown): readonly ReviewerChangedFile[] {
	if (!Array.isArray(data)) {
		return [];
	}
	return data.flatMap(item => {
		const file = item as { filename?: unknown; additions?: unknown; deletions?: unknown };
		return typeof file.filename === 'string' ? [{ path: file.filename, additions: Number(file.additions) || 0, deletions: Number(file.deletions) || 0 }] : [];
	});
}

/** The changed files whose history is read: the biggest changes first, then by path. */
export function filesForHistory(files: readonly ReviewerChangedFile[]): readonly string[] {
	return [...files]
		.sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.slice(0, HISTORY_FILE_LIMIT)
		.map(file => file.path);
}

/** The commits of `GET /commits?path=` for one file. */
export function parseHistory(path: string, data: unknown): readonly ReviewerHistoryCommit[] {
	if (!Array.isArray(data)) {
		return [];
	}
	return data.flatMap(item => {
		const commit = item as { author?: { login?: unknown; type?: unknown } | null; commit?: { author?: { date?: unknown } } };
		const date = commit.commit?.author?.date;
		if (typeof date !== 'string') {
			return [];
		}
		const login = typeof commit.author?.login === 'string' ? commit.author.login : undefined;
		return [{ path, login, bot: commit.author?.type === 'Bot', date }];
	});
}

/** The text of a `GET /contents/<path>` answer; undefined when it is not a file. */
export function parseContentsText(data: unknown, decodeBase64: (base64: string) => string): string | undefined {
	const file = data as { type?: unknown; content?: unknown; encoding?: unknown } | undefined;
	if (!file || file.type !== 'file' || typeof file.content !== 'string' || file.encoding !== 'base64') {
		return undefined;
	}
	return decodeBase64(file.content.replace(/\s/g, ''));
}

/** The body of the request that asks for these reviews; teams go by their slug, without the organization. */
export function requestReviewersBody(logins: readonly string[]): { reviewers: string[]; team_reviewers: string[] } {
	return {
		reviewers: logins.filter(login => !login.includes('/')),
		team_reviewers: logins.filter(login => login.includes('/')).map(login => login.slice(login.indexOf('/') + 1)),
	};
}

/**
 * The reviewers or teams that were asked for but are missing from GitHub's answer to the request (issue 1520): GitHub can
 * answer 201 and still drop one, such as a team whose only member is the author. The answer is the pull request, so its
 * requested reviewers and teams say what GitHub kept. An answer that cannot be read drops nothing.
 */
export function missingRequestedReviewers(asked: readonly string[], responseBody: unknown): readonly string[] {
	const pull = parsePullRequestForReviewers(responseBody);
	if (!pull) {
		return [];
	}
	const kept = new Set(pull.requested.map(entry => entry.toLowerCase()));
	return asked.filter(entry => {
		const name = entry.toLowerCase();
		// A team may come back as `org/slug` or, without its organization, as `slug`.
		return !kept.has(name) && !(name.includes('/') && kept.has(name.slice(name.indexOf('/') + 1)));
	});
}
