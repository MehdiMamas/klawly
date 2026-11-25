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

/**
 * Klawly never ships the Agent SDK's bundled Claude Code (issue 548): a session runs the user's
 * installed `claude` or doesn't start, and never falls back to the SDK's own lookup.
 */
suite('Claude runtime without a bundled Claude Code (issue 548)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a session without an installed Claude Code fails with runtime-missing and never starts a query', async () => {
		const root = join(tmpdir(), `klawly-no-bundled-${Date.now()}`);
		mkdirSync(root, { recursive: true });
		const starts: ClaudeQueryStart[] = [];
		try {
			const runtime = store.add(new ClaudeNodeRuntimeService({
				runtimePath: join(root, 'missing', 'claude'),
				homeDirectory: root,
				execFile: async () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }); },
				queryFactory: async start => {
					starts.push(start);
					return emptyQuery();
				},
			}));
			const failure = await runtime.begin({ prompt: 'hi', cwd: root, mode: 'agent', workspaceFolders: [root] }).then(() => undefined, (error: Error & { kind?: string }) => error.kind);
			assert.deepStrictEqual({ failure, starts: starts.length }, { failure: 'runtime-missing', starts: 0 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('a session always passes the installed Claude Code to the SDK', async () => {
		const root = join(tmpdir(), `klawly-installed-${Date.now()}`);
		mkdirSync(join(root, 'home'), { recursive: true });
		const configDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		const starts: ClaudeQueryStart[] = [];
		try {
			const runtime = store.add(new ClaudeNodeRuntimeService({
				runtimePath: process.execPath,
				homeDirectory: join(root, 'home'),
				execFile: async (_file, args) => args[0] === '--version'
					? { stdout: '2.1.288 (Claude Code)\n', stderr: '' }
					: { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' },
				queryFactory: async start => {
					starts.push(start);
					return emptyQuery();
				},
			}));
			const session = await runtime.begin({ prompt: 'hi', cwd: root, mode: 'agent', workspaceFolders: [root] });
			await waitFor(() => starts.length === 1);
			await runtime.disposeSession(session.sessionId);
			assert.deepStrictEqual(starts.map(start => start.options.pathToClaudeCodeExecutable), [process.execPath]);
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
	throw new Error('timed out');
}
