/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { INativeWorkbenchEnvironmentService } from '../../../services/environment/electron-browser/environmentService.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { CLAUDE_AGENTS_WINDOW } from '../common/claudeContextKeys.js';
import { CLAUDE_AGENT_VIEW_ID } from '../common/claudeViews.js';

/**
 * What the Agents window shows (#1255): the agents list and the chat, nothing
 * of the IDE around them. `true` means the part is shown.
 */
export const CLAUDE_AGENTS_WINDOW_PARTS: ReadonlyMap<Parts, boolean> = new Map([
	[Parts.EDITOR_PART, false],
	[Parts.PANEL_PART, false],
	[Parts.ACTIVITYBAR_PART, false],
	[Parts.STATUSBAR_PART, false],
	// Hidden by default (#1522): the agents list is the Agent pane's column. The sidebar command still toggles it.
	[Parts.SIDEBAR_PART, false],
	[Parts.AUXILIARYBAR_PART, true],
]);

/** The setting the status bar follows; the layout has no part case for it. */
export const STATUS_BAR_VISIBLE_SETTING = 'workbench.statusBar.visible';

/** The setting that holds the window title template. */
export const WINDOW_TITLE_SETTING = 'window.title';

/** The Agents window's title template: "Agents Window", then the app name; never the folder name (#1522). */
export function claudeAgentsWindowTitleTemplate(): string {
	return localize('claudeAgentsWindowTitle', "Agents Window") + '${separator}${appName}';
}

/** The parts that are not in the Agents window's layout yet, as `[part, hidden]`. */
export function claudeAgentsWindowLayoutChanges(isVisible: (part: Parts) => boolean): [Parts, boolean][] {
	const changes: [Parts, boolean][] = [];
	for (const [part, shown] of CLAUDE_AGENTS_WINDOW_PARTS) {
		if (isVisible(part) !== shown) {
			changes.push([part, !shown]);
		}
	}
	return changes;
}

/** The wording of the quit prompt for `running` agents that would be stopped. */
export function claudeAgentsQuitPrompt(running: number): { message: string; detail: string; primaryButton: string } {
	return {
		message: running === 1
			? localize('claudeAgentsQuit.one', "An agent is still running. Quit anyway?")
			: localize('claudeAgentsQuit.many', "{0} agents are still running. Quit anyway?", running),
		detail: localize('claudeAgentsQuit.detail', "Quitting stops them. Work they have not finished is not completed."),
		primaryButton: localize({ key: 'claudeAgentsQuit.quit', comment: ['&& denotes a mnemonic'] }, "&&Quit"),
	};
}

/**
 * The next layout step to apply, or `undefined` when done. The status bar is not
 * a layout step (it follows a setting). Only one step is returned at a time, the
 * editor before the panel: hiding the editor while the panel is hidden brings the
 * panel back, so the caller re-reads visibility after every step.
 */
export function claudeAgentsWindowNextLayoutStep(isVisible: (part: Parts) => boolean): [Parts, boolean] | undefined {
	return claudeAgentsWindowLayoutChanges(isVisible).find(([part]) => part !== Parts.STATUSBAR_PART);
}

/**
 * In a window opened with `--agents-layout` (see `openAgentsWindow`), hides
 * the IDE parts and shows the agent chat, so the window stands alone.
 */
export class ClaudeAgentsWindowLayoutContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeAgentsWindowLayout';

	constructor(
		@INativeWorkbenchEnvironmentService environment: INativeWorkbenchEnvironmentService,
		@IWorkbenchLayoutService layout: IWorkbenchLayoutService,
		@IViewsService views: IViewsService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IConfigurationService configurationService: IConfigurationService,
		@IClaudeAgentService agent: IClaudeAgentService,
		@IDialogService dialogs: IDialogService,
		@ILifecycleService lifecycle: ILifecycleService,
	) {
		super();
		if (!environment.args['agents-layout']) {
			return;
		}
		CLAUDE_AGENTS_WINDOW.bindTo(contextKeys).set(true);
		// Closing the Agents window stops its running agents, so ask first.
		this._register(lifecycle.onBeforeShutdown(e => e.veto((async () => {
			const running = agent.getSessions().filter(session => agent.getViewState(session.id).turns.some(turn => turn.status === 'running')).length;
			if (running === 0) {
				return false;
			}
			const { confirmed } = await dialogs.confirm(claudeAgentsQuitPrompt(running));
			return !confirmed;
		})(), 'veto.claudeAgentsRunning')));
		// In memory, so the user's settings stay untouched.
		configurationService.updateValue(STATUS_BAR_VISIBLE_SETTING, false, ConfigurationTarget.MEMORY);
		configurationService.updateValue(WINDOW_TITLE_SETTING, claudeAgentsWindowTitleTemplate(), ConfigurationTarget.MEMORY);
		// Bounded: each step fixes one part, and a step may undo another (editor/panel).
		for (let i = 0; i < 2 * CLAUDE_AGENTS_WINDOW_PARTS.size; i++) {
			const step = claudeAgentsWindowNextLayoutStep(p => layout.isVisible(p, mainWindow));
			if (!step) {
				break;
			}
			layout.setPartHidden(step[1], step[0]);
		}
		views.openView(CLAUDE_AGENT_VIEW_ID, false);
	}
}
