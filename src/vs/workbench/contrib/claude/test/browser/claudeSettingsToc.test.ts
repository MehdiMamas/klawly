/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ISetting, ISettingsGroup } from '../../../../services/preferences/common/preferences.js';
import { tocData } from '../../../preferences/browser/settingsLayout.js';
import { resolveSettingsTree, withChatTocEntry } from '../../../preferences/browser/settingsTree.js';

suite('Classic Settings table of contents', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
	const setting = (key: string): ISetting => ({ range, key, keyRange: range, value: undefined, valueRange: range, description: [], descriptionRanges: [] });
	const group: ISettingsGroup = {
		id: 'core',
		range,
		title: 'Core',
		titleRange: range,
		sections: [{ settings: ['editor.fontSize', 'security.workspace.trust.enabled', 'chat.agent.enabled', 'claude.agent.runtime'].map(setting) }]
	};

	test('lists the claude settings under AI / Claude, last, and leaves out upstream Chat', () => {
		const { tree, leftoverSettings } = resolveSettingsTree(tocData, [group], undefined, new NullLogService());
		assert.deepStrictEqual({
			groups: tree.children?.map(child => child.label),
			claude: tree.children?.find(child => child.id === 'claude')?.settings?.map(s => s.key),
			leftover: [...leftoverSettings].map(s => s.key),
		}, {
			groups: ['Text Editor', 'Security', 'AI / Claude'],
			claude: ['claude.agent.runtime'],
			leftover: ['chat.agent.enabled'],
		});
	});

	test('lists upstream Chat before AI / Claude while upstream chat is on', () => {
		const { tree, leftoverSettings } = resolveSettingsTree(withChatTocEntry(tocData), [group], undefined, new NullLogService());
		assert.deepStrictEqual({
			groups: tree.children?.map(child => child.label),
			leftover: [...leftoverSettings].map(s => s.key),
			layoutUnchanged: tocData.children?.find(child => child.id === 'chat')?.hide,
		}, {
			groups: ['Text Editor', 'Chat', 'Security', 'AI / Claude'],
			leftover: [],
			layoutUnchanged: true,
		});
	});
});
