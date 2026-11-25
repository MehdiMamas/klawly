/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CLAUDE_V5_COMMAND_ALIASES } from '../../common/claudeViews.js';

suite('v5 command aliases', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('each v5 id names one existing command, and no two v5 ids run the same one', () => {
		const targets = Object.values(CLAUDE_V5_COMMAND_ALIASES);
		assert.deepStrictEqual({
			shared: targets.length - new Set(targets).size,
			selfAlias: Object.entries(CLAUDE_V5_COMMAND_ALIASES).filter(([v5Id, id]) => v5Id === id).length,
			ids: Object.keys(CLAUDE_V5_COMMAND_ALIASES).sort(),
		}, { shared: 0, selfAlias: 0, ids: ['claude.checkpoint.restore', 'claude.review.findIssues', 'claude.review.keepAll'] });
	});
});
