/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { normalizeClaudeFastMode, sameClaudeFastModeStatus } from '../../common/claudeFastMode.js';

suite('Claude fast mode state (issue 456)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('each SDK state normalizes to on, cooling down, unavailable or off', () => {
		assert.deepStrictEqual([
			normalizeClaudeFastMode({}),
			normalizeClaudeFastMode({ fast_mode_state: 'on' }),
			normalizeClaudeFastMode({ fast_mode_state: 'off' }),
			normalizeClaudeFastMode({ fast_mode_state: 'cooldown' }),
			normalizeClaudeFastMode({ fast_mode_state: 'unavailable' }),
			normalizeClaudeFastMode({ fast_mode_state: 'something-new' }),
			normalizeClaudeFastMode({ fast_mode_state: 42 }),
		], [
			undefined,
			{ state: 'on' },
			{ state: 'off' },
			{ state: 'cooldown' },
			{ state: 'unavailable', reason: 'other' },
			{ state: 'off' },
			undefined,
		]);
	});

	test('a cooldown keeps its return time whether it is given in seconds, milliseconds or as a date', () => {
		const at = Date.UTC(2030, 0, 2, 3, 4, 5);
		assert.deepStrictEqual([
			normalizeClaudeFastMode({ fast_mode_state: 'cooldown', fast_mode_cooldown_until: at }),
			normalizeClaudeFastMode({ fast_mode_state: 'cooldown', fast_mode_resets_at: at / 1000 }),
			normalizeClaudeFastMode({ fast_mode_state: 'cooldown', fast_mode_cooldown_until: new Date(at).toISOString() }),
			normalizeClaudeFastMode({ fast_mode_state: 'cooldown', fast_mode_cooldown_until: 'soon' }),
		], [
			{ state: 'cooldown', resumesAt: at },
			{ state: 'cooldown', resumesAt: at },
			{ state: 'cooldown', resumesAt: at },
			{ state: 'cooldown' },
		]);
	});

	test('each disabled reason reads as a plain reason, and unknown text is kept as the detail', () => {
		const reason = (text: unknown) => normalizeClaudeFastMode({ fast_mode_state: 'unavailable', fast_mode_disabled_reason: text });
		assert.deepStrictEqual([
			reason('rate_limit'),
			reason('overloaded'),
			reason('org_not_enabled'),
			reason('billing_issue'),
			reason('model_not_supported'),
			reason('weekend maintenance'),
			reason(7),
		], [
			{ state: 'unavailable', reason: 'rate-limit' },
			{ state: 'unavailable', reason: 'overloaded' },
			{ state: 'unavailable', reason: 'not-enabled' },
			{ state: 'unavailable', reason: 'billing' },
			{ state: 'unavailable', reason: 'model' },
			{ state: 'unavailable', reason: 'other', detail: 'weekend maintenance' },
			{ state: 'unavailable', reason: 'other' },
		]);
	});

	test('a reason with a state that is off or unknown still reads as unavailable; a reason alone does too', () => {
		assert.deepStrictEqual([
			normalizeClaudeFastMode({ fast_mode_state: 'off', fast_mode_disabled_reason: 'overloaded' }),
			normalizeClaudeFastMode({ fast_mode_disabled_reason: 'rate_limit' }),
		], [
			{ state: 'unavailable', reason: 'overloaded' },
			{ state: 'unavailable', reason: 'rate-limit' },
		]);
	});

	test('two statuses are the same when state and reason match, whatever the return time', () => {
		assert.deepStrictEqual([
			sameClaudeFastModeStatus(undefined, undefined),
			sameClaudeFastModeStatus({ state: 'on' }, undefined),
			sameClaudeFastModeStatus({ state: 'on' }, { state: 'on' }),
			sameClaudeFastModeStatus({ state: 'cooldown', resumesAt: 1 }, { state: 'cooldown', resumesAt: 2 }),
			sameClaudeFastModeStatus({ state: 'unavailable', reason: 'billing' }, { state: 'unavailable', reason: 'model' }),
			sameClaudeFastModeStatus({ state: 'on' }, { state: 'cooldown' }),
		], [true, false, true, true, false, false]);
	});
});
