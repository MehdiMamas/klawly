/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeAutoReport, claudeAutoTotals, ClaudeAutoTaskEntry, claudeCiWaitOutcome, parseClaudeAutoTaskLog, upsertClaudeAutoTaskLine } from '../../common/claudeAutoTaskLog.js';

/** Issue 849: the local Auto log and its report. */
suite('Claude Auto task log', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const entry = (sessionId: string, patch: Partial<ClaudeAutoTaskEntry> = {}): ClaudeAutoTaskEntry => ({
		time: Date.UTC(2026, 9, 18, 12, 0),
		sessionId,
		approach: 'solo',
		models: ['Opus'],
		turns: 1,
		costUsd: 1,
		tokens: 50_000,
		compactions: 0,
		retries: 0,
		failures: 0,
		stalls: 0,
		escalations: 0,
		ciFirstTry: undefined,
		reviewRounds: 0,
		asked: undefined,
		...patch,
	});

	test('one line per chat: a newer entry replaces the older one and other lines stay', () => {
		const decision = JSON.stringify({ time: '2026-10-18T12:00:00.000Z', tier: 'small', runId: 'r1' });
		let lines = upsertClaudeAutoTaskLine([decision], entry('a', { turns: 1 }));
		lines = upsertClaudeAutoTaskLine(lines, entry('b'));
		lines = upsertClaudeAutoTaskLine(lines, entry('a', { turns: 3, approach: 'delegated', models: ['Opus', 'Haiku'], ciFirstTry: 'fail' }));
		assert.deepStrictEqual({ first: lines[0], parsed: parseClaudeAutoTaskLog(lines) }, {
			first: decision,
			parsed: [entry('b'), entry('a', { turns: 3, approach: 'delegated', models: ['Opus', 'Haiku'], ciFirstTry: 'fail' })],
		});
	});

	test('skips broken and foreign lines, and reads bad numbers as zero', () => {
		assert.deepStrictEqual(parseClaudeAutoTaskLog([
			'not json',
			JSON.stringify({ kind: 'escalation', from: 'Haiku' }),
			JSON.stringify({ kind: 'autoTask', sessionId: 's', time: 'bad', tokens: -4, costUsd: 'x', models: ['Opus', 3], ciFirstTry: 'maybe' }),
		]), [{
			time: 0, sessionId: 's', approach: 'solo', models: ['Opus'], turns: 0, costUsd: undefined, tokens: 0, compactions: 0,
			retries: 0, failures: 0, stalls: 0, escalations: 0, ciFirstTry: undefined, reviewRounds: 0, asked: undefined,
		}]);
	});

	test('reads the ci_wait outcome', () => {
		assert.deepStrictEqual([
			claudeCiWaitOutcome('[ci_wait] PASS · o/r PR #1\nRun: https://example.test'),
			claudeCiWaitOutcome('[ci_wait] FAIL · o/r PR #1'),
			claudeCiWaitOutcome('[ci_wait] ERROR · o/r run 5'),
			claudeCiWaitOutcome('The build passed.'),
		], ['pass', 'fail', 'fail', undefined]);
	});

	test('totals against the targets', () => {
		assert.deepStrictEqual(claudeAutoTotals([
			entry('a', { costUsd: 0.5, tokens: 20_000, ciFirstTry: 'pass' }),
			entry('b', { costUsd: 60, tokens: 300_000, compactions: 2, ciFirstTry: 'fail' }),
			entry('c', { costUsd: 1.5, tokens: 80_000 }),
			entry('d', { costUsd: 70, asked: true }),
		]), {
			tasks: 4,
			medianCostUsd: 30.75,
			medianTokens: 65_000,
			ciFirstTryRate: 0.5,
			expensiveUnasked: 1,
			compactedSpendShare: 60 / 132,
		});
	});

	test('the report has the targets and one row per chat, newest first', () => {
		const report = claudeAutoReport([entry('a', { costUsd: 0.8 }), entry('b', { time: Date.UTC(2026, 9, 18, 13, 5), approach: 'delegated', models: ['Opus', 'Sonnet'], ciFirstTry: 'pass', escalations: 1 })]);
		const rows = report.split('\n').filter(line => line.startsWith('| 2026'));
		assert.deepStrictEqual({
			rows,
			cost: report.split('\n').find(line => line.includes('Median cost')),
		}, {
			rows: [
				'| 2026-10-18 13:05 | Delegated | Opus, Sonnet | 1 | $1.00 | 50,000 | 0 | 0 | 0 | 0 | 1 | Passed | 0 |',
				'| 2026-10-18 12:00 | Solo | Opus | 1 | $0.80 | 50,000 | 0 | 0 | 0 | 0 | 0 | - | 0 |',
			],
			cost: '| Median cost per chat at most $1.20 | $0.90 | met |',
		});
		assert.ok(claudeAutoReport([]).includes('No Auto chats yet'));
	});
});
