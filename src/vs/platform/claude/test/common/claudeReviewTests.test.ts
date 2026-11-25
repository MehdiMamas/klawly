/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeReviewPrompt, formatClaudeReviewSummary, readClaudeReviewSummary } from '../../common/claudeReviewLoop.js';
import { buildClaudeReproduceTestPrompt, buildClaudeWriteTestPrompt, CLAUDE_REVIEW_TEST_GAPS_MAX, claudeReviewReproduceChip, claudeReviewTestChip, formatClaudeReviewTestGaps, parseClaudeReviewTestResult, readClaudeReviewTestGaps } from '../../common/claudeReviewTests.js';

suite('Claude review tests (issue 936)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const gap = { file: 'src/a.ts', symbol: 'parse', caseDescription: 'empty input' };

	test('reads gaps: drops invalid rows, dedupes, trims, caps', () => {
		const many = Array.from({ length: 15 }, (_, i) => ({ file: 'f.ts', symbol: `s${i}`, caseDescription: 'c' }));
		assert.deepStrictEqual([
			readClaudeReviewTestGaps(undefined),
			readClaudeReviewTestGaps('x'),
			readClaudeReviewTestGaps([{ file: 'a.ts', symbol: 's' }, null, { file: 1, symbol: 's', caseDescription: 'c' }, { file: ' ', symbol: 's', caseDescription: 'c' }]),
			readClaudeReviewTestGaps([gap, { ...gap }, { file: ' src/a.ts ', symbol: 'parse', caseDescription: ' empty input ' }]),
			readClaudeReviewTestGaps(many).length,
		], [[], [], [], [gap], CLAUDE_REVIEW_TEST_GAPS_MAX]);
	});

	test('the Write Test prompt names the symbol, the case and the rules', () => {
		const prompt = buildClaudeWriteTestPrompt(gap);
		assert.deepStrictEqual([
			prompt.includes('`parse` in `src/a.ts`'),
			prompt.includes('Case: empty input'),
			/narrow test command/.test(prompt),
			/Do not change the code under test/.test(prompt),
		], [true, true, true, true]);
	});

	test('the Reproduce prompt carries the finding and asks for a failing test', () => {
		const prompt = buildClaudeReproduceTestPrompt({ file: 'src/b.ts', startLine: 7, title: 'Off by one', body: 'The loop skips the last row.' });
		assert.deepStrictEqual([
			prompt.includes('Off by one (`src/b.ts` line 7)'),
			prompt.includes('The loop skips the last row.'),
			/failing test/.test(prompt),
			/Do not change the code under test/.test(prompt),
			/`Test result: failed`/.test(prompt),
			/`Test result: passed`/.test(prompt),
		], [true, true, true, true, true, true]);
	});

	test('the Reproduce chip reads a failing test as Reproduced and a pass as unexpected', () => {
		assert.deepStrictEqual([
			claudeReviewReproduceChip('idle'),
			claudeReviewReproduceChip('sent'),
			claudeReviewReproduceChip(parseClaudeReviewTestResult('Test result: failed') ?? 'sent'),
			claudeReviewReproduceChip(parseClaudeReviewTestResult('Test result: passed') ?? 'sent'),
		], [
			undefined,
			{ key: 'sent', tone: 'info' },
			{ key: 'reproduced', tone: 'good' },
			{ key: 'unexpectedPass', tone: 'bad' },
		]);
	});

	test('chips map the state and hide while idle', () => {
		assert.deepStrictEqual([
			claudeReviewTestChip('idle'),
			claudeReviewTestChip('sent'),
			claudeReviewTestChip('passed'),
			claudeReviewTestChip('failed'),
		], [undefined, { key: 'sent', tone: 'info' }, { key: 'passed', tone: 'good' }, { key: 'failed', tone: 'bad' }]);
	});

	test('the summary keeps test gaps, copies them as Markdown and omits them when none', () => {
		const base = { overview: 'Adds a cache.', files: [{ path: 'a.ts', change: 'adds', risk: 'low' }] };
		const withGaps = readClaudeReviewSummary({ summary: { ...base, testGaps: [gap, { file: 'x' }] } });
		const without = readClaudeReviewSummary({ summary: { ...base, testGaps: [] } });
		assert.deepStrictEqual([withGaps?.testGaps, without?.testGaps], [[gap], undefined]);
		assert.ok(formatClaudeReviewSummary(withGaps!, undefined, false).includes('## Test Gaps\n\n- `parse` (`src/a.ts`): empty input'));
		assert.ok(!formatClaudeReviewSummary(without!, undefined, false).includes('Test Gaps'));
		assert.strictEqual(formatClaudeReviewTestGaps([{ ...gap, caseDescription: 'a\nb' }]), '## Test Gaps\n\n- `parse` (`src/a.ts`): a b');
	});

	test('the review prompt asks for test gaps only with a summary', () => {
		assert.ok(claudeReviewPrompt('diff', undefined, { summary: 'summary' }).includes('summary.testGaps'));
		assert.ok(!claudeReviewPrompt('diff', undefined, { summary: 'off' }).includes('summary.testGaps'));
	});

	suite('parseClaudeReviewTestResult', () => {
		test('reads the closing result line', () => {
			assert.deepStrictEqual([
				parseClaudeReviewTestResult('Added the test.\n\nTest result: passed (npm run test-node -- --run a.test.ts)'),
				parseClaudeReviewTestResult('Test result: FAILED, 1 failing'),
				parseClaudeReviewTestResult('**Test result:** `failed`'),
				parseClaudeReviewTestResult('Test result: failed\nFixed it.\nTest result: passed'),
				parseClaudeReviewTestResult('It passed or failed, who knows.'),
				parseClaudeReviewTestResult(''),
			], ['passed', 'failed', 'failed', 'passed', undefined, undefined]);
		});
	});
});
