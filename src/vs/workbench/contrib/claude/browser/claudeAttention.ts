/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { alert, status } from '../../../../base/browser/ui/aria/aria.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { AccessibilitySignal, AcknowledgeDocCommentsToken, IAccessibilitySignalService } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { ClaudeRuntimeState, IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { CLAUDE_AGENT_ENABLED_SETTING, CLAUDE_NOTIFICATIONS_APPROVAL_SETTING, CLAUDE_NOTIFICATIONS_FINISHED_SETTING, CLAUDE_NOTIFICATIONS_SOUND_SETTING, readClaudeAgentEnabled } from '../../../../platform/claude/common/claudeConfiguration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { FocusMode } from '../../../../platform/native/common/native.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { describePermissionPrompt, permissionsForTimeline } from '../../../services/claude/common/claudeAgentState.js';
import { IClaudeAutomationService } from '../../../services/claude/common/claudeAutomationService.js';
import { IClaudeBackgroundAgentService } from '../../../services/claude/common/claudeBackgroundAgent.js';
import { IHostService, IToastOptions } from '../../../services/host/browser/host.js';
import { claudeStatusText, ClaudeStatusReport } from '../../../../platform/claude/common/claudeStatusTool.js';
import { ClaudeAnnouncementBatcher, ClaudeAnnouncementTracker } from '../common/claudeAnnouncer.js';
import { ClaudeAttentionState } from '../common/claudeAttentionState.js';
import { CLAUDE_FOCUS_AGENT_COMMAND_ID, CLAUDE_OPEN_BACKGROUND_AGENTS_COMMAND_ID } from '../common/claudeViews.js';
import { IClaudeSetupService } from './claudeSetup.js';

/** Sentences gathered in this window are read as one message. */
const ANNOUNCE_BATCH_MS = 600;

/** Where announcements are read. Defaults to the workbench aria live regions; tests pass a recorder. */
export interface ClaudeAriaSink {
	/** Read at once, interrupting. */
	alert(message: string): void;
	/** Read when the screen reader is idle. */
	status(message: string): void;
}

const WORKBENCH_ARIA: ClaudeAriaSink = { alert, status };

/**
 * Screen-reader announcements for the current agent session (spec 49):
 * coherent sentences, batched, never token by token. Approval requests are
 * read at once as alerts.
 */
export class ClaudeAnnouncerContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeAnnouncer';

	constructor(
		@IClaudeAgentService agent: IClaudeAgentService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super();
		this._register(new ClaudeAnnouncer(agent, configuration));
	}
}

/** Batches the current session's announcements and reads them through `_aria`. */
export class ClaudeAnnouncer extends Disposable {
	private readonly _tracker = new ClaudeAnnouncementTracker();
	private readonly _batcher = new ClaudeAnnouncementBatcher();
	private readonly _flush = this._register(new RunOnceScheduler(() => this.flush(), ANNOUNCE_BATCH_MS));

	constructor(
		private readonly _agent: IClaudeAgentService,
		private readonly _configuration: IConfigurationService,
		private readonly _aria: ClaudeAriaSink = WORKBENCH_ARIA,
	) {
		super();
		this._register(this._agent.onDidChangeViewState(change => {
			if (change.sessionId === this._agent.getCurrentSession()?.id) {
				this.observe();
			}
		}));
		this._register(this._agent.onDidChangeSession(() => this.observe()));
		this.observe();
	}

	private observe(): void {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		const items = this._tracker.observe(session.id, this._agent.getViewState(session.id));
		if (items.length === 0 || !readClaudeAgentEnabled(this._configuration.getValue(CLAUDE_AGENT_ENABLED_SETTING))) {
			return;
		}
		this._batcher.add(items);
		if (this._batcher.hasUrgent) {
			this._flush.cancel();
			this.flush();
		} else if (!this._flush.isScheduled()) {
			this._flush.schedule();
		}
	}

	private flush(): void {
		const batch = this._batcher.flush();
		if (batch.urgent) {
			this._aria.alert(batch.urgent);
		}
		if (batch.polite) {
			this._aria.status(batch.polite);
		}
	}
}

/**
 * Native notifications, kept sparse (spec 48): a permission request, an agent
 * or background agent that finished or failed, and an expired sign-in. OS
 * toasts show only while the window is not focused; inside a focused window the
 * Agent pane, the status bar item and the background agent cards already show
 * these. `claude.notifications.*` turns the approval and finished toasts off,
 * and turns on a sound that plays focused or not. Update notifications belong
 * to the updater.
 */
