/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isFolderToOpen } from '../../../../../platform/window/common/window.js';
import { MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { CLAUDE_OPEN_IN_AGENT_PANE_COMMAND_ID } from '../../common/claudeViews.js';
import { claudeOpenInAgentPaneRequest } from '../../electron-browser/claudeAgentsWindowActions.js';

suite('Claude Agents window actions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Open in Agent Pane asks for an IDE window on the folder with the session', () => {
		const folder = URI.file('/repo');
		assert.deepStrictEqual(
			[claudeOpenInAgentPaneRequest(folder, 'abc-123'), claudeOpenInAgentPaneRequest(folder, undefined)].map(r => ({
				openables: r.openables.map(o => isFolderToOpen(o) ? o.folderUri.toString() : 'other'),
				forceNewWindow: r.options.forceNewWindow,
				session: r.options.chatSessionToOpen?.toString()
			})),
			[
				{ openables: ['file:///repo'], forceNewWindow: false, session: 'agent-host-claude:/abc-123' },
				{ openables: ['file:///repo'], forceNewWindow: false, session: undefined },
			]);
	});

	test('Open in Agent Pane is in the palette, and only usable in the Agents window', () => {
		const command = MenuRegistry.getCommand(CLAUDE_OPEN_IN_AGENT_PANE_COMMAND_ID);
		const keys = new Map<string, boolean>();
		const usable = () => command!.precondition!.evaluate({ getValue: <T>(key: string) => keys.get(key) as T | undefined });
		const inIdeWindow = usable();
		keys.set('claude.agentsWindow', true);
		assert.deepStrictEqual({ title: command?.title && typeof command.title !== 'string' ? command.title.value : undefined, inIdeWindow, inAgentsWindow: usable() }, {
			title: 'Open in Agent Pane', inIdeWindow: false, inAgentsWindow: true,
		});
	});
});
