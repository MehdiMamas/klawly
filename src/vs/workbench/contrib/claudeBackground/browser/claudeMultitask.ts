/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { CLAUDE_MULTITASK_RUN_QUEUED_COMMAND_ID, IClaudeMultitaskService } from '../../../services/claude/common/claudeMultitask.js';
import { CLAUDE_AGENT_ENABLED } from '../../claude/common/claudeContextKeys.js';
import { KLAWLY_CATEGORY } from '../../claude/common/claudeViews.js';

/** Run Queued in Parallel (issue 487): the current chat's queued messages run at once as a multitask. */
export function registerClaudeMultitask(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_MULTITASK_RUN_QUEUED_COMMAND_ID,
				title: localize2('claudeMultitaskRunQueued', "Run Queued Messages in Parallel"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		run(accessor: ServicesAccessor): void {
			const agent = accessor.get(IClaudeAgentService);
			const multitask = accessor.get(IClaudeMultitaskService);
			const workspace = accessor.get(IWorkspaceContextService);
			const notifications = accessor.get(INotificationService);
			const session = agent.getCurrentSession();
			const folder = workspace.getWorkspace().folders.find(candidate => candidate.uri.scheme === Schemas.file);
			if (!session || !folder) {
				notifications.error(localize('claudeMultitaskNoChat', "Open a local folder and a chat with queued messages first."));
				return;
			}
			try {
				multitask.runQueued(session.id, folder.uri.fsPath, session.mode);
			} catch (error) {
				notifications.error(error instanceof Error ? error.message : String(error));
			}
		}
	});
}
