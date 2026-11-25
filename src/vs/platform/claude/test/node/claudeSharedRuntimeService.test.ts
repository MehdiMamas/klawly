/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClientConnectionEvent, IPCClient, IPCServer, IMessagePassingProtocol, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationChangeEvent } from '../../../configuration/common/configuration.js';
import { BeginClaudeRequest, ClaudeModelInfo, ClaudeRunHandle, ClaudeRuntimeState, ClaudeUserInput, IClaudeRuntimeService } from '../../common/claude.js';
import { CLAUDE_AGENT_RUNTIME_PATH_SETTING, CLAUDE_AGENT_RUNTIME_SETTING, ClaudeAgentRuntimeKind, readClaudeAgentRuntimeKind } from '../../common/claudeConfiguration.js';
import { CLAUDE_RUNTIME_CHANNEL } from '../../common/claudeIpc.js';
import { NormalizedClaudeEvent } from '../../common/claudeProtocol.js';
import { claudeTestSessionFixtures } from '../../common/claudeTestSession.js';
import { FakeClaudeRuntimeService } from '../../common/fakeClaudeRuntimeService.js';
import { ClaudeSharedRuntimeService } from '../../node/claudeSharedRuntimeService.js';

suite('ClaudeSharedRuntimeService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('uses the fake runtime until the setting selects live', async () => {
		const config = store.add(new TestConfig());
		const fakes: RuntimeStub[] = [];
		const lives: RuntimeStub[] = [];
		const service = store.add(new ClaudeSharedRuntimeService({
			getKind: () => config.kind,
			getRuntimePath: () => config.path,
			onDidChangeConfiguration: config.onDidChangeConfiguration,
			createFake: () => {
				const runtime = new RuntimeStub('fake');
				fakes.push(runtime);
				return runtime;
			},
			createLive: runtimePath => {
				const runtime = new RuntimeStub('live', runtimePath);
				lives.push(runtime);
				return runtime;
			},
		}));

		assert.strictEqual(fakes.length, 1);
		assert.strictEqual(lives.length, 0);
		assert.strictEqual(fakes[0].ensureCount, 0);

		const state = await service.ensureRuntime();
		assert.strictEqual(state.installed, true);
		assert.strictEqual(fakes[0].ensureCount, 1);

		config.path = 'C:\\Claude\\claude.exe';
		config.fire([CLAUDE_AGENT_RUNTIME_PATH_SETTING]);
		assert.strictEqual(lives.length, 0, 'a path change does not start the live runtime while fake is selected');
		assert.strictEqual(fakes[0].disposed, false);

		config.kind = 'live';
		config.fire([CLAUDE_AGENT_RUNTIME_SETTING]);
		await timeout(0);
		assert.strictEqual(fakes[0].disposed, true);
		assert.strictEqual(lives.length, 1);
		assert.strictEqual(lives[0].runtimePath, 'C:\\Claude\\claude.exe');
		assert.strictEqual(lives[0].ensureCount, 1);

		const events: NormalizedClaudeEvent[] = [];
		store.add(service.onDidEmitEvent(event => events.push(event)));
		lives[0].events.fire({ type: 'session.completed', sessionId: 'live-1' });
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].type, 'session.completed');
	});

	test('missing runtime setting is live and only fake opts into the test script', () => {
		assert.strictEqual(readClaudeAgentRuntimeKind(undefined), 'live');
		assert.strictEqual(readClaudeAgentRuntimeKind('live'), 'live');
		assert.strictEqual(readClaudeAgentRuntimeKind('fake'), 'fake');
		assert.strictEqual(readClaudeAgentRuntimeKind('other'), 'live');
	});

	test('a live runtimePath change recreates the runtime and fails open sessions', async () => {
		const config = store.add(new TestConfig());
		config.kind = 'live';
		config.path = 'C:\\Claude\\one.exe';
		const lives: RuntimeStub[] = [];
		const service = store.add(new ClaudeSharedRuntimeService({
			getKind: () => config.kind,
			getRuntimePath: () => config.path,
			onDidChangeConfiguration: config.onDidChangeConfiguration,
			createFake: () => { throw new Error('fake runtime should not be created'); },
			createLive: runtimePath => {
				const runtime = new RuntimeStub('live', runtimePath);
				lives.push(runtime);
				return runtime;
			},
		}));
		const events: NormalizedClaudeEvent[] = [];
		store.add(service.onDidEmitEvent(event => events.push(event)));

		const handle = await service.begin({ prompt: 'ok', cwd: '/repo', mode: 'agent' });
		config.path = 'C:\\Claude\\two.exe';
		config.fire([CLAUDE_AGENT_RUNTIME_PATH_SETTING]);
		await timeout(0);

		assert.strictEqual(lives.length, 2);
		assert.strictEqual(lives[0].disposed, true);
		assert.strictEqual(lives[0].runtimePath, 'C:\\Claude\\one.exe');
		assert.strictEqual(lives[1].runtimePath, 'C:\\Claude\\two.exe');
		assert.strictEqual(lives[1].ensureCount, 1);
		const failed = events.find(event => event.type === 'session.failed');
		assert.ok(failed);
		assert.strictEqual(failed.sessionId, handle.sessionId);
		if (failed.type === 'session.failed') {
			assert.strictEqual(failed.kind, 'unknown');
			assert.strictEqual(failed.message, 'Claude runtime setting changed.');
		}
	});

	test('a runtime switch during begin disposes the session on the stale runtime', async () => {
		const config = store.add(new TestConfig());
		config.kind = 'live';
		config.path = 'C:\\Claude\\one.exe';
		let releaseBegin: () => void = () => { };
		const beginGate = new Promise<void>(resolve => { releaseBegin = resolve; });
		const lives: RuntimeStub[] = [];
		const service = store.add(new ClaudeSharedRuntimeService({
			getKind: () => config.kind,
			getRuntimePath: () => config.path,
			onDidChangeConfiguration: config.onDidChangeConfiguration,
			createFake: () => { throw new Error('fake runtime should not be created'); },
			createLive: runtimePath => {
				const runtime = new RuntimeStub('live', runtimePath);
				lives.push(runtime);
				return runtime;
			},
		}));
		const events: NormalizedClaudeEvent[] = [];
		store.add(service.onDidEmitEvent(event => events.push(event)));

		lives[0].beginGate = beginGate;
		const pending = service.begin({ prompt: 'ok', cwd: '/repo', mode: 'agent' });
		await timeout(0);
		config.path = 'C:\\Claude\\two.exe';
		config.fire([CLAUDE_AGENT_RUNTIME_PATH_SETTING]);
		releaseBegin();
		const handle = await pending;

		assert.strictEqual(lives.length, 2);
		assert.deepStrictEqual(lives[0].disposedSessions, [handle.sessionId]);
		const failed = events.filter(event => event.type === 'session.failed');
		assert.strictEqual(failed.length, 1);
		assert.strictEqual(failed[0].sessionId, handle.sessionId);
		if (failed[0].type === 'session.failed') {
			assert.strictEqual(failed[0].message, 'Claude runtime setting changed.');
		}
	});

	test('a finished or disposed session is not failed when the runtime changes', async () => {
		const config = store.add(new TestConfig());
		config.kind = 'live';
		config.path = 'C:\\Claude\\one.exe';
		const lives: RuntimeStub[] = [];
		const service = store.add(new ClaudeSharedRuntimeService({
			getKind: () => config.kind,
			getRuntimePath: () => config.path,
			onDidChangeConfiguration: config.onDidChangeConfiguration,
			createFake: () => { throw new Error('fake runtime should not be created'); },
			createLive: runtimePath => {
				const runtime = new RuntimeStub('live', runtimePath);
				lives.push(runtime);
				return runtime;
			},
		}));
		const events: NormalizedClaudeEvent[] = [];
		store.add(service.onDidEmitEvent(event => events.push(event)));

		const completed = await service.begin({ prompt: 'ok', cwd: '/repo', mode: 'agent' });
		lives[0].events.fire({ type: 'session.completed', sessionId: completed.sessionId });
		const disposed = await service.begin({ prompt: 'ok', cwd: '/other', mode: 'agent' });
		await service.disposeSession(disposed.sessionId);
		assert.deepStrictEqual(lives[0].disposedSessions, [disposed.sessionId]);

		config.path = 'C:\\Claude\\two.exe';
		config.fire([CLAUDE_AGENT_RUNTIME_PATH_SETTING]);
		await timeout(0);

		assert.strictEqual(events.filter(event => event.type === 'session.failed').length, 0);
	});

	test('disposing the shared runtime fails an open session as stopped', async () => {
		const config = store.add(new TestConfig());
		config.kind = 'live';
		config.path = 'C:\\Claude\\one.exe';
		const service = store.add(new ClaudeSharedRuntimeService({
			getKind: () => config.kind,
			getRuntimePath: () => config.path,
			onDidChangeConfiguration: config.onDidChangeConfiguration,
			createFake: () => { throw new Error('fake runtime should not be created'); },
			createLive: runtimePath => new RuntimeStub('live', runtimePath),
		}));
		const events: NormalizedClaudeEvent[] = [];
		store.add(service.onDidEmitEvent(event => events.push(event)));

		const handle = await service.begin({ prompt: 'ok', cwd: '/repo', mode: 'agent' });
		service.dispose();

		const failed = events.filter(event => event.type === 'session.failed');
		assert.strictEqual(failed.length, 1);
		assert.strictEqual(failed[0].sessionId, handle.sessionId);
		if (failed[0].type === 'session.failed') {
			assert.strictEqual(failed[0].kind, 'unknown');
			assert.strictEqual(failed[0].message, 'Claude runtime stopped.');
		}
	});

	test('proxies a fake session across an IPC channel', async () => {
		const config = store.add(new TestConfig());
		const service = store.add(new ClaudeSharedRuntimeService({
			getKind: () => 'fake',
			getRuntimePath: () => undefined,
			onDidChangeConfiguration: config.onDidChangeConfiguration,
			createFake: () => new FakeClaudeRuntimeService(secretFixtures()),
			createLive: () => { throw new Error('live runtime should not be created'); },
		}));
		const ipc = store.add(new DisposableStore());
		const server = ipc.add(new TestIPCServer());
		server.registerChannel(CLAUDE_RUNTIME_CHANNEL, ProxyChannel.fromService(service, ipc));
		const client = ipc.add(server.createConnection('renderer'));
		const proxy = ProxyChannel.toService<IClaudeRuntimeService>(client.getChannel(CLAUDE_RUNTIME_CHANNEL));

		const events: NormalizedClaudeEvent[] = [];
		ipc.add(proxy.onDidEmitEvent(event => events.push(event)));
		await timeout(0);

		const handle = await proxy.begin({
			prompt: 'Reply with the single word ok.',
			cwd: '/repo',
			mode: 'agent',
			fixture: 'test-session',
		});
		assert.ok(handle.sessionId);

		const settled = await settle(events);
		assert.ok(settled.some(event => event.type === 'tool.started' && event.call.name === 'Read'));
		assert.strictEqual(settled[settled.length - 1].type, 'session.completed');
		assert.ok(settled.every(event => event.sessionId === handle.sessionId));
		// The channel forwards the normalized event, including tool input.
		// Redaction happens in the output-channel formatter, not on the IPC payload.
		assert.strictEqual(JSON.stringify(settled).includes(SECRET), true);
		assert.strictEqual(JSON.stringify([...claudeTestSessionFixtures().values()]).includes(SECRET), false);
	});
});

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

