/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse as parseGlob } from '../../../base/common/glob.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ClaudeReviewFinding, ClaudeReviewSeverity, CLAUDE_REVIEW_SEVERITIES } from './claudeReviewLoop.js';

/**
 * GitHub triggers for automations (issue 518). Klawly has no server, so while
 * it runs the runner window polls the GitHub REST API through the user's own
 * GitHub CLI (`gh api`, run in the shared process) with ETags: an unchanged
 * answer is a `304`, which GitHub does not count against the rate limit.
 * The first answer of a watch is its baseline and starts nothing, so turning
 * an automation on (or restarting Klawly) never replays old events.
 */

/** How often the runner window polls each GitHub automation, in minutes. */
export const CLAUDE_AUTOMATION_GITHUB_POLL_SETTING = 'claude.automations.githubPollMinutes';
export const CLAUDE_AUTOMATION_GITHUB_POLL_DEFAULT_MINUTES = 3;

/** Most events one run carries; the rest wait for the next run. */
export const CLAUDE_AUTOMATION_GITHUB_EVENTS_PER_RUN = 10;

/**
 * A comment with this marker never starts a run. Runs that post on GitHub add
 * it, so a reply that quotes the trigger phrase cannot start the automation
 * again.
 */
export const CLAUDE_AUTOMATION_GITHUB_MARKER = '<!-- klawly-automation -->';

/** What happened to a pull request. */
export type ClaudeGitHubPullRequestAction =
	/** Opened since the watch began. */
	| 'opened'
	/** New commits: the head commit changed. */
	| 'updated'
	/** The trigger's `label` was added. */
	| 'labeled'
	/** A new conversation comment contains the trigger's `comment` text. */
	| 'commented';

export const CLAUDE_GITHUB_PULL_REQUEST_ACTIONS: readonly ClaudeGitHubPullRequestAction[] = ['opened', 'updated', 'labeled', 'commented'];

/**
 * The optional "Only when" filters of a pull request trigger (issue 924). A
 * trigger without them keeps today's behaviour: every pull request that
 * matches `on`, `label` and `base` starts a run.
 */
export interface ClaudeGitHubPullRequestFilters {
	/** Only these authors (case-insensitive logins). */
	readonly authors?: readonly string[];
	/** Never these authors, such as `dependabot[bot]`. */
	readonly excludeAuthors?: readonly string[];
	/** Only head branches matching one of these globs. */
	readonly headBranches?: readonly string[];
	/** Only when the title or description has one of these (case-insensitive). */
	readonly keywords?: readonly string[];
	/** Never when the title or description has one of these, such as `wip`. */
	readonly skipKeywords?: readonly string[];
	/** Skip draft pull requests. */
	readonly skipDrafts?: boolean;
	/** Skip a pull request whose changed files all match these globs. */
	readonly ignorePaths?: readonly string[];
}

/**
 * The GitHub triggers. `repo` is `owner/name` on github.com.
 *
 * `githubPullRequest` is the trigger later automations (a pull request
 * reviewer, security agents) build on: each run gets the
 * {@link ClaudeGitHubPullRequestEvent}s that started it, in its prompt and in
 * `ClaudeAutomationTriggerContext.github`.
 */
export type ClaudeAutomationGitHubTrigger =
	/** An open pull request was opened, got new commits, a label or a matching comment. `base` limits it to one base branch. The optional filters are {@link ClaudeGitHubPullRequestFilters}. */
	| ({ readonly type: 'githubPullRequest'; readonly repo: string; readonly on: readonly ClaudeGitHubPullRequestAction[]; readonly label?: string; readonly comment?: string; readonly base?: string } & ClaudeGitHubPullRequestFilters)
	/** `branch` got new commits. */
	| { readonly type: 'githubPush'; readonly repo: string; readonly branch: string }
	/** A GitHub Actions workflow run failed. `branch` limits it to one branch. */
	| { readonly type: 'githubCheckFailed'; readonly repo: string; readonly branch?: string };

export type ClaudeAutomationGitHubTriggerType = ClaudeAutomationGitHubTrigger['type'];

export const CLAUDE_AUTOMATION_GITHUB_TRIGGER_TYPES: readonly ClaudeAutomationGitHubTriggerType[] = ['githubPullRequest', 'githubPush', 'githubCheckFailed'];

