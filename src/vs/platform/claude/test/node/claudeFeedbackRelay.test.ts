/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { bufferToStream, VSBuffer } from '../../../../base/common/buffer.js';
import { IRequestContext, IRequestOptions } from '../../../../base/parts/request/common/request.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeFeedbackRequest, getClaudeFeedbackStatus, postClaudeFeedback } from '../../node/claudeFeedbackRelay.js';

const ENDPOINT = 'https://relay.invalid/api/feedback';
const TOKEN = 'test-token-not-real';

function answer(statusCode: number, body: string, headers: Record<string, string> = {}): ClaudeFeedbackRequest {
	return async () => ({ res: { headers, statusCode }, stream: bufferToStream(VSBuffer.fromString(body)) } satisfies IRequestContext);
}

suite('Klawly feedback relay (issue 538)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('posts the JSON payload with the client key header and returns the issue number', async () => {
		const sent: IRequestOptions[] = [];
		const result = await postClaudeFeedback(async options => {
			sent.push(options);
			return answer(201, '{"number":538}')(options);
		}, ENDPOINT, '{"v":1}', TOKEN);
		const [options] = sent;
		const key = options.headers?.['X-Klawly-Feedback-Key'];
		assert.deepStrictEqual({
			result,
			type: options.type,
			url: options.url,
			data: options.data,
			contentType: options.headers?.['Content-Type'],
			// The key's value is never printed, even by a failing test.
			hasKey: typeof key === 'string' && key.length > 0,
			// The token's value is never printed either.
			authorization: options.headers?.Authorization === `Bearer ${TOKEN}`,
			hasTimeout: (options.timeout ?? 0) > 0,
		}, {
			result: { kind: 'sent', number: 538 },
			type: 'POST',
			url: ENDPOINT,
			data: '{"v":1}',
			contentType: 'application/json',
			hasKey: true,
			authorization: true,
			hasTimeout: true,
		});
	});

	test('sorts failures: unreachable relay, relay error, proxy page, success without a number', async () => {
		const unreachable: ClaudeFeedbackRequest = async () => {
			throw new Error('getaddrinfo ENOTFOUND relay.invalid');
		};
		assert.deepStrictEqual([
			await postClaudeFeedback(unreachable, ENDPOINT, '{}', TOKEN),
			await postClaudeFeedback(answer(429, '{"error":"Too many reports. Try again later."}'), ENDPOINT, '{}', TOKEN),
			// The relay's rate limit says how long it lasts (issue 739).
			await postClaudeFeedback(answer(429, '{"error":"Too many reports. Try again in 10 minutes.","retryAfter":594}', { 'retry-after': '594' }), ENDPOINT, '{}', TOKEN),
			await postClaudeFeedback(answer(502, '<html>Bad gateway</html>'), ENDPOINT, '{}', TOKEN),
			await postClaudeFeedback(answer(200, '{}'), ENDPOINT, '{}', TOKEN),
		], [
			{ kind: 'network' },
			{ kind: 'rejected', status: 429, error: 'Too many reports. Try again later.' },
			{ kind: 'rejected', status: 429, error: 'Too many reports. Try again in 10 minutes.', retryAfter: 594 },
			{ kind: 'rejected', status: 502, error: undefined },
			{ kind: 'rejected', status: 200, error: undefined },
		]);
	});

	test('a banned account and a missing sign-in come back as results, not errors (issue 949)', async () => {
		const ban = { login: 'octo-cat', bannedAt: '2026-10-14T10:00:00.000Z', reason: 'Abusive.', reportExcerpt: 'text', issue: 951, appealEmail: 'someone@example.com' };
		assert.deepStrictEqual([
			await postClaudeFeedback(answer(403, JSON.stringify({ error: 'banned', ban })), ENDPOINT, '{}', TOKEN),
			await postClaudeFeedback(answer(401, '{"error":"github_login_required","message":"Sign in."}'), ENDPOINT, '{}', TOKEN),
			// A 403 without a ban is an ordinary refusal.
			await postClaudeFeedback(answer(403, '{"error":"Forbidden"}'), ENDPOINT, '{}', TOKEN),
		], [
			{ kind: 'banned', ban },
			{ kind: 'login_required', message: 'Sign in.' },
			{ kind: 'rejected', status: 403, error: 'Forbidden' },
		]);
	});

	test('the status check sends the token and reads who is signed in and whether they are banned (issue 949)', async () => {
		const ban = { login: 'octo-cat', bannedAt: '2026-10-14T10:00:00.000Z', reason: 'Abusive.', reportExcerpt: 'text', issue: 951, appealEmail: 'someone@example.com' };
		const sent: IRequestOptions[] = [];
		const ok = await getClaudeFeedbackStatus(async options => {
			sent.push(options);
			return answer(200, '{"banned":false,"login":"octo-cat"}')(options);
		}, ENDPOINT, TOKEN);
		assert.deepStrictEqual({
			ok,
			url: sent[0].url,
			type: sent[0].type,
			authorization: sent[0].headers?.Authorization === `Bearer ${TOKEN}`,
			banned: await getClaudeFeedbackStatus(answer(200, JSON.stringify({ banned: true, ban })), ENDPOINT, TOKEN),
			loggedOut: await getClaudeFeedbackStatus(answer(401, '{}'), ENDPOINT, TOKEN),
			down: await getClaudeFeedbackStatus(answer(502, '<html></html>'), ENDPOINT, TOKEN),
		}, {
			ok: { kind: 'ok', login: 'octo-cat' },
			url: ENDPOINT + '/status',
			type: 'GET',
			authorization: true,
			banned: { kind: 'banned', ban },
			loggedOut: { kind: 'login_required' },
			down: { kind: 'unavailable' },
		});
	});
});
