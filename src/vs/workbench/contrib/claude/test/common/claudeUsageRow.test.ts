/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeUsageRowParts, claudeUsageState, claudeUsageUpdatedLabel } from '../../common/claudeUsageRow.js';

const now = Date.UTC(2026, 9, 8, 12, 0);
const later = now + 2 * 60 * 60 * 1000;

suite('Claude usage row', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('hidden while nothing is known and for sign-ins without plan limits', () => {
		assert.deepStrictEqual([claudeUsageRowParts(undefined, now), claudeUsageRowParts([], now)], [[], []]);
	});

	test('shows the session and the week, with the session reset and the Settings meter levels', () => {
		assert.deepStrictEqual(claudeUsageRowParts([
			{ kind: 'weekOpus', percent: 99, resetsAt: later },
			{ kind: 'session', percent: 41.6, resetsAt: later },
			{ kind: 'week', percent: 80, resetsAt: later },
		], now), [
			{ kind: 'session', name: 'Session', percent: 42, level: 'normal', resetsAt: later },
			{ kind: 'week', name: 'Week', percent: 80, level: 'high', resetsAt: undefined },
		]);
	});

	test('a full window says when it resets; a reset in the past is left out', () => {
		assert.deepStrictEqual(claudeUsageRowParts([
			{ kind: 'session', percent: 120, resetsAt: now - 1000 },
			{ kind: 'week', percent: 100, resetsAt: later },
		], now), [
			{ kind: 'session', name: 'Session', percent: 100, level: 'full', resetsAt: undefined },
			{ kind: 'week', name: 'Week', percent: 100, level: 'full', resetsAt: later },
		]);
	});

	test('without a session or week window the first two windows show', () => {
		assert.deepStrictEqual(claudeUsageRowParts([
			{ kind: 'weekSonnet', percent: 10 },
			{ kind: 'model', label: 'Fable', percent: 5 },
			{ kind: 'weekOpus', percent: 50 },
		], now).map(part => part.name), ['Sonnet Week', 'Fable']);
	});

	test('says how old the limits are, and "just now" for the first minute (issue 704)', () => {
		const current = Date.now();
		assert.deepStrictEqual(
			[claudeUsageUpdatedLabel(current - 10_000, current), claudeUsageUpdatedLabel(current - 5 * 60_000, current)],
			['Updated just now', 'Updated 5 mins ago'],
		);
	});

	test('"none" is only for an empty answer; a wait or a failure never reads as none (issue 942)', () => {
		const windows = [{ kind: 'session' as const, percent: 10 }];
		assert.deepStrictEqual({
			numbers: claudeUsageState({ usage: windows }, false),
			numbersWhileRefreshing: claudeUsageState({ usage: windows }, true),
			loading: claudeUsageState({ usage: undefined }, true),
			loadingNoOverview: claudeUsageState(undefined, true),
			failed: claudeUsageState({ usage: undefined, usageFailed: true }, false),
			failedWithOld: claudeUsageState({ usage: [], usageFailed: true }, false),
			none: claudeUsageState({ usage: [] }, false),
			notAsked: claudeUsageState({ usage: undefined }, false),
		}, {
			numbers: 'windows',
			numbersWhileRefreshing: 'windows',
			loading: 'loading',
			loadingNoOverview: 'loading',
			failed: 'failed',
			failedWithOld: 'failed',
			none: 'none',
			notAsked: 'unknown',
		});
	});
});
