/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ClaudeGitHubReference } from '../../../../platform/claude/common/claudeProtocol.js';

/** What a pull request or issue card and the pull request pill say (issue 430). */
export interface GitHubReferenceLabels {
	/** `owner/repo`. */
	readonly repository: string;
	/** `#431`. */
	readonly number: string;
	/** "Pull request" or "Issue", with "opened in this chat" when the session created it. */
	readonly kind: string;
	/** The URL without its scheme, which is all the card knows until GitHub answers. */
	readonly location: string;
	readonly ariaLabel: string;
}

/** The labels of a card that knows only the URL: the repository, the number and the kind. */
export function describeGitHubReference(reference: ClaudeGitHubReference): GitHubReferenceLabels {
	const repository = `${reference.owner}/${reference.repo}`;
	const number = `#${reference.number}`;
	const kind = reference.kind === 'pullRequest'
		? (reference.createdBySession ? localize('claudeGitHubPullRequestCreated', "Pull request opened in this chat") : localize('claudeGitHubPullRequest', "Pull request"))
		: (reference.createdBySession ? localize('claudeGitHubIssueCreated', "Issue opened in this chat") : localize('claudeGitHubIssue', "Issue"));
	return {
		repository,
		number,
		kind,
		location: reference.url.replace(/^https:\/\//, ''),
		ariaLabel: localize('claudeGitHubCardLabel', "{0} {1} in {2}. Open on GitHub", kind, number, repository),
	};
}

/** The checks of a pull request's head commit, summed up. */
export type ClaudeGitHubChecks = 'pending' | 'success' | 'failure' | 'neutral';

/** A pull request as GitHub describes it. */
export interface ClaudeGitHubPullRequestDetails {
	readonly kind: 'pullRequest';
	readonly title: string;
	readonly body: string;
	readonly state: 'open' | 'closed' | 'merged';
	readonly draft: boolean;
	readonly author: string;
	readonly headRef: string;
	readonly baseRef: string;
	readonly checks?: ClaudeGitHubChecks;
}

/** An issue as GitHub describes it. */
export interface ClaudeGitHubIssueDetails {
	readonly kind: 'issue';
	readonly title: string;
	readonly body: string;
	readonly state: 'open' | 'closed';
	readonly notPlanned: boolean;
	readonly author: string;
}

export type ClaudeGitHubDetails = ClaudeGitHubPullRequestDetails | ClaudeGitHubIssueDetails;

/** What the workbench knows about a pull request or issue beyond its URL. */
export type ClaudeGitHubDetailsState =
	| { readonly status: 'loading' }
	| { readonly status: 'loaded'; readonly details: ClaudeGitHubDetails }
	/** GitHub hides the repository (private, or gone) and there is no GitHub sign-in. */
	| { readonly status: 'signIn' }
	/** Offline, rate limited or any other failure: the card says what the URL says. */
	| { readonly status: 'unavailable' };

/** The state a card's badge and the pill are colored by (the theme's git colors). */
export type ClaudeGitHubStateKind = 'open' | 'draft' | 'merged' | 'closed' | 'notPlanned';

/** What a card says once GitHub answered, or why it can't say more. */
export interface GitHubDetailsLabels {
	readonly title?: string;
	readonly state?: { readonly kind: ClaudeGitHubStateKind; readonly label: string };
	/** Only for an open pull request whose checks are pending, passed or failed. */
	readonly checks?: { readonly kind: 'pending' | 'success' | 'failure'; readonly label: string };
	/** `head → base`. */
	readonly branches?: string;
	readonly author?: string;
	/** "Loading…" or "Klawly needs access to this repository to show the pull request". */
	readonly notice?: string;
	readonly ariaLabel: string;
}

function stateOf(details: ClaudeGitHubDetails): { readonly kind: ClaudeGitHubStateKind; readonly label: string } {
	if (details.kind === 'pullRequest') {
		if (details.state === 'merged') {
			return { kind: 'merged', label: localize('claudeGitHubMerged', "Merged") };
		}
		if (details.state === 'closed') {
			return { kind: 'closed', label: localize('claudeGitHubClosed', "Closed") };
		}
		return details.draft ? { kind: 'draft', label: localize('claudeGitHubDraft', "Draft") } : { kind: 'open', label: localize('claudeGitHubOpen', "Open") };
	}
	if (details.state === 'open') {
		return { kind: 'open', label: localize('claudeGitHubIssueOpen', "Open") };
	}
	return details.notPlanned ? { kind: 'notPlanned', label: localize('claudeGitHubNotPlanned', "Not planned") } : { kind: 'closed', label: localize('claudeGitHubIssueClosed', "Closed") };
}

function checksOf(details: ClaudeGitHubPullRequestDetails): GitHubDetailsLabels['checks'] {
	if (details.state !== 'open') {
		return undefined;
	}
	switch (details.checks) {
		case 'pending': return { kind: 'pending', label: localize('claudeGitHubChecksPending', "Checks pending") };
		case 'failure': return { kind: 'failure', label: localize('claudeGitHubChecksFailed', "Checks failed") };
		case 'success': return { kind: 'success', label: localize('claudeGitHubChecksPassed', "Checks passed") };
		default: return undefined;
	}
}

/** The labels of a card for what the workbench knows about it (issue 430). */
export function describeGitHubDetails(reference: ClaudeGitHubReference, state: ClaudeGitHubDetailsState): GitHubDetailsLabels {
	const base = describeGitHubReference(reference);
	switch (state.status) {
		case 'loading':
			return { notice: localize('claudeGitHubLoading', "Loading..."), ariaLabel: base.ariaLabel };
		case 'signIn':
			return { notice: localize('claudeGitHubSignIn', "Klawly needs access to this repository to show the pull request"), ariaLabel: base.ariaLabel };
		case 'unavailable':
			return { ariaLabel: base.ariaLabel };
	}
	const details = state.details;
	const status = stateOf(details);
	const checks = details.kind === 'pullRequest' ? checksOf(details) : undefined;
	const author = localize('claudeGitHubAuthor', "by {0}", details.author);
	return {
		title: details.title,
		state: status,
		checks,
		branches: details.kind === 'pullRequest' ? `${details.headRef} → ${details.baseRef}` : undefined,
		author,
		ariaLabel: localize('claudeGitHubDetailsLabel', "{0} {1} in {2}: {3}. {4}. Open on GitHub", base.kind, base.number, base.repository, details.title, [status.label, checks?.label, author].filter(Boolean).join(', ')),
	};
}

/** The pull request pill on a session's tab and Agents row: the number, its state once known, and what it is in words for a screen reader. */
export function describePullRequestPill(reference: ClaudeGitHubReference, state?: ClaudeGitHubDetailsState): { readonly label: string; readonly state?: ClaudeGitHubStateKind; readonly ariaLabel: string } {
	const number = `#${reference.number}`;
	const repository = `${reference.owner}/${reference.repo}`;
	const status = state?.status === 'loaded' ? stateOf(state.details) : undefined;
	return {
		label: number,
		state: status?.kind,
		ariaLabel: status
			? localize('claudeGitHubPillStateLabel', "Pull request {0} in {1}, {2}, opened in this chat", number, repository, status.label)
			: localize('claudeGitHubPillLabel', "Pull request {0} in {1}, opened in this chat", number, repository),
	};
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function login(value: unknown): string {
	return text(record(value)?.login) ?? '';
}

/** A pull request from GitHub's REST `GET /repos/{owner}/{repo}/pulls/{number}`, with the head commit its checks are on. */
export function pullRequestFromRest(data: unknown): { readonly details: ClaudeGitHubPullRequestDetails; readonly headSha: string } | undefined {
	const json = record(data);
	const title = text(json?.title);
	const head = record(json?.head);
	const base = record(json?.base);
	if (!json || title === undefined || !head || !base) {
		return undefined;
	}
	const merged = json.merged === true || typeof json.merged_at === 'string';
	return {
		details: {
			kind: 'pullRequest',
			title,
			body: text(json.body) ?? '',
			state: merged ? 'merged' : json.state === 'closed' ? 'closed' : 'open',
			draft: json.draft === true,
			author: login(json.user),
			headRef: text(head.ref) ?? '',
			baseRef: text(base.ref) ?? '',
		},
		headSha: text(head.sha) ?? '',
	};
}

/** An issue from GitHub's REST `GET /repos/{owner}/{repo}/issues/{number}`. */
export function issueFromRest(data: unknown): ClaudeGitHubIssueDetails | undefined {
	const json = record(data);
	const title = text(json?.title);
	if (!json || title === undefined) {
		return undefined;
	}
	return {
		kind: 'issue',
		title,
		body: text(json.body) ?? '',
		state: json.state === 'closed' ? 'closed' : 'open',
		notPlanned: json.state_reason === 'not_planned',
		author: login(json.user),
	};
}

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

/** The checks of GitHub's REST `GET /repos/{owner}/{repo}/commits/{sha}/check-runs`, summed up: any pending, else any failed, else passed. */
export function checksFromRest(data: unknown): ClaudeGitHubChecks | undefined {
	const runs = record(data)?.check_runs;
	if (!Array.isArray(runs) || runs.length === 0) {
		return undefined;
	}
	const all = runs.map(record);
	if (all.some(run => run?.status !== 'completed')) {
		return 'pending';
	}
	return all.some(run => FAILED_CONCLUSIONS.has(text(run?.conclusion) ?? '')) ? 'failure' : 'success';
}
