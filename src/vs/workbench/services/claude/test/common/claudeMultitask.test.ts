/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BackgroundAgentStatus, BackgroundAgentTask, BackgroundApplyResult, ClaudeBackgroundRunOptions, isActiveBackgroundStatus } from '../../../../../platform/claude/common/claudeBackground.js';
import { AgentMode, ContextAttachment, PendingInput } from '../../../../../platform/claude/common/claudeContext.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { ClaudeSubmitOptions, IClaudeAgentService } from '../../common/claudeAgentService.js';
import { AgentViewState, EMPTY_AGENT_VIEW_STATE, TurnViewModel } from '../../common/claudeAgentState.js';
import { IClaudeBackgroundAgentService } from '../../common/claudeBackgroundAgent.js';
import { ClaudeWorkerRegistry } from '../../common/claudeWorkerRegistry.js';
import { assignMultitaskAttachments, ClaudeMultitaskService, multitaskSummaryPrompt, parseMultitaskPrompts, splitMultitaskLineMode } from '../../common/claudeMultitask.js';

class FakeBackground implements IClaudeBackgroundAgentService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidChangeTasks = new Emitter<void>();
	readonly onDidChangeTasks = this._onDidChangeTasks.event;
	readonly started: { prompt: string; options?: ClaudeBackgroundRunOptions }[] = [];
	private readonly _tasks: BackgroundAgentTask[] = [];

	constructor(private readonly _max: number) { }

	getTasks(): readonly BackgroundAgentTask[] {
		return this._tasks;
	}
	maxParallelSessions(): number {
		return this._max;
	}
	canStart(): boolean {
		return this._tasks.filter(task => isActiveBackgroundStatus(task.status)).length < this._max;
	}
	async start(prompt: string, options?: ClaudeBackgroundRunOptions): Promise<BackgroundAgentTask> {
		this.started.push({ prompt, options });
		if (prompt === 'broken') {
			throw new Error('Open a local folder before starting a background agent.');
		}
		const id = options?.taskId ?? 'task';
		const task: BackgroundAgentTask = {
			id,
			sessionId: `session-${id}`,
			repoRoot: '/repo',
			baseRef: 'base',
			worktreePath: `/worktrees/${id}`,
			branchName: `klawly/${id}`,
			status: 'running',
			title: prompt,
			filesChanged: 0,
			added: 0,
			removed: 0,
			testStatus: 'tests not run',
			conflicts: [],
			stopped: false,
		};
		this._tasks.push(task);
		this._onDidChangeTasks.fire();
		return task;
	}
	finish(id: string, status: BackgroundAgentStatus, filesChanged = 0): void {
		const task = this._tasks.find(candidate => candidate.id === id)!;
		task.status = status;
		task.filesChanged = filesChanged;
		task.added = filesChanged * 3;
		task.removed = filesChanged;
		this._onDidChangeTasks.fire();
	}
	async stop(taskId: string): Promise<void> {
		const task = this._tasks.find(candidate => candidate.id === taskId)!;
		task.stopped = true;
		this.finish(taskId, 'failed');
	}
	async delete(): Promise<void> { }
	async review(): Promise<void> { }
	async apply(): Promise<BackgroundApplyResult> {
		return { applied: false, conflicts: [] };
	}
	async openConflicts(): Promise<void> { }
	async cleanUp(): Promise<{ readonly removed: number; readonly kept: number }> {
		return { removed: 0, kept: 0 };
	}
	dispose(): void {
		this._onDidChangeTasks.dispose();
	}
}

function answered(text: string, status: TurnViewModel['status'] = 'complete'): AgentViewState {
	return { ...EMPTY_AGENT_VIEW_STATE, turns: [{ assistantText: text, status, permissions: [] as TurnViewModel['permissions'] } as TurnViewModel] };
}

