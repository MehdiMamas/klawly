/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { canMessageWorker, canRestartWorker, canStopWorker } from '../../../services/claude/common/claudeWorkerControls.js';
import { IClaudeWorkerRegistry, IClaudeWorkerRun } from '../../../services/claude/common/claudeWorkerRegistry.js';
import { CLAUDE_AGENT_ENABLED } from '../../claude/common/claudeContextKeys.js';
import { KLAWLY_CATEGORY } from '../../claude/common/claudeViews.js';
import { CLAUDE_WORKERS_VIEW_ID } from '../common/claudeBackground.js';
import { ClaudeWorkersViewPane } from './claudeWorkersViewPane.js';

/** Picks the worker a command acts on: the one selected in the Workers view, else one chosen from a list. */
async function pickWorker(accessor: ServicesAccessor, allowed: (run: IClaudeWorkerRun) => boolean, placeHolder: string): Promise<{ pane: ClaudeWorkersViewPane; run: IClaudeWorkerRun } | undefined> {
	const views = accessor.get(IViewsService);
	const registry = accessor.get(IClaudeWorkerRegistry);
	const quickInput = accessor.get(IQuickInputService);
	const notifications = accessor.get(INotificationService);
	const pane = await views.openView<ClaudeWorkersViewPane>(CLAUDE_WORKERS_VIEW_ID, false);
	if (!pane) {
		return undefined;
	}
	const selected = pane.selectedWorker();
	if (selected && allowed(selected)) {
		return { pane, run: selected };
	}
	const candidates = registry.all().filter(allowed);
	if (candidates.length === 0) {
		notifications.info(localize('claudeWorkerNoneToAct', "No running worker is selected. Open a worker in the Workers view first."));
		return undefined;
	}
	const picked = await quickInput.pick(candidates.map(run => ({ label: `${run.number} ${run.name}`, run })), { placeHolder });
	return picked ? { pane, run: picked.run } : undefined;
}

async function act(accessor: ServicesAccessor, allowed: (run: IClaudeWorkerRun) => boolean, placeHolder: string, doIt: (pane: ClaudeWorkersViewPane, run: IClaudeWorkerRun) => Promise<void>): Promise<void> {
	const notifications = accessor.get(INotificationService);
	const target = await pickWorker(accessor, allowed, placeHolder);
	if (!target) {
		return;
	}
	try {
		await doIt(target.pane, target.run);
	} catch (error) {
		notifications.error(error instanceof Error ? error.message : String(error));
	}
}

/** The Stop Worker and Restart Worker commands (issue 1100). */
export function registerClaudeWorkerControls(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'claude.workers.stop',
				title: localize2('claudeWorkerStopCommand', "Stop Worker"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		run(accessor: ServicesAccessor): Promise<void> {
			return act(accessor, canStopWorker, localize('claudeWorkerStopPick', "Pick the worker to stop"), (pane, run) => pane.stopWorker(run));
		}
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'claude.workers.restart',
				title: localize2('claudeWorkerRestartCommand', "Restart Worker"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		run(accessor: ServicesAccessor): Promise<void> {
			return act(accessor, canRestartWorker, localize('claudeWorkerRestartPick', "Pick the worker to restart"), (pane, run) => pane.restartWorker(run));
		}
	});	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'claude.workers.message',
				title: localize2('claudeWorkerMessageCommand', "Message Worker"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		run(accessor: ServicesAccessor): Promise<void> {
			return act(accessor, canMessageWorker, localize('claudeWorkerMessagePick', "Pick the worker to message"), (pane, run) => pane.messageWorker(run));
		}
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'claude.workers.handoff',
				title: localize2('claudeWorkerHandoffCommand', "Copy Worker Handoff"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		run(accessor: ServicesAccessor): Promise<void> {
			return act(accessor, () => true, localize('claudeWorkerHandoffPick', "Pick the worker to hand off"), (pane, run) => pane.copyHandoff(run));
		}
	});
}
