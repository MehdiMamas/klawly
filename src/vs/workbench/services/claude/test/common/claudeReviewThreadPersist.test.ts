/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { deserializeReviewStats, serializeReviewStats, deserializeFindingThreads, deserializeReviewSignals, serializeFindingThreads, serializeReviewSignals } from '../../common/claudeReviewPersist.js';

suite('Claude review thread persistence', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('round trips replies and intended; drops empty threads and bad records', () => {
		const threads = [
			{ findingId: 'a', replies: [{ role: 'user' as const, text: 'why?' }, { role: 'assistant' as const, text: 'because' }] },
			{ findingId: 'b', replies: [], intended: true },
			{ findingId: 'c', replies: [] },
		];
		const json = serializeFindingThreads(threads);
		assert.deepStrictEqual({
			roundTrip: deserializeFindingThreads(json),
			notJson: deserializeFindingThreads('nope'),
			notArray: deserializeFindingThreads('{}'),
			bad: deserializeFindingThreads(JSON.stringify([null, { findingId: 1 }, { findingId: 'd', replies: [{ role: 'x', text: 'y' }, { role: 'user', text: '' }, { role: 'user', text: 'ok' }] }])),
		}, {
			roundTrip: [threads[0], threads[1]],
			notJson: [],
			notArray: [],
			bad: [{ findingId: 'd', replies: [{ role: 'user', text: 'ok' }] }],
		});
	});

	test('round trips dismissal counters; drops bad records', () => {
		const counters = [
			{ repo: '/r', category: 'style' as const, title: 'prefer const', count: 2, sample: 'Prefer const' },
			{ repo: '/r', category: 'bug' as const, title: 'x', count: 0, sample: 'X' },
		];
		assert.deepStrictEqual({
			roundTrip: deserializeReviewSignals(serializeReviewSignals(counters)),
			notJson: deserializeReviewSignals('nope'),
			bad: deserializeReviewSignals(JSON.stringify([null, { repo: '/r', category: 'nope', title: 't', count: 1, sample: 's' }, { repo: '/r', category: 'bug', title: 't', count: 1.5, sample: 's' }])),
		}, { roundTrip: [counters[0]], notJson: [], bad: [] });
	});

	test('review statistics round trip and skip bad entries (issue 937)', () => {
		const events = [{ time: 5, kind: 'fixed' as const, severity: 'high' as const, category: 'bug' as const, file: 'a.ts' }];
		assert.deepStrictEqual({
			roundTrip: deserializeReviewStats(serializeReviewStats(events)),
			notJson: deserializeReviewStats('nope'),
			bad: deserializeReviewStats(JSON.stringify([null, [1, 'zzz', 'high', 'bug', 'a.ts'], [2, 'raised', 'nope', 'bug', 'a.ts'], [3, 'raised', 'low', 'style', 'b.ts']])).map(e => e.time),
		}, { roundTrip: events, notJson: [], bad: [3] });
	});
});
