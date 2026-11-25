/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BeginClaudeRequest, ClaudeRunHandle, ClaudeUserInput } from '../../../../../platform/claude/common/claude.js';
import { mergeTurnCheckpoints, TurnCheckpoint } from '../../../../../platform/claude/common/claudeCheckpoints.js';
import { FakeClaudeRuntimeService } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { IOutputService } from '../../../output/common/output.js';
import { ClaudeAgentService } from '../../common/claudeAgentService.js';
import { AgentReducerEvent, EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../common/claudeAgentState.js';
import { URI } from '../../../../../base/common/uri.js';
import { ReviewFile } from '../../common/claudeReview.js';
import { claudeRewindCheck, claudeRewindCommitsArgs, claudeRewindCommitsNote, claudeRewindGroups, claudeRewindNote, claudeRewindPickItems, claudeRewindSelection, claudeRewindStatusArgs, claudeRewindTurnIds, claudeShellChangedFiles, parseClaudeRewindCommits } from '../../common/claudeRewind.js';
import { agentWorkspaceStubs } from './claudeAgentTestUtils.js';

suite('Claude rewind (issue 702)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a turn keeps the anchor it completed on, and a rewind drops it, later turns and their subagents', () => {
		const events = threeTurns();
		const state = replay(events);
		const rewound = reduceAgentState(state, { type: 'turn.rewound', turnId: 'turn-2' });
		const missing = reduceAgentState(state, { type: 'turn.rewound', turnId: 'turn-9' });
		assert.deepStrictEqual({
			anchors: state.turns.map(turn => turn.anchor),
			kept: rewound.turns.map(turn => turn.id),
			subagents: rewound.subagents.map(subagent => subagent.run.id),
			subagentsBefore: state.subagents.map(subagent => subagent.run.id),
			unchanged: missing === state,
			dropped: claudeRewindTurnIds(state, 'turn-2'),
		}, {
			anchors: ['a-1', 'a-2', undefined],
			kept: ['turn-1'],
			subagents: [],
			subagentsBefore: ['run-sub'],
			unchanged: true,
			dropped: ['turn-2', 'turn-3'],
		});
	});

	test('a rewind resumes after the reply before the message, from the conversation that wrote it', () => {
		const events = threeTurns();
		const state = replay(events);
		const compacted: AgentReducerEvent[] = [...events, { type: 'session.compacted', sessionId: 'r' }];
		const handedOff: AgentReducerEvent[] = events.map(event => event.type === 'session.completed' && event.anchor === 'a-2' ? { ...event, anchor: undefined } : event);
		const reasons = (check: ReturnType<typeof claudeRewindCheck>) => check.enabled ? check.target : check.reason;
		assert.deepStrictEqual({
			first: reasons(claudeRewindCheck(events, state, 'turn-1')),
			second: reasons(claudeRewindCheck(events, state, 'turn-2')),
			third: reasons(claudeRewindCheck(events, state, 'turn-3')),
			missing: reasons(claudeRewindCheck(events, state, 'turn-9')),
			afterCompaction: reasons(claudeRewindCheck(compacted, replay(compacted), 'turn-3')),
			noPoint: reasons(claudeRewindCheck(handedOff, replay(handedOff), 'turn-3')),
		}, {
			first: {},
			second: { claudeSessionId: 'claude-a', anchor: 'a-1' },
			third: { claudeSessionId: 'claude-b', anchor: 'a-2' },
			missing: 'That message is no longer in the chat.',
			afterCompaction: 'The chat was compacted after this message, so it can\'t go back to it.',
			noPoint: 'Claude Code saved no point to go back to after the reply before this message. Replies handed to another chat, and chats from before this feature, can\'t be edited.',
		});
		const stopped: AgentReducerEvent[] = [
			{ type: 'turn.submitted', turnId: 'turn-1', text: 'One' },
			{ type: 'turn.stopped' },
			{ type: 'turn.submitted', turnId: 'turn-2', text: 'Two' },
		];
		const afterStopped: AgentReducerEvent[] = [...events, { type: 'turn.submitted', turnId: 'turn-4', text: 'Four' }];
		assert.deepStrictEqual({
			firstStopped: reasons(claudeRewindCheck(stopped, replay(stopped), 'turn-2')),
			afterStopped: reasons(claudeRewindCheck(afterStopped, replay(afterStopped), 'turn-4')),
		}, {
			firstStopped: {},
			afterStopped: { claudeSessionId: 'claude-b', anchor: 'a-2' },
		});
	});

	test('kept files become one note for Claude, and none when nothing was kept', () => {
		assert.deepStrictEqual([claudeRewindNote([]), claudeRewindNote(['/repo/a.ts', '/repo/b.ts'])], [
			undefined,
			'The user went back and edited an earlier message. Files changed after it are still on disk: /repo/a.ts, /repo/b.ts. Treat them as they are now; don\'t assume the dropped turns happened.',
		]);
	});

	test('turns merge into one checkpoint: each written file keeps its first snapshot and last write', () => {
		const first: TurnCheckpoint = {
			schemaVersion: 1, id: 'turn-2', sessionId: 's', turnId: 'turn-2', createdAt: 2, files: [
				{ uri: 'file:///repo/a.ts', existed: true, hash: 'a0', afterHash: 'a1', capturedAs: 'write' },
				{ uri: 'file:///repo/dirty.ts', existed: true, hash: 'd0', capturedAs: 'buffer' },
			],
		};
		const second: TurnCheckpoint = {
			schemaVersion: 1, id: 'turn-3', sessionId: 's', turnId: 'turn-3', createdAt: 3, files: [
				{ uri: 'file:///repo/a.ts', existed: true, hash: 'a1', afterHash: 'a2', capturedAs: 'write' },
				{ uri: 'file:///repo/new.ts', existed: false, afterHash: 'n1', capturedAs: 'write' },
			],
		};
		const merged = mergeTurnCheckpoints([first, second]);
		assert.deepStrictEqual({
			id: merged?.id,
			files: merged?.files.map(file => [file.uri, file.hash, file.afterHash]),
			none: mergeTurnCheckpoints([]),
			unwritten: mergeTurnCheckpoints([{ ...first, files: [first.files[1]] }]),
		}, {
			id: 'turn-2',
			files: [['file:///repo/a.ts', 'a0', 'a2'], ['file:///repo/new.ts', undefined, 'n1']],
			none: undefined,
			unwritten: undefined,
		});
	});

	test('rewind drops the turns, starts a copy cut at the reply before, and tells Claude about kept files once', async () => {
		const runtime = store.add(new RecordingRuntime());
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await agent.submit(session.id, 'First', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		await agent.submit(session.id, 'Second', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		const [firstTurn, secondTurn] = agent.getViewState(session.id).turns;
		const claudeId = agent.getCurrentSession()?.claudeSessionId;
		assert.ok(claudeId && firstTurn.anchor);

		const canRewind = agent.canRewind(session.id, secondTurn.id);
		await agent.rewind(session.id, secondTurn.id, ['/repo/a.ts']);
		const afterRewind = agent.getViewState(session.id).turns.map(turn => turn.user.text);
		await agent.submit(session.id, 'Second, edited', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		await agent.submit(session.id, 'Third', '/repo');
		await until(() => agent.getViewState(session.id).turns[2]?.status === 'complete');
		const note = 'The user went back and edited an earlier message. Files changed after it are still on disk: /repo/a.ts.';
		assert.deepStrictEqual({
			canRewind,
			afterRewind,
			// The live query holds the uncut conversation, so the edit starts a new one; later messages follow it up.
			begins: runtime.begins.map(begin => [begin.prompt.startsWith(note) ? 'note' : begin.prompt, begin.resumeSessionId === claudeId, begin.resumeSessionAt]),
			sent: runtime.sent,
			shown: agent.getViewState(session.id).turns.map(turn => turn.user.text),
		}, {
			canRewind: { enabled: true },
			afterRewind: ['First'],
			begins: [['First', false, undefined], ['note', true, firstTurn.anchor]],
			sent: ['Second', 'Third'],
			shown: ['First', 'Second, edited', 'Third'],
		});
	});
	test('an earlier message keeps the attachments it was sent with, so editing it can carry them (issue 1054)', async () => {
		const runtime = store.add(new RecordingRuntime());
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		const attachment = { kind: 'file', uri: 'file:///repo/a.ts' } as const;
		await agent.submit(session.id, 'First', '/repo', { attachments: [attachment] });
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		await agent.submit(session.id, 'Second', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		const [first, second] = agent.getViewState(session.id).turns;
		assert.deepStrictEqual({
			first: agent.getTurnAttachments(session.id, first.id),
			second: agent.getTurnAttachments(session.id, second.id),
			unknown: agent.getTurnAttachments(session.id, 'nope'),
		}, { first: [attachment], second: [], unknown: [] });
	});

	test('Stop before any output takes the message back: it leaves the chat, and its text and attachments return to the composer (issue 948)', async () => {
		const runtime = store.add(new RecordingRuntime());
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await agent.submit(session.id, 'First', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		runtime.stepDelayMs = 60_000;
		const attachment = { kind: 'file', uri: 'file:///repo/a.ts' } as const;
		await agent.submit(session.id, 'Second', '/repo', { attachments: [attachment] });
		const restored: string[] = [];
		store.add(agent.onDidChangeSession(change => change.reason === 'restored' && restored.push(change.reason)));
		const took = await agent.stopAndTakeBack(session.id);
		const after = agent.getCurrentSession();
		assert.deepStrictEqual({
			took,
			turns: agent.getViewState(session.id).turns.map(turn => turn.user.text),
			draft: after?.draft,
			attachments: after?.attachments.map(item => item.kind),
			restored,
		}, {
			took: true,
			turns: ['First'],
			draft: 'Second',
			attachments: ['file'],
			restored: ['restored'],
		});
	});

	test('Stop after output keeps the stopped turn, puts its prompt back, and sending replaces the turn (issue 1178)', async () => {
		const runtime = store.add(new RecordingRuntime());
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await agent.submit(session.id, 'First', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		runtime.stepDelayMs = 40;
		await agent.submit(session.id, 'Second', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.assistantText.length > 0);
		const took = await agent.stopAndTakeBack(session.id);
		const afterStop = {
			took,
			turns: agent.getViewState(session.id).turns.map(turn => [turn.user.text, turn.status]),
			draft: agent.getCurrentSession()?.draft,
			pending: agent.pendingEditTurnId(session.id) !== undefined,
		};
		runtime.stepDelayMs = 0;
		await agent.submit(session.id, 'Better', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		assert.deepStrictEqual({
			afterStop,
			turns: agent.getViewState(session.id).turns.map(turn => [turn.user.text, turn.status]),
			pending: agent.pendingEditTurnId(session.id) !== undefined,
		}, {
			afterStop: { took: true, turns: [['First', 'complete'], ['Second', 'stopped']], draft: 'Second', pending: true },
			turns: [['First', 'complete'], ['Better', 'complete']],
			pending: false,
		});
	});

	test('Stop on a turn that changed files asks Keep or Undo first; Cancel leaves it stopped (issue 1178)', async () => {
		const answers: Array<readonly string[] | undefined> = [['/repo/a.ts'], undefined];
		const results: Array<{ took: boolean; pending: boolean; draft: string | undefined }> = [];
		for (const answer of answers) {
			const runtime = store.add(new RecordingRuntime());
			const stubs = agentWorkspaceStubs();
			stubs[2] = { ...stubs[2], readTurnsChanges: async () => [{}] as never } as typeof stubs[2];
			const agent = store.add(new ClaudeAgentService(runtime, output(), ...stubs));
			const session = agent.createSession();
			await agent.submit(session.id, 'First', '/repo');
			await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
			runtime.stepDelayMs = 40;
			await agent.submit(session.id, 'Second', '/repo');
			await until(() => agent.getViewState(session.id).turns[1]?.assistantText.length > 0);
			const took = await agent.stopAndTakeBack(session.id, async () => answer);
			results.push({ took, pending: agent.pendingEditTurnId(session.id) !== undefined, draft: agent.getCurrentSession()?.draft });
		}
		assert.deepStrictEqual(results, [
			{ took: true, pending: true, draft: 'Second' },
			{ took: false, pending: false, draft: '' },
		]);
	});

	test('A message queued during the stopped turn survives sending the edited prompt (issue 1178)', async () => {
		const runtime = store.add(new RecordingRuntime());
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await agent.submit(session.id, 'First', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		runtime.stepDelayMs = 40;
		await agent.submit(session.id, 'Second', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.assistantText.length > 0);
		await agent.queue(session.id, 'Later', '/repo', 'queue');
		await agent.stopAndTakeBack(session.id);
		const before = agent.getPending(session.id).map(item => item.text);
		runtime.stepDelayMs = 60_000;
		await agent.submit(session.id, 'Better', '/repo');
		assert.deepStrictEqual({ before, after: agent.getPending(session.id).map(item => item.text) }, { before: ['Later'], after: ['Later'] });
	});

	test('Esc after Stop keeps the stopped turn, and the next message is a new turn (issue 1178)', async () => {
		const runtime = store.add(new RecordingRuntime());
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await agent.submit(session.id, 'First', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		runtime.stepDelayMs = 40;
		await agent.submit(session.id, 'Second', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.assistantText.length > 0);
		await agent.stopAndTakeBack(session.id);
		agent.discardPendingEdit(session.id);
		runtime.stepDelayMs = 0;
		await agent.submit(session.id, 'Other', '/repo');
		await until(() => agent.getViewState(session.id).turns[2]?.status === 'complete');
		assert.deepStrictEqual(agent.getViewState(session.id).turns.map(turn => [turn.user.text, turn.status]), [['First', 'complete'], ['Second', 'stopped'], ['Other', 'complete']]);
	});

	test('Edit still goes back to the message after Stop took one back, and sends the edit as the next turn', async () => {
		const runtime = store.add(new RecordingRuntime());
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const session = agent.createSession();
		await agent.submit(session.id, 'First', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		runtime.stepDelayMs = 60_000;
		await agent.submit(session.id, 'Oops', '/repo');
		await agent.stopAndTakeBack(session.id);
		runtime.stepDelayMs = 0;
		await agent.submit(session.id, 'Better', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		assert.deepStrictEqual(agent.getViewState(session.id).turns.map(turn => [turn.user.text, turn.status]), [['First', 'complete'], ['Better', 'complete']]);
	});


	suite('per-file choice and commits (issue 818)', () => {
		const file = (path: string) => ({ uri: URI.file(path), name: path, directory: '', isNew: false, originalText: '', hunks: [], added: 1, removed: 0, state: 'pending' } as unknown as ReviewFile);

		test('files other chats wrote are grouped apart', () => {
			const a = file('/w/a.ts');
			const b = file('/w/b.ts');
			const groups = claudeRewindGroups([a, b], new Set([b.uri.fsPath]));
			assert.deepStrictEqual(claudeRewindPickItems(claudeRewindGroups([a, b], new Set([b.uri.fsPath]), new Set([b.uri.fsPath])))[1].detail, '+1 -0  Also changed by a helper chat');
			assert.deepStrictEqual(groups.own, [a]);
			assert.deepStrictEqual(groups.others, [b]);
		});

		test('picker rows start ticked and show a plain +/- count (issue 1060)', () => {
			const a = file('/w/a.ts');
			const b = file('/w/b.ts');
			assert.deepStrictEqual(claudeRewindPickItems({ own: [a], others: [b], helperPaths: new Set<string>() }), [
				{ id: a.uri.toString(), label: '/w/a.ts', description: '', detail: '+1 -0', picked: true },
				{ id: b.uri.toString(), label: '/w/b.ts', description: '', detail: '+1 -0  Also changed by another chat', picked: false },
			]);
		});

		test('selection restores the picked files and keeps the rest', () => {
			const a = file('/w/a.ts');
			const b = file('/w/b.ts');
			const selection = claudeRewindSelection({ own: [a], others: [b], helperPaths: new Set<string>() }, new Set([a.uri.toString()]));
			assert.deepStrictEqual(selection.restore, [a.uri.toString()]);
			assert.deepStrictEqual(selection.keep, [b.uri.toString()]);
		});

		test('commit log output is parsed and junk lines are skipped', () => {
			const commits = parseClaudeRewindCommits(['abc1234\tFix it', 'not a hash\tx', '', 'fedcba9876\tAdd\tthing', ''].join('\n'));
			assert.deepStrictEqual(commits, [{ hash: 'abc1234', subject: 'Fix it' }, { hash: 'fedcba9876', subject: 'Add\tthing' }]);
			assert.deepStrictEqual(claudeRewindCommitsArgs('abc'), ['log', '--format=%H%x09%s', 'abc..HEAD']);
			assert.strictEqual(claudeRewindCommitsNote([]), '');
			assert.strictEqual(claudeRewindCommitsNote(commits), '\n\nCommits made since this message stay in git:\nabc1234  Fix it\nfedcba9  Add\tthing');
		});
	});

	test('shell changes: new, modified, reverted and unchanged files', () => {
		const before = ' M src/a.ts\n?? notes.md\n';
		const after = ' M src/a.ts\n?? notes.md\n M src/b.ts\n?? out/x.txt\nR  old.ts -> new.ts\n';
		assert.deepStrictEqual(
			[claudeShellChangedFiles(before, after), claudeShellChangedFiles(before, ''), claudeShellChangedFiles('', ''), claudeRewindStatusArgs()],
			[['new.ts', 'out/x.txt', 'src/b.ts'], ['notes.md', 'src/a.ts'], [], ['status', '--porcelain=v1', '--untracked-files=all']]
		);
	});
});

/** Three turns over two Claude Code conversations; the third was stopped, so it has no anchor. */
function threeTurns(): AgentReducerEvent[] {
	return [
		{ type: 'turn.submitted', turnId: 'turn-1', text: 'One' },
		{ type: 'session.started', sessionId: 'r', claudeSessionId: 'claude-a' },
		{ type: 'session.completed', sessionId: 'r', anchor: 'a-1' },
		{ type: 'turn.submitted', turnId: 'turn-2', text: 'Two' },
		{ type: 'session.started', sessionId: 'r', claudeSessionId: 'claude-b' },
		{
			type: 'subagent.started',
			sessionId: 'r',
			parentRunId: 'run-main',
			run: { id: 'run-sub', parentRunId: 'run-main', agentType: 'Explore', description: 'Look', background: false, state: 'running', startedAt: 1, toolCallCount: 0 },
		},
		{ type: 'session.completed', sessionId: 'r', anchor: 'a-2' },
		{ type: 'turn.submitted', turnId: 'turn-3', text: 'Three' },
		{ type: 'turn.stopped' },
	];
}

function replay(events: readonly AgentReducerEvent[]) {
	return events.reduce(reduceAgentState, EMPTY_AGENT_VIEW_STATE);
}

class RecordingRuntime extends FakeClaudeRuntimeService {
	readonly begins: BeginClaudeRequest[] = [];
	/** Follow-ups sent to a running query. */
	readonly sent: string[] = [];

	constructor() {
		super(new Map([
			['plain-answer', [
				'{"type":"session.started","sessionId":"$session","model":"fixture-sonnet"}',
				'{"type":"assistant.completed","sessionId":"$session","text":"Done."}',
				'{"type":"session.completed","sessionId":"$session"}',
			].join('\n')],
		]));
	}

	override async begin(request: BeginClaudeRequest): Promise<ClaudeRunHandle> {
		this.begins.push(request);
		return super.begin(request);
	}

	override async send(sessionId: string, input: ClaudeUserInput): Promise<void> {
		this.sent.push(input.text);
		return super.send(sessionId, input);
	}
}

function output(): IOutputService {
	return { _serviceBrand: undefined, getChannel: () => ({ append: () => undefined }) } as unknown as IOutputService;
}

async function until(read: () => boolean): Promise<void> {
	for (let i = 0; i < 80; i++) {
		if (read()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.fail('timed out waiting for the agent');
}
