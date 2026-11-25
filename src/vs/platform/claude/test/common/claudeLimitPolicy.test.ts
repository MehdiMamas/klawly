/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeShouldResumeAtReset, readClaudeLimitOptions, readClaudeLimitPolicy, resolveClaudeLimitPolicy } from '../../common/claudeLimitPolicy.js';

suite('Claude limit policy (issue 1182)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('chat override beats global, and a policy the account does not allow falls back to ask', () => {
		const allowed = { allowExtraUsage: true, allowApiFallback: true };
		assert.deepStrictEqual([
			resolveClaudeLimitPolicy({}),
			resolveClaudeLimitPolicy({ globalPolicy: 'extraUsage', account: allowed }),
			resolveClaudeLimitPolicy({ globalPolicy: 'ask', chatPolicy: 'apiKey', account: allowed }),
			resolveClaudeLimitPolicy({ globalPolicy: 'extraUsage', account: {} }),
			resolveClaudeLimitPolicy({ chatPolicy: 'otherAccount' }),
			resolveClaudeLimitPolicy({ chatPolicy: 'otherAccount', otherAccountAvailable: true }),
		], [
			{ policy: 'ask', source: 'global' },
			{ policy: 'extraUsage', source: 'global' },
			{ policy: 'apiKey', source: 'chat' },
			{ policy: 'ask', source: 'global', blocked: 'extraUsage' },
			{ policy: 'ask', source: 'chat', blocked: 'otherAccount' },
			{ policy: 'otherAccount', source: 'chat' },
		]);
	});

	test('reads settings and drops values of the wrong type', () => {
		assert.deepStrictEqual([
			readClaudeLimitPolicy('apiKey'),
			readClaudeLimitPolicy('nope'),
			readClaudeLimitOptions({ work: { allowExtraUsage: true, extraUsageCapUsd: 10, kind: 'work' }, bad: 3, odd: { extraUsageCapUsd: -1, kind: 'x' } }),
		], [
			'apiKey',
			undefined,
			{
				work: { allowExtraUsage: true, extraUsageCapUsd: 10, allowApiFallback: undefined, kind: 'work' },
				odd: { allowExtraUsage: undefined, extraUsageCapUsd: undefined, allowApiFallback: undefined, kind: undefined },
			},
		]);
	});

	test('resumes at reset only when asked, rejected and the reset is ahead', () => {
		const rejected = { window: 'session' as const, status: 'rejected' as const, resetsAt: 2000 };
		assert.deepStrictEqual([
			claudeShouldResumeAtReset(rejected, 1000, true),
			claudeShouldResumeAtReset(rejected, 1000, false),
			claudeShouldResumeAtReset(rejected, 3000, true),
			claudeShouldResumeAtReset({ ...rejected, resetsAt: undefined }, 1000, true),
			claudeShouldResumeAtReset(undefined, 1000, true),
		], [true, false, false, false, false]);
	});
});
