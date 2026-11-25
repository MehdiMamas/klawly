/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { BackgroundAgentTask, isActiveBackgroundStatus } from '../../../../platform/claude/common/claudeBackground.js';

export type BackgroundCardAction = 'review' | 'apply' | 'open' | 'stop' | 'delete' | 'resolve';

export interface BackgroundCardFact {
	readonly icon: string;
	readonly text: string;
	readonly added?: number;
	readonly removed?: number;
}

export interface BackgroundCardButton {
	readonly action: BackgroundCardAction;
	readonly label: string;
	readonly primary: boolean;
	readonly danger: boolean;
}

export interface BackgroundAgentCard {
	readonly title: string;
	readonly badge: string;
	readonly badgeKind: 'running' | 'success' | 'warning' | 'error';
	readonly icon: 'loading' | 'pass' | 'error' | 'git-merge' | 'shield';
	readonly spin: boolean;
	readonly facts: readonly BackgroundCardFact[];
	readonly actions: readonly BackgroundCardButton[];
}

/** Status card for one background agent. Labels come from the task, not from guessed test results. */
export function backgroundAgentCard(task: BackgroundAgentTask): BackgroundAgentCard {
	const conflicts = task.conflicts.length;
	const waiting = task.status === 'waiting';
	const active = isActiveBackgroundStatus(task.status);
	let badge = localize('claudeBackgroundRunning', "running");
	let badgeKind: BackgroundAgentCard['badgeKind'] = 'running';
	let icon: BackgroundAgentCard['icon'] = 'loading';
	if (conflicts > 0) {
		badge = conflicts === 1
			? localize('claudeBackgroundOneConflict', "1 conflict")
			: localize('claudeBackgroundConflicts', "{0} conflicts", conflicts);
		badgeKind = 'warning';
		icon = 'git-merge';
	} else if (waiting) {
		badge = localize('claudeBackgroundApproval', "approval");
		badgeKind = 'warning';
		icon = 'shield';
	} else if (task.status === 'complete') {
		badge = localize('claudeBackgroundDone', "done");
		badgeKind = 'success';
		icon = 'pass';
	} else if (task.status === 'failed') {
		badge = task.stopped
			? localize('claudeBackgroundStopped', "stopped")
			: localize('claudeBackgroundFailed', "failed");
		badgeKind = 'error';
		icon = 'error';
	} else if (task.status === 'starting') {
		badge = localize('claudeBackgroundStarting', "starting");
	}
	const fileText = task.filesChanged === 1
		? localize('claudeBackgroundOneFile', "1 file")
		: localize('claudeBackgroundFiles', "{0} files", task.filesChanged);
	const facts: BackgroundCardFact[] = [
		{ icon: 'repo-forked', text: task.branchName },
		{ icon: 'files', text: fileText, added: task.added, removed: task.removed },
		{ icon: 'beaker', text: task.testStatus },
	];
	if (conflicts > 0) {
		facts.push({ icon: 'git-merge', text: localize('claudeBackgroundMainMoved', "main changed since this agent started") });
	}
	const actions: BackgroundCardButton[] = [];
	if (conflicts > 0) {
		actions.push({ action: 'resolve', label: localize('claudeBackgroundResolve', "Resolve in merge editor"), primary: true, danger: false });
	}
	if (waiting) {
		actions.push({ action: 'review', label: localize('claudeBackgroundReviewRequest', "Review request"), primary: conflicts === 0, danger: false });
	} else {
		actions.push({
			action: 'apply',
			label: task.status === 'complete'
				? localize('claudeBackgroundReviewApply', "Review & apply")
				: localize('claudeBackgroundApply', "Apply"),
			primary: conflicts === 0 && !active,
			danger: false,
		});
		actions.push({ action: 'review', label: localize('claudeBackgroundReview', "Review"), primary: false, danger: false });
	}
	actions.push({ action: 'open', label: localize('claudeBackgroundOpen', "Open worktree"), primary: false, danger: false });
	if (active) {
		actions.push({ action: 'stop', label: localize('claudeBackgroundStop', "Stop"), primary: false, danger: true });
	} else {
		actions.push({ action: 'delete', label: localize('claudeBackgroundDelete', "Delete"), primary: false, danger: false });
	}
	return {
		title: task.title,
		badge,
		badgeKind,
		icon,
		spin: icon === 'loading',
		facts,
		actions,
	};
}
