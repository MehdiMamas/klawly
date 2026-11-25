/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BeginClaudeRequest, ClaudeModelInfo } from '../../../../../platform/claude/common/claude.js';
import { CLAUDE_MODELS_AUTO_SETTING } from '../../../../../platform/claude/common/claudeAutoModel.js';
import { CLAUDE_AGENT_DEFAULT_MODE_SETTING, CLAUDE_AGENT_ENABLED_SETTING, CLAUDE_AGENT_NEW_CHATS_FIRST_SETTING, CLAUDE_INLINE_EDIT_MODEL_SETTING, CLAUDE_MODELS_CUSTOM_SETTING, CLAUDE_MODELS_DEFAULT_SETTING, CLAUDE_MODELS_EFFORT_SETTING, CLAUDE_MODELS_FAST_MODE_SETTING, CLAUDE_MODELS_ULTRACODE_SETTING } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { ClaudeSessionSettings } from '../../../../../platform/claude/common/claudeSessionSettings.js';
import { FakeClaudeRuntimeService } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IOutputService } from '../../../output/common/output.js';
import { ClaudeAgentService, ClaudeModelRejection } from '../../common/claudeAgentService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { agentWorkspaceStubs, TestPickStorage } from './claudeAgentTestUtils.js';

suite('Claude agent settings (spec 46, spec 34b)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(values: Record<string, unknown>, runtime = store.add(new FakeClaudeRuntimeService(fixtures()))): { agent: ClaudeAgentService; runtime: FakeClaudeRuntimeService } {
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs({ configuration: new TestConfigurationService(values) })));
		return { agent, runtime };
	}

	test('new sessions start in claude.agent.defaultMode with claude.models.default', async () => {
		const { agent, runtime } = create({ [CLAUDE_AGENT_DEFAULT_MODE_SETTING]: 'plan', [CLAUDE_MODELS_DEFAULT_SETTING]: 'fixture-opus' });
		const begins: BeginClaudeRequest[] = [];
		const begin = runtime.begin.bind(runtime);
		runtime.begin = async request => {
			begins.push(request);
			return begin(request);
		};
		const first = agent.createSession();
		assert.deepStrictEqual([first.mode, first.modelId, first.modelName], ['plan', 'fixture-opus', 'fixture-opus']);
		await agent.setNextModel(first.id, 'fixture-sonnet');
		const second = agent.createSession();
		assert.deepStrictEqual([second.mode, second.modelId, second.modelName], ['plan', 'fixture-opus', 'Fixture Opus']);
		await agent.submit(second.id, 'Why?', '/repo');
		assert.deepStrictEqual(begins.map(request => [request.mode, request.modelId]), [['plan', 'fixture-opus']]);
	});

	test('new chats go last by default and first with claude.agent.newChatsFirst, and moveSession reorders the tabs (issue 964)', async () => {
		const ids = (agent: ClaudeAgentService) => agent.getSessions().map(session => session.id);
		const last = create({}).agent;
		const lastIds = [last.createSession().id, last.createSession().id, last.createSession().id];
		const first = create({ [CLAUDE_AGENT_NEW_CHATS_FIRST_SETTING]: true }).agent;
		const firstIds = [first.createSession().id, first.createSession().id, first.createSession().id];
		const defaults = ids(last);
		last.moveSession(lastIds[2], lastIds[0]);
		const movedFront = ids(last);
		last.moveSession(lastIds[2], undefined);
		assert.deepStrictEqual(
			{ defaults, newestFirst: ids(first), movedFront, movedBack: ids(last) },
			{ defaults: lastIds, newestFirst: [...firstIds].reverse(), movedFront: [lastIds[2], lastIds[0], lastIds[1]], movedBack: lastIds },
		);
	});

	test('without settings, sessions keep the old defaults', () => {
		const { agent } = create({});
		const session = agent.createSession();
		assert.deepStrictEqual([session.mode, session.modelId], ['agent', undefined]);
	});

	test('without claude.models.default, a new session starts on the model last picked, in any window, while Claude still reports it', async () => {
		const storage = new TestPickStorage();
		const open = (custom: string[] = []) => store.add(new ClaudeAgentService(store.add(new FakeClaudeRuntimeService(fixtures())), output(), ...agentWorkspaceStubs({ storage: storage as unknown as IStorageService, configuration: new TestConfigurationService({ [CLAUDE_MODELS_CUSTOM_SETTING]: custom }) })));
		const agent = open();
		const fresh = agent.createSession();
		await agent.setNextModel(fresh.id, 'fixture-sonnet');
		const next = agent.createSession();
		const otherWindow = open().createSession();
		const custom = open(['my-model']);
		await custom.setNextModel(custom.createSession().id, 'my-model');
		const afterCustom = custom.createSession();
		const gone = agent.createSession();
		assert.deepStrictEqual(
			[fresh.modelId, [next.modelId, next.modelName], otherWindow.modelId, afterCustom.modelId, gone.modelId],
			[undefined, ['fixture-sonnet', 'Fixture Sonnet'], 'fixture-sonnet', 'my-model', undefined],
		);
	});

	test('#950: picking Auto in the model picker is what new chats start on, in any window and after a restart, until a model is picked', async () => {
		const storage = new TestPickStorage();
		const open = () => store.add(new ClaudeAgentService(store.add(new FakeClaudeRuntimeService(fixtures())), output(), ...agentWorkspaceStubs({ storage: storage as unknown as IStorageService })));
		const agent = open();
		const first = agent.createSession();
		agent.setAutoModel(first.id, true, true);
		const next = agent.createSession();
		const restarted = open();
		const afterRestart = restarted.createSession();
		const onRestart = !!restarted.getAutoModel(afterRestart.id);
		await restarted.setNextModel(afterRestart.id, 'fixture-sonnet');
		const later = open();
		const afterModel = later.createSession();
		assert.deepStrictEqual(
			[!!agent.getAutoModel(next.id), onRestart, later.getAutoModel(afterModel.id)],
			[true, true, undefined],
		);
	});

	test('a custom model id can be picked; an invented one cannot', async () => {
		const { agent } = create({ [CLAUDE_MODELS_CUSTOM_SETTING]: ['my-model'] });
		const session = agent.createSession();
		await agent.setNextModel(session.id, 'my-model');
		assert.deepStrictEqual([agent.getCurrentSession()?.modelId, agent.getCurrentSession()?.modelName], ['my-model', 'my-model']);
		await assert.rejects(() => agent.setNextModel(session.id, 'invented'), /not in the list/);
	});

	test('claude.inlineEdit.model applies to the inline turn only, then the runtime default returns', async () => {
		const { agent, runtime } = create({ [CLAUDE_INLINE_EDIT_MODEL_SETTING]: 'fixture-opus' });
		const switched: string[] = [];
		runtime.setModel = async (_sessionId, modelId) => { switched.push(modelId); };
		const session = agent.createSession();
		await agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		await agent.submit(session.id, 'Rename x', '/repo', { origin: 'inline-edit', keepDraft: true });
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		await agent.submit(session.id, 'Thanks', '/repo');
		await until(() => agent.getViewState(session.id).turns[2]?.status === 'complete');
		const turns = agent.getViewState(session.id).turns;
		assert.deepStrictEqual({
			switched,
			sentModels: turns.map(turn => turn.user.sent?.modelId),
			inline: turns.map(turn => agent.isInlineEditTurn(session.id, turn.id)),
		}, {
			switched: ['fixture-opus', 'fixture-sonnet'],
			sentModels: [undefined, 'fixture-opus', undefined],
			inline: [false, true, false],
		});
	});

	test('a closed session forgets which of its turns inline edit started', async () => {
		const { agent } = create({});
		const kept = agent.createSession();
		const closed = agent.createSession();
		for (const session of [kept, closed]) {
			await agent.submit(session.id, 'Rename x', '/repo', { origin: 'inline-edit', keepDraft: true });
			await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		}
		const keptTurn = agent.getViewState(kept.id).turns[0].id;
		const closedTurn = agent.getViewState(closed.id).turns[0].id;
		agent.closeSession(closed.id);
		assert.deepStrictEqual([agent.isInlineEditTurn(kept.id, keptTurn), agent.isInlineEditTurn(closed.id, closedTurn)], [true, false]);
		agent.dispose();
		assert.strictEqual(agent.isInlineEditTurn(kept.id, keptTurn), false);
	});

	test('a rejected model is reported and the turn falls back to claude.models.default', async () => {
		const { agent, runtime } = create({ [CLAUDE_MODELS_DEFAULT_SETTING]: 'fixture-sonnet' });
		const attempts: string[] = [];
		runtime.setModel = async (_sessionId, modelId) => {
			attempts.push(modelId);
			if (modelId === 'fixture-opus') {
				throw new Error('model not available on this plan');
			}
		};
		const rejections: ClaudeModelRejection[] = [];
		store.add(agent.onDidRejectModel(event => rejections.push(event)));
		const session = agent.createSession();
		await agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		await agent.setNextModel(session.id, 'fixture-opus');
		await agent.submit(session.id, 'Again', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		assert.deepStrictEqual({
			attempts,
			rejections: rejections.map(event => [event.modelId, event.fallback, event.message]),
			modelId: agent.getCurrentSession()?.modelId,
		}, {
			attempts: ['fixture-opus'],
			rejections: [['fixture-opus', 'fixture-sonnet', 'model not available on this plan']],
			modelId: 'fixture-sonnet',
		});
	});

	test('a new session opens with the configured effort and switches, fitted to its model (Phase 33)', async () => {
		const { agent, runtime } = create({
			[CLAUDE_MODELS_DEFAULT_SETTING]: 'fixture-opus',
			[CLAUDE_MODELS_EFFORT_SETTING]: { 'fixture-opus': 'xhigh', 'fixture-sonnet': 'high' },
			[CLAUDE_MODELS_FAST_MODE_SETTING]: true,
			[CLAUDE_MODELS_ULTRACODE_SETTING]: false,
		});
		const begins: BeginClaudeRequest[] = [];
		const begin = runtime.begin.bind(runtime);
		runtime.begin = async request => {
			begins.push(request);
			return begin(request);
		};
		const opus = agent.createSession();
		const unloaded = agent.getSessionSettings(opus.id);
		await agent.submit(opus.id, 'Why?', '/repo');
		await until(() => agent.getViewState(opus.id).turns[0]?.status === 'complete');
		const sonnet = agent.createSession();
		await agent.setNextModel(sonnet.id, 'fixture-sonnet');
		await agent.submit(sonnet.id, 'Why?', '/repo');
		await until(() => agent.getViewState(sonnet.id).turns[0]?.status === 'complete');
		assert.deepStrictEqual({
			unloaded,
			opus: agent.getSessionSettings(opus.id),
			sonnet: agent.getSessionSettings(sonnet.id),
			sent: begins.map(request => request.sessionSettings),
		}, {
			// Nothing is shown for a model the runtime has not reported yet.
			unloaded: {},
			opus: { effort: 'xhigh', fastMode: true },
			sonnet: {},
			sent: [{ effort: 'xhigh', fastMode: true }, {}],
		});
	});

	test('picked settings are checked, reach the live query once, and follow a model switch (Phase 33)', async () => {
		const { agent, runtime } = create({ [CLAUDE_MODELS_DEFAULT_SETTING]: 'fixture-opus' });
		const applied: ClaudeSessionSettings[] = [];
		const setSessionSettings = runtime.setSessionSettings.bind(runtime);
		runtime.setSessionSettings = async (sessionId, settings) => {
			applied.push(settings);
			return setSessionSettings(sessionId, settings);
		};
		const runtimeIds: string[] = [];
		const begin = runtime.begin.bind(runtime);
		runtime.begin = async request => {
			const handle = await begin(request);
			runtimeIds.push(handle.sessionId);
			return handle;
		};
		const reasons: string[] = [];
		store.add(agent.onDidChangeSession(change => reasons.push(change.reason)));
		const session = agent.createSession();
		await agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		await agent.setNextSettings(session.id, { effort: 'max', ultracode: true });
		await agent.setNextSettings(session.id, { effort: 'max', ultracode: true });
		await agent.submit(session.id, 'Again', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		await agent.submit(session.id, 'Once more', '/repo');
		await until(() => agent.getViewState(session.id).turns[2]?.status === 'complete');
		await agent.setNextModel(session.id, 'fixture-sonnet');
		const afterSwitch = agent.getSessionSettings(session.id);
		await assert.rejects(() => agent.setNextSettings(session.id, { fastMode: true }), /no fast mode/);
		await assert.rejects(() => agent.setNextSettings('closed', {}), /not open/);
		assert.deepStrictEqual({
			applied,
			runtime: runtimeIds.map(id => runtime.getSessionSettings(id)),
			afterSwitch,
			reasons: reasons.filter(reason => reason === 'settings').length,
		}, {
			applied: [{ effort: 'max', ultracode: true }],
			runtime: [{ effort: 'max', ultracode: true }],
			afterSwitch: {},
			reasons: 1,
		});
	});

	test('a session on the runtime default keeps its configured settings on follow-up turns (Phase 33)', async () => {
		const { agent, runtime } = create({
			[CLAUDE_MODELS_EFFORT_SETTING]: { default: 'high' },
			[CLAUDE_MODELS_FAST_MODE_SETTING]: true,
		});
		// A `default` row that runs on fixture-opus. The script's `session.started` then
		// reports `fixture-sonnet`, standing in for a resolved id with neither effort nor fast mode.
		const listModels = runtime.listModels.bind(runtime);
		runtime.listModels = async () => [
			{ id: 'default', displayName: 'Default', description: 'Scripted default', source: 'runtime', supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsFastMode: true },
			...await listModels(),
		];
		const applied: ClaudeSessionSettings[] = [];
		const setSessionSettings = runtime.setSessionSettings.bind(runtime);
		runtime.setSessionSettings = async (sessionId, settings) => {
			applied.push(settings);
			return setSessionSettings(sessionId, settings);
		};
		const runtimeIds: string[] = [];
		const begin = runtime.begin.bind(runtime);
		runtime.begin = async request => {
			const handle = await begin({ ...request, modelId: request.modelId ?? 'fixture-opus' });
			runtimeIds.push(handle.sessionId);
			return handle;
		};
		const session = agent.createSession();
		await agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		await agent.submit(session.id, 'Again', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		assert.deepStrictEqual({
			applied,
			runtime: runtimeIds.map(id => runtime.getSessionSettings(id)),
			shown: agent.getSessionSettings(session.id),
		}, {
			applied: [],
			runtime: [{ effort: 'high', fastMode: true }],
			shown: { effort: 'high', fastMode: true },
		});
	});

	test('#95: a fresh install starts at medium, then each new session starts at the level last picked, in any window and after a restart; Max and Ultracode are not remembered', async () => {
		const storage = new TestPickStorage();
		const open = (values: Record<string, unknown> = {}) => {
			const runtime = store.add(new FakeClaudeRuntimeService(fixtures()));
			const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs({ storage: storage as unknown as IStorageService, configuration: new TestConfigurationService({ [CLAUDE_MODELS_DEFAULT_SETTING]: 'fixture-opus', ...values }) })));
			return { agent, runtime };
		};
		const effortOf = async (agent: ClaudeAgentService) => {
			const session = agent.createSession();
			await agent.setNextModel(session.id, 'fixture-opus');
			return agent.getSessionSettings(session.id).effort;
		};
		const { agent, runtime } = open();
		const begins: BeginClaudeRequest[] = [];
		const begin = runtime.begin.bind(runtime);
		runtime.begin = async request => {
			begins.push(request);
			return begin(request);
		};
		const fresh = agent.createSession();
		await agent.submit(fresh.id, 'Why?', '/repo');
		await until(() => agent.getViewState(fresh.id).turns[0]?.status === 'complete');
		await agent.setNextSettings(fresh.id, { effort: 'high' });
		const afterHigh = await effortOf(agent);
		const restarted = await effortOf(open().agent);
		const maxed = agent.createSession();
		await agent.setNextModel(maxed.id, 'fixture-opus');
		await agent.setNextSettings(maxed.id, { effort: 'max' });
		await agent.setNextSettings(maxed.id, { effort: 'max', ultracode: true });
		const afterMaxAndUltracode = await effortOf(agent);
		const configured = await effortOf(open({ [CLAUDE_MODELS_EFFORT_SETTING]: { 'fixture-opus': 'low' } }).agent);
		assert.deepStrictEqual({
			sent: begins.map(request => request.sessionSettings),
			afterHigh,
			restarted,
			afterMaxAndUltracode,
			configured,
			remembered: [...storage.values.values()].filter(value => !value.startsWith('fixture') && !value.startsWith('[')),
		}, {
			// The level reaches Claude Code explicitly, so its own effortLevel setting cannot override it.
			sent: [{ effort: 'medium' }],
			afterHigh: 'high',
			restarted: 'high',
			afterMaxAndUltracode: 'high',
			configured: 'low',
			remembered: ['high'],
		});
	});

	test('a refused change is reported, the pick goes back to what the query has, and the turn goes on (Phase 33)', async () => {
		const { agent, runtime } = create({ [CLAUDE_MODELS_DEFAULT_SETTING]: 'fixture-opus' });
		runtime.setSessionSettings = async () => {
			throw new Error('fast mode is not on this plan');
		};
		const session = agent.createSession();
		await agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		await agent.setNextSettings(session.id, { fastMode: true });
		const picked = agent.getSessionSettings(session.id);
		await agent.submit(session.id, 'Again', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		assert.deepStrictEqual([picked, agent.getSessionSettings(session.id), agent.getViewState(session.id).turns.map(turn => turn.status)], [
			{ effort: 'medium', fastMode: true },
			{ effort: 'medium' },
			['complete', 'complete'],
		]);
	});

	test('the fake runtime cooldown drives the fast mode state and drops once to a single notice event (issue 456)', async () => {
		const cooldown = [
			'{"type":"session.started","sessionId":"$session","model":"fixture-opus"}',
			'{"type":"session.fastMode","sessionId":"$session","status":{"state":"on"}}',
			'{"type":"session.fastMode","sessionId":"$session","status":{"state":"cooldown","resumesAt":4102444800000},"previous":{"state":"on"}}',
			'{"type":"session.fastMode","sessionId":"$session","status":{"state":"cooldown","resumesAt":4102444900000},"previous":{"state":"cooldown"}}',
			'{"type":"assistant.completed","sessionId":"$session","text":"Done."}',
			'{"type":"session.completed","sessionId":"$session"}',
		].join('\n');
		const { agent } = create({ [CLAUDE_MODELS_DEFAULT_SETTING]: 'fixture-opus' }, store.add(new FakeClaudeRuntimeService(new Map([['plain-answer', cooldown]]))));
		const session = agent.createSession();
		const drops: string[] = [];
		store.add(agent.onDidDropFastMode(drop => drops.push(`${drop.sessionId === session.id}:${drop.previous.state}>${drop.status.state}`)));
		const before = agent.getFastModeStatus(session.id);
		await agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		assert.deepStrictEqual({ before, after: agent.getFastModeStatus(session.id), drops }, {
			before: undefined,
			after: { state: 'cooldown', resumesAt: 4102444900000 },
			drops: ['true:on>cooldown'],
		});
	});

	test('Auto runs every message on Opus and only the effort follows the rating (issues 521, 1254)', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), { models: AUTO_MODELS }));
		const { agent } = create({ [CLAUDE_MODELS_AUTO_SETTING]: 'balance' }, runtime);
		const begins: [string | undefined, string | undefined][] = [];
		const begin = runtime.begin.bind(runtime);
		runtime.begin = async request => {
			begins.push([request.modelId, request.sessionSettings?.effort]);
			return begin(request);
		};
		const switched: string[] = [];
		const setModel = runtime.setModel.bind(runtime);
		runtime.setModel = async (sessionId, modelId) => {
			switched.push(modelId);
			return setModel(sessionId, modelId);
		};
		const efforts: (string | undefined)[] = [];
		const setSessionSettings = runtime.setSessionSettings.bind(runtime);
		runtime.setSessionSettings = async (sessionId, settings) => {
			efforts.push(settings.effort);
			return setSessionSettings(sessionId, settings);
		};
		const session = agent.createSession();
		const before = agent.getAutoModel(session.id);
		const prompts = ['Why does this test fail?', 'Fix the off-by-one in readToken and add a test for it.', 'Refactor the storage layer so every service shares one cache.'];
		for (const [index, prompt] of prompts.entries()) {
			await agent.submit(session.id, prompt, '/repo');
			await until(() => agent.getViewState(session.id).turns[index]?.status === 'complete');
		}
		const auto = agent.getViewState(session.id).turns.map(turn => {
			const pick = turn.user.sent?.auto;
			return [turn.user.sent?.modelId, pick?.complexity, pick?.modelName, pick?.effort, pick?.source];
		});
		assert.deepStrictEqual({ before, begins, switched, efforts, auto, last: agent.getAutoModel(session.id)?.last?.modelId, pill: agent.getSessionSettings(session.id) }, {
			before: {},
			begins: [['opus', 'low']],
			switched: [],
			efforts: ['medium', 'high'],
			auto: [
				['opus', 'simple', 'Opus', 'low', 'claude'],
				['opus', 'moderate', 'Opus', 'medium', 'claude'],
				['opus', 'complex', 'Opus', 'high', 'claude'],
			],
			last: 'opus',
			pill: { effort: 'high' },
		});
	});

	test('Auto estimates when the classifier fails, skips slash commands, and a picked model turns it off (issue 521)', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), { models: AUTO_MODELS }));
		runtime.classifyAutoModel = async () => ({ ok: false, message: 'Claude did not rate the prompt.' });
		const { agent } = create({}, runtime);
		const begins: (string | undefined)[] = [];
		const begin = runtime.begin.bind(runtime);
		runtime.begin = async request => {
			begins.push(request.modelId);
			return begin(request);
		};
		const session = agent.createSession();
		const off = agent.getAutoModel(session.id);
		agent.setAutoModel(session.id, true);
		await agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		await agent.submit(session.id, '/compact', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		await agent.setNextModel(session.id, 'haiku');
		const afterPick = agent.getAutoModel(session.id);
		const turns = agent.getViewState(session.id).turns.map(turn => turn.user.sent?.auto && [turn.user.sent.auto.modelId, turn.user.sent.auto.source]);
		assert.throws(() => agent.setAutoModel('closed', true), /not open/);
		assert.deepStrictEqual({ off, begins, turns, afterPick }, {
			off: undefined,
			begins: ['opus'],
			turns: [['opus', 'estimate'], undefined],
			afterPick: undefined,
		});
	});

	test('claude.agent.enabled false refuses new turns and keeps the session', async () => {
		const { agent } = create({ [CLAUDE_AGENT_ENABLED_SETTING]: false });
		const session = agent.createSession();
		await assert.rejects(() => agent.submit(session.id, 'Why?', '/repo'), /Agent features are turned off/);
		await assert.rejects(() => agent.queue(session.id, 'Why?', '/repo', 'queue'), /Agent features are turned off/);
		assert.deepStrictEqual([agent.getViewState(session.id).turns.length, agent.getSessions().length], [0, 1]);
	});
});

/** Claude Code's three current families, for Auto model. */
const AUTO_MODELS: readonly ClaudeModelInfo[] = [
	{ id: 'opus', displayName: 'Opus', source: 'runtime', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
	{ id: 'sonnet', displayName: 'Sonnet', source: 'runtime', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
	{ id: 'haiku', displayName: 'Haiku', source: 'runtime', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
];

function fixtures(): Map<string, string> {
	return new Map([
		['plain-answer', [
			'{"type":"session.started","sessionId":"$session","model":"fixture-sonnet"}',
			'{"type":"assistant.completed","sessionId":"$session","text":"Done."}',
			'{"type":"session.completed","sessionId":"$session"}',
		].join('\n')],
	]);
}

function output(): IOutputService {
	return {
		_serviceBrand: undefined,
		getChannel: () => ({ append: () => undefined }),
	} as unknown as IOutputService;
}

async function until(read: () => boolean): Promise<void> {
	for (let i = 0; i < 80; i++) {
		if (read()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.fail('timed out waiting for the turn');
}
