/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { BackgroundAgentTask } from '../../../../platform/claude/common/claudeBackground.js';
import { IClaudeBackgroundAgentService } from '../../../services/claude/common/claudeBackgroundAgent.js';
import { CLAUDE_AGENT_ENABLED } from '../../claude/common/claudeContextKeys.js';
import { KLAWLY_CATEGORY } from '../../claude/common/claudeViews.js';

/** Klawly: Apply Worktree (issue 670). */
export const CLAUDE_APPLY_WORKTREE_COMMAND_ID = 'claude.applyWorktree';
/** Klawly: Delete Worktree (issue 670). */
export const CLAUDE_DELETE_WORKTREE_COMMAND_ID = 'claude.deleteWorktree';

/** One pick per worktree: the task title, and its branch and change count as the description. */
export function worktreePickItems(tasks: readonly BackgroundAgentTask[]): (IQuickPickItem & { readonly taskId: string })[] {
	return tasks.map(task => ({
		taskId: task.id,
		label: task.title,
		description: task.branchName,
		detail: task.filesChanged === 1
			? localize('claudeWorktreePickOne', "1 file changed")
			: localize('claudeWorktreePickMany', "{0} files changed", task.filesChanged),
	}));
}

/**
 * Apply Worktree and Delete Worktree (issue 670): the Background Agents view's Apply and Delete
 * as commands, so they work from the palette and a keybinding. They ask which worktree
 * when none is given.
 */
export function registerClaudeWorktreeCommands(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_APPLY_WORKTREE_COMMAND_ID,
				// Other names are aliases the palette matches but never shows (DL-30, issue 904).
				title: { ...localize2('claudeApplyWorktree', "Apply Worktree"), original: 'Apply Worktree (Git Worktree, Merge Worktree, Apply Branch, Merge Branch, Background Agent Changes)' },
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		async run(accessor: ServicesAccessor, taskId?: string): Promise<void> {
			const background = accessor.get(IClaudeBackgroundAgentService);
			const notifications = accessor.get(INotificationService);
			const id = typeof taskId === 'string' ? taskId : await pickWorktree(accessor, localize('claudeApplyWorktreePlaceholder', "Choose a worktree to apply to the workspace"));
			if (!id) {
				return;
			}
			try {
				const result = await background.apply(id);
				if (!result.applied && result.conflicts.length === 0) {
					notifications.info(localize('claudeApplyWorktreeNothing', "Nothing was applied. The worktree has no changes, or you declined."));
				}
			} catch (error) {
				notifications.error(error instanceof Error ? error.message : String(error));
			}
		}
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_DELETE_WORKTREE_COMMAND_ID,
				title: { ...localize2('claudeDeleteWorktree', "Delete Worktree"), original: 'Delete Worktree (Git Worktree, Remove Worktree, Discard Worktree, Delete Branch, Remove Branch)' },
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		async run(accessor: ServicesAccessor, taskId?: string): Promise<void> {
			const background = accessor.get(IClaudeBackgroundAgentService);
			const notifications = accessor.get(INotificationService);
			const id = typeof taskId === 'string' ? taskId : await pickWorktree(accessor, localize('claudeDeleteWorktreePlaceholder', "Choose a worktree to delete"));
			if (!id) {
				return;
			}
			try {
				await background.delete(id);
			} catch (error) {
				notifications.error(error instanceof Error ? error.message : String(error));
			}
		}
	});
}

async function pickWorktree(accessor: ServicesAccessor, placeHolder: string): Promise<string | undefined> {
	const background = accessor.get(IClaudeBackgroundAgentService);
	const quickInput = accessor.get(IQuickInputService);
	const notifications = accessor.get(INotificationService);
	const items = worktreePickItems(background.getTasks());
	if (items.length === 0) {
		notifications.info(localize('claudeWorktreeNone', "There are no background agent worktrees."));
		return undefined;
	}
	return (await quickInput.pick(items, { placeHolder }))?.taskId;
}
