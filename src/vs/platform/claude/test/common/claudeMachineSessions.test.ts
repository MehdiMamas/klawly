/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { buildMachineSessionRows, IClaudeMachineSession, machineSessionKeepReason, machineSessionState, MACHINE_SESSION_IDLE_MS, MACHINE_SESSION_WAIT_KEEP_MS, planMachineCleanup } from '../../common/claudeMachineSessions.js';

const NOW = 1_000_000_000_000;

function session(sessionId: string, overrides: Partial<IClaudeMachineSession> = {}): IClaudeMachineSession {
	return {
		id: sessionId,
		sessionId,
		name: sessionId,
		cwd: `C:\\work\\${sessionId}`,
		kind: 'background',
		rawState: 'working',
		startedAt: NOW - 1000,
		updatedAt: NOW - 1000,
		parentSessionId: undefined,
		contextTokens: undefined,
		model: undefined,
		costUsd: undefined,
		unpushed: 0,
		dirty: false,
		waitingOnCi: false,
		...overrides,
	};
}

suite('Every Claude session on this PC (issue 1251)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('state maps to plain words: working, idle, waiting, finished, stopped, failed', () => {
		const phase = (s: IClaudeMachineSession) => machineSessionState(s, NOW).phase;
		assert.deepStrictEqual({
			working: phase(session('a')),
			idle: phase(session('b', { updatedAt: NOW - MACHINE_SESSION_IDLE_MS })),
			idleText: machineSessionState(session('b', { updatedAt: NOW - 12 * 60_000 }), NOW).text,
			waiting: phase(session('c', { rawState: 'blocked' })),
			finished: phase(session('d', { rawState: 'done' })),
			stopped: phase(session('e', { rawState: 'stopped' })),
			failed: phase(session('f', { rawState: 'failed' })),
		}, {
			working: 'working',
			idle: 'idle',
			idleText: 'Idle for 12 min',
			waiting: 'waiting',
			finished: 'finished',
			stopped: 'stopped',
			failed: 'failed',
		});
	});

	test('managers come first, each followed by its workers; unknown parents and cycles are still shown', () => {
		const rows = buildMachineSessionRows([
			session('worker1', { parentSessionId: 'mgr', startedAt: NOW - 500 }),
			session('mgr', { startedAt: NOW - 900 }),
			session('orphan', { parentSessionId: 'gone', startedAt: NOW - 100 }),
			session('loopA', { parentSessionId: 'loopB' }),
			session('loopB', { parentSessionId: 'loopA' }),
		], NOW);
		assert.deepStrictEqual(rows.map(row => [row.session.sessionId, row.depth, row.workerCount]), [
			['orphan', 0, 0],
			['mgr', 0, 1],
			['worker1', 1, 0],
			['loopA', 0, 1],
			['loopB', 1, 0],
		]);
	});

	test('actions follow the state: Stop while running, Resume and Delete once not running, nothing for a terminal session', () => {
		const rows = buildMachineSessionRows([
			session('run'),
			session('fail', { rawState: 'failed' }),
			session('done', { rawState: 'done' }),
			session('term', { kind: 'interactive', rawState: undefined }),
		], NOW);
		const flags = (id: string) => {
			const row = rows.find(r => r.session.sessionId === id)!;
			return [row.canStop, row.canKill, row.canResume, row.canDelete];
		};
		assert.deepStrictEqual({ run: flags('run'), fail: flags('fail'), done: flags('done'), term: flags('term') }, {
			run: [true, true, false, false],
			fail: [false, false, true, true],
			done: [false, false, false, true],
			term: [false, false, false, false],
		});
	});

	test('keep rules: unpushed commits, dirty folder, CI, a recent decision and working are kept', () => {
		const reasons = {
			unpushed: machineSessionKeepReason(session('a', { rawState: 'done', unpushed: 2 }), NOW) !== undefined,
			dirty: machineSessionKeepReason(session('b', { rawState: 'done', dirty: true }), NOW) !== undefined,
			ci: machineSessionKeepReason(session('c', { rawState: 'done', waitingOnCi: true }), NOW) !== undefined,
			recentWait: machineSessionKeepReason(session('d', { rawState: 'blocked', updatedAt: NOW - 60_000 }), NOW) !== undefined,
			oldWait: machineSessionKeepReason(session('e', { rawState: 'blocked', updatedAt: NOW - MACHINE_SESSION_WAIT_KEEP_MS }), NOW),
			working: machineSessionKeepReason(session('f'), NOW) !== undefined,
			finished: machineSessionKeepReason(session('g', { rawState: 'done' }), NOW),
		};
		assert.deepStrictEqual(reasons, { unpushed: true, dirty: true, ci: true, recentWait: true, oldWait: undefined, working: true, finished: undefined });
	});

	test('cleanup deletes finished, stopped, failed and idle background sessions, stops idle ones first, keeps the rest with a reason', () => {
		const rows = buildMachineSessionRows([
			session('finished', { rawState: 'done' }),
			session('idle', { updatedAt: NOW - 30 * 60_000 }),
			session('unpushed', { rawState: 'done', unpushed: 1 }),
			session('working'),
			session('term', { kind: 'interactive', rawState: undefined, updatedAt: NOW - 3_600_000 }),
		], NOW);
		const plan = planMachineCleanup(rows, NOW);
		assert.deepStrictEqual({
			steps: plan.steps.map(step => [step.session.sessionId, step.stopFirst]).sort(),
			kept: plan.kept.map(entry => entry.session.sessionId),
		}, {
			steps: [['finished', false], ['idle', true]],
			kept: ['unpushed'],
		});
	});
});
