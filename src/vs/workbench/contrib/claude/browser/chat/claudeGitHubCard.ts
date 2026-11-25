/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../base/browser/dom.js';
import { renderAsPlaintext } from '../../../../../base/browser/markdownRenderer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Event } from '../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { ClaudeGitHubReference } from '../../../../../platform/claude/common/claudeProtocol.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { ClaudeGitHubDetailsState, ClaudeGitHubStateKind, describeGitHubDetails, describeGitHubReference, describePullRequestPill } from '../../common/claudeGitHubCards.js';
import { IClaudeGitHubDetailsService } from './claudeGitHubDetails.js';
import { IClaudeCheckInvestigationService } from './claudeCheckInvestigation.js';
import { describeReviewerReason, describeRisk } from '../../common/claudeReviewerSuggestions.js';
import { IClaudeReviewerSuggestionService } from './claudeReviewerSuggestions.js';

/** What a card or pill needs to show a reference's live details (issue 430). */
export interface ClaudeGitHubCardContext {
	/** The session the reference is in; details are cached per session. */
	readonly sessionId: string;
	readonly details: IClaudeGitHubDetailsService;
	readonly hover: IHoverService;
	/** Offers Investigate Failing Check under an open pull request whose checks failed (issue 505). */
	readonly investigation?: IClaudeCheckInvestigationService;
	/** Offers Suggest Reviewers under an open pull request (issue 508). */
	readonly reviewers?: IClaudeReviewerSuggestionService;
	/** Offers Tend This PR under an open pull request, the same command the palette runs (issue 1016). */
	readonly tend?: {
		readonly onDidChange: Event<{ readonly sessionId: string }>;
		isTending(sessionId: string): boolean;
		/** Starts tending when the chat is not, stops it when it is. */
		toggle(sessionId: string, reference: ClaudeGitHubReference): void;
	};
}

/** How much of the description the card's hover shows. */
const DESCRIPTION_LENGTH = 300;

function stateIcon(kind: ClaudeGitHubReference['kind'], state: ClaudeGitHubStateKind | undefined): ThemeIcon {
	if (kind === 'issue') {
		return state === 'closed' ? Codicon.issueClosed : state === 'notPlanned' ? Codicon.circleSlash : Codicon.issues;
	}
	switch (state) {
		case 'merged': return Codicon.gitPullRequestDone;
		case 'closed': return Codicon.gitPullRequestClosed;
		case 'draft': return Codicon.gitPullRequestDraft;
		default: return Codicon.gitPullRequest;
	}
}

/**
 * The notice for an organization that limits OAuth app access (issue 1519): says which one, offers a sign-in again so GitHub
 * can offer the organization's Grant or Request choice, and links the policy page (owners) and GitHub's docs (everyone).
 */
function renderOrgRestricted(panel: HTMLElement, org: string, signInAgain: () => Promise<unknown>, reviewers: IClaudeReviewerSuggestionService, store: DisposableStore): void {
	append(panel, $('div.claude-github-card-reviewer-empty')).textContent = localize('claudeGitHubOrgRestricted', "{0} limits third-party access, so Klawly can't read its teams.", org);
	const button = append(panel, $<HTMLButtonElement>('button.claude-github-card-signin.claude-github-card-reviewer-signin'));
	button.type = 'button';
	append(button, $(ThemeIcon.asCSSSelector(Codicon.signIn)));
	append(button, $('span')).textContent = localize('claudeGitHubOrgRestrictedSignIn', "Sign In Again to Grant Access");
	store.add(addDisposableListener(button, EventType.CLICK, event => {
		event.preventDefault();
		event.stopPropagation();
		void signInAgain();
	}));
	for (const link of [
		{ label: localize('claudeGitHubOrgRestrictedPolicy', "Open {0}'s OAuth App Policy", org), owner: true },
		{ label: localize('claudeGitHubOrgRestrictedLearnMore', "Learn More"), owner: false },
	]) {
		const anchor = append(panel, $<HTMLButtonElement>('button.claude-github-card-signin.claude-github-card-reviewer-signin'));
		anchor.type = 'button';
		append(anchor, $('span')).textContent = link.label;
		store.add(addDisposableListener(anchor, EventType.CLICK, event => {
			event.preventDefault();
			event.stopPropagation();
			void reviewers.openAccessHelp(org, link.owner);
		}));
	}
}

