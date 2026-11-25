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
import { ClaudeAgentService } from '../../common/claudeAgentService.js';

suite('Claude agent submit', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('streams a turn and keeps the runtime for the next message', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures()));
		let begins = 0;
		let sends = 0;
		const originalBegin = runtime.begin.bind(runtime);
		const originalSend = runtime.send.bind(runtime);
		runtime.begin = async (request: BeginClaudeRequest): Promise<ClaudeRunHandle> => {
			begins++;
			assert.strictEqual(request.modelId, 'fixture-opus');
			assert.strictEqual(request.cwd, '/repo');
			assert.strictEqual(request.prompt, 'Why?');
			return originalBegin(request);
		};
		runtime.send = async (sessionId: string, input: ClaudeUserInput) => {
			sends++;
			assert.strictEqual(input.text, 'Again');
			await originalSend(sessionId, input);
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await agent.setNextModel(session.id, 'fixture-opus');

		await agent.submit(session.id, '  Why?  ', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		const first = agent.getViewState(session.id).turns[0];
		assert.strictEqual(first.user.text, 'Why?');
		assert.strictEqual(first.assistantText, 'The handler returns early. That skips the check.');
		assert.strictEqual(agent.getCurrentSession()?.draft, '');

		await agent.submit(session.id, 'Again', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		assert.strictEqual(begins, 1);
		assert.strictEqual(sends, 1);
		assert.strictEqual(agent.getViewState(session.id).turns[0].assistantText, first.assistantText);
	});

	test('stop keeps partial text and the next message starts a new runtime session', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), { stepDelayMs: 30 }));
		const interrupts: string[] = [];
		const original = runtime.interrupt.bind(runtime);
		runtime.interrupt = async sessionId => {
			interrupts.push(sessionId);
			await original(sessionId);
		};
		let begins = 0;
		const originalBegin = runtime.begin.bind(runtime);
		runtime.begin = async request => {
			begins++;
			return originalBegin(request);
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();

		const pending = agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.assistantText.includes('early') === true);
		await agent.stop(session.id);
		await pending;
		const stopped = agent.getViewState(session.id).turns[0];
		assert.strictEqual(stopped.status, 'stopped');
		assert.ok(stopped.assistantText.includes('early'));
		assert.strictEqual(stopped.assistantText.includes('skips the check'), false);
		assert.strictEqual(interrupts.length, 1);

		await agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		assert.strictEqual(begins, 2);
		assert.strictEqual(agent.getViewState(session.id).turns[0].status, 'stopped');
	});

	test('a failed turn keeps partial text and retry sends it again', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures()));
		let begins = 0;
		const originalBegin = runtime.begin.bind(runtime);
		runtime.begin = async request => {
			begins++;
			return originalBegin({ ...request, fixture: begins === 1 ? 'crash' : 'plain-answer' });
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'failed');
		const failed = agent.getViewState(session.id).turns[0];
		assert.strictEqual(failed.assistantText, 'Partial answer');
		assert.strictEqual(failed.failure?.kind, 'process-crash');

		await agent.retry(session.id, '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		assert.strictEqual(agent.getViewState(session.id).turns[1].user.text, 'Why?');
		assert.strictEqual(agent.getViewState(session.id).turns[0].assistantText, 'Partial answer');
	});

	test('subagent text is not part of the turn', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures()));
		const originalBegin = runtime.begin.bind(runtime);
		runtime.begin = request => originalBegin({ ...request, fixture: 'hidden' });
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await agent.submit(session.id, 'Look', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		assert.strictEqual(agent.getViewState(session.id).turns[0].assistantText, 'visible');
	});

	test('rejects an empty message, an unknown session, and a second prompt while running', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), { stepDelayMs: 50 }));
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await assert.rejects(() => agent.submit(session.id, '   ', '/repo'), /Write a message first/);
		await assert.rejects(() => agent.submit('missing', 'Hi', '/repo'), /not open/);
		const pending = agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns.length === 1);
		await assert.rejects(() => agent.submit(session.id, 'Again', '/repo'), /still answering/);
		await agent.stop(session.id);
		await pending;
	});

	test('a start failure becomes a failed turn', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures()));
		runtime.begin = async () => {
			throw new Error('Claude is not installed.');
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await agent.submit(session.id, 'Why?', '/repo');
		const turn = agent.getViewState(session.id).turns[0];
		assert.strictEqual(turn.status, 'failed');
		assert.strictEqual(turn.failure?.message, 'Claude is not installed.');
		assert.strictEqual(turn.user.text, 'Why?');
	});

	test('retry leaves the composer draft in place and a follow-up sets the model only when it changed', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures()));
		const models: string[] = [];
		runtime.setModel = async (_sessionId, modelId) => {
			models.push(modelId);
		};
		let begins = 0;
		const originalBegin = runtime.begin.bind(runtime);
		runtime.begin = async request => {
			begins++;
			return originalBegin({ ...request, fixture: begins === 1 ? 'crash' : 'plain-answer' });
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await agent.setNextModel(session.id, 'fixture-opus');
		await agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'failed');
		agent.setDraft(session.id, 'keep this');

		await agent.retry(session.id, '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		assert.strictEqual(agent.getCurrentSession()?.draft, 'keep this');
		assert.deepStrictEqual(models, []);

		await agent.setNextModel(session.id, 'fixture-sonnet');
		await agent.submit(session.id, 'Again', '/repo');
		await until(() => agent.getViewState(session.id).turns[2]?.status === 'complete');
		assert.deepStrictEqual(models, ['fixture-sonnet']);
	});

	test('retry resends the latest failed turn after an earlier stop', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), { stepDelayMs: 30 }));
		const prompts: string[] = [];
		const originalBegin = runtime.begin.bind(runtime);
		runtime.begin = async request => {
			prompts.push(request.prompt);
			const fixture = prompts.length === 2 ? 'crash' : 'plain-answer';
			return originalBegin({ ...request, fixture });
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		const pending = agent.submit(session.id, 'First', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.assistantText.includes('early') === true);
		await agent.stop(session.id);
		await pending;

		await agent.submit(session.id, 'Second', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'failed');
		await agent.retry(session.id, '/repo');
		await until(() => agent.getViewState(session.id).turns[2]?.user.text === 'Second');
		assert.deepStrictEqual(prompts, ['First', 'Second', 'Second']);
		assert.strictEqual(agent.getViewState(session.id).turns[0].status, 'stopped');
	});

	test('closing a running session interrupts it', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), { stepDelayMs: 50 }));
		const interrupts: string[] = [];
		const original = runtime.interrupt.bind(runtime);
		runtime.interrupt = async sessionId => {
			interrupts.push(sessionId);
			await original(sessionId);
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		const pending = agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.assistantText.includes('early') === true);
		agent.closeSession(session.id);
		await pending;
		await until(() => interrupts.length === 1);
		assert.deepStrictEqual(agent.getViewState(session.id).turns, []);
	});

	test('a directory added during an open query is omitted from that turn and sent on the next begin', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures()));
		const begins: string[][] = [];
		const originalBegin = runtime.begin.bind(runtime);
		const originalSend = runtime.send.bind(runtime);
		runtime.begin = async request => {
			begins.push([...(request.additionalDirectories ?? [])]);
			return originalBegin(request);
		};
		let sends = 0;
		runtime.send = async (sessionId, input) => {
			sends++;
			await originalSend(sessionId, input);
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		agent.addAdditionalDirectory(session.id, 'D:\\one');
		await agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		agent.addAdditionalDirectory(session.id, 'D:\\two');
		await agent.submit(session.id, 'Again', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		assert.deepStrictEqual(agent.getViewState(session.id).turns[0].user.sent?.additionalDirectories, ['D:\\one']);
		assert.deepStrictEqual(agent.getViewState(session.id).turns[1].user.sent?.additionalDirectories, ['D:\\one']);
		assert.strictEqual(sends, 1);
		assert.deepStrictEqual(begins, [['D:\\one']]);

		const runtimeSlow = store.add(new FakeClaudeRuntimeService(fixtures(), { stepDelayMs: 30 }));
		const slowBegins: string[][] = [];
		const originalSlowBegin = runtimeSlow.begin.bind(runtimeSlow);
		runtimeSlow.begin = async request => {
			slowBegins.push([...(request.additionalDirectories ?? [])]);
			return originalSlowBegin(request);
		};
		const slow = store.add(new ClaudeAgentService(runtimeSlow, output(), ...agentWorkspaceStubs()));
		const again = slow.createSession();
		slow.addAdditionalDirectory(again.id, 'D:\\one');
		await slow.submit(again.id, 'Why?', '/repo');
		await until(() => slow.getViewState(again.id).turns[0]?.status === 'complete');
		slow.addAdditionalDirectory(again.id, 'D:\\two');
		const pending = slow.submit(again.id, 'Slow', '/repo');
		await until(() => slow.getViewState(again.id).turns[1]?.status === 'running');
		await slow.stop(again.id);
		await pending;
		await slow.submit(again.id, 'Fresh', '/repo');
		await until(() => slow.getViewState(again.id).turns[2]?.status === 'complete');
		assert.deepStrictEqual(slowBegins[0], ['D:\\one']);
		assert.deepStrictEqual(slowBegins[1], ['D:\\one', 'D:\\two']);
		assert.deepStrictEqual(slow.getViewState(again.id).turns[2].user.sent?.additionalDirectories, ['D:\\one', 'D:\\two']);
	});

	test('retry resends the compiled prompt', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures()));
		const prompts: string[] = [];
		const originalBegin = runtime.begin.bind(runtime);
		runtime.begin = async request => {
			prompts.push(request.prompt);
			if (prompts.length === 1) {
				throw new Error('Claude is not installed.');
			}
			return originalBegin(request);
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		const compiled = '<ide_request mode="agent">\n\nlook\n</ide_request>';
		await agent.submit(session.id, 'look', '/repo', { compiled });
		assert.strictEqual(agent.getViewState(session.id).turns[0]?.status, 'failed');
		await agent.retry(session.id, '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		assert.deepStrictEqual(prompts, [compiled, compiled]);
	});

	test('a failed start clears attachments, and a busy submit does not put them back', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures(), { stepDelayMs: 40 }));
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		agent.setAttachments(session.id, [{ kind: 'file', uri: 'file:///repo/src/app.ts' }]);
		const pending = agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns.length === 1);
		assert.deepStrictEqual(agent.getCurrentSession()?.attachments, []);
		await assert.rejects(() => agent.submit(session.id, 'Again', '/repo'), /still answering/);
		assert.deepStrictEqual(agent.getCurrentSession()?.attachments, []);
		await agent.stop(session.id);
		await pending;
	});

	test('session.started stores slash commands and skills', async () => {
		const scripts = fixtures();
		scripts.set('commands', [
			'{"type":"session.started","sessionId":"$session","slashCommands":["review"],"skills":["code-review"]}',
			'{"type":"assistant.completed","sessionId":"$session","text":"ok"}',
			'{"type":"session.completed","sessionId":"$session"}',
		].join('\n'));
		const runtime = store.add(new FakeClaudeRuntimeService(scripts));
		const originalBegin = runtime.begin.bind(runtime);
		runtime.begin = request => originalBegin({ ...request, fixture: 'commands' });
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await agent.submit(session.id, 'Why?', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		assert.deepStrictEqual(agent.getCurrentSession()?.slashCommands, ['review']);
		assert.deepStrictEqual(agent.getCurrentSession()?.skills, ['code-review']);
	});

	test('a compiled prompt is what the runtime receives, and the turn can show it', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(fixtures()));
		const originalBegin = runtime.begin.bind(runtime);
		runtime.begin = async request => {
			assert.strictEqual(request.prompt, '<ide_request mode="agent">\n\nlook\n</ide_request>');
			assert.deepStrictEqual(request.additionalDirectories, ['D:\\outside']);
			return originalBegin(request);
		};
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		agent.addAdditionalDirectory(session.id, 'D:\\outside');
		agent.setAttachments(session.id, [{ kind: 'file', uri: 'file:///repo/src/app.ts' }]);
		await agent.submit(session.id, 'look', '/repo', {
			compiled: '<ide_request mode="agent">\n\nlook\n</ide_request>',
		});
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		const turn = agent.getViewState(session.id).turns[0];
		assert.strictEqual(turn.user.text, 'look');
		assert.strictEqual(turn.user.sent?.compiled, '<ide_request mode="agent">\n\nlook\n</ide_request>');
		assert.deepStrictEqual(turn.user.sent?.additionalDirectories, ['D:\\outside']);
		assert.deepStrictEqual(agent.getCurrentSession()?.attachments, []);
	});
});

function fixtures(): Map<string, string> {
	return new Map([
		['plain-answer', [
			'{"type":"session.started","sessionId":"$session","model":"fixture-sonnet"}',
			'{"type":"assistant.delta","sessionId":"$session","text":"The handler returns early. "}',
			'{"type":"assistant.delta","sessionId":"$session","text":"That skips the check."}',
			'{"type":"assistant.completed","sessionId":"$session","text":"The handler returns early. That skips the check."}',
			'{"type":"session.completed","sessionId":"$session"}',
		].join('\n')],
		['crash', [
			'{"type":"session.started","sessionId":"$session"}',
			'{"type":"assistant.delta","sessionId":"$session","text":"Partial answer"}',
			'{"type":"session.failed","sessionId":"$session","message":"process exited","kind":"process-crash"}',
		].join('\n')],
		['hidden', [
			'{"type":"session.started","sessionId":"$session"}',
			'{"type":"assistant.delta","sessionId":"$session","parentRunId":"run-1","text":"hidden"}',
			'{"type":"assistant.completed","sessionId":"$session","text":"visible"}',
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
