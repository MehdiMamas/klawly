/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/** The five things an Auto run can be in, as the user sees them (DL-109). */
export type ClaudeAutoStatusState = 'working' | 'waiting' | 'done' | 'failed' | 'guard';

/** What a button on a status does. The surface wires each id to its own handler. */
export type ClaudeAutoStatusActionId = 'stop' | 'answer' | 'openPr' | 'viewChanges' | 'retry' | 'retryOnOpus' | 'openLog' | 'continue';

export interface ClaudeAutoStatusInput {
	readonly state: ClaudeAutoStatusState;
	/** The model doing the work now, such as "Sonnet". Empty while no model runs. */
	readonly modelLabel?: string;
	/** Live cost of the run and its helpers, in US dollars. */
	readonly costUsd?: number;
	/** Working: how many helpers run. */
	readonly helpers?: number;
	/** Working: nothing runs but CI; no model is running and it costs nothing. */
	readonly waitingOnCi?: boolean;
	/** Waiting: the question, in the user's words. */
	readonly question?: string;
	/** Done: what the run changed and how long it took. */
	readonly filesChanged?: number;
	readonly minutes?: number;
	readonly hasPr?: boolean;
	/** Failed: why. A missing reason reads "No reason was reported". */
	readonly reason?: string;
	/** Failed: the run already went to Opus, so Retry on Opus is not offered. */
	readonly opusTried?: boolean;
	/** Failed: a log exists to open. */
	readonly hasLog?: boolean;
	/** Guard: which limit was hit. */
	readonly guard?: 'cost' | 'context';
}

export interface ClaudeAutoStatusAction {
	readonly id: ClaudeAutoStatusActionId;
	readonly label: string;
	/** The one main action; the rest are secondary. */
	readonly primary: boolean;
}

export interface ClaudeAutoStatus {
	readonly state: ClaudeAutoStatusState;
	/** One or two words: "Working", "Waiting for you". */
	readonly label: string;
	/** The line after the label: the model, the question, the reason. */
	readonly detail: string;
	/** The cost as shown, or undefined when it is not known yet. */
	readonly cost: string | undefined;
	readonly aria: string;
	readonly actions: readonly ClaudeAutoStatusAction[];
}

/** "$1.87" (DL-110: tabular in the UI), or undefined when no cost is known. */
export function claudeAutoCostText(usd: number | undefined): string | undefined {
	return usd === undefined ? undefined : `$${usd.toFixed(2)}`;
}

function action(id: ClaudeAutoStatusActionId, label: string, primary: boolean): ClaudeAutoStatusAction {
	return { id, label, primary };
}

function helpersText(count: number): string {
	return count === 1 ? localize('claudeAutoStatusOneHelper', "1 helper") : localize('claudeAutoStatusManyHelpers', "{0} helpers", count);
}

/**
 * DL-109: a state in plain words, its model, its live cost and one main
 * action. DL-110: while only CI runs the cost reads "$0 while waiting".
 */
export function claudeAutoStatus(input: ClaudeAutoStatusInput): ClaudeAutoStatus {
	const model = input.modelLabel?.trim();
	let cost = claudeAutoCostText(input.costUsd);
	let label: string;
	let detail: string;
	let actions: ClaudeAutoStatusAction[];
	switch (input.state) {
		case 'working':
			label = localize('claudeAutoStatusWorking', "Working");
			if (input.waitingOnCi) {
				detail = localize('claudeAutoStatusCi', "waiting on CI, no model running");
				cost = cost ? localize('claudeAutoStatusCiCost', "$0 while waiting · {0} total", cost) : localize('claudeAutoStatusCiCostNone', "$0 while waiting");
			} else if (input.helpers && input.helpers > 0) {
				detail = model ? localize('claudeAutoStatusHelpersOn', "{0} on {1}", helpersText(input.helpers), model) : helpersText(input.helpers);
			} else {
				detail = model ?? '';
			}
			actions = [action('stop', localize('claudeAutoStatusStop', "Stop"), true)];
			break;
		case 'waiting':
			label = localize('claudeAutoStatusWaiting', "Waiting for you");
			detail = input.question?.trim() || localize('claudeAutoStatusDecision', "A decision is needed");
			actions = [action('answer', localize('claudeAutoStatusAnswer', "Answer"), true)];
			break;
		case 'done': {
			label = localize('claudeAutoStatusDone', "Done");
			const files = input.filesChanged ?? 0;
			const changed = files === 1 ? localize('claudeAutoStatusOneFile', "1 file changed") : localize('claudeAutoStatusManyFiles', "{0} files changed", files);
			detail = input.minutes !== undefined ? localize('claudeAutoStatusDoneDetail', "{0} · {1} min", changed, input.minutes) : changed;
			actions = [input.hasPr
				? action('openPr', localize('claudeAutoStatusOpenPr', "Open PR"), true)
				: action('viewChanges', localize('claudeAutoStatusViewChanges', "View Changes"), true)];
			break;
		}
		case 'failed':
			label = localize('claudeAutoStatusFailed', "Failed");
			detail = input.reason?.trim() || localize('claudeAutoStatusNoReason', "No reason was reported");
			actions = input.opusTried
				? [action('retry', localize('claudeAutoStatusRetry', "Retry"), true)]
				: [action('retryOnOpus', localize('claudeAutoStatusRetryOnOpus', "Retry on Opus"), true), action('retry', localize('claudeAutoStatusRetry', "Retry"), false)];
			if (input.hasLog) {
				actions.push(action('openLog', localize('claudeAutoStatusOpenLog', "Open Log"), false));
			}
			break;
		case 'guard':
			label = localize('claudeAutoStatusGuard', "Limit reached");
			detail = input.guard === 'context'
				? localize('claudeAutoStatusGuardContext', "Context is nearly full")
				: localize('claudeAutoStatusGuardCost', "{0} used", cost ?? '$0.00');
			actions = [action('continue', localize('claudeAutoStatusContinue', "Continue"), false), action('stop', localize('claudeAutoStatusStop', "Stop"), true)];
			break;
	}
	const parts = [label, detail, cost].filter(part => !!part);
	if (model && (input.state === 'waiting' || input.state === 'done' || input.state === 'failed')) {
		parts.splice(2, 0, model);
	}
	return { state: input.state, label, detail, cost, aria: localize('claudeAutoStatusAria', "Auto: {0}", parts.join(', ')), actions };
}

/**
 * Issue 1220: a notification is for the moment the run stops working and needs the user or has an outcome.
 * `previous` is the state painted before; the first paint of a chat never notifies. Working and Guard never notify
 * (a guard hit already has its own strip and notification).
 */
export function claudeAutoNoticeSeverity(previous: ClaudeAutoStatusState | undefined, next: ClaudeAutoStatusState): 'info' | 'warn' | 'error' | undefined {
	if (previous === undefined || previous === next) {
		return undefined;
	}
	switch (next) {
		case 'waiting': return 'warn';
		case 'failed': return 'error';
		case 'done': return previous === 'working' ? 'info' : undefined;
		default: return undefined;
	}
}