suite('Claude Multitask', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(max: number, pending: PendingInput[] = [], storage = store.add(new InMemoryStorageService()), mainOpen = true) {
		const background = new FakeBackground(max);
		store.add({ dispose: () => background.dispose() });
		const views = new Map<string, AgentViewState>();
		const onDidChangeViewState = store.add(new Emitter<{ readonly sessionId: string }>());
		const sent: { sessionId: string; text: string; cwd: string; behavior: string; compiled?: string }[] = [];
		const removed: string[] = [];
		// Read-only runs (issue 686) open their own chat in the sending chat's folder.
		const chats: { id: string; cwd?: string; mode?: AgentMode; text?: string; submitCwd?: string; compiled?: string }[] = [];
		let current = 'main';
		const agent = {
			onDidChangeViewState: onDidChangeViewState.event,
			getViewState: (sessionId: string) => views.get(sessionId) ?? EMPTY_AGENT_VIEW_STATE,
			getPending: () => pending,
			removePending: (_sessionId: string, id: string) => removed.push(id),
			queue: async (sessionId: string, text: string, cwd: string, behavior: string, options?: ClaudeSubmitOptions) => {
				sent.push({ sessionId, text, cwd, behavior, compiled: options?.compiled });
				return { id: 'p', text, attachments: [], behavior, createdAt: 0 };
			},
			getSessions: () => [...(mainOpen ? [{ id: 'main' }] : []), ...chats],
			getCurrentSession: () => ({ id: current }),
			selectSession: (sessionId: string) => { current = sessionId; },
			createSession: () => {
				const chat = { id: `chat-${chats.length + 1}` };
				chats.push(chat);
				current = chat.id;
				return chat;
			},
			pinWorkingDirectory: (sessionId: string, cwd: string) => { chats.find(chat => chat.id === sessionId)!.cwd = cwd; },
			setMode: (sessionId: string, mode: AgentMode) => { chats.find(chat => chat.id === sessionId)!.mode = mode; },
			submit: async (sessionId: string, text: string, cwd: string, options?: ClaudeSubmitOptions) => {
				Object.assign(chats.find(chat => chat.id === sessionId)!, { text, submitCwd: cwd, compiled: options?.compiled });
				views.set(sessionId, answered('', 'running'));
			},
			stop: async (sessionId: string) => {
				views.set(sessionId, answered('', 'stopped'));
				onDidChangeViewState.fire({ sessionId });
			},
		} as unknown as IClaudeAgentService;
		const registry = store.add(new ClaudeWorkerRegistry(store.add(new InMemoryStorageService())));
		const service = store.add(new ClaudeMultitaskService(background, agent, new NullLogService(), storage, registry));
		const answer = (sessionId: string, text: string) => {
			views.set(sessionId, answered(text));
			onDidChangeViewState.fire({ sessionId });
		};
		return { service, registry, background, views, sent, removed, chats, answer, current: () => current };
	}

	test('parses one prompt per line after /multitask', () => {
		assert.deepStrictEqual([
			parseMultitaskPrompts('/multitask\n- Find the slow test\n2. Explain the parser\r\n\n  * Check the docs  '),
			parseMultitaskPrompts('/multitask Fix A\nFix B'),
			parseMultitaskPrompts('/multitask'),
			parseMultitaskPrompts('/multitasks a'),
			parseMultitaskPrompts('Run /multitask'),
		], [
			['Find the slow test', 'Explain the parser', 'Check the docs'],
			['Fix A', 'Fix B'],
			[],
			undefined,
			undefined,
		]);
	});

	test('runs past the parallel cap wait for a slot, then one combined turn goes back to the chat', async () => {
		const { service, background, views, sent } = create(2);
		const group = service.start('main', ['Find the slow test', 'Explain the parser', 'broken'], '/repo');
		const id = (index: number) => `multitask-${group.id}-${index}`;
		assert.deepStrictEqual(service.getGroups('main')[0].runs.map(run => run.status), ['running', 'running', 'queued']);

		views.set(`session-${id(1)}`, answered('The slow test is claudePaneShell.'));
		background.finish(id(1), 'complete', 2);
		await Promise.resolve();
		const third = service.getGroups('main')[0].runs[2];
		assert.deepStrictEqual([third.status, third.error], ['failed', 'Open a local folder before starting a background agent.']);
		assert.strictEqual(sent.length, 0);

		views.set(`session-${id(2)}`, answered('It is a recursive descent parser.'));
		background.finish(id(2), 'complete');
		assert.deepStrictEqual({
			started: background.started.map(run => [run.prompt, run.options?.taskId, run.options?.select]),
			ended: service.getGroups('main')[0].endedAt !== undefined,
			sent: sent.map(turn => [turn.sessionId, turn.text, turn.cwd, turn.behavior]),
			compiled: sent[0].compiled === multitaskSummaryPrompt([
				{ prompt: 'Find the slow test', status: 'complete', stopped: false, branchName: `klawly/${id(1)}`, filesChanged: 2, added: 6, removed: 2, answer: 'The slow test is claudePaneShell.' },
				{ prompt: 'Explain the parser', status: 'complete', stopped: false, branchName: `klawly/${id(2)}`, filesChanged: 0, added: 0, removed: 0, answer: 'It is a recursive descent parser.' },
				{ prompt: 'broken', status: 'failed', error: 'Open a local folder before starting a background agent.' },
			]),
		}, {
			started: [
				['Find the slow test', id(1), false],
				['Explain the parser', id(2), false],
				['broken', id(3), false],
			],
			ended: true,
			sent: [['main', 'Combine the results of the 3 parallel tasks.', '/repo', 'queue']],
			compiled: true,
		});

		// Ending is reported once, and dismiss clears the ended cards.
		background.finish(id(1), 'complete', 2);
		service.dismiss(group.id);
		assert.deepStrictEqual([sent.length, service.getGroups('main').length], [1, 0]);
	});

	test('issue 835: a multitask and each prompt are recorded as runs in the worker registry', async () => {
		const { service, registry, background, views } = create(2);
		const group = service.start('main', ['Find the slow test', 'Explain the parser'], '/repo');
		const shape = () => registry.all().map(run => [run.number, run.parentId, run.kind, run.state, run.name]);
		assert.deepStrictEqual(shape(), [
			['1', undefined, 'multitask', 'working', 'Multitask of 2: Find the slow test'],
			['1-1', `multitask-${group.id}`, 'multitask', 'working', 'Find the slow test'],
			['1-2', `multitask-${group.id}`, 'multitask', 'working', 'Explain the parser'],
		]);
		for (const index of [1, 2]) {
			views.set(`session-multitask-${group.id}-${index}`, answered('Done.'));
			background.finish(`multitask-${group.id}-${index}`, 'complete');
		}
		await Promise.resolve();
		assert.deepStrictEqual(registry.all().map(run => run.state), ['finished', 'finished', 'finished']);
	});

	test('the combined prompt names each task, its branch and its result', () => {
		assert.strictEqual(multitaskSummaryPrompt([
			{ prompt: 'A', status: 'complete', branchName: 'klawly/a', filesChanged: 1, added: 4, removed: 1, answer: ' Done A. ' },
			{ prompt: 'B', status: 'failed', stopped: true },
		]), [
			'These 2 tasks ran in parallel as background agents, each in its own git worktree of this repository. Combine their results into one answer: what each one found or changed, where they agree or conflict, and what to do next. Do not redo the tasks. Changes stay on each task\'s branch until they are applied from the Background view.',
			'',
			'## Task 1: A',
			'Status: complete',
			'Branch: klawly/a (1 files changed, +4 -1)',
			'Result:',
			'Done A.',
			'',
			'## Task 2: B',
			'Status: stopped',
		].join('\n'));
	});

	test('Run Queued in Parallel takes the queued messages off the queue; fewer than two is refused', () => {
		const queued = (id: string, text: string): PendingInput => ({ id, text, attachments: [], behavior: 'queue', createdAt: 0 });
		const { service, background, removed } = create(4, [queued('q1', 'Fix A'), queued('q2', 'Fix B')]);
		service.runQueued('main', '/repo');
		assert.deepStrictEqual([background.started.map(run => run.prompt), removed], [['Fix A', 'Fix B'], ['q1', 'q2']]);

		const single = create(4, [queued('q1', 'Fix A')]);
		assert.throws(() => single.service.runQueued('main', '/repo'), /Queue at least two messages/);
		assert.throws(() => single.service.start('main', ['only one'], '/repo'), /at least two prompts/);
	});

	test('Stop All stops running tasks and drops runs that never started; results still go back', async () => {
		const { service, background, sent } = create(1);
		const group = service.start('main', ['A', 'B'], '/repo');
		await service.stop(group.id);
		assert.deepStrictEqual({
			statuses: service.getGroups('main')[0].runs.map(run => run.status),
			started: background.started.length,
			sent: sent.length,
		}, { statuses: ['failed', 'failed'], started: 1, sent: 1 });
	});

	test('a read-only multitask runs each task as a chat in the sending chat\'s folder, with no worktree', async () => {
		const { service, background, sent, chats, answer, current } = create(4);
		const group = service.start('main', ['Explain the parser', 'Find the slow test'], '/repo', 'ask');
		await Promise.resolve();
		const running = service.getGroups('main')[0].runs.map(run => [run.status, run.readOnly, run.runSessionId]);
		answer('chat-1', 'A recursive descent parser.');
		answer('chat-2', 'claudePaneShell.');
		assert.deepStrictEqual({
			running,
			worktrees: background.started.length,
			chats,
			current: current(),
			ended: service.getGroups('main')[0].endedAt !== undefined,
			sent: sent.map(turn => [turn.sessionId, turn.cwd]),
			compiled: sent[0]?.compiled === multitaskSummaryPrompt([
				{ prompt: 'Explain the parser', status: 'complete', answer: 'A recursive descent parser.', readOnly: true },
				{ prompt: 'Find the slow test', status: 'complete', answer: 'claudePaneShell.', readOnly: true },
			]),
			header: multitaskSummaryPrompt([{ prompt: 'A', status: 'complete', readOnly: true }]).split('\n')[0],
		}, {
			running: [['running', true, 'chat-1'], ['running', true, 'chat-2']],
			worktrees: 0,
			chats: [
				{ id: 'chat-1', cwd: '/repo', mode: 'ask', text: 'Explain the parser', submitCwd: '/repo', compiled: undefined },
				{ id: 'chat-2', cwd: '/repo', mode: 'ask', text: 'Find the slow test', submitCwd: '/repo', compiled: undefined },
			],
			current: 'main',
			ended: true,
			sent: [['main', '/repo']],
			compiled: true,
			header: 'These 1 tasks ran in parallel as read-only agents in this folder, so they changed no files. Combine their results into one answer: what each one found, where they agree or conflict, and what to do next. Do not redo the tasks.',
		});
		service.dismiss(group.id);

		// Agent mode keeps the worktree path and passes the mode on.
		service.start('main', ['Fix A', 'Fix B'], '/repo', 'agent');
		assert.deepStrictEqual(background.started.map(run => run.options?.mode), ['agent', 'agent']);
	});

	test('issue 759: a line starting with a mode runs in that mode, the others in the chat mode', async () => {
		const { service, background, chats } = create(4);
		service.start('main', ['ask: Explain the parser', 'Fix A', 'Plan: Outline B', 'note: keep it short'], '/repo', 'agent');
		await Promise.resolve();
		assert.deepStrictEqual({
			runs: service.getGroups('main')[0].runs.map(run => [run.prompt, run.mode, run.readOnly]),
			worktrees: background.started.map(run => [run.prompt, run.options?.mode]),
			chats: chats.map(chat => [chat.text, chat.mode]),
			split: [splitMultitaskLineMode('ask:'), splitMultitaskLineMode('  agent : go ')],
		}, {
			runs: [['Explain the parser', 'ask', true], ['Fix A', undefined, undefined], ['Outline B', 'plan', true], ['note: keep it short', undefined, undefined]],
			worktrees: [['Fix A', 'agent'], ['note: keep it short', 'agent']],
			chats: [['Explain the parser', 'ask'], ['Outline B', 'plan']],
			split: [{ text: 'ask:' }, { text: 'go', mode: 'agent' }],
		});
	});

	test('multitasks are kept per workspace across a window reload; unfinished ones wait for Send Results', async () => {
		const storage = store.add(new InMemoryStorageService());
		const before = create(1, [], storage);
		const done = before.service.start('main', ['A', 'B'], '/repo', 'ask');
		before.answer('chat-1', 'Done A.');
		await Promise.resolve();
		before.answer('chat-2', 'Done B.');
		const unfinished = before.service.start('main', ['C', 'D'], '/repo');
		before.views.set(`session-multitask-${unfinished.id}-1`, answered('Done C.'));
		before.background.finish(`multitask-${unfinished.id}-1`, 'complete', 1);
		await Promise.resolve();
		const saved = before.service.getGroups('main');

		// A new window: the background agents are gone, the stored multitasks are not.
		const after = create(1, [], storage);
		const restored = after.service.getGroups('main');
		const sentOnLoad = after.sent.length;
		// A chat with no message of its own does not reopen: its waiting multitask shows in another chat and sends there.
		const orphaned = create(1, [], storage, false);
		const elsewhere = orphaned.service.getGroups('other').map(group => group.id);
		orphaned.service.sendResults(unfinished.id, 'other');
		after.service.sendResults(unfinished.id, 'main');
		after.service.sendResults(unfinished.id, 'main');
		assert.deepStrictEqual({
			ids: restored.map(group => group.id),
			done: restored[0].runs,
			unfinished: restored[1].runs.map(run => [run.prompt, run.status, run.error]),
			unsent: restored.map(group => group.unsent),
			sentOnLoad,
			sent: after.sent.map(turn => [turn.sessionId, turn.text]),
			compiled: after.sent[0].compiled === multitaskSummaryPrompt([
				{ prompt: 'C', status: 'complete', stopped: false, branchName: `klawly/multitask-${unfinished.id}-1`, filesChanged: 1, added: 3, removed: 1, answer: 'Done C.' },
				{ prompt: 'D', status: 'failed', error: 'Interrupted by a window reload.' },
			]),
			afterSend: after.service.getGroups('main')[1].unsent,
			elsewhere,
			sentElsewhere: orphaned.sent.map(turn => turn.sessionId),
			elsewhereAfterSend: orphaned.service.getGroups('other').map(group => [group.sessionId, group.unsent]),
		}, {
			ids: [done.id, unfinished.id],
			done: saved[0].runs,
			unfinished: [['C', 'complete', undefined], ['D', 'failed', 'Interrupted by a window reload.']],
			unsent: [undefined, true],
			sentOnLoad: 0,
			sent: [['main', 'Combine the results of the 2 parallel tasks.']],
			compiled: true,
			afterSend: undefined,
			elsewhere: [unfinished.id],
			sentElsewhere: ['other'],
			elsewhereAfterSend: [['other', undefined]],
		});
	});

	test('attachments reach the tasks that name them, or every task when none does', () => {
		const file = (path: string): ContextAttachment => ({ kind: 'file', uri: `file:///repo/${path}` });
		const terminal: ContextAttachment = { kind: 'terminal', terminalId: 1, lines: 50, title: 'npm test' };
		const image: ContextAttachment = { kind: 'image', localUri: 'file:///tmp/paste-1.png' };
		const queued: PendingInput[] = [
			{ id: 'q1', text: 'Fix A', attachments: [], behavior: 'queue', createdAt: 0, compiled: 'Fix A\n<file a.ts>' },
			{ id: 'q2', text: 'Fix B', attachments: [], behavior: 'queue', createdAt: 0 },
		];
		const { service, background } = create(4, queued);
		service.runQueued('main', '/repo');
		service.start('main', [{ text: 'Fix C', compiled: 'Fix C\n<file c.ts>' }, 'Fix D'], '/repo');
		assert.deepStrictEqual({
			assigned: assignMultitaskAttachments(
				['Fix the bug in parser.ts', 'Explain why npm test fails', 'Speed up the app module', 'Review parser and app.ts'],
				[file('src/parser.ts'), file('src/app.tsx'), terminal, image],
			),
			// Each prompt's compiled text reaches its background agent; plain prompts stay plain.
			compiled: background.started.map(run => run.options?.compiled),
		}, {
			assigned: [
				[file('src/parser.ts'), image],
				[terminal, image],
				[file('src/app.tsx'), image],
				[file('src/parser.ts'), image],
			],
			compiled: ['Fix A\n<file a.ts>', undefined, 'Fix C\n<file c.ts>', undefined],
		});
	});
});
