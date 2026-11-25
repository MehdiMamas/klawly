/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { acquireKlawlySyncLock, KLAWLY_SYNC_LOCK_STALE_MS } from '../../node/klawlySyncLock.js';

suite('Klawly Sync lock', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	setup(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), 'klawly-sync-lock-'));
	});
	teardown(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	test('only one writer holds the lock, and release lets the next one in', async () => {
		const path = join(dir, '.sync', 'lock');
		const first = await acquireKlawlySyncLock(path, 1);
		assert.ok(first);
		assert.strictEqual(await acquireKlawlySyncLock(path, 2), undefined);
		await first.release();
		const second = await acquireKlawlySyncLock(path, 2);
		assert.ok(second);
		await second.release();
	});

	test('a lock with no heartbeat for 30 s is stale and taken over', async () => {
		const path = join(dir, '.sync', 'lock');
		let clock = 1_000;
		await acquireKlawlySyncLock(path, 1, () => clock);
		clock += KLAWLY_SYNC_LOCK_STALE_MS - 1;
		assert.strictEqual(await acquireKlawlySyncLock(path, 2, () => clock), undefined);
		clock += 2;
		assert.ok(await acquireKlawlySyncLock(path, 2, () => clock));
		assert.strictEqual(JSON.parse(await fs.readFile(path, 'utf8')).pid, 2);
	});

	test('a heartbeat keeps the lock alive', async () => {
		const path = join(dir, '.sync', 'lock');
		let clock = 1_000;
		const lock = await acquireKlawlySyncLock(path, 1, () => clock);
		clock += 20_000;
		await lock!.heartbeat();
		clock += 20_000;
		assert.strictEqual(await acquireKlawlySyncLock(path, 2, () => clock), undefined);
	});
});
