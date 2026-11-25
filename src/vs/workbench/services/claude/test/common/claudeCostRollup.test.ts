/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeAutoHelperTier, claudeDescendantCost, claudeRolledUpCost } from '../../common/claudeDelegation.js';

suite('Claude cost roll-up (issue 848)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const nodes = [
		{ sessionId: 'a', parentSessionId: 'root', costUsd: 0.1 },
		{ sessionId: 'b', parentSessionId: 'a', costUsd: 0.2 },
		{ sessionId: 'c', parentSessionId: 'b', costUsd: 0.3 },
		{ sessionId: 'other', parentSessionId: 'elsewhere', costUsd: 9 },
		{ sessionId: 'free', parentSessionId: 'root' },
	];

	test('adds nested descendants and ignores other trees', () => {
		assert.strictEqual(Math.round((claudeDescendantCost('root', nodes) ?? 0) * 100), 60);
		assert.strictEqual(Math.round((claudeRolledUpCost('root', 1, nodes) ?? 0) * 100), 160);
		assert.strictEqual(Math.round((claudeDescendantCost('a', nodes) ?? 0) * 100), 50);
	});

	test('undefined when nothing reported a cost', () => {
		assert.strictEqual(claudeDescendantCost('free', nodes), undefined);
		assert.strictEqual(claudeRolledUpCost('free', undefined, nodes), undefined);
		assert.strictEqual(claudeRolledUpCost('free', 0.5, nodes), 0.5);
		assert.strictEqual(claudeRolledUpCost('root', undefined, nodes) !== undefined, true);
	});

	test('a loop in the links ends', () => {
		const loop = [{ sessionId: 'x', parentSessionId: 'y', costUsd: 1 }, { sessionId: 'y', parentSessionId: 'x', costUsd: 2 }];
		assert.strictEqual(claudeDescendantCost('x', loop), 2);
	});

	test('Auto helpers default to Sonnet unless the picker chose a tier', () => {
		assert.strictEqual(claudeAutoHelperTier(undefined, false), 'medium');
		assert.strictEqual(claudeAutoHelperTier(undefined, true), 'small');
		assert.strictEqual(claudeAutoHelperTier('large', false), 'large');
		assert.strictEqual(claudeAutoHelperTier('small', false), 'small');
	});
});