/** True for a GitHub trigger, which the runner window polls. */
export function isClaudeAutomationGitHubTrigger(trigger: { readonly type: string }): trigger is ClaudeAutomationGitHubTrigger {
	return (CLAUDE_AUTOMATION_GITHUB_TRIGGER_TYPES as readonly string[]).includes(trigger.type);
}

/** A pull request event. Fields from GitHub are untrusted text. */
export interface ClaudeGitHubPullRequestEvent {
	readonly kind: 'pullRequest';
	readonly action: ClaudeGitHubPullRequestAction;
	readonly repo: string;
	readonly number: number;
	readonly url: string;
	/** Absent only for a comment on a pull request the watch has not listed (closed, or not among the recent ones). */
	readonly title?: string;
	readonly author?: string;
	readonly baseRef?: string;
	readonly headRef?: string;
	readonly headSha?: string;
	readonly draft?: boolean;
	/** The description, for the keyword filters. */
	readonly body?: string;
	/** The label that was added, for `labeled`. */
	readonly label?: string;
	/** The comment, for `commented`. */
	readonly comment?: { readonly author: string; readonly body: string; readonly url: string };
}

/** New commits on a branch. */
export interface ClaudeGitHubPushEvent {
	readonly kind: 'push';
	readonly repo: string;
	readonly branch: string;
	readonly before: string;
	readonly sha: string;
	readonly url: string;
}

/** A failed GitHub Actions workflow run. */
export interface ClaudeGitHubCheckFailedEvent {
	readonly kind: 'checkFailed';
	readonly repo: string;
	readonly runId: number;
	readonly workflow: string;
	readonly branch: string;
	readonly sha: string;
	readonly url: string;
	/** The pull requests the run belongs to, by number. */
	readonly pullRequests: readonly number[];
}

export type ClaudeGitHubEvent = ClaudeGitHubPullRequestEvent | ClaudeGitHubPushEvent | ClaudeGitHubCheckFailedEvent;

//#region Validation

/** `owner/name` on github.com. */
export function isClaudeGitHubRepo(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(value) && !/\/\.{1,2}$/.test(value);
}

/** A branch name Git allows, without characters that would change an API path or query. */
export function isClaudeGitHubBranch(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(value) && !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/') && !value.includes('..') && !value.includes('//');
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function texts(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const items = [...new Set(value.map(text).filter((item): item is string => item !== undefined))];
	return items.length ? items : undefined;
}

/** Reads the optional pull request filters; a missing or empty one is left out, which means no filtering. */
export function readClaudeGitHubPullRequestFilters(record: Readonly<Record<string, unknown>>): ClaudeGitHubPullRequestFilters {
	const authors = texts(record.authors);
	const excludeAuthors = texts(record.excludeAuthors);
	const headBranches = texts(record.headBranches);
	const keywords = texts(record.keywords);
	const skipKeywords = texts(record.skipKeywords);
	const ignorePaths = texts(record.ignorePaths);
	return {
		...(authors ? { authors } : {}),
		...(excludeAuthors ? { excludeAuthors } : {}),
		...(headBranches ? { headBranches } : {}),
		...(keywords ? { keywords } : {}),
		...(skipKeywords ? { skipKeywords } : {}),
		...(record.skipDrafts === true ? { skipDrafts: true } : {}),
		...(ignorePaths ? { ignorePaths } : {}),
	};
}

/** Reads a GitHub trigger from `automations.json`, or undefined when a field is missing or wrong. */
export function readClaudeAutomationGitHubTrigger(record: Readonly<Record<string, unknown>>): ClaudeAutomationGitHubTrigger | undefined {
	const repo = text(record.repo);
	if (!isClaudeGitHubRepo(repo)) {
		return undefined;
	}
	switch (record.type) {
		case 'githubPullRequest': {
			const on = record.on === undefined ? ['opened'] : record.on;
			if (!Array.isArray(on) || !on.length || !on.every(action => CLAUDE_GITHUB_PULL_REQUEST_ACTIONS.includes(action))) {
				return undefined;
			}
			const label = text(record.label);
			const comment = text(record.comment);
			const base = text(record.base);
			if ((on.includes('labeled') && !label) || (on.includes('commented') && !comment) || (base !== undefined && !isClaudeGitHubBranch(base))) {
				return undefined;
			}
			const actions = [...new Set(on as ClaudeGitHubPullRequestAction[])];
			const filters = readClaudeGitHubPullRequestFilters(record);
			return {
				type: 'githubPullRequest', repo, on: actions,
				...(actions.includes('labeled') ? { label } : {}),
				...(actions.includes('commented') ? { comment } : {}),
				...(base ? { base } : {}),
				...filters,
			};
		}
		case 'githubPush': {
			const branch = text(record.branch);
			return isClaudeGitHubBranch(branch) ? { type: 'githubPush', repo, branch } : undefined;
		}
		case 'githubCheckFailed': {
			const branch = text(record.branch);
			if (branch !== undefined && !isClaudeGitHubBranch(branch)) {
				return undefined;
			}
			return branch ? { type: 'githubCheckFailed', repo, branch } : { type: 'githubCheckFailed', repo };
		}
		default:
			return undefined;
	}
}

//#endregion

//#region The GitHub API through `gh`

/** Shared-process channel for {@link IClaudeGitHubApiService}. */
export const CLAUDE_GITHUB_API_CHANNEL = 'claudeGitHubApi';

export const IClaudeGitHubApiService = createDecorator<IClaudeGitHubApiService>('claudeGitHubApiService');

export interface ClaudeGitHubApiResponse {
	/** The HTTP status, or 0 when `gh` gave no answer (not installed, not signed in, offline). */
	readonly status: number;
	readonly etag?: string;
	/** The parsed JSON of a `200`. */
	readonly body?: unknown;
	/** Why the request failed, for a status that is not 200 or 304. */
	readonly error?: string;
}

/**
 * Read-only GET requests to the GitHub REST API through the user's own
 * `gh api`, with its sign-in. Only `repos/<owner>/<name>/…` paths are allowed.
 */
export interface IClaudeGitHubApiService {
	readonly _serviceBrand: undefined;
	/** `etag` from the last answer makes an unchanged one a `304`. */
	get(endpoint: string, etag?: string): Promise<ClaudeGitHubApiResponse>;
}

/** A `repos/<owner>/<name>/…` API path with a plain query: no scheme, host, spaces or leading `-`. */
export function isClaudeGitHubEndpoint(endpoint: string): boolean {
	return /^repos\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._%/-]*)?(?:\?[A-Za-z0-9._%&=-]*)?$/.test(endpoint) && !endpoint.includes('..');
}