/** The first lines of a description, as plain text. */
function descriptionExcerpt(body: string): string | undefined {
	const text = renderAsPlaintext(new MarkdownString(body), { omitMarkdownSyntax: true }).replace(/\s+/g, ' ').trim();
	return text ? (text.length > DESCRIPTION_LENGTH ? `${text.slice(0, DESCRIPTION_LENGTH - 1)}…` : text) : undefined;
}

/**
 * A pull request or issue card in the timeline (issue 430). Before GitHub
 * answers, and when it can't (offline, errors), it shows the repository,
 * number and URL; once it answers, the title, state, checks, branches and
 * author, with the description's first lines on hover. A private repository
 * without a GitHub sign-in offers to sign in below the card, and an open pull
 * request whose checks failed offers Investigate Failing Check there (issue
 * 505, DL-55), and an open one Suggest Reviewers (issue 508). The whole card opens it (DL-11 words, DL-01 theme colors).
 */
export function renderGitHubCard(parent: HTMLElement, reference: ClaudeGitHubReference, context: ClaudeGitHubCardContext, store: DisposableStore): HTMLButtonElement {
	const card = append(parent, $<HTMLButtonElement>('button.claude-github-card'));
	card.type = 'button';
	card.dataset.kind = reference.kind;
	const icon = append(card, $('span.claude-github-card-icon'));
	const body = append(card, $('span.claude-github-card-body'));
	append(card, $(ThemeIcon.asCSSSelector(Codicon.linkExternal) + '.claude-github-card-open'));
	const signIn = store.add(new DisposableStore());
	const investigate = store.add(new DisposableStore());
	const suggest = store.add(new DisposableStore());
	const tend = store.add(new DisposableStore());
	let state: ClaudeGitHubDetailsState = context.details.get(context.sessionId, reference);

	const paint = () => {
		const base = describeGitHubReference(reference);
		const labels = describeGitHubDetails(reference, state);
		card.dataset.status = state.status;
		card.dataset.state = labels.state?.kind ?? '';
		card.setAttribute('aria-label', labels.ariaLabel);
		icon.className = `claude-github-card-icon ${ThemeIcon.asClassName(stateIcon(reference.kind, labels.state?.kind))}`;
		clearNode(body);
		const head = append(body, $('span.claude-github-card-head'));
		const meta = append(body, $('span.claude-github-card-meta'));
		if (labels.title !== undefined) {
			append(head, $('span.claude-github-card-title')).textContent = labels.title;
			append(head, $('span.claude-github-card-number')).textContent = base.number;
			if (labels.state) {
				append(meta, $('span.claude-github-card-state')).textContent = labels.state.label;
			}
			if (labels.checks) {
				const checks = append(meta, $('span.claude-github-card-checks'));
				checks.dataset.checks = labels.checks.kind;
				append(checks, $(ThemeIcon.asCSSSelector(labels.checks.kind === 'success' ? Codicon.passFilled : labels.checks.kind === 'failure' ? Codicon.error : Codicon.circleFilled)));
				append(checks, $('span')).textContent = labels.checks.label;
			}
			if (labels.branches) {
				append(meta, $('span.claude-github-card-branches')).textContent = labels.branches;
			}
			append(meta, $('span.claude-github-card-repo')).textContent = base.repository;
			if (labels.author) {
				append(meta, $('span.claude-github-card-author')).textContent = labels.author;
			}
		} else {
			append(head, $('span.claude-github-card-repo')).textContent = base.repository;
			append(head, $('span.claude-github-card-number')).textContent = base.number;
			append(meta, $('span.claude-github-card-kind')).textContent = base.kind;
			append(meta, $('span.claude-github-card-url')).textContent = (state.status === 'loading' || state.status === 'signIn') && labels.notice ? labels.notice : base.location;
		}

		// Sign in from the card when GitHub hides the repository from anonymous reads.
		signIn.clear();
		if (state.status === 'signIn' && labels.notice) {
			const button = append(parent, $<HTMLButtonElement>('button.claude-github-card-signin'));
			button.type = 'button';
			append(button, $(ThemeIcon.asCSSSelector(Codicon.signIn)));
			append(button, $('span')).textContent = localize('claudeGitHubSignInRepository', "Sign In with Repository Access");
			signIn.add({ dispose: () => button.remove() });
			signIn.add(addDisposableListener(button, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				void context.details.signIn();
			}));
		}

		// Investigate Failing Check: the card is a button, so its next step sits under it like the sign-in.
		investigate.clear();
		const investigation = context.investigation;
		if (investigation && state.status === 'loaded' && state.details.kind === 'pullRequest' && labels.checks?.kind === 'failure') {
			const reading = investigation.isReading(context.sessionId, reference.url);
			const button = append(parent, $<HTMLButtonElement>('button.claude-github-card-signin.claude-github-card-investigate'));
			button.type = 'button';
			button.disabled = reading;
			append(button, $(ThemeIcon.asCSSSelector(reading ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.debugAlt)));
			append(button, $('span')).textContent = reading ? localize('claudeGitHubInvestigating', "Reading the Failed Log...") : localize('claudeGitHubInvestigate', "Investigate Failing Check");
			investigate.add({ dispose: () => button.remove() });
			investigate.add(addDisposableListener(button, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				void investigation.investigate(context.sessionId, reference);
			}));
		}

		// Tend This PR (issue 1016): a quiet link like the others (DL-55); it flips to Stop Tending while the chat watches this pull request.
		tend.clear();
		const tending = context.tend;
		if (tending && state.status === 'loaded' && state.details.kind === 'pullRequest' && state.details.state === 'open') {
			const on = tending.isTending(context.sessionId);
			const button = append(parent, $<HTMLButtonElement>('button.claude-github-card-signin.claude-github-card-tend'));
			button.type = 'button';
			button.dataset.tending = String(on);
			append(button, $(ThemeIcon.asCSSSelector(on ? Codicon.debugStop : Codicon.eye)));
			append(button, $('span')).textContent = on ? localize('claudeGitHubStopTending', "Stop Tending") : localize('claudeGitHubTend', "Tend This PR");
			tend.add({ dispose: () => button.remove() });
			tend.add(addDisposableListener(button, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				tending.toggle(context.sessionId, reference);
			}));
		}

		// Suggest Reviewers (issues 508, 870): the suggestions and the risk note sit under the card; Request Review asks GitHub (DL-93).
		suggest.clear();
		const reviewers = context.reviewers;
		if (reviewers && state.status === 'loaded' && state.details.kind === 'pullRequest' && state.details.state === 'open') {
			const suggestion = reviewers.get(context.sessionId, reference);
			if (suggestion.status === 'idle' || suggestion.status === 'loading') {
				const loading = suggestion.status === 'loading';
				const button = append(parent, $<HTMLButtonElement>('button.claude-github-card-signin.claude-github-card-reviewers'));
				button.type = 'button';
				button.disabled = loading;
				append(button, $(ThemeIcon.asCSSSelector(loading ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.personAdd)));
				append(button, $('span')).textContent = loading ? localize('claudeGitHubReadingReviewers', "Reading the Changes...") : localize('claudeGitHubSuggestReviewers', "Suggest Reviewers");
				suggest.add({ dispose: () => button.remove() });
				suggest.add(addDisposableListener(button, EventType.CLICK, event => {
					event.preventDefault();
					event.stopPropagation();
					void reviewers.suggest(context.sessionId, reference);
				}));
			} else {
				const panel = append(parent, $('div.claude-github-card-suggestions'));
				suggest.add({ dispose: () => panel.remove() });
				if (suggestion.status === 'needsAccess') {
					append(panel, $('div.claude-github-card-risk')).textContent = localize('claudeGitHubReviewersNeedsAccess', "Klawly needs access to this repository to suggest reviewers.");
					const signInButton = append(panel, $<HTMLButtonElement>('button.claude-github-card-signin.claude-github-card-reviewers'));
					signInButton.type = 'button';
					append(signInButton, $(ThemeIcon.asCSSSelector(Codicon.signIn)));
					append(signInButton, $('span')).textContent = localize('claudeGitHubReviewersSignIn', "Sign In with Repository Access");
					suggest.add(addDisposableListener(signInButton, EventType.CLICK, event => {
						event.preventDefault();
						event.stopPropagation();
						void reviewers.signIn(context.sessionId, reference);
					}));
				} else if (suggestion.status === 'orgRestricted') {
					renderOrgRestricted(panel, suggestion.org, () => reviewers.signIn(context.sessionId, reference), reviewers, suggest);
				} else if (suggestion.status === 'unavailable') {
					append(panel, $('div.claude-github-card-risk')).textContent = localize('claudeGitHubReviewersUnavailable', "Couldn't read this pull request from GitHub. Sign in to GitHub and try again.");
					const retry = append(panel, $<HTMLButtonElement>('button.claude-github-card-signin.claude-github-card-reviewers'));
					retry.type = 'button';
					append(retry, $(ThemeIcon.asCSSSelector(Codicon.refresh)));
					append(retry, $('span')).textContent = localize('claudeGitHubReviewersRetry', "Try Again");
					suggest.add(addDisposableListener(retry, EventType.CLICK, event => {
						event.preventDefault();
						event.stopPropagation();
						void reviewers.suggest(context.sessionId, reference);
					}));
				} else {
					const risk = append(panel, $('div.claude-github-card-risk'));
					risk.dataset.risk = suggestion.suggestions.risk.level;
					risk.textContent = describeRisk(suggestion.suggestions.risk);
					const people = suggestion.suggestions.reviewers;
					if (!people.length) {
						append(panel, $('div.claude-github-card-reviewer-empty')).textContent = localize('claudeGitHubNoReviewers', "No one to suggest: no code owner matches these files and none has changed them in the last year.");
					}
					for (const person of people) {
						const row = append(panel, $('div.claude-github-card-reviewer'));
						append(row, $('span.claude-github-card-reviewer-login')).textContent = person.team ? person.login : `@${person.login}`;
						append(row, $('span.claude-github-card-reviewer-reason')).textContent = describeReviewerReason(person, suggestion.changedFiles, suggestion.now);
					}
					if (people.length) {
						const requesting = suggestion.request === 'requesting';
						const requested = suggestion.request === 'requested';
						const request = append(panel, $<HTMLButtonElement>('button.claude-github-card-signin.claude-github-card-request'));
						request.type = 'button';
						request.disabled = requesting || requested;
						append(request, $(ThemeIcon.asCSSSelector(requested ? Codicon.check : requesting ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.personAdd)));
						append(request, $('span')).textContent = requested ? localize('claudeGitHubReviewRequested', "Review Requested") : requesting ? localize('claudeGitHubRequestingReview', "Requesting...") : localize('claudeGitHubRequestReview', "Request Review");
						suggest.add(addDisposableListener(request, EventType.CLICK, event => {
							event.preventDefault();
							event.stopPropagation();
							void reviewers.request(context.sessionId, reference, people.map(person => person.login));
						}));
						if (suggestion.request === 'signIn') {
							// Signed out: suggestions read anonymously, but requesting reviews needs the account.
							append(panel, $('div.claude-github-card-reviewer-empty')).textContent = localize('claudeGitHubRequestSignIn', "Sign in to GitHub to request these reviews.");
							const signInButton = append(panel, $<HTMLButtonElement>('button.claude-github-card-signin.claude-github-card-reviewer-signin'));
							signInButton.type = 'button';
							append(signInButton, $(ThemeIcon.asCSSSelector(Codicon.signIn)));
							append(signInButton, $('span')).textContent = localize('claudeGitHubRequestSignInButton', "Sign In to GitHub");
							suggest.add(addDisposableListener(signInButton, EventType.CLICK, event => {
								event.preventDefault();
								event.stopPropagation();
								void context.details.signIn().then(() => reviewers.request(context.sessionId, reference, people.map(person => person.login)));
							}));
						}
						if (suggestion.request === 'orgRestricted' && suggestion.restrictedOrg) {
							renderOrgRestricted(panel, suggestion.restrictedOrg, () => context.details.signIn().then(() => reviewers.request(context.sessionId, reference, people.map(person => person.login))), reviewers, suggest);
						}
						if (suggestion.request === 'dropped' && suggestion.dropped?.length) {
								// GitHub answered 201 and still left some out (issue 1520): say which, never "Review Requested".
								const dropped = append(panel, $('div.claude-github-card-reviewer-empty'));
								dropped.textContent = localize('claudeGitHubReviewDropped', "GitHub Didn't Add {0}", suggestion.dropped.join(', '));
								suggest.add(context.hover.setupDelayedHover(dropped, () => ({
									content: localize('claudeGitHubReviewDroppedHover', "The pull request's author can't be asked to review their own pull request, and GitHub drops a team made up only of the author."),
									additionalClasses: ['claude-root'],
								})));
							}
							if (suggestion.request === 'failed') {
							append(panel, $('div.claude-github-card-reviewer-empty')).textContent = localize('claudeGitHubRequestFailed', "GitHub didn't take the request. Sign in to GitHub with access to this repository and try again.");
						}
					}
				}
			}
		}
	};
	paint();
	if (context.reviewers) {
		store.add(context.reviewers.onDidChange(event => {
			if (event.sessionId === context.sessionId && event.url === reference.url) {
				paint();
			}
		}));
	}
	if (context.investigation) {
		store.add(context.investigation.onDidChange(event => {
			if (event.sessionId === context.sessionId && event.url === reference.url) {
				paint();
			}
		}));
	}

	if (context.tend) {
		store.add(context.tend.onDidChange(event => {
			if (event.sessionId === context.sessionId) {
				paint();
			}
		}));
	}

	store.add(context.details.onDidChange(event => {
		if (event.sessionId === context.sessionId && event.url === reference.url) {
			state = context.details.get(context.sessionId, reference);
			paint();
		}
	}));
	store.add(context.hover.setupDelayedHover(card, () => ({
		content: (state.status === 'loaded' && descriptionExcerpt(state.details.body)) || reference.url,
		additionalClasses: ['claude-root'],
	})));
	store.add(addDisposableListener(card, EventType.CLICK, event => {
		event.preventDefault();
		event.stopPropagation();
		void context.details.open(reference);
	}));
	return card;
}

