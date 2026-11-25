/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ClaudeAutomationEntry, ClaudeAutomationScope } from './claudeAutomation.js';
import { CLAUDE_OS_SCHEDULE_MAX_ENTRIES, ClaudeOsScheduleAutomation } from './claudeAutomationOsSchedule.js';

/** Shared-process channel that keeps the operating system's scheduler in step with the automations (issue 463). */
export const CLAUDE_OS_SCHEDULE_CHANNEL = 'klawlyClaudeOsSchedule';

/** The owners a window looks after: the user's automations, and the open folder's. */
export interface ClaudeOsScheduleOwner {
	readonly scope: ClaudeAutomationScope;
	readonly folder?: string;
}

export interface ClaudeOsScheduleFailure {
	readonly id: string;
	readonly reason: string;
}

export interface IClaudeOsScheduleService {
	readonly _serviceBrand: undefined;
	/**
	 * Registers `wanted` with the OS scheduler and removes every earlier entry of `owners` that is no longer wanted.
	 * Entries of other owners are left alone. Returns why each automation could not be registered.
	 */
	sync(owners: readonly ClaudeOsScheduleOwner[], wanted: readonly ClaudeOsScheduleAutomation[]): Promise<readonly ClaudeOsScheduleFailure[]>;
}

export const IClaudeOsScheduleService = createDecorator<IClaudeOsScheduleService>('claudeOsScheduleService');

/**
 * The automations that belong on the OS scheduler: enabled, opted in with
 * `runWhenClosed`, on a `schedule` trigger, while automations are on. At most
 * {@link CLAUDE_OS_SCHEDULE_MAX_ENTRIES}.
 */
export function claudeOsWantedSchedules(automations: readonly ClaudeAutomationEntry[], automationsEnabled: boolean, workspaceFolder: string | undefined): ClaudeOsScheduleAutomation[] {
	if (!automationsEnabled) {
		return [];
	}
	const wanted: ClaudeOsScheduleAutomation[] = [];
	for (const automation of automations) {
		const scope = automation.scope;
		if (!automation.enabled || automation.permissionMode === 'agent' || !automation.runWhenClosed || automation.trigger.type !== 'schedule' || (scope === 'workspace' && !workspaceFolder)) {
			continue;
		}
		wanted.push({ id: automation.id, scope, cron: automation.trigger.cron, folder: scope === 'workspace' ? workspaceFolder : undefined });
	}
	return wanted.slice(0, CLAUDE_OS_SCHEDULE_MAX_ENTRIES);
}
