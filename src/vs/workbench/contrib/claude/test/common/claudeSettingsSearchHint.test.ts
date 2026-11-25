/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeSettingsPages, claudeSettingsSearchHint, searchClaudeSettings } from '../../common/claudeSettingsPages.js';

suite('Claude Settings search hint (issue 904)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('theme words point at the VS Code picker, whatever the case or the order', () => {
		const commandFor = (query: string) => claudeSettingsSearchHint(query)?.command;
		assert.deepStrictEqual(
			['theme', 'Theme', 'color theme', 'themes', 'dark mode', 'colour', 'icon theme', 'theme icons'].map(query => [query, commandFor(query)]),
			[
				['theme', 'workbench.action.selectTheme'],
				['Theme', 'workbench.action.selectTheme'],
				['color theme', 'workbench.action.selectTheme'],
				['themes', 'workbench.action.selectTheme'],
				['dark mode', 'workbench.action.selectTheme'],
				['colour', 'workbench.action.selectTheme'],
				['icon theme', 'workbench.action.selectIconTheme'],
				['theme icons', 'workbench.action.selectIconTheme'],
			],
		);
	});

	test('other searches get no hint, and a word inside another word is not a theme word', () => {
		assert.deepStrictEqual(['', 'zzz', 'permissions', 'highlight', 'lighthouse'].map(query => claudeSettingsSearchHint(query)), [undefined, undefined, undefined, undefined, undefined]);
	});

	test('"theme" matches no Klawly setting, so the hint is the answer', () => {
		assert.deepStrictEqual(searchClaudeSettings(claudeSettingsPages(), 'theme').map(match => match.row.id), []);
	});
});
