/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Settings > Agents > Delegation: minutes after which a finished worker that is still open is flagged (0 turns it off). */
export const CLAUDE_WORKERS_FINISHED_MINUTES_SETTING = 'klawly.delegation.workers.finishedMinutes';
/** Minutes without an event after which a working worker is flagged as hung (0 turns it off). */
export const CLAUDE_WORKERS_HUNG_MINUTES_SETTING = 'klawly.delegation.workers.hungMinutes';

export interface ClaudeWorkersViewThresholds {
	readonly finishedMinutes: number;
	readonly hungMinutes: number;
}

export const CLAUDE_WORKERS_VIEW_DEFAULTS: ClaudeWorkersViewThresholds = { finishedMinutes: 5, hungMinutes: 10 };

/** A threshold from settings: a whole number of 0 or more, else the default. */
export function readClaudeWorkersMinutes(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
