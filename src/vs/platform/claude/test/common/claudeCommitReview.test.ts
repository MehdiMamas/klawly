/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_COMMIT_REVIEW_MAX_DIFF, claudeCommitFixDraft, claudeCommitReviewDiff, claudeFindingMarkerSeverity, claudeShortSha, lastClaudeReflogCommit, readClaudeReviewAfterCommit } from '../../common/claudeCommitReview.js';
import { ClaudeReviewFinding, claudeReviewPrompt, readClaudeReviewFindingsFromText, filterClaudeReviewFindings, readClaudeReviewCategories, readClaudeReviewSettings } from '../../common/claudeReviewLoop.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function line(old: string, next: string, action: string): string {
	return `${old} ${next} Klawly <klawly@example.com> 1760000000 +0000\t${action}`;
}

suite('Claude commit review', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only commits at the end of the reflog count', () => {
		const reflog = (last: string) => [line('0'.repeat(40), A, 'commit (initial): base'), last, ''].join('\n');
		assert.deepStrictEqual([
			lastClaudeReflogCommit(reflog(line(A, B, 'commit: fix the parser'))),
			lastClaudeReflogCommit(reflog(line(A, B, 'commit (amend): fix the parser'))),
			lastClaudeReflogCommit(reflog(line(A, B, 'commit (merge): Merge branch x'))),
			lastClaudeReflogCommit(reflog(line(B, C, 'checkout: moving from main to x'))),
			lastClaudeReflogCommit(reflog(line(B, C, 'reset: moving to HEAD~1'))),
			lastClaudeReflogCommit(reflog(line(B, C, 'rebase (pick): fix the parser'))),
			lastClaudeReflogCommit(''),
		], [
			{ sha: B, message: 'fix the parser' },
			{ sha: B, message: 'fix the parser' },
			{ sha: B, message: 'Merge branch x' },
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	test('setting, severity, cut diff and review notes', () => {
		const long = 'x'.repeat(CLAUDE_COMMIT_REVIEW_MAX_DIFF + 10);
		const prompt = claudeReviewPrompt('diff', ' Check SQL. ');
		assert.deepStrictEqual({
			settings: ['quick', 'deep', 'off', true, undefined].map(readClaudeReviewAfterCommit),
			severities: (['critical', 'high', 'medium', 'low'] as const).map(claudeFindingMarkerSeverity),
			short: claudeCommitReviewDiff('small'),
			cut: claudeCommitReviewDiff(long).endsWith('[The diff is cut here; read the rest with git show.]'),
			notes: prompt.includes('<project_review_notes>\nCheck SQL.\n</project_review_notes>'),
			noNotes: claudeReviewPrompt('diff', '  ').includes('project_review_notes'),
		}, {
			settings: ['quick', 'deep', 'off', 'off', 'off'],
			severities: [8, 8, 4, 2],
			short: 'small',
			cut: true,
			notes: true,
			noNotes: false,
		});
	});

	test('the short sha is seven characters', () => {
		assert.deepStrictEqual([claudeShortSha(A), claudeShortSha('abc')], ['aaaaaaa', 'abc']);
	});

	test('the fix draft names the commit and every finding', () => {
		const one = { file: 'src/a.ts', startLine: 3, endLine: 4, severity: 'high' as const, category: 'bug' as const, title: 'Unchecked input', body: 'It reaches the query.', suggestion: 'Validate it.' };
		const two = { file: 'src/b.ts', startLine: 9, endLine: 9, severity: 'low' as const, category: 'bug' as const, title: 'Naming', body: '' };
		const first = '- src/a.ts:3-4\n  Unchecked input\n  It reaches the query.\n  Suggested fix:\n  Validate it.';
		assert.deepStrictEqual([claudeCommitFixDraft(A, [one]), claudeCommitFixDraft(B, [one, two])], [
			'Claude reviewed commit aaaaaaa and left a finding on it. Address it, then say what you changed.\n\n' + first,
			'Claude reviewed commit bbbbbbb and left findings on it. Address each one, then say what you changed.\n\n' + first + '\n- src/b.ts:9\n  Naming',
		]);
	});

	test('an old review loads on the new scale, and the filter keeps what it must', () => {
		const old = [
			{ file: 'a.ts', startLine: 1, endLine: 1, severity: 'error', title: 'E', body: '' },
			{ file: 'a.ts', startLine: 2, endLine: 2, severity: 'warning', title: 'W', body: '' },
			{ file: 'a.ts', startLine: 3, endLine: 3, severity: 'info', title: 'I', body: '' },
		];
		const finding = (severity: ClaudeReviewFinding['severity'], category: ClaudeReviewFinding['category']): ClaudeReviewFinding => ({ file: 'a.ts', startLine: 1, endLine: 1, severity, category, title: 't', body: '' });
		const all = [finding('critical', 'style'), finding('low', 'security'), finding('high', 'bug'), finding('medium', 'style'), finding('low', 'bug'), finding('medium', 'tests')];
		const kept = (minSeverity: 'critical' | 'high' | 'medium' | 'low', categories: readonly ClaudeReviewFinding['category'][]) =>
			filterClaudeReviewFindings(all, { minSeverity, categories }).map(f => `${f.severity}/${f.category}`);
		assert.deepStrictEqual({
			legacy: readClaudeReviewFindingsFromText(JSON.stringify({ findings: old }))?.map(f => `${f.severity}/${f.category}`),
			all: kept('low', ['bug', 'tests', 'style']),
			high: kept('high', ['bug', 'tests', 'style']),
			noStyle: kept('low', ['bug', 'tests']),
			none: kept('critical', []),
			categories: [readClaudeReviewCategories(['style', 'nope', 'bug']), readClaudeReviewCategories('x').length],
			settings: readClaudeReviewSettings(key => ({ 'claude.review.minSeverity': 'high', 'claude.review.strictness': 'strict' } as Record<string, unknown>)[key]),
		}, {
			legacy: ['high/bug', 'medium/bug', 'low/bug'],
			all: ['critical/style', 'low/security', 'high/bug', 'medium/style', 'low/bug', 'medium/tests'],
			high: ['critical/style', 'low/security', 'high/bug'],
			noStyle: ['critical/style', 'low/security', 'high/bug', 'low/bug', 'medium/tests'],
			none: ['critical/style', 'low/security'],
			categories: [['bug', 'style'], 5],
			settings: { minSeverity: 'high', categories: ['security', 'bug', 'logic', 'performance', 'tests'], strictness: 'strict', summary: 'summary', showReadiness: true, useTickets: false, ticketPatterns: ['\\b[A-Z][A-Z0-9]+-\\d+\\b', '(?<![\\w&])#\\d+\\b'] },
		});
	});

	test('the prompt words each strictness, the categories and what is never suppressed', () => {
		const lines = (strictness: 'relaxed' | 'balanced' | 'strict') => claudeReviewPrompt('D', undefined, { strictness, categories: ['bug', 'style'] }).split('\n');
		assert.deepStrictEqual({
			relaxed: lines('relaxed')[4],
			balanced: lines('balanced')[4],
			strict: lines('strict')[4],
			categories: lines('strict')[5],
			never: lines('relaxed')[6],
			none: claudeReviewPrompt('D', undefined, { categories: [] }).split('\n')[5],
		}, {
			relaxed: 'Report only real problems in the changed code. An empty list is a valid answer. Be relaxed: report only problems you are sure about and that matter. Skip nitpicks, taste and anything speculative.',
			balanced: 'Report only real problems in the changed code. An empty list is a valid answer. Be balanced: report real problems and clear risks in the changed code. Skip pure taste.',
			strict: 'Report only real problems in the changed code. An empty list is a valid answer. Be strict: also report risks, edge cases, missing tests and anything a careful maintainer would push back on.',
			categories: 'Report these categories: bug, style.',
			never: 'Whatever the settings, always report security problems, memory leaks, null or undefined dereferences and infinite loops.',
			none: 'Report only security problems.',
		});
	});
});
