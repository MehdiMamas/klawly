/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { buildClaudeReviewContextPack, claudeChangedSymbols, claudeDiffPaths, claudeReviewInstructionsWithContext, readClaudeReviewImpactContext } from '../../common/claudeReviewContext.js';

suite('Claude review context pack', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const diff = [
		'diff --git a/src/a.ts b/src/a.ts',
		'--- a/src/a.ts',
		'+++ b/src/a.ts',
		'@@ -10,3 +10,4 @@ export class Widget {',
		'-export function renderWidget(a: string) {',
		'+export function renderWidget(a: string, b: number) {',
		'+	if (b) {',
		'+	}',
		'+	const helperValue = 4;',
	].join('\n');

	test('the changed symbols come from hunk headers and changed declarations, once each', () => {
		assert.deepStrictEqual(claudeChangedSymbols(diff), [
			{ name: 'Widget', path: 'src/a.ts' },
			{ name: 'renderWidget', path: 'src/a.ts' },
			{ name: 'helperValue', path: 'src/a.ts' },
		]);
		assert.deepStrictEqual([...claudeDiffPaths(diff)], ['src/a.ts']);
	});

	test('references inside changed files are dropped and the summary counts the rest', () => {
		const pack = buildClaudeReviewContextPack(
			[{ name: 'renderWidget', path: 'src/a.ts' }],
			[
				{ symbol: 'renderWidget', path: 'src/b.ts', line: 41, text: '  renderWidget(x);' },
				{ symbol: 'renderWidget', path: 'src/a.ts', line: 3, text: 'renderWidget(y)' },
			],
			new Set(['src/a.ts']));
		assert.deepStrictEqual({ summary: pack?.summary, count: pack?.referenceCount, cites: pack?.text.includes('- src/b.ts:41  renderWidget(x);'), self: pack?.text.includes('src/a.ts:3') },
			{ summary: 'Looked at 1 reference to 1 changed symbol in 1 other file', count: 1, cites: true, self: false });
	});

	test('the pack is cut to its budget and stays closed', () => {
		const references = Array.from({ length: 8 }, (_, index) => ({ symbol: 'renderWidget', path: `src/c${index}.ts`, line: index + 1, text: 'x'.repeat(150) }));
		const pack = buildClaudeReviewContextPack([{ name: 'renderWidget', path: 'src/a.ts' }], references, new Set(), undefined, 500);
		assert.deepStrictEqual({ short: (pack?.text.length ?? 0) <= 500, closed: pack?.text.endsWith('</impact_context>') }, { short: true, closed: true });
	});

	test('nothing found means no pack, and the graph summary alone is enough', () => {
		assert.strictEqual(buildClaudeReviewContextPack([], [], new Set()), undefined);
		assert.strictEqual(buildClaudeReviewContextPack([], [], new Set(), 'api -> store')?.text.includes('api -> store'), true);
	});

	test('instructions take the pack after the notes; the setting defaults to symbols', () => {
		const pack = buildClaudeReviewContextPack([], [], new Set(), 'g');
		assert.strictEqual(claudeReviewInstructionsWithContext('notes', undefined), 'notes');
		assert.strictEqual(claudeReviewInstructionsWithContext('notes', pack)?.startsWith('notes\n\n<impact_context>'), true);
		assert.deepStrictEqual(['off', 'symbolsAndPatterns', 'x', undefined].map(readClaudeReviewImpactContext), ['off', 'symbolsAndPatterns', 'symbols', 'symbols']);
	});
});