/** The API paths one trigger polls, by name. */
export function claudeGitHubEndpoints(trigger: ClaudeAutomationGitHubTrigger): Readonly<Record<string, string>> {
	const repo = `repos/${trigger.repo}`;
	switch (trigger.type) {
		case 'githubPullRequest': {
			const pulls = `${repo}/pulls?state=open&sort=updated&direction=desc&per_page=50`;
			return trigger.on.includes('commented') ? { pulls, comments: `${repo}/issues/comments?sort=created&direction=desc&per_page=50` } : { pulls };
		}
		case 'githubPush':
			return { branch: `${repo}/branches/${trigger.branch}` };
		case 'githubCheckFailed':
			return { runs: `${repo}/actions/runs?status=failure&per_page=30${trigger.branch ? `&branch=${encodeURIComponent(trigger.branch)}` : ''}` };
	}
}

//#endregion

//#region Filters

function containsAny(haystack: string, needles: readonly string[]): boolean {
	const lower = haystack.toLowerCase();
	return needles.some(needle => lower.includes(needle.toLowerCase()));
}

/** True when every file matches one of the `ignorePaths` globs; no files never counts as ignored. */
export function claudeGitHubFilesAllIgnored(ignorePaths: readonly string[], files: readonly string[]): boolean {
	const matchers = ignorePaths.map(pattern => parseGlob(pattern.replace(/^\/+/, ''), { ignoreCase: true }));
	return files.length > 0 && files.every(file => matchers.some(match => match(file)));
}

/**
 * Whether a pull request event passes the trigger's filters (issue 924).
 * A filter on a field the event does not carry (a comment on a pull request
 * the watch has not listed) does not apply. An explicit comment
 * (`commented`) bypasses the draft and keyword filters: someone asked for it.
 * `changedFiles` is the pull request's file list; without it `ignorePaths`
 * does not apply, so the caller reads it for triggers that have `ignorePaths`.
 */