const SECRET = 'sk-ant-api03-testsecretvalue';

class TestConfig extends Disposable {
	kind: ClaudeAgentRuntimeKind = 'fake';
	path: string | undefined;
	private readonly _onDidChangeConfiguration = this._register(new Emitter<IConfigurationChangeEvent>());
	readonly onDidChangeConfiguration = this._onDidChangeConfiguration.event;

	fire(keys: readonly string[]): void {
		this._onDidChangeConfiguration.fire({
			affectsConfiguration: key => keys.includes(key),
		} as IConfigurationChangeEvent);
	}
}

class RuntimeStub extends Disposable implements IClaudeRuntimeService {
	declare readonly _serviceBrand: undefined;
	ensureCount = 0;
	disposed = false;
	beginGate: Promise<void> | undefined;
	readonly disposedSessions: string[] = [];
	readonly events = this._register(new Emitter<NormalizedClaudeEvent>());
	readonly onDidEmitEvent = this.events.event;
	private readonly _onDidChangeRuntimeState = this._register(new Emitter<ClaudeRuntimeState>());
	readonly onDidChangeRuntimeState = this._onDidChangeRuntimeState.event;

	constructor(private readonly label: 'fake' | 'live', readonly runtimePath?: string) {
		super();
	}

	async getRuntimeState(): Promise<ClaudeRuntimeState> {
		return { installed: true, authenticated: false, version: this.label };
	}

