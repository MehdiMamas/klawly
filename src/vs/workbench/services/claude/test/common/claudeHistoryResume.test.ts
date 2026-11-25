/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { dirname, join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseChatDrag } from '../../../../../platform/claude/common/claudeChatReference.js';
import { BeginClaudeRequest, ClaudeRunHandle } from '../../../../../platform/claude/common/claude.js';
import { FakeClaudeRuntimeService } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { compilePrompt, compileSubmission, formatSentPrompt } from '../../../../../platform/claude/common/claudePrompt.js';
import { JsonlSessionStore, SessionStorage } from '../../../../../platform/claude/common/claudeSessionStore.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
// eslint-disable-next-line local/code-layering, local/code-import-patterns -- the history load failure test drives the electron-browser contribution
import { ClaudeDurableHistoryContribution } from '../../../../contrib/claude/electron-browser/claudeDurableHistory.js';
import { IOutputService } from '../../../output/common/output.js';
import { exportTranscript, replayDurableEvents } from '../../common/claudeTranscript.js';
import { AgentReducerEvent } from '../../common/claudeAgentState.js';
import { buildTurnReview, ClaudeReviewService } from '../../common/claudeReview.js';
import { IClaudeCheckpointService } from '../../common/claudeCheckpointService.js';
import { deserializeReviews, serializeReviews } from '../../common/claudeReviewPersist.js';
import { agentWorkspaceStubs } from './claudeAgentTestUtils.js';
import { ClaudeAgentService, isClaudeResumeRejection } from '../../common/claudeAgentService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';

