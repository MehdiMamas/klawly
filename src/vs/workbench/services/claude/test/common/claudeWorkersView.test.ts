/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeWorkersViewThresholds, readClaudeWorkersMinutes } from '../../../../../platform/claude/common/claudeWorkersViewSettings.js';
import { IClaudeWorkerRun } from '../../common/claudeWorkerRegistry.js';
import { buildWorkerDetail, buildWorkerRows, summarizeWorkerSteps, workerFlags, workerFlagText } from '../../common/claudeWorkersView.js';

suite('Claude workers view', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const MIN = 60_000;
	const NOW = 1_000_000_000;
	const thresholds: ClaudeWorkersViewThresholds = { finishedMinutes: 5, hungMinutes: 10 };

	function run(id: string, extra: Partial<IClaudeWorkerRun> = {}): IClaudeWorkerRun {
		return {
			id, number: id, parentId: undefined, ownerSessionId: 'chat-1', name: `worker ${id}`, kind: 'delegate',
			model: 'Sonnet 5.5', state: 'working', escalations: 0, startedAt: NOW - 60 * MIN, lastEventAt: NOW,
			...extra,
		} as IClaudeWorkerRun;
	}

	function source(runs: IClaudeWorkerRun[]) {
		const costOf = (id: string): number => (runs.find(r => r.id === id)?.costUsd ?? 0) + runs.filter(r => r.parentId === id).reduce((sum, r) => sum + costOf(r.id), 0);
		return { all: () => runs, subtreeCost: costOf };
	}

	test('rows follow the tree with numbers, depth and subtree cost', () => {
		const rows = buildWorkerRows(source([
			run('1', { costUsd: 1 }),
			run('1-1', { parentId: '1', costUsd: 0.5 }),
			run('1-1-1', { parentId: '1-1', costUsd: 0.25 }),
			run('2'),
		]), NOW, thresholds);
		assert.deepStrictEqual(rows.map(r => [r.number, r.depth, r.subtreeCostUsd, r.hasChildren]), [
			['1', 0, 1.75, true], ['1-1', 1, 0.75, true], ['1-1-1', 2, 0.25, false], ['2', 0, 0, false],
		]);
	});

	test('a finished row is collapsed with its children hidden until expanded', () => {
		const runs = [run('1', { state: 'finished', endedAt: NOW }), run('1-1', { parentId: '1' })];
		const folded = buildWorkerRows(source(runs), NOW, thresholds);
		const open = buildWorkerRows(source(runs), NOW, thresholds, new Set(['1']));
		assert.deepStrictEqual({ folded: folded.map(r => [r.id, r.collapsed]), open: open.map(r => [r.id, r.collapsed]) }, {
			folded: [['1', true]],
			open: [['1', false], ['1-1', false]],
		});
	});

	test('idle flag appears for a finished run left open past the threshold', () => {
		const fresh = run('1', { state: 'finished', endedAt: NOW - 4 * MIN });
		const old = run('2', { state: 'finished', endedAt: NOW - 5 * MIN });
		assert.deepStrictEqual([workerFlags(fresh, NOW, thresholds), workerFlags(old, NOW, thresholds)], [[], ['idle']]);
	});

	test('hung flag appears for a working run with no news past the threshold', () => {
		const quick = run('1', { lastEventAt: NOW - 9 * MIN });
		const silent = run('2', { lastEventAt: NOW - 10 * MIN });
		const waiting = run('3', { state: 'waiting', lastEventAt: NOW - 30 * MIN });
		assert.deepStrictEqual([workerFlags(quick, NOW, thresholds), workerFlags(silent, NOW, thresholds), workerFlags(waiting, NOW, thresholds)], [[], ['hung'], []]);
	});

	test('messages and quiet flags', () => {
		const flags = workerFlags(run('1', { state: 'finished', endedAt: NOW, messagesWaiting: 2, quiet: true }), NOW, thresholds);
		const working = workerFlags(run('2', { quiet: true }), NOW, thresholds);
		assert.deepStrictEqual({ flags, working }, { flags: ['messages', 'quiet'], working: [] });
	});

	test('a threshold of 0 turns its flag off', () => {
		const off: ClaudeWorkersViewThresholds = { finishedMinutes: 0, hungMinutes: 0 };
		assert.deepStrictEqual([
			workerFlags(run('1', { state: 'finished', endedAt: NOW - 999 * MIN }), NOW, off),
			workerFlags(run('2', { lastEventAt: NOW - 999 * MIN }), NOW, off),
		], [[], []]);
	});

	test('minutes setting falls back on junk and clamps negatives', () => {
		assert.deepStrictEqual([readClaudeWorkersMinutes('x', 5), readClaudeWorkersMinutes(undefined, 7), readClaudeWorkersMinutes(3, 5), readClaudeWorkersMinutes(0, 5)], [5, 7, 3, 0]);
	});

	test('steps are summarized in words, not tool names', () => {
		assert.deepStrictEqual([
			summarizeWorkerSteps([]),
			summarizeWorkerSteps([{ tool: 'Read', state: 'success' }, { tool: 'Read', state: 'success' }, { tool: 'Bash', state: 'failed' }, { tool: 'Grep', state: 'success' }, { tool: 'Glob', state: 'success' }, { tool: 'Zap', state: 'success' }]),
		], ['No steps yet.', 'read files (2), ran commands (1, 1 failed), searched the code (2), used other tools (1)']);
	});

	test('a template worker row says its plain name and how it runs; other rows say nothing', () => {
		const rows = buildWorkerRows(source([run('1', { template: 'watch-ci' }), run('2'), run('3', { template: 'nonsense' })]), NOW, thresholds);
		assert.deepStrictEqual(rows.map(r => r.templateText), ['Watch CI · Small tier, reports failures only', undefined, undefined]);
	});

	test('detail shows facts, flags and a report fallback', () => {
		const detail = buildWorkerDetail(run('1', { state: 'finished', endedAt: NOW - 6 * MIN, lastEventAt: NOW - 6 * MIN, costUsd: 0.5, objective: 'Fix it' }), [], 1.5, NOW, thresholds);
		assert.deepStrictEqual({ title: detail.title, flags: detail.flags.length, report: detail.report, steps: detail.steps, objective: detail.facts.some(f => f.includes('Fix it')), cost: detail.facts.some(f => f.includes('$0.500') && f.includes('$1.50')) }, {
			title: 'worker 1', flags: 1, report: 'No report.', steps: 'No steps yet.', objective: true, cost: true,
		});
	});

	test('flag text is plural-aware and names Restart only when it is available', () => {
		const delegate = run('1', { kind: 'delegate', state: 'working', messagesWaiting: 1 });
		const other = run('2', { kind: 'background', state: 'working', messagesWaiting: 3 });
		assert.deepStrictEqual([
			workerFlagText('messages', delegate, thresholds),
			workerFlagText('messages', other, thresholds),
			workerFlagText('hung', delegate, thresholds).includes('restart'),
			workerFlagText('hung', other, thresholds).includes('restart'),
		], ['1 message was sent to it and it has not read it yet. It reads them when its current step ends.', '3 messages were sent to it and it has not read them yet. It reads them when its current step ends.', true, false]);
	});

	test('the idle flag states the fact and promises no action the view refuses', () => {
		const ended = run('1', { kind: 'delegate', state: 'finished' });
		assert.strictEqual(workerFlagText('idle', ended, thresholds), `Finished more than ${thresholds.finishedMinutes} min ago and is still open.`);
	});
});