	async ensureRuntime(): Promise<ClaudeRuntimeState> {
		this.ensureCount++;
		const state = await this.getRuntimeState();
		this._onDidChangeRuntimeState.fire(state);
		return state;
	}

	async begin(request: BeginClaudeRequest): Promise<ClaudeRunHandle> {
		if (this.beginGate) {
			await this.beginGate;
		}
		return { sessionId: `${this.label}:${request.cwd}` };
	}

	async send(_sessionId: string, _input: ClaudeUserInput): Promise<void> { }
	async canSteer(_sessionId: string): Promise<boolean> { return false; }
	async steer(_sessionId: string, _text: string): Promise<boolean> { return false; }
	async interrupt(_sessionId: string): Promise<void> { }
	async resolvePermission(): Promise<void> { }
	async interruptSubagent(_sessionId: string, _runId: string): Promise<void> { }
	async disposeSession(sessionId: string): Promise<void> {
		this.disposedSessions.push(sessionId);
	}
	async listModels(): Promise<readonly ClaudeModelInfo[]> { return []; }
	async setModel(_sessionId: string, _modelId: string): Promise<void> { }

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}
}

class QueueProtocol implements IMessagePassingProtocol {
	private buffering = true;
	private buffers: VSBuffer[] = [];
	private readonly _onMessage = new Emitter<VSBuffer>({
		onDidAddFirstListener: () => {
			for (const buffer of this.buffers) {
				this._onMessage.fire(buffer);
			}
			this.buffers = [];
			this.buffering = false;
		},
		onDidRemoveLastListener: () => {
			this.buffering = true;
		}
	});
	readonly onMessage = this._onMessage.event;
	other!: QueueProtocol;

