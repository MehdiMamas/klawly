/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';

/** A local change waits this long for more changes before it syncs. */
export const KLAWLY_SYNC_CHANGE_DELAY_MS = 3_000;
/** Safety net: sync at least this often. */
export const KLAWLY_SYNC_INTERVAL_MS = 5 * 60_000;

export interface IKlawlySyncTimers {
	setTimeout(callback: () => void, ms: number): IDisposable;
	setInterval(callback: () => void, ms: number): IDisposable;
}

/**
 * When Klawly Sync runs: at startup, on window focus, about 3 s after a local change (changes
 * inside that window collapse into one run) and every 5 minutes. Runs never overlap: a trigger
 * that arrives during a run asks for one more run right after it. Paused means no runs at all.
 */
export class KlawlySyncScheduler extends Disposable {

	private _running = false;
	private _again = false;
	private _paused = false;
	private _changeTimer: IDisposable | undefined;

	constructor(
		private readonly _run: () => Promise<void>,
		private readonly _timers: IKlawlySyncTimers,
	) {
		super();
		this._register(this._timers.setInterval(() => this.trigger(), KLAWLY_SYNC_INTERVAL_MS));
	}

	get paused(): boolean {
		return this._paused;
	}

	setPaused(paused: boolean): void {
		this._paused = paused;
		if (paused) {
			this._cancelChange();
		} else {
			this.trigger();
		}
	}

	/** Startup and window focus: run now. */
	trigger(): void {
		if (this._paused) {
			return;
		}
		if (this._running) {
			this._again = true;
			return;
		}
		void this._start();
	}

	/** A local file changed: run after the quiet period. */
	notifyLocalChange(): void {
		if (this._paused) {
			return;
		}
		this._cancelChange();
		this._changeTimer = this._timers.setTimeout(() => {
			this._cancelChange();
			this.trigger();
		}, KLAWLY_SYNC_CHANGE_DELAY_MS);
	}

	/** Resolves when no run is going. Tests and shutdown use it. */
	async idle(): Promise<void> {
		while (this._running) {
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		}
	}

	private async _start(): Promise<void> {
		this._running = true;
		try {
			do {
				this._again = false;
				try {
					await this._run();
				} catch {
					// the run reports its own errors; the next trigger tries again
				}
			} while (this._again && !this._paused);
		} finally {
			this._running = false;
		}
	}

	private _cancelChange(): void {
		this._changeTimer?.dispose();
		this._changeTimer = undefined;
	}

	override dispose(): void {
		this._cancelChange();
		super.dispose();
	}
}
