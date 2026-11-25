/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, reset } from '../../../../../base/browser/dom.js';
import { IActionViewItemOptions, ActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Action, IAction } from '../../../../../base/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { CLAUDE_AGENTS_WINDOW_ENABLED_SETTING } from '../../../../../platform/claude/common/claudeAgentHost.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { GLOBAL_ACTIVITY_ID } from '../../../../common/activity.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IsAuxiliaryWindowContext } from '../../../../common/contextkeys.js';
import { CLAUDE_AGENT_ENABLED } from '../../common/claudeContextKeys.js';
import { CLAUDE_NEW_SESSION_COMMAND_ID, CLAUDE_OPEN_AGENTS_WINDOW_COMMAND_ID, CLAUDE_OPEN_CHAT_IN_WINDOW_COMMAND_ID, CLAUDE_OPEN_SETTINGS_COMMAND_ID } from '../../common/claudeViews.js';

/** Only in the main window: the Agents window has its own title bar and no need to open itself. */
const MAIN_WINDOW_AGENT = ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, IsAuxiliaryWindowContext.negate());
/** Whether the pill opens VS Code's Agents window instead of the chat in its own window (DL-27). */
const AGENTS_WINDOW_ENABLED = ContextKeyExpr.has(`config.${CLAUDE_AGENTS_WINDOW_ENABLED_SETTING}`);

/**
 * The title bar's Klawly actions (ide-03): New Agent leads the layout toggles,
 * in the same run with no separator between them, and the Agents Window pill
 * follows them. Both can be hidden from the title bar's context menu like any
 * title bar action. The pill is one of two items in one place: the chat in its own
 * window, or with `claude.agentsWindow.enabled` on, VS Code's Agents window (DL-27).
 */
export function registerClaudeTitleBarActions(): IDisposable {
	const store = new DisposableStore();
	store.add(MenuRegistry.appendMenuItem(MenuId.LayoutControlMenu, {
		command: { id: CLAUDE_NEW_SESSION_COMMAND_ID, title: localize('claudeTitleBarNewAgent', "New Agent"), icon: Codicon.add },
		group: 'navigation',
		// Before the first layout toggle (order 0).
		order: -10,
		when: MAIN_WINDOW_AGENT,
	}));
	store.add(MenuRegistry.appendMenuItem(MenuId.TitleBar, {
		command: { id: CLAUDE_OPEN_CHAT_IN_WINDOW_COMMAND_ID, title: localize('claudeTitleBarAgentsWindow', "Agents Window"), tooltip: localize('claudeTitleBarAgentsWindowTooltip', "Open the agent in its own window"), icon: Codicon.window },
		group: 'navigation',
		order: 100,
		when: ContextKeyExpr.and(MAIN_WINDOW_AGENT, AGENTS_WINDOW_ENABLED.negate()),
	}));
	store.add(MenuRegistry.appendMenuItem(MenuId.TitleBar, {
		command: { id: CLAUDE_OPEN_AGENTS_WINDOW_COMMAND_ID, title: localize('claudeTitleBarAgentsWindow', "Agents Window"), tooltip: localize('claudeTitleBarAgentSessionsWindowTooltip', "Open your Claude sessions in the Agents window"), icon: Codicon.window },
		group: 'navigation',
		order: 100,
		when: ContextKeyExpr.and(MAIN_WINDOW_AGENT, AGENTS_WINDOW_ENABLED),
	}));
	return store;
}

/** A labelled pill rather than a bare icon, so the way into the Agents window reads at a glance. */
export class ClaudeAgentsWindowPill extends ActionViewItem {

	constructor(action: IAction, options: IActionViewItemOptions) {
		super(undefined, action, { ...options, icon: false, label: true });
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('claude-root', 'claude-titlebar-pill-item');
		this.label?.classList.add('claude-titlebar-pill');
	}

	protected override updateLabel(): void {
		if (this.label) {
			reset(this.label, renderIcon(Codicon.window), $('span.text', undefined, this.action.label));
		}
	}
}

/**
 * The gear at the end of the title bar opens Klawly Settings. It takes the place of the
 * Manage menu's gear, whose entries (Command Palette, Settings, Extensions, Themes, ...)
 * stay in File > Preferences and the Command Palette.
 */
export class ClaudeSettingsGear extends ActionViewItem {

	constructor(
		options: IActionViewItemOptions,
		@ICommandService commandService: ICommandService,
	) {
		const action = new Action(CLAUDE_OPEN_SETTINGS_COMMAND_ID, localize('claudeTitleBarSettings', "Klawly Settings"), ThemeIcon.asClassName(Codicon.settingsGear), true, () => commandService.executeCommand(CLAUDE_OPEN_SETTINGS_COMMAND_ID));
		super(undefined, action, { ...options, icon: true, label: false });
		this._register(action);
	}
}

/**
 * Renders the Agents Window title bar action as {@link ClaudeAgentsWindowPill}, and the
 * title bar's gear as {@link ClaudeSettingsGear}.
 */
export class ClaudeTitleBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.claudeTitleBar';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(registerClaudeTitleBarActions());
		for (const id of [CLAUDE_OPEN_CHAT_IN_WINDOW_COMMAND_ID, CLAUDE_OPEN_AGENTS_WINDOW_COMMAND_ID]) {
			this._register(actionViewItemService.register(MenuId.TitleBar, id, (action, options) => instantiationService.createInstance(ClaudeAgentsWindowPill, action, options)));
		}
		this._register(actionViewItemService.register(MenuId.TitleBar, GLOBAL_ACTIVITY_ID, (_action, options) => instantiationService.createInstance(ClaudeSettingsGear, options)));
	}
}
