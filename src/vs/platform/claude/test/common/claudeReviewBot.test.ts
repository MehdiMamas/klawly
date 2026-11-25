/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { appendClaudeReviewRule, claudeFixOnBranchPrompt, claudeMentionPromptLines, claudeRememberRules, claudeReviewConfirmDetail, formatClaudeGitHubReview, parseClaudePullRequestUrl, parseClaudeReviewMention } from '../../common/claudeReviewBot.js';
import { CLAUDE_REVIEW_CATEGORIES, ClaudeReviewFilter, ClaudeReviewFinding } from '../../common/claudeReviewLoop.js';
import { readClaudeReviewedSha } from '../../common/claudeReviewPersist.js';

const filter: ClaudeReviewFilter = { minSeverity: 'low', categories: CLAUDE_REVIEW_CATEGORIES };

function finding(extra: Partial<ClaudeReviewFinding>): ClaudeReviewFinding {
	return { file: './src/a.ts', startLine: 4, endLine: 4, severity: 'high', category: 'bug', title: 'Off by one', body: 'The loop skips the last item.', ...extra };
}

suite('Klawly review bot (issue 872)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the review has the summary on top and an inline comment per finding, with a suggestion block when there is a fix', () => {
		const review = formatClaudeGitHubReview([
			finding({ suggestion: 'for (i = 0; i <= n; i++)' }),
			finding({ file: 'src/b.ts', startLine: 10, endLine: 12, severity: 'low', category: 'style', title: 'Name' }),
		], filter, { readinessScore: 80 });
		assert.deepStrictEqual({
			event: review.event,
			top: review.body.includes('Readiness: 80/100') && review.body.includes('2 findings'),
			single: [review.comments[0].path, review.comments[0].line, review.comments[0].start_line],
			suggestion: review.comments[0].body.includes('```suggestion\nfor (i = 0; i <= n; i++)\n```'),
			multi: [review.comments[1].line, review.comments[1].start_line, review.comments[1].body.includes('suggestion')],
		}, { event: 'COMMENT', top: true, single: ['src/a.ts', 4, undefined], suggestion: true, multi: [12, 10, false] });
	});

	test('a suggestion containing a fence gets a longer fence, and no findings says so', () => {
		const review = formatClaudeGitHubReview([finding({ suggestion: 'x\n```\ny' })], filter);
		assert.ok(review.comments[0].body.includes('````suggestion'));
		assert.ok(formatClaudeGitHubReview([], filter).body.includes('No findings.'));
	});

	test('a review posted against a commit ends with where it stopped, so the next one starts there (issue 927)', () => {
		const sha = '0123456789abcdef0123456789abcdef01234567';
		const body = formatClaudeGitHubReview([finding({})], filter, { commitSha: sha }).body;
		assert.deepStrictEqual({
			line: body.includes('Reviewed up to 0123456.'),
			marker: readClaudeReviewedSha([body]),
			without: readClaudeReviewedSha([formatClaudeGitHubReview([finding({})], filter).body]),
		}, { line: true, marker: sha, without: undefined });
	});

	test('the confirm detail lists the top comment and every line comment as GitHub gets them', () => {
		const review = formatClaudeGitHubReview([finding({}), finding({ file: 'b.ts', startLine: 2, endLine: 5, title: 'Leak' })], filter);
		const detail = claudeReviewConfirmDetail(review);
		assert.ok(detail.includes('src/a.ts:4') && detail.includes('b.ts:2-5') && detail.includes('Off by one') && detail.includes('Leak'));
	});

	test('the fix prompt names the pull request, checks out its head branch, and never pushes', () => {
		const target = { owner: 'acme', repo: 'app', number: 7 };
		const withBranch = claudeFixOnBranchPrompt(finding({ suggestion: 'i <= n' }), { ...target, headRef: 'fix/cache' });
		const withoutBranch = claudeFixOnBranchPrompt(finding({}), { ...target, headRef: 'bad; rm -rf /' });
		assert.deepStrictEqual({
			names: withBranch.includes('acme/app#7') && withBranch.includes('git checkout -B fix/cache FETCH_HEAD'),
			suggestion: withBranch.includes('i <= n') && !withBranch.includes('```suggestion'),
			fallback: withoutBranch.includes('gh pr checkout 7') && !withoutBranch.includes('rm -rf'),
			noPush: withBranch.includes('Do not push'),
		}, { names: true, suggestion: true, fallback: true, noPush: true });
	});

	test('@klawly remember rules come out of comments once each, in order', () => {
		assert.deepStrictEqual(claudeRememberRules(['@klawly remember Use tabs.', 'looks good', '@klawly remember  use   TABS.', '@klawly review', '@klawly remember Name tests by behavior.']), ['Use tabs.', 'Name tests by behavior.']);
	});

	test('a pull request link parses to owner, repo and number; anything else does not', () => {
		assert.deepStrictEqual(parseClaudePullRequestUrl(' https://github.com/acme/app/pull/7/files'), { owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/pull/7' });
		assert.deepStrictEqual([parseClaudePullRequestUrl('https://github.com/acme/app/issues/7'), parseClaudePullRequestUrl('https://example.com/acme/app/pull/7'), parseClaudePullRequestUrl('https://github.com/acme/app/pull/new/x')], [undefined, undefined, undefined]);
	});

	test('mentions: review, quick, deep, a question, remember, and none', () => {
		assert.deepStrictEqual([
			parseClaudeReviewMention('please @klawly review'),
			parseClaudeReviewMention('@klawly review deep'),
			parseClaudeReviewMention('@Klawly review Quick.'),
			parseClaudeReviewMention('@klawly review is this thread-safe?'),
			parseClaudeReviewMention('@klawly remember we always use tabs'),
			parseClaudeReviewMention('@klawly remember'),
			parseClaudeReviewMention('hello'),
		], [
			{ kind: 'review' },
			{ kind: 'review', depth: 'deep' },
			{ kind: 'review', depth: 'quick' },
			{ kind: 'review', question: 'is this thread-safe?' },
			{ kind: 'remember', rule: 'we always use tabs' },
			undefined,
			undefined,
		]);
	});

	test('the prompt gets a focus line for a question or a depth, none for a plain review', () => {
		assert.deepStrictEqual([
			claudeMentionPromptLines({ kind: 'review' }).length,
			claudeMentionPromptLines({ kind: 'review', question: 'is it safe?' })[0],
			claudeMentionPromptLines({ kind: 'review', depth: 'deep' }).length,
			claudeMentionPromptLines({ kind: 'remember', rule: 'x' }).length,
		], [0, 'Focus on this question as well: is it safe?', 1, 0]);
	});

	test('a rule is appended to REVIEW.md once, as one bullet', () => {
		const first = appendClaudeReviewRule(undefined, '  - Use  tabs ');
		const again = appendClaudeReviewRule(first.text, 'use tabs');
		const more = appendClaudeReviewRule(first.text, 'No any');
		assert.deepStrictEqual([first, again.added, more.text], [{ text: '# Review rules\n\n- Use tabs\n', added: true }, false, '# Review rules\n\n- Use tabs\n- No any\n']);
	});
});
