/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeDelegateTier } from '../../common/claudeDelegateContract.js';
import { climbClaudeDelegateLadder, ClaudeLadderCall, countTrailingFailedCalls, formatEscalationLogLine, readClaudeDelegationLadderThreshold, reachedClaudeLadderThreshold, sessionFallbackCause } from '../../common/claudeDelegateLadder.js';

/** Issue 839: the escalation ladder's counters and thresholds. */
suite('Claude delegate ladder', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const calls = (...states: ClaudeLadderCall['state'][]): ClaudeLadderCall[] => states.map(state => ({ state }));

	test('counts the failed calls at the end, skipping running ones and stopping at a success', () => {
		assert.deepStrictEqual([
			countTrailingFailedCalls([]),
			countTrailingFailedCalls(calls('failed', 'failed', 'success')),
			countTrailingFailedCalls(calls('success', 'failed', 'failed')),
			countTrailingFailedCalls(calls('failed', 'success', 'failed', 'running')),
			countTrailingFailedCalls(calls('failed', 'cancelled', 'failed')),
		], [0, 0, 2, 1, 1]);
	});

	test('a threshold of 0 is off, and a bad setting reads as the default', () => {
		assert.deepStrictEqual([
			reachedClaudeLadderThreshold(9, 0),
			reachedClaudeLadderThreshold(3, 4),
			reachedClaudeLadderThreshold(4, 4),
			readClaudeDelegationLadderThreshold(0, 4),
			readClaudeDelegationLadderThreshold(2.7, 4),
			readClaudeDelegationLadderThreshold(-1, 4),
			readClaudeDelegationLadderThreshold('3', 4),
		], [false, false, true, 0, 2, 4, 4]);
	});

	test('climbs Small to Medium to Large and skips a tier that runs the same model', () => {
		const models: Record<ClaudeDelegateTier, string> = { small: 'haiku', medium: 'sonnet', large: '' };
		const same: Record<ClaudeDelegateTier, string> = { small: 'haiku', medium: 'haiku', large: 'opus' };
		assert.deepStrictEqual([
			climbClaudeDelegateLadder('small', 'haiku', tier => models[tier]),
			climbClaudeDelegateLadder('medium', 'sonnet', tier => models[tier]),
			climbClaudeDelegateLadder('large', '', tier => models[tier]),
			climbClaudeDelegateLadder('small', 'haiku', tier => same[tier]),
			climbClaudeDelegateLadder('medium', 'sonnet', () => 'sonnet'),
			climbClaudeDelegateLadder(undefined, 'haiku', tier => models[tier]),
		], ['medium', 'large', undefined, 'large', undefined, undefined]);
	});

	test('a cheap turn goes back after 3 failed calls in a row or 30 steps, and each limit can be off', () => {
		const limits = { sessionFailedCalls: 3, sessionSteps: 30 };
		assert.deepStrictEqual([
			sessionFallbackCause(calls('failed', 'failed'), limits),
			sessionFallbackCause(calls('success', 'failed', 'failed', 'failed'), limits),
			sessionFallbackCause(Array.from({ length: 30 }, (_, i) => ({ state: i % 2 ? 'failed' : 'success' } as ClaudeLadderCall)), limits),
			sessionFallbackCause(calls('failed', 'failed', 'failed'), { sessionFailedCalls: 0, sessionSteps: 30 }),
			sessionFallbackCause(Array.from({ length: 40 }, () => ({ state: 'success' } as ClaudeLadderCall)), { sessionFailedCalls: 3, sessionSteps: 0 }),
		], [undefined, 'failed-calls', 'steps', undefined, undefined]);
	});

	test('the decision log line names the move, its cause and its count', () => {
		const line = JSON.parse(formatEscalationLogLine({ time: Date.UTC(2026, 9, 16), from: 'Haiku', to: 'Sonnet', fromTier: 'small', toTier: 'medium', cause: 'failed-calls', count: 4 }));
		assert.deepStrictEqual(line, { time: '2026-10-16T00:00:00.000Z', kind: 'escalation', from: 'Haiku', to: 'Sonnet', fromTier: 'small', toTier: 'medium', cause: 'failed-calls', count: 4 });
	});
});
