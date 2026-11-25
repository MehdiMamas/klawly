/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeEstimateCostUsd, claudeModelFamily } from '../../common/claudeModelPricing.js';

suite('Claude model pricing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('finds the family from an id or a name', () => {
		assert.deepStrictEqual(['claude-opus-5-5', 'Sonnet 5.5', 'claude-haiku-5-5', 'gpt-x', undefined].map(claudeModelFamily), ['opus', 'sonnet', 'haiku', undefined, undefined]);
	});

	test('prices input, output and cache reads and writes at their own rates', () => {
		const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
		assert.deepStrictEqual([
			claudeEstimateCostUsd('sonnet', tokens),
			claudeEstimateCostUsd('opus', { cacheWriteTokens: 1_000_000 }),
			claudeEstimateCostUsd('unknown', tokens),
		], [3 + 15 + 0.3 + 3.75, 18.75, undefined]);
	});
});
