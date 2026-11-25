/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeAutoModelEntryText, setClaudeAutoEnabled } from '../../common/claudeAutoSwitch.js';

suite('Klawly Auto switch', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('toggling Auto writes only the Auto setting and leaves the permission level alone (issue 1579)', async () => {
		const written: Array<[string, unknown]> = [];
		const writer = { updateValue: async (key: string, value: unknown, _target: unknown) => { written.push([key, value]); } };
		await setClaudeAutoEnabled(writer, true);
		await setClaudeAutoEnabled(writer, false);
		assert.deepStrictEqual(written, [['claude.auto.enabled', true], ['claude.auto.enabled', false]]);
	});

	test('the model picker entry is named Auto with a short description', () => {
		assert.deepStrictEqual(claudeAutoModelEntryText(), { label: 'Auto', description: 'Picks the model for each turn' });
	});
});
