/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeContextBreakdown } from '../../common/claudeProtocol.js';

/**
 * The composer's context ring opens what fills the window, read from Claude
 * Code's context report (issue 93). Only rows inside the window are shown.
 */
suite('Claude context breakdown', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps used, free and buffer rows; drops deferred, empty and unknown rows', () => {
		assert.deepStrictEqual(claudeContextBreakdown({
			totalTokens: 120000,
			maxTokens: 200000,
			categories: [
				{ name: 'System prompt', tokens: 3000, kind: 'used' },
				{ name: 'Messages', tokens: 117000, kind: 'used' },
				{ name: 'MCP tools (deferred)', tokens: 9000, kind: 'deferred' },
				{ name: 'Custom agents', tokens: 0, kind: 'used' },
				{ name: 'Something new', tokens: 10, kind: 'later' },
				{ name: 'Older report', tokens: 500, isDeferred: true },
				{ name: 'Autocompact buffer', tokens: 45000, kind: 'buffer' },
				{ name: 'Free space', tokens: 35000, kind: 'free' },
			],
		}), {
			usedTokens: 120000,
			windowTokens: 200000,
			categories: [
				{ name: 'System prompt', tokens: 3000, kind: 'used' },
				{ name: 'Messages', tokens: 117000, kind: 'used' },
				{ name: 'Autocompact buffer', tokens: 45000, kind: 'buffer' },
				{ name: 'Free space', tokens: 35000, kind: 'free' },
			],
		});
	});

	test('a report without a window is no breakdown', () => {
		assert.deepStrictEqual([
			claudeContextBreakdown(undefined),
			claudeContextBreakdown({ totalTokens: 10, maxTokens: 0, categories: [] }),
			claudeContextBreakdown({ totalTokens: Number.NaN, maxTokens: 1000, categories: [] }),
		], [undefined, undefined, undefined]);
	});
});
