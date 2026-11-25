/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeGitHubReference } from '../../../../../platform/claude/common/claudeProtocol.js';
import { checksFromRest, ClaudeGitHubDetails, describeGitHubDetails, describePullRequestPill, issueFromRest, pullRequestFromRest } from '../../common/claudeGitHubCards.js';

const pullRequest: ClaudeGitHubReference = { url: 'https://github.com/acme/app/pull/7', owner: 'acme', repo: 'app', number: 7, kind: 'pullRequest', createdBySession: true };
const issue: ClaudeGitHubReference = { url: 'https://github.com/acme/app/issues/3', owner: 'acme', repo: 'app', number: 3, kind: 'issue', createdBySession: false };

function pr(state: 'open' | 'closed' | 'merged', draft = false, checks?: 'pending' | 'success' | 'failure'): ClaudeGitHubDetails {
	return { kind: 'pullRequest', title: 'Fix the cache', body: 'Body', state, draft, author: 'octo', headRef: 'fix/cache', baseRef: 'main', checks };
}

suite('Claude GitHub cards', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('card labels for each state: open with checks, draft, merged, closed, issue, loading, sign in and error', () => {
		const describe = (reference: ClaudeGitHubReference, state: Parameters<typeof describeGitHubDetails>[1]) => {
			const labels = describeGitHubDetails(reference, state);
			return [labels.title, labels.state?.kind, labels.state?.label, labels.checks?.label, labels.branches, labels.author, labels.notice];
		};
		assert.deepStrictEqual([
			describe(pullRequest, { status: 'loaded', details: pr('open', false, 'failure') }),
			describe(pullRequest, { status: 'loaded', details: pr('open', true, 'pending') }),
			describe(pullRequest, { status: 'loaded', details: pr('merged', false, 'success') }),
			describe(pullRequest, { status: 'loaded', details: pr('closed') }),
			describe(issue, { status: 'loaded', details: { kind: 'issue', title: 'Crash', body: '', state: 'closed', notPlanned: true, author: 'octo' } }),
			describe(pullRequest, { status: 'loading' }),
			describe(pullRequest, { status: 'signIn' }),
			describe(pullRequest, { status: 'unavailable' }),
		], [
			['Fix the cache', 'open', 'Open', 'Checks failed', 'fix/cache → main', 'by octo', undefined],
			['Fix the cache', 'draft', 'Draft', 'Checks pending', 'fix/cache → main', 'by octo', undefined],
			// Checks of a pull request that is no longer open don't matter.
			['Fix the cache', 'merged', 'Merged', undefined, 'fix/cache → main', 'by octo', undefined],
			['Fix the cache', 'closed', 'Closed', undefined, 'fix/cache → main', 'by octo', undefined],
			['Crash', 'notPlanned', 'Not planned', undefined, undefined, 'by octo', undefined],
			[undefined, undefined, undefined, undefined, undefined, undefined, 'Loading...'],
			[undefined, undefined, undefined, undefined, undefined, undefined, 'Klawly needs access to this repository to show the pull request'],
			[undefined, undefined, undefined, undefined, undefined, undefined, undefined],
		]);
	});

	test('the pill takes its state once GitHub answered', () => {
		assert.deepStrictEqual([
			describePullRequestPill(pullRequest),
			describePullRequestPill(pullRequest, { status: 'loaded', details: pr('merged') }),
		], [
			{ label: '#7', state: undefined, ariaLabel: 'Pull request #7 in acme/app, opened in this chat' },
			{ label: '#7', state: 'merged', ariaLabel: 'Pull request #7 in acme/app, Merged, opened in this chat' },
		]);
	});

	test('REST answers become details, and malformed ones nothing', () => {
		assert.deepStrictEqual([
			pullRequestFromRest({ title: 'T', body: null, state: 'closed', merged_at: '2026-10-10T00:00:00Z', draft: false, user: { login: 'octo' }, head: { ref: 'h', sha: 'abc' }, base: { ref: 'main' } }),
			pullRequestFromRest({ title: 'T', state: 'open', draft: true, user: { login: 'octo' }, head: { ref: 'h', sha: 'abc' }, base: { ref: 'main' } })?.details.draft,
			pullRequestFromRest({ message: 'Not Found' }),
			issueFromRest({ title: 'I', body: 'B', state: 'closed', state_reason: 'completed', user: { login: 'octo' } }),
			issueFromRest('nope'),
		], [
			{ details: { kind: 'pullRequest', title: 'T', body: '', state: 'merged', draft: false, author: 'octo', headRef: 'h', baseRef: 'main' }, headSha: 'abc' },
			true,
			undefined,
			{ kind: 'issue', title: 'I', body: 'B', state: 'closed', notPlanned: false, author: 'octo' },
			undefined,
		]);
	});

	test('check runs sum up: any running is pending, else any failed is failure', () => {
		const runs = (...values: [string, string | null][]) => ({ check_runs: values.map(([status, conclusion]) => ({ status, conclusion })) });
		assert.deepStrictEqual([
			checksFromRest(runs(['completed', 'success'], ['in_progress', null])),
			checksFromRest(runs(['completed', 'success'], ['completed', 'timed_out'])),
			checksFromRest(runs(['completed', 'success'], ['completed', 'skipped'])),
			checksFromRest(runs()),
			checksFromRest(undefined),
		], ['pending', 'failure', 'success', undefined, undefined]);
	});
});
