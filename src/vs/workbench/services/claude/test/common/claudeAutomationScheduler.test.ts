/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeAutomation } from '../../../../../platform/claude/common/claudeAutomation.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { CLAUDE_AUTOMATION_HEARTBEAT_MS, CLAUDE_AUTOMATION_LEASE_MS, CLAUDE_AUTOMATION_USER_GROUP, ClaudeAutomationScheduler, claudeAutomationWorkspaceGroup } from '../../common/claudeAutomationScheduler.js';

const USER = CLAUDE_AUTOMATION_USER_GROUP;
const MINUTE = 60 * 1000;

const everyMinute: ClaudeAutomation = { id: 'tick', name: 'tick', prompt: 'p', trigger: { type: 'schedule', cron: '* * * * *' }, permissionMode: 'agent', target: 'worktree', budgetUsd: 1, allowedTools: [], enabled: true };

suite('Claude automation scheduler (issue 426)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** Windows of one Klawly: one application storage and one clock. */
	function create(names: string[]) {
		const storage = store.add(new InMemoryStorageService());
		const clock = { now: Date.UTC(2026, 9, 12, 9, 0) };
		const windows = names.map(name => {
			const scheduler = store.add(new ClaudeAutomationScheduler(name, storage, () => clock.now));
			scheduler.setGroups([USER]);
			return scheduler;
		});
		/** Each window's heartbeat, in order; returns who gained what. */
		const beat = () => windows.map(window => window.heartbeat().join(','));
		const advance = (ms: number) => clock.now += ms;
		/** Every window checks the user group; returns what each would start. */
		const check = (enabled = true) => windows.map(window => {
			const result = window.check(USER, [everyMinute], enabled);
			return [...result.run.map(a => `run ${a.id}`), ...result.missed.map(a => `missed ${a.id}`)].join(',');
		});
		return { windows, beat, advance, check };
	}

	test('the first window to claim holds from its next heartbeat; the other never does', () => {
		const { windows, beat, advance } = create(['a', 'b']);
		const first = beat();
		advance(CLAUDE_AUTOMATION_HEARTBEAT_MS);
		const second = beat();
		advance(CLAUDE_AUTOMATION_HEARTBEAT_MS);
		const third = beat();
		assert.deepStrictEqual({ first, second, third, holds: windows.map(window => window.holds(USER)) }, {
			first: ['', ''],
			second: [USER, ''],
			third: ['', ''],
			holds: [true, false],
		});
	});

	test('a schedule starts in one window only', () => {
		const { beat, advance, check } = create(['a', 'b', 'c']);
		beat();
		advance(CLAUDE_AUTOMATION_HEARTBEAT_MS);
		beat();
		const first = check(); // Sets the last check.
		advance(MINUTE);
		beat();
		assert.deepStrictEqual({ first, next: check() }, {
			first: ['', '', ''],
			next: ['run tick', '', ''],
		});
	});

	test('when the runner closes, another window takes over at once and starts what fell due in between', () => {
		const { windows, beat, advance, check } = create(['a', 'b']);
		beat();
		advance(CLAUDE_AUTOMATION_HEARTBEAT_MS);
		beat();
		check();
		advance(MINUTE);
		windows[0].setGroups([]); // Window a closes.
		const claimed = windows[1].heartbeat();
		advance(CLAUDE_AUTOMATION_HEARTBEAT_MS);
		const gained = windows[1].heartbeat();
		assert.deepStrictEqual({ claimed, gained, checks: check() }, {
			claimed: [],
			gained: [USER],
			checks: ['', 'run tick'],
		});
	});

	test('a runner that stops renewing loses the lease once it expires', () => {
		const { windows, advance, check } = create(['a', 'b']);
		windows[0].heartbeat();
		advance(CLAUDE_AUTOMATION_HEARTBEAT_MS);
		windows[0].heartbeat();
		check();
		// Window a hangs; window b keeps beating.
		advance(CLAUDE_AUTOMATION_HEARTBEAT_MS);
		const beforeExpiry = windows[1].heartbeat();
		advance(CLAUDE_AUTOMATION_LEASE_MS);
		windows[1].heartbeat();
		advance(CLAUDE_AUTOMATION_HEARTBEAT_MS);
		const afterExpiry = windows[1].heartbeat();
		assert.deepStrictEqual({ beforeExpiry, afterExpiry, holds: windows.map(window => window.holds(USER)) }, {
			beforeExpiry: [],
			afterExpiry: [USER],
			holds: [false, true],
		});
	});

	test('after Klawly was closed for long, the missed runs are listed once, to run once each', () => {
		const { beat, advance, check } = create(['a', 'b']);
		beat();
		advance(CLAUDE_AUTOMATION_HEARTBEAT_MS);
		beat();
		check();
		advance(3 * 60 * MINUTE);
		beat(); // Reopened: window a claims again first.
		advance(CLAUDE_AUTOMATION_HEARTBEAT_MS);
		beat();
		const reopened = check();
		advance(MINUTE);
		beat();
		assert.deepStrictEqual({ reopened, next: check() }, {
			reopened: ['missed tick', ''],
			next: ['run tick', ''],
		});
	});

	test('a window without the lease catches up nothing after a long gap (issue 463)', () => {
		const { windows, beat, advance, check } = create(['a', 'b']);
		beat();
		advance(CLAUDE_AUTOMATION_HEARTBEAT_MS);
		beat();
		check();
		advance(3 * 60 * MINUTE);
		beat();
		advance(CLAUDE_AUTOMATION_HEARTBEAT_MS);
		beat();
		// Window a holds the lease again; window b, which does not, gets no missed run.
		assert.deepStrictEqual({ holds: windows.map(window => window.holds(USER)), reopened: check() }, { holds: [true, false], reopened: ['missed tick', ''] });
	});

	test('while automations are off the last check still advances, so turning them on reports nothing missed', () => {
		const { beat, advance, check } = create(['a']);
		beat();
		advance(CLAUDE_AUTOMATION_HEARTBEAT_MS);
		beat();
		check(false);
		for (let i = 0; i < 10; i++) {
			advance(MINUTE);
			beat();
			check(false);
		}
		advance(MINUTE);
		beat();
		assert.deepStrictEqual(check(true), ['run tick']);
	});

	test('each workspace has its own lease; runs are recorded per group and shared by every window', () => {
		const storage = store.add(new InMemoryStorageService());
		let now = Date.UTC(2026, 9, 12, 9, 0);
		const one = claudeAutomationWorkspaceGroup('file:///one');
		const two = claudeAutomationWorkspaceGroup('file:///two');
		const a = store.add(new ClaudeAutomationScheduler('a', storage, () => now));
		const b = store.add(new ClaudeAutomationScheduler('b', storage, () => now));
		a.setGroups([USER, one]);
		b.setGroups([USER, two]);
		a.heartbeat();
		b.heartbeat();
		now += CLAUDE_AUTOMATION_HEARTBEAT_MS;
		const gained = [a.heartbeat(), b.heartbeat()];
		a.record(one, { automationKey: 'workspace:tests', taskId: 'automation-tests-0a1b2c3d', trigger: 'manual', startedAt: now, state: 'complete' });
		assert.deepStrictEqual({ gained, seenByB: b.getState(one).runs?.['workspace:tests']?.state, groupOfLease: b.groupOfLeaseKey('claude.automations.lease:' + two) }, {
			gained: [[USER, one], [two]],
			seenByB: 'complete',
			groupOfLease: two,
		});
	});
});
