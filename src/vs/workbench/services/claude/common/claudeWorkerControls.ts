/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IClaudeBackgroundAgentService } from './claudeBackgroundAgent.js';
import { IClaudeDelegationService } from './claudeDelegation.js';
import { IClaudeMultitaskService } from './claudeMultitask.js';
import { IClaudeWorkerRun, isEndedWorkerState } from './claudeWorkerRegistry.js';

/** The services a Stop or Restart on a worker run goes through (issue 1100). */
export interface ClaudeWorkerControlServices {
	readonly delegation: Pick<IClaudeDelegationService, 'stop' | 'rerun' | 'message'>;
	readonly background: Pick<IClaudeBackgroundAgentService, 'stop'>;
	readonly multitask: Pick<IClaudeMultitaskService, 'stop'>;
}

const BACKGROUND_PREFIX = 'background-';
const MULTITASK_PREFIX = 'multitask-';

/** A run can be stopped while it is not over, and its kind has a stop call. */
export function canStopWorker(run: IClaudeWorkerRun): boolean {
	return !isEndedWorkerState(run.state) && (run.kind === 'delegate' || run.kind === 'background' || run.kind === 'multitask');
}

/** Only a delegated worker can be started again, and only while it is working (a hung worker is working). */
export function canRestartWorker(run: IClaudeWorkerRun): boolean {
	return run.kind === 'delegate' && run.state === 'working';
}

/** Why Stop Worker is unavailable for this run, in plain words; empty when it can be stopped (DL-12). */
export function stopWorkerDisabledReason(run: IClaudeWorkerRun): string {
	if (canStopWorker(run)) {
		return '';
	}
	return isEndedWorkerState(run.state)
		? localize('claudeWorkerStopDisabledEnded', "This worker has already finished.")
		: localize('claudeWorkerStopDisabledKind', "This worker is stopped in the chat that started it.");
}

/** Why Restart Worker is unavailable for this run, in plain words; empty when it can be restarted (DL-11, DL-12). */
export function restartWorkerDisabledReason(run: IClaudeWorkerRun): string {
	return canRestartWorker(run) ? '' : localize('claudeWorkerRestartDisabled', "Only a working worker started from a chat can be restarted.");
}

/** Stops the run through the service that started it. A multitask run stops its whole multitask. */
export async function stopWorker(run: IClaudeWorkerRun, services: ClaudeWorkerControlServices): Promise<void> {
	switch (run.kind) {
		case 'delegate':
			return services.delegation.stop(run.id);
		case 'background':
			return services.background.stop(run.id.startsWith(BACKGROUND_PREFIX) ? run.id.slice(BACKGROUND_PREFIX.length) : run.id);
		case 'multitask': {
			const rest = run.id.startsWith(MULTITASK_PREFIX) ? run.id.slice(MULTITASK_PREFIX.length) : run.id;
			// Group ids have no dash; a prompt run is `<group>-<n>`.
			return services.multitask.stop(rest.split('-')[0]);
		}
		default:
			return;
	}
}

/** Stops a hung delegated worker and sends its task again. Resolves false when the task could not be sent again. */
export async function restartWorker(run: IClaudeWorkerRun, services: ClaudeWorkerControlServices): Promise<boolean> {
	if (!canRestartWorker(run)) {
		return false;
	}
	await services.delegation.stop(run.id);
	return services.delegation.rerun(run.id);
}

/** Context size at which a worker is better replaced than messaged (issue 841). */
export const CLAUDE_FRESH_WORKER_TOKENS = 100_000;

/** Only a delegated worker has a chat to message; a finished one is resumed by the message. */
export function canMessageWorker(run: IClaudeWorkerRun): boolean {
	return run.kind === 'delegate' && run.state !== 'stopped';
}

/** Why Message Worker is unavailable for this run, in plain words; empty when it can be messaged. */
export function messageWorkerDisabledReason(run: IClaudeWorkerRun): string {
	return canMessageWorker(run) ? '' : localize('claudeWorkerMessageDisabled', "Only a delegated worker that has not been stopped can be messaged.");
}

/** A hint to hand the work to a fresh worker when the target's context is large; empty otherwise. */
export function freshWorkerHint(run: IClaudeWorkerRun, thresholdTokens: number = CLAUDE_FRESH_WORKER_TOKENS): string {
	if (run.contextTokens === undefined || run.contextTokens < thresholdTokens) {
		return '';
	}
	return localize('claudeWorkerFreshHint', "This worker's context is large ({0}k tokens). A fresh worker with a handoff will do better than another message.", Math.round(run.contextTokens / 1000));
}

/** Sends a message to the worker. Resolves false when it cannot be sent. */
export async function messageWorker(run: IClaudeWorkerRun, text: string, services: ClaudeWorkerControlServices): Promise<boolean> {
	return canMessageWorker(run) ? services.delegation.message(run.id, text) : false;
}

/**
 * The checkpoint a new session starts from (issue 841): objective, decisions, open, branch, done, evidence, remaining, risks.
 * What the registry does not hold is written as `not recorded`, so the new worker knows to ask.
 */
export function buildWorkerHandoff(run: IClaudeWorkerRun): string {
	const none = localize('claudeWorkerHandoffNone', "not recorded");
	const lines = [
		localize('claudeWorkerHandoffTitle', "Handoff from {0}", run.name),
		'',
		`${localize('claudeWorkerHandoffObjective', "Objective")}: ${run.objective ?? none}`,
		`${localize('claudeWorkerHandoffDecisions', "Decisions")}: ${none}`,
		`${localize('claudeWorkerHandoffOpen', "Open")}: ${isEndedWorkerState(run.state) ? none : run.stateDetail ?? run.state}`,
		`${localize('claudeWorkerHandoffBranch', "Branch")}: ${[run.repo, run.worktree].filter(Boolean).join(' ') || none}`,
		`${localize('claudeWorkerHandoffDone', "Done")}: ${run.report ?? none}`,
		`${localize('claudeWorkerHandoffEvidence', "Evidence")}: ${run.acceptance ?? none}`,
		`${localize('claudeWorkerHandoffRemaining', "Remaining")}: ${isEndedWorkerState(run.state) ? none : run.objective ?? none}`,
		`${localize('claudeWorkerHandoffRisks', "Risks")}: ${none}`,
	];
	return lines.join('\n');
}
