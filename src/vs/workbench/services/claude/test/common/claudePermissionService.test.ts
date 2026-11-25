/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BeginClaudeRequest, ClaudeRunHandle, ClaudeUserInput } from '../../../../../platform/claude/common/claude.js';
import { CLAUDE_AGENT_ALLOW_EVERYTHING_CONFIRM_SETTING, CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, readClaudePermissionPolicy } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { DEFAULT_PERMISSION_POLICY } from '../../../../../platform/claude/common/claudePermissions.js';
import { NormalizedClaudeEvent, PermissionChoice, PermissionRequest } from '../../../../../platform/claude/common/claudeProtocol.js';
import { NO_SESSION_PERMISSIONS } from '../../../../../platform/claude/common/claudeSessionPermissions.js';
import { FakeClaudeRuntimeService } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { IConfigurationChangeEvent } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IConfirmation, IConfirmationResult, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IOutputService } from '../../../output/common/output.js';
import { ClaudeAgentService } from '../../common/claudeAgentService.js';
import { formatClaudeAgentEvent } from '../../common/claudeAgentLog.js';
import { EMPTY_AGENT_VIEW_STATE, describeActivity, reduceAgentState } from '../../common/claudeAgentState.js';
import { ClaudePermissionService } from '../../common/claudePermissionService.js';
import { agentWorkspaceStubs, TestTrustState } from './claudeAgentTestUtils.js';

const REQUEST = {
	id: 'perm-1', toolName: 'Bash', input: { command: 'npm install zod' },
	category: 'shell' as const, command: 'npm install zod', cwd: '/repo', risk: 'network' as const, canRemember: true,
	mode: 'agent' as const, canAllowAllCommands: true, workspaceTrusted: true,
};

suite('Claude permission state', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function requested(canRemember = true): NormalizedClaudeEvent {
		return { type: 'permission.requested', sessionId: 's', request: { ...REQUEST, canRemember } };
	}

	test('a request is pending until the host settles it, and the activity says so', () => {
		let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 't', text: 'go' });
		state = reduceAgentState(state, requested());
		assert.strictEqual(state.turns[0].permissions[0].state, 'pending');
		assert.strictEqual(state.turns[0].permissions[0].command, 'npm install zod');
		assert.strictEqual(describeActivity(state.turns[0]), 'Waiting for your approval');
		state = reduceAgentState(state, {
			type: 'permission.resolved', sessionId: 's',
			outcome: { requestId: 'perm-1', toolName: 'Bash', decision: 'allow', scope: 'session', source: 'user' },
		});
		const entry = state.turns[0].permissions[0];
		assert.deepStrictEqual([entry.state, entry.scope, entry.source], ['allowed', 'session', 'user']);
	});

	test('a stopped turn leaves an open request denied, never allowed', () => {
		let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 't', text: 'go' });
		state = reduceAgentState(state, requested());
		state = reduceAgentState(state, { type: 'session.failed', sessionId: 's', message: 'stopped', kind: 'process-crash' });
		const entry = state.turns[0].permissions[0];
		assert.deepStrictEqual([entry.state, entry.source], ['denied', 'session-stopped']);
	});

	test('a policy denial with no card is recorded as denied', () => {
		let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 't', text: 'go' });
		state = reduceAgentState(state, {
			type: 'permission.resolved', sessionId: 's',
			outcome: { requestId: 'x', toolName: 'Write', decision: 'deny', source: 'policy', subject: '/outside/a.ts' },
		});
		assert.deepStrictEqual(state.turns[0].permissions.map(p => [p.state, p.source]), [['denied', 'policy']]);
	});

	test('the log line for a decision omits the command and the path', () => {
		const line = formatClaudeAgentEvent({
			type: 'permission.resolved', sessionId: 's',
			outcome: { requestId: 'p', toolName: 'Bash', decision: 'allow', scope: 'once', source: 'user', subject: 'curl -H "Authorization: Bearer sk-ant-api03-abcdefghij" x' },
		}, 1);
		assert.ok(line.includes('decision=allow') && line.includes('source=user'));
		assert.ok(!line.includes('curl') && !line.includes('sk-ant'));
	});

	test('bad permission settings fall back to the safe defaults', () => {
		const values: Record<string, unknown> = {
			'claude.agent.defaultPermissionMode': 'prompt',
			'claude.agent.permissions.writeWorkspace': 'maybe',
			'claude.agent.permissions.network': 'allow',
			'claude.agent.permissions.shellDestructive': 42,
		};
		const policy = readClaudePermissionPolicy(key => values[key]);
		assert.strictEqual(policy.writeWorkspace, DEFAULT_PERMISSION_POLICY.writeWorkspace);
		assert.strictEqual(policy.shellDestructive, DEFAULT_PERMISSION_POLICY.shellDestructive);
		assert.strictEqual(policy.network, 'allow');
	});
});

