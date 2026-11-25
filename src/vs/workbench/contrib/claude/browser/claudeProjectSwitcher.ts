/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isRecentFolder, IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { claudeUnreadByFolder, readClaudeHandoffs } from '../../../services/claude/common/claudeDepartmentInbox.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { claudeSwitcherProjects, ClaudeSwitcherProject } from '../common/claudeProjectSwitcher.js';
import { KLAWLY_CATEGORY } from '../common/claudeViews.js';

export const CLAUDE_SWITCH_PROJECT_COMMAND_ID = 'claude.switchProject';

interface ProjectItem extends IQuickPickItem {
	readonly project: ClaudeSwitcherProject;
}

/** Switch Project Window: open and recent projects with their unread hand-offs (issue 1459, DL-121). */
export function registerClaudeProjectSwitcher(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_SWITCH_PROJECT_COMMAND_ID,
				title: localize2('claudeSwitchProject', "Switch Project Window..."),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const quickInput = accessor.get(IQuickInputService);
			const host = accessor.get(IHostService);
			const workspaces = accessor.get(IWorkspacesService);
			const unread = claudeUnreadByFolder(readClaudeHandoffs(accessor.get(IStorageService)));
			const open = accessor.get(IWorkspaceContextService).getWorkspace().folders.map(folder => folder.uri);
			const recent = await workspaces.getRecentlyOpened();
			const projects = claudeSwitcherProjects(open, recent.workspaces.filter(isRecentFolder).map(entry => entry.folderUri), unread);
			const items: ProjectItem[] = projects.map(project => ({
				label: project.name,
				description: project.current
					? localize('claudeSwitchProjectCurrent', "This window")
					: project.unread > 0
						? localize('claudeSwitchProjectUnread', "{0} unread hand-offs", project.unread)
						: undefined,
				detail: project.folder,
				project,
			}));
			const picked = await quickInput.pick(items, { placeHolder: localize('claudeSwitchProjectPlaceholder', "Switch to a project window") });
			if (picked && !picked.project.current) {
				await host.openWindow([{ folderUri: picked.project.uri }], {});
			}
		}
	});
}
