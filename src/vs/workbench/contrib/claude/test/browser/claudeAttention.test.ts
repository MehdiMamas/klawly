/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { ClaudeStatusReport } from '../../../../../platform/claude/common/claudeStatusTool.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BackgroundAgentStatus, BackgroundAgentTask } from '../../../../../platform/claude/common/claudeBackground.js';
import { AccessibilitySignal, IAccessibilitySignalService, Sound } from '../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { CLAUDE_AGENT_ENABLED_SETTING, CLAUDE_NOTIFICATIONS_APPROVAL_SETTING, CLAUDE_NOTIFICATIONS_FINISHED_SETTING, CLAUDE_NOTIFICATIONS_SOUND_SETTING } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { INotificationHandle, IPromptChoice, Severity } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { ClaudeAgentSessionChange, IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { AgentReducerEvent, AgentViewState, EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../../../services/claude/common/claudeAgentState.js';
import { IClaudeAutomationService } from '../../../../services/claude/common/claudeAutomationService.js';
import { IClaudeBackgroundAgentService } from '../../../../services/claude/common/claudeBackgroundAgent.js';
import { IHostService, IToastOptions, IToastResult } from '../../../../services/host/browser/host.js';
import { ClaudeAnnouncer, ClaudeAriaSink, ClaudeAttentionNotifier } from '../../browser/claudeAttention.js';
import { CLAUDE_FOCUS_AGENT_COMMAND_ID, CLAUDE_OPEN_BACKGROUND_AGENTS_COMMAND_ID } from '../../common/claudeViews.js';
import { TestClaudeSetupService } from './claudeSetupTestUtils.js';

function apply(state: AgentViewState, ...events: AgentReducerEvent[]): AgentViewState {
	return events.reduce(reduceAgentState, state);
}

function permission(id: string, command: string): AgentReducerEvent {
	return { type: 'permission.requested', sessionId: 's', request: { id, toolName: 'Bash', input: {}, category: 'shell', command, canRemember: true } };
}

function task(id: string, status: BackgroundAgentStatus): BackgroundAgentTask {
	return { id, sessionId: `bg-${id}`, repoRoot: '/repo', baseRef: 'main', worktreePath: `/wt/${id}`, branchName: `agent/${id}`, status, title: `Task ${id}`, filesChanged: 0, added: 0, removed: 0, testStatus: 'tests not run', conflicts: [], stopped: false };
}

/** Agent double: a test sets view states and opens or closes sessions. */
class FakeAgent {
	readonly onDidChangeViewStateEmitter = new Emitter<{ readonly sessionId: string }>();
	readonly onDidChangeSessionEmitter = new Emitter<ClaudeAgentSessionChange>();
	readonly onDidChangeViewState = this.onDidChangeViewStateEmitter.event;
	readonly onDidChangeSession = this.onDidChangeSessionEmitter.event;
	readonly selected: string[] = [];
	private readonly _states = new Map<string, AgentViewState>();
	private _sessions: string[] = [];
	current: string | undefined;

	open(id: string): void {
		this._sessions.push(id);
		this.current = id;
		this.onDidChangeSessionEmitter.fire({ reason: 'created', session: undefined, sessions: this.getSessions() });
	}

	close(id: string): void {
		this._sessions = this._sessions.filter(candidate => candidate !== id);
		this._states.delete(id);
		this.current = this._sessions.at(-1);
		this.onDidChangeSessionEmitter.fire({ reason: 'closed', session: undefined, sessions: this.getSessions() });
	}

	set(id: string, state: AgentViewState): void {
		this._states.set(id, state);
		this.onDidChangeViewStateEmitter.fire({ sessionId: id });
	}

	getSessions() {
		return this._sessions.map(id => ({ id })) as unknown as ReturnType<IClaudeAgentService['getSessions']>;
	}

	getCurrentSession() {
		return this.current ? { id: this.current } as unknown as ReturnType<IClaudeAgentService['getCurrentSession']> : undefined;
	}

	getViewState(id: string): AgentViewState {
		return this._states.get(id) ?? EMPTY_AGENT_VIEW_STATE;
	}

	selectSession(id: string): void {
		this.selected.push(id);
	}

	getRuntimeSessionId(id: string): string {
		return `rt-${id}`;
	}

	dispose(): void {
		this.onDidChangeViewStateEmitter.dispose();
		this.onDidChangeSessionEmitter.dispose();
	}
}

class RecordingNotifications extends TestNotificationService {
	readonly prompts: { severity: Severity; message: string; choices: IPromptChoice[] }[] = [];

