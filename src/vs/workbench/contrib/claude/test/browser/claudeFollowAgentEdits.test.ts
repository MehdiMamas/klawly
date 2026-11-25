/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeFollowAction } from '../../browser/claudeFollowAction.js';

suite('Claude follow agent edits', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('follows only when on, and never steals focus from typing', () => {
		assert.deepStrictEqual([claudeFollowAction(false, false), claudeFollowAction(false, true), claudeFollowAction(true, false), claudeFollowAction(true, true)], ['none', 'none', 'open', 'pill']);
	});
});
