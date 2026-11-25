/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeGitHubReference, NormalizedClaudeEvent } from '../../../../../platform/claude/common/claudeProtocol.js';
import { IDelayedHoverOptions } from '../../../../../base/browser/ui/hover/hover.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../../../services/claude/common/claudeAgentState.js';
import { IClaudeCheckInvestigationService } from '../../browser/chat/claudeCheckInvestigation.js';
import { ClaudeReviewerState, IClaudeReviewerSuggestionService } from '../../browser/chat/claudeReviewerSuggestions.js';
import { renderGitHubCard } from '../../browser/chat/claudeGitHubCard.js';
import { ClaudeSessionTabs } from '../../browser/chat/claudeSessionTabs.js';
import { ClaudeGitHubPullRequestDetails } from '../../common/claudeGitHubCards.js';
import { TestClaudeGitHubDetailsService } from './claudeGitHubTestUtils.js';

const pullRequest: ClaudeGitHubReference = { url: 'https://github.com/acme/app/pull/7', owner: 'acme', repo: 'app', number: 7, kind: 'pullRequest', createdBySession: false };

function details(state: ClaudeGitHubPullRequestDetails['state'], extra: Partial<ClaudeGitHubPullRequestDetails> = {}): ClaudeGitHubPullRequestDetails {
	return { kind: 'pullRequest', title: 'Fix the cache', body: '## Why\n\nThe cache **never** expired.', state, draft: false, author: 'octo', headRef: 'fix/cache', baseRef: 'main', ...extra };
}

