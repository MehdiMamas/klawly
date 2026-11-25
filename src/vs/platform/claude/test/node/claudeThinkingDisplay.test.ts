/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeAgentRunner, ClaudePermissionBridge } from '../../node/claudeAgentRunner.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery, ClaudeQueryStart } from '../../node/claudeQuery.js';

/** Issue 740: Claude Code streams thinking text only when the query asks for it. */
suite('Claude thinking display (issue 740)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const folders: string[] = [];

	teardown(() => {
		for (const folder of folders.splice(0)) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	/** Opens a session on a Claude Code of `runtimeVersion` and returns what its query was asked to show. */
	async function thinkingDisplayFor(sessionId: string, runtimeVersion: string | undefined): Promise<string | undefined> {
		const root = mkdtempSync(join(tmpdir(), 'klawly-thinking-display-'));
		folders.push(root);
		const registry = store.add(new ClaudeProcessRegistry());
		const releases: Array<() => void> = [];
		let options: ClaudeQueryStart['options'] | undefined;
		const bridge: ClaudePermissionBridge = { request: async () => ({ behavior: 'deny', message: 'test' }) };
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			homeDirectory: root,
			queryFactory: async start => {
				options = start.options;
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(releases);
			},
		}));
		const done = (async () => {
			for await (const _event of runner.start({ sessionId, prompt: 'hi', cwd: root, mode: 'agent', workspaceTrusted: true, permissionBridge: bridge, runtimeVersion })) {
				// Drain the events until the session is disposed.
			}
		})();
		store.add({ dispose: () => { releases.forEach(release => release()); void done; } });
		for (let attempt = 0; attempt < 500 && !(options && registry.get(sessionId)); attempt++) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		assert.ok(options, 'the query did not open');
		return options.thinkingDisplay;
	}

	test('a Claude Code that takes --thinking-display is asked for summarized thinking; an older or unknown one is not', async () => {
		assert.deepStrictEqual({
			current: await thinkingDisplayFor('s-current', '2.1.296'),
			older: await thinkingDisplayFor('s-older', '2.1.100'),
			unknown: await thinkingDisplayFor('s-unknown', undefined),
		}, {
			current: 'summarized',
			older: undefined,
			unknown: undefined,
		});
	});
});

function idleQuery(releases: Array<() => void>): ClaudeQuery {
	let release: (() => void) | undefined;
	const done = new Promise<void>(resolve => {
		release = resolve;
		releases.push(resolve);
	});
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: 'system', subtype: 'init', slash_commands: [], skills: [], session_id: 'sdk-session' };
			await done;
		},
		interrupt: async () => release?.(),
		setModel: async () => undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => release?.(),
	};
}
