/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeNodeRuntimeService } from '../../node/claudeNodeRuntimeService.js';
import { ClaudeQuery, ClaudeQueryStart } from '../../node/claudeQuery.js';

suite('Claude built-in subagents setting (spec 16a)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('claude.subagents.builtInAgents is read when each query starts', async () => {
		const root = join(tmpdir(), `klawly-builtin-setting-${Date.now()}`);
		mkdirSync(join(root, 'home'), { recursive: true });
		const configDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		let enabled = true;
		const starts: ClaudeQueryStart[] = [];
		try {
			const runtime = store.add(new ClaudeNodeRuntimeService({
				runtimePath: process.execPath,
				homeDirectory: join(root, 'home'),
				execFile: async (_file, args) => args[0] === '--version'
					? { stdout: '2.1.288 (Claude Code)\n', stderr: '' }
					: { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' },
				builtInAgentsEnabled: () => enabled,
				queryFactory: async start => {
					starts.push(start);
					return emptyQuery();
				},
			}));
			const first = await runtime.begin({ prompt: 'hi', cwd: root, mode: 'agent', workspaceFolders: [root] });
			await waitFor(() => starts.length === 1);
			enabled = false;
			const second = await runtime.begin({ prompt: 'hi', cwd: root, mode: 'agent', workspaceFolders: [root] });
			await waitFor(() => starts.length === 2);
			await runtime.disposeSession(first.sessionId);
			await runtime.disposeSession(second.sessionId);
			assert.deepStrictEqual(starts.map(start => Object.keys(start.options.agents ?? {}).sort()), [['explorer', 'klawly-guide', 'reviewer'], []]);
		} finally {
			if (configDir !== undefined) {
				process.env.CLAUDE_CONFIG_DIR = configDir;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function emptyQuery(): ClaudeQuery {
	return {
		async *[Symbol.asyncIterator]() { },
		interrupt: async () => undefined,
		setModel: async () => undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => undefined,
	};
}

async function waitFor(ready: () => boolean): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (ready()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.fail('timed out');
}