suite('Claude permission service', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(canRemember: boolean, options: { trusted?: boolean; trust?: TestTrustState; requests?: readonly PermissionRequest[]; confirm?: Partial<IConfirmationResult> } = {}) {
		const requests = options.requests ?? [{ ...REQUEST, canRemember }];
		const fixture = [
			'{"type":"session.started","sessionId":"$session"}',
			...requests.map(request => JSON.stringify({ type: 'permission.requested', sessionId: '$session', request })),
		].join('\n');
		const runtime = store.add(new FakeClaudeRuntimeService(new Map([['plain-answer', fixture]])));
		const begins: BeginClaudeRequest[] = [];
		const sends: ClaudeUserInput[] = [];
		const choices: PermissionChoice[] = [];
		const begin = runtime.begin.bind(runtime);
		const send = runtime.send.bind(runtime);
		const resolve = runtime.resolvePermission.bind(runtime);
		runtime.begin = async (request: BeginClaudeRequest): Promise<ClaudeRunHandle> => { begins.push(request); return begin(request); };
		runtime.send = async (id: string, input: ClaudeUserInput) => { sends.push(input); return send(id, input); };
		runtime.resolvePermission = async (id: string, requestId: string, choice: PermissionChoice) => { choices.push(choice); await resolve(id, requestId, choice); };
		const output = { _serviceBrand: undefined, getChannel: () => ({ append: () => undefined }) } as unknown as IOutputService;
		const configuration = new TestConfigurationService();
		configuration.updateValue = async (key: string, value: unknown) => {
			await configuration.setUserConfiguration(key, value);
			configuration.onDidChangeConfigurationEmitter.fire({ affectsConfiguration: (changed: string) => changed === key } as unknown as IConfigurationChangeEvent);
		};
		const stubs = agentWorkspaceStubs({ trusted: options.trusted, trust: options.trust, folders: ['/repo', '/other'], configuration });
		const agent = store.add(new ClaudeAgentService(runtime, output, ...stubs));
		const confirms: IConfirmation[] = [];
		const dialogs = {
			confirm: async (confirmation: IConfirmation): Promise<IConfirmationResult> => {
				confirms.push(confirmation);
				return { confirmed: true, ...options.confirm };
			},
		} as unknown as IDialogService;
		const service = store.add(new ClaudePermissionService(runtime, agent, dialogs, configuration, stubs[1]));
		const session = agent.createSession();
		return { agent, service, session, begins, sends, choices, confirms, configuration, runtime };
	}

	async function until(read: () => boolean): Promise<void> {
		for (let i = 0; i < 100; i++) {
			if (read()) {
				return;
			}
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		assert.fail('timed out');
	}

	test('the first message carries the workspace folders and the trust state', async () => {
		const { agent, session, begins } = setup(true, { trusted: false });
		await agent.submit(session.id, 'ask', '/repo');
		await until(() => begins.length === 1);
		assert.strictEqual(begins[0].workspaceTrusted, false);
		assert.strictEqual(begins[0].workspaceFolders!.length, 2);
		await agent.stop(session.id);
		await agent.submit(session.id, 'again', '/repo');
		assert.strictEqual(begins.length, 2);
		assert.strictEqual(begins[1].workspaceTrusted, false);
	});

	test('respond carries the answer to the runtime and settles the card', async () => {
		const { agent, service, session, choices } = setup(true);
		await agent.submit(session.id, 'ask', '/repo');
		await until(() => service.getPending(session.id).length === 1);
		await service.respond(session.id, 'perm-1', 'allow-session');
		assert.deepStrictEqual(choices, ['allow-session']);
		await until(() => service.getPending(session.id).length === 0);
		const [entry] = service.getHistory(session.id);
		assert.deepStrictEqual([entry.state, entry.scope, entry.source], ['allowed', 'session', 'user']);
	});

	test('a subagent\'s request is pending in the session and respond reaches the runtime', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(new Map([['plain-answer', [
			'{"type":"session.started","sessionId":"$session"}',
			JSON.stringify({ type: 'subagent.started', sessionId: '$session', run: { id: 'run-a', agentType: 'Explore', description: 'Find tests', background: false, state: 'running', startedAt: 1, toolCallCount: 0 } }),
			JSON.stringify({ type: 'permission.requested', sessionId: '$session', parentRunId: 'run-a', request: REQUEST }),
		].join('\n')]])));
		const choices: PermissionChoice[] = [];
		const resolve = runtime.resolvePermission.bind(runtime);
		runtime.resolvePermission = async (id: string, requestId: string, choice: PermissionChoice) => { choices.push(choice); await resolve(id, requestId, choice); };
		const output = { _serviceBrand: undefined, getChannel: () => ({ append: () => undefined }) } as unknown as IOutputService;
		const configuration = new TestConfigurationService();
		const stubs = agentWorkspaceStubs({ folders: ['/repo'], configuration });
		const agent = store.add(new ClaudeAgentService(runtime, output, ...stubs));
		const service = store.add(new ClaudePermissionService(runtime, agent, {} as IDialogService, configuration, stubs[1]));
		const session = agent.createSession();
		await agent.submit(session.id, 'ask', '/repo');
		await until(() => service.getPending(session.id).length === 1);
		const asked = service.getPending(session.id)[0].askedBy;
		await service.respond(session.id, 'perm-1', 'deny');
		assert.deepStrictEqual({ asked, choices }, { asked: 'Explore', choices: ['deny'] });
	});

	test('a request that cannot be remembered is only ever allowed once', async () => {
		const { agent, service, session, choices } = setup(false);
		await agent.submit(session.id, 'ask', '/repo');
		await until(() => service.getPending(session.id).length === 1);
		await service.respond(session.id, 'perm-1', 'allow-workspace');
		assert.deepStrictEqual(choices, ['allow-once']);
	});

	test('a request that is not pending is rejected and reaches no runtime', async () => {
		const { agent, service, session, choices } = setup(true);
		await assert.rejects(() => service.respond(session.id, 'perm-1', 'allow-once'));
		await agent.submit(session.id, 'ask', '/repo');
		await until(() => service.getPending(session.id).length === 1);
		await service.respond(session.id, 'perm-1', 'deny');
		await until(() => service.getPending(session.id).length === 0);
		await assert.rejects(() => service.respond(session.id, 'perm-1', 'allow-once'));
		assert.deepStrictEqual(choices, ['deny']);
	});

	test('Allow All Commands approves the card, turns the switch on, and reaches the runtime now and on the next turn', async () => {
		const { agent, service, session, choices, sends, begins, runtime } = setup(true);
		await agent.submit(session.id, 'ask', '/repo');
		await until(() => service.getPending(session.id).length === 1);
		await service.respond(session.id, 'perm-1', 'allow-all-commands');
		await until(() => service.getPending(session.id).length === 0);
		const runtimeId = agent.getRuntimeSessionId(session.id)!;
		assert.deepStrictEqual({
			choices,
			pane: service.getSessionPermissions(session.id),
			runtime: runtime.getSessionPermissions(runtimeId),
		}, {
			choices: ['allow-once'],
			pane: { allowAllCommands: true, allowEverything: false },
			runtime: { allowAllCommands: true, allowEverything: false },
		});
		await agent.stop(session.id);
		await agent.submit(session.id, 'again', '/repo');
		await until(() => begins.length + sends.length >= 2);
		assert.deepStrictEqual((sends.at(-1) ?? begins.at(-1))?.sessionPermissions, { allowAllCommands: true, allowEverything: false });
	});

	test('Allow All Commands is refused for a card that does not offer it', async () => {
		const { agent, service, session, choices } = setup(true, { requests: [{ ...REQUEST, toolName: 'Write', category: 'write', command: undefined, targetPath: '/repo/a.ts', canAllowAllCommands: false }] });
		await agent.submit(session.id, 'ask', '/repo');
		await until(() => service.getPending(session.id).length === 1);
		await assert.rejects(() => service.respond(session.id, 'perm-1', 'allow-all-commands'));
		assert.deepStrictEqual([choices, service.getSessionPermissions(session.id)], [[], NO_SESSION_PERMISSIONS]);
	});

	test('Allow All Commands covers waiting command cards, but not a destructive, credential or web one', async () => {
		const { agent, service, session, choices } = setup(true, {
			requests: [
				{ ...REQUEST, id: 'safe' },
				{ ...REQUEST, id: 'rm', command: 'rm -rf dist', risk: 'destructive', canRemember: false },
				{ ...REQUEST, id: 'env', command: 'cat .env', risk: 'credentials', canRemember: false, canAllowAllCommands: false },
				{ ...REQUEST, id: 'web', toolName: 'WebFetch', category: 'web', command: 'https://x.dev', risk: undefined, canAllowAllCommands: false },
			],
		});
		await agent.submit(session.id, 'ask', '/repo');
		await until(() => service.getPending(session.id).length === 4);
		await service.setAllowAllCommands(session.id, true);
		await until(() => service.getPending(session.id).length === 3);
		assert.deepStrictEqual([choices, service.getPending(session.id).map(entry => entry.id)], [['allow-once'], ['rm', 'env', 'web']]);
	});

	test('picking an Allow Everything level warns first; Cancel puts the previous level back and leaves the card waiting', async () => {
		const { agent, service, session, choices, confirms, configuration } = setup(true, { confirm: { confirmed: false } });
		await agent.submit(session.id, 'ask', '/repo');
		await until(() => service.getPending(session.id).length === 1);
		await configuration.updateValue(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, 'allowEverything');
		await until(() => service.getPermissionLevel() === 'strict');
		assert.deepStrictEqual({
			dialogs: confirms.map(confirm => [confirm.type, !!confirm.checkbox]),
			choices,
			pending: service.getPending(session.id).length,
			switches: service.getSessionPermissions(session.id),
		}, { dialogs: [['warning', false]], choices: [], pending: 1, switches: NO_SESSION_PERMISSIONS });
	});

	test('Allow Everything approves every waiting card, credentials included, and warns only once', async () => {
		const { agent, service, session, choices, confirms, configuration, runtime } = setup(true, {
			requests: [
				{ ...REQUEST, id: 'rm', command: 'rm -rf dist', risk: 'destructive', canRemember: false },
				{ ...REQUEST, id: 'out', toolName: 'Write', category: 'write', command: undefined, targetPath: '/etc/x', outsideWorkspace: true, canRemember: false, canAllowAllCommands: false, risk: undefined },
				{ ...REQUEST, id: 'env', toolName: 'Read', category: 'read', command: undefined, targetPath: '/repo/.env', risk: 'credentials', canRemember: false, canAllowAllCommands: false },
			],
		});
		await agent.submit(session.id, 'ask', '/repo');
		await until(() => service.getPending(session.id).length === 3);
		await configuration.updateValue(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, 'allowEverything');
		await until(() => service.getPending(session.id).length === 0);
		const runtimeId = agent.getRuntimeSessionId(session.id)!;
		const everything = {
			confirms: confirms.length,
			choices,
			switches: service.getSessionPermissions(session.id),
			runtime: runtime.getSessionPermissions(runtimeId),
			setting: configuration.getValue(CLAUDE_AGENT_ALLOW_EVERYTHING_CONFIRM_SETTING),
		};
		// Down to Ask Before Edits and up to the other level: no second warning, and credentials ask again.
		await configuration.updateValue(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, 'prompt');
		await configuration.updateValue(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, 'allowEverythingExceptCredentials');
		assert.deepStrictEqual({ everything, confirms: confirms.length, switches: service.getSessionPermissions(session.id), other: service.getSessionPermissions(agent.createSession().id) }, {
			everything: {
				confirms: 1,
				choices: ['allow-once', 'allow-once', 'allow-once'],
				switches: { allowAllCommands: false, allowEverything: true, allowCredentials: true, unasked: true },
				runtime: { allowAllCommands: false, allowEverything: true, allowCredentials: true, unasked: true },
				setting: false,
			},
			confirms: 1,
			switches: { allowAllCommands: false, allowEverything: true },
			other: { allowAllCommands: false, allowEverything: true },
		});
	});

	test('Allow Everything Except Credentials leaves a credential card waiting', async () => {
		const { agent, service, session, choices, configuration } = setup(true, {
			requests: [
				{ ...REQUEST, id: 'rm', command: 'rm -rf dist', risk: 'destructive', canRemember: false },
				{ ...REQUEST, id: 'env', command: 'cat .env', risk: 'credentials', canRemember: false, canAllowAllCommands: false },
			],
		});
		await agent.submit(session.id, 'ask', '/repo');
		await until(() => service.getPending(session.id).length === 2);
		await configuration.updateValue(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, 'allowEverythingExceptCredentials');
		await until(() => service.getPending(session.id).length === 1);
		assert.deepStrictEqual([choices, service.getPending(session.id).map(entry => entry.id)], [['allow-once'], ['env']]);
	});

	test('no switch or level turns anything on in an untrusted workspace', async () => {
		const { agent, service, session, confirms, choices, configuration } = setup(true, { trusted: false, requests: [{ ...REQUEST, canAllowAllCommands: false, workspaceTrusted: false, canRemember: false }] });
		await agent.submit(session.id, 'ask', '/repo');
		await until(() => service.getPending(session.id).length === 1);
		await configuration.updateValue(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, 'allowEverything');
		await until(() => confirms.length === 1);
		await assert.rejects(() => service.setAllowAllCommands(session.id, true), /Trust this workspace first/);
		await assert.rejects(() => service.respond(session.id, 'perm-1', 'allow-all-commands'), /Trust this workspace first/);
		assert.throws(() => agent.setSessionPermissions(session.id, { allowAllCommands: false, allowEverything: true }), /Trust this workspace first/);
		assert.deepStrictEqual([choices, service.getPending(session.id).length, service.getSessionPermissions(session.id)], [[], 1, NO_SESSION_PERMISSIONS]);
	});

	test('losing workspace trust turns the switches off in the pane and the runtime, and trusting again does not turn them back on', async () => {
		const trust = store.add(new TestTrustState());
		const { agent, service, session, runtime } = setup(true, { trust });
		const other = agent.createSession();
		await agent.submit(session.id, 'ask', '/repo');
		await until(() => service.getPending(session.id).length === 1);
		await service.setAllowAllCommands(session.id, true);
		await service.setAllowAllCommands(other.id, true);
		const runtimeId = agent.getRuntimeSessionId(session.id)!;
		const changes: string[] = [];
		store.add(agent.onDidChangeSession(change => changes.push(change.reason)));

		trust.set(false);
		trust.set(true);
		assert.deepStrictEqual({
			pane: [service.getSessionPermissions(session.id), service.getSessionPermissions(other.id)],
			runtime: runtime.getSessionPermissions(runtimeId),
			changes,
		}, {
			pane: [NO_SESSION_PERMISSIONS, NO_SESSION_PERMISSIONS],
			runtime: NO_SESSION_PERMISSIONS,
			changes: ['permissions', 'permissions'],
		});
	});

	test('an Allow Everything level waits while the workspace is untrusted and applies once it is trusted', async () => {
		const trust = store.add(new TestTrustState(false));
		const { service, session, configuration } = setup(true, { trust });
		await configuration.updateValue(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, 'allowEverything');
		await until(() => configuration.getValue(CLAUDE_AGENT_ALLOW_EVERYTHING_CONFIRM_SETTING) === false);
		const untrusted = service.getSessionPermissions(session.id);
		trust.set(true);
		assert.deepStrictEqual([untrusted, service.getSessionPermissions(session.id)], [NO_SESSION_PERMISSIONS, { allowAllCommands: false, allowEverything: true, allowCredentials: true, unasked: true }]);
	});

	test('a card asked before the workspace was trusted is not approved by a level picked later', async () => {
		const trust = store.add(new TestTrustState(false));
		const { agent, service, session, choices, confirms, configuration } = setup(true, { trust, requests: [{ ...REQUEST, canAllowAllCommands: false, workspaceTrusted: false, canRemember: false }] });
		await agent.submit(session.id, 'ask', '/repo');
		await until(() => service.getPending(session.id).length === 1);
		trust.set(true);
		await assert.rejects(() => service.respond(session.id, 'perm-1', 'allow-all-commands'), /asked before this workspace was trusted/);
		await configuration.updateValue(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, 'allowEverything');
		await until(() => confirms.length === 1);
		assert.deepStrictEqual([choices, service.getPending(session.id).map(entry => entry.id)], [[], ['perm-1']]);
	});

	test('switches belong to one session, are not persisted, and end with it', async () => {
		const { agent, service, session, begins } = setup(true);
		await service.setAllowAllCommands(session.id, true);
		const other = agent.createSession();
		assert.deepStrictEqual(service.getSessionPermissions(other.id), NO_SESSION_PERMISSIONS);
		await agent.submit(session.id, 'ask', '/repo');
		await until(() => begins.length === 1);
		assert.deepStrictEqual(begins[0].sessionPermissions, { allowAllCommands: true, allowEverything: false });
		agent.closeSession(session.id);
		assert.deepStrictEqual(service.getSessionPermissions(session.id), NO_SESSION_PERMISSIONS);
	});
});
