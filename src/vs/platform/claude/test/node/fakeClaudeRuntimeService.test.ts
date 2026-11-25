/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readdirSync, readFileSync } from 'fs';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { BeginClaudeRequest } from '../../common/claude.js';
import { FakeClaudeRuntimeService, parseClaudeFixture } from '../../common/fakeClaudeRuntimeService.js';
import { NormalizedClaudeEvent } from '../../common/claudeProtocol.js';

suite('FakeClaudeRuntimeService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const fixtures = loadFixtures();

	test('replays a scripted plain answer for one session', async () => {
		const service = store.add(new FakeClaudeRuntimeService(fixtures));
		const events = await replay(service, { prompt: 'Explain the handler', cwd: '/repo', mode: 'agent', fixture: 'plain-answer' });

		assert.strictEqual(events[0].type, 'session.started');
		assert.ok(events[0].sessionId);
		assert.ok(events.some(event => event.type === 'assistant.delta' && event.text.includes('handler')));
		assert.strictEqual(events[events.length - 1].type, 'session.completed');
		assert.ok(events.every(event => event.sessionId === events[0].sessionId));
	});

	test('replays two parallel subagents and can stop one of them', async () => {
		const service = store.add(new FakeClaudeRuntimeService(fixtures));
		const seen: NormalizedClaudeEvent[] = [];
		store.add(service.onDidEmitEvent(event => seen.push(event)));

		const started = waitFor(service, event => event.type === 'subagent.started' && event.run.id === 'run-b');
		const handle = await service.begin({ prompt: 'Investigate login', cwd: '/repo', mode: 'agent', fixture: 'parallel-subagents' });
		await started;
		await service.interruptSubagent(handle.sessionId, 'run-b');

		const events = await settle(seen);
		const starts = events.filter((event): event is NormalizedClaudeEvent & { type: 'subagent.started' } => event.type === 'subagent.started');
		assert.deepStrictEqual(starts.map(event => event.run.id), ['run-a', 'run-b']);

		const runBTools = events.filter(event => event.type === 'tool.started' && event.parentRunId === 'run-b');
		assert.strictEqual(runBTools.length, 0);
		assert.ok(events.some(event => event.type === 'tool.started' && event.parentRunId === 'run-a'));
		const stopped = events.find(event => event.type === 'subagent.finished' && event.runId === 'run-b' && event.state === 'stopped');
		assert.ok(stopped && stopped.type === 'subagent.finished');
		assert.strictEqual(stopped.parentRunId, undefined);
		assert.strictEqual(events[events.length - 1].type, 'session.completed');
	});

	test('listModels returns the fixture catalog and setModel emits session.modelChanged', async () => {
		const service = store.add(new FakeClaudeRuntimeService(fixtures));
		const models = await service.listModels();
		assert.deepStrictEqual(models.map(model => model.id), ['fixture-sonnet', 'fixture-opus', 'fixture-opus[1m]']);

		const seen: NormalizedClaudeEvent[] = [];
		store.add(service.onDidEmitEvent(event => seen.push(event)));
		const handle = await service.begin({ prompt: 'Hi', cwd: '/repo', mode: 'ask', fixture: 'plain-answer' });
		await service.setModel(handle.sessionId, 'fixture-opus');

		const changed = seen.find(event => event.type === 'session.modelChanged');
		assert.ok(changed && changed.type === 'session.modelChanged');
		assert.strictEqual(changed.modelId, 'fixture-opus');
		assert.strictEqual(changed.sessionId, handle.sessionId);
		await assert.rejects(() => service.setModel(handle.sessionId, 'not-a-model'));
	});

	test('given models and file writes, it reports those models and writes each scripted file before its event', async () => {
		const log: string[] = [];
		const script = [
			{ type: 'session.started', sessionId: '$session' },
			{ type: 'file.beforeWrite', sessionId: '$session', uri: 'file:///repo/a.ts', before: 'old' },
			{ type: 'file.afterWrite', sessionId: '$session', uri: 'file:///repo/a.ts', after: 'new' },
			{ type: 'session.completed', sessionId: '$session' },
		].map(event => JSON.stringify(event)).join('\n');
		const service = store.add(new FakeClaudeRuntimeService(new Map([['plain-answer', script]]), {
			models: [{ id: 'default', displayName: 'Default', source: 'runtime', resolvedModel: 'claude-opus-5-5' }],
			fileWrites: {
				beforeWrite: async (turn, uri) => { log.push(`before ${turn.checkpointSessionId}/${turn.turnId} ${turn.cwd} ${uri}`); },
				afterWrite: async (turn, uri, after) => { log.push(`after ${turn.turnId} ${uri} ${after}`); },
			},
		}));
		store.add(service.onDidEmitEvent(event => log.push(event.type)));
		const models = (await service.listModels()).map(model => model.id);
		const handle = await service.begin({ prompt: 'Hi', cwd: '/repo', mode: 'agent', checkpointSessionId: 'pane-1', turnId: 'turn-1' });
		await waitFor(service, event => event.type === 'session.completed');
		const first = log.splice(0);
		await service.send(handle.sessionId, { text: 'Again', turnId: 'turn-2' });
		await waitFor(service, event => event.type === 'session.completed');
		assert.deepStrictEqual({ models, first, second: log.filter(line => line.startsWith('before') || line.startsWith('after')) }, {
			models: ['default'],
			first: ['session.started', 'session.catalog', 'before pane-1/turn-1 /repo file:///repo/a.ts', 'file.beforeWrite', 'after turn-1 file:///repo/a.ts new', 'file.afterWrite', 'session.completed'],
			second: ['before pane-1/turn-2 /repo file:///repo/a.ts', 'after turn-2 file:///repo/a.ts new'],
		});
	});

	test('a Tab completion answers with the given text, and nothing without it', async () => {
		const request = { id: 'c1', prompt: 'complete', cwd: '/repo' };
		const plain = store.add(new FakeClaudeRuntimeService(fixtures));
		const given = store.add(new FakeClaudeRuntimeService(fixtures, { inlineCompletion: ({ id }) => `${id}: this.items.delete(sku);` }));
		assert.deepStrictEqual([await plain.completeInline(request), await given.completeInline(request)], [undefined, 'c1: this.items.delete(sku);']);
	});

	test('session settings are checked against the model and setSessionSettings emits session.settingsChanged', async () => {
		const service = store.add(new FakeClaudeRuntimeService(fixtures));
		await assert.rejects(() => service.begin({ prompt: 'Hi', cwd: '/repo', mode: 'ask', fixture: 'plain-answer', modelId: 'fixture-sonnet', sessionSettings: { effort: 'high' } }), /takes no effort level/);
		const handle = await service.begin({ prompt: 'Hi', cwd: '/repo', mode: 'ask', fixture: 'plain-answer', modelId: 'fixture-opus', sessionSettings: { effort: 'max' } });
		const seen: NormalizedClaudeEvent[] = [];
		store.add(service.onDidEmitEvent(event => seen.push(event)));
		const opened = service.getSessionSettings(handle.sessionId);
		await service.setSessionSettings(handle.sessionId, { ultracode: true, fastMode: true });
		// A value that is not Claude Code's is dropped, as it would be after IPC.
		await service.setSessionSettings(handle.sessionId, { effort: 'max', thinking: false, fastMode: 'yes' as unknown as true });
		assert.deepStrictEqual({
			opened,
			now: service.getSessionSettings(handle.sessionId),
			events: seen.filter(event => event.type === 'session.settingsChanged').map(event => event.type === 'session.settingsChanged' ? event.settings : undefined),
		}, {
			opened: { effort: 'max' },
			now: { effort: 'max', thinking: false },
			events: [{ ultracode: true, fastMode: true }, { effort: 'max', thinking: false }],
		});
	});

	test('session.started is still available after begin resolves', async () => {
		const service = store.add(new FakeClaudeRuntimeService(fixtures));
		const handle = await service.begin({ prompt: 'Explain the handler', cwd: '/repo', mode: 'agent', fixture: 'plain-answer' });
		const seen: NormalizedClaudeEvent[] = [];
		store.add(service.onDidEmitEvent(event => {
			if (event.sessionId === handle.sessionId) {
				seen.push(event);
			}
		}));

		const events = await settle(seen);
		assert.strictEqual(events[0].type, 'session.started');
		assert.strictEqual(events[0].sessionId, handle.sessionId);
		assert.strictEqual(events[events.length - 1].type, 'session.completed');
	});

	test('interruptSubagent does nothing once a run has finished', async () => {
		const service = store.add(new FakeClaudeRuntimeService(fixtures));
		const seen: NormalizedClaudeEvent[] = [];
		store.add(service.onDidEmitEvent(event => seen.push(event)));
		const handle = await service.begin({ prompt: 'Investigate login', cwd: '/repo', mode: 'agent', fixture: 'parallel-subagents' });
		await settle(seen);

		const before = seen.length;
		await service.interruptSubagent(handle.sessionId, 'run-a');
		await service.interruptSubagent(handle.sessionId, 'missing-run');
		await nextTick();
		assert.strictEqual(seen.length, before);
		assert.ok(seen.some(event => event.type === 'subagent.finished' && event.runId === 'run-a' && event.state === 'success'));
	});

	test('stopping a run skips events from a nested subagent', async () => {
		const custom = new Map(fixtures);
		custom.set('nested-subagent', [
			'{"type":"session.started","sessionId":"$session"}',
			'{"type":"subagent.started","sessionId":"$session","run":{"id":"run-outer","agentType":"general-purpose","description":"Outer","background":false,"state":"running","startedAt":1,"toolCallCount":0}}',
			'{"type":"subagent.started","sessionId":"$session","parentRunId":"run-outer","run":{"id":"run-inner","parentRunId":"run-outer","agentType":"Explore","description":"Inner","background":false,"state":"running","startedAt":2,"toolCallCount":0}}',
			'{"type":"tool.started","sessionId":"$session","parentRunId":"run-inner","call":{"id":"read-inner","name":"Read","category":"read","input":{},"display":{"label":"Read inner"}}}',
			'{"type":"subagent.finished","sessionId":"$session","parentRunId":"run-outer","runId":"run-inner","state":"success"}',
			'{"type":"subagent.finished","sessionId":"$session","runId":"run-outer","state":"success"}',
			'{"type":"session.completed","sessionId":"$session"}',
		].join('\n'));
		const service = store.add(new FakeClaudeRuntimeService(custom));
		const seen: NormalizedClaudeEvent[] = [];
		store.add(service.onDidEmitEvent(event => seen.push(event)));
		const started = waitFor(service, event => event.type === 'subagent.started' && event.run.id === 'run-outer');
		const handle = await service.begin({ prompt: 'Nest', cwd: '/repo', mode: 'agent', fixture: 'nested-subagent' });
		await started;
		await service.interruptSubagent(handle.sessionId, 'run-outer');

		const events = await settle(seen);
		assert.strictEqual(events.filter(event => event.type === 'tool.started').length, 0);
		const stopped = events.find(event => event.type === 'subagent.finished' && event.runId === 'run-outer');
		assert.ok(stopped && stopped.type === 'subagent.finished' && stopped.state === 'stopped' && stopped.parentRunId === undefined);
		assert.strictEqual(events[events.length - 1].type, 'session.completed');
	});

	test('send rejects an unknown fixture without stopping the current script', async () => {
		const service = store.add(new FakeClaudeRuntimeService(fixtures));
		const seen: NormalizedClaudeEvent[] = [];
		store.add(service.onDidEmitEvent(event => seen.push(event)));
		const handle = await service.begin({ prompt: 'Hi', cwd: '/repo', mode: 'agent', fixture: 'plain-answer' });
		await assert.rejects(() => service.send(handle.sessionId, { text: 'again', fixture: 'missing-fixture' }));
		const events = await settle(seen);
		assert.strictEqual(events[events.length - 1].type, 'session.completed');
		assert.ok(events.every(event => event.sessionId === handle.sessionId));
	});

	test('send without a fixture replays plain-answer', async () => {
		const service = store.add(new FakeClaudeRuntimeService(fixtures));
		const seen: NormalizedClaudeEvent[] = [];
		store.add(service.onDidEmitEvent(event => seen.push(event)));
		const handle = await service.begin({ prompt: 'Hi', cwd: '/repo', mode: 'agent', fixture: 'plain-answer' });
		await settle(seen);
		const again = seen.length;
		const completedBefore = seen.filter(event => event.type === 'session.completed').length;
		await service.send(handle.sessionId, { text: 'another question' });
		for (let i = 0; i < 40 && seen.filter(event => event.type === 'session.completed').length === completedBefore; i++) {
			await nextTick();
		}
		assert.ok(seen.length > again);
		assert.strictEqual(seen[seen.length - 1].type, 'session.completed');
		assert.ok(seen.slice(again).some(event => event.type === 'assistant.delta'));
	});

	test('interrupt stops the script without a terminal event', async () => {
		const service = store.add(new FakeClaudeRuntimeService(fixtures));
		const seen: NormalizedClaudeEvent[] = [];
		store.add(service.onDidEmitEvent(event => seen.push(event)));
		const firstDelta = waitFor(service, event => event.type === 'assistant.delta');
		const handle = await service.begin({ prompt: 'Write a long answer', cwd: '/repo', mode: 'agent', fixture: 'long-output' });
		await firstDelta;
		await service.interrupt(handle.sessionId);
		const events = await settle(seen);
		const types = events.map(event => event.type);
		assert.deepStrictEqual(
			[types.filter(type => type === 'assistant.delta').length < 8, types.includes('session.completed'), types.includes('session.failed')],
			[true, false, false],
		);
	});

	test('interruptSubagent after interrupt emits nothing', async () => {
		const service = store.add(new FakeClaudeRuntimeService(fixtures));
		const seen: NormalizedClaudeEvent[] = [];
		store.add(service.onDidEmitEvent(event => seen.push(event)));
		const started = waitFor(service, event => event.type === 'subagent.started' && event.run.id === 'run-a');
		const handle = await service.begin({ prompt: 'Investigate login', cwd: '/repo', mode: 'agent', fixture: 'parallel-subagents' });
		await started;
		await service.interrupt(handle.sessionId);
		await service.interruptSubagent(handle.sessionId, 'run-a');
		await settle(seen);
		assert.deepStrictEqual(seen.filter(event => event.type === 'subagent.finished' && event.runId === 'run-a'), []);
	});

	test('send replays a fixture again after a stopped subagent', async () => {
		const service = store.add(new FakeClaudeRuntimeService(fixtures));
		const seen: NormalizedClaudeEvent[] = [];
		store.add(service.onDidEmitEvent(event => seen.push(event)));
		const started = waitFor(service, event => event.type === 'subagent.started' && event.run.id === 'run-b');
		const handle = await service.begin({ prompt: 'Investigate login', cwd: '/repo', mode: 'agent', fixture: 'parallel-subagents' });
		await started;
		await service.interruptSubagent(handle.sessionId, 'run-b');
		await settle(seen);
		const again = waitFor(service, event => event.type === 'tool.started' && event.parentRunId === 'run-b');
		await service.send(handle.sessionId, { text: 'again', fixture: 'parallel-subagents' });
		const tool = await again;
		assert.strictEqual(tool.type === 'tool.started' ? tool.parentRunId : undefined, 'run-b');
	});

	test('drops unknown event types and keeps events before a truncated tail', () => {
		const sessionId = 'session-1';
		const events = parseClaudeFixture([
			'{"type":"session.started","sessionId":"$session"}',
			'{"type":"future.widget","sessionId":"$session"}',
			'{"type":"assistant.completed","sessionId":"$session","text":"kept"}',
			'{"type":"assistant.delta"',
		].join('\n'), sessionId);

		assert.deepStrictEqual(events.map(event => event.type), ['session.started', 'assistant.completed']);
		assert.strictEqual(events[0].sessionId, sessionId);
		assert.strictEqual(events[1].type === 'assistant.completed' ? events[1].text : '', 'kept');
	});

	test('every fixture replays without throwing', async () => {
		const service = store.add(new FakeClaudeRuntimeService(fixtures));
		for (const name of fixtures.keys()) {
			const events = await replay(service, { prompt: name, cwd: '/repo', mode: 'agent', fixture: name });
			assert.ok(events.length > 0, name);
			assert.strictEqual(events[0].type, 'session.started', name);
		}
	});
});

