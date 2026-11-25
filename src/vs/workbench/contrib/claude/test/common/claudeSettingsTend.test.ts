/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeSettingsPages } from '../../common/claudeSettingsPages.js';

suite('Claude settings: Tend This PR', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the Tend This PR group lists its three settings', () => {
		const rows = claudeSettingsPages().flatMap(page => page.sections.filter(section => section.id === 'tend').flatMap(section => section.rows));
		assert.deepStrictEqual(rows.map(row => row.key), ['claude.tend.pollSeconds', 'claude.tend.maxTurns', 'claude.tend.ignoreAuthors']);
		assert.deepStrictEqual(rows.slice(0, 2).map(row => row.title), ['Check Interval', 'Turn Limit']);
	});
});
