/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { agentsWindowTitle } from '../../common/agentsWindowTitle.js';

suite('Agents window title (issue 1277)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('names the folder, or just Agents without one', () => {
		assert.deepStrictEqual([agentsWindowTitle('klawly'), agentsWindowTitle(undefined)], ['Agents - klawly', 'Agents']);
	});
});
