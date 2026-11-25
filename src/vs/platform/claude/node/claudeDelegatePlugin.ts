/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { dirname, join } from '../../../base/common/path.js';
import { CLAUDE_DELEGATE_PLUGIN, claudeDelegatePluginFiles } from '../common/claudeDelegate.js';

/** Plugin folders already written in this process, by folder, so a turn does not touch the disk again. */
const written = new Map<string, Promise<string | undefined>>();

/**
 * Writes the bundled `klawly-delegate` plugin (issue 693) under
 * `<root>/klawly-delegate/<version>` and returns its folder. The files come
 * from code that ships with Klawly, so the plugin is versioned with the app.
 * Undefined when the folder cannot be written; the session then runs without it.
 */
export function ensureClaudeDelegatePlugin(root: string, version: string): Promise<string | undefined> {
	const folder = join(root, CLAUDE_DELEGATE_PLUGIN, version.replace(/[^\w.-]/g, '_') || '0');
	let pending = written.get(folder);
	if (!pending) {
		pending = writePlugin(folder, version);
		written.set(folder, pending);
		// A failure is not cached, so the next session tries again.
		void pending.then(result => result ?? written.delete(folder));
	}
	return pending;
}

async function writePlugin(folder: string, version: string): Promise<string | undefined> {
	try {
		for (const [path, contents] of Object.entries(claudeDelegatePluginFiles(version))) {
			const file = join(folder, path);
			await fs.mkdir(dirname(file), { recursive: true });
			const current = await fs.readFile(file, 'utf8').catch(() => undefined);
			if (current !== contents) {
				await fs.writeFile(file, contents);
			}
		}
		return folder;
	} catch {
		return undefined;
	}
}
