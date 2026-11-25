/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CLAUDE_AGENTS_WINDOW_ENABLED_SETTING } from '../../../../../platform/claude/common/claudeAgentHost.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ClaudeAgentSession, IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudeChatShareService } from '../../browser/chat/claudeChatShare.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { CLAUDE_AGENTS_WINDOW } from '../../common/claudeContextKeys.js';
import { CLAUDE_OPEN_IN_AGENT_PANE_COMMAND_ID } from '../../common/claudeViews.js';
import { ClaudeSessionActions } from '../../browser/chat/claudeSessionActions.js';

suite('Klawly session actions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Open in Agents Window shows for a chat Claude Code answered while the Agents window is on, opens its session there, and waits for a running turn (issue 618)', async () => {
		const calls: string[] = [];
		let running = false;
		const configuration = new TestConfigurationService({ [CLAUDE_AGENTS_WINDOW_ENABLED_SETTING]: true });
		const actions = new ClaudeSessionActions(
			{ getViewState: () => ({ turns: [{ status: running ? 'running' : 'complete' }] }) } as unknown as IClaudeAgentService,
			{} as IQuickInputService,
			{} as IFileDialogService,
			{ info: () => calls.push('notice') } as unknown as INotificationService,
			{ linksEnabled: false } as IClaudeChatShareService,
			configuration,
			{ executeCommand: async (id: string, resource: unknown) => { calls.push(`${id} ${String(resource)}`); return undefined; } } as unknown as ICommandService,
			new MockContextKeyService(),
		);
		const answered = { id: 'tab', title: 'Fix login', claudeSessionId: 'cc-1' } as ClaudeAgentSession;
		const fresh = { id: 'fresh', title: 'New Agent' } as ClaudeAgentSession;
		const offered = (session: ClaudeAgentSession) => actions.actions(session, () => undefined).some(action => action.id === 'claude.history.openInAgentsWindow');
		const shown = { answered: offered(answered), fresh: offered(fresh) };
		const open = actions.actions(answered, () => undefined).find(action => action.id === 'claude.history.openInAgentsWindow')!;
		await open.run();
		running = true;
		await open.run();
		await configuration.setUserConfiguration(CLAUDE_AGENTS_WINDOW_ENABLED_SETTING, false);
		assert.deepStrictEqual({ shown, calls, whenOff: offered(answered) }, {
			shown: { answered: true, fresh: false },
			calls: ['workbench.action.chat.openSessionInAgentsWindow agent-host-claude:/cc-1', 'notice'],
			whenOff: false,
		});
	});

	test('Open in Agent Pane shows only in the Agents window, for a chat Claude Code answered, and runs the command on that chat (issue 1509)', async () => {
		const calls: string[] = [];
		const keys = new MockContextKeyService();
		const actions = new ClaudeSessionActions(
			{ resume: async (id: string) => { calls.push(`resume ${id}`); } } as unknown as IClaudeAgentService,
			{} as IQuickInputService,
			{} as IFileDialogService,
			{} as INotificationService,
			{ linksEnabled: false } as IClaudeChatShareService,
			new TestConfigurationService(),
			{ executeCommand: async (id: string) => { calls.push(id); return undefined; } } as unknown as ICommandService,
			keys,
		);
		const answered = { id: 'tab', title: 'Fix login', claudeSessionId: 'cc-1' } as ClaudeAgentSession;
		const fresh = { id: 'fresh', title: 'New Agent' } as ClaudeAgentSession;
		const find = (session: ClaudeAgentSession) => actions.actions(session, () => undefined).find(action => action.id === 'claude.history.openInAgentPane');
		const inIdeWindow = !!find(answered);
		CLAUDE_AGENTS_WINDOW.bindTo(keys).set(true);
		const inAgentsWindow = { answered: !!find(answered), fresh: !!find(fresh) };
		await find(answered)!.run();
		assert.deepStrictEqual({ inIdeWindow, inAgentsWindow, calls }, {
			inIdeWindow: false,
			inAgentsWindow: { answered: true, fresh: false },
			calls: ['resume tab', CLAUDE_OPEN_IN_AGENT_PANE_COMMAND_ID],
		});
	});
});
