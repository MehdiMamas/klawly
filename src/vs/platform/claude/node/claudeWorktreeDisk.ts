/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { lstat, readdir } from 'fs/promises';
import { join } from '../../../base/common/path.js';

/**
 * Bytes the files under `root` take (issue 865). Links are counted as links and never followed,
 * so a link out of the worktree cannot make it look bigger or be walked. Returns undefined when
 * `root` does not exist.
 */
export async function directorySize(root: string): Promise<number | undefined> {
	try {
		await lstat(root);
	} catch {
		return undefined;
	}
	let total = 0;
	const pending = [root];
	while (pending.length > 0) {
		const dir = pending.pop()!;
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			const path = join(dir, name);
			try {
				const info = await lstat(path);
				if (info.isDirectory()) {
					pending.push(path);
				} else {
					total += info.size;
				}
			} catch {
				// Removed while walking.
			}
		}
	}
	return total;
}
