/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildWorkerHandoff, canMessageWorker, freshWorkerHint, messageWorker, canRestartWorker, canStopWorker, restartWorkerDisabledReason, stopWorkerDisabledReason, ClaudeWorkerControlServices, restartWorker, stopWorker } from '../../../../services/claude/common/claudeWorkerControls.js';
import { IClaudeWorkerRun } from '../../../../services/claude/common/claudeWorkerRegistry.js';

function run(patch: Partial<IClaudeWorkerRun>): IClaudeWorkerRun {
	return { id: 'a', number: '1', ownerSessionId: 's', name: 'w', kind: 'delegate', model: 'm', state: 'working', startedAt: 0, lastEventAt: 0, ...patch };
}

function services(calls: string[]): ClaudeWorkerControlServices {
	return {
		delegation: { stop: async id => { calls.push(`delegate.stop ${id}`); }, rerun: async id => { calls.push(`delegate.rerun ${id}`); return id !== 'norerun'; }, message: async (id, text) => { calls.push(`delegate.message ${id} ${text}`); return true; } },
		background: { stop: async id => { calls.push(`background.stop ${id}`); } },
		multitask: { stop: async id => { calls.push(`multitask.stop ${id}`); } },
	};
}

suite('Claude worker controls', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only a live run of a stoppable kind can be stopped', () => {
		assert.deepStrictEqual([
			canStopWorker(run({})),
			canStopWorker(run({ state: 'finished' })),
			canStopWorker(run({ kind: 'subagent' })),
			canStopWorker(run({ kind: 'background', state: 'waiting' })),
		], [true, false, false, true]);
	});

	test('only a working delegated run can be restarted', () => {
		assert.deepStrictEqual([
			canRestartWorker(run({})),
			canRestartWorker(run({ state: 'stopped' })),
			canRestartWorker(run({ kind: 'background' })),
		], [true, false, false]);
	});

	test('a disabled Stop or Restart explains itself in plain words', () => {
		assert.deepStrictEqual([
			stopWorkerDisabledReason(run({})),
			stopWorkerDisabledReason(run({ state: 'finished' })),
			stopWorkerDisabledReason(run({ kind: 'subagent' })),
			restartWorkerDisabledReason(run({})),
			restartWorkerDisabledReason(run({ state: 'stopped' })),
		], ['', 'This worker has already finished.', 'This worker is stopped in the chat that started it.', '', 'Only a working worker started from a chat can be restarted.']);
	});

	test('stop goes through the service that started the run', async () => {
		const calls: string[] = [];
		const s = services(calls);
		await stopWorker(run({ id: 'card1' }), s);
		await stopWorker(run({ id: 'background-t9', kind: 'background' }), s);
		await stopWorker(run({ id: 'multitask-ab12cd34-2', kind: 'multitask' }), s);
		await stopWorker(run({ id: 'multitask-ab12cd34', kind: 'multitask' }), s);
		assert.deepStrictEqual(calls, ['delegate.stop card1', 'background.stop t9', 'multitask.stop ab12cd34', 'multitask.stop ab12cd34']);
	});

	test('restart stops, then sends the task again', async () => {
		const calls: string[] = [];
		await restartWorker(run({ id: 'card1' }), services(calls));
		await restartWorker(run({ id: 'b', kind: 'background' }), services(calls));
		assert.deepStrictEqual(calls, ['delegate.stop card1', 'delegate.rerun card1']);
	});

	test('restart says whether the task was sent again', async () => {
		assert.deepStrictEqual([
			await restartWorker(run({ id: 'card1' }), services([])),
			await restartWorker(run({ id: 'norerun' }), services([])),
			await restartWorker(run({ id: 'b', kind: 'background' }), services([])),
		], [true, false, false]);
	});

	test('a delegated worker that is not stopped can be messaged, and the message goes to its card', async () => {
		const calls: string[] = [];
		assert.deepStrictEqual([
			canMessageWorker(run({})),
			canMessageWorker(run({ state: 'finished' })),
			canMessageWorker(run({ state: 'stopped' })),
			canMessageWorker(run({ kind: 'background' })),
			await messageWorker(run({}), 'use tabs', services(calls)),
			await messageWorker(run({ kind: 'background' }), 'x', services(calls)),
			calls,
		], [true, true, false, false, true, false, ['delegate.message a use tabs']]);
	});

	test('a large context gets a hint to hand off to a fresh worker', () => {
		assert.deepStrictEqual([
			freshWorkerHint(run({})),
			freshWorkerHint(run({ contextTokens: 99_999 })),
			freshWorkerHint(run({ contextTokens: 120_000 })),
		], ['', '', 'This worker\'s context is large (120k tokens). A fresh worker with a handoff will do better than another message.']);
	});

	test('the handoff has every checkpoint section and marks what is not recorded', () => {
		assert.strictEqual(buildWorkerHandoff(run({ name: 'api', objective: 'add the route', repo: 'klawly', worktree: '.worktrees/api', report: 'route added', acceptance: 'npm test passes', state: 'finished' })), [
			'Handoff from api',
			'',
			'Objective: add the route',
			'Decisions: not recorded',
			'Open: not recorded',
			'Branch: klawly .worktrees/api',
			'Done: route added',
			'Evidence: npm test passes',
			'Remaining: not recorded',
			'Risks: not recorded',
		].join('\n'));
	});
});