suite('Durable session history', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('restart reopens the transcript, sent prompt, and subagent without starting a tool', async () => {
		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		const runtime = store.add(new CountingRuntime());
		const first = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		first.attachDurableHistory(sessions);
		const session = first.createSession();
		await first.submit(session.id, 'Fix the login redirect', '/repo', {
			compiled: '<ide_request mode="agent">\nFix the login redirect\n</ide_request>',
		});
		await until(() => first.getViewState(session.id).turns[0]?.status === 'complete');
		const claudeId = first.getCurrentSession()?.claudeSessionId;
		assert.ok(claudeId);
		await until(() => persisted(disk, sessions, session.id, claudeId));
		first.dispose();

		const beginsBefore = runtime.begins;
		const second = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		second.attachDurableHistory(sessions);
		await second.loadDurableHistory();
		await second.resume(session.id);
		assert.strictEqual(runtime.begins, beginsBefore);
		const turn = second.getViewState(session.id).turns[0];
		assert.strictEqual(turn.user.text, 'Fix the login redirect');
		assert.ok(turn.user.sent?.compiled.includes('Fix the login redirect'));
		assert.ok(formatSentPrompt(turn.user.sent!).includes('<ide_request'));
		assert.ok(second.getSessionEvents(session.id).some(event => event.type === 'turn.submitted'));
		assert.strictEqual(second.getCurrentSession()?.claudeSessionId, claudeId);
	});

	test('a turn written by the Agents window shows up when another window loads the session from the shared history', async () => {
		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		const runtime = store.add(new CountingRuntime());
		const agentsWindow = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		agentsWindow.attachDurableHistory(sessions);
		const session = agentsWindow.createSession();
		await agentsWindow.submit(session.id, 'Rename the helper', '/repo');
		await until(() => agentsWindow.getViewState(session.id).turns[0]?.status === 'complete');
		const claudeId = agentsWindow.getCurrentSession()?.claudeSessionId;
		assert.ok(claudeId);
		await until(() => persisted(disk, sessions, session.id, claudeId));

		const ideWindow = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		ideWindow.attachDurableHistory(sessions);
		await ideWindow.loadDurableHistory();
		await ideWindow.resume(session.id);
		assert.deepStrictEqual(ideWindow.getViewState(session.id).turns.map(turn => turn.user.text), ['Rename the helper']);
	});

	test('a crash marks the open tool interrupted and a failed resume offers a new session', async () => {
		const events: AgentReducerEvent[] = [
			{ type: 'turn.submitted', turnId: 'turn-1', text: 'Edit auth', sent: { compiled: 'Edit auth', mode: 'agent' } },
			{
				type: 'tool.started',
				sessionId: 'runtime',
				call: { id: 'edit-1', name: 'Edit', category: 'write', input: { file_path: 'auth.ts' }, display: { label: 'Edit auth.ts', file: 'auth.ts' } },
			},
			{
				type: 'subagent.started',
				sessionId: 'runtime',
				parentRunId: 'run-parent',
				run: { id: 'run-child', parentRunId: 'run-parent', agentType: 'Explore', description: 'Look around', background: false, state: 'running', startedAt: 1, toolCallCount: 1 },
			},
			{
				type: 'tool.started',
				sessionId: 'runtime',
				parentRunId: 'run-child',
				call: { id: 'read-1', name: 'Read', category: 'read', input: {}, display: { label: 'Read auth.ts', file: 'auth.ts' } },
			},
		];
		const replay = replayDurableEvents(events);
		assert.strictEqual(replay.interrupted, true);
		assert.strictEqual(replay.state.turns[0].cards[0].state, 'interrupted');
		assert.strictEqual(replay.state.subagents[0].run.parentRunId, 'run-parent');
		assert.strictEqual(replay.state.subagents[0].chat.cards[0].state, 'interrupted');
		assert.strictEqual(replay.state.subagents[0].run.state, 'stopped');
		assert.ok(replay.events.at(-1)?.type === 'session.recovered');

		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		const runtime = store.add(new CountingRuntime());
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		agent.attachDurableHistory(sessions);
		const session = agent.createSession();
		await agent.submit(session.id, 'Fix the login redirect', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		const claudeId = agent.getCurrentSession()?.claudeSessionId;
		assert.ok(claudeId);
		await until(() => persisted(disk, sessions, session.id, claudeId));
		agent.dispose();
		runtime.failResume = true;
		const reopened = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		reopened.attachDurableHistory(sessions);
		await reopened.loadDurableHistory();
		await reopened.resume(session.id);
		const begins = runtime.begins;
		await reopened.submit(session.id, 'And again', '/repo');
		await until(() => reopened.getCurrentSession()?.resumeFailed === true);
		assert.ok(runtime.begins > begins);
		assert.ok(runtime.lastBegin?.resumeSessionId);
		const continued = await reopened.continueInNewSession(session.id);
		assert.notStrictEqual(continued, session.id);
		assert.ok(reopened.getSessions().find(item => item.id === continued)?.draft.includes('could not be resumed'));
		assert.strictEqual(reopened.getCurrentSession()?.claudeSessionId, undefined);
	});

	test('export redacts secrets and a saved review hunk stays accepted', () => {
		const review = buildTurnReview('sess-1', 'turn-1', [{
			uri: URI.file('/repo/src/auth.ts'),
			originalText: 'export const token = 1;\n',
			modifiedText: 'export const token = 2;\n',
			existed: true,
		}]);
		review.files[0].hunks[0].state = 'accepted';
		const restored = deserializeReviews(serializeReviews([review]));
		const service = new ClaudeReviewService(emptyCheckpoints(), emptyModels(), emptyFiles(), emptyTextFiles(), new TestConfigurationService());
		store.add(service);
		service.importSaved(restored[0]);
		assert.strictEqual(service.get('sess-1', 'turn-1')?.files[0].hunks[0].state, 'accepted');

		const replay = replayDurableEvents([
			{ type: 'turn.submitted', turnId: 'turn-1', text: 'hello', sent: { compiled: 'hello', mode: 'agent' } },
			{ type: 'assistant.completed', sessionId: 's', text: 'token sk-ant-secretvalue' },
			{ type: 'session.completed', sessionId: 's' },
		]);
		const markdown = exportTranscript(replay.state, 'Fix login').markdown;
		assert.ok(markdown.includes('[redacted]'));
		assert.ok(!markdown.includes('sk-ant-secretvalue'));
		const prompt = compilePrompt({
			userText: 'continue',
			mode: 'agent',
			workspaceRoot: '/repo',
			attachments: [{ kind: 'chat', sessionId: 'missing', reference: { title: 'Gone', sessionId: 'missing', turnStart: 1, turnEnd: 1, asOfTurn: 1, path: '/gone.md', summary: 'x', scope: 'summary', deleted: true, otherWorkspace: false } }],
			diagnostics: [],
			instructionFiles: [],
		});
		assert.ok(!prompt.includes('<chat_reference'));
		const ranged = exportTranscript(replay.state, 'Fix login', { turnRange: [1, 1] });
		assert.ok(!ranged.json.includes('"sent"'));
		const raw = exportTranscript(replay.state, 'Fix login', { raw: true });
		assert.ok(raw.json.includes('"sent"'));
	});

	test('a long stream coalesces deltas and a non-resume error stays retryable', async () => {
		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		const lines = [
			'{"type":"session.started","sessionId":"$session","model":"fixture-sonnet"}',
			...Array.from({ length: 8 }, (_value, index) => `{"type":"assistant.delta","sessionId":"$session","text":"${index}"}`),
			'{"type":"assistant.completed","sessionId":"$session","text":"01234567"}',
			'{"type":"session.completed","sessionId":"$session"}',
		];
		const runtime = store.add(new FakeClaudeRuntimeService(new Map([['plain-answer', lines.join('\n')]])));
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		agent.attachDurableHistory(sessions);
		const session = agent.createSession();
		await agent.submit(session.id, 'Stream', '/repo');
		await until(() => (disk.files.get(sessions.eventsPath(session.id)) ?? '').includes('assistant.completed'));
		const events = disk.files.get(sessions.eventsPath(session.id)) ?? '';
		const deltas = events.split('\n').filter(line => line.includes('assistant.delta'));
		assert.ok(deltas.length > 0 && deltas.length < 8);
		assert.ok(disk.sessionWrites < 8);
		const claudeId = agent.getCurrentSession()?.claudeSessionId;
		assert.ok(claudeId);
		await until(() => persisted(disk, sessions, session.id, claudeId));

		agent.dispose();
		const again = store.add(new CountingRuntime());
		again.failResume = true;
		again.failMessage = 'disk full';
		const reopened = store.add(new ClaudeAgentService(again, output(), ...agentWorkspaceStubs()));
		reopened.attachDurableHistory(sessions);
		await reopened.loadDurableHistory();
		await reopened.resume(session.id);
		let fresh = 0;
		store.add(reopened.onDidStartFreshClaudeSession(() => { fresh++; }));
		await reopened.submit(session.id, 'retry', '/repo');
		await until(() => reopened.getViewState(session.id).turns.at(-1)?.status === 'failed');
		assert.strictEqual(reopened.getCurrentSession()?.resumeFailed, false);
		assert.strictEqual(fresh, 0);
		assert.strictEqual(isClaudeResumeRejection(new Error('disk full')), false);
		assert.strictEqual(isClaudeResumeRejection(new Error('Claude session cannot be resumed')), true);
		assert.strictEqual(isClaudeResumeRejection(new Error('No conversation found with session ID abc')), true);
	});

	test('no conversation found blocks resume until a new session starts', async () => {
		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		const runtime = store.add(new CountingRuntime());
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		agent.attachDurableHistory(sessions);
		const session = agent.createSession();
		await agent.submit(session.id, 'Fix the login redirect', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		const firstId = agent.getCurrentSession()?.claudeSessionId;
		assert.ok(firstId);
		await until(() => persisted(disk, sessions, session.id, firstId));
		agent.dispose();

		runtime.failResume = true;
		runtime.failAsEvent = true;
		runtime.failMessage = 'No conversation found with session ID abc';
		const reopened = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		reopened.attachDurableHistory(sessions);
		await reopened.loadDurableHistory();
		await reopened.resume(session.id);
		await reopened.submit(session.id, 'And again', '/repo');
		await until(() => reopened.getCurrentSession()?.resumeFailed === true);
		assert.strictEqual(runtime.lastBegin?.resumeSessionId, firstId);

		runtime.failResume = false;
		await reopened.submit(session.id, 'Start fresh', '/repo');
		await until(() => reopened.getViewState(session.id).turns.at(-1)?.status === 'complete');
		const freshId = reopened.getCurrentSession()?.claudeSessionId;
		assert.ok(freshId);
		assert.notStrictEqual(freshId, firstId);
		assert.strictEqual(reopened.getCurrentSession()?.resumeFailed, false);
		await until(() => persisted(disk, sessions, session.id, freshId));
		reopened.dispose();
		const resumed = store.add(new CountingRuntime());
		const third = store.add(new ClaudeAgentService(resumed, output(), ...agentWorkspaceStubs()));
		third.attachDurableHistory(sessions);
		await third.loadDurableHistory();
		await third.resume(session.id);
		await third.submit(session.id, 'Resume the fresh id', '/repo');
		await until(() => resumed.lastBegin?.resumeSessionId === freshId);
		assert.strictEqual(third.getCurrentSession()?.resumeFailed, false);
	});

	test('resume passes the Claude Code conversation id, not the runtime session id', async () => {
		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		const runtime = store.add(new CountingRuntime());
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		agent.attachDurableHistory(sessions);
		const session = agent.createSession();
		await agent.submit(session.id, 'Fix the login redirect', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		const claudeId = agent.getCurrentSession()!.claudeSessionId!;
		await until(() => persisted(disk, sessions, session.id, claudeId));
		agent.dispose();

		const reopened = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		reopened.attachDurableHistory(sessions);
		await reopened.loadDurableHistory();
		await reopened.resume(session.id);
		await reopened.submit(session.id, 'And again', '/repo');
		await until(() => reopened.getViewState(session.id).turns.at(-1)?.status === 'complete');
		assert.deepStrictEqual({
			resumed: runtime.lastBegin?.resumeSessionId,
			runtimeId: runtime.handles.includes(claudeId),
			kept: reopened.getCurrentSession()?.claudeSessionId,
		}, { resumed: claudeId, runtimeId: false, kept: claudeId });
	});

	test('a session from the Agents window opens its tab, else its saved chat, else a new tab that resumes it (issue 618)', async () => {
		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		const runtime = store.add(new CountingRuntime());
		await sessions.upsertIndex({ id: 'saved-chat', workspaceId: 'ws', title: 'Saved', updatedAt: 2, mode: 'agent', firstUser: 'Earlier work', open: false, claudeSessionId: 'cc-saved' });
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		agent.attachDurableHistory(sessions);
		await agent.loadDurableHistory();
		const tab = agent.createSession();
		await agent.submit(tab.id, 'Fix the login redirect', '/repo');
		await until(() => agent.getViewState(tab.id).turns[0]?.status === 'complete');
		const claudeId = agent.getSessions().find(session => session.id === tab.id)!.claudeSessionId!;
		const other = agent.createSession();

		const openTab = await agent.openClaudeCodeSession(claudeId);
		const currentAfterTab = agent.getCurrentSession()?.id;
		const savedChat = await agent.openClaudeCodeSession('cc-saved');
		const adopted = await agent.openClaudeCodeSession('cc-agents-window');
		const again = await agent.openClaudeCodeSession('cc-agents-window');
		await agent.submit(adopted.sessionId, 'Carry on', '/repo');
		await until(() => agent.getViewState(adopted.sessionId).turns[0]?.status === 'complete');
		assert.deepStrictEqual({
			openTab,
			currentAfterTab,
			savedChat,
			adopted: adopted.adopted,
			newTab: ![tab.id, other.id, 'saved-chat'].includes(adopted.sessionId),
			again: again.sessionId === adopted.sessionId && !again.adopted,
			title: agent.getSessions().find(session => session.id === adopted.sessionId)?.title,
			resumed: runtime.lastBegin?.resumeSessionId,
		}, {
			openTab: { sessionId: tab.id, adopted: false },
			currentAfterTab: tab.id,
			savedChat: { sessionId: 'saved-chat', adopted: false },
			adopted: true,
			newTab: true,
			again: true,
			title: 'From the Agents Window',
			resumed: 'cc-agents-window',
		});
	});

	test('a turn another window appends to a session reaches this window without a restart (issue 1509)', async () => {
		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		const runtime = store.add(new CountingRuntime());
		const ide = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		ide.attachDurableHistory(sessions);
		const session = ide.createSession();
		await ide.submit(session.id, 'First turn', '/repo');
		await until(() => ide.getViewState(session.id).turns[0]?.status === 'complete');
		const claudeId = ide.getCurrentSession()!.claudeSessionId!;
		await until(() => persisted(disk, sessions, session.id, claudeId));

		const other = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		other.attachDurableHistory(sessions);
		await other.loadDurableHistory();
		await other.resume(session.id);
		await other.submit(session.id, 'Second turn from the other window', '/repo');
		await until(() => other.getViewState(session.id).turns[1]?.status === 'complete');
		await until(() => (disk.files.get(sessions.eventsPath(session.id)) ?? '').split('assistant.completed').length > 2);

		const before = ide.getViewState(session.id).turns.length;
		await ide.syncExternalHistory(session.id);
		const synced = ide.getViewState(session.id).turns.map(turn => turn.user.text);
		await ide.syncExternalHistory(session.id);
		assert.deepStrictEqual({ before, synced, again: ide.getViewState(session.id).turns.length }, {
			before: 1,
			synced: ['First turn', 'Second turn from the other window'],
			again: 2,
		});
	});

	test('a resumed agent runs on the SSH host or dev container it started on', async () => {
		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		const runtime = store.add(new CountingRuntime());
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		agent.attachDurableHistory(sessions);
		const session = agent.createSession();
		agent.setExecutionTarget(session.id, { kind: 'ssh', host: 'build-box', remotePath: '/srv/shop' });
		await agent.submit(session.id, 'Fix the login redirect', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		const claudeId = agent.getCurrentSession()!.claudeSessionId!;
		await until(() => persisted(disk, sessions, session.id, claudeId));
		agent.dispose();

		const reopened = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		reopened.attachDurableHistory(sessions);
		await reopened.loadDurableHistory();
		await reopened.resume(session.id);
		await reopened.submit(session.id, 'And again', '/repo');
		await until(() => reopened.getViewState(session.id).turns.at(-1)?.status === 'complete');
		assert.deepStrictEqual({ resumed: runtime.lastBegin?.resumeSessionId, target: runtime.lastBegin?.executionTarget }, { resumed: claudeId, target: { kind: 'ssh', host: 'build-box', remotePath: '/srv/shop' } });
	});

	test('a plugin change lists on chats whose query runs, and Restart Session resumes the next turn in a new query', async () => {
		const runtime = store.add(new CountingRuntime());
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const started = agent.createSession();
		await agent.submit(started.id, 'Fix the login redirect', '/repo');
		await until(() => agent.getViewState(started.id).turns[0]?.status === 'complete');
		const claudeId = agent.getSessions().find(session => session.id === started.id)?.claudeSessionId;
		const notStarted = agent.createSession();
		const reasons: string[] = [];
		store.add(agent.onDidChangeSession(change => reasons.push(change.reason)));

		agent.notePluginChange('commit-commands', false);
		agent.notePluginChange('lint', true);
		agent.notePluginChange('commit-commands', false);
		const listed = { started: agent.getPluginChanges(started.id), notStarted: agent.getPluginChanges(notStarted.id) };
		agent.restartSession(started.id);
		// A session already set to restart loads this one too.
		agent.notePluginChange('later', false);
		const fired = [...reasons];
		const afterRestart = agent.getPluginChanges(started.id);
		await agent.submit(started.id, 'And again', '/repo');
		await until(() => agent.getViewState(started.id).turns.at(-1)?.status === 'complete');

		assert.deepStrictEqual({ listed, afterRestart, fired, begins: runtime.begins, resumed: runtime.lastBegin?.resumeSessionId }, {
			listed: {
				started: [{ plugin: 'lint', removed: true }, { plugin: 'commit-commands', removed: false }],
				notStarted: [],
			},
			afterRestart: [],
			fired: ['plugins', 'plugins', 'plugins', 'plugins'],
			begins: 2,
			resumed: claudeId,
		});
	});

	test('a chat opened to try a plugin passes its folder with every query, and other chats pass none', async () => {
		const runtime = store.add(new CountingRuntime());
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const trial = agent.createSession({ plugins: ['/cache/claude-plugin-trials/team/lint'] });
		await agent.submit(trial.id, 'Lint this file', '/repo');
		await until(() => agent.getViewState(trial.id).turns[0]?.status === 'complete');
		const first = runtime.lastBegin?.plugins;
		agent.restartSession(trial.id);
		agent.notePluginChange('lint', false);
		agent.restartSession(trial.id);
		await agent.submit(trial.id, 'Again', '/repo');
		await until(() => agent.getViewState(trial.id).turns.at(-1)?.status === 'complete');
		const resumed = runtime.lastBegin?.plugins;
		const plain = agent.createSession();
		await agent.submit(plain.id, 'Hello', '/repo');
		await until(() => agent.getViewState(plain.id).turns[0]?.status === 'complete');

		assert.deepStrictEqual({ first, resumed, plain: runtime.lastBegin?.plugins, begins: runtime.begins }, {
			first: ['/cache/claude-plugin-trials/team/lint'],
			resumed: ['/cache/claude-plugin-trials/team/lint'],
			plain: undefined,
			begins: 3,
		});
	});

	test('a restart reopens only the open tabs of this workspace, and closed chats stay in history', async () => {
		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		const runtime = store.add(new CountingRuntime());
		const first = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		first.attachDurableHistory(sessions);
		const kept = first.createSession();
		await first.submit(kept.id, 'Keep this tab', '/repo');
		await until(() => first.getViewState(kept.id).turns[0]?.status === 'complete');
		const closed = first.createSession();
		await first.submit(closed.id, 'Close this tab', '/repo');
		await until(() => first.getViewState(closed.id).turns[0]?.status === 'complete');
		await until(() => openFlags(disk, sessions).get(closed.id) === true);
		first.closeSession(closed.id);
		await until(() => openFlags(disk, sessions).get(closed.id) === false);
		await sessions.upsertIndex({ id: 'elsewhere', workspaceId: 'other-ws', title: 'Elsewhere', updatedAt: 3, mode: 'agent', firstUser: 'Other work', open: true });
		first.dispose();

		const second = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		second.attachDurableHistory(sessions);
		const empty = second.createSession();
		await second.loadDurableHistory();
		const tabs = second.getSessions().map(session => session.id);
		const exported = await second.exportSession(closed.id, 'markdown');
		const mentioned = second.listChatMentions('Close').map(item => item.id);
		await second.renameSession(closed.id, 'Closed and renamed');
		await second.submit(kept.id, 'And more', '/repo');
		await until(() => second.getViewState(kept.id).turns.at(-1)?.status === 'complete');
		assert.deepStrictEqual({
			tabs,
			current: second.getCurrentSession()?.id,
			emptyKept: second.getHistory().some(session => session.id === empty.id),
			history: second.getHistory().map(session => session.id).sort(),
			exported: exported.includes('Close this tab'),
			tabsAfterExport: second.getSessions().map(session => session.id),
			mentioned,
			renamed: second.getHistory().find(session => session.id === closed.id)?.title,
			turns: second.getViewState(kept.id).turns.map(turn => turn.user.text),
		}, {
			tabs: [kept.id],
			current: kept.id,
			emptyKept: false,
			history: [closed.id, 'elsewhere', kept.id].sort(),
			exported: true,
			tabsAfterExport: [kept.id],
			mentioned: [closed.id],
			renamed: 'Closed and renamed',
			turns: ['Keep this tab', 'And more'],
		});
	});

	test('a restored tab closed before its transcript loads is saved as closed and keeps its summary', async () => {
		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		await sessions.append('sess-open', { type: 'turn.submitted', turnId: 'turn-1', text: 'Keep this tab' });
		await sessions.upsertIndex({ id: 'sess-open', workspaceId: URI.file('/work/project').toString(), title: 'Open', updatedAt: 1, mode: 'agent', firstUser: 'Keep this tab', turnCount: 1, open: true });
		const agent = store.add(new ClaudeAgentService(store.add(new CountingRuntime()), output(), ...agentWorkspaceStubs()));
		agent.attachDurableHistory(sessions);
		await agent.loadDurableHistory();
		const restored = agent.getSessions().map(session => session.id);
		agent.closeSession('sess-open');
		await until(() => openFlags(disk, sessions).get('sess-open') === false);
		const record = (await sessions.readIndex()).sessions.find(candidate => candidate.id === 'sess-open');
		assert.deepStrictEqual({ restored, open: record?.open, firstUser: record?.firstUser, history: agent.getHistory().map(session => session.id) }, {
			restored: ['sess-open'], open: false, firstUser: 'Keep this tab', history: ['sess-open'],
		});
	});

	test('#82: a history action on a closed chat whose transcript fails to load does not bring it back as a tab', async () => {
		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		await sessions.append('sess-closed', { type: 'turn.submitted', turnId: 'turn-1', text: 'Closed before' });
		await sessions.upsertIndex({ id: 'sess-closed', workspaceId: URI.file('/work/project').toString(), title: 'Closed', updatedAt: 1, mode: 'agent', firstUser: 'Closed before', turnCount: 1, open: false });
		const agent = store.add(new ClaudeAgentService(store.add(new CountingRuntime()), output(), ...agentWorkspaceStubs()));
		agent.attachDurableHistory(sessions);
		const empty = agent.createSession();
		await agent.loadDurableHistory();
		disk.failReads = sessions.eventsPath('sess-closed');
		const failed = await agent.exportSession('sess-closed', 'markdown').then(() => false, () => true);
		disk.failReads = undefined;
		assert.deepStrictEqual({ failed, tabs: agent.getSessions().map(session => session.id), open: openFlags(disk, sessions).get('sess-closed') }, {
			failed: true, tabs: [empty.id], open: false,
		});
	});

	test('#82: pin and archive persist for open and closed chats, archiving closes the tab, and opening unarchives', async () => {
		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		const runtime = store.add(new CountingRuntime());
		const first = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		first.attachDurableHistory(sessions);
		const pinned = first.createSession();
		await first.submit(pinned.id, 'Pin this tab', '/repo');
		await until(() => first.getViewState(pinned.id).turns[0]?.status === 'complete');
		const archived = first.createSession();
		await first.submit(archived.id, 'Archive this tab', '/repo');
		await until(() => first.getViewState(archived.id).turns[0]?.status === 'complete');
		const closed = first.createSession();
		await first.submit(closed.id, 'Pin this closed chat', '/repo');
		await until(() => first.getViewState(closed.id).turns[0]?.status === 'complete');
		first.closeSession(closed.id);
		await until(() => openFlags(disk, sessions).get(closed.id) === false);
		first.setPinned(pinned.id, true);
		first.setArchived(archived.id, true);
		first.setPinned(closed.id, true);
		const tabs = first.getSessions().map(session => session.id);
		const saved = () => savedFlags(disk, sessions, [pinned.id, archived.id, closed.id]);
		// Pinned and open; archived and closed; pinned and closed.
		await until(() => saved().join() === 'true/false/true,false/true/false,true/false/false');
		first.dispose();

		const second = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		second.attachDurableHistory(sessions);
		await second.loadDurableHistory();
		const restored = (id: string) => second.getHistory().find(session => session.id === id);
		const afterRestart = [pinned.id, archived.id, closed.id].map(id => `${!!restored(id)?.pinned}/${!!restored(id)?.archived}`);
		const restoredTabs = second.getSessions().map(session => session.id);
		second.selectSession(archived.id);
		await second.resume(archived.id);
		assert.deepStrictEqual({
			tabs,
			afterRestart,
			restoredTabs,
			reopened: [second.getSessions().some(session => session.id === archived.id), !!restored(archived.id)?.archived],
		}, {
			tabs: [pinned.id],
			afterRestart: ['true/false', 'false/true', 'true/false'],
			restoredTabs: [pinned.id],
			reopened: [true, false],
		});
	});

	test('#82: a chat from a window with no folder shows Empty Window, not the window id', async () => {
		const sessions = new JsonlSessionStore('/data', new MemorySessionStorage());
		await sessions.upsertIndex({ id: 'sess-empty', workspaceId: '1791331969142', workspaceName: '1791331969142', title: 'Loose', updatedAt: 1, mode: 'agent', firstUser: 'Hi' });
		const agent = store.add(new ClaudeAgentService(store.add(new CountingRuntime()), output(), ...agentWorkspaceStubs()));
		agent.attachDurableHistory(sessions);
		await agent.loadDurableHistory();
		assert.strictEqual(agent.getHistory().find(session => session.id === 'sess-empty')?.workspaceName, 'Empty Window');
	});

	test('interrupted stays set across two reopens until a new turn', async () => {
		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		const sessionId = 'sess-cut';
		await sessions.append(sessionId, { type: 'turn.submitted', turnId: 'turn-1', text: 'Edit auth' });
		await sessions.append(sessionId, {
			type: 'tool.started',
			sessionId: 'runtime',
			call: { id: 'edit-1', name: 'Edit', category: 'write', input: {}, display: { label: 'Edit auth.ts', file: 'auth.ts' } },
		});
		await sessions.writeSession({
			id: sessionId, workspaceId: 'ws', title: 'Cut', mode: 'agent', createdAt: 1, updatedAt: 2, status: 'running', turns: [], checkpointIds: ['turn-1'],
		});
		await sessions.upsertIndex({ id: sessionId, workspaceId: 'ws', title: 'Cut', updatedAt: 2, mode: 'agent' });

		const open = async () => {
			const runtime = store.add(new CountingRuntime());
			const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
			agent.attachDurableHistory(sessions);
			await agent.loadDurableHistory();
			await agent.resume(sessionId);
			return agent;
		};
		const first = await open();
		assert.strictEqual(first.getCurrentSession()?.interrupted, true);
		assert.strictEqual(first.getViewState(sessionId).turns[0].cards[0].state, 'interrupted');
		first.dispose();
		const second = await open();
		assert.strictEqual(second.getCurrentSession()?.interrupted, true);
		assert.strictEqual((disk.files.get(sessions.eventsPath(sessionId)) ?? '').split('session.recovered').length - 1, 1);
		await second.submit(sessionId, 'Continue after the crash', '/repo');
		await until(() => second.getViewState(sessionId).turns.at(-1)?.status === 'complete');
		await until(() => (disk.files.get(sessions.eventsPath(sessionId)) ?? '').includes('session.completed'));
		assert.strictEqual(second.getCurrentSession()?.interrupted, false);
		second.dispose();
		const third = await open();
		assert.strictEqual(third.getCurrentSession()?.interrupted, false);
	});

	test('a single-turn reference contains only that turn', async () => {
		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		const runtime = store.add(new CountingRuntime());
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		agent.attachDurableHistory(sessions);
		const session = agent.createSession();
		await agent.submit(session.id, 'Fix the login redirect', '/repo');
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		await agent.submit(session.id, 'Add a logout button', '/repo');
		await until(() => agent.getViewState(session.id).turns[1]?.status === 'complete');
		await agent.renameSession(session.id, 'Renamed login');
		const composer = agent.createSession();
		const reference = await agent.prepareChatReference(composer.id, {
			kind: 'chat', sessionId: session.id, scope: 'full', asOfTurn: 2, turnRange: [2, 2], title: 'Renamed login',
		});
		assert.ok(reference.fullTranscript?.includes('Add a logout button'));
		assert.ok(!reference.fullTranscript?.includes('Fix the login redirect'));
		assert.strictEqual(disk.files.get(reference.path)?.includes('Fix the login redirect'), false);
	});

	test('history actions, chat references, and a mid-turn fork keep checkpoint and review', async () => {
		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		const runtime = store.add(new CountingRuntime());
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		let revealed: string | undefined;
		agent.attachDurableHistory(sessions, async path => { revealed = path; });
		const session = agent.createSession();
		await agent.submit(session.id, 'Fix the login redirect', '/repo', { compiled: 'compiled-prompt-body' });
		await until(() => agent.getViewState(session.id).turns[0]?.status === 'complete');
		await agent.renameSession(session.id, 'Renamed login');
		assert.strictEqual(agent.getSessions().find(item => item.id === session.id)?.title, 'Renamed login');
		const markdown = await agent.exportSession(session.id, 'markdown');
		const json = await agent.exportSession(session.id, 'json');
		assert.ok(markdown.includes('Fix the login redirect'));
		assert.ok(!json.includes('compiled-prompt-body'));
		const mentions = agent.listChatMentions('Renamed');
		assert.ok(mentions.some(item => item.id === session.id));
		const drag = parseChatDrag(JSON.stringify({ sessionId: session.id, asOfTurn: 1, turnId: 'turn-1' }));
		assert.strictEqual(drag?.sessionId, session.id);
		assert.strictEqual(parseChatDrag('not-json'), undefined);

		const composer = agent.createSession();
		const summary = await agent.prepareChatReference(composer.id, {
			kind: 'chat', sessionId: session.id, scope: 'summary', asOfTurn: 1, turnRange: [1, 1], title: 'Renamed login',
		});
		const full = await agent.prepareChatReference(composer.id, {
			kind: 'chat', sessionId: session.id, scope: 'full', asOfTurn: 1, turnRange: [1, 1], title: 'Renamed login',
		});
		assert.notStrictEqual(summary.path, full.path);
		assert.ok(summary.path.includes('summary'));
		assert.ok(full.path.includes('full'));
		assert.ok(agent.getSessions().find(item => item.id === composer.id)?.additionalDirectories.includes(summary.path));
		assert.ok(agent.getSessions().find(item => item.id === composer.id)?.additionalDirectories.includes(full.path));
		const summaryPrompt = compilePrompt({
			userText: 'use it', mode: 'agent', workspaceRoot: '/repo',
			attachments: [{ kind: 'chat', sessionId: session.id, reference: summary }],
			diagnostics: [], instructionFiles: [],
		});
		const fullPrompt = compileSubmission({
			userText: 'use it', mode: 'agent', workspaceRoot: '/repo',
			attachments: [{ kind: 'chat', sessionId: session.id, reference: full }],
			diagnostics: [], instructionFiles: [],
		});
		assert.ok(summaryPrompt.includes('<chat_reference '));
		assert.ok(!summaryPrompt.includes('## Fix the login redirect'));
		assert.ok(fullPrompt.includes('Fix the login redirect'));
		const missing = await agent.prepareChatReference(composer.id, {
			kind: 'chat', sessionId: 'missing-session', scope: 'summary', asOfTurn: 1, turnRange: [1, 1],
		});
		assert.strictEqual(missing.deleted, true);

		const forked = await agent.forkSession(session.id, agent.getViewState(session.id).turns[0].id);
		assert.notStrictEqual(forked, session.id);
		await agent.submit(forked, 'Now the logout page', '/repo');
		await until(() => agent.getViewState(forked).turns.at(-1)?.status === 'complete');
		const firstForkPrompt = runtime.lastBegin?.prompt ?? '';
		await agent.submit(forked, 'And the footer', '/repo');
		await until(() => agent.getViewState(forked).turns.at(-1)?.status === 'complete');
		assert.deepStrictEqual({
			draft: agent.getSessions().find(item => item.id === forked)?.draft,
			summarySent: firstForkPrompt.includes('You do not have its transcript') && firstForkPrompt.endsWith('Now the logout page'),
			shown: agent.getViewState(forked).turns.slice(-2).map(turn => turn.user.text),
			summaryOnce: agent.getViewState(forked).turns.at(-1)?.user.sent?.compiled,
		}, {
			draft: '',
			summarySent: true,
			shown: ['Now the logout page', 'And the footer'],
			summaryOnce: 'And the footer',
		});

		await agent.deleteSession(session.id);
		assert.ok(!agent.getSessions().some(item => item.id === session.id));

		const blocked = 'sess-mid';
		await sessions.append(blocked, { type: 'turn.submitted', turnId: 'turn-1', text: 'Edit auth' });
		await sessions.append(blocked, {
			type: 'tool.started',
			sessionId: 'runtime',
			call: { id: 'edit-1', name: 'Edit', category: 'write', input: {}, display: { label: 'Edit auth.ts', file: 'auth.ts' } },
		});
		await sessions.writeSession({
			id: blocked, workspaceId: 'other-ws', title: 'Mid', mode: 'agent', createdAt: 1, updatedAt: 2, status: 'running', turns: [], checkpointIds: ['turn-1'],
		});
		await sessions.upsertIndex({
			id: blocked, workspaceId: 'other-ws', workspaceName: 'Other', title: 'Mid', updatedAt: 2, mode: 'agent', worktree: { path: '/tmp/agent-wt' },
		});
		const review = buildTurnReview(blocked, 'turn-1', [{
			uri: URI.file('/repo/src/auth.ts'),
			originalText: 'a\n',
			modifiedText: 'b\n',
			existed: true,
		}]);
		await sessions.writeReviews(blocked, serializeReviews([review]));
		const checkpointPath = join(dirname(sessions.eventsPath(blocked)), 'checkpoints', 'turn-1.json');
		await disk.write(checkpointPath, JSON.stringify({ schemaVersion: 1, id: 'turn-1', sessionId: blocked, turnId: 'turn-1', createdAt: 1, files: [] }));
		await agent.loadDurableHistory();
		await agent.revealWorktree(blocked);
		assert.strictEqual(revealed, '/tmp/agent-wt');
		const other = await agent.prepareChatReference(composer.id, {
			kind: 'chat', sessionId: blocked, scope: 'summary', asOfTurn: 1, turnRange: [1, 1], title: 'Mid', workspaceName: 'Other',
		});
		assert.strictEqual(other.otherWorkspace, true);
		assert.ok(!other.summary.includes('Fix the login redirect'));
		const forkId = await agent.forkSession(blocked, 'turn-1');
		assert.strictEqual(agent.getViewState(forkId).turns[0].cards[0].state, 'interrupted');
		const copied = disk.files.get(join(dirname(sessions.eventsPath(forkId)), 'checkpoints', 'turn-1.json')) ?? '';
		assert.ok(copied.includes(forkId));
		assert.ok(!copied.includes(`"sessionId":"${blocked}"`) || copied.includes(forkId));
		const copiedReviews = disk.files.get(sessions.reviewsFile(forkId)) ?? '';
		assert.ok(copiedReviews.includes(forkId));
		assert.ok(copiedReviews.includes('pending') || copiedReviews.includes('auth.ts'));
	});

	test('one load recovers once, and reviews follow the changed session', async () => {
		const files = new MapFileService();
		const storage = files.storage();
		const sessions = new JsonlSessionStore('/data', storage);
		const sessionId = 'sess-review';
		await sessions.append(sessionId, { type: 'turn.submitted', turnId: 'turn-1', text: 'Edit auth' });
		await sessions.append(sessionId, {
			type: 'tool.started',
			sessionId: 'runtime',
			call: { id: 'edit-1', name: 'Edit', category: 'write', input: {}, display: { label: 'Edit auth.ts', file: 'auth.ts' } },
		});
		await sessions.writeSession({
			id: sessionId, claudeSessionId: 'claude-review', workspaceId: 'ws', title: 'Review', mode: 'agent', createdAt: 1, updatedAt: 2, status: 'running', turns: [], checkpointIds: ['turn-1'],
		});
		await sessions.upsertIndex({ id: sessionId, workspaceId: 'ws', workspaceName: 'ws', title: 'Review', updatedAt: 2, mode: 'agent', claudeSessionId: 'claude-review', checkpointIds: ['turn-1'], firstUser: 'Edit auth' });
		const built = buildTurnReview(sessionId, 'turn-1', [{
			uri: URI.file('/repo/src/auth.ts'),
			originalText: 'a\n',
			modifiedText: 'b\n',
			existed: true,
		}]);
		await sessions.writeReviews(sessionId, serializeReviews([built]));
		await storage.write(join('/data', 'agent-sessions', sessionId, 'checkpoints', 'turn-1.json'), JSON.stringify({ schemaVersion: 1, id: 'turn-1', sessionId, turnId: 'turn-1', createdAt: 1, files: [{ uri: 'file:///repo/src/auth.ts' }] }));

		const runtime = store.add(new CountingRuntime());
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const review = store.add(new ClaudeReviewService(emptyCheckpoints(), emptyModels(), emptyFiles(), emptyTextFiles(), new TestConfigurationService()));
		store.add(new ClaudeDurableHistoryContribution(
			agent,
			{ userDataPath: '/data' } as never,
			files.asFileService(),
			{ showItemInFolder: async () => undefined } as never,
			review,
			noComparisons(),
			quietLog() as never,
		));
		await until(() => agent.getHistory().some(item => item.id === sessionId));
		const first = agent.resume(sessionId);
		const second = agent.resume(sessionId);
		await Promise.all([first, second]);
		const textAt = (path: string) => storage.files.get(URI.file(path).fsPath) ?? '';
		const recovered = textAt(sessions.eventsPath(sessionId)).split('session.recovered').length - 1;
		assert.strictEqual(recovered, 1);
		assert.strictEqual(agent.getViewState(sessionId).turns[0].cards[0].state, 'interrupted');
		await until(() => review.get(sessionId, 'turn-1')?.files[0].hunks[0].state === 'pending');
		agent.createSession();
		const hunkId = review.get(sessionId, 'turn-1')!.files[0].hunks[0].id;
		review.acceptHunk(sessionId, 'turn-1', hunkId);
		await until(() => textAt(sessions.reviewsFile(sessionId)).includes('"accepted"'));
		assert.ok(!textAt(sessions.reviewsFile(agent.getCurrentSession()!.id)).includes(sessionId));

		const reopenedAgent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const reopenedReview = store.add(new ClaudeReviewService(emptyCheckpoints(), emptyModels(), emptyFiles(), emptyTextFiles(), new TestConfigurationService()));
		store.add(new ClaudeDurableHistoryContribution(
			reopenedAgent,
			{ userDataPath: '/data' } as never,
			files.asFileService(),
			{ showItemInFolder: async () => undefined } as never,
			reopenedReview,
			noComparisons(),
			quietLog() as never,
		));
		await until(() => reopenedAgent.getHistory().some(item => item.id === sessionId));
		await reopenedAgent.resume(sessionId);
		await until(() => reopenedReview.get(sessionId, 'turn-1')?.files[0].hunks[0].state === 'accepted');
		const checkpoint = textAt(join('/data', 'agent-sessions', sessionId, 'checkpoints', 'turn-1.json'));
		assert.ok(checkpoint.includes('turn-1'));
		assert.ok(checkpoint.includes('auth.ts'));
		assert.strictEqual(reopenedAgent.getCurrentSession()?.claudeSessionId, 'claude-review');
	});

	test('a failed history load is logged', async () => {
		const files = new MapFileService();
		files.explodeReads = true;
		const logs: string[] = [];
		const runtime = store.add(new CountingRuntime());
		const agent = store.add(new ClaudeAgentService(runtime, output(), ...agentWorkspaceStubs()));
		const review = store.add(new ClaudeReviewService(emptyCheckpoints(), emptyModels(), emptyFiles(), emptyTextFiles(), new TestConfigurationService()));
		store.add(new ClaudeDurableHistoryContribution(
			agent,
			{ userDataPath: '/data' } as never,
			files.asFileService(),
			{ showItemInFolder: async () => undefined } as never,
			review,
			noComparisons(),
			{ error: (message: string) => { logs.push(message); } } as never,
		));
		await until(() => logs.some(line => line.includes('Claude history failed to load')));
	});
});

function noComparisons(): never {
	return { attachDurableHistory: async () => undefined } as never;
}

class CountingRuntime extends FakeClaudeRuntimeService {
	begins = 0;
	failResume = false;
	failAsEvent = false;
	failMessage = 'Claude session cannot be resumed';
	lastBegin: BeginClaudeRequest | undefined;
	/** The runtime session ids `begin()` handed out. */
	readonly handles: string[] = [];

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
		this.begins++;
		this.lastBegin = request;
		if (this.failResume && request.resumeSessionId) {
			if (this.failAsEvent) {
				const handle = { sessionId: `resume-${this.begins}` };
				this.emitEvent({ type: 'session.failed', sessionId: handle.sessionId, message: this.failMessage });
				return handle;
			}
			throw new Error(this.failMessage);
		}
		const handle = await super.begin(request);
		this.handles.push(handle.sessionId);
		return handle;
	}
}

function emptyCheckpoints(): IClaudeCheckpointService {
	return {
		_serviceBrand: undefined,
		captureDirtyBuffers: async () => [],
		restore: async () => false,
		readCheckpointOriginals: async () => [],
		readTurnsChanges: async () => [],
		readOtherChatPaths: async () => new Set<string>(), readHelperTurnIds: async () => [], readTurnGitHead: async () => undefined,
		restoreTurns: async () => true,
	};
}

function emptyModels(): ConstructorParameters<typeof ClaudeReviewService>[1] {
	return { createModelReference: async () => { throw new Error('no model'); } } as unknown as ConstructorParameters<typeof ClaudeReviewService>[1];
}

function emptyFiles(): ConstructorParameters<typeof ClaudeReviewService>[2] {
	return { exists: async () => false } as unknown as ConstructorParameters<typeof ClaudeReviewService>[2];
}

function emptyTextFiles(): ConstructorParameters<typeof ClaudeReviewService>[3] {
	return { isDirty: () => false } as unknown as ConstructorParameters<typeof ClaudeReviewService>[3];
}

function quietLog(): { error(message: string): void } {
	return { error: () => undefined };
}

function output(): IOutputService {
	return { _serviceBrand: undefined, getChannel: () => ({ append: () => undefined }) } as unknown as IOutputService;
}

function persisted(disk: MemorySessionStorage, sessions: JsonlSessionStore, sessionId: string, claudeId: string): boolean {
	const events = disk.files.get(sessions.eventsPath(sessionId)) ?? '';
	const meta = disk.files.get(sessions.sessionFile(sessionId)) ?? '';
	const index = disk.files.get(sessions.indexPath()) ?? '';
	return events.includes('assistant.completed') && meta.includes(claudeId) && index.includes(sessionId);
}

/** Each indexed session's `open` flag, read from the index file as written. */
function openFlags(disk: MemorySessionStorage, sessions: JsonlSessionStore): Map<string, boolean | undefined> {
	const text = disk.files.get(sessions.indexPath());
	const parsed: { sessions?: { id: string; open?: boolean }[] } = text ? JSON.parse(text) : {};
	return new Map((parsed.sessions ?? []).map(record => [record.id, record.open]));
}

/** Pinned, archived and open, as saved in the index, for each id. */
function savedFlags(disk: MemorySessionStorage, sessions: JsonlSessionStore, ids: readonly string[]): string[] {
	const text = disk.files.get(sessions.indexPath());
	const parsed: { sessions?: { id: string; open?: boolean; pinned?: boolean; archived?: boolean }[] } = text ? JSON.parse(text) : {};
	const records = new Map((parsed.sessions ?? []).map(record => [record.id, record]));
	return ids.map(id => records.get(id)).map(record => `${!!record?.pinned}/${!!record?.archived}/${!!record?.open}`);
}

async function until(read: () => boolean): Promise<void> {
	for (let i = 0; i < 80; i++) {
		if (read()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.fail('timed out waiting for history');
}

class MemorySessionStorage implements SessionStorage {
	readonly files = new Map<string, string>();
	sessionWrites = 0;
	/** Reads of paths that contain this text fail. */
	failReads: string | undefined;

	read(path: string): Promise<string | undefined> {
		if (this.failReads && path.includes(this.failReads)) {
			return Promise.reject(new Error('unreadable'));
		}
		return Promise.resolve(this.files.get(path));
	}

	write(path: string, text: string): Promise<void> {
		if (path.includes('session.json')) {
			this.sessionWrites++;
		}
		this.files.set(path, text);
		return Promise.resolve();
	}

	append(path: string, text: string): Promise<void> {
		this.files.set(path, (this.files.get(path) ?? '') + text);
		return Promise.resolve();
	}

	rename(from: string, to: string): Promise<void> {
		const text = this.files.get(from);
		if (text === undefined) {
			return Promise.reject(new Error('missing'));
		}
		this.files.set(to, text);
		this.files.delete(from);
		return Promise.resolve();
	}

	mkdir(): Promise<void> {
		return Promise.resolve();
	}

	remove(path: string): Promise<void> {
		for (const key of [...this.files.keys()]) {
			if (key === path || key.startsWith(`${path}/`) || key.startsWith(`${path}\\`)) {
				this.files.delete(key);
			}
		}
		return Promise.resolve();
	}

	list(dir: string): Promise<readonly string[]> {
		const names = new Set<string>();
		for (const key of this.files.keys()) {
			if (!key.startsWith(dir)) {
				continue;
			}
			const rest = key.slice(dir.length).replace(/^[/\\]/, '');
			if (rest) {
				names.add(rest.split(/[/\\]/)[0]);
			}
		}
		return Promise.resolve([...names]);
	}
}

/** File service and session storage over one map, so the history contribution and the test share bytes. */
class MapFileService {
	private readonly files = new Map<string, string>();
	explodeReads = false;

	storage(): SessionStorage & { readonly files: Map<string, string> } {
		const files = this.files;
		const keyOf = (path: string) => URI.file(path).fsPath;
		return {
			files,
			read: async path => files.get(keyOf(path)),
			write: async (path, text) => { files.set(keyOf(path), text); },
			append: async (path, text) => {
				const key = keyOf(path);
				files.set(key, (files.get(key) ?? '') + text);
			},
			rename: async (from, to) => {
				const text = files.get(keyOf(from));
				if (text === undefined) {
					throw new Error('missing');
				}
				files.set(keyOf(to), text);
				files.delete(keyOf(from));
			},
			mkdir: async () => undefined,
			remove: async path => {
				const prefix = keyOf(path);
				for (const key of [...files.keys()]) {
					if (key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}\\`)) {
						files.delete(key);
					}
				}
			},
			list: async dir => {
				const prefix = keyOf(dir);
				const names = new Set<string>();
				for (const key of files.keys()) {
					if (!key.startsWith(prefix)) {
						continue;
					}
					const rest = key.slice(prefix.length).replace(/^[/\\]/, '');
					if (rest) {
						names.add(rest.split(/[/\\]/)[0]);
					}
				}
				return [...names];
			},
		};
	}

	asFileService(): IFileService {
		const files = this.files;
		const explode = () => this.explodeReads;
		const file = (resource: URI) => resource.fsPath;
		return {
			onDidFilesChange: Event.None,
			watch: () => Disposable.None,
			exists: async (resource: URI) => explode() || files.has(file(resource)),
			readFile: async (resource: URI) => {
				if (explode()) {
					throw new Error('disk gone');
				}
				return { value: VSBuffer.fromString(files.get(file(resource)) ?? '') };
			},
			writeFile: async (resource: URI, content: VSBuffer, options?: { append?: boolean }) => {
				const path = file(resource);
				const text = content.toString();
				files.set(path, options?.append ? (files.get(path) ?? '') + text : text);
			},
			move: async (from: URI, to: URI) => {
				const text = files.get(file(from));
				if (text === undefined) {
					throw new Error('missing');
				}
				files.set(file(to), text);
				files.delete(file(from));
			},
			createFolder: async () => undefined,
			del: async (resource: URI) => {
				const path = file(resource);
				for (const key of [...files.keys()]) {
					if (key === path || key.startsWith(`${path}/`) || key.startsWith(`${path}\\`)) {
						files.delete(key);
					}
				}
			},
			resolve: async (resource: URI) => {
				const path = file(resource);
				const names = new Set<string>();
				for (const key of files.keys()) {
					if (!key.startsWith(path)) {
						continue;
					}
					const rest = key.slice(path.length).replace(/^[/\\]/, '');
					if (rest) {
						names.add(rest.split(/[/\\]/)[0]);
					}
				}
				return { children: [...names].map(name => ({ name })) };
			},
		} as unknown as IFileService;
	}
}