function loadFixtures(): Map<string, string> {
	const dir = join(process.cwd(), 'test', 'claude', 'fixtures');
	const map = new Map<string, string>();
	for (const file of readdirSync(dir)) {
		if (!file.endsWith('.jsonl')) {
			continue;
		}
		map.set(file.slice(0, -'.jsonl'.length), readFileSync(join(dir, file), 'utf8'));
	}
	assert.ok(map.has('plain-answer'), `no fixtures in ${dir}`);
	assert.ok(map.has('parallel-subagents'), `missing parallel-subagents in ${dir}`);
	return map;
}

async function replay(service: FakeClaudeRuntimeService, request: BeginClaudeRequest): Promise<NormalizedClaudeEvent[]> {
	const seen: NormalizedClaudeEvent[] = [];
	const listener = service.onDidEmitEvent(event => seen.push(event));
	try {
		await service.begin(request);
		return await settle(seen);
	} finally {
		listener.dispose();
	}
}

function nextTick(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

async function settle(seen: NormalizedClaudeEvent[]): Promise<NormalizedClaudeEvent[]> {
	let last = -1;
	for (let i = 0; i < 40; i++) {
		await nextTick();
		if (seen.length === last && seen.length > 0) {
			return seen;
		}
		last = seen.length;
		if (seen.some(event => event.type === 'session.completed' || event.type === 'session.failed')) {
			await nextTick();
			return seen;
		}
	}
	assert.fail(`fixture did not settle (${seen.map(event => event.type).join(',')})`);
}

function waitFor(service: FakeClaudeRuntimeService, predicate: (event: NormalizedClaudeEvent) => boolean): Promise<NormalizedClaudeEvent> {
	return new Promise(resolve => {
		const listener = service.onDidEmitEvent(event => {
			if (predicate(event)) {
				listener.dispose();
				resolve(event);
			}
		});
	});
}