suite('Claude GitHub cards and pills (issue 430)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let gitHub: TestClaudeGitHubDetailsService;
	let hovers: Map<HTMLElement, () => IDelayedHoverOptions>;
	let hover: IHoverService;
	let host: HTMLElement;

	setup(() => {
		gitHub = store.add(new TestClaudeGitHubDetailsService());
		hovers = new Map();
		hover = {
			...NullHoverService,
			setupDelayedHover: (target: HTMLElement, options: (() => IDelayedHoverOptions) | IDelayedHoverOptions) => {
				hovers.set(target, typeof options === 'function' ? options : () => options);
				return toDisposable(() => hovers.delete(target));
			},
		} as IHoverService;
		host = document.createElement('div');
		document.body.appendChild(host);
		store.add(toDisposable(() => host.remove()));
	});

	/** What a card shows: its status and state, its text, and any sign-in action after it. */
	function describeCard(card: HTMLElement): string[] {
		return [
			`${card.dataset.status}/${card.dataset.state || '-'}`,
			card.querySelector('.claude-github-card-head')!.textContent!,
			[...card.querySelectorAll('.claude-github-card-meta > span')].map(part => part.textContent).join(' · '),
			...[...host.querySelectorAll('.claude-github-card-signin')].map(button => `[${button.textContent}]`),
		];
	}

	test('a card shows the live state, checks, branches and author, and only the URL until or unless GitHub answers', () => {
		const card = renderGitHubCard(host, pullRequest, { sessionId: 's', details: gitHub, hover }, store.add(new DisposableStore()));
		const shown: string[][] = [describeCard(card)];
		const hoverText: unknown[] = [hovers.get(card)!().content];
		for (const state of [
			{ status: 'loaded', details: details('open', { checks: 'failure' }) },
			{ status: 'loaded', details: details('merged', { checks: 'success' }) },
			{ status: 'loaded', details: details('closed') },
			{ status: 'unavailable' },
			{ status: 'signIn' },
		] as const) {
			gitHub.set('s', pullRequest.url, state);
			shown.push(describeCard(card));
			hoverText.push(hovers.get(card)!().content);
		}
		// Another session's answer leaves this card alone.
		gitHub.set('other', pullRequest.url, { status: 'loaded', details: details('merged') });
		shown.push(describeCard(card));
		assert.deepStrictEqual({ shown, hoverText }, {
			shown: [
				['loading/-', 'acme/app#7', 'Pull request · Loading...'],
				['loaded/open', 'Fix the cache#7', 'Open · Checks failed · fix/cache → main · acme/app · by octo'],
				['loaded/merged', 'Fix the cache#7', 'Merged · fix/cache → main · acme/app · by octo'],
				['loaded/closed', 'Fix the cache#7', 'Closed · fix/cache → main · acme/app · by octo'],
				['unavailable/-', 'acme/app#7', 'Pull request · github.com/acme/app/pull/7'],
				['signIn/-', 'acme/app#7', 'Pull request · Klawly needs access to this repository to show the pull request', '[Sign In with Repository Access]'],
				['signIn/-', 'acme/app#7', 'Pull request · Klawly needs access to this repository to show the pull request', '[Sign In with Repository Access]'],
			],
			hoverText: [pullRequest.url, 'Why The cache never expired.', 'Why The cache never expired.', 'Why The cache never expired.', pullRequest.url, pullRequest.url],
		});
	});

	test('the card opens the pull request; its sign-in action signs in and goes away once GitHub answers', () => {
		const card = renderGitHubCard(host, pullRequest, { sessionId: 's', details: gitHub, hover }, store.add(new DisposableStore()));
		gitHub.set('s', pullRequest.url, { status: 'signIn' });
		host.querySelector<HTMLButtonElement>('.claude-github-card-signin')!.click();
		card.click();
		gitHub.set('s', pullRequest.url, { status: 'loaded', details: details('open') });
		assert.deepStrictEqual({ calls: gitHub.calls, signIn: host.querySelectorAll('.claude-github-card-signin').length, label: card.getAttribute('aria-label') }, {
			calls: ['signIn', `open ${pullRequest.url}`],
			signIn: 0,
			label: 'Pull request #7 in acme/app: Fix the cache. Open, by octo. Open on GitHub',
		});
	});

	test('an open pull request whose checks failed offers Investigate Failing Check under its card (issue 505)', () => {
		const changed = store.add(new Emitter<{ readonly sessionId: string; readonly url: string }>());
		const reading = new Set<string>();
		const investigated: string[] = [];
		const investigation = {
			onDidChange: changed.event,
			isReading: (sessionId: string, url: string) => reading.has(`${sessionId} ${url}`),
			investigate: async (sessionId: string, reference: ClaudeGitHubReference) => { investigated.push(`${sessionId} ${reference.url}`); },
		} as IClaudeCheckInvestigationService;
		renderGitHubCard(host, pullRequest, { sessionId: 's', details: gitHub, hover, investigation }, store.add(new DisposableStore()));
		const links = () => [...host.querySelectorAll<HTMLButtonElement>('.claude-github-card-investigate')].map(button => `${button.textContent}${button.disabled ? ' (disabled)' : ''}`);
		const shown: string[][] = [];
		gitHub.set('s', pullRequest.url, { status: 'loaded', details: details('open', { checks: 'success' }) });
		shown.push(links());
		gitHub.set('s', pullRequest.url, { status: 'loaded', details: details('open', { checks: 'failure' }) });
		shown.push(links());
		host.querySelector<HTMLButtonElement>('.claude-github-card-investigate')!.click();
		reading.add(`s ${pullRequest.url}`);
		changed.fire({ sessionId: 's', url: pullRequest.url });
		shown.push(links());
		reading.clear();
		changed.fire({ sessionId: 's', url: pullRequest.url });
		shown.push(links());
		assert.deepStrictEqual({ shown, investigated }, {
			shown: [[], ['Investigate Failing Check'], ['Reading the Failed Log... (disabled)'], ['Investigate Failing Check']],
			investigated: [`s ${pullRequest.url}`],
		});
	});

	test('an open pull request offers Tend This PR under its card, which becomes Stop Tending while the chat tends it (issue 1016)', () => {
		const changed = store.add(new Emitter<{ readonly sessionId: string }>());
		const tending = new Set<string>();
		const toggled: string[] = [];
		const tend = {
			onDidChange: changed.event,
			isTending: (sessionId: string) => tending.has(sessionId),
			toggle: (sessionId: string, reference: ClaudeGitHubReference) => { toggled.push(`${sessionId} ${reference.url}`); },
		};
		renderGitHubCard(host, pullRequest, { sessionId: 's', details: gitHub, hover, tend }, store.add(new DisposableStore()));
		const link = () => [...host.querySelectorAll<HTMLButtonElement>('.claude-github-card-tend')].map(button => button.textContent);
		const shown: (string | null)[][] = [link()];
		gitHub.set('s', pullRequest.url, { status: 'loaded', details: details('merged') });
		shown.push(link());
		gitHub.set('s', pullRequest.url, { status: 'loaded', details: details('open') });
		shown.push(link());
		host.querySelector<HTMLButtonElement>('.claude-github-card-tend')!.click();
		tending.add('s');
		changed.fire({ sessionId: 's' });
		shown.push(link());
		assert.deepStrictEqual({ shown, toggled }, {
			shown: [[], [], ['Tend This PR'], ['Stop Tending']],
			toggled: [`s ${pullRequest.url}`],
		});
	});

	test('an open pull request offers Suggest Reviewers; the risk note and Request Review then sit under its card (issues 508, 870)', () => {
		const changed = store.add(new Emitter<{ readonly sessionId: string; readonly url: string }>());
		let current: ClaudeReviewerState = { status: 'idle' };
		const calls: string[] = [];
		const reviewers = {
			_serviceBrand: undefined,
			onDidChange: changed.event,
			get: () => current,
			suggest: async (sessionId: string, reference: ClaudeGitHubReference) => { calls.push(`suggest ${sessionId} ${reference.url}`); },
			signIn: async () => { },
			openAccessHelp: async () => { },
			request: async (sessionId: string, _reference: ClaudeGitHubReference, logins: readonly string[]) => { calls.push(`request ${sessionId} ${logins.join(',')}`); },
		} as IClaudeReviewerSuggestionService;
		renderGitHubCard(host, pullRequest, { sessionId: 's', details: gitHub, hover, reviewers }, store.add(new DisposableStore()));
		const shown = () => [...host.querySelectorAll('.claude-github-card-reviewers, .claude-github-card-risk, .claude-github-card-reviewer, .claude-github-card-reviewer-empty, .claude-github-card-request')].map(element => `${element.className.split(' ').pop()}: ${element.textContent}`);
		const states: string[][] = [shown()];
		const update = (next: ClaudeReviewerState) => { current = next; changed.fire({ sessionId: 's', url: pullRequest.url }); states.push(shown()); };
		gitHub.set('s', pullRequest.url, { status: 'loaded', details: details('open') });
		states.push(shown());
		host.querySelector<HTMLButtonElement>('.claude-github-card-reviewers')!.click();
		update({ status: 'loading' });
		const suggestions = { reviewers: [{ login: 'amy', team: false, ownedFiles: 2, historyFiles: 0, commits: 0, lastCommit: undefined }], risk: { level: 'low' as const, factors: [], areas: [], lines: 4, files: 2 } };
		update({ status: 'ready', suggestions, changedFiles: 2, now: 0, request: 'none', requested: [] });
		host.querySelector<HTMLButtonElement>('.claude-github-card-request')!.click();
		update({ status: 'ready', suggestions, changedFiles: 2, now: 0, request: 'requested', requested: ['amy'] });
		update({ status: 'ready', suggestions, changedFiles: 2, now: 0, request: 'dropped', requested: [], dropped: ['acme/core'] });
		const droppedHover = [...hovers.entries()].filter(([target]) => target.textContent?.startsWith('GitHub Didn')).map(([, options]) => options().content);
		update({ status: 'ready', suggestions: { reviewers: [], risk: suggestions.risk }, changedFiles: 2, now: 0, request: 'none', requested: [] });
		gitHub.set('s', pullRequest.url, { status: 'loaded', details: details('merged') });
		states.push(shown());
		assert.deepStrictEqual({ states, calls, droppedHover }, {
			states: [
				[],
				['claude-github-card-reviewers: Suggest Reviewers'],
				['claude-github-card-reviewers: Reading the Changes...'],
				['claude-github-card-risk: Low risk: 4 lines in 2 files, tests changed with the code.', 'claude-github-card-reviewer: @amyowns 2 of 2 changed files', 'claude-github-card-request: Request Review'],
				['claude-github-card-risk: Low risk: 4 lines in 2 files, tests changed with the code.', 'claude-github-card-reviewer: @amyowns 2 of 2 changed files', 'claude-github-card-request: Review Requested'],
				['claude-github-card-risk: Low risk: 4 lines in 2 files, tests changed with the code.', 'claude-github-card-reviewer: @amyowns 2 of 2 changed files', 'claude-github-card-request: Request Review', "claude-github-card-reviewer-empty: GitHub Didn't Add acme/core"],
				['claude-github-card-risk: Low risk: 4 lines in 2 files, tests changed with the code.', 'claude-github-card-reviewer-empty: No one to suggest: no code owner matches these files and none has changed them in the last year.'],
				[],
			],
			calls: [`suggest s ${pullRequest.url}`, 'request s amy'],
			droppedHover: ["The pull request's author can't be asked to review their own pull request, and GitHub drops a team made up only of the author."],
		});
	});

	test('a signed-out Request Review asks to sign in, then signs in and asks again (issue 945)', async () => {
		const changed = store.add(new Emitter<{ readonly sessionId: string; readonly url: string }>());
		const suggestions = { reviewers: [{ login: 'amy', team: false, ownedFiles: 2, historyFiles: 0, commits: 0, lastCommit: undefined }], risk: { level: 'low' as const, factors: [], areas: [], lines: 4, files: 2 } };
		let current: ClaudeReviewerState = { status: 'ready', suggestions, changedFiles: 2, now: 0, request: 'signIn', requested: [] };
		const calls: string[] = [];
		const reviewers = {
			_serviceBrand: undefined,
			onDidChange: changed.event,
			get: () => current,
			suggest: async () => { },
			signIn: async () => { },
			openAccessHelp: async () => { },
			request: async (_sessionId: string, _reference: ClaudeGitHubReference, logins: readonly string[]) => { calls.push(`request ${logins.join(',')}`); },
		} as IClaudeReviewerSuggestionService;
		renderGitHubCard(host, pullRequest, { sessionId: 's', details: gitHub, hover, reviewers }, store.add(new DisposableStore()));
		gitHub.set('s', pullRequest.url, { status: 'loaded', details: details('open') });
		const shown = () => [...host.querySelectorAll('.claude-github-card-reviewer-empty, .claude-github-card-reviewer-signin')].map(element => element.textContent);
		const prompt = shown();
		host.querySelector<HTMLButtonElement>('.claude-github-card-reviewer-signin')!.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual({ prompt, calls: [...gitHub.calls, ...calls] }, {
			prompt: ['Sign in to GitHub to request these reviews.', 'Sign In to GitHub'],
			calls: ['signIn', 'request amy'],
		});
	});

	test('a session tab shows a pill only for the pull request the session created, colored by its state', () => {
		const opened: string[] = [];
		const tabs = store.add(new ClaudeSessionTabs(host, {
			select: () => undefined,
			openPullRequest: sessionId => opened.push(sessionId),
			close: () => undefined,
			dragStart: () => undefined,
			reorder: () => undefined,
			contextMenu: () => undefined,
		}, hover, gitHub));
		const detected = (sessionId: string, createdBySession: boolean): NormalizedClaudeEvent => ({ type: 'github.referenceDetected', sessionId, reference: { ...pullRequest, createdBySession } });
		const created = reduceAgentState(EMPTY_AGENT_VIEW_STATE, detected('a', true)).pullRequest;
		const mentioned = reduceAgentState(EMPTY_AGENT_VIEW_STATE, detected('b', false)).pullRequest;
		tabs.update([{ id: 'a', title: 'Ship it', running: false, pullRequest: created }, { id: 'b', title: 'Read it', running: false, pullRequest: mentioned }], 'a');
		const pills = () => [...host.querySelectorAll<HTMLElement>('.claude-pr-pill')].map(pill => `${pill.textContent} ${pill.dataset.state || 'unknown'} | ${pill.getAttribute('aria-label')}`);
		const before = pills();
		gitHub.set('a', pullRequest.url, { status: 'loaded', details: details('merged') });
		host.querySelector<HTMLButtonElement>('.claude-pr-pill')!.click();
		assert.deepStrictEqual({ before, after: pills(), opened }, {
			before: ['#7 unknown | Pull request #7 in acme/app, opened in this chat'],
			after: ['#7 merged | Pull request #7 in acme/app, Merged, opened in this chat'],
			opened: ['a'],
		});
	});
});
