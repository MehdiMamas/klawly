/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NormalizedClaudeEvent } from '../../common/claudeProtocol.js';
import { ClaudeAgentRunner } from '../../node/claudeAgentRunner.js';
import { ClaudeNodeRuntimeService } from '../../node/claudeNodeRuntimeService.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery, ClaudeQueryStart } from '../../node/claudeQuery.js';
import { createClaudeCliQuery } from '../../node/claudeCliQuery.js';
import { removeDirWithRetries } from './claudeTestFiles.js';

suite('Claude sample repo', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function keep(dir: string): string {
		store.add({ dispose: () => removeDirWithRetries(dir, 40, 250) });
		return dir;
	}

	test('captures normalized events for a scripted Claude turn', async () => {
		const cwd = keep(mkdtempSync(join(tmpdir(), 'klawly-sample-')));
		writeFileSync(join(cwd, 'README.md'), '# sample\n');
		let captured: ClaudeQueryStart | undefined;
		const registry = store.add(new ClaudeProcessRegistry());
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				captured = start;
				const first = await start.prompt[Symbol.asyncIterator]().next();
				assert.strictEqual(first.value?.message.content, '/review');
				return scriptedQuery([
					{
						type: 'system',
						subtype: 'init',
						model: 'claude-sonnet',
						claude_code_version: '2.1.288',
						slash_commands: ['review'],
						skills: ['code-review'],
						session_id: 'sdk-session',
					},
					{
						type: 'stream_event',
						event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'pong' } },
						parent_tool_use_id: null,
						session_id: 'sdk-session',
					},
					{
						type: 'result',
						subtype: 'success',
						is_error: false,
						result: 'pong',
						usage: { input_tokens: 3, output_tokens: 1 },
						session_id: 'sdk-session',
					},
				]);
			},
		}));

		const events = await collect(runner.start({
			sessionId: 'local-session',
			prompt: '/review',
			cwd,
			resumeSessionId: 'resume-1',
			allowedTools: ['Read'],
			additionalDirectories: [cwd, 'relative/nope'],
			workspaceTrusted: true,
		}));

		assert.ok(captured);
		assert.strictEqual(captured.options.cwd, cwd);
		assert.deepStrictEqual(captured.options.settingSources, ['user', 'project', 'local']);
		assert.strictEqual(captured.options.resume, 'resume-1');
		assert.deepStrictEqual(captured.options.allowedTools, ['Read']);
		assert.deepStrictEqual(captured.options.additionalDirectories, [cwd]);
		assert.strictEqual(captured.options.permissionMode, 'default');
		assert.strictEqual(captured.options.includePartialMessages, true);
		assert.strictEqual(events[0].type, 'session.started');
		assert.ok(events.some(event => event.type === 'assistant.delta' && event.text === 'pong'));
		assert.strictEqual(events[events.length - 1].type, 'session.completed');
		assert.ok(events.every(event => event.sessionId === 'local-session'));

		const decision = await captured.options.canUseTool('Bash', { command: 'npm test' }, {
			signal: new AbortController().signal,
			toolUseID: 'tool-1',
		});
		assert.strictEqual(decision.behavior, 'deny');
		const capabilities = await runner.capabilities();
		assert.strictEqual(capabilities.skills.includes('code-review'), true);
		assert.strictEqual(capabilities.commands.some(command => command.name === 'review'), true);
	});

	test('stops one subagent when the SDK task stop fails by interrupting the turn', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		let stopped = false;
		let release: (() => void) | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				await start.prompt[Symbol.asyncIterator]().next();
				return scriptedQuery([], {
					async *[Symbol.asyncIterator]() {
						yield {
							type: 'system',
							subtype: 'task_started',
							task_id: 'task-9',
							tool_use_id: 'run-9',
							description: 'Look around',
							subagent_type: 'explorer',
							session_id: 'sdk-session',
						};
						await new Promise<void>(resolve => {
							release = resolve;
						});
					},
					interrupt: async () => release?.(),
					close: () => release?.(),
					stopTask: async () => {
						stopped = true;
						throw new Error('stopTask unavailable');
					},
				});
			},
		}));

		const seen: NormalizedClaudeEvent[] = [];
		const done = (async () => {
			for await (const event of runner.start({
				sessionId: 'local-session',
				prompt: 'look',
				cwd: tmpdir(),
			})) {
				seen.push(event);
				if (event.type === 'session.completed' || event.type === 'session.failed') {
					break;
				}
			}
		})();
		await waitFor(seen, event => event.type === 'subagent.started');
		await runner.interruptSubagent('local-session', 'run-9');
		await done;

		assert.strictEqual(stopped, true);
		assert.ok(seen.some(event => event.type === 'subagent.finished' && event.runId === 'run-9' && event.state === 'stopped' && event.interruptedParent === true && event.resultText === 'Stopped by interrupting the parent turn.'));
	});

	test('kills a session that outlives its timeout', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 30,
			queryFactory: async start => {
				await start.prompt[Symbol.asyncIterator]().next();
				return hangingQuery();
			},
		}));

		const events = await collect(runner.start({
			sessionId: 'local-session',
			prompt: 'hang',
			cwd: tmpdir(),
		}));

		const timedOut = events[events.length - 1];
		assert.strictEqual(timedOut.type, 'session.failed');
		if (timedOut.type === 'session.failed') {
			assert.strictEqual(timedOut.kind, 'process-crash');
		}
	});

	test('lists models from the SDK and switches the live model', async () => {
		const cwd = keep(mkdtempSync(join(tmpdir(), 'klawly-models-')));
		mkdirSync(cwd, { recursive: true });
		let model: string | undefined;
		let release: (() => void) | undefined;
		const service = store.add(new ClaudeNodeRuntimeService({
			execFile: async (_file, args) => {
				if (args[0] === '--version') {
					return { stdout: '2.1.288 (Claude Code)\n', stderr: '' };
				}
				return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }), stderr: '' };
			},
			runtimePath: process.execPath,
			queryFactory: async start => {
				if (start.options.modelPicker) {
					// The query that asks for older models runs beside the session.
					return scriptedQuery([], { supportedModels: async () => [{ id: 'claude-opus-4-6', displayName: 'Opus 4.6' }] });
				}
				await start.prompt[Symbol.asyncIterator]().next();
				return scriptedQuery([], {
					async *[Symbol.asyncIterator]() {
						yield { type: 'system', subtype: 'init', model: 'claude-sonnet', slash_commands: ['help'], skills: ['code-review'], session_id: 'sdk-session' };
						await new Promise<void>(resolve => {
							release = resolve;
						});
						yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sdk-session' };
					},
					supportedModels: async () => [{ id: 'claude-sonnet', displayName: 'Sonnet', description: 'Reported by the runtime' }],
					setModel: async next => {
						model = next;
					},
					interrupt: async () => release?.(),
					close: () => release?.(),
				});
			},
		}));
		const seen: NormalizedClaudeEvent[] = [];
		store.add(service.onDidEmitEvent(event => seen.push(event)));

		const handle = await service.begin({ prompt: 'hi', cwd, mode: 'agent' });
		await waitFor(seen, event => event.type === 'session.started');
		await service.setModel(handle.sessionId, 'claude-sonnet');
		const models = await service.listModels();
		let later = models;
		for (let i = 0; i < 50 && later.length < 2; i++) {
			await new Promise(resolve => setTimeout(resolve, 0));
			later = await service.listModels();
		}
		release?.();
		await settle(seen);

		// The live lineup comes back at once; the older models join a later call.
		assert.deepStrictEqual([models.map(entry => entry.id), later.map(entry => [entry.id, !!entry.older])], [
			['claude-sonnet'],
			[['claude-sonnet', false], ['claude-opus-4-6', true]],
		]);
		assert.strictEqual(model, 'claude-sonnet');
		assert.strictEqual(models[0]?.id, 'claude-sonnet');
		assert.strictEqual(models[0]?.source, 'runtime');
		assert.ok(seen.some(event => event.type === 'session.modelChanged' && event.modelId === 'claude-sonnet'));
	});

	test('runs Claude in a sample repo when KLAWLY_LIVE_CLAUDE=1', async function () {
		if (process.env.KLAWLY_LIVE_CLAUDE !== '1') {
			this.skip();
		}
		this.timeout(120_000);
		const cwd = keep(mkdtempSync(join(tmpdir(), 'klawly-live-')));
		writeFileSync(join(cwd, 'README.md'), '# sample\n');
		const service = store.add(new ClaudeNodeRuntimeService({
			queryFactory: createClaudeCliQuery,
			maxTurns: 1,
			permissionBridge: { request: async () => ({ behavior: 'deny', message: 'Denied in the live probe.' }) },
		}));
		const seen: NormalizedClaudeEvent[] = [];
		store.add(service.onDidEmitEvent(event => seen.push(event)));

		const handle = await service.begin({
			prompt: 'Reply with the single word pong. Do not use tools.',
			cwd,
			mode: 'agent',
		});
		const terminal = await waitForTerminal(seen, 90_000);
		const capabilities = await service.capabilities();
		await service.disposeSession(handle.sessionId);

		const answer = seen.flatMap(event => event.type === 'assistant.delta' || event.type === 'assistant.completed' ? [event.text] : []).join('\n');
		console.log(`live Claude terminal: ${terminal.type}${terminal.type === 'session.failed' ? ` ${terminal.kind ?? 'unknown'}` : ''}`);
		assert.ok(seen.some(event => event.type === 'session.started' && event.sessionId === handle.sessionId));
		assert.strictEqual(terminal.type, 'session.completed');
		assert.ok(answer.toLowerCase().includes('pong'), 'live Claude did not answer');
		assert.ok(capabilities.commands.length > 0);
		assert.ok(Array.isArray(capabilities.skills));
	});

	test('emits one terminal event per turn while the query stays open', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		let releaseSecond: (() => void) | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				const prompts = start.prompt[Symbol.asyncIterator]();
				return scriptedQuery([], {
					async *[Symbol.asyncIterator]() {
						const first = await prompts.next();
						yield { type: 'system', subtype: 'init', model: 'claude-sonnet', slash_commands: ['help'], skills: [], session_id: 'sdk-session' };
						yield { type: 'result', subtype: 'success', is_error: false, result: first.value?.message.content, session_id: 'sdk-session' };
						const second = await prompts.next();
						yield { type: 'result', subtype: 'success', is_error: false, result: second.value?.message.content, session_id: 'sdk-session' };
						await new Promise<void>(resolve => { releaseSecond = resolve; });
					},
					close: () => releaseSecond?.(),
					interrupt: async () => releaseSecond?.(),
				});
			},
		}));

		const seen: NormalizedClaudeEvent[] = [];
		const iterator = runner.start({ sessionId: 'local-session', prompt: 'one', cwd: tmpdir() })[Symbol.asyncIterator]();
		const firstTerminal = await nextTerminal(iterator, seen);
		await runner.send('local-session', 'two');
		const secondTerminal = await nextTerminal(iterator, seen);
		releaseSecond?.();
		await iterator.next();

		assert.strictEqual(firstTerminal.type, 'session.completed');
		assert.strictEqual(secondTerminal.type, 'session.completed');
		assert.ok(seen.filter(event => event.type === 'assistant.completed' && event.text === 'one').length === 1);
		assert.ok(seen.filter(event => event.type === 'assistant.completed' && event.text === 'two').length === 1);
		assert.strictEqual(seen.filter(event => event.type === 'session.completed').length, 2);
	});

	test('send during launch reuses the query that is still starting', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		let calls = 0;
		let release: (() => void) | undefined;
		let reached: (() => void) | undefined;
		const reachedPromise = new Promise<void>(resolve => { reached = resolve; });
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				calls++;
				await start.prompt[Symbol.asyncIterator]().next();
				reached?.();
				await new Promise<void>(resolve => { release = resolve; });
				return scriptedQuery([
					{ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sdk-session' },
				]);
			},
		}));

		const done = collect(runner.start({ sessionId: 'local-session', prompt: 'one', cwd: tmpdir() }));
		await reachedPromise;
		const replacement = await runner.send('local-session', 'two');
		release?.();
		await done;

		assert.strictEqual(calls, 1);
		assert.strictEqual(replacement, undefined);
	});

	test('interrupt ends the open turn', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		let interrupted = false;
		let release: (() => void) | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				await start.prompt[Symbol.asyncIterator]().next();
				return scriptedQuery([], {
					async *[Symbol.asyncIterator]() {
						await new Promise<void>(resolve => { release = resolve; });
					},
					interrupt: async () => {
						interrupted = true;
						release?.();
					},
					close: () => release?.(),
				});
			},
		}));

		const events = collect(runner.start({ sessionId: 'local-session', prompt: 'hang', cwd: tmpdir() }));
		await waitUntil(() => registry.get('local-session') !== undefined);
		await runner.interrupt('local-session');
		const seen = await events;
		assert.strictEqual(interrupted, true);
		assert.strictEqual(seen[seen.length - 1].type, 'session.completed');
	});

	test('disposeSession drops the query', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				await start.prompt[Symbol.asyncIterator]().next();
				return hangingQuery();
			},
		}));
		const done = collect(runner.start({ sessionId: 'local-session', prompt: 'hang', cwd: tmpdir() }));
		await waitUntil(() => registry.get('local-session') !== undefined);
		runner.disposeSession('local-session');
		await done;
		assert.strictEqual(runner.hasSession('local-session'), false);
		assert.strictEqual(registry.get('local-session'), undefined);
	});

	test('stopTask success does not interrupt the parent turn', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		let stopped: string | undefined;
		let interrupted = false;
		let release: (() => void) | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				await start.prompt[Symbol.asyncIterator]().next();
				return scriptedQuery([], {
					async *[Symbol.asyncIterator]() {
						yield {
							type: 'system',
							subtype: 'task_started',
							task_id: 'task-9',
							tool_use_id: 'run-9',
							description: 'Look around',
							subagent_type: 'explorer',
							session_id: 'sdk-session',
						};
						await new Promise<void>(resolve => { release = resolve; });
					},
					stopTask: async taskId => { stopped = taskId; },
					interrupt: async () => { interrupted = true; },
					close: () => release?.(),
				});
			},
		}));
		const seen: NormalizedClaudeEvent[] = [];
		const done = (async () => {
			for await (const event of runner.start({ sessionId: 'local-session', prompt: 'look', cwd: tmpdir() })) {
				seen.push(event);
			}
		})();
		await waitFor(seen, event => event.type === 'subagent.started');
		await runner.interruptSubagent('local-session', 'run-9');
		await runner.interruptSubagent('local-session', 'missing');
		release?.();
		await done;
		assert.strictEqual(stopped, 'task-9');
		assert.strictEqual(interrupted, false);
		assert.strictEqual(seen.some(event => event.type === 'subagent.finished'), false);
	});

	test('a rejected live model switch keeps the previous model', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		let release: (() => void) | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				await start.prompt[Symbol.asyncIterator]().next();
				return scriptedQuery([], {
					async *[Symbol.asyncIterator]() {
						yield { type: 'system', subtype: 'init', slash_commands: [], skills: [], session_id: 'sdk-session' };
						await new Promise<void>(resolve => { release = resolve; });
					},
					setModel: async () => { throw new Error('model refused'); },
					close: () => release?.(),
					interrupt: async () => release?.(),
				});
			},
		}));
		const seen: NormalizedClaudeEvent[] = [];
		const done = (async () => {
			for await (const event of runner.start({ sessionId: 'local-session', prompt: 'hi', cwd: tmpdir(), modelId: 'claude-sonnet' })) {
				seen.push(event);
			}
		})();
		await waitFor(seen, event => event.type === 'session.started');
		await assert.rejects(() => runner.setModel('local-session', 'claude-opus'));
		assert.strictEqual(seen.some(event => event.type === 'session.modelChanged'), false);
		release?.();
		await done;
	});

	test('setModel without a live query is sent on the next query', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		const models: Array<string | undefined> = [];
		const side: NormalizedClaudeEvent[] = [];
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			onEvent: event => side.push(event),
			queryFactory: async start => {
				models.push(start.options.model);
				await start.prompt[Symbol.asyncIterator]().next();
				return scriptedQuery([
					{ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sdk-session' },
				]);
			},
		}));
		await collect(runner.start({ sessionId: 'local-session', prompt: 'hi', cwd: tmpdir() }));
		await runner.setModel('local-session', 'claude-opus');
		const second = await runner.send('local-session', 'again');
		assert.ok(second);
		await collect(second);
		assert.ok(side.some(event => event.type === 'session.modelChanged' && event.modelId === 'claude-opus'));
		assert.strictEqual(models[1], 'claude-opus');
	});

	test('an allowing permission bridge can replace tool input', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		let captured: ClaudeQueryStart | undefined;
		let release: (() => void) | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				captured = start;
				await start.prompt[Symbol.asyncIterator]().next();
				return scriptedQuery([], {
					async *[Symbol.asyncIterator]() {
						yield { type: 'system', subtype: 'init', slash_commands: [], skills: [], session_id: 'sdk-session' };
						await new Promise<void>(resolve => { release = resolve; });
					},
					close: () => release?.(),
					interrupt: async () => release?.(),
				});
			},
		}));
		const seen: NormalizedClaudeEvent[] = [];
		const done = (async () => {
			for await (const event of runner.start({
				sessionId: 'local-session',
				prompt: 'hi',
				cwd: tmpdir(),
				permissionBridge: { request: async () => ({ behavior: 'allow', updatedInput: { command: 'rm -rf /' } }) },
			})) {
				seen.push(event);
			}
		})();
		await waitFor(seen, event => event.type === 'session.started');
		const decision = await captured!.options.canUseTool('Bash', { command: 'npm test' }, {
			signal: new AbortController().signal,
			toolUseID: 'tool-7',
		});
		await waitFor(seen, event => event.type === 'permission.requested');
		release?.();
		await done;
		assert.strictEqual(decision.behavior, 'allow');
		if (decision.behavior === 'allow') {
			// The command the user approved is the command that runs. A bridge cannot swap it.
			assert.strictEqual(decision.updatedInput, undefined);
		}
		const request = seen.find(event => event.type === 'permission.requested');
		assert.strictEqual(request?.type, 'permission.requested');
		if (request?.type === 'permission.requested') {
			assert.strictEqual(request.request.id, 'tool-7');
		}
	});

	test('an idle session stays up after the turn completes', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		let release: (() => void) | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 40,
			queryFactory: async start => {
				await start.prompt[Symbol.asyncIterator]().next();
				return scriptedQuery([], {
					async *[Symbol.asyncIterator]() {
						yield { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sdk-session' };
						await new Promise<void>(resolve => { release = resolve; });
					},
					close: () => release?.(),
					interrupt: async () => release?.(),
				});
			},
		}));
		const seen: NormalizedClaudeEvent[] = [];
		const done = (async () => {
			for await (const event of runner.start({ sessionId: 'local-session', prompt: 'hi', cwd: tmpdir() })) {
				seen.push(event);
			}
		})();
		await waitFor(seen, event => event.type === 'session.completed');
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.ok(registry.get('local-session'));
		assert.strictEqual(seen.some(event => event.type === 'session.failed'), false);
		release?.();
		await done;
	});

	test('a prompt sent during an open turn stays on that turn', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		let releaseRead: (() => void) | undefined;
		let releaseEnd: (() => void) | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				const prompts = start.prompt[Symbol.asyncIterator]();
				return scriptedQuery([], {
					async *[Symbol.asyncIterator]() {
						await prompts.next();
						releaseRead?.();
						await prompts.next();
						yield { type: 'result', subtype: 'success', is_error: false, result: 'one turn', session_id: 'sdk-session' };
						await new Promise<void>(resolve => { releaseEnd = resolve; });
					},
					close: () => releaseEnd?.(),
					interrupt: async () => releaseEnd?.(),
				});
			},
		}));
		const seen: NormalizedClaudeEvent[] = [];
		const iterator = runner.start({ sessionId: 'local-session', prompt: 'one', cwd: tmpdir() })[Symbol.asyncIterator]();
		await new Promise<void>(resolve => { releaseRead = resolve; });
		await runner.send('local-session', 'two');
		const terminal = await nextTerminal(iterator, seen);
		releaseEnd?.();
		await iterator.next();
		assert.strictEqual(terminal.type, 'session.completed');
		assert.strictEqual(seen.filter(event => event.type === 'session.completed').length, 1);
		assert.ok(seen.some(event => event.type === 'assistant.completed' && event.text === 'one turn'));
	});

	test('setModel during launch is applied on the live query', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		let applied: string | undefined;
		let release: (() => void) | undefined;
		let reached: (() => void) | undefined;
		const reachedPromise = new Promise<void>(resolve => { reached = resolve; });
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				reached?.();
				await new Promise<void>(resolve => { release = resolve; });
				await start.prompt[Symbol.asyncIterator]().next();
				return scriptedQuery([
					{ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sdk-session' },
				], {
					setModel: async model => { applied = model; },
				});
			},
		}));
		const seen: NormalizedClaudeEvent[] = [];
		const done = (async () => {
			for await (const event of runner.start({ sessionId: 'local-session', prompt: 'hi', cwd: tmpdir(), modelId: 'claude-sonnet' })) {
				seen.push(event);
			}
		})();
		await reachedPromise;
		const pending = runner.setModel('local-session', 'claude-opus');
		assert.strictEqual(seen.some(event => event.type === 'session.modelChanged'), false);
		release?.();
		await pending;
		await done;
		assert.strictEqual(applied, 'claude-opus');
		assert.ok(seen.some(event => event.type === 'session.modelChanged' && event.modelId === 'claude-opus'));
	});

	test('setModel during a failed launch rejects', async () => {
		const registry = store.add(new ClaudeProcessRegistry());
		let release: (() => void) | undefined;
		let reached: (() => void) | undefined;
		const reachedPromise = new Promise<void>(resolve => { reached = resolve; });
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async () => {
				reached?.();
				await new Promise<void>(resolve => { release = resolve; });
				throw new Error('launch failed');
			},
		}));
		const done = (async () => {
			for await (const event of runner.start({ sessionId: 'local-session', prompt: 'hi', cwd: tmpdir() })) {
				assert.ok(event.type === 'session.failed' || event.type === 'session.started');
			}
		})();
		await reachedPromise;
		const pending = runner.setModel('local-session', 'claude-opus');
		release?.();
		await assert.rejects(pending);
		await done;
	});
});

