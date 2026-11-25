/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServiceIdentifier, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkspace, IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { BeginClaudeRequest, ClaudeModelInfo, ClaudeRunHandle, ClaudeRuntimeState, ClaudeUserInput, IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { ClaudeAgentDelegateHandler } from '../../common/claudeDelegationModel.js';
import { NormalizedClaudeEvent } from '../../../../../platform/claude/common/claudeProtocol.js';
import { FakeClaudeRuntimeService } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { claudeTestSessionFixtures } from '../../../../../platform/claude/common/claudeTestSession.js';
import { IOutputService } from '../../../output/common/output.js';
import { agentWorkspaceStubs } from './claudeAgentTestUtils.js';
import { ClaudeAgentService, IClaudeAgentService } from '../../common/claudeAgentService.js';
import { runKlawlyTestAgentSession } from '../../common/claudeTestSessionCommand.js';

const SECRET = 'sk-ant-api03-testsecretvalue';

suite('Claude test agent session', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('command starts a fake session and logs redacted events', async () => {
		const lines: string[] = [];
		let shown = false;
		const runtime = store.add(new FakeClaudeRuntimeService(secretFixtures()));
		const disposed: string[] = [];
		const originalDispose = runtime.disposeSession.bind(runtime);
		runtime.disposeSession = async sessionId => {
			disposed.push(sessionId);
			await originalDispose(sessionId);
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(lines), ...agentWorkspaceStubs()));
		const otherLines: string[] = [];
		store.add(new ClaudeAgentService(runtime, output(otherLines), ...agentWorkspaceStubs()));
		const notes: string[] = [];

		await runKlawlyTestAgentSession(accessor({
			workspace: workspaceWith(URI.file('/repo')),
			notification: notes,
			outputShown: () => { shown = true; },
			agent,
		}));

		assert.strictEqual(shown, true);
		assert.deepStrictEqual(notes, []);
		const log = await settle(lines);
		assert.ok(log.some(line => line.includes('runtime') && line.includes('version=fake')));
		assert.ok(log.some(line => line.includes('tool.started') && line.includes('tool=Read')));
		assert.ok(log.some(line => line.includes('session.completed')));
		assert.ok(log.every(line => !line.includes(SECRET)));
		assert.ok(log.every(line => !line.includes('src/secret.ts')));
		assert.strictEqual(JSON.stringify([...claudeTestSessionFixtures().values()]).includes(SECRET), false);
		assert.strictEqual(disposed.length, 1);
		assert.ok(otherLines.every(line => !line.includes('tool.started') && !line.includes('session.completed')));
	});

	test('logs events that arrive before begin resolves and disposes the session', async () => {
		const lines: string[] = [];
		const disposed: string[] = [];
		const runtime = store.add(new EmitDuringBeginRuntime(disposed));
		const agent = store.add(new ClaudeAgentService(runtime, output(lines), ...agentWorkspaceStubs()));

		const handle = await agent.runTestSession('/repo');
		assert.strictEqual(handle.sessionId, 's1');
		assert.ok(lines.some(line => line.includes('tool=Read')));
		assert.ok(lines.every(line => !line.includes(SECRET) && !line.includes('other-session')));
		runtime.events.fire({ type: 'session.completed', sessionId: 's1' });
		assert.deepStrictEqual(disposed, ['s1']);
	});

	test('dispose closes a session that has not finished', async () => {
		const disposed: string[] = [];
		const runtime = store.add(new EmitDuringBeginRuntime(disposed));
		const agent = new ClaudeAgentService(runtime, output([]), ...agentWorkspaceStubs());
		await agent.runTestSession('/repo');
		agent.dispose();
		assert.deepStrictEqual(disposed, ['s1']);
	});

	test('asks for a local folder before starting a session', async () => {
		const lines: string[] = [];
		let begun = false;
		const runtime = store.add(new FakeClaudeRuntimeService(claudeTestSessionFixtures()));
		const original = runtime.begin.bind(runtime);
		runtime.begin = async request => {
			begun = true;
			return original(request);
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(lines), ...agentWorkspaceStubs()));
		const notes: string[] = [];

		await runKlawlyTestAgentSession(accessor({
			workspace: workspaceWith(undefined),
			notification: notes,
			outputShown: () => { throw new Error('output should stay hidden'); },
			agent,
		}));

		assert.strictEqual(begun, false);
		assert.strictEqual(lines.length, 0);
		assert.strictEqual(notes.length, 1);
		assert.ok(notes[0].includes('Open a local folder'));
	});

	test('notifies with a redacted failure', async () => {
		const lines: string[] = [];
		const runtime = store.add(new FakeClaudeRuntimeService(claudeTestSessionFixtures()));
		runtime.begin = async () => {
			throw new Error(`Authorization Bearer ${SECRET}`);
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(lines), ...agentWorkspaceStubs()));
		const notes: string[] = [];
		let shown = false;

		await runKlawlyTestAgentSession(accessor({
			workspace: workspaceWith(URI.file('/repo')),
			notification: notes,
			outputShown: () => { shown = true; },
			agent,
		}));

		assert.strictEqual(shown, true);
		assert.strictEqual(notes.length, 1);
		assert.strictEqual(notes[0].includes(SECRET), false);
		assert.ok(notes[0].includes('[redacted]'));
		assert.ok(lines.some(line => line.includes('test session failed') && !line.includes(SECRET)));
	});
});

