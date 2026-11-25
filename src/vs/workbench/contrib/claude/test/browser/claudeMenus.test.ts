/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { registerClaudeMenuItems } from '../../browser/claudeMenus.js';

suite('Klawly menus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const menus: [string, MenuId][] = [
		['file', MenuId.MenubarFileMenu],
		['view', MenuId.MenubarViewMenu],
		['explorer', MenuId.ExplorerContext],
		['tab', MenuId.EditorTitleContext],
	];

	function klawlyItems() {
		return menus.flatMap(([name, id]) => MenuRegistry.getMenuItems(id).filter(isIMenuItem)
			.filter(item => item.command.id.startsWith('claude.') && item.group !== '3_goal')
			.map(item => [name, item.command.id, typeof item.command.title === 'string' ? item.command.title : item.command.title.value, item.group, item.order]));
	}

	test('File starts an agent or its window, View reaches the agent, and the Explorer and tabs send files to the current or a new agent', () => {
		const registration = registerClaudeMenuItems();
		const during = klawlyItems();
		registration.dispose();
		assert.deepStrictEqual({ during, after: klawlyItems() }, {
			during: [
				['file', 'claude.newSession', 'New A&&gent', '1_new', 2.5],
				['file', 'claude.openAgentsWindow', 'Open Agents Window', '1_new', 3.5],
				['view', 'claude.focusAgent', 'Agent', '3_views', 5],
				['explorer', 'claude.addFile', 'Add to Agent', '4_claude', 1],
				['explorer', 'claude.addFileToNewAgent', 'Add to New Agent', '4_claude', 2],
				['tab', 'claude.addFile', 'Add File to Agent', '2_claude', 1],
				['tab', 'claude.addFileToNewAgent', 'Add File to New Agent', '2_claude', 2],
			],
			after: [],
		});
	});
});
