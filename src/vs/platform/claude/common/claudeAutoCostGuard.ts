/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';

/**
 * Auto mode cost guard (issue 1218, epic 1215): one chat never spends on
 * without you. At the notify amount the composer says so once; at the stop
 * amount Auto interrupts the chat and its helpers and waits for you. The cost
 * is the chat's own plus every helper's under it. A pure function of numbers:
 * no services, no I/O.
 */

export const CLAUDE_AUTO_COST_NOTIFY_USD_SETTING = 'claude.auto.cost.notifyUsd';
export const CLAUDE_AUTO_COST_NOTIFY_USD_DEFAULT = 25;
export const CLAUDE_AUTO_COST_STOP_USD_SETTING = 'claude.auto.cost.stopUsd';
export const CLAUDE_AUTO_COST_STOP_USD_DEFAULT = 50;
export const CLAUDE_AUTO_COST_USD_MIN = 1;
export const CLAUDE_AUTO_COST_USD_MAX = 10000;

export type ClaudeAutoCostState = 'ok' | 'notify' | 'stop';

function readAmount(get: (key: string) => unknown, key: string, fallback: number): number {
	const value = get(key);
	if (typeof value !== 'number' || !Number.isFinite(value) || value < CLAUDE_AUTO_COST_USD_MIN || value > CLAUDE_AUTO_COST_USD_MAX) {
		return fallback;
	}
	return value;
}

/** Reads the notify amount. Anything but a number in range falls back to the default. */
export function readClaudeAutoCostNotify(get: (key: string) => unknown): number {
	return readAmount(get, CLAUDE_AUTO_COST_NOTIFY_USD_SETTING, CLAUDE_AUTO_COST_NOTIFY_USD_DEFAULT);
}

/** Reads the stop amount. Anything but a number in range falls back to the default. */
export function readClaudeAutoCostStop(get: (key: string) => unknown): number {
	return readAmount(get, CLAUDE_AUTO_COST_STOP_USD_SETTING, CLAUDE_AUTO_COST_STOP_USD_DEFAULT);
}

/** ok below notify, notify from notify until stop, stop at and above stop. Stop wins when it is not above notify. */
export function claudeAutoCostState(cost: number | undefined, notifyUsd: number, stopUsd: number): ClaudeAutoCostState {
	if (cost === undefined || !Number.isFinite(cost) || cost < 0) {
		return 'ok';
	}
	if (cost >= stopUsd) {
		return 'stop';
	}
	return cost >= notifyUsd ? 'notify' : 'ok';
}

/** Raise Limit: the chat's stop amount grows by one stop step (the setting), for this chat only. */
export function raiseClaudeAutoCostStop(currentLimit: number, stepUsd: number): number {
	return currentLimit + stepUsd;
}

/** Two decimals under $10 ("$1.60"), whole dollars from $10 up ("$12"). */
export function formatClaudeAutoCostUsd(usd: number): string {
	return usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.floor(usd)}`;
}

export function claudeAutoCostNotifyLabel(usd: number): string {
	return localize('claudeAutoCostNotify', "{0} Used", formatClaudeAutoCostUsd(usd));
}

export function claudeAutoCostNotifyDetail(): string {
	return localize('claudeAutoCostNotifyDetail', "This chat and its helpers. Auto stops and asks at the limit");
}

export function claudeAutoCostStopLabel(usd: number): string {
	return localize('claudeAutoCostStop', "Waiting for You: {0} Used", formatClaudeAutoCostUsd(usd));
}

export function claudeAutoCostStopDetail(): string {
	return localize('claudeAutoCostStopDetail', "Auto stopped this chat and its helpers at the limit");
}

/** One log line for a stop (issue 849 reads these). */
export function formatClaudeAutoCostLogLine(sessionId: string, cost: number, stopUsd: number): string {
	return `[auto] cost stop: session ${sessionId} stopped at $${cost.toFixed(2)} of $${stopUsd}`;
}
