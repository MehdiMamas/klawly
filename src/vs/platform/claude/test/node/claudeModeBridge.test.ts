/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_DUPLICATE_SESSION_MANAGER_TOOLS } from '../../common/claudeNoModelTools.js';
import assert from 'assert';
import { tmpdir } from 'os';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AgentMode } from '../../common/claudeContext.js';
import { DEFAULT_PERMISSION_POLICY } from '../../common/claudePermissions.js';
import { NormalizedClaudeEvent } from '../../common/claudeProtocol.js';
import { ClaudeAgentRunner, ClaudePermissionBridge } from '../../node/claudeAgentRunner.js';
import { ClaudePermissionHost } from '../../node/claudePermissionHost.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery, ClaudeQueryStart, ClaudeToolPermission } from '../../node/claudeQuery.js';

interface Harness {
	readonly runner: ClaudeAgentRunner;
	readonly seen: NormalizedClaudeEvent[];
	readonly bridgeCalls: string[];
	options(): ClaudeQueryStart['options'];
	starts(): number;
	canUseTool(toolName: string, input: Record<string, unknown>, id?: string): Promise<ClaudeToolPermission>;
	release(): void;
}

/** These tests drive the permission callback the SDK would call, through the real runner. */
suite('Claude mode permission bridge', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function open(mode: AgentMode, allowedTools?: readonly string[]): Promise<Harness> {
		const registry = store.add(new ClaudeProcessRegistry());
		let captured: ClaudeQueryStart | undefined;
		let starts = 0;
		let release: (() => void) | undefined;
		const bridgeCalls: string[] = [];
		const bridge: ClaudePermissionBridge = {
			request: async request => {
				bridgeCalls.push(request.toolName);
				return { behavior: 'allow' };
			},
		};
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			// The acceptEdits preset. The default prompt preset makes workspace writes ask (#175).
			permissionHost: new ClaudePermissionHost({ getPolicy: () => ({ ...DEFAULT_PERMISSION_POLICY, writeWorkspace: 'allow' }) }),
			queryFactory: async start => {
				captured = start;
				starts++;
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(() => release, fn => { release = fn; });
			},
		}));
		const seen: NormalizedClaudeEvent[] = [];
		const done = (async () => {
			for await (const event of runner.start({ sessionId: 'session-1', prompt: 'hi', cwd: tmpdir(), mode, allowedTools, workspaceTrusted: true, permissionBridge: bridge })) {
				seen.push(event);
			}
		})();
		store.add({ dispose: () => { release?.(); void done; } });
		await waitFor(() => seen.some(event => event.type === 'session.started'));
		let serial = 0;
		return {
			runner,
			seen,
			bridgeCalls,
			options: () => captured!.options,
			starts: () => starts,
			canUseTool: (toolName, input, id = `tool-${++serial}`) => captured!.options.canUseTool(toolName, input, { signal: new AbortController().signal, toolUseID: id }),
			release: () => release?.(),
		};
	}

	test('Ask denies every file write before the bridge is asked, and sends a command to the bridge', async () => {
		const h = await open('ask');
		const write = await h.canUseTool('Write', { file_path: 'a.plan.md', content: 'x' });
		const edit = await h.canUseTool('Edit', { file_path: 'a.ts' });
		for (const decision of [write, edit]) {
			assert.strictEqual(decision.behavior, 'deny');
			if (decision.behavior === 'deny') {
				assert.ok(decision.message?.includes('Ask mode never changes files'), decision.message);
			}
		}
		assert.deepStrictEqual(h.bridgeCalls, []);
		// Commands ask in every mode (Phase 27): the bridge is asked, and here it allows.
		assert.strictEqual((await h.canUseTool('Bash', { command: 'rm -rf dist' })).behavior, 'allow');
		assert.deepStrictEqual(h.bridgeCalls, ['Bash']);
		h.release();
	});

	test('Ask lets reads, read-only commands and the web through the host policy without a prompt', async () => {
		const h = await open('ask');
		assert.strictEqual((await h.canUseTool('Read', { file_path: 'a.ts' })).behavior, 'allow');
		assert.strictEqual((await h.canUseTool('Bash', { command: 'git status' })).behavior, 'allow');
		assert.strictEqual((await h.canUseTool('WebFetch', { url: 'https://example.com' })).behavior, 'allow');
		assert.deepStrictEqual(h.bridgeCalls, []);
		assert.strictEqual(h.seen.some(event => event.type === 'permission.requested'), false);
		h.release();
	});

	test('Ask opens the SDK query with every write tool disallowed; Plan keeps Write and Edit for plan files', async () => {
		const allowed = ['Read', 'Grep', 'Write', 'Edit(src/**)', 'Bash', 'Bash(git status)', 'NotebookEdit', 'mcp__db__drop'];
		const ask = await open('ask', allowed);
		assert.deepStrictEqual([ask.options().disallowedTools, ask.options().allowedTools], [['Write', 'Edit', 'MultiEdit', 'NotebookEdit', ...CLAUDE_DUPLICATE_SESSION_MANAGER_TOOLS], ['Read', 'Grep']]);
		ask.release();
		const plan = await open('plan', allowed);
		assert.deepStrictEqual([plan.options().disallowedTools, plan.options().allowedTools], [['NotebookEdit', ...CLAUDE_DUPLICATE_SESSION_MANAGER_TOOLS], ['Read', 'Grep']]);
		plan.release();
	});

	test('Agent opens the SDK query refusing only the session-manager duplicates and keeps its allowed tools (issue 1170)', async () => {
		const h = await open('agent', ['Read', 'Write']);
		assert.deepStrictEqual(h.options().disallowedTools, [...CLAUDE_DUPLICATE_SESSION_MANAGER_TOOLS]);
		assert.deepStrictEqual(h.options().allowedTools, ['Read', 'Write']);
		h.release();
	});

	test('a mode denial carries the structured denial', async () => {
		const h = await open('plan');
		const decision = await h.canUseTool('Write', { file_path: 'a.ts', content: 'x' });
		assert.strictEqual(decision.behavior, 'deny');
		if (decision.behavior === 'deny') {
			assert.deepStrictEqual(decision.denial, { code: 'mode-read-only', mode: 'plan', tool: 'Write', category: 'write' });
		}
		h.release();
	});

	test('Build restarts the Plan query so no tool is disallowed, and Ask after Plan restarts it again', async () => {
		const ask = await open('plan');
		await ask.runner.send('session-1', 'Explain', 'ask');
		// The restart launches the new query in the background, after the checkpoint, so wait for it.
		await waitFor(() => ask.starts() === 2);
		assert.ok(ask.options().disallowedTools?.includes('Write'));
		ask.release();
		const h = await open('plan');
		assert.deepStrictEqual(h.options().disallowedTools, ['NotebookEdit', ...CLAUDE_DUPLICATE_SESSION_MANAGER_TOOLS]);
		await h.runner.send('session-1', 'Build the plan', 'agent');
		await waitFor(() => h.starts() === 2);
		assert.deepStrictEqual(h.options().disallowedTools, [...CLAUDE_DUPLICATE_SESSION_MANAGER_TOOLS]);
		h.release();
	});

	test('Plan writes only plan files before Build, its commands ask, and a Build turn in Agent mode writes', async () => {
		const h = await open('plan');
		const before = await h.canUseTool('Write', { file_path: 'a.ts', content: 'x' });
		assert.strictEqual(before.behavior, 'deny');
		if (before.behavior === 'deny') {
			assert.ok(before.message?.includes('Plan mode only writes plan files'), before.message);
		}
		assert.strictEqual((await h.canUseTool('Write', { file_path: 'notes/next.plan.md', content: 'x' })).behavior, 'allow');
		assert.deepStrictEqual(h.bridgeCalls, []);
		assert.strictEqual((await h.canUseTool('Bash', { command: 'npm test' })).behavior, 'allow');
		assert.deepStrictEqual(h.bridgeCalls, ['Bash']);

		// Build: the next turn is sent in Agent mode on the same runtime session, and in-workspace edits run.
		await h.runner.send('session-1', 'Build the plan', 'agent');
		const after = await h.canUseTool('Write', { file_path: 'a.ts', content: 'x' }, 'tool-build');
		assert.strictEqual(after.behavior, 'allow');
		assert.deepStrictEqual(h.bridgeCalls, ['Bash']);
		h.release();
	});

	test('Agent writes inside the workspace without a card, and sends a command to the bridge', async () => {
		const h = await open('agent');
		assert.strictEqual((await h.canUseTool('Write', { file_path: 'a.ts', content: 'x' }, 'tool-w')).behavior, 'allow');
		assert.deepStrictEqual(h.bridgeCalls, []);
		assert.strictEqual((await h.canUseTool('Bash', { command: 'npm test' }, 'tool-b')).behavior, 'allow');
		assert.deepStrictEqual(h.bridgeCalls, ['Bash']);
		const request = h.seen.find(event => event.type === 'permission.requested');
		assert.strictEqual(request?.type === 'permission.requested' ? request.request.toolName : undefined, 'Bash');
		h.release();
	});

	test('a bridge that denies still wins in Agent mode', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		let captured: ClaudeQueryStart | undefined;
		let release: (() => void) | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				captured = start;
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(() => release, fn => { release = fn; });
			},
		}));
		const seen: NormalizedClaudeEvent[] = [];
		const done = (async () => {
			for await (const event of runner.start({ sessionId: 's', prompt: 'hi', cwd: tmpdir(), mode: 'agent', permissionBridge: { request: async () => ({ behavior: 'deny', message: 'No.' }) } })) {
				seen.push(event);
			}
		})();
		await waitFor(() => seen.some(event => event.type === 'session.started'));
		const decision = await captured!.options.canUseTool('Bash', { command: 'npm test' }, { signal: new AbortController().signal, toolUseID: 't' });
		assert.deepStrictEqual(decision, { behavior: 'deny', message: 'No.', denial: { code: 'user-denied', mode: 'agent', tool: 'Bash', category: 'shell' } });
		release?.();
		await done;
	});
});

function idleQuery(getRelease: () => (() => void) | undefined, setRelease: (release: () => void) => void): ClaudeQuery {
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: 'system', subtype: 'init', slash_commands: [], skills: [], session_id: 'sdk-session' };
			await new Promise<void>(resolve => setRelease(resolve));
		},
		interrupt: async () => getRelease()?.(),
		setModel: async () => undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => getRelease()?.(),
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > 5000) {
			assert.fail('condition was not met');
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}
