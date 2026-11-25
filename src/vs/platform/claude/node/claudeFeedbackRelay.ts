/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { IRequestContext, IRequestOptions } from '../../../base/parts/request/common/request.js';
import { asText, IRequestService } from '../../request/common/request.js';
import { ClaudeFeedbackBan, ClaudeFeedbackSendResult, ClaudeFeedbackStatusResult, IClaudeFeedbackService } from '../common/claudeFeedbackRelay.js';

/**
 * Sent as `X-Klawly-Feedback-Key`. It ships in the app, so it is not a secret: it only
 * turns away requests that did not come from Klawly. The relay rate-limits the rest.
 * Never log it; the request service redacts the header in its trace log. The user's GitHub
 * token goes in `Authorization` (issue 949), which the request service redacts as well.
 */
const KLAWLY_FEEDBACK_CLIENT_KEY = 'klawly-feedback-v1-6f1d3c9e2a7b';

/** A report with images and logs is a few MB; give a slow uplink time to send it. */
const SEND_TIMEOUT_MS = 90_000;
const STATUS_TIMEOUT_MS = 15_000;

export type ClaudeFeedbackRequest = (options: IRequestOptions) => Promise<IRequestContext>;

/** Posts one report and sorts the outcome into {@link ClaudeFeedbackSendResult}. */
export async function postClaudeFeedback(request: ClaudeFeedbackRequest, endpoint: string, payload: string, token: string): Promise<ClaudeFeedbackSendResult> {
	let context: IRequestContext;
	try {
		context = await request({
			type: 'POST',
			url: endpoint,
			headers: { 'Content-Type': 'application/json', 'X-Klawly-Feedback-Key': KLAWLY_FEEDBACK_CLIENT_KEY, 'Authorization': `Bearer ${token}` },
			data: payload,
			timeout: SEND_TIMEOUT_MS,
			callSite: 'klawly.feedback',
		});
	} catch {
		return { kind: 'network' };
	}
	let text: string | null = null;
	try {
		text = await asText(context);
	} catch {
		// The body broke off; the status code is reported below.
	}
	const response = parseObject(text);
	const status = context.res.statusCode ?? 0;
	const ban = status === 403 ? parseBan(response.ban) : undefined;
	if (ban) {
		return { kind: 'banned', ban };
	}
	if (status === 401) {
		return { kind: 'login_required', message: typeof response.message === 'string' && response.message ? response.message : undefined };
	}
	if (status >= 200 && status < 300 && typeof response.number === 'number') {
		return { kind: 'sent', number: response.number };
	}
	const error = typeof response.error === 'string' && response.error ? response.error : undefined;
	// The relay says how long its rate limit lasts (issue 739); a proxy may only send the header.
	const header = context.res.headers['retry-after'];
	const retryAfter = Number(Array.isArray(header) ? header[0] : header);
	if (status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) {
		return { kind: 'rejected', status, error, retryAfter: Math.ceil(retryAfter) };
	}
	return { kind: 'rejected', status, error };
}

/** Asks the relay whether the account may send, and sorts the answer into {@link ClaudeFeedbackStatusResult}. */
export async function getClaudeFeedbackStatus(request: ClaudeFeedbackRequest, endpoint: string, token: string): Promise<ClaudeFeedbackStatusResult> {
	let context: IRequestContext;
	try {
		context = await request({
			type: 'GET',
			url: `${endpoint.replace(/\/+$/, '')}/status`,
			headers: { 'X-Klawly-Feedback-Key': KLAWLY_FEEDBACK_CLIENT_KEY, 'Authorization': `Bearer ${token}` },
			timeout: STATUS_TIMEOUT_MS,
			callSite: 'klawly.feedback.status',
		});
	} catch {
		return { kind: 'unavailable' };
	}
	let text: string | null = null;
	try {
		text = await asText(context);
	} catch {
		// Treated as unavailable below.
	}
	const response = parseObject(text);
	const status = context.res.statusCode ?? 0;
	if (status === 401) {
		return { kind: 'login_required' };
	}
	const ban = parseBan(response.ban);
	if (response.banned === true && ban) {
		return { kind: 'banned', ban };
	}
	if (status >= 200 && status < 300 && response.banned === false) {
		return { kind: 'ok', login: typeof response.login === 'string' ? response.login : '' };
	}
	return { kind: 'unavailable' };
}

function parseObject(text: string | null): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(text ?? '');
		return value && typeof value === 'object' ? value as Record<string, unknown> : {};
	} catch {
		// Not JSON: a proxy or gateway answered. The status code is reported by the caller.
		return {};
	}
}

function parseBan(value: unknown): ClaudeFeedbackBan | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const ban = value as Record<string, unknown>;
	if (typeof ban.login !== 'string') {
		return undefined;
	}
	const text = (field: unknown) => typeof field === 'string' ? field : '';
	return {
		login: ban.login,
		bannedAt: text(ban.bannedAt),
		reason: text(ban.reason),
		reportExcerpt: text(ban.reportExcerpt),
		issue: typeof ban.issue === 'number' ? ban.issue : undefined,
		appealEmail: text(ban.appealEmail) || 'https://github.com/MehdiMamas/klawly-ide/issues',
	};
}

export class ClaudeFeedbackService implements IClaudeFeedbackService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IRequestService private readonly _requests: IRequestService,
	) { }

	send(endpoint: string, payload: string, token: string): Promise<ClaudeFeedbackSendResult> {
		return postClaudeFeedback(options => this._requests.request(options, CancellationToken.None), endpoint, payload, token);
	}

	getStatus(endpoint: string, token: string): Promise<ClaudeFeedbackStatusResult> {
		return getClaudeFeedbackStatus(options => this._requests.request(options, CancellationToken.None), endpoint, token);
	}
}
