/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeSaveBeforeCommandRequest } from '../../common/claude.js';
import { ClaudeSaveBeforeCommandsMode } from '../../common/claudeConfiguration.js';
import { ClaudeAgentRunner, ClaudeBeforeCommandRequest } from '../../node/claudeAgentRunner.js';
import { ClaudeUserPermissionBridge } from '../../node/claudePermissionHost.js';
import { ClaudeNodeRuntimeService } from '../../node/claudeNodeRuntimeService.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery, ClaudeQueryStart } from '../../node/claudeQuery.js';

/**
 * `claude.agent.saveBeforeCommands`: the PreToolUse screen (or the approval in
 * canUseTool) holds a shell command until the workbench has saved.
 */
suite('Claude save before commands', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const folders: string[] = [];

	teardown(() => {
		for (const folder of folders.splice(0)) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	function workspace(): string {
		const folder = mkdtempSync(join(tmpdir(), 'klawly-save-'));
		folders.push(folder);
		return folder;
	}

	async function openRunner(mode: ClaudeSaveBeforeCommandsMode, hook: (request: ClaudeBeforeCommandRequest) => Promise<void>) {
		const registry = store.add(new ClaudeProcessRegistry());
		const bridge = new ClaudeUserPermissionBridge();
		const releases: Array<() => void> = [];
		let captured: ClaudeQueryStart | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			saveBeforeCommands: () => mode,
			beforeCommand: hook,
			queryFactory: async start => {
				captured = start;
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(releases);
			},
		}));
		const done = (async () => {
			for await (const event of runner.start({ sessionId: 'session-1', prompt: 'hi', cwd: workspace(), mode: 'agent', workspaceTrusted: true, permissionBridge: bridge })) {
				void event;
			}
		})();
		store.add({ dispose: () => { bridge.dispose(); releases.forEach(release => release()); void done; } });
		await waitFor(() => !!captured);
		return { options: () => captured!.options, bridge };
	}

	test('an allowed command waits for the hook; other tools and never mode do not call it', async () => {
		const calls: string[] = [];
		let finish: (() => void) | undefined;
		const h = await openRunner('always', request => {
			calls.push(`${request.mode} ${request.command}`);
			return new Promise<void>(resolve => { finish = resolve; });
		});
		let screened = false;
		const pending = h.options().screenTool('Bash', { command: 'git status' }).then(result => {
			screened = true;
			return result;
		});
		await waitFor(() => calls.length === 1);
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.strictEqual(screened, false, 'the command waits for the save');
		finish!();
		assert.strictEqual(await pending, undefined);
		assert.strictEqual(await h.options().screenTool('Read', { file_path: 'a.ts' }), undefined);
		assert.deepStrictEqual(calls, ['always git status']);

		const never: string[] = [];
		const quiet = await openRunner('never', async request => { never.push(request.command); });
		assert.strictEqual(await quiet.options().screenTool('Bash', { command: 'git status' }), undefined);
		assert.deepStrictEqual(never, []);
	});

	test('a command that asks is saved for only after the user approves it, and a failing hook does not block it', async () => {
		const calls: string[] = [];
		const h = await openRunner('prompt', async request => {
			calls.push(request.command);
			throw new Error('save failed');
		});
		assert.deepStrictEqual(await h.options().screenTool('Bash', { command: 'npm test' }), { decision: 'ask' });
		assert.deepStrictEqual(calls, []);

		const denied = h.options().canUseTool('Bash', { command: 'npm test' }, { signal: new AbortController().signal, toolUseID: 'd1' });
		await waitFor(() => h.bridge.hasPending('session-1'));
		h.bridge.resolve('session-1', 'd1', 'deny');
		assert.strictEqual((await denied).behavior, 'deny');
		assert.deepStrictEqual(calls, []);

		const approved = h.options().canUseTool('Bash', { command: 'npm test' }, { signal: new AbortController().signal, toolUseID: 'a1' });
		await waitFor(() => h.bridge.hasPending('session-1'));
		h.bridge.resolve('session-1', 'a1', 'allow-once');
		assert.strictEqual((await approved).behavior, 'allow');
		assert.deepStrictEqual(calls, ['npm test']);
	});

	async function openService(mode: ClaudeSaveBeforeCommandsMode, timeoutMs = 5000) {
		const releases: Array<() => void> = [];
		let captured: ClaudeQueryStart | undefined;
		const service = store.add(new ClaudeNodeRuntimeService({
			runtimePath: process.execPath,
			execFile: async (_file, args) => args[0] === '--version' ? { stdout: '2.1.288\n', stderr: '' } : { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' },
			saveBeforeCommands: () => mode,
			saveBeforeCommandTimeoutMs: () => timeoutMs,
			queryFactory: async start => {
				captured = start;
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(releases);
			},
		}));
		store.add({ dispose: () => releases.forEach(release => release()) });
		const requests: ClaudeSaveBeforeCommandRequest[] = [];
		store.add(service.onDidRequestSaveBeforeCommand(request => requests.push(request)));
		const cwd = workspace();
		const { sessionId } = await service.begin({ prompt: 'hi', cwd, mode: 'agent', workspaceFolders: [cwd], workspaceTrusted: true });
		await waitFor(() => !!captured);
		return { service, sessionId, requests, options: () => captured!.options };
	}

	test('the runtime asks the workbench and the command runs once the workbench answers', async () => {
		const h = await openService('prompt');
		let screened = false;
		const pending = h.options().screenTool('Bash', { command: 'git status' }).then(result => {
			screened = true;
			return result;
		});
		await waitFor(() => h.requests.length === 1);
		assert.deepStrictEqual({ ...h.requests[0], requestId: typeof h.requests[0].requestId }, { sessionId: h.sessionId, requestId: 'string', command: 'git status', mode: 'prompt' });
		await h.service.resolveSaveBeforeCommand('other-session', h.requests[0].requestId);
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.strictEqual(screened, false, 'an answer for another session does not release the command');
		await h.service.resolveSaveBeforeCommand(h.sessionId, h.requests[0].requestId);
		assert.strictEqual(await pending, undefined);
	});

	test('a command does not wait forever: the timeout and an interrupt both release it', async () => {
		const timed = await openService('always', 20);
		assert.strictEqual(await timed.options().screenTool('Bash', { command: 'git status' }), undefined);
		assert.strictEqual(timed.requests.length, 1);

		const interrupted = await openService('always');
		const pending = interrupted.options().screenTool('Bash', { command: 'git status' });
		await waitFor(() => interrupted.requests.length === 1);
		await interrupted.service.interrupt(interrupted.sessionId);
		assert.strictEqual(await pending, undefined);
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

async function waitFor(predicate: () => boolean): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > 5000) {
			assert.fail('condition was not met');
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}
