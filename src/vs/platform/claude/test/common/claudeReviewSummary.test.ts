/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_REVIEW_SUMMARY_SETTING, claudeReviewPrompt, formatClaudeReviewSummary, readClaudeReviewSettings, readClaudeReviewSummary } from '../../common/claudeReviewLoop.js';

suite('Claude review summary (issue 918)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the parser reads a summary, drops bad rows and returns nothing without one', () => {
		assert.deepStrictEqual([
			readClaudeReviewSummary(undefined),
			readClaudeReviewSummary({ summary: { files: [] } }),
			readClaudeReviewSummary({ summary: { overview: '  ' } }),
			readClaudeReviewSummary({
				summary: {
					overview: 'Adds a retry.',
					files: [{ path: 'a.ts', change: 'Retries', risk: 'high' }, { path: 'b.ts', change: 'Docs' }, { change: 'no path' }, { path: 'c.ts' }],
					description: 'New body',
				}
			}),
			readClaudeReviewSummary({ summary: { overview: 'Only text.', description: '' } }),
		], [
			undefined,
			undefined,
			undefined,
			{
				overview: 'Adds a retry.',
				files: [{ path: 'a.ts', change: 'Retries', risk: 'high' }, { path: 'b.ts', change: 'Docs', risk: 'low' }],
				description: 'New body',
			},
			{ overview: 'Only text.', files: [] },
		]);
	});

	test('the Markdown formatter writes the overview and a file table', () => {
		assert.strictEqual(formatClaudeReviewSummary({
			overview: 'Adds a retry.',
			files: [{ path: 'a.ts', change: 'Retries | twice', risk: 'high' }, { path: 'b.ts', change: 'Docs\nonly', risk: 'low' }],
		}), [
			'## Summary',
			'',
			'Adds a retry.',
			'',
			'<details>',
			'<summary>Files changed (2)</summary>',
			'',
			'| File | Change | Risk |',
			'| --- | --- | --- |',
			'| `a.ts` | Retries \\| twice | high |',
			'| `b.ts` | Docs only | low |',
			'',
			'</details>',
		].join('\n'));
	});

	test('the Markdown formatter adds the proposed description only when asked (issue 1088)', () => {
		const summary = { overview: 'Adds a retry.', files: [], description: 'New body' };
		const without = formatClaudeReviewSummary(summary);
		const withIt = formatClaudeReviewSummary(summary, undefined, true);
		assert.deepStrictEqual({ without: without.includes('Proposed Pull Request Description'), withIt: withIt.endsWith(['', '## Proposed Pull Request Description', '', 'New body'].join('\n')) },{ without: false, withIt: true });
	});

	test('the setting defaults to a summary and the prompt asks for it by mode', () => {
		const prompt = (mode: 'off' | 'summary' | 'summaryAndDescription') => claudeReviewPrompt('diff', undefined, { summary: mode });
		assert.deepStrictEqual([
			readClaudeReviewSettings(() => undefined).summary,
			readClaudeReviewSettings(key => key === CLAUDE_REVIEW_SUMMARY_SETTING ? 'off' : undefined).summary,
			readClaudeReviewSettings(key => key === CLAUDE_REVIEW_SUMMARY_SETTING ? 'nope' : undefined).summary,
			prompt('off').includes('"summary"'),
			prompt('summary').includes('"overview"'),
			prompt('summary').includes('summary.description'),
			prompt('summaryAndDescription').includes('summary.description'),
		], ['summary', 'off', 'summary', false, true, false, true]);
	});
});