suite('Claude agent stop with background children', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const run = (id: string) => ({ id, agentType: 'local_bash', description: 'Build', background: true, state: 'running', startedAt: 1, toolCallCount: 0 });

	async function setup() {
		const runtime = store.add(new ChildRuntime());
		const agent = store.add(new ClaudeAgentService(runtime, output([]), ...agentWorkspaceStubs()));
		const stops: string[] = [];
		const handler: ClaudeAgentDelegateHandler = {
			delegate: async () => { throw new Error('unused'); },
			stopUnder: sessionId => { stops.push(sessionId); },
		};
		store.add(agent.setDelegateHandler(handler));
		const session = agent.createSession();
		await agent.submit(session.id, 'Go', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		const runtimeId = agent.getRuntimeSessionId(session.id) ?? '';
		return { runtime, agent, session, stops, runtimeId };
	}

	test('a finished turn with a live child is still working, and Stop stops the child', async () => {
		const { runtime, agent, session, stops } = await setup();
		const before = { working: agent.isWorking(session.id), turn: agent.getViewState(session.id).turns[0].status };
		await agent.stop(session.id);
		assert.deepStrictEqual({ before, stops, interrupted: runtime.interrupted, turn: agent.getViewState(session.id).turns[0].status }, {
			before: { working: true, turn: 'complete' },
			stops: [session.id],
			interrupted: ['run-bg'],
			turn: 'complete',
		});
	});

	test('after Stop a late child start or tool is dropped and stopped again, a permission request still shows', async () => {
		const { runtime, agent, session, stops, runtimeId } = await setup();
		await agent.stop(session.id);
		runtime.fire({ type: 'subagent.started', sessionId: runtimeId, run: run('run-late') } as NormalizedClaudeEvent);
		runtime.fire({ type: 'tool.started', sessionId: runtimeId, call: { id: 'c1', name: 'Bash', category: 'shell', input: {}, display: { label: 'Bash' } } } as NormalizedClaudeEvent);
		runtime.fire({ type: 'permission.requested', sessionId: runtimeId, parentRunId: 'run-bg', request: { id: 'perm-1', toolName: 'Bash', input: {}, category: 'shell', command: 'ls', cwd: '/repo', risk: 'none', canRemember: false, mode: 'agent', canAllowAllCommands: false, workspaceTrusted: true } } as unknown as NormalizedClaudeEvent);
		const turn = agent.getViewState(session.id).turns[0];
		assert.deepStrictEqual({
			subagents: agent.getViewState(session.id).subagents.map(subagent => subagent.run.id),
			cards: turn.cards.length,
			permissions: agent.getViewState(session.id).subagents[0].chat.permissions.length,
			stops: stops.length,
			interrupted: runtime.interrupted,
		}, { subagents: ['run-bg'], cards: 0, permissions: 1, stops: 3, interrupted: ['run-bg', 'run-late'] });
	});

	test('a new message clears the stop latch', async () => {
		const { runtime, agent, session, runtimeId } = await setup();
		await agent.stop(session.id);
		await agent.submit(session.id, 'Again', '/repo');
		runtime.fire({ type: 'subagent.started', sessionId: runtimeId, run: run('run-new') } as NormalizedClaudeEvent);
		assert.deepStrictEqual(agent.getViewState(session.id).subagents.map(subagent => subagent.run.id), ['run-bg', 'run-new']);
	});
});

class ChildRuntime extends FakeClaudeRuntimeService {
	readonly interrupted: string[] = [];

	constructor() {
		super(new Map([['plain-answer', [
			'{"type":"session.started","sessionId":"$session"}',
			JSON.stringify({ type: 'subagent.started', sessionId: '$session', run: { id: 'run-bg', agentType: 'local_bash', description: 'Build', background: true, state: 'running', startedAt: 1, toolCallCount: 0 } }),
			'{"type":"session.completed","sessionId":"$session"}',
		].join('\n')]]));
	}

	fire(event: NormalizedClaudeEvent): void {
		this.emitEvent(event);
	}

