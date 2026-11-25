/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeModelInfo } from '../../common/claude.js';
import { ClaudeAutoComplexity, claudeAutoModelPrompt, estimateClaudeAutoComplexity, pickClaudeAutoModel, readClaudeAutoClassification, readClaudeAutoOn } from '../../common/claudeAutoModel.js';

const models: ClaudeModelInfo[] = [
	{ id: 'default', displayName: 'Default', resolvedModel: 'claude-opus-5-5', source: 'runtime' },
	{ id: 'opus', displayName: 'Opus', source: 'runtime' },
	{ id: 'opus[1m]', displayName: 'Opus (1M context)', source: 'runtime' },
	{ id: 'sonnet', displayName: 'Sonnet', source: 'runtime' },
	{ id: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5', source: 'runtime', older: true },
	{ id: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-5-5', source: 'runtime' },
	{ id: 'my-haiku-proxy', displayName: 'my-haiku-proxy', source: 'custom' },
];

const COMPLEXITIES: readonly ClaudeAutoComplexity[] = ['simple', 'moderate', 'complex'];

suite('Claude Auto model (issue 521)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('simple, moderate and complex prompts all run on opus; only the effort changes (issue 1254)', () => {
		const table = COMPLEXITIES.map(complexity => {
			const pick = pickClaudeAutoModel(complexity, models);
			return `${pick?.modelId} ${pick?.effort}`;
		});
		assert.deepStrictEqual(table, ['opus low', 'opus medium', 'opus high']);
	});

	test('a family that is not offered falls to sonnet, then haiku', () => {
		const opusOnly = models.filter(model => model.id === 'opus');
		const noOpus = models.filter(model => model.id === 'sonnet' || model.id === 'haiku');
		assert.deepStrictEqual([
			pickClaudeAutoModel('simple', opusOnly)?.modelId,
			pickClaudeAutoModel('complex', noOpus)?.modelId,
			pickClaudeAutoModel('simple', models.filter(model => model.source === 'custom' || model.older || model.id === 'default')),
		], ['opus', 'sonnet', undefined]);
	});

	test('the local estimate rates short questions simple, design work complex, and a retry one level up', () => {
		const rate = (prompt: string, contextTokens?: number, retry?: boolean) => estimateClaudeAutoComplexity({ prompt, contextTokens, retry });
		assert.deepStrictEqual([
			rate('Why does this test fail?'),
			rate('what is a monad'),
			rate('Fix the off-by-one in readToken and add a test for it.'),
			rate('Refactor the storage layer so every service shares one cache.'),
			rate('Why does this test fail?', 120_000),
			rate('Why does this test fail?', undefined, true),
			rate(Array.from({ length: 25 }, (_, index) => `line ${index}`).join('\n')),
		], ['simple', 'simple', 'moderate', 'complex', 'complex', 'moderate', 'complex']);
	});

	test('the classifier answer and the setting are read strictly', () => {
		assert.deepStrictEqual([
			readClaudeAutoClassification({ complexity: 'complex', reason: '  Spans many files.  ' }),
			readClaudeAutoClassification({ complexity: 'trivial' }),
			readClaudeAutoClassification('simple'),
			readClaudeAutoClassification({ complexity: 'simple', reason: 'x'.repeat(300) })?.reason?.length,
			['auto', 'cost', 'balance', 'intelligence', 'off', undefined].map(readClaudeAutoOn),
		], [{ complexity: 'complex', reason: 'Spans many files.' }, undefined, undefined, 160, [true, true, true, true, false, false]]);
	});

	test('the classifier prompt carries the context size and the retry, and cuts a long request', () => {
		const prompt = claudeAutoModelPrompt({ prompt: 'a'.repeat(5000), contextTokens: 42_000, retry: true });
		assert.deepStrictEqual([
			prompt.includes('context: 42000.'),
			prompt.includes('failed: yes.'),
			prompt.includes(`${'a'.repeat(4000)}\n[...]`),
			prompt.includes('a'.repeat(4001)),
		], [true, true, true, false]);
	});
});
