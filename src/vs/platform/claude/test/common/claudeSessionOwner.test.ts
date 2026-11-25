/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeSessionBlockedBy } from '../../common/claudeSessionOwner.js';

suite('claudeSessionBlockedBy (v5 N5)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const live = [{ owner: 'pane-a', claudeSessionId: 'c1' }, { owner: 'pane-b', claudeSessionId: undefined }];

	test('one Claude Code session id runs in one view', () => {
		assert.deepStrictEqual([
			claudeSessionBlockedBy(live, 'c1', 'pane-c'),
			claudeSessionBlockedBy(live, 'c1', 'pane-a'),
			claudeSessionBlockedBy(live, 'c2', 'pane-c'),
			claudeSessionBlockedBy(live, undefined, 'pane-c'),
			claudeSessionBlockedBy([], 'c1', 'pane-c'),
		], ['pane-a', undefined, undefined, undefined, undefined]);
	});
});
