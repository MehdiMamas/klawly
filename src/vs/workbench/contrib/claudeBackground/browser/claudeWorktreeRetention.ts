/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ByteSize } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ClaudeWorktreeUsage, totalWorktreeUsage, worktreeAgeDays } from '../../../../platform/claude/common/claudeWorktreeRetention.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IClaudeWorktreeKeeper } from '../../../services/claude/common/claudeWorktreeKeeper.js';
import { CLAUDE_AGENT_ENABLED } from '../../claude/common/claudeContextKeys.js';
import { KLAWLY_CATEGORY } from '../../claude/common/claudeViews.js';

/** Klawly: Show Worktree Disk Use (issue 865). */
export const CLAUDE_WORKTREE_DISK_USE_COMMAND_ID = 'claude.showWorktreeDiskUse';

/** How often the age sweep runs while Klawly stays open. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Biggest first, so the worktrees worth deleting are on top. Each pick shows its age and size. */
export function worktreeDiskPickItems(usages: readonly ClaudeWorktreeUsage[], now: number): IQuickPickItem[] {
	return usages
		.slice()
		.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1))
		.map(({ record, bytes }) => {
			const days = worktreeAgeDays(record, now);
			return {
				label: record.title,
				description: bytes === undefined ? localize('claudeWorktreeSizeUnknown', "Size unknown") : ByteSize.formatSize(bytes),
				detail: days === 0
					? localize('claudeWorktreeAgeToday', "Last worked on today")
					: days === 1
						? localize('claudeWorktreeAgeOne', "Last worked on 1 day ago")
						: localize('claudeWorktreeAgeMany', "Last worked on {0} days ago", days),
			};
		});
}

/** The pick's heading: how many worktrees Klawly keeps and what they use together. */
export function worktreeDiskSummary(usages: readonly ClaudeWorktreeUsage[]): string {
	const { bytes, unreadable } = totalWorktreeUsage(usages);
	const base = usages.length === 1
		? localize('claudeWorktreeSummaryOne', "1 worktree uses {0}", ByteSize.formatSize(bytes))
		: localize('claudeWorktreeSummaryMany', "{0} worktrees use {1}", usages.length, ByteSize.formatSize(bytes));
	return unreadable === 0 ? base : localize('claudeWorktreeSummaryUnreadable', "{0} ({1} could not be read)", base, unreadable);
}

/**
 * Removes idle worktrees once at startup and every few hours (issue 865). Only a worktree with
 * nothing left to apply goes; the keeper checks that.
 */
class ClaudeWorktreeRetentionContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeWorktreeRetention';

	constructor(
		@IClaudeWorktreeKeeper private readonly keeper: IClaudeWorktreeKeeper,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		void this.sweep();
		const timer = this._register(new IntervalTimer());
		timer.cancelAndSet(() => void this.sweep(), SWEEP_INTERVAL_MS);
	}

	private async sweep(): Promise<void> {
		try {
			const { removed } = await this.keeper.sweep();
			if (removed.length > 0) {
				this.notifications.info(removed.length === 1
					? localize('claudeWorktreeSweptOne', "Removed 1 old worktree with nothing left to apply.")
					: localize('claudeWorktreeSweptMany', "Removed {0} old worktrees with nothing left to apply.", removed.length));
			}
		} catch {
			// The next sweep tries again.
		}
	}
}

export function registerClaudeWorktreeRetention(): void {
	registerWorkbenchContribution2(ClaudeWorktreeRetentionContribution.ID, ClaudeWorktreeRetentionContribution, WorkbenchPhase.Eventually);
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_WORKTREE_DISK_USE_COMMAND_ID,
				title: localize2('claudeShowWorktreeDiskUse', "Show Worktree Disk Use"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const keeper = accessor.get(IClaudeWorktreeKeeper);
			const quickInput = accessor.get(IQuickInputService);
			const notifications = accessor.get(INotificationService);
			const usages = await keeper.usage();
			if (usages.length === 0) {
				notifications.info(localize('claudeWorktreeDiskNone', "Klawly is not keeping any worktrees."));
				return;
			}
			await quickInput.pick(worktreeDiskPickItems(usages, Date.now()), { placeHolder: worktreeDiskSummary(usages) });
		}
	});
}