function scriptedQuery(messages: readonly unknown[], extra?: Partial<ClaudeQuery>): ClaudeQuery {
	return {
		async *[Symbol.asyncIterator]() {
			for (const message of messages) {
				yield message;
			}
		},
		interrupt: async () => undefined,
		setModel: async () => undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => undefined,
		...extra,
	};
}

function hangingQuery(): ClaudeQuery {
	let close: (() => void) | undefined;
	return {
		async *[Symbol.asyncIterator]() {
			await new Promise<void>(resolve => {
				close = resolve;
			});
		},
		interrupt: async () => undefined,
		setModel: async () => undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => {
			throw new Error('still running');
		},
		close: () => close?.(),
	};
}

async function collect(events: AsyncIterable<NormalizedClaudeEvent>): Promise<NormalizedClaudeEvent[]> {
	const seen: NormalizedClaudeEvent[] = [];
	for await (const event of events) {
		seen.push(event);
		if (event.type === 'session.completed' || event.type === 'session.failed') {
			break;
		}
	}
	return seen;
}

async function settle(seen: NormalizedClaudeEvent[]): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt++) {
		if (seen.some(event => event.type === 'session.completed' || event.type === 'session.failed')) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.fail(`session did not settle (${seen.map(event => event.type).join(',')})`);
}

