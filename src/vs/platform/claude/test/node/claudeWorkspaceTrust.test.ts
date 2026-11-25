/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NormalizedClaudeEvent } from '../../common/claudeProtocol.js';
import { ClaudeAgentRunner, ClaudePermissionBridge } from '../../node/claudeAgentRunner.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery, ClaudeQueryStart } from '../../node/claudeQuery.js';
import { buildClaudeCliArguments } from '../../node/claudeCliArgs.js';

interface Harness {
	readonly runner: ClaudeAgentRunner;
	readonly requests: string[];
	/** Options of every query opened so far, oldest first. */
	readonly opened: ClaudeQueryStart['options'][];
	latest(): ClaudeQueryStart['options'];
}

/**
 * Workspace Trust decides which Claude settings a query loads (rule 40). An
 * untrusted repository's `.claude/settings.json` hooks and `.mcp.json` servers
 * must not load, because a hook runs a shell command without any prompt.
 */
suite('Claude workspace trust', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const folders: string[] = [];

	teardown(() => {
		for (const folder of folders.splice(0)) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	async function open(workspaceTrusted: boolean | undefined): Promise<Harness> {
		const cwd = mkdtempSync(join(tmpdir(), 'klawly-trust-'));
		folders.push(cwd);
		const registry = store.add(new ClaudeProcessRegistry());
		const opened: ClaudeQueryStart['options'][] = [];
		const requests: string[] = [];
		const releases: Array<() => void> = [];
		const bridge: ClaudePermissionBridge = {
			request: async request => {
				requests.push(request.toolName);
				return { behavior: 'deny', message: 'test' };
			},
		};
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				opened.push(start.options);
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(releases);
			},
		}));
		const seen: NormalizedClaudeEvent[] = [];
		const done = (async () => {
			for await (const event of runner.start({ sessionId: 'session-1', prompt: 'hi', cwd, mode: 'agent', workspaceTrusted, permissionBridge: bridge })) {
				seen.push(event);
			}
		})();
		store.add({ dispose: () => { releases.forEach(release => release()); void done; } });
		await waitFor(() => opened.length === 1);
		return { runner, requests, opened, latest: () => opened[opened.length - 1] };
	}

	function sources(options: ClaudeQueryStart['options']) {
		return { settingSources: options.settingSources, strictMcpConfig: options.strictMcpConfig };
	}

	test('an untrusted or unknown-trust workspace loads only user settings and no MCP configuration from disk', async () => {
		const untrusted = await open(false);
		const unknown = await open(undefined);
		const trusted = await open(true);
		assert.deepStrictEqual([sources(untrusted.latest()), sources(unknown.latest()), sources(trusted.latest())], [
			{ settingSources: ['user'], strictMcpConfig: true },
			{ settingSources: ['user'], strictMcpConfig: true },
			{ settingSources: ['user', 'project', 'local'], strictMcpConfig: undefined },
		]);
	});

	test('the command line carries the same sources and the strict MCP flag', () => {
		const flags = (options: Partial<ClaudeQueryStart['options']>) => {
			const args = buildClaudeCliArguments(options as ClaudeQueryStart['options'], { bridgeMcpServers: {}, permissionBridge: true });
			return [args[args.indexOf('--setting-sources') + 1], args.includes('--strict-mcp-config')];
		};
		assert.deepStrictEqual([
			flags({ settingSources: ['user'], strictMcpConfig: true }),
			flags({ settingSources: ['user', 'project', 'local'] }),
			flags({}),
		], [
			['user', true],
			['user,project,local', false],
			['', false],
		]);
	});

	test('granting trust takes effect on the next turn: project settings load and the policy relaxes', async () => {
		const h = await open(false);
		// Untrusted: a workspace write can only be approved once.
		const before = await h.latest().canUseTool('Write', { file_path: 'a.ts', content: 'x' }, { signal: new AbortController().signal, toolUseID: 'w1' });
		assert.strictEqual(before.behavior, 'deny');

		await h.runner.send('session-1', 'next turn', undefined, true);
		await waitFor(() => h.opened.length === 2);
		assert.deepStrictEqual(sources(h.latest()), { settingSources: ['user', 'project', 'local'], strictMcpConfig: undefined });
		// The restarted query continues the same conversation.
		assert.strictEqual(h.latest().resume, 'sdk-session');
	});

	test('revoking trust between turns restarts the query without project settings', async () => {
		const h = await open(true);
		await h.runner.send('session-1', 'next turn', undefined, false);
		await waitFor(() => h.opened.length === 2);
		assert.deepStrictEqual(sources(h.latest()), { settingSources: ['user'], strictMcpConfig: true });
	});

	test('a turn with unchanged or unreported trust reuses the open query', async () => {
		const h = await open(false);
		await h.runner.send('session-1', 'same trust', undefined, false);
		await h.runner.send('session-1', 'trust not reported');
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.strictEqual(h.opened.length, 1);
	});

	test('the host policy of the next turn uses the new trust', async () => {
		const h = await open(false);
		const untrustedScreen = await h.latest().screenTool('Bash', { command: 'git status' });
		await h.runner.send('session-1', 'next turn', undefined, true);
		await waitFor(() => h.opened.length === 2);
		const trustedScreen = await h.latest().screenTool('Bash', { command: 'git status' });
		assert.deepStrictEqual([untrustedScreen, trustedScreen], [{ decision: 'ask' }, undefined]);
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
