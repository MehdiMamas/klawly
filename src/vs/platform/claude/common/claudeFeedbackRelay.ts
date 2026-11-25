/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

/** Shared-process channel for {@link IClaudeFeedbackService}. */
export const CLAUDE_FEEDBACK_CHANNEL = 'claudeFeedback';

export const IClaudeFeedbackService = createDecorator<IClaudeFeedbackService>('claudeFeedbackService');

/** Why a GitHub account may not send feedback (issue 949). The relay words every field. */
export interface ClaudeFeedbackBan {
	readonly login: string;
	/** ISO date the account was banned. */
	readonly bannedAt: string;
	readonly reason: string;
	/** The start of the report that earned the ban, as plain text. */
	readonly reportExcerpt: string;
	/** The issue number of that report, when the relay names one. */
	readonly issue?: number;
	/** Where to write to appeal the ban. */
	readonly appealEmail: string;
}

/** How a Send Feedback post ended. */
export type ClaudeFeedbackSendResult =
	/** The relay filed the report as issue `number`. */
	| { readonly kind: 'sent'; readonly number: number }
	/** The relay could not be reached: offline, DNS, proxy, TLS or a timeout. */
	| { readonly kind: 'network' }
	/** The relay wants a GitHub sign-in: no token, or one GitHub no longer accepts (401). Older builds get this too (issue 949). */
	| { readonly kind: 'login_required'; readonly message?: string }
	/** The sender's GitHub account is banned (403, issue 949). */
	| { readonly kind: 'banned'; readonly ban: ClaudeFeedbackBan }
	/** The relay (or a proxy in front of it) answered without filing the report. */
	| { readonly kind: 'rejected'; readonly status: number; readonly error?: string; /** Seconds to wait, from a 429's `Retry-After` (issue 739). */ readonly retryAfter?: number };

/** What `GET /api/feedback/status` says about the signed-in GitHub account (issue 949). */
export type ClaudeFeedbackStatusResult =
	| { readonly kind: 'ok'; readonly login: string }
	| { readonly kind: 'banned'; readonly ban: ClaudeFeedbackBan }
	| { readonly kind: 'login_required' }
	/** Offline or an answer that is not the status: the form still opens, the send reports the real reason. */
	| { readonly kind: 'unavailable' };

/**
 * Posts Send Feedback reports to the relay (issue 538). It runs in the shared process
 * on the Node request service, so the renderer never makes the cross-origin call (the
 * relay answers no CORS preflight) and proxy settings apply.
 */
export interface IClaudeFeedbackService {
	readonly _serviceBrand: undefined;

	/**
	 * Posts `payload` (the JSON request body) to `endpoint` as the GitHub account `token` belongs
	 * to (issue 949). Never throws for network or HTTP failures. The token is never logged.
	 */
	send(endpoint: string, payload: string, token: string): Promise<ClaudeFeedbackSendResult>;

	/** Asks the relay whether the account `token` belongs to may send feedback (`<endpoint>/status`). */
	getStatus(endpoint: string, token: string): Promise<ClaudeFeedbackStatusResult>;
}
