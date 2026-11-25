/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeAccountEntry } from '../../../../../platform/claude/common/claudeAccounts.js';
import { claudeLimitRetryOptions } from '../../common/claudeLimitBanner.js';

suite('claudeLimitRetryOptions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const personal: ClaudeAccountEntry = { id: 'default', email: 'me@example.com', plan: 'max', signedIn: true, active: true };
	const work: ClaudeAccountEntry = { id: 'work', email: 'me@work.example', plan: 'team', signedIn: true, active: false };
	const api: ClaudeAccountEntry = { id: 'api', signedIn: true, active: false };
	const signedOut: ClaudeAccountEntry = { id: 'old', email: 'old@example.com', plan: 'pro', signedIn: false, active: false };

	test('offers other signed-in accounts, extra usage and the API key only where allowed (issue 1385)', () => {
		const summary = (options: Parameters<typeof claudeLimitRetryOptions>[2]) => claudeLimitRetryOptions([personal, work, api, signedOut], 'default', options).map(option => `${option.id}:${option.accountId ?? '-'}:${option.policy}`);
		assert.deepStrictEqual({
			none: summary(undefined),
			all: summary({ allowExtraUsage: true, allowApiFallback: true }),
		}, {
			none: ['otherAccount:work:otherAccount'],
			all: ['otherAccount:work:otherAccount', 'extraUsage:-:extraUsage', 'apiKey:api:apiKey'],
		});
	});
});
