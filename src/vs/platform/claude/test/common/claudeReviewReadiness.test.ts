/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeReviewPrompt, claudeReviewReadinessPrompt, formatClaudeReviewSummary, readClaudeReviewSettings } from '../../common/claudeReviewLoop.js';
import { CLAUDE_REVIEW_READINESS_RULE, claudeReviewReadinessBand, claudeReviewRiskArea, clampClaudeReviewReadinessScore, fallbackClaudeReviewReadiness, formatClaudeReviewReadiness, readClaudeReviewReadiness } from '../../common/claudeReviewReadiness.js';

suite('Claude review readiness (issue 920)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the clamp keeps a whole number from 0 to 5 and rejects non-numbers', () => {
		assert.deepStrictEqual([7, -3, 2.6, 2.4, 0, 5, NaN, Infinity, '4', null, undefined].map(clampClaudeReviewReadinessScore), [5, 0, 3, 2, 0, 5, undefined, undefined, undefined, undefined, undefined]);
	});

	test('the fallback score follows the rule', () => {
		const f = (file: string, severity: 'critical' | 'high' | 'medium' | 'low', kind?: 'finding' | 'question') => ({ file, severity, kind });
		const table: [string, ReturnType<typeof f>[], number, string][] = [
			['none', [], 5, 'No unresolved findings.'],
			['only questions', [f('a.ts', 'critical', 'question')], 5, 'No unresolved findings.'],
			['low', [f('a.ts', 'low')], 4, 'Highest severity is low.'],
			['medium', [f('a.ts', 'low'), f('b.ts', 'medium')], 3, 'Highest severity is medium.'],
			['high', [f('a.ts', 'high')], 2, 'Highest severity is high.'],
			['critical', [f('a.ts', 'critical')], 0, 'Highest severity is critical.'],
			['many', [f('a.ts', 'low'), f('b.ts', 'low'), f('c.ts', 'low'), f('d.ts', 'low')], 3, 'Highest severity is low, 4 findings.'],
			['auth', [f('src/auth/login.ts', 'high')], 1, 'Highest severity is high, touches auth.'],
			['floor', [f('db/migrations/1.sql', 'critical')], 0, 'Highest severity is critical, touches migrations.'],
		];
		assert.deepStrictEqual(table.map(([, findings]) => fallbackClaudeReviewReadiness(findings).score), table.map(row => row[2]));
		assert.deepStrictEqual(table.map(([, findings]) => fallbackClaudeReviewReadiness(findings).reason), table.map(row => row[3]));
	});

	test('the band follows the score (issue 1098)', () => {
		assert.deepStrictEqual([0, 2, 3, 4, 5].map(claudeReviewReadinessBand), ['notReady', 'notReady', 'reviewNeeded', 'reviewNeeded', 'ready']);
	});

	test('risk areas are found from the path', () => {
		assert.deepStrictEqual(['src/auth/token.ts', 'billing/invoice.ts', 'db/migrations/001.sql', 'src/util.ts'].map(claudeReviewRiskArea), ['auth', 'payments', 'migrations', undefined]);
	});

	test('the model score is clamped, its reason kept, and a bad score falls back', () => {
		const findings = [{ file: 'a.ts', severity: 'high' as const }];
		assert.deepStrictEqual([
			readClaudeReviewReadiness({ readiness: { score: 9, reason: ' Rule: high. ', riskArea: 'auth' } }, findings),
			readClaudeReviewReadiness({ readiness: { score: 3 } }, findings),
			readClaudeReviewReadiness({ readiness: { score: 'x', reason: 'ignored' } }, findings),
			readClaudeReviewReadiness({}, []),
		], [
			{ score: 5, reason: 'Rule: high.', riskArea: 'auth' },
			{ score: 3, reason: 'Highest severity is high.' },
			{ score: 2, reason: 'Highest severity is high.' },
			{ score: 5, reason: 'No unresolved findings.' },
		]);
	});

	test('the readiness line and the PR summary carry the score', () => {
		const readiness = { score: 3, reason: 'Medium finding.' };
		assert.strictEqual(formatClaudeReviewReadiness(readiness), 'Merge readiness 3/5: Medium finding.');
		assert.ok(formatClaudeReviewSummary({ overview: 'Adds x.', files: [] }, readiness).includes('**Merge readiness 3/5: Medium finding.**'));
		assert.ok(!formatClaudeReviewSummary({ overview: 'Adds x.', files: [] }).includes('readiness'));
	});

	test('the prompt asks for the score only when on', () => {
		assert.deepStrictEqual(claudeReviewReadinessPrompt(false), []);
		assert.deepStrictEqual(claudeReviewReadinessPrompt(true), [
			'',
			`Also fill "readiness": "score" is a whole number from 0 (do not merge) to 5 (ready to merge) and "reason" is one line that cites the rule you used. ${CLAUDE_REVIEW_READINESS_RULE} Name the area in "riskArea" when it applies. The score is advice only.`,
		]);
		assert.ok(claudeReviewPrompt('diff', undefined, { readiness: true }).includes('Also fill "readiness"'));
		assert.ok(!claudeReviewPrompt('diff', undefined, {}).includes('readiness'));
	});

	test('the setting is on by default and off when false', () => {
		assert.deepStrictEqual([readClaudeReviewSettings(() => undefined).showReadiness, readClaudeReviewSettings(key => key === 'claude.review.showReadiness' ? false : undefined).showReadiness], [true, false]);
	});
});
