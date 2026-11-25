/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeTerminalPluginFiles } from '../../common/claudeTerminalPlugin.js';
import { writeClaudeTerminalPlugin } from '../../node/claudeTerminalPlugin.js';

suite('Claude terminal plugin', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('writes a one-plugin marketplace whose ids match', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'klawly-terminal-plugin-'));
		try {
			const folder = await writeClaudeTerminalPlugin(root, '1.2.3');
			const files = claudeTerminalPluginFiles('1.2.3');
			const written: Record<string, string> = {};
			for (const path of Object.keys(files)) {
				written[path] = await fs.readFile(join(folder, path), 'utf8');
			}
			const marketplace = JSON.parse(written['.claude-plugin/marketplace.json']);
			const manifest = JSON.parse(written['klawly/.claude-plugin/plugin.json']);
			assert.deepStrictEqual({
				same: written,
				marketplace: marketplace.name,
				plugin: marketplace.plugins.map((p: { name: string; source: string }) => `${p.name} ${p.source}`),
				manifest: manifest.name,
				command: written['klawly/commands/klawly.md'].includes('klawly://agent/import'),
				rewrite: await writeClaudeTerminalPlugin(root, '1.2.3') === folder,
			}, {
				same: files,
				marketplace: 'klawly',
				plugin: ['klawly ./klawly'],
				manifest: 'klawly',
				command: true,
				rewrite: true,
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