export class ClaudeAttentionNotifier extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeAttention';

	/** Permissions, auth failures and task states already handled. Pruned as sessions close and tasks go. */
	private readonly _state = new ClaudeAttentionState();
	private _runtime: ClaudeRuntimeState | undefined;
	private readonly _toasts = this._register(new CancellationTokenSource());

	constructor(
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeBackgroundAgentService private readonly _background: IClaudeBackgroundAgentService,
		@IClaudeSetupService private readonly _setup: IClaudeSetupService,
		@IHostService private readonly _host: IHostService,
		@INotificationService private readonly _notifications: INotificationService,
		@ICommandService private readonly _commands: ICommandService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IAccessibilitySignalService private readonly _signals: IAccessibilitySignalService,
		@IClaudeAutomationService private readonly _automations: IClaudeAutomationService,
		@IClaudeRuntimeService runtimeService: IClaudeRuntimeService,
	) {
		super();
		this._register(toDisposable(() => this._toasts.cancel()));
		if (runtimeService.onDidReportStatus) {
			this._register(runtimeService.onDidReportStatus(report => this.onStatus(report)));
		}
		for (const session of this._agent.getSessions()) {
			this.collectPermissions(session.id);
			this._state.endedTurn(session.id, this._agent.getViewState(session.id).turns.at(-1));
		}
		this._state.endedTasks(this._background.getTasks());
		this._runtime = this._setup.runtime;
		this._register(this._agent.onDidChangeViewState(change => this.onViewState(change.sessionId)));
		this._register(this._agent.onDidChangeSession(change => {
			if (change.reason === 'closed') {
				this._state.retainSessions(new Set(change.sessions.map(session => session.id)));
			}
		}));
		this._register(this._background.onDidChangeTasks(() => this.onTasks()));
		this._register(this._setup.onDidChange(() => this.onRuntime()));
	}

	private enabled(): boolean {
		return readClaudeAgentEnabled(this._configuration.getValue(CLAUDE_AGENT_ENABLED_SETTING));
	}

	/** A notification setting; anything but `false` keeps the registered default of on. */
	private wants(key: typeof CLAUDE_NOTIFICATIONS_APPROVAL_SETTING | typeof CLAUDE_NOTIFICATIONS_FINISHED_SETTING): boolean {
		return this._configuration.getValue(key) !== false;
	}

	/** The opt-in sound. It plays even when accessibility signals are off: the user asked for it here. */
	private chime(signal: AccessibilitySignal): void {
		if (this._configuration.getValue(CLAUDE_NOTIFICATIONS_SOUND_SETTING) === true) {
			void this._signals.playSound(signal.sound.getSound(), false, AcknowledgeDocCommentsToken);
		}
	}

	/** Pending requests not seen before: permissions, then MCP forms and sign-ins (issue 428). Marks them seen. */
	private collectPermissions(sessionId: string): { readonly prompt: string; readonly input: boolean }[] {
		const state = this._agent.getViewState(sessionId);
		const pending = [
			...state.turns.flatMap(turn => permissionsForTimeline(turn, state.subagents, undefined).filter(entry => entry.state === 'pending'))
				.map(entry => ({ id: entry.id, prompt: describePermissionPrompt(entry), input: false })),
			...state.turns.flatMap(turn => turn.elicitations ?? []).filter(entry => entry.state === 'pending')
				.map(entry => ({ id: `elicitation:${entry.id}`, prompt: localize('claudeToastInputBody', "{0}: {1}", entry.server, entry.title ?? entry.message), input: true })),
		];
		return this._state.freshPermissions(sessionId, pending);
	}

	private onViewState(sessionId: string): void {
		const last = this._agent.getViewState(sessionId).turns.at(-1);
		const authFailure = last?.status === 'failed' && last.failure?.kind === 'auth';
		if (authFailure && this._state.authFailed(sessionId, last.id)) {
			// Claude refused the sign-in mid-session: probe again so the pane and
			// the status bar show the real state and offer Sign In.
			void this._setup.redetect();
		}
		const ended = this._state.endedTurn(sessionId, last);
		const fresh = this.collectPermissions(sessionId);
		if (!this.enabled()) {
			return;
		}
		const openSession = () => {
			this._agent.selectSession(sessionId);
			return this._commands.executeCommand(CLAUDE_FOCUS_AGENT_COMMAND_ID);
		};
		// An automation run answers its own requests (issue 426); one it denies is announced as the run needing you.
		if (fresh.length > 0 && !this._automations.isUnattended(sessionId)) {
			this.chime(AccessibilitySignal.chatUserActionRequired);
			if (this.wants(CLAUDE_NOTIFICATIONS_APPROVAL_SETTING) && !this._host.hasFocus) {
				void this.toast({
					title: fresh[0].input ? localize('claudeToastInput', "Claude needs your input") : localize('claudeToastApproval', "Claude needs your approval"),
					body: fresh[0].prompt,
					actions: [localize('claudeToastOpenAgent', "Open Agent")],
					dedupeKey: `claude.permission.${sessionId}`,
				}, openSession);
			}
		}
		// A refused sign-in has its own toast from the runtime state.
		if (ended && last && !authFailure) {
			this.chime(AccessibilitySignal.chatResponseReceived);
			if (this.wants(CLAUDE_NOTIFICATIONS_FINISHED_SETTING) && !this._host.hasFocus) {
				const title = this._agent.getSessions().find(session => session.id === sessionId)?.title ?? '';
				void this.toast({
					title: last.status === 'failed'
						? last.failure?.kind === 'turn-limit'
							? localize('claudeToastTurnLimit', "Claude stopped at its step limit")
							: localize('claudeToastTurnFailed', "Claude stopped with an error")
						: localize('claudeToastTurnFinished', "Claude finished"),
					body: title,
					actions: [localize('claudeToastOpenAgent', "Open Agent")],
					dedupeKey: `claude.turn.${sessionId}`,
				}, openSession);
			}
		}
	}

	/** A one-line status the agent chose to show (issue 1171). Only the window that owns the chat shows it. */
	private onStatus(report: ClaudeStatusReport): void {
		const session = this._agent.getSessions().find(candidate => this._agent.getRuntimeSessionId(candidate.id) === report.sessionId);
		if (!session || !this.enabled()) {
			return;
		}
		const text = claudeStatusText(report.text);
		if (!text) {
			return;
		}
		const open = () => {
			this._agent.selectSession(session.id);
			return this._commands.executeCommand(CLAUDE_FOCUS_AGENT_COMMAND_ID);
		};
		const setting = report.kind === 'attention' ? CLAUDE_NOTIFICATIONS_APPROVAL_SETTING : CLAUDE_NOTIFICATIONS_FINISHED_SETTING;
		if (!this.wants(setting)) {
			return;
		}
		if (report.kind === 'attention') {
			this.chime(AccessibilitySignal.chatUserActionRequired);
		}
		if (this._host.hasFocus) {
			// The user is looking at the window: a quiet in-app note, and only for what needs them.
			if (report.kind === 'attention') {
				this._notifications.prompt(Severity.Info, localize('claudeStatusFocused', "{0}: {1}", session.title, text), [{
					label: localize('claudeToastOpenAgent', "Open Agent"),
					run: () => { void open(); },
				}]);
			}
			return;
		}
		void this.toast({
			title: session.title,
			body: text,
			actions: [localize('claudeToastOpenAgent', "Open Agent")],
			dedupeKey: `claude.status.${session.id}`,
		}, open);
	}

	private onTasks(): void {
		const ended = this._state.endedTasks(this._background.getTasks());
		if (!this.enabled() || ended.length === 0) {
			return;
		}
		this.chime(AccessibilitySignal.chatResponseReceived);
		if (!this.wants(CLAUDE_NOTIFICATIONS_FINISHED_SETTING)) {
			return;
		}
		for (const task of ended) {
			const failed = task.status === 'failed';
			const title = failed
				? localize('claudeBackgroundFailed', "Background agent failed: {0}", task.title)
				: localize('claudeBackgroundFinished', "Background agent finished: {0}", task.title);
			const open = () => this._commands.executeCommand(CLAUDE_OPEN_BACKGROUND_AGENTS_COMMAND_ID);
			if (this._host.hasFocus) {
				// No toast generator: one notification, only for the end of a background run.
				this._notifications.prompt(failed ? Severity.Warning : Severity.Info, title, [{
					label: localize('claudeBackgroundOpen', "Open Background Agents"),
					run: () => { void open(); },
				}]);
			} else {
				void this.toast({
					title,
					actions: [localize('claudeBackgroundOpen', "Open Background Agents")],
					dedupeKey: `claude.background.${task.id}`,
				}, open);
			}
		}
	}

	private onRuntime(): void {
		const previous = this._runtime;
		const next = this._setup.runtime;
		this._runtime = next;
		const expired = !!previous?.installed && previous.authenticated && !!next?.installed && !next.authenticated;
		if (!expired || !this.enabled() || this._host.hasFocus) {
			return;
		}
		void this.toast({
			title: localize('claudeToastSignInExpired', "Your Claude sign-in expired"),
			body: localize('claudeToastSignInDetail', "Sign in again to keep using the agent."),
			actions: [localize('claudeToastSignIn', "Sign In")],
			dedupeKey: 'claude.auth',
		}, () => this._commands.executeCommand(CLAUDE_FOCUS_AGENT_COMMAND_ID));
	}

	private async toast(options: IToastOptions, open: () => Promise<unknown>): Promise<void> {
		const result = await this._host.showToast(options, this._toasts.token);
		if (result.clicked || typeof result.actionIndex === 'number') {
			await this._host.focus(mainWindow, { mode: FocusMode.Force });
			await open();
		}
	}
}
