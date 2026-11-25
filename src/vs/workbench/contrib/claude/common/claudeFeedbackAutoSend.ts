/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeFeedbackBannedError, ClaudeFeedbackDraft, ClaudeFeedbackSendError, ClaudeFeedbackSignInError, ClaudeFeedbackUnsent } from './claudeFeedback.js';

/** Waits between passes that left a report unsent: 5 minutes, 30 minutes, then hourly. */
const AUTO_SEND_DELAYS_MS = [5 * 60_000, 30 * 60_000, 60 * 60_000];

export function claudeFeedbackAutoSendDelay(attempt: number): number {
	return AUTO_SEND_DELAYS_MS[Math.min(attempt, AUTO_SEND_DELAYS_MS.length - 1)];
}

/** `stop`: retrying cannot help until the tester signs in or the ban is lifted. `retry`: the network or relay may recover. */
export function claudeFeedbackAutoSendFailure(error: unknown): 'stop' | 'retry' {
	return error instanceof ClaudeFeedbackBannedError || error instanceof ClaudeFeedbackSignInError ? 'stop' : 'retry';
}

export interface IClaudeFeedbackAutoSend {
	send(draft: ClaudeFeedbackDraft): Promise<number>;
	remove(id: string): void;
	/** Stores the new reason on a report that stays kept, so the form shows it. */
	keep(entry: ClaudeFeedbackUnsent): void;
	onSent(entry: ClaudeFeedbackUnsent, number: number): void;
	log(message: string): void;
}

/**
 * One pass over the kept reports, one at a time. A report that sends is removed. A network or
 * relay failure keeps it and ends the pass as `retry`; a ban or a missing sign-in keeps it with
 * the reason and ends it as `stop`. Returns `done` when no report is left.
 */
export async function autoSendClaudeFeedback(entries: readonly ClaudeFeedbackUnsent[], io: IClaudeFeedbackAutoSend): Promise<'done' | 'retry' | 'stop'> {
	for (const entry of entries) {
		try {
			const number = await io.send(entry.draft);
			io.remove(entry.id);
			io.onSent(entry, number);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (claudeFeedbackAutoSendFailure(error) === 'stop') {
				io.keep({ ...entry, error: message, attachment: undefined });
				io.log(`[feedback] auto-send stopped: ${message}`);
				return 'stop';
			}
			if (error instanceof ClaudeFeedbackSendError) {
				io.keep({ ...entry, error: message, attachment: error.attachment });
			}
			io.log(`[feedback] auto-send failed, will retry: ${message}`);
			return 'retry';
		}
	}
	return 'done';
}
