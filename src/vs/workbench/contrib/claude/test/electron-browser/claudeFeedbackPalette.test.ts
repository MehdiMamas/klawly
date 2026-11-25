/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { matchesCommandAtWordStart } from '../../../../../platform/quickinput/browser/commandsQuickAccess.js';
import { CLAUDE_SEND_FEEDBACK_COMMAND_ID } from '../../common/claudeFeedback.js';
import { registerClaudeFeedback } from '../../electron-browser/claudeFeedback.js';

suite('Klawly Send Feedback in the Command Palette (issue 795)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('"bug" finds Send Feedback at a word start, so it ranks above the Debug commands that match only inside "Debug"', () => {
		if (!CommandsRegistry.getCommand(CLAUDE_SEND_FEEDBACK_COMMAND_ID)) {
			registerClaudeFeedback();
		}
		const title = MenuRegistry.getMenuItems(MenuId.CommandPalette).filter(isIMenuItem).find(item => item.command.id === CLAUDE_SEND_FEEDBACK_COMMAND_ID)?.command.title;
		const original = typeof title === 'string' ? title : title?.original ?? '';
		// The commands quick access shows "Category: Title" and keeps the English "Category: original" as the alias.
		const feedback = { label: 'Klawly: Send Feedback', commandAlias: `Klawly: ${original}` };
		const debug = [{ label: 'Debug: Start Debugging' }, { label: 'Debug: Toggle Breakpoint' }, { label: 'Debug: Open Link' }];
		assert.deepStrictEqual(
			['bug', 'report', 'feedback'].map(filter => [filter, matchesCommandAtWordStart(filter, feedback), debug.map(pick => matchesCommandAtWordStart(filter, pick))]),
			[['bug', true, [false, false, false]], ['report', true, [false, false, false]], ['feedback', true, [false, false, false]]],
		);
	});
});