	override prompt(severity: Severity, message: string, choices: IPromptChoice[]): INotificationHandle {
		this.prompts.push({ severity, message, choices });
		return super.prompt(severity, message, choices);
	}
}

suite('Claude attention notifier and announcer', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options: { focused?: boolean; clickToast?: boolean; agentEnabled?: boolean; approval?: boolean; finished?: boolean; sound?: boolean } = {}) {
		const store = disposables.add(new DisposableStore());
		const agent = store.add(new FakeAgent());
		const tasksChanged = store.add(new Emitter<void>());
		let tasks: BackgroundAgentTask[] = [];
		const background = {
			onDidChangeTasks: tasksChanged.event,
			getTasks: () => tasks,
		} as unknown as IClaudeBackgroundAgentService;
		const setupService = store.add(new TestClaudeSetupService({ installed: true, authenticated: true, version: '2.1.0' }));
		const toasts: IToastOptions[] = [];
		const focusCalls: string[] = [];
		const host = {
			hasFocus: options.focused ?? false,
			showToast: async (toast: IToastOptions, _token: CancellationToken): Promise<IToastResult> => {
				toasts.push(toast);
				return { supported: true, clicked: !!options.clickToast };
			},
			focus: async () => { focusCalls.push('focus'); },
		};
		const notifications = new RecordingNotifications();
		const commands: string[] = [];
		const commandService = { executeCommand: async (id: string) => { commands.push(id); return undefined; } } as unknown as ICommandService;
		const configuration = new TestConfigurationService({
			[CLAUDE_AGENT_ENABLED_SETTING]: options.agentEnabled ?? true,
			[CLAUDE_NOTIFICATIONS_APPROVAL_SETTING]: options.approval ?? true,
			[CLAUDE_NOTIFICATIONS_FINISHED_SETTING]: options.finished ?? true,
			[CLAUDE_NOTIFICATIONS_SOUND_SETTING]: options.sound ?? false,
		});
		const sounds: string[] = [];
		// The response sound is picked at random from a set; record the signal it belongs to.
		const signals = {
			playSound: async (sound: Sound) => {
				sounds.push([AccessibilitySignal.chatUserActionRequired, AccessibilitySignal.chatResponseReceived].find(signal => signal.sound.randomOneOf.includes(sound))?.name ?? sound.fileName);
			},
		} as unknown as IAccessibilitySignalService;
		const statusEmitter = store.add(new Emitter<ClaudeStatusReport>());
		const runtime = { onDidReportStatus: statusEmitter.event } as unknown as IClaudeRuntimeService;
		const notifier = store.add(new ClaudeAttentionNotifier(agent as unknown as IClaudeAgentService, background, setupService, host as unknown as IHostService, notifications, commandService, configuration, signals, { isUnattended: () => false } as unknown as IClaudeAutomationService, runtime));
		return {
			agent, notifier, statusEmitter, setupService, host, toasts, focusCalls, notifications, commands, sounds,
			setTasks: (next: BackgroundAgentTask[]) => { tasks = next; tasksChanged.fire(); },
		};
	}

	test('an approval toasts only while the window is unfocused, once per request', async () => {
		const unfocused = setup({ clickToast: true });
		unfocused.agent.open('s1');
		let state = apply(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 't1', text: 'Go' }, permission('p1', 'npm test'));
		unfocused.agent.set('s1', state);
		unfocused.agent.set('s1', state);
		state = apply(state, permission('p2', 'npm run build'));
		unfocused.agent.set('s1', state);
		await timeout(0);

		const focused = setup({ focused: true });
		focused.agent.open('s1');
		focused.agent.set('s1', apply(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 't1', text: 'Go' }, permission('p1', 'npm test')));
		await timeout(0);

		assert.deepStrictEqual({
			toasts: unfocused.toasts.map(toast => [toast.title, toast.body, toast.dedupeKey, toast.actions]),
			clicked: { focus: unfocused.focusCalls.length, selected: unfocused.agent.selected, commands: unfocused.commands },
			focused: { toasts: focused.toasts.length, prompts: focused.notifications.prompts.length },
		}, {
			toasts: [
				['Claude needs your approval', 'Run this command?', 'claude.permission.s1', ['Open Agent']],
				['Claude needs your approval', 'Run this command?', 'claude.permission.s1', ['Open Agent']],
			],
			clicked: { focus: 2, selected: ['s1', 's1'], commands: [CLAUDE_FOCUS_AGENT_COMMAND_ID, CLAUDE_FOCUS_AGENT_COMMAND_ID] },
			focused: { toasts: 0, prompts: 0 },
		});
	});

	test('issue 1171: a status line toasts while unfocused, only for its own chat, and attention also shows in-app when focused', async () => {
		const unfocused = setup({ clickToast: true });
		unfocused.agent.open('s1');
		unfocused.statusEmitter.fire({ sessionId: 'rt-s1', text: ' Build   is green ', kind: 'done' });
		unfocused.statusEmitter.fire({ sessionId: 'rt-other-window', text: 'Not mine', kind: 'done' });
		const focused = setup({ focused: true });
		focused.agent.open('s1');
		focused.statusEmitter.fire({ sessionId: 'rt-s1', text: 'Fine', kind: 'info' });
		focused.statusEmitter.fire({ sessionId: 'rt-s1', text: 'Need you', kind: 'attention' });
		await timeout(0);
		assert.deepStrictEqual({
			toasts: unfocused.toasts.map(toast => [toast.body, toast.dedupeKey, toast.actions]),
			selected: unfocused.agent.selected,
			focused: { toasts: focused.toasts.length, prompts: focused.notifications.prompts.map(prompt => prompt.message) },
		}, {
			toasts: [['Build is green', 'claude.status.s1', ['Open Agent']]],
			selected: ['s1'],
			focused: { toasts: 0, prompts: ['undefined: Need you'] },
		});
	});

	test('an expired sign-in toasts while unfocused; a sign-in failure in a turn probes once', async () => {
		const unfocused = setup();
		unfocused.setupService.set({ installed: true, authenticated: false, version: '2.1.0' });
		unfocused.setupService.set({ installed: true, authenticated: false, version: '2.1.0' });
		const focused = setup({ focused: true });
		focused.setupService.set({ installed: true, authenticated: false, version: '2.1.0' });

		focused.agent.open('s1');
		const failed = apply(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 't1', text: 'Go' }, { type: 'turn.failed', message: '401', kind: 'auth' });
		focused.agent.set('s1', failed);
		focused.agent.set('s1', failed);
		await timeout(0);
		assert.deepStrictEqual({
			unfocused: unfocused.toasts.map(toast => [toast.title, toast.dedupeKey, toast.actions]),
			focused: focused.toasts.length,
			probes: focused.setupService.calls,
		}, {
			unfocused: [['Your Claude sign-in expired', 'claude.auth', ['Sign In']]],
			focused: 0,
			probes: ['redetect'],
		});
	});

	test('a background agent that finishes or fails: a toast when unfocused, one in-app prompt when focused', async () => {
		const unfocused = setup();
		unfocused.setTasks([task('a', 'running'), task('b', 'running'), task('c', 'complete')]);
		unfocused.setTasks([task('a', 'complete'), task('b', 'failed'), task('c', 'complete')]);
		unfocused.setTasks([task('a', 'complete'), task('b', 'failed'), task('c', 'complete')]);

		const focused = setup({ focused: true });
		focused.setTasks([task('a', 'running'), task('b', 'running')]);
		focused.setTasks([task('a', 'complete'), task('b', 'failed')]);
		focused.notifications.prompts[1].choices[0].run();

		const off = setup({ agentEnabled: false });
		off.setTasks([task('a', 'running')]);
		off.setTasks([task('a', 'complete')]);
		await timeout(0);

		assert.deepStrictEqual({
			unfocused: unfocused.toasts.map(toast => [toast.title, toast.dedupeKey]),
			focused: focused.notifications.prompts.map(prompt => [prompt.severity, prompt.message, prompt.choices.map(choice => choice.label)]),
			focusedToasts: focused.toasts.length,
			opened: focused.commands,
			agentOff: [off.toasts.length, off.notifications.prompts.length],
		}, {
			unfocused: [['Background agent finished: Task a', 'claude.background.a'], ['Background agent failed: Task b', 'claude.background.b']],
			focused: [
				[Severity.Info, 'Background agent finished: Task a', ['Open Background Agents']],
				[Severity.Warning, 'Background agent failed: Task b', ['Open Background Agents']],
			],
			focusedToasts: 0,
			opened: [CLAUDE_OPEN_BACKGROUND_AGENTS_COMMAND_ID],
			agentOff: [0, 0],
		});
	});

	test('a turn that ends: a toast when unfocused, none when focused, a stopped turn, or the setting is off', async () => {
		const run = async (options: Parameters<typeof setup>[0], end: AgentReducerEvent) => {
			const harness = setup(options);
			harness.agent.open('s1');
			const running = apply(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 't1', text: 'Go' });
			harness.agent.set('s1', running);
			harness.agent.set('s1', apply(running, end));
			harness.agent.set('s1', apply(running, end));
			await timeout(0);
			return harness;
		};
		const done = await run({ clickToast: true }, { type: 'session.completed', sessionId: 's' });
		const failed = await run({}, { type: 'turn.failed', message: 'boom' });
		const focused = await run({ focused: true }, { type: 'session.completed', sessionId: 's' });
		const stopped = await run({}, { type: 'turn.stopped' });
		const off = await run({ finished: false }, { type: 'session.completed', sessionId: 's' });
		assert.deepStrictEqual({
			done: done.toasts.map(toast => [toast.title, toast.dedupeKey, toast.actions]),
			opened: { selected: done.agent.selected, commands: done.commands },
			failed: failed.toasts.map(toast => toast.title),
			others: [focused.toasts.length, stopped.toasts.length, off.toasts.length],
		}, {
			done: [['Claude finished', 'claude.turn.s1', ['Open Agent']]],
			opened: { selected: ['s1'], commands: [CLAUDE_FOCUS_AGENT_COMMAND_ID] },
			failed: ['Claude stopped with an error'],
			others: [0, 0, 0],
		});
	});

	test('notification settings: approval and finished toasts turn off; the sound plays only when on, focused or not', async () => {
		const quiet = setup({ approval: false, finished: false });
		quiet.agent.open('s1');
		quiet.agent.set('s1', apply(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 't1', text: 'Go' }, permission('p1', 'npm test')));
		quiet.setTasks([task('a', 'running')]);
		quiet.setTasks([task('a', 'complete')]);

		const loud = setup({ focused: true, sound: true });
		loud.agent.open('s1');
		const asking = apply(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 't1', text: 'Go' }, permission('p1', 'npm test'));
		loud.agent.set('s1', asking);
		loud.agent.set('s1', apply(asking, { type: 'permission.resolved', sessionId: 's', outcome: { requestId: 'p1', toolName: 'Bash', decision: 'allow', scope: 'once', source: 'user' } }, { type: 'session.completed', sessionId: 's' }));
		await timeout(0);

		assert.deepStrictEqual({
			quiet: { toasts: quiet.toasts.length, prompts: quiet.notifications.prompts.length, sounds: quiet.sounds },
			loud: { toasts: loud.toasts.length, sounds: loud.sounds },
		}, {
			quiet: { toasts: 0, prompts: 0, sounds: [] },
			loud: { toasts: 0, sounds: [AccessibilitySignal.chatUserActionRequired.name, AccessibilitySignal.chatResponseReceived.name] },
		});
	});

	test('with claude.agent.enabled off, nothing toasts', async () => {
		const off = setup({ agentEnabled: false });
		off.agent.open('s1');
		off.agent.set('s1', apply(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 't1', text: 'Go' }, permission('p1', 'npm test')));
		off.setupService.set({ installed: true, authenticated: false });
		await timeout(0);
		assert.strictEqual(off.toasts.length, 0);
	});

	test('announcements are batched into one polite message; approvals are read at once', () => runWithFakedTimers({}, async () => {
		const store = disposables.add(new DisposableStore());
		const agent = store.add(new FakeAgent());
		const heard: string[] = [];
		const aria: ClaudeAriaSink = {
			alert: message => heard.push(`alert: ${message}`),
			status: message => heard.push(`status: ${message}`),
		};
		const configuration = new TestConfigurationService({ [CLAUDE_AGENT_ENABLED_SETTING]: true });
		agent.open('s1');
		store.add(new ClaudeAnnouncer(agent as unknown as IClaudeAgentService, configuration, aria));
		let state = apply(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 't1', text: 'Go' });
		agent.set('s1', state);
		for (const text of ['Look', 'ing']) {
			state = apply(state, { type: 'assistant.delta', sessionId: 's', text });
			agent.set('s1', state);
		}
		const beforeFlush = [...heard];
		state = apply(state, permission('p1', 'npm test'));
		agent.set('s1', state);
		const urgent = [...heard];
		state = apply(state, { type: 'permission.resolved', sessionId: 's', outcome: { requestId: 'p1', toolName: 'Bash', decision: 'allow', scope: 'once', source: 'user' } }, { type: 'session.completed', sessionId: 's' });
		agent.set('s1', state);
		await timeout(1000);
		// Other sessions are not read.
		agent.set('other', apply(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'x', text: 'Hidden' }));
		await timeout(1000);
		assert.deepStrictEqual({ beforeFlush, urgent, heard }, {
			beforeFlush: [],
			urgent: ['alert: Approval needed: Run this command?', 'status: Agent started working.'],
			heard: ['alert: Approval needed: Run this command?', 'status: Agent started working.', 'status: Agent finished.'],
		});
	}));
});