	override async interruptSubagent(_sessionId: string, runId: string): Promise<void> {
		this.interrupted.push(runId);
	}
}

async function until(read: () => boolean): Promise<void> {
	for (let i = 0; i < 80; i++) {
		if (read()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.fail('timed out');
}

function secretFixtures(): ReadonlyMap<string, string> {
	const script = [
		'{"type":"session.started","sessionId":"$session","model":"fixture-sonnet"}',
		`{"type":"tool.started","sessionId":"$session","call":{"id":"call-1","name":"Read","category":"read","input":{"content":"API_KEY=${SECRET}"},"display":{"label":"Read src/secret.ts","file":"src/secret.ts"}}}`,
		`{"type":"assistant.delta","sessionId":"$session","text":"token ${SECRET}"}`,
		'{"type":"assistant.completed","sessionId":"$session","text":"ok"}',
		'{"type":"session.completed","sessionId":"$session"}',
	].join('\n');
	return new Map([['test-session', script]]);
}

class EmitDuringBeginRuntime extends Disposable implements IClaudeRuntimeService {
	declare readonly _serviceBrand: undefined;
	readonly events = this._register(new Emitter<NormalizedClaudeEvent>());
	readonly onDidEmitEvent = this.events.event;
	private readonly _onDidChangeRuntimeState = this._register(new Emitter<ClaudeRuntimeState>());
	readonly onDidChangeRuntimeState = this._onDidChangeRuntimeState.event;

	constructor(private readonly disposed: string[]) {
		super();
	}

	async getRuntimeState(): Promise<ClaudeRuntimeState> {
		return { installed: true, authenticated: false, version: 'fake' };
	}

	async ensureRuntime(): Promise<ClaudeRuntimeState> {
		return this.getRuntimeState();
	}

	async begin(_request: BeginClaudeRequest): Promise<ClaudeRunHandle> {
		this.events.fire({ type: 'session.started', sessionId: 's1' });
		this.events.fire({
			type: 'tool.started',
			sessionId: 's1',
			call: { id: 'call-1', name: 'Read', category: 'read', input: { content: SECRET }, display: { label: 'Read' } },
		});
		this.events.fire({ type: 'session.started', sessionId: 'other-session' });
		return { sessionId: 's1' };
	}

	async send(_sessionId: string, _input: ClaudeUserInput): Promise<void> { }
	async canSteer(_sessionId: string): Promise<boolean> { return false; }
	async steer(_sessionId: string, _text: string): Promise<boolean> { return false; }
	async interrupt(_sessionId: string): Promise<void> { }
	async resolvePermission(): Promise<void> { }
	async interruptSubagent(_sessionId: string, _runId: string): Promise<void> { }
	async disposeSession(sessionId: string): Promise<void> {
		this.disposed.push(sessionId);
	}
	async listModels(): Promise<readonly ClaudeModelInfo[]> { return []; }
	async setModel(_sessionId: string, _modelId: string): Promise<void> { }
}

function output(lines: string[]): IOutputService {
	return {
		_serviceBrand: undefined,
		getChannel: () => ({
			append: (text: string) => lines.push(text),
		}),
	} as unknown as IOutputService;
}

function workspaceWith(uri: URI | undefined): IWorkspaceContextService {
	const workspace = { folders: uri ? [{ uri, name: 'repo', index: 0 }] : [] } as IWorkspace;
	return {
		_serviceBrand: undefined,
		getWorkspace: () => workspace,
	} as unknown as IWorkspaceContextService;
}

function accessor(options: {
	workspace: IWorkspaceContextService;
	notification: string[];
	outputShown: () => void;
	agent: IClaudeAgentService;
}): ServicesAccessor {
	const notification = {
		_serviceBrand: undefined,
		error: (message: string) => options.notification.push(message),
	} as unknown as INotificationService;
	const outputService = {
		_serviceBrand: undefined,
		showChannel: async () => { options.outputShown(); },
	} as unknown as IOutputService;
	const services = new Map<ServiceIdentifier<unknown>, unknown>();
	services.set(IWorkspaceContextService, options.workspace);
	services.set(INotificationService, notification);
	services.set(IOutputService, outputService);
	services.set(IClaudeAgentService, options.agent);
	return {
		get<T>(id: ServiceIdentifier<T>): T {
			const value = services.get(id);
			if (value === undefined) {
				throw new Error('missing service');
			}
			return value as T;
		},
	};
}

function nextTick(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

async function settle(lines: string[]): Promise<string[]> {
	for (let i = 0; i < 40; i++) {
		await nextTick();
		if (lines.some(line => line.includes('session.completed'))) {
			return lines;
		}
	}
	assert.fail(`session did not complete (${lines.join(' | ')})`);
}