async function nextTerminal(iterator: AsyncIterator<NormalizedClaudeEvent>, seen: NormalizedClaudeEvent[]): Promise<NormalizedClaudeEvent> {
	for (; ;) {
		const next = await iterator.next();
		if (next.done || !next.value) {
			assert.fail(`query ended before the turn finished (${seen.map(event => event.type).join(',')})`);
		}
		seen.push(next.value);
		if (next.value.type === 'session.completed' || next.value.type === 'session.failed') {
			return next.value;
		}
	}
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > 5000) {
			assert.fail('condition was not met');
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

function waitFor(seen: NormalizedClaudeEvent[], predicate: (event: NormalizedClaudeEvent) => boolean): Promise<NormalizedClaudeEvent> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const timer = setInterval(() => {
			const match = seen.find(predicate);
			if (match) {
				clearInterval(timer);
				resolve(match);
				return;
			}
			if (Date.now() - started > 5000) {
				clearInterval(timer);
				reject(new Error(`event did not arrive (${seen.map(event => event.type).join(',')})`));
			}
		}, 10);
	});
}

function waitForTerminal(seen: NormalizedClaudeEvent[], timeoutMs: number): Promise<NormalizedClaudeEvent> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const timer = setInterval(() => {
			const terminal = seen.find(event => event.type === 'session.completed' || event.type === 'session.failed');
			if (terminal) {
				clearInterval(timer);
				resolve(terminal);
				return;
			}
			if (Date.now() - started > timeoutMs) {
				clearInterval(timer);
				reject(new Error(`live Claude did not finish (${seen.map(event => event.type).join(',')})`));
			}
		}, 50);
	});
}