	send(buffer: VSBuffer): void {
		this.other.receive(buffer);
	}

	protected receive(buffer: VSBuffer): void {
		if (this.buffering) {
			this.buffers.push(buffer);
		} else {
			this._onMessage.fire(buffer);
		}
	}

	dispose(): void {
		this._onMessage.dispose();
	}
}

function createProtocolPair(): [QueueProtocol, QueueProtocol] {
	const one = new QueueProtocol();
	const other = new QueueProtocol();
	one.other = other;
	other.other = one;
	return [one, other];
}

class TestIPCClient extends IPCClient<string> {
	private readonly _onDidDisconnect = new Emitter<void>();
	readonly onDidDisconnect = this._onDidDisconnect.event;

	constructor(protocol: IMessagePassingProtocol, id: string) {
		super(protocol, id);
	}

	override dispose(): void {
		this._onDidDisconnect.fire();
		this._onDidDisconnect.dispose();
		super.dispose();
	}
}

class TestIPCServer extends IPCServer<string> {
	private readonly onDidClientConnect: Emitter<ClientConnectionEvent>;

	constructor() {
		const onDidClientConnect = new Emitter<ClientConnectionEvent>();
		super(onDidClientConnect.event);
		this.onDidClientConnect = onDidClientConnect;
	}

	private readonly protocols: QueueProtocol[] = [];

	createConnection(id: string): IPCClient<string> {
		const [pc, ps] = createProtocolPair();
		this.protocols.push(pc, ps);
		const client = new TestIPCClient(pc, id);
		this.onDidClientConnect.fire({
			protocol: ps,
			onDidClientDisconnect: client.onDidDisconnect,
		});
		return client;
	}

	override dispose(): void {
		this.onDidClientConnect.dispose();
		for (const protocol of this.protocols) {
			protocol.dispose();
		}
		super.dispose();
	}
}

function nextTick(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

async function settle(events: NormalizedClaudeEvent[]): Promise<NormalizedClaudeEvent[]> {
	for (let i = 0; i < 40; i++) {
		await nextTick();
		if (events.some(event => event.type === 'session.completed')) {
			await nextTick();
			return events;
		}
	}
	assert.fail(`fixture did not settle (${events.map(event => event.type).join(',')})`);
}
