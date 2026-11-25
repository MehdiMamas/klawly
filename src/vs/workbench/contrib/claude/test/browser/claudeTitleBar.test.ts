/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Action } from '../../../../../base/common/actions.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandActionToggleInfo } from '../../../../../platform/action/common/action.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ICommandEvent, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ToggleAuxiliaryBarAction } from '../../../../browser/parts/auxiliarybar/auxiliaryBarActions.js';
import { ClaudeAgentsWindowPill, ClaudeSettingsGear, registerClaudeTitleBarActions } from '../../browser/titlebar/claudeTitleBar.js';
import { CLAUDE_NEW_SESSION_COMMAND_ID, CLAUDE_OPEN_AGENTS_WINDOW_COMMAND_ID, CLAUDE_OPEN_CHAT_IN_WINDOW_COMMAND_ID } from '../../common/claudeViews.js';

class RecordingCommandService implements ICommandService {
	declare readonly _serviceBrand: undefined;
	readonly onWillExecuteCommand: Event<ICommandEvent> = Event.None;
	readonly onDidExecuteCommand: Event<ICommandEvent> = Event.None;
	readonly ran: string[] = [];

	async executeCommand<R>(commandId: string): Promise<R | undefined> {
		this.ran.push(commandId);
		return undefined;
	}
}

suite('Klawly title bar', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function klawlyItems() {
		return [MenuId.LayoutControlMenu, MenuId.TitleBar].flatMap(menu => MenuRegistry.getMenuItems(menu).filter(isIMenuItem)
			.filter(item => [CLAUDE_NEW_SESSION_COMMAND_ID, CLAUDE_OPEN_CHAT_IN_WINDOW_COMMAND_ID, CLAUDE_OPEN_AGENTS_WINDOW_COMMAND_ID].includes(item.command.id))
			.map(item => [menu.id, item.command.id, item.group, item.order, item.when?.serialize()]));
	}

	test('New Agent leads the layout toggles and the Agents Window pill follows them, in the main window only', () => {
		const registration = registerClaudeTitleBarActions();
		const during = klawlyItems();
		registration.dispose();
		// New Agent sits in the layout toggles' own group, ordered before the first toggle (order 0),
		// so no separator splits them (#151). The pill opens VS Code's Agents window instead when
		// claude.agentsWindow.enabled is on, so one of its two items shows (DL-27, issue 617).
		assert.deepStrictEqual({ during, after: klawlyItems() }, {
			during: [
				['LayoutControlMenu', 'claude.newSession', 'navigation', -10, '!claude.agentDisabled && !isAuxiliaryWindow'],
				['TitleBar', 'claude.openChatInWindow', 'navigation', 100, '!claude.agentDisabled && !config.claude.agentsWindow.enabled && !isAuxiliaryWindow'],
				['TitleBar', 'claude.openAgentsWindow', 'navigation', 100, 'config.claude.agentsWindow.enabled && !claude.agentDisabled && !isAuxiliaryWindow'],
			],
			after: [],
		});
	});

	test('the secondary side bar toggle is named Toggle Agent in the title bar, the palette and the menus (issue 358)', () => {
		const command = MenuRegistry.getCommand(ToggleAuxiliaryBarAction.ID)!;
		const toggled = command.toggled as ICommandActionToggleInfo;
		const titleBar = MenuRegistry.getMenuItems(MenuId.LayoutControlMenu).filter(isIMenuItem)
			.filter(item => item.command.id === ToggleAuxiliaryBarAction.ID)
			.map(item => item.command.title);
		assert.deepStrictEqual({
			titleBar,
			palette: command.title,
			toggled: [toggled.title, toggled.mnemonicTitle],
		}, {
			titleBar: ['Toggle Agent', 'Toggle Agent'],
			palette: { value: 'Toggle Agent Visibility', original: 'Toggle Agent Visibility' },
			toggled: ['Hide Agent', '&&Agent'],
		});
	});

	test('the other secondary side bar commands say Agent too, so the palette uses one name for the pane (issue 358)', () => {
		const titles = Object.fromEntries([
			'workbench.action.closeAuxiliaryBar',
			'workbench.action.focusAuxiliaryBar',
			'workbench.action.previousAuxiliaryBarView',
			'workbench.action.nextAuxiliaryBarView',
			'workbench.action.maximizeAuxiliaryBar',
			'workbench.action.restoreAuxiliaryBar',
			'workbench.action.toggleMaximizedAuxiliaryBar',
		].map(id => {
			const title = MenuRegistry.getCommand(id)!.title;
			return [id, typeof title === 'string' ? title : title.value];
		}));
		const paneTitle = MenuRegistry.getMenuItems(MenuId.AuxiliaryBarTitle).filter(isIMenuItem)
			.filter(item => item.command.id === ToggleAuxiliaryBarAction.ID)
			.map(item => item.command.title);
		assert.deepStrictEqual({ titles, paneTitle }, {
			titles: {
				'workbench.action.closeAuxiliaryBar': 'Hide Agent',
				'workbench.action.focusAuxiliaryBar': 'Focus into Agent',
				'workbench.action.previousAuxiliaryBarView': 'Previous Agent View',
				'workbench.action.nextAuxiliaryBarView': 'Next Agent View',
				'workbench.action.maximizeAuxiliaryBar': 'Maximize Agent',
				'workbench.action.restoreAuxiliaryBar': 'Restore Agent',
				'workbench.action.toggleMaximizedAuxiliaryBar': 'Toggle Maximized Agent',
			},
			paneTitle: ['Hide Agent'],
		});
	});

	test('the Agents Window pill shows its icon and label and runs the action on click', async () => {
		let runs = 0;
		const action = store.add(new Action(CLAUDE_OPEN_CHAT_IN_WINDOW_COMMAND_ID, 'Agents Window', undefined, true, async () => { runs++; }));
		const pill = store.add(new ClaudeAgentsWindowPill(action, {}));
		const container = document.createElement('div');
		pill.render(container);
		const label = container.querySelector<HTMLElement>('.action-label')!;
		label.click();
		await Promise.resolve();
		assert.deepStrictEqual({
			item: [...container.classList],
			label: [...label.classList],
			parts: [...label.children].map(child => child.classList.contains('codicon-window') ? 'icon' : child.textContent),
			runs,
		}, {
			item: ['claude-root', 'claude-titlebar-pill-item'],
			label: ['action-label', 'claude-titlebar-pill'],
			parts: ['icon', 'Agents Window'],
			runs: 1,
		});
	});

	test('the title bar gear opens Klawly Settings', async () => {
		const commandService = new RecordingCommandService();
		const gear = store.add(new ClaudeSettingsGear({}, commandService));
		const container = document.createElement('div');
		gear.render(container);
		const label = container.querySelector<HTMLElement>('.action-label')!;
		label.click();
		await Promise.resolve();
		assert.deepStrictEqual({
			icon: label.classList.contains('codicon-settings-gear'),
			label: label.getAttribute('aria-label'),
			commands: commandService.ran,
		}, {
			icon: true,
			label: 'Klawly Settings',
			commands: ['claude.openSettings'],
		});
	});
});
