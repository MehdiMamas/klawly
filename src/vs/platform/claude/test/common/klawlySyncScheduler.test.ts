/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IKlawlySyncTimers, KLAWLY_SYNC_CHANGE_DELAY_MS, KLAWLY_SYNC_INTERVAL_MS, KlawlySyncScheduler } from '../../common/klawlySyncScheduler.js';

/** A clock the test moves by hand. */
class ManualTimers implements IKlawlySyncTimers {
	now = 0;
	private readonly _timers = new Set<{ at: number; every?: number; callback: () => void }>();

	setTimeout(callback: () => void, ms: number): IDisposable {
		const timer = { at: this.now + ms, callback };
		this._timers.add(timer);
		return { dispose: () => { this._timers.delete(timer); } };
	}

	setInterval(callback: () => void, ms: number): IDisposable {
		const timer = { at: this.now + ms, every: ms, callback };
		this._timers.add(timer);
		return { dispose: () => { this._timers.delete(timer); } };
	}

	advance(ms: number): void {
		const end = this.now + ms;
		for (; ;) {
			const due = [...this._timers].filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
			if (!due) {
				break;
			}
			this.now = due.at;
			if (due.every) {
				due.at += due.every;
			} else {
				this._timers.delete(due);
			}
			due.callback();
		}
		this.now = end;
	}
}

suite('KlawlySyncScheduler', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function make() {
		const timers = new ManualTimers();
		const runs: number[] = [];
		const scheduler = store.add(new KlawlySyncScheduler(async () => { runs.push(timers.now); }, timers));
		return { timers, runs, scheduler };
	}

	test('changes inside the quiet period collapse into one run 3 s after the last one', async () => {
		const { timers, runs, scheduler } = make();
		scheduler.notifyLocalChange();
		timers.advance(2_000);
		scheduler.notifyLocalChange();
		timers.advance(KLAWLY_SYNC_CHANGE_DELAY_MS - 1);
		await scheduler.idle();
		assert.deepStrictEqual(runs, []);
		timers.advance(1);
		await scheduler.idle();
		assert.deepStrictEqual(runs, [2_000 + KLAWLY_SYNC_CHANGE_DELAY_MS]);
	});

	test('runs every 5 minutes, and a trigger during a run asks for one more run, never two at once', async () => {
		const timers = new ManualTimers();
		let active = 0;
		let peak = 0;
		let count = 0;
		let release!: () => void;
		const scheduler = store.add(new KlawlySyncScheduler(async () => {
			active++;
			peak = Math.max(peak, active);
			count++;
			if (count === 1) {
				await new Promise<void>(resolve => { release = resolve; });
			}
			active--;
		}, timers));
		scheduler.trigger();
		scheduler.trigger();
		scheduler.trigger();
		release();
		await scheduler.idle();
		assert.deepStrictEqual({ count, peak }, { count: 2, peak: 1 });
		timers.advance(KLAWLY_SYNC_INTERVAL_MS);
		await scheduler.idle();
		assert.strictEqual(count, 3);
	});

	test('paused means no runs; resuming syncs at once', async () => {
		const { timers, runs, scheduler } = make();
		scheduler.setPaused(true);
		scheduler.trigger();
		scheduler.notifyLocalChange();
		timers.advance(KLAWLY_SYNC_INTERVAL_MS);
		await scheduler.idle();
		assert.deepStrictEqual(runs, []);
		scheduler.setPaused(false);
		await scheduler.idle();
		assert.strictEqual(runs.length, 1);
	});
});
