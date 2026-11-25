/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeModelInfo, ClaudeUserInput } from '../../../../../platform/claude/common/claude.js';
import { CLAUDE_MODELS_AUTO_SETTING } from '../../../../../platform/claude/common/claudeAutoModel.js';
import { FakeClaudeRuntimeService } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IClaudeWorktreeService } from '../../../../../platform/claude/common/claudeBackground.js';
import { IOutputService } from '../../../output/common/output.js';
import { ClaudeAgentService } from '../../common/claudeAgentService.js';
import { ClaudeDelegationService, claudeDelegateFollowUpText, claudeDescendants } from '../../common/claudeDelegation.js';
import { ClaudeDelegateCard, claudeAutoRoute, claudeDelegateTitle, claudeFallbackSentence } from '../../common/claudeDelegationModel.js';
import { ClaudeWorkerRegistry } from '../../common/claudeWorkerRegistry.js';
import { agentWorkspaceStubs } from './claudeAgentTestUtils.js';

/**
 * Auto delegates (issue 693): a message whose pick is another model runs in a
 * read-only delegated chat, and the chat keeps its own model. Stop on a card
 * stops everything under it and asks once whether to switch from Auto.
 */
suite('Claude delegation', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const FIX = 'Fix the off-by-one in readToken and add a test for it.';

	function create(hangOn?: string, fixture?: string, settings: Record<string, unknown> = {}, worktrees?: IClaudeWorktreeService) {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), { models: AUTO_MODELS }));
		const begins: (string | undefined)[] = [];
		const sends: string[] = [];
		const switched: string[] = [];
		const begin = runtime.begin.bind(runtime);
		runtime.begin = async request => {
			begins.push(request.modelId);
			// A delegated chat on `hangOn` (comma separated models) keeps working until it is stopped; with `fixture`, chats after the first play it.
			return begin(!!request.modelId && hangOn?.split(',').includes(request.modelId) && begins.length > 1 ? { ...request, fixture: 'working' } : fixture && begins.length > 1 ? { ...request, fixture } : request);
		};
		const send = runtime.send.bind(runtime);
		runtime.send = async (sessionId: string, input: ClaudeUserInput) => {
			sends.push(input.text);
			return send(sessionId, input);
		};
		const setModel = runtime.setModel.bind(runtime);
		runtime.setModel = async (sessionId, modelId) => {
			switched.push(modelId);
			return setModel(sessionId, modelId);
		};
		const stubs = agentWorkspaceStubs({ configuration: new TestConfigurationService({ [CLAUDE_MODELS_AUTO_SETTING]: 'balance', ...settings }) });
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...stubs));
		const registry = store.add(new ClaudeWorkerRegistry(store.add(new InMemoryStorageService())));
		const written = new Map<string, string>();
		const files = {
			readFile: async (resource: URI) => {
				const text = written.get(resource.path);
				if (text === undefined) {
					throw new Error('missing');
				}
				return { value: VSBuffer.fromString(text) };
			},
			writeFile: async (resource: URI, content: VSBuffer) => {
				written.set(resource.path, content.toString());
			},
		} as unknown as IFileService;
		const environment = { userRoamingDataHome: URI.file('/data/User') } as unknown as IEnvironmentService;
		const delegation = store.add(new ClaudeDelegationService(agent, runtime, stubs[0], registry, stubs[4], files, environment, worktrees ?? {} as IClaudeWorktreeService));
		return { agent, runtime, delegation, registry, begins, sends, switched, decisions: () => [...written.values()].flatMap(text => text.split('\n').filter(line => line)).map(line => JSON.parse(line) as Record<string, unknown>) };
	}

	function cards(agent: ClaudeAgentService, sessionId: string): readonly ClaudeDelegateCard[] {
		return agent.getViewState(sessionId).turns.flatMap(turn => turn.delegates ?? []);
	}

	/** Auto runs on Opus (issue 1254), so a chat is moved off it to give the pick somewhere to delegate from. */
	function leaveOpus(agent: ClaudeAgentService, sessionId: string, modelId = 'haiku') {
		const panes = (agent as unknown as { _paneSessions: { id: string; modelId?: string; modelName?: string }[] })._paneSessions;
		const pane = panes.find(candidate => candidate.id === sessionId)!;
		pane.modelId = modelId;
		pane.modelName = modelId === 'haiku' ? 'Haiku' : 'Opus';
	}

	function shape(card: ClaudeDelegateCard): object {
		return { model: card.modelLabel, state: card.state, stoppedByUser: !!card.stoppedByUser, rerun: !!card.rerun, children: card.children.map(shape) };
	}

	test('routing: delegate only when the pick is another model in a chat that has a conversation', () => {
		const base = { canDelegate: true, delegated: false, hasConversation: true, chatModel: 'claude-haiku-4-5', pick: 'opus' };
		assert.deepStrictEqual([
			claudeAutoRoute(base),
			claudeAutoRoute({ ...base, pick: 'claude-haiku-4-5-20251001' }),
			claudeAutoRoute({ ...base, chatModel: undefined }),
			claudeAutoRoute({ ...base, hasConversation: false }),
			claudeAutoRoute({ ...base, delegated: true }),
			claudeAutoRoute({ ...base, canDelegate: false }),
		], ['delegate', 'stay', 'stay', 'adopt', 'switch', 'switch']);
	});

	test('Auto hands a message to a delegated chat on the pick; the chat keeps its model and reads the answer next', async () => {
		const { agent, delegation, registry, begins, sends, switched } = create();
		const session = agent.createSession();
		await agent.submit(session.id, 'Why does this test fail?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		leaveOpus(agent, session.id);
		// The runtime would read the compiled prompt; the card and the delegated chat show the message.
		await agent.submit(session.id, FIX, '/repo', { compiled: `<ide_request mode="agent">\n${FIX}\n</ide_request>` });
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		const [card] = cards(agent, session.id);
		leaveOpus(agent, session.id, 'opus');
		await agent.submit(session.id, 'Why does this test fail?', '/repo');
		await until(() => agent.getViewState(session.id).turns[2]?.status === 'complete');
		const child = agent.getSessions().find(candidate => candidate.id === card.childSessionId);
		assert.deepStrictEqual({
			begins,
			switched,
			model: agent.getSessions().find(candidate => candidate.id === session.id)?.modelId,
			card: { ...shape(card as ClaudeDelegateCard), auto: card.auto, result: card.result, prompt: card.prompt, title: card.title, cost: card.costUsd },
			// The delegated chat shows the message; the model also reads the last exchanges.
			child: [child?.delegatedFrom, child?.modelId, agent.getViewState(card.childSessionId).turns.map(turn => turn.user.text)],
			task: card.task.startsWith('The conversation so far') && card.task.endsWith(`${FIX}\n</ide_request>`),
			current: agent.getCurrentSession()?.id === session.id,
			readBack: sends.at(-1)?.startsWith('[Klawly] Auto handed the user\'s last message to a delegated chat on Opus.'),
			parentCost: delegation.getDelegatedCost(session.id),
			run: registry.all().map(run => [run.number, run.kind, run.state, run.model, run.ownerSessionId === session.id, run.costUsd, run.report]),
		}, {
			begins: ['opus', 'opus'],
			switched: [],
			model: 'opus',
			card: { model: 'Opus', state: 'done', stoppedByUser: false, rerun: false, children: [], auto: true, result: 'Done.', prompt: FIX, title: claudeDelegateTitle(FIX), cost: 0.02 },
			child: [session.id, 'opus', [FIX]],
			task: true,
			current: true,
			readBack: true,
			parentCost: 0.02,
			run: [['1', 'delegate', 'finished', 'Opus', true, 0.02, 'Done.']],
		});
	});

	test('an idle Auto chat writes one line to the local Auto log, rewritten as it goes on (issue 849)', async () => {
		const { agent, decisions } = create();
		const session = agent.createSession();
		await agent.submit(session.id, 'Why does this test fail?', '/repo');
		await until(() => decisions().some(line => line.kind === 'autoTask'));
		leaveOpus(agent, session.id);
		await agent.submit(session.id, FIX, '/repo');
		await until(() => decisions().some(line => line.kind === 'autoTask' && line.approach === 'delegated'));
		const logged = decisions().filter(line => line.kind === 'autoTask');
		assert.deepStrictEqual(logged.map(line => [line.sessionId === session.id, line.approach, line.turns, line.models, line.failures, line.stalls]), [
			[true, 'delegated', 2, ['Opus'], 0, 0],
		]);
	});

	test('Stop on a card stops everything under it, pauses the chat and asks once; No offers Rerun and never reruns by itself', async () => {
		const { agent, delegation, begins } = create('opus,sonnet');
		const session = agent.createSession();
		await agent.submit(session.id, 'Why does this test fail?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		leaveOpus(agent, session.id);
		await agent.submit(session.id, FIX, '/repo');
		await until(() => cards(agent, session.id).length === 1);
		const top = cards(agent, session.id)[0];
		const nested = delegation.delegate({ parentSessionId: top.childSessionId, task: 'Look up readToken', model: 'sonnet', auto: false });
		await until(() => cards(agent, session.id)[0].children.length === 1);
		await delegation.stop(top.id);
		const paused = { question: delegation.getQuestion(session.id)?.modelLabel, turn: agent.getViewState(session.id).turns[1].status, card: shape(cards(agent, session.id)[0]) };
		delegation.answer(session.id, false);
		await until(() => agent.getViewState(session.id).turns[1].status === 'stopped');
		const answered = { question: delegation.getQuestion(session.id), auto: !!agent.getAutoModel(session.id), card: shape(cards(agent, session.id)[0]), nested: (await nested).kind, begins: begins.length };
		await delegation.rerun(top.id);
		await until(() => agent.getViewState(session.id).turns.length === 3);
		assert.deepStrictEqual({ paused, answered, rerun: [agent.getViewState(session.id).turns[2].user.text, cards(agent, session.id)[0].rerun] }, {
			paused: {
				question: 'Haiku',
				turn: 'running',
				card: { model: 'Opus', state: 'stopped', stoppedByUser: true, rerun: false, children: [{ model: 'Sonnet', state: 'stopped', stoppedByUser: true, rerun: false, children: [] }] },
			},
			answered: {
				question: undefined,
				auto: true,
				card: { model: 'Opus', state: 'stopped', stoppedByUser: true, rerun: true, children: [{ model: 'Sonnet', state: 'stopped', stoppedByUser: true, rerun: false, children: [] }] },
				nested: 'stopped',
				begins: 3,
			},
			rerun: [FIX, false],
		});
		await agent.stop(session.id);
	});

	test('delegation nests two levels: manager, coordinator, helper; a helper cannot delegate (issue 1009)', async () => {
		const { agent, delegation } = create('opus');
		const session = agent.createSession();
		await agent.submit(session.id, 'Why does this test fail?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		leaveOpus(agent, session.id);
		await agent.submit(session.id, FIX, '/repo');
		await until(() => cards(agent, session.id).length === 1);
		const coordinator = cards(agent, session.id)[0];
		const helper = delegation.delegate({ parentSessionId: coordinator.childSessionId, task: 'Look up readToken', model: 'sonnet', auto: false });
		await until(() => cards(agent, session.id)[0].children.length === 1);
		const tooDeep = await delegation.delegate({ parentSessionId: cards(agent, session.id)[0].children[0].childSessionId, task: 'Look up writeToken', model: 'sonnet', auto: false });
		await delegation.stop(coordinator.id);
		await helper;
		assert.deepStrictEqual(tooDeep, { kind: 'failed', message: 'Delegated chats nest at most 2 levels deep. Give a reason to go deeper, up to 4.' });
		await agent.stop(session.id);
	});

	test('Retry on Opus sends the stopped task again on Opus for that turn only (issue 1220)', async () => {
		const { agent, delegation, switched } = create('opus');
		const session = agent.createSession();
		await agent.submit(session.id, 'Why does this test fail?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		leaveOpus(agent, session.id);
		await agent.submit(session.id, FIX, '/repo');
		await until(() => cards(agent, session.id).length === 1);
		const top = cards(agent, session.id)[0];
		const before = await delegation.rerun(top.id, { modelId: 'opus' });
		await delegation.stop(top.id);
		delegation.answer(session.id, false);
		await until(() => agent.getViewState(session.id).turns[1].status === 'stopped');
		const rerun = await delegation.rerun(top.id, { modelId: 'opus' });
		await until(() => agent.getViewState(session.id).turns.length === 3);
		assert.deepStrictEqual({ before, rerun, text: agent.getViewState(session.id).turns[2].user.text, switched }, { before: false, rerun: true, text: FIX, switched: [] });
		await agent.stop(session.id);
	});

	test('Yes switches the chat from Auto to its own model, and nothing is delegated after', async () => {
		const { agent, delegation, begins, switched } = create('opus');
		const session = agent.createSession();
		await agent.submit(session.id, 'Why does this test fail?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		leaveOpus(agent, session.id);
		await agent.submit(session.id, FIX, '/repo');
		await until(() => cards(agent, session.id).length === 1);
		await delegation.stop(cards(agent, session.id)[0].id);
		delegation.answer(session.id, true);
		await until(() => agent.getViewState(session.id).turns[1].status === 'stopped');
		await agent.submit(session.id, FIX, '/repo');
		await until(() => agent.getViewState(session.id).turns[2]?.status === 'complete');
		const refused = await delegation.delegate({ parentSessionId: session.id, task: 'x', auto: false });
		assert.deepStrictEqual({ auto: agent.getAutoModel(session.id), begins, switched, cards: cards(agent, session.id).length, refused: refused.kind, model: agent.getSessions().find(candidate => candidate.id === session.id)?.modelId }, {
			auto: undefined,
			begins: ['opus', 'opus'],
			switched: ['haiku'],
			cards: 1,
			refused: 'failed',
			model: 'haiku',
		});
	});

	async function delegateFrom(agent: ClaudeAgentService, delegation: ClaudeDelegationService, request: Partial<Parameters<ClaudeDelegationService['delegate']>[0]>) {
		const session = agent.createSession();
		await agent.submit(session.id, 'Why does this test fail?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		const result = await delegation.delegate({ parentSessionId: session.id, task: 'Do it', model: 'sonnet', auto: false, ...request });
		return { session, result };
	}

	test('the helper gets the attachments the delegating message was sent with (issue 1406)', async () => {
		const { agent, delegation } = create();
		const session = agent.createSession();
		const chip = { kind: 'file' as const, uri: 'file:///repo/src/token.ts' };
		agent.setAttachments(session.id, [chip]);
		await agent.submit(session.id, 'Why does this test fail?', '/repo', { attachments: [chip] });
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		const submitted: { sessionId: string; attachments: unknown }[] = [];
		const submit = agent.submit.bind(agent);
		agent.submit = (sessionId, text, cwd, options) => {
			submitted.push({ sessionId, attachments: options?.attachments });
			return submit(sessionId, text, cwd, options);
		};
		await delegation.delegate({ parentSessionId: session.id, task: 'Do it', model: 'sonnet', auto: false });
		assert.deepStrictEqual(submitted.map(entry => entry.attachments), [[chip]]);
	});

	test('a worker with a contract reports in at most 300 words', async () => {
		const { agent, delegation, registry } = create(undefined, 'long-report');
		const { session, result } = await delegateFrom(agent, delegation, { objective: 'Fix it', acceptance: 'The test passes' });
		const card = cards(agent, session.id)[0];
		const words = (text: string | undefined) => (text ?? '').split(/\s+/).length;
		assert.deepStrictEqual({ kind: result.kind, words: words(card.report), cardResult: card.result === card.report, objective: card.objective, acceptance: card.acceptance, run: registry.all()[0].objective }, { kind: 'done', words: 300, cardResult: true, objective: 'Fix it', acceptance: 'The test passes', run: 'Fix it' });
		assert.ok(card.report?.endsWith('…'));
	});

	test('a worker that ends with [[quiet]] has nothing to report', async () => {
		const { agent, delegation } = create(undefined, 'quiet-report');
		const { session, result } = await delegateFrom(agent, delegation, { objective: 'Check it' });
		const card = cards(agent, session.id)[0];
		assert.deepStrictEqual({ kind: result.kind, quiet: card.quiet, report: card.report }, { kind: 'done', quiet: true, report: '' });
	});

	test('a worker at 100% of its budget is stopped and reports it', async () => {
		const { agent, delegation } = create(undefined, 'spending');
		const { session, result } = await delegateFrom(agent, delegation, { objective: 'Spend', budget: { usd: 0.02 } });
		const card = cards(agent, session.id)[0];
		assert.deepStrictEqual({ kind: result.kind, state: card.budgetState }, { kind: 'failed', state: 'stop' });
	});

	test('a worker that fails 4 calls in a row moves up a tier, and the move shows on its card, the registry and the decision log', async () => {
		const { agent, delegation, registry, decisions } = create(undefined, 'failing');
		const session = agent.createSession();
		await agent.submit(session.id, 'Why does this test fail?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		void delegation.delegate({ parentSessionId: session.id, task: 'Do it', tier: 'small', auto: false });
		await until(() => (cards(agent, session.id)[0]?.escalations?.length ?? 0) === 1);
		const card = cards(agent, session.id)[0];
		const run = registry.all()[0];
		const logged = decisions().filter(line => line.kind === 'escalation');
		assert.deepStrictEqual({
			card: [card.tier, card.modelLabel, card.escalations?.map(e => [e.from, e.to, e.cause, e.count])],
			run: [run.tier, run.model, run.stateDetail],
			logged: logged.map(line => [line.from, line.to, line.cause, line.count]),
		}, {
			card: ['medium', 'Sonnet', [['Haiku', 'Sonnet', 'failed-calls', 4]]],
			run: ['medium', 'Sonnet', 'Moved up from Haiku to Sonnet after 4 failed calls in a row.'],
			logged: [['Haiku', 'Sonnet', 'failed-calls', 4]],
		});
	});

	test('a finished run writes its tokens into its decision, and the card shows why it was routed (issue 987)', async () => {
		const { agent, delegation, decisions } = create(undefined, 'token-usage');
		const { session, result } = await delegateFrom(agent, delegation, { model: undefined, tier: 'medium', reason: 'writes code from a stated cause' });
		const card = cards(agent, session.id)[0];
		await until(() => decisions().some(line => line.kind === undefined && line.tokens !== undefined));
		const decision = decisions().find(line => line.kind === undefined);
		assert.deepStrictEqual({
			kind: result.kind,
			card: [card.routeReason, card.routeWhy],
			decision: [decision?.runId === card.id, decision?.tokens],
		}, {
			kind: 'done',
			card: ['writes code from a stated cause', 'tier and reason given'],
			decision: [true, { input: 1200, output: 340, cacheRead: 5000, cacheWrite: 800 }],
		});
	});

	test('Auto routes a delegated task through routeAutoStep when it names no tier or model (issue 1230)', async () => {
		const { agent, delegation } = create();
		const { session, result } = await delegateFrom(agent, delegation, { model: undefined });
		const card = cards(agent, session.id)[0];
		assert.deepStrictEqual([result.kind, card.routeWhy?.startsWith('Auto: '), card.tier !== undefined], ['done', true, true]);
	});

	test('with Auto off a delegated task keeps the classic route', async () => {
		const { agent, delegation } = create(undefined, undefined, { 'claude.auto.enabled': false });
		const { session } = await delegateFrom(agent, delegation, { model: undefined });
		assert.strictEqual(cards(agent, session.id)[0].routeWhy?.startsWith('Auto: '), false);
	});

	test('Auto reuses a finished helper of the same tier after compacting it (issue 1230)', async () => {
		const { agent, delegation, sends } = create();
		const { session } = await delegateFrom(agent, delegation, { model: undefined, tier: 'medium', reason: 'writes code from a stated cause' });
		await delegation.delegate({ parentSessionId: session.id, task: 'Do the next part', tier: 'medium', reason: 'writes code from a stated cause', auto: false });
		const [first, second] = cards(agent, session.id);
		assert.deepStrictEqual([second.childSessionId === first.childSessionId, sends.includes('/compact')], [true, true]);
	});

	test('the third rework with a cap of 2 is refused with the open points (issue 1219)', async () => {
		const { agent, delegation } = create(undefined, undefined, { 'claude.auto.review.maxRounds': 2 });
		const { session } = await delegateFrom(agent, delegation, { task: 'Fix the review points', model: undefined, tier: 'medium', reason: 'writes code from a stated cause' });
		// The scripted agent answers /compact asynchronously: wait for it before the task, as the real one does.
		const submit = agent.submit.bind(agent);
		agent.submit = async (id, ...rest) => {
			await until(() => agent.getViewState(id).turns.every(turn => turn.status !== 'running'));
			return submit(id, ...rest);
		};
		const messages: string[] = [];
		for (let round = 1; round <= 3; round++) {
			await until(() => agent.getSessions().every(chat => agent.getViewState(chat.id).turns.every(turn => turn.status !== 'running')));
			const more = await delegation.delegate({ parentSessionId: session.id, task: 'Fix the review points', tier: 'medium', reason: 'writes code from a stated cause', auto: false });
			messages.push(more.kind === 'failed' ? more.message : more.kind);
		}
		assert.deepStrictEqual(messages.map(message => message.includes('2 times')), [false, false, true]);
		assert.strictEqual(cards(agent, session.id).length, 3);
	});

	test('reusing a helper for different tasks is not a rework and is never capped (issue 1219)', async () => {
		const { agent, delegation } = create(undefined, undefined, { 'claude.auto.review.maxRounds': 2 });
		const { session } = await delegateFrom(agent, delegation, { model: undefined, tier: 'medium', reason: 'writes code from a stated cause' });
		const submit = agent.submit.bind(agent);
		agent.submit = async (id, ...rest) => {
			await until(() => agent.getViewState(id).turns.every(turn => turn.status !== 'running'));
			return submit(id, ...rest);
		};
		const kinds: string[] = [];
		for (let step = 1; step <= 3; step++) {
			await until(() => agent.getSessions().every(chat => agent.getViewState(chat.id).turns.every(turn => turn.status !== 'running')));
			const next = await delegation.delegate({ parentSessionId: session.id, task: `Another job ${step}`, tier: 'medium', reason: 'writes code from a stated cause', auto: false });
			kinds.push(next.kind);
		}
		assert.deepStrictEqual(kinds, ['done', 'done', 'done']);
	});

	test('claude.auto.reuseHelpers off starts a new helper each time (issue 1230)', async () => {
		const { agent, delegation, sends } = create(undefined, undefined, { 'claude.auto.reuseHelpers': false });
		const { session } = await delegateFrom(agent, delegation, { model: undefined, tier: 'medium', reason: 'writes code from a stated cause' });
		await delegation.delegate({ parentSessionId: session.id, task: 'Do the next part', tier: 'medium', reason: 'writes code from a stated cause', auto: false });
		const [first, second] = cards(agent, session.id);
		assert.deepStrictEqual([second.childSessionId === first.childSessionId, sends.includes('/compact')], [false, false]);
	});

	test('a chat on Auto that fails 3 calls in a row goes back to the model it started on, once, and the turn says so (issue 1009)', async () => {
		// No delegation service, so Auto switches the model inside the chat.
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), { models: AUTO_MODELS }));
		const switched: string[] = [];
		const setModel = runtime.setModel.bind(runtime);
		runtime.setModel = async (sessionId, modelId) => {
			switched.push(modelId);
			return setModel(sessionId, modelId);
		};
		const send = runtime.send.bind(runtime);
		runtime.send = async (sessionId, input) => send(sessionId, { ...input, fixture: 'failing' });
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs({ configuration: new TestConfigurationService({ [CLAUDE_MODELS_AUTO_SETTING]: 'balance' }) })));
		const session = agent.createSession();
		await agent.submit(session.id, 'Why does this test fail?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		leaveOpus(agent, session.id);
		await agent.submit(session.id, FIX, '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.fallback !== undefined);
		await new Promise(resolve => setTimeout(resolve, 50));
		const fallback = agent.getViewState(session.id).turns[1].fallback;
		assert.deepStrictEqual({
			switched,
			fallback: fallback && [fallback.from !== fallback.to, fallback.to, fallback.cause, fallback.count],
			sentence: fallback && claudeFallbackSentence(fallback),
		}, {
			switched: ['haiku'],
			fallback: [true, 'Haiku', 'failed-calls', 3],
			sentence: 'Went back to your model, Haiku, after 3 failed calls in a row.',
		});
	});

	test('a worker with the ladder off stays on its tier', async () => {
		const { agent, delegation } = create(undefined, 'failing', { 'klawly.delegation.ladder.workerFailedCalls': 0 });
		const session = agent.createSession();
		await agent.submit(session.id, 'Why does this test fail?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		void delegation.delegate({ parentSessionId: session.id, task: 'Do it', tier: 'small', auto: false });
		await until(() => cards(agent, session.id)[0] !== undefined && agent.getViewState(cards(agent, session.id)[0].childSessionId).turns[0]?.cards.length === 4);
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.deepStrictEqual([cards(agent, session.id)[0].tier, cards(agent, session.id)[0].escalations], ['small', undefined]);
	});

	test('the chat\'s own Stop stops its delegated chats without a question', async () => {
		const { agent, delegation } = create('opus');
		const session = agent.createSession();
		await agent.submit(session.id, 'Why does this test fail?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		leaveOpus(agent, session.id);
		await agent.submit(session.id, FIX, '/repo');
		await until(() => cards(agent, session.id).length === 1);
		await agent.stop(session.id);
		await until(() => cards(agent, session.id)[0].state !== 'running');
		assert.deepStrictEqual([delegation.getQuestion(session.id), cards(agent, session.id)[0].state, agent.getViewState(session.id).turns[1].status], [undefined, 'stopped', 'stopped']);
	});

	/** A parent whose turn ends while two slower helpers still run (issue 1238). */
	async function parentWithRunningHelpers() {
		const made = create(undefined, 'slow-report');
		made.runtime.stepDelayMs = 40;
		const session = made.agent.createSession();
		void made.agent.submit(session.id, 'Why does this test fail?', '/repo');
		await until(() => made.begins.length === 1);
		const answers = ['First part', 'Second part'].map(task => made.delegation.delegate({ parentSessionId: session.id, task, model: 'sonnet', auto: false }));
		await until(() => made.agent.getViewState(session.id).turns[0]?.status === 'complete');
		return { ...made, session, answers, before: made.sends.length };
	}

	test('an idle parent gets exactly one follow-up turn holding every finished report (issue 1238)', async () => {
		const { agent, session, answers } = await parentWithRunningHelpers();
		await Promise.all(answers);
		await until(() => agent.getViewState(session.id).turns.length === 2);
		await new Promise(resolve => setTimeout(resolve, 800));
		const followUps = agent.getViewState(session.id).turns.map(turn => turn.user.text).filter(text => text.startsWith(claudeDelegateFollowUpText([])));
		assert.deepStrictEqual([followUps.length, followUps[0].split('\n').length - 1, agent.getViewState(session.id).turns.length], [1, 2, 2]);
	});

	test('no follow-up turn is sent after the user stopped the chat (issue 1238)', async () => {
		const { agent, sends, session, answers, before } = await parentWithRunningHelpers();
		await agent.stop(session.id);
		await Promise.all(answers);
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.deepStrictEqual([sends.slice(before).filter(text => text.startsWith(claudeDelegateFollowUpText([]))).length, agent.getViewState(session.id).turns.length], [0, 1]);
	});

	test('claudeDescendants lists nested helpers once each (issue 1240)', () => {
		const nodes = [
			{ sessionId: 'child', parentSessionId: 'root' },
			{ sessionId: 'grandchild', parentSessionId: 'child' },
			{ sessionId: 'loop', parentSessionId: 'grandchild' },
			{ sessionId: 'root', parentSessionId: 'loop' },
		];
		assert.deepStrictEqual(claudeDescendants('root', nodes), ['child', 'grandchild', 'loop']);
	});

	/** A manager chat whose helper keeps working until it is stopped. */
	async function managerWithHelper(worktrees?: IClaudeWorktreeService) {
		const ctx = create('opus,sonnet', undefined, {}, worktrees);
		const session = ctx.agent.createSession();
		await ctx.agent.submit(session.id, 'Why does this test fail?', '/repo');
		await until(() => ctx.agent.getViewState(session.id).turns[0]?.status === 'complete');
		leaveOpus(ctx.agent, session.id);
		await ctx.agent.submit(session.id, FIX, '/repo');
		await until(() => cards(ctx.agent, session.id).length === 1);
		const top = cards(ctx.agent, session.id)[0];
		const stops: string[] = [];
		const stop = ctx.agent.stop.bind(ctx.agent);
		ctx.agent.stop = async (sessionId: string) => {
			stops.push(sessionId);
			return stop(sessionId);
		};
		return { ...ctx, session, top, stops };
	}

	test('messageHelper finds a helper by card id or title and sends it the text; an unknown helper fails (issue 1380)', async () => {
		const { agent, delegation, session, top } = await managerWithHelper();
		const byId = await delegation.messageHelper(session.id, top.id, 'Also rename the tests.');
		const byTitle = await delegation.messageHelper(session.id, top.title.toUpperCase(), 'And the docs.');
		const unknown = await delegation.messageHelper(session.id, 'nobody', 'hi');
		assert.deepStrictEqual({ byId, byTitle: byTitle.kind, unknown: unknown.kind, queued: agent.getPending(top.childSessionId).map(input => input.text), cards: cards(agent, session.id).length }, {
			byId: { kind: 'messaged', helper: top.title },
			byTitle: 'messaged',
			unknown: 'failed',
			queued: ['Also rename the tests.', 'And the docs.'],
			cards: 1,
		});
	});

	test('stopping the root stops each helper once, nested ones too (issue 1240)', async () => {
		const { agent, delegation, session, top, stops } = await managerWithHelper();
		const nested = delegation.delegate({ parentSessionId: top.childSessionId, task: 'Look up readToken', model: 'sonnet', auto: false });
		await until(() => cards(agent, session.id)[0].children.length === 1);
		const grandchild = cards(agent, session.id)[0].children[0].childSessionId;
		await agent.stop(session.id);
		await nested;
		await until(() => cards(agent, session.id)[0].state === 'stopped');
		assert.deepStrictEqual([stops.filter(id => id === top.childSessionId).length, stops.filter(id => id === grandchild).length], [1, 1]);
	});

	test('a helper in a dirty worktree gets a WIP commit before it stops, and the parent is not woken (issue 1240)', async () => {
		const events: string[] = [];
		const worktrees = { wipCommit: async (folder: string) => { events.push(`wip ${folder}`); return true; } } as unknown as IClaudeWorktreeService;
		const { agent, session, top, stops, sends } = await managerWithHelper(worktrees);
		const getSessions = agent.getSessions.bind(agent);
		agent.getSessions = () => getSessions().map(item => item.id === session.id ? { ...item, worktreePath: '/repo/.worktrees/a' } : item);
		const before = sends.length;
		const stop = agent.stop.bind(agent);
		agent.stop = async (sessionId: string) => {
			if (sessionId === top.childSessionId) {
				events.push('stop');
			}
			return stop(sessionId);
		};
		await agent.stop(session.id);
		await until(() => cards(agent, session.id)[0].state === 'stopped');
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.deepStrictEqual([events, stops.includes(top.childSessionId), sends.length - before], [['wip /repo/.worktrees/a', 'stop'], true, 0]);
	});

	/** The last segment of a path, on either separator. */
	function leaf(path: string): string {
		return path.split(/[\\/]/).pop() ?? '';
	}

	/** A worktree service that records what it is asked, for a repository at `/repo`. */
	function recordingWorktrees(events: string[], changed = false): IClaudeWorktreeService {
		return {
			head: async () => 'base1',
			add: async (_repo: string, path: string, branch: string, base: string) => { events.push(`add ${leaf(path)} ${branch.includes('helper-') ? 'branch' : branch} ${base}`); },
			hasChanges: async () => changed,
			remove: async (_repo: string, path: string) => { events.push(`remove ${leaf(path)}`); },
			wipCommit: async () => true,
		} as unknown as IClaudeWorktreeService;
	}

	async function ownFilesHelpers(settings: Record<string, unknown>, events: string[], changed = false) {
		const ctx = create('opus', undefined, settings, recordingWorktrees(events, changed));
		const pinned: string[] = [];
		const pin = ctx.agent.pinWorkingDirectory.bind(ctx.agent);
		ctx.agent.pinWorkingDirectory = (id: string, cwd: string) => { pinned.push(leaf(cwd)); pin(id, cwd); };
		const session = ctx.agent.createSession();
		await ctx.agent.submit(session.id, 'Why does this test fail?', '/repo');
		await until(() => ctx.agent.getViewState(session.id).turns[0]?.status === 'complete');
		const first = ctx.delegation.delegate({ parentSessionId: session.id, task: 'Fix a', model: 'opus', auto: false, files: ['src/a.ts'] });
		const second = ctx.delegation.delegate({ parentSessionId: session.id, task: 'Fix b', model: 'opus', auto: false, files: ['src/a.ts'] });
		return { ...ctx, session, pinned, first, second };
	}

	test('a coding helper works in its own worktree, so overlapping files do not queue it (issue 1397)', async () => {
		const events: string[] = [];
		const { agent, session, pinned } = await ownFilesHelpers({}, events);
		await until(() => cards(agent, session.id).length === 2 && pinned.length === 2);
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.deepStrictEqual([events.filter(event => event.startsWith('add')).length, pinned.every(name => name.startsWith('helper-')), cards(agent, session.id).map(card => card.state)], [2, true, ['running', 'running']]);
	});

	test('a helper without files, or with the setting off, shares the workspace and queues on overlap (issue 1397)', async () => {
		const events: string[] = [];
		const { agent, session, registry } = await ownFilesHelpers({ 'klawly.delegation.helperWorktrees': false }, events);
		await until(() => cards(agent, session.id).length === 2);
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.deepStrictEqual([events, registry.all().map(run => run.state).sort()], [[], ['queued', 'working']]);
	});

	test('a helper worktree with no changes is removed when the helper stops; one with changes stays (issue 1397)', async () => {
		for (const changed of [false, true]) {
			const events: string[] = [];
			const { agent, session, pinned } = await ownFilesHelpers({}, events, changed);
			await until(() => cards(agent, session.id).length === 2 && pinned.length === 2);
			await agent.stop(session.id);
			await until(() => cards(agent, session.id).every(card => card.state === 'stopped'));
			await new Promise(resolve => setTimeout(resolve, 50));
			assert.deepStrictEqual(events.filter(event => event.startsWith('remove')).length, changed ? 0 : 2);
		}
	});
});

const AUTO_MODELS: readonly ClaudeModelInfo[] = [
	{ id: 'opus', displayName: 'Opus', source: 'runtime', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
	{ id: 'sonnet', displayName: 'Sonnet', source: 'runtime', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
	{ id: 'haiku', displayName: 'Haiku', source: 'runtime', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
];

function fixtures(): Map<string, string> {
	return new Map([
		['plain-answer', [
			'{"type":"session.started","sessionId":"$session"}',
			'{"type":"usage.changed","sessionId":"$session","usage":{"costUsd":0.02}}',
			'{"type":"assistant.completed","sessionId":"$session","text":"Done."}',
			'{"type":"session.completed","sessionId":"$session"}',
		].join('\n')],
		['token-usage', [
			'{"type":"session.started","sessionId":"$session"}',
			'{"type":"usage.changed","sessionId":"$session","usage":{"inputTokens":1200,"outputTokens":340,"cacheReadTokens":5000,"cacheWriteTokens":800,"costUsd":0.03}}',
			'{"type":"assistant.completed","sessionId":"$session","text":"Done."}',
			'{"type":"session.completed","sessionId":"$session"}',
		].join('\n')],
		['long-report', [
			'{"type":"session.started","sessionId":"$session"}',
			'{"type":"assistant.completed","sessionId":"$session","text":"' + Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ') + '"}',
			'{"type":"session.completed","sessionId":"$session"}',
		].join('\n')],
		['quiet-report', [
			'{"type":"session.started","sessionId":"$session"}',
			'{"type":"assistant.completed","sessionId":"$session","text":"[[quiet]]"}',
			'{"type":"session.completed","sessionId":"$session"}',
		].join('\n')],
		['spending', [
			'{"type":"session.started","sessionId":"$session"}',
			'{"type":"usage.changed","sessionId":"$session","usage":{"costUsd":0.021}}',
			'{"type":"assistant.delta","sessionId":"$session","text":"Working"}',
		].join('\n')],
		['failing', [
			'{"type":"session.started","sessionId":"$session"}',
			...[1, 2, 3, 4].flatMap(n => [
				`{"type":"tool.started","sessionId":"$session","call":{"id":"call-${n}","name":"Bash","category":"command","input":{"command":"npm test"},"display":{"label":"npm test"}}}`,
				`{"type":"tool.completed","sessionId":"$session","callId":"call-${n}","result":{"ok":false,"error":"exit 1"}}`,
			]),
			'{"type":"assistant.delta","sessionId":"$session","text":"Retrying"}',
		].join('\n')],
		['slow-report', [
			'{"type":"session.started","sessionId":"$session"}',
			...Array.from({ length: 12 }, () => '{"type":"assistant.delta","sessionId":"$session","text":"Looking"}'),
			'{"type":"assistant.completed","sessionId":"$session","text":"Found it."}',
			'{"type":"session.completed","sessionId":"$session"}',
		].join('\n')],
		['working', [
			'{"type":"session.started","sessionId":"$session"}',
			'{"type":"assistant.delta","sessionId":"$session","text":"Looking"}',
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
	for (let i = 0; i < 200; i++) {
		if (read()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.fail('timed out waiting');
}
