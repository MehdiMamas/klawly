/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeFindingId, claudeReviewCliExitCode, claudeReviewLoopPrompt, claudeReviewMarkAddressed, claudeReviewMcpFindings, formatClaudeReviewCliOutput, parseClaudeReviewCliArgs } from '../../common/claudeReviewCli.js';
import { ClaudeReviewFinding } from '../../common/claudeReviewLoop.js';

suite('Claude review CLI', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const finding = (severity: ClaudeReviewFinding['severity'], extra: Partial<ClaudeReviewFinding> = {}): ClaudeReviewFinding => ({ file: 'src/a.ts', startLine: 4, endLine: 5, severity, category: 'bug', title: 'Null deref', body: 'x may be null', ...extra });

	test('arguments: defaults, flags, inline values and errors', () => {
		assert.deepStrictEqual(
			[
				parseClaudeReviewCliArgs([]),
				parseClaudeReviewCliArgs([], true),
				parseClaudeReviewCliArgs(['status', '--base=develop', '--depth', 'deep', '--text', '--fail-on', 'low']),
				parseClaudeReviewCliArgs(['--depth', 'slow']),
				parseClaudeReviewCliArgs(['--base', '--rm']),
				parseClaudeReviewCliArgs(['--nope']),
			],
			[
				{ command: 'review', base: 'main', depth: 'quick', format: 'json', failOn: 'high' },
				{ command: 'review', base: 'main', depth: 'quick', format: 'text', failOn: 'high' },
				{ command: 'status', base: 'develop', depth: 'deep', format: 'text', failOn: 'low' },
				{ error: '--depth is quick or deep' },
				{ error: '--base needs a branch name' },
				{ error: 'Unknown argument --nope' },
			]);
	});

	test('exit code: at or above fail-on, questions never count', () => {
		assert.deepStrictEqual(
			[
				claudeReviewCliExitCode([], 'high'),
				claudeReviewCliExitCode([finding('medium')], 'high'),
				claudeReviewCliExitCode([finding('high')], 'high'),
				claudeReviewCliExitCode([finding('low')], 'low'),
				claudeReviewCliExitCode([finding('critical', { kind: 'question' })], 'low'),
			],
			[0, 0, 1, 1, 0]);
	});

	test('output: JSON carries ids, text is one block per finding', () => {
		const json = JSON.parse(formatClaudeReviewCliOutput([finding('high')], 'json', 'abc1234'));
		assert.deepStrictEqual({ sha: json.reviewedSha, count: json.count, id: json.findings[0].id }, { sha: 'abc1234', count: 1, id: 'src/a.ts:4:null-deref' });
		assert.deepStrictEqual(
			[formatClaudeReviewCliOutput([], 'text'), formatClaudeReviewCliOutput([finding('high')], 'text')],
			['No findings.', 'HIGH src/a.ts:4 Null deref\n  x may be null']);
	});

	test('MCP: open findings are listed and marking them addressed changes only those', () => {
		const review = { reviewedSha: 'abc1234', findings: [{ finding: finding('high'), status: 'open' as const }, { finding: finding('low', { title: 'Other' }), status: 'open' as const }, { finding: finding('low', { title: 'Done' }), status: 'addressed' as const }] };
		assert.deepStrictEqual(claudeReviewMcpFindings(review).map(item => item.id), ['src/a.ts:4:null-deref', 'src/a.ts:4:other']);
		const result = claudeReviewMarkAddressed(review, [claudeFindingId(finding('high')), 7, 'nope']);
		assert.deepStrictEqual({ changed: result.changed, left: claudeReviewMcpFindings(result.review).map(item => item.title) }, { changed: 1, left: ['Other'] });
	});

	test('the loop prompt names the round cap and asks before the first edit', () => {
		const prompt = claudeReviewLoopPrompt(3);
		assert.deepStrictEqual([prompt.includes('3 rounds'), prompt.includes('ask me to confirm'), prompt.includes('Never push or merge')], [true, true, true]);
	});
});