/** The pull request pill on a session's tab and Agents row: its icon and number, colored by its state once GitHub answers. */
export function renderPullRequestPill(parent: HTMLElement, reference: ClaudeGitHubReference, context: ClaudeGitHubCardContext, open: () => void, store: DisposableStore): HTMLButtonElement {
	const pill = append(parent, $<HTMLButtonElement>('button.claude-pr-pill'));
	pill.type = 'button';
	const icon = append(pill, $('span'));
	const label = append(pill, $('span'));
	const paint = () => {
		const labels = describePullRequestPill(reference, context.details.get(context.sessionId, reference));
		pill.dataset.state = labels.state ?? '';
		pill.setAttribute('aria-label', labels.ariaLabel);
		icon.className = ThemeIcon.asClassName(stateIcon('pullRequest', labels.state));
		label.textContent = labels.label;
	};
	paint();
	store.add(context.details.onDidChange(event => {
		if (event.sessionId === context.sessionId && event.url === reference.url) {
			paint();
		}
	}));
	store.add(addDisposableListener(pill, EventType.CLICK, event => {
		event.preventDefault();
		event.stopPropagation();
		open();
	}));
	return pill;
}

/** The static pull request badge on an Agents row, which is already a button (the row opens the session). */
export function renderPullRequestBadge(parent: HTMLElement, reference: ClaudeGitHubReference, state: ClaudeGitHubDetailsState): string {
	const labels = describePullRequestPill(reference, state);
	const badge = append(parent, $('span.claude-pr-pill.is-static'));
	badge.dataset.state = labels.state ?? '';
	append(badge, $(ThemeIcon.asCSSSelector(stateIcon('pullRequest', labels.state))));
	append(badge, $('span')).textContent = labels.label;
	return labels.ariaLabel;
}