export function matchesPullRequestFilters(trigger: ClaudeGitHubPullRequestFilters, event: ClaudeGitHubPullRequestEvent, changedFiles?: readonly string[]): boolean {
	const explicit = event.action === 'commented';
	const author = event.author?.toLowerCase();
	if (author !== undefined) {
		if (trigger.authors?.length && !trigger.authors.some(item => item.toLowerCase() === author)) {
			return false;
		}
		if (trigger.excludeAuthors?.some(item => item.toLowerCase() === author)) {
			return false;
		}
	}
	if (event.headRef !== undefined && trigger.headBranches?.length && !trigger.headBranches.some(pattern => parseGlob(pattern, { ignoreCase: true })(event.headRef!))) {
		return false;
	}
	if (!explicit) {
		if (trigger.skipDrafts && event.draft) {
			return false;
		}
		if (event.title !== undefined) {
			const words = `${event.title}\n${event.body ?? ''}`;
			if (trigger.skipKeywords?.length && containsAny(words, trigger.skipKeywords)) {
				return false;
			}
			if (trigger.keywords?.length && !containsAny(words, trigger.keywords)) {
				return false;
			}
		}
	}
	return !(trigger.ignorePaths?.length && changedFiles && claudeGitHubFilesAllIgnored(trigger.ignorePaths, changedFiles));
}

//#endregion

//#region Watching

interface KnownPullRequest {
	readonly title: string;
	readonly author: string;
	readonly url: string;
	readonly baseRef: string;
	readonly headRef: string;
	readonly headSha: string;
	readonly draft: boolean;
	readonly body: string;
	readonly labels: readonly string[];
}

/** What a watch has seen. Absent fields have no baseline yet. */
export interface ClaudeGitHubWatchState {
	/** When the watch began: a pull request created before it is never `opened`. */
	readonly since: number;
	readonly pulls?: Readonly<Record<number, KnownPullRequest>>;
	/** The newest comment id seen. */
	readonly commentId?: number;
	/** The branch's head commit. */
	readonly sha?: string;
	/** The newest failed run id seen. */
	readonly runId?: number;
}

export interface ClaudeGitHubWatchUpdate {
	readonly state: ClaudeGitHubWatchState;
	readonly events: readonly ClaudeGitHubEvent[];
}

type Json = Readonly<Record<string, unknown>>;

