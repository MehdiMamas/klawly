/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { dirname, join } from '../../../base/common/path.js';
import { CLAUDE_TERMINAL_PLUGIN, claudeTerminalPluginFiles } from '../common/claudeTerminalPlugin.js';

/**
 * Writes the `/klawly` marketplace (issue 1186) under `<root>/klawly/<version>`
 * and returns its folder, the source for `claude plugin marketplace add`.
 * Files already current are left alone. Throws when the folder cannot be written.
 */
export async function writeClaudeTerminalPlugin(root: string, version: string): Promise<string> {
	const folder = join(root, CLAUDE_TERMINAL_PLUGIN, version.replace(/[^\w.-]/g, '_') || '0');
	for (const [path, contents] of Object.entries(claudeTerminalPluginFiles(version))) {
		const file = join(folder, path);
		await fs.mkdir(dirname(file), { recursive: true });
		const current = await fs.readFile(file, 'utf8').catch(() => undefined);
		if (current !== contents) {
			await fs.writeFile(file, contents);
		}
	}
	return folder;
}
