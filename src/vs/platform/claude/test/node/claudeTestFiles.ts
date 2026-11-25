/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { rmSync } from 'fs';

/** Blocks for `ms`. The Electron test renderer is not cross-origin isolated, so `SharedArrayBuffer` may not exist there. */
function sleepSync(ms: number): void {
	if (typeof SharedArrayBuffer === 'function') {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
		return;
	}
	const end = Date.now() + ms;
	while (Date.now() < end) {
		// busy-wait
	}
}

/**
 * Removes a temp directory, retrying while Windows still holds it locked after a child process exits.
 * `rmSync` retries do not cover that EPERM. A directory still locked after the last attempt is left in the
 * OS temp folder: the Electron test renderer on Windows can hold one for longer, and a leftover temp folder
 * must not fail the test that used it.
 */
export function removeDirWithRetries(dir: string, attempts: number, delayMs: number): void {
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
			if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') {
				throw error;
			}
			if (attempt < attempts - 1) {
				sleepSync(delayMs);
			}
		}
	}
}
