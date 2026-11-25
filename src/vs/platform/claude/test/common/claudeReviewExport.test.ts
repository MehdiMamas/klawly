/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_REVIEW_DEFAULT_CATEGORIES, ClaudeReviewFinding, formatClaudeReviewMarkdown, formatClaudeReviewSarif } from '../../common/claudeReviewLoop.js';

suite('Claude review export (issue 938)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const filter = { minSeverity: 'medium' as const, categories: CLAUDE_REVIEW_DEFAULT_CATEGORIES };
	const findings: ClaudeReviewFinding[] = [
		{ file: 'b.ts', startLine: 4, endLine: 6, severity: 'medium', category: 'logic', title: 'Off by one', body: 'The loop skips the last item.', suggestion: 'i <= n' },
		{ file: 'a.ts', startLine: 1, endLine: 1, severity: 'critical', category: 'bug', title: 'Crash', body: 'Null deref.' },
		{ file: 'c.ts', startLine: 9, endLine: 9, severity: 'low', category: 'style', title: 'Naming', body: 'Hidden by the filter.' },
	];
	const sha = '0123456789abcdef0123456789abcdef01234567';

	test('Markdown lists the filtered findings, worst first, with score and commit', () => {
		assert.strictEqual(formatClaudeReviewMarkdown(findings, filter, { commitSha: sha, readinessScore: 4, readinessReason: 'One medium finding.', summary: { overview: 'Adds a loop.', files: [] } }), [
			'# Klawly Review',
			'',
			`Commit: \`${sha}\``,
			'',
			'Readiness: 4/5 - One medium finding.',
			'',
			'## Findings (2)',
			'',
			'### CRITICAL: Crash',
			'',
			'`a.ts:1` · bug',
			'',
			'Null deref.',
			'',
			'### MEDIUM: Off by one',
			'',
			'`b.ts:4-6` · logic',
			'',
			'The loop skips the last item.',
			'',
			'```',
			'i <= n',
			'```',
			'',
		].join('\n').replace('## Findings', '## Summary\n\nAdds a loop.\n\n## Findings'));
	});

	test('Markdown says so when nothing passes the filter', () => {
		assert.strictEqual(formatClaudeReviewMarkdown([], filter), '# Klawly Review\n\n## Findings (0)\n\nNo findings.\n');
	});

	test('SARIF 2.1 maps severities to levels and carries the commit and score', () => {
		const sarif = JSON.parse(formatClaudeReviewSarif(findings, filter, { commitSha: sha, readinessScore: 4, readinessReason: 'One medium finding.' }));
		assert.deepStrictEqual({
			version: sarif.version,
			results: sarif.runs[0].results,
			revision: sarif.runs[0].versionControlProvenance,
			properties: sarif.runs[0].properties,
		}, {
			version: '2.1.0',
			results: [
				{ ruleId: 'bug', level: 'error', message: { text: 'Crash\n\nNull deref.' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'a.ts' }, region: { startLine: 1, endLine: 1 } } }] },
				{ ruleId: 'logic', level: 'warning', message: { text: 'Off by one\n\nThe loop skips the last item.\n\nSuggestion:\ni <= n' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'b.ts' }, region: { startLine: 4, endLine: 6 } } }] },
			],
			revision: [{ revisionId: sha }],
			properties: { commitSha: sha, readinessScore: 4, readinessReason: 'One medium finding.' },
		});
	});

	test('SARIF maps high to error and low to note', () => {
		const all = { minSeverity: 'low' as const, categories: ['style' as const, 'logic' as const] };
		const levels = JSON.parse(formatClaudeReviewSarif([{ ...findings[0], severity: 'high' }, findings[2]], all)).runs[0].results.map((result: { level: string }) => result.level);
		assert.deepStrictEqual(levels, ['error', 'note']);
	});
});
