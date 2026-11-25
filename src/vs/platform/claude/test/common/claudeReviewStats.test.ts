/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_REVIEW_STATS_MAX_EVENTS, ClaudeReviewStatEvent, claudeReviewStatsCsv, recordClaudeReviewStats, summarizeClaudeReviewStats, trimClaudeReviewStats } from '../../common/claudeReviewStats.js';

suite('Claude review statistics (issue 937)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const DAY = 24 * 60 * 60 * 1000;
	const now = Date.UTC(2026, 9, 18);
	const event = (daysAgo: number, kind: ClaudeReviewStatEvent['kind'], file = 'a.ts', category: ClaudeReviewStatEvent['category'] = 'bug', severity: ClaudeReviewStatEvent['severity'] = 'medium'): ClaudeReviewStatEvent =>
		({ time: now - daysAgo * DAY, kind, file, category, severity });

	test('summary counts the period only, with the addressed rate and top lists', () => {
		const events = [
			event(1, 'raised', 'a.ts'), event(1, 'raised', 'a.ts'), event(2, 'raised', 'b.ts', 'style'), event(2, 'raised', 'c.ts'),
			event(1, 'fixed'), event(2, 'dismissed', 'b.ts', 'style'), event(3, 'dismissed', 'b.ts', 'style'),
			event(20, 'raised', 'old.ts'),
		];
		const week = summarizeClaudeReviewStats(events, '7d', now);
		assert.deepStrictEqual({ total: week.total, rate: week.addressedRate, dismissed: week.mostDismissed, files: week.topFiles }, {
			total: { raised: 4, fixed: 1, dismissed: 2, ignored: 0 },
			rate: 0.75,
			dismissed: [{ category: 'style', dismissed: 2 }],
			files: [{ file: 'a.ts', raised: 2 }, { file: 'b.ts', raised: 1 }, { file: 'c.ts', raised: 1 }],
		});
		assert.strictEqual(summarizeClaudeReviewStats(events, '30d', now).total.raised, 5);
	});

	test('an empty log gives zeros', () => {
		const summary = summarizeClaudeReviewStats([], '90d', now);
		assert.deepStrictEqual({ total: summary.total, rate: summary.addressedRate, severities: summary.bySeverity.length }, { total: { raised: 0, fixed: 0, dismissed: 0, ignored: 0 }, rate: 0, severities: 0 });
	});

	test('trim drops events older than 90 days and caps the count', () => {
		assert.deepStrictEqual(trimClaudeReviewStats([event(91, 'raised'), event(89, 'raised')], now).map(e => e.time), [now - 89 * DAY]);
		const many = Array.from({ length: CLAUDE_REVIEW_STATS_MAX_EVENTS + 5 }, (_, index) => ({ ...event(1, 'raised'), time: now - DAY + index }));
		const kept = trimClaudeReviewStats(many, now);
		assert.deepStrictEqual({ length: kept.length, first: kept[0].time }, { length: CLAUDE_REVIEW_STATS_MAX_EVENTS, first: many[5].time });
		assert.strictEqual(recordClaudeReviewStats([event(100, 'raised')], [event(0, 'fixed')], now).length, 1);
	});

	test('csv has a header, quotes commas and defuses formulas', () => {
		const csv = claudeReviewStatsCsv([event(0, 'raised', 'a,b.ts'), event(0, 'fixed', '=cmd.ts')]);
		assert.deepStrictEqual(csv.split('\n'), [
			'time,event,severity,category,file',
			'2026-10-18T00:00:00.000Z,raised,medium,bug,"a,b.ts"',
			'2026-10-18T00:00:00.000Z,fixed,medium,bug,\'=cmd.ts',
			'',
		]);
	});
});
