/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudePermissionLevels, claudePermissionLevelToMigrate } from '../../common/claudePermissionLevels.js';

suite('Claude permission level migration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('an existing install keeps its level, a new one takes Strict', () => {
		assert.deepStrictEqual({
			newInstall: claudePermissionLevelToMigrate(true, undefined),
			existingUnset: claudePermissionLevelToMigrate(false, undefined),
			existingPicked: claudePermissionLevelToMigrate(false, 'acceptEdits'),
			levels: claudePermissionLevels().map(({ level, label }) => `${level}: ${label}`),
		}, {
			newInstall: undefined,
			existingUnset: 'prompt',
			existingPicked: undefined,
			levels: ['strict: Strict', 'prompt: Ask Before Edits', 'acceptEdits: Accept Edits', 'auto: Auto', 'allowEverythingExceptCredentials: Allow Everything Except Credentials', 'allowEverything: Allow Everything'],
		});
	});
});
