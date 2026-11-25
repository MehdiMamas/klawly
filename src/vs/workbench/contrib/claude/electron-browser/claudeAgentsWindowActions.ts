/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenWindowOptions, IWindowOpenable } from '../../../../platform/window/common/window.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { agentsWindowSessionResource } from '../../../../platform/claude/common/claudeAgentsWindowSessions.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { CLAUDE_AGENTS_WINDOW, CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { CLAUDE_OPEN_IN_AGENT_PANE_COMMAND_ID, KLAWLY_CATEGORY } from '../common/claudeViews.js';

/**
 * What "Open in Agent Pane" asks the main process for (#1509): an IDE window on the Agents
 * window's folder (reused if one has it, never the Agents window, #1277), showing the same
 * Claude Code session. A session that has not run yet has no id to hand over, so the window
 * just opens.
 */
export function claudeOpenInAgentPaneRequest(folder: URI, claudeSessionId: string | undefined): { readonly openables: IWindowOpenable[]; readonly options: IOpenWindowOptions } {
	return {
		openables: [{ folderUri: folder }],
		options: {
			forceNewWindow: false,
			chatSessionToOpen: claudeSessionId ? agentsWindowSessionResource(claudeSessionId) : undefined
		}
	};
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CLAUDE_OPEN_IN_AGENT_PANE_COMMAND_ID,
			title: localize2('claudeOpenInAgentPane', "Open in Agent Pane"),
			category: KLAWLY_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_AGENTS_WINDOW),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const folder = accessor.get(IWorkspaceContextService).getWorkspace().folders[0]?.uri;
		if (!folder) {
			accessor.get(INotificationService).info(localize('claudeOpenInAgentPaneNoFolder', "Open a folder in this window first."));
			return;
		}
		const { openables, options } = claudeOpenInAgentPaneRequest(folder, accessor.get(IClaudeAgentService).getCurrentSession()?.claudeSessionId);
		await accessor.get(INativeHostService).openWindow(openables, options);
	}
});
