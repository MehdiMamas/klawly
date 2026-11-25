/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BeginClaudeRequest, ClaudeRunHandle, ClaudeUserInput } from '../../../../../platform/claude/common/claude.js';
import { FakeClaudeRuntimeService } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { IOutputService } from '../../../output/common/output.js';
import { agentWorkspaceStubs } from './claudeAgentTestUtils.js';
import { ClaudeAgentService, ClaudeTurnBusyError, shouldRequeuePending } from '../../common/claudeAgentService.js';

suite('Claude agent queue', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('queue holds follow-ups until the turn ends and then sends them in order', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), { stepDelayMs: 15 }));
		const prompts: string[] = [];
		const originalBegin = runtime.begin.bind(runtime);
		const originalSend = runtime.send.bind(runtime);
		runtime.begin = async (request: BeginClaudeRequest): Promise<ClaudeRunHandle> => {
			prompts.push(request.prompt);
			return originalBegin(request);
		};
		runtime.send = async (sessionId: string, input: ClaudeUserInput) => {
			prompts.push(input.text);
			await originalSend(sessionId, input);
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		const pending = agent.submit(session.id, 'Look', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'running');

		const first = await agent.queue(session.id, 'first follow-up', '/repo', 'queue', { compiled: 'FIRST' });
		const second = await agent.queue(session.id, 'second follow-up', '/repo', 'queue', { compiled: 'SECOND' });
		assert.strictEqual(first.behavior, 'queue');
		assert.strictEqual(second.behavior, 'queue');
		assert.deepStrictEqual(agent.getPending(session.id).map(item => item.text), ['first follow-up', 'second follow-up']);
		assert.strictEqual(agent.getViewState(session.id).turns.length, 1);
		assert.strictEqual(await agent.supportsSteer(session.id), false);

		agent.updatePending(session.id, first.id, 'edited follow-up', 'EDITED');
		agent.removePending(session.id, second.id);
		assert.deepStrictEqual(agent.getPending(session.id).map(item => item.text), ['edited follow-up']);

		await pending;
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		assert.strictEqual(agent.getViewState(session.id).turns[1].user.text, 'edited follow-up');
		assert.deepStrictEqual(prompts, ['Look', 'EDITED']);
		assert.strictEqual(agent.getPending(session.id).length, 0);
	});

	test('steer delivers into the running turn and does not open another one', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), { stepDelayMs: 30 }));
		const steered: string[] = [];
		runtime.canSteer = async () => true;
		runtime.steer = async (_sessionId: string, text: string) => {
			steered.push(text);
			return true;
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		const pending = agent.submit(session.id, 'Look', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'running' && agent.getRuntimeSessionId(session.id) !== undefined);
		assert.strictEqual(await agent.supportsSteer(session.id), true);

		const item = await agent.queue(session.id, 'Use the helper', '/repo', 'steer', { compiled: 'STEER' });
		assert.strictEqual(item.behavior, 'steer');
		assert.deepStrictEqual(steered, ['STEER']);
		assert.strictEqual(agent.getPending(session.id).length, 0);
		assert.strictEqual(agent.getViewState(session.id).turns.length, 1);
		assert.strictEqual(agent.getViewState(session.id).turns[0].status, 'running');
		assert.strictEqual(agent.getCurrentSession()?.draft, '');

		await agent.stop(session.id);
		await pending;
	});

	test('a reminder reaches the runtime without adding a chat turn or pending message', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), { stepDelayMs: 30 }));
		const steered: string[] = [];
		runtime.steer = async (_sessionId: string, text: string) => {
			steered.push(text);
			return true;
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		assert.strictEqual(await agent.remind(session.id, 'idle'), false);
		const pending = agent.submit(session.id, 'Look', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'running' && agent.getRuntimeSessionId(session.id) !== undefined);

		assert.strictEqual(await agent.remind(session.id, 'Consider delegating'), true);
		assert.deepStrictEqual({ steered, pending: agent.getPending(session.id).length, turns: agent.getViewState(session.id).turns.length }, { steered: ['Consider delegating'], pending: 0, turns: 1 });

		await agent.stop(session.id);
		await pending;
	});

	test('steer is refused when the runtime cannot take another message', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), { stepDelayMs: 30 }));
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		const pending = agent.submit(session.id, 'Look', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'running');
		await assert.rejects(() => agent.queue(session.id, 'now', '/repo', 'steer'), /Steer now is not available/);
		assert.strictEqual(agent.getPending(session.id).length, 0);
		assert.strictEqual(agent.getViewState(session.id).turns.length, 1);
		await agent.stop(session.id);
		await pending;
	});

	test('Enter again on a queued message interrupts the turn once and then sends it once', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), { stepDelayMs: 30 }));
		const calls: string[] = [];
		const originalBegin = runtime.begin.bind(runtime);
		const originalInterrupt = runtime.interrupt.bind(runtime);
		runtime.begin = async (request: BeginClaudeRequest): Promise<ClaudeRunHandle> => {
			calls.push(`begin:${request.prompt}`);
			return originalBegin(request);
		};
		runtime.interrupt = async (sessionId: string) => {
			calls.push('interrupt');
			await originalInterrupt(sessionId);
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		const pending = agent.submit(session.id, 'Look', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'running' && agent.getRuntimeSessionId(session.id) !== undefined);
		await agent.queue(session.id, 'now please', '/repo', 'queue', { compiled: 'NOW' });

		assert.strictEqual(await agent.sendQueuedNow(session.id), true);
		assert.strictEqual(await agent.sendQueuedNow(session.id), false);
		await pending;
		assert.deepStrictEqual(calls.filter(call => call === 'interrupt' || call.startsWith('begin:')).slice(0, 3).map(call => call.startsWith('begin:') && call !== 'begin:NOW' ? 'begin' : call), ['begin', 'interrupt', 'begin:NOW']);
		assert.strictEqual(calls.filter(call => call === 'begin:NOW').length, 1);
		assert.strictEqual(agent.getPending(session.id).length, 0);
		await until(() => !agent.getViewState(session.id).turns.some(turn => turn.status === 'running'));
	});

	test('a draft and chips typed during a queued follow-up survive the flush', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), { stepDelayMs: 15 }));
		const sent: { text: string; attachments: unknown }[] = [];
		const originalSend = runtime.send.bind(runtime);
		runtime.send = async (sessionId: string, input: ClaudeUserInput) => {
			sent.push({ text: input.text, attachments: input.attachments });
			await originalSend(sessionId, input);
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		const pending = agent.submit(session.id, 'Look', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'running');
		const queuedChip = { kind: 'file' as const, uri: 'file:///repo/queued.ts' };
		const draftChip = { kind: 'file' as const, uri: 'file:///repo/draft.ts' };
		await agent.queue(session.id, 'follow-up', '/repo', 'queue', { compiled: 'QUEUED queued.ts', attachments: [queuedChip] });
		agent.setDraft(session.id, 'still typing');
		agent.setAttachments(session.id, [draftChip]);

		await pending;
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		assert.strictEqual(agent.getCurrentSession()?.draft, 'still typing');
		assert.deepStrictEqual(agent.getCurrentSession()?.attachments, [draftChip]);
		assert.deepStrictEqual(sent, [{ text: 'QUEUED queued.ts', attachments: [queuedChip] }]);
		assert.strictEqual(agent.getPending(session.id).length, 0);
	});

	test('an edited queued item keeps its attachments, and a missing item is reported', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), { stepDelayMs: 20 }));
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		const pending = agent.submit(session.id, 'Look', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'running');
		const chip = { kind: 'file' as const, uri: 'file:///repo/src/app.ts' };
		const item = await agent.queue(session.id, 'with the file', '/repo', 'queue', { attachments: [chip], compiled: 'FILE' });
		assert.strictEqual(agent.updatePending(session.id, item.id, 'edited with the file', 'EDITED FILE'), true);
		assert.strictEqual(agent.getPending(session.id)[0].text, 'edited with the file');
		assert.deepStrictEqual(agent.getPending(session.id)[0].attachments, [chip]);
		agent.removePending(session.id, item.id);
		assert.strictEqual(agent.updatePending(session.id, item.id, 'too late'), false);
		await agent.stop(session.id);
		await pending;
	});

	test('queued messages stay queued when the turn is stopped or fails', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), { stepDelayMs: 20 }));
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		const pending = agent.submit(session.id, 'Look', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'running');
		await agent.queue(session.id, 'after a stop', '/repo', 'queue');
		await agent.stop(session.id);
		await pending;
		assert.strictEqual(agent.getViewState(session.id).turns[0].status, 'stopped');
		assert.deepStrictEqual(agent.getPending(session.id).map(item => item.text), ['after a stop']);
		assert.strictEqual(agent.getViewState(session.id).turns.length, 1);

		const failing = store.add(new FakeClaudeRuntimeService(crashFixtures(), { stepDelayMs: 15 }));
		const originalBegin = failing.begin.bind(failing);
		failing.begin = request => originalBegin({ ...request, fixture: 'crash' });
		const failedAgent = store.add(new ClaudeAgentService(failing, output(), ...agentWorkspaceStubs()));
		const failedSession = failedAgent.createSession();
		const failedTurn = failedAgent.submit(failedSession.id, 'Look', '/repo');
		await until(() => failedAgent.getViewState(failedSession.id).turns[0]?.status === 'running');
		await failedAgent.queue(failedSession.id, 'after a failure', '/repo', 'queue');
		await failedTurn;
		await until(() => failedAgent.getViewState(failedSession.id).turns[0]?.status === 'failed');
		assert.deepStrictEqual(failedAgent.getPending(failedSession.id).map(item => item.text), ['after a failure']);
		assert.strictEqual(failedAgent.getViewState(failedSession.id).turns.length, 1);
	});

	test('a busy flush is recognized without reading the localized message', () => {
		const busy = new ClaudeTurnBusyError();
		assert.strictEqual(shouldRequeuePending(busy), true);
		assert.strictEqual(shouldRequeuePending(new Error(busy.message)), false);
		assert.strictEqual(shouldRequeuePending(new Error('still answering')), false);
	});

	test('steer is recorded on the running turn', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), { stepDelayMs: 30 }));
		runtime.canSteer = async () => true;
		runtime.steer = async () => true;
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		const pending = agent.submit(session.id, 'Look', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'running' && agent.getRuntimeSessionId(session.id) !== undefined);
		await agent.queue(session.id, 'Use the helper', '/repo', 'steer', { compiled: 'STEER' });
		assert.deepStrictEqual(agent.getViewState(session.id).turns[0].steered, ['Use the helper']);
		await agent.stop(session.id);
		await pending;
		assert.deepStrictEqual(agent.getViewState(session.id).turns[0].steered, ['Use the helper']);
	});

	test('queue sends immediately when nothing is running', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures()));
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await agent.queue(session.id, 'Hello', '/repo', 'queue');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		assert.strictEqual(agent.getViewState(session.id).turns[0].user.text, 'Hello');
		assert.strictEqual(agent.getPending(session.id).length, 0);
	});
});

function fixtures(): Map<string, string> {
	return new Map([
		['plain-answer', [
			'{"type":"session.started","sessionId":"$session"}',
			'{"type":"assistant.delta","sessionId":"$session","text":"working"}',
			'{"type":"assistant.completed","sessionId":"$session","text":"working"}',
			'{"type":"session.completed","sessionId":"$session"}',
		].join('\n')],
	]);
}

function crashFixtures(): Map<string, string> {
	return new Map([
		['crash', [
			'{"type":"session.started","sessionId":"$session"}',
			'{"type":"assistant.delta","sessionId":"$session","text":"partial"}',
			'{"type":"session.failed","sessionId":"$session","message":"process exited","kind":"process-crash"}',
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
