/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_INJECTED_INSTRUCTIONS } from '../../common/claudeInjectedInstructions.js';

suite('Injected instructions (issue 1172)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every text is shown and holds no URL, secret or user path', () => {
		assert.deepStrictEqual({
			count: CLAUDE_INJECTED_INSTRUCTIONS.length,
			empty: CLAUDE_INJECTED_INSTRUCTIONS.filter(entry => !entry.text.trim()).map(entry => entry.id),
			leaks: CLAUDE_INJECTED_INSTRUCTIONS.filter(entry => /https?:\/\/|[A-Za-z]:\|\/Users\/|\/home\/|sk-[A-Za-z0-9]|ghp_|@[a-z0-9-]+\.[a-z]{2,}/i.test(entry.text)).map(entry => entry.id),
		}, { count: 4, empty: [], leaks: [] });
	});
});