function record(value: unknown): Json {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

function str(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function list(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function login(value: unknown): string {
	return str(record(value).login);
}

function readPullRequest(value: unknown): (KnownPullRequest & { readonly number: number; readonly createdAt: number }) | undefined {
	const pull = record(value);
	const number = pull.number;
	if (typeof number !== 'number' || !Number.isSafeInteger(number)) {
		return undefined;
	}
	return {
		number,
		createdAt: Date.parse(str(pull.created_at)) || 0,
		title: str(pull.title),
		author: login(pull.user),
		url: str(pull.html_url),
		baseRef: str(record(pull.base).ref),
		headRef: str(record(pull.head).ref),
		headSha: str(record(pull.head).sha),
		draft: pull.draft === true,
		body: str(pull.body),
		labels: list(pull.labels).map(label => str(record(label).name)).filter(name => name),
	};
}

function pullRequestEvent(repo: string, number: number, pull: KnownPullRequest, action: ClaudeGitHubPullRequestAction): ClaudeGitHubPullRequestEvent {
	return { kind: 'pullRequest', action, repo, number, url: pull.url, title: pull.title, author: pull.author, baseRef: pull.baseRef, headRef: pull.headRef, headSha: pull.headSha, draft: pull.draft, body: pull.body };
}

/**
 * Folds one `200` answer of the endpoint `name` (from
 * {@link claudeGitHubEndpoints}) into the watch and returns the events it
 * holds. The first answer of each endpoint only sets the baseline.
 */
export function claudeGitHubWatchUpdate(trigger: ClaudeAutomationGitHubTrigger, state: ClaudeGitHubWatchState, name: string, body: unknown): ClaudeGitHubWatchUpdate {
	switch (trigger.type) {
		case 'githubPullRequest':
			return name === 'comments' ? watchComments(trigger, state, body) : watchPullRequests(trigger, state, body);
		case 'githubPush': {
			const sha = str(record(record(body).commit).sha);
			if (!sha) {
				return { state, events: [] };
			}
			const events: ClaudeGitHubEvent[] = state.sha !== undefined && state.sha !== sha
				? [{ kind: 'push', repo: trigger.repo, branch: trigger.branch, before: state.sha, sha, url: `https://github.com/${trigger.repo}/compare/${state.sha}...${sha}` }]
				: [];
			return { state: { ...state, sha }, events };
		}
		case 'githubCheckFailed': {
			const runs = list(record(body).workflow_runs).map(record).filter(run => typeof run.id === 'number');
			const newest = Math.max(state.runId ?? 0, ...runs.map(run => run.id as number));
			const events: ClaudeGitHubEvent[] = state.runId === undefined ? [] : runs
				.filter(run => (run.id as number) > state.runId! && run.conclusion === 'failure')
				.sort((a, b) => (a.id as number) - (b.id as number))
				.map(run => ({
					kind: 'checkFailed',
					repo: trigger.repo,
					runId: run.id as number,
					workflow: str(run.name),
					branch: str(run.head_branch),
					sha: str(run.head_sha),
					url: str(run.html_url),
					pullRequests: list(run.pull_requests).map(pull => record(pull).number).filter((number): number is number => typeof number === 'number'),
				}));
			return { state: { ...state, runId: newest }, events };
		}
	}
}

function watchPullRequests(trigger: Extract<ClaudeAutomationGitHubTrigger, { type: 'githubPullRequest' }>, state: ClaudeGitHubWatchState, body: unknown): ClaudeGitHubWatchUpdate {
	const pulls: Record<number, KnownPullRequest> = {};
	const events: ClaudeGitHubEvent[] = [];
	for (const item of list(body)) {
		const pull = readPullRequest(item);
		if (!pull) {
			continue;
		}
		const { number, createdAt, ...known } = pull;
		pulls[number] = known;
		if (!state.pulls || (trigger.base !== undefined && known.baseRef !== trigger.base)) {
			continue;
		}
		const before = state.pulls[number];
		// One event per pull request and answer, the first that applies.
		let action: ClaudeGitHubPullRequestAction | undefined;
		if (!before) {
			if (createdAt >= state.since && trigger.on.includes('opened')) {
				action = 'opened';
			} else if (createdAt >= state.since && trigger.on.includes('labeled') && known.labels.includes(trigger.label!)) {
				action = 'labeled';
			}
		} else if (trigger.on.includes('labeled') && known.labels.includes(trigger.label!) && !before.labels.includes(trigger.label!)) {
			action = 'labeled';
		} else if (trigger.on.includes('updated') && before.headSha && known.headSha && before.headSha !== known.headSha) {
			action = 'updated';
		}
		if (action) {
			const event = pullRequestEvent(trigger.repo, number, known, action);
			const full = action === 'labeled' ? { ...event, label: trigger.label } : event;
			if (matchesPullRequestFilters(trigger, full)) {
				events.push(full);
			}
		}
	}
	events.reverse(); // Oldest change first: GitHub lists the most recently updated first.
	return { state: { ...state, pulls }, events };
}

function watchComments(trigger: Extract<ClaudeAutomationGitHubTrigger, { type: 'githubPullRequest' }>, state: ClaudeGitHubWatchState, body: unknown): ClaudeGitHubWatchUpdate {
	const comments = list(body).map(record).filter(comment => typeof comment.id === 'number');
	const newest = Math.max(state.commentId ?? 0, ...comments.map(comment => comment.id as number));
	if (state.commentId === undefined) {
		return { state: { ...state, commentId: newest }, events: [] };
	}
	const phrase = trigger.comment!.toLowerCase();
	const events: ClaudeGitHubEvent[] = [];
	for (const comment of comments.sort((a, b) => (a.id as number) - (b.id as number))) {
		const said = str(comment.body);
		const url = str(comment.html_url);
		const number = Number(/\/pull\/(?<number>\d+)/.exec(url)?.groups?.number);
		if ((comment.id as number) <= state.commentId || !Number.isSafeInteger(number) || record(comment.user).type === 'Bot'
			|| said.includes(CLAUDE_AUTOMATION_GITHUB_MARKER) || !said.toLowerCase().includes(phrase)) {
			continue;
		}
		const known = state.pulls?.[number];
		if (trigger.base !== undefined && known && known.baseRef !== trigger.base) {
			continue;
		}
		const event: ClaudeGitHubPullRequestEvent = known
			? pullRequestEvent(trigger.repo, number, known, 'commented')
			: { kind: 'pullRequest', action: 'commented', repo: trigger.repo, number, url: `https://github.com/${trigger.repo}/pull/${number}` };
		const withComment = { ...event, comment: { author: login(comment.user), body: said, url } };
		if (matchesPullRequestFilters(trigger, withComment)) {
			events.push(withComment);
		}
	}
	return { state: { ...state, commentId: newest }, events };
}

//#endregion

/** The events as the run's prompt carries them: one block each, plain text. */
export function claudeGitHubEventDetails(events: readonly ClaudeGitHubEvent[]): string {
	return events.map(event => {
		switch (event.kind) {
			case 'pullRequest': {
				const lines = [`Pull request ${event.action}: ${event.repo}#${event.number}${event.title ? ` "${event.title}"` : ''}`, `URL: ${event.url}`];
				if (event.author) {
					lines.push(`Author: ${event.author}${event.draft ? ' (draft)' : ''}`);
				}
				if (event.headRef) {
					lines.push(`Branch: ${event.headRef} (${event.headSha}) into ${event.baseRef}`);
				}
				if (event.label) {
					lines.push(`Label added: ${event.label}`);
				}
				if (event.comment) {
					lines.push(`Comment by ${event.comment.author}: ${event.comment.url}`, event.comment.body);
				}
				return lines.join('\n');
			}
			case 'push':
				return [`Push to ${event.repo} ${event.branch}: ${event.before}..${event.sha}`, `Compare: ${event.url}`].join('\n');
			case 'checkFailed':
				return [
					`Workflow run failed: ${event.workflow} on ${event.repo} ${event.branch} (${event.sha})`,
					`URL: ${event.url}`,
					...(event.pullRequests.length ? [`Pull requests: ${event.pullRequests.map(number => `#${number}`).join(', ')}`] : []),
				].join('\n');
		}
	}).join('\n\n');
}

/** Off by default: the PR bot sets a "Klawly review" commit status (issue 928). */
export const CLAUDE_REVIEW_POST_STATUS_SETTING = 'claude.review.postStatus';

/** The commit status context the review writes; branch protection can require it. */
export const CLAUDE_REVIEW_STATUS_CONTEXT = 'Klawly review';

/** The GitHub commit status states the review uses. */
export type ClaudeReviewStatusState = 'pending' | 'success' | 'failure' | 'error';

export interface ClaudeReviewStatus {
	readonly state: ClaudeReviewStatusState;
	/** At most 140 characters, the limit GitHub puts on a status description. */
	readonly description: string;
}

/**
 * The status of a finished review: success when nothing is at or above the
 * threshold (the lowest severity setting of issue 921), failure with a short
 * count otherwise. Pure.
 */
export function claudeReviewStatusDescription(findings: readonly ClaudeReviewFinding[], threshold: ClaudeReviewSeverity): ClaudeReviewStatus {
	const limit = CLAUDE_REVIEW_SEVERITIES.indexOf(threshold);
	const counts = CLAUDE_REVIEW_SEVERITIES.map(severity => ({ severity, count: findings.filter(finding => finding.severity === severity).length }));
	const blocking = counts.filter(entry => CLAUDE_REVIEW_SEVERITIES.indexOf(entry.severity) <= limit && entry.count > 0);
	if (!blocking.length) {
		return { state: 'success', description: `No findings at or above ${threshold}` };
	}
	const total = blocking.reduce((sum, entry) => sum + entry.count, 0);
	const parts = blocking.map(entry => `${entry.count} ${entry.severity}`).join(', ');
	return { state: 'failure', description: `${total} finding${total === 1 ? '' : 's'} at or above ${threshold}: ${parts}`.slice(0, 140) };
}

/** The status of a run that is still going, or that failed before it could report. */
export function claudeReviewRunStatus(state: 'pending' | 'error'): ClaudeReviewStatus {
	return state === 'pending'
		? { state, description: 'Klawly is reviewing this change' }
		: { state, description: 'The Klawly review did not finish' };
}

/** The one GitHub CLI call the review may make for a status, allowed only with the setting on. */
export const CLAUDE_REVIEW_STATUS_ALLOWED_TOOL = 'Bash(gh api repos/*/*/statuses/*:*)';

/** The two GitHub CLI calls that react (eyes while reviewing, then a check) to the pull request or the comment that asked, allowed only with the setting on. */
export const CLAUDE_REVIEW_REACTION_ALLOWED_TOOLS = ['Bash(gh api repos/*/*/issues/*/reactions:*)', 'Bash(gh api repos/*/*/issues/comments/*/reactions:*)'];
