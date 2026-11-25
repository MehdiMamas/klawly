/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { dirname } from '../../../base/common/path.js';

/** A lock whose heartbeat is older than this is dead, and the next machine process takes it over. */
export const KLAWLY_SYNC_LOCK_STALE_MS = 30_000;

interface LockContent {
	readonly pid: number;
	readonly heartbeat: number;
}

export interface IKlawlySyncLock {
	/** Keeps the lock alive. Call it at least every 10 s while syncing. */
	heartbeat(): Promise<void>;
	release(): Promise<void>;
}

/**
 * One sync writer per machine (issue 447): `~/.klawly/claude/.sync/lock`, created exclusively
 * (`wx`), holding the pid and a heartbeat. Returns `undefined` when another live writer holds it,
 * so a second Klawly window does not sync at the same time. A lock not refreshed for 30 s is stale.
 */
export async function acquireKlawlySyncLock(lockPath: string, pid: number, now: () => number = Date.now): Promise<IKlawlySyncLock | undefined> {
	await fs.mkdir(dirname(lockPath), { recursive: true });
	const write = (flag: 'wx' | 'w') => fs.writeFile(lockPath, JSON.stringify({ pid, heartbeat: now() } satisfies LockContent), { flag });
	try {
		await write('wx');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
			throw error;
		}
		let held: LockContent | undefined;
		try {
			held = JSON.parse(await fs.readFile(lockPath, 'utf8')) as LockContent;
		} catch {
			held = undefined; // unreadable: treat as stale
		}
		if (held && held.pid !== pid && now() - held.heartbeat < KLAWLY_SYNC_LOCK_STALE_MS) {
			return undefined;
		}
		// Stale: remove it and race for it again with the exclusive create, so two takers cannot both win.
		await fs.rm(lockPath, { force: true });
		try {
			await write('wx');
		} catch (again) {
			if ((again as NodeJS.ErrnoException).code === 'EEXIST') {
				return undefined;
			}
			throw again;
		}
	}
	return {
		heartbeat: () => write('w'),
		release: () => fs.rm(lockPath, { force: true }),
	};
}
