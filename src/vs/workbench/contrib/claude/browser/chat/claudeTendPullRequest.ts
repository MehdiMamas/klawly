/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ClaudeGhProblem, ClaudePullRequestTarget, IClaudeCheckInvestigator } from '../../../../../platform/claude/common/claudeCheckInvestigation.js';
import { ClaudeGitHubReference } from '../../../../../platform/claude/common/claudeProtocol.js';
import { buildTendPrompt, CLAUDE_TEND_IGNORE_SETTING, CLAUDE_TEND_INITIAL, CLAUDE_TEND_POLL_SECONDS, CLAUDE_TEND_POLL_SETTING, CLAUDE_TEND_TURNS_SETTING, CLAUDE_TEND_TURN_CAP, clampTendSetting, ClaudeTendFailure, ClaudeTendProgress, ClaudeTendStopReason, decideTendStep, recordTendWork } from '../../../../../platform/claude/common/claudeTendPullRequest.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { createDecorator, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { IClaudeReviewBotService } from '../review/claudeReviewBotService.js';
import { CLAUDE_AGENT_ENABLED } from '../../common/claudeContextKeys.js';
import { KLAWLY_CATEGORY } from '../../common/claudeViews.js';

export const CLAUDE_TEND_PR_COMMAND_ID = 'claude.tendPullRequest';
export const CLAUDE_STOP_TENDING_PR_COMMAND_ID = 'claude.stopTendingPullRequest';
export { CLAUDE_TEND_IGNORE_SETTING, CLAUDE_TEND_POLL_SETTING, CLAUDE_TEND_TURNS_SETTING };
export const CLAUDE_TEND_STATUS_ENTRY_ID = 'claude.tendPullRequest';

/** True while any chat tends a pull request; Stop Tending This PR is hidden otherwise (issue 1042). */
export const CLAUDE_TENDING_PR = new RawContextKey<boolean>('claude.tendingPullRequest', false, localize('claudeTendingPullRequestKey', "Whether Klawly is tending a pull request"));

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'claude',
	order: 102,
	title: localize('claudeConfigurationTitle', "AI / Claude"),
	type: 'object',
	properties: {
		[CLAUDE_TEND_POLL_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.APPLICATION,
			default: CLAUDE_TEND_POLL_SECONDS.fallback,
			minimum: CLAUDE_TEND_POLL_SECONDS.min,
			maximum: CLAUDE_TEND_POLL_SECONDS.max,
			description: localize('claudeTendPoll', "Seconds between checks of a pull request while Tend This PR watches it."),
		},
		[CLAUDE_TEND_TURNS_SETTING]: {
			type: 'number',
			scope: ConfigurationScope.APPLICATION,
			default: CLAUDE_TEND_TURN_CAP.fallback,
			minimum: CLAUDE_TEND_TURN_CAP.min,
			maximum: CLAUDE_TEND_TURN_CAP.max,
			description: localize('claudeTendTurns', "Most turns Tend This PR may start for one pull request before it stops and tells you."),
		},
		[CLAUDE_TEND_IGNORE_SETTING]: {
			type: 'array',
			items: { type: 'string' },
			scope: ConfigurationScope.APPLICATION,
			default: [],
			description: localize('claudeTendIgnore', "GitHub users whose review comments Tend This PR leaves alone, such as a bot you do not want it to answer."),
		},
	},
});

export const IClaudeTendPullRequestService = createDecorator<IClaudeTendPullRequestService>('claudeTendPullRequestService');

/**
 * Tend This PR (issue 873): while it runs for a chat's pull request, it polls
 * the checks and review comments through the user's GitHub CLI (read-only) and,
 * when something new fails or is said, queues one turn in that chat with the
 * failed logs and comments as data. Claude fixes and may commit locally; it
 * never pushes or replies on GitHub without the user's approval, so the chat's
 * normal permission prompts guard every push and post.
 */
export interface IClaudeTendPullRequestService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<{ readonly sessionId: string }>;
	isTending(sessionId: string): boolean;
	/** The chats tending a pull request now, oldest first. */
	tending(): readonly ClaudeTendingRun[];
	/** Why tending last ended in this chat, in words for the user; cleared when it starts again. */
	lastEnd(sessionId: string): ClaudeTendEnd | undefined;
	start(sessionId: string, reference: ClaudeGitHubReference): Promise<void>;
	stop(sessionId: string): void;
}

export interface ClaudeTendingRun {
	readonly sessionId: string;
	readonly number: number;
}

export interface ClaudeTendEnd {
	readonly reason: ClaudeTendStopReason;
	readonly number: number;
	readonly message: string;
}

/** The timer Tend This PR waits on between polls; a test passes its own (issue 1016). */
export interface IClaudeTendScheduler {
	set(callback: () => void, milliseconds: number): unknown;
	clear(handle: unknown): void;
}

const DEFAULT_SCHEDULER: IClaudeTendScheduler = {
	set: (callback, milliseconds) => setTimeout(callback, milliseconds),
	clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface TendRun {
	readonly reference: ClaudeGitHubReference;
	progress: ClaudeTendProgress;
	/** A poll is in flight, so a slow `gh` never overlaps the next one. */
	polling: boolean;
	timer: unknown;
	stopped: boolean;
}

export class ClaudeTendPullRequestService extends Disposable implements IClaudeTendPullRequestService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<{ readonly sessionId: string }>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _runs = new Map<string, TendRun>();
	private readonly _lastEnd = new Map<string, ClaudeTendEnd>();

	constructor(
		private readonly _scheduler: IClaudeTendScheduler = DEFAULT_SCHEDULER,
		@IClaudeCheckInvestigator private readonly _investigator: IClaudeCheckInvestigator,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@INotificationService private readonly _notifications: INotificationService,
		@ICommandService private readonly _commands: ICommandService,
		@IClaudeReviewBotService private readonly _reviewBot: Pick<IClaudeReviewBotService, 'remember'>,
	) {
		super();
	}

	override dispose(): void {
		for (const run of this._runs.values()) {
			run.stopped = true;
			this._scheduler.clear(run.timer);
		}
		this._runs.clear();
		super.dispose();
	}

	isTending(sessionId: string): boolean {
		return this._runs.has(sessionId);
	}

	tending(): readonly ClaudeTendingRun[] {
		return [...this._runs].map(([sessionId, run]) => ({ sessionId, number: run.reference.number }));
	}

	lastEnd(sessionId: string): ClaudeTendEnd | undefined {
		return this._lastEnd.get(sessionId);
	}

	async start(sessionId: string, reference: ClaudeGitHubReference): Promise<void> {
		if (reference.kind !== 'pullRequest' || this._runs.has(sessionId)) {
			return;
		}
		// Check the folder before promising anything (issue 1044), so the start toast is never followed by this error.
		if (!this._workspace.getWorkspace().folders.some(folder => folder.uri.scheme === 'file')) {
			this._notifications.error(localize('claudeTendNeedsFolder', "Open a local folder before tending a pull request."));
			return;
		}
		const run: TendRun = { reference, progress: CLAUDE_TEND_INITIAL, polling: false, timer: undefined, stopped: false };
		this._runs.set(sessionId, run);
		this._lastEnd.delete(sessionId);
		this._onDidChange.fire({ sessionId });
		this._notifications.info(localize('claudeTendStarted', "Tending #{0}: Klawly checks it every {1} seconds and asks you before every push or reply. Stop Tending This PR ends it.", reference.number, this.pollSeconds()));
		await this.poll(sessionId, run);
	}

	stop(sessionId: string): void {
		this.finish(sessionId, 'stopped');
	}

	private pollSeconds(): number {
		return clampTendSetting(this._configuration.getValue(CLAUDE_TEND_POLL_SETTING), CLAUDE_TEND_POLL_SECONDS);
	}

	private turnCap(): number {
		return clampTendSetting(this._configuration.getValue(CLAUDE_TEND_TURNS_SETTING), CLAUDE_TEND_TURN_CAP);
	}

	private schedule(sessionId: string, run: TendRun): void {
		if (run.stopped) {
			return;
		}
		run.timer = this._scheduler.set(() => void this.poll(sessionId, run), this.pollSeconds() * 1000);
	}

	private finish(sessionId: string, reason: ClaudeTendStopReason, problem?: { readonly problem: ClaudeGhProblem; readonly message: string }): void {
		const run = this._runs.get(sessionId);
		if (!run) {
			return;
		}
		run.stopped = true;
		this._scheduler.clear(run.timer);
		this._runs.delete(sessionId);
		const number = run.reference.number;
		const message = tendEndMessage(reason, number, this.turnCap(), problem);
		this._lastEnd.set(sessionId, { reason, number, message });
		this._onDidChange.fire({ sessionId });
		switch (reason) {
			case 'turnCap': this._notifications.prompt(Severity.Info, message, [{
				label: localize('claudeTendOpenSettings', "Open Settings"),
				run: () => this._commands.executeCommand('workbench.action.openSettings', CLAUDE_TEND_TURNS_SETTING),
			}]); break;
			case 'ghProblem': this._notifications.warn(message); break;
			default: this._notifications.info(message); break;
		}
	}

	private async poll(sessionId: string, run: TendRun): Promise<void> {
		if (run.stopped || run.polling) {
			return;
		}
		run.polling = true;
		try {
			const target: ClaudePullRequestTarget = { owner: run.reference.owner, repo: run.reference.repo, number: run.reference.number };
			// `@klawly remember <rule>` comments go into REVIEW.md as a local edit; quiet unless a rule is new (issue 872).
			void this._reviewBot.remember(run.reference);
			const read = await this._investigator.tendSnapshot(target);
			if (run.stopped) {
				return;
			}
			if (!read.ok) {
				this.finish(sessionId, 'ghProblem', read);
				return;
			}
			const snapshot = read.snapshot;
			const ignored = this._configuration.getValue<string[] | undefined>(CLAUDE_TEND_IGNORE_SETTING) ?? [];
			const step = decideTendStep(snapshot, run.progress, this.turnCap(), Array.isArray(ignored) ? ignored : []);
			if (step.kind === 'stop') {
				this.finish(sessionId, step.reason);
				return;
			}
			if (step.kind === 'work') {
				const failures: ClaudeTendFailure[] = [];
				// A few logs are enough for one turn; the rest come with the next one.
				for (const check of step.failing.slice(0, 3)) {
					const log = await this._investigator.failedLog(target, check);
					failures.push({ check, log: log.ok ? log.log.text : undefined });
				}
				if (run.stopped) {
					return;
				}
				const sent = step.failing.slice(0, 3);
				const cwd = this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === 'file')?.uri.fsPath;
				if (!cwd) {
					this.finish(sessionId, 'stopped');
					this._notifications.error(localize('claudeTendNeedsFolder', "Open a local folder before tending a pull request."));
					return;
				}
				const label = localize('claudeTendTurnLabel', "Tend This PR: #{0}", target.number);
				await this._agent.queue(sessionId, label, cwd, 'queue', { compiled: buildTendPrompt(target, snapshot.branch, failures, step.comments), label, keepDraft: true });
				run.progress = recordTendWork(snapshot, run.progress, { kind: 'work', failing: sent, comments: step.comments });
			}
		} catch (error) {
			if (!run.stopped) {
				this.finish(sessionId, 'ghProblem', { problem: 'failed', message: error instanceof Error ? error.message : String(error) });
			}
			return;
		} finally {
			run.polling = false;
		}
		this.schedule(sessionId, run);
	}
}

/** The end reason in words, for the toast and for the chat that was tending (issue 1042). */
export function tendEndMessage(reason: ClaudeTendStopReason, number: number, turnCap: number, problem?: { readonly problem: ClaudeGhProblem; readonly message: string }): string {
	switch (reason) {
		case 'clean': return localize('claudeTendClean', "Stopped tending #{0}: every check passed and nothing is left to address.", number);
		case 'merged': return localize('claudeTendMerged', "Stopped tending #{0}: it was merged.", number);
		case 'closed': return localize('claudeTendClosed', "Stopped tending #{0}: it was closed.", number);
		case 'turnCap': return localize('claudeTendTurnCap', "Stopped tending #{0} after {1} turns. Run Tend This PR again to go on, or raise the Turn Limit in Settings.", number, turnCap);
		case 'stopped': return localize('claudeTendStopped', "Stopped tending #{0}.", number);
		case 'ghProblem': return problem?.problem === 'ghMissing' || problem?.problem === 'signedOut'
			? localize('claudeTendGhSignIn', "Stopped tending #{0}: the GitHub CLI is missing or signed out. Run “gh auth login”, then run Tend This PR again.", number)
			: localize('claudeTendGhFailed', "Stopped tending #{0}: the GitHub CLI could not read it ({1}).", number, problem?.message ?? '');
	}
}

/** The status bar entry while chats tend pull requests; clicking it stops the first one (issue 1042). */
export function tendStatusEntry(runs: readonly ClaudeTendingRun[]): IStatusbarEntry | undefined {
	const first = runs[0];
	if (!first) {
		return undefined;
	}
	const text = `$(sync~spin) ${runs.length === 1
		? localize('claudeTendStatusText', "Tending #{0}", first.number)
		: localize('claudeTendStatusTextMany', "Tending {0} PRs", runs.length)}`;
	const tooltip = runs.length === 1
		? localize('claudeTendStatusTooltip', "Klawly is tending pull request #{0}: it checks it on a timer and asks you before every push or reply. Click to stop tending.", first.number)
		: localize('claudeTendStatusTooltipMany', "Klawly is tending pull requests {0}. Click to stop tending #{1}.", runs.map(run => `#${run.number}`).join(', '), first.number);
	return {
		name: localize('claudeTendStatusName', "Tend This PR"),
		text,
		ariaLabel: tooltip,
		tooltip,
		command: { id: CLAUDE_STOP_TENDING_PR_COMMAND_ID, title: localize('claudeTendStatusStop', "Stop Tending This PR"), arguments: [first.sessionId] },
	};
}

/** Shows the running state in the status bar and keeps the Stop context key true while tending (issue 1042). */
export class ClaudeTendStatusBar extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.claudeTendPullRequestStatus';

	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IClaudeTendPullRequestService private readonly _tend: IClaudeTendPullRequestService,
		@IStatusbarService private readonly _statusbar: IStatusbarService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const tending = CLAUDE_TENDING_PR.bindTo(contextKeyService);
		const update = () => {
			const runs = this._tend.tending();
			tending.set(runs.length > 0);
			const entry = tendStatusEntry(runs);
			if (!entry) {
				this._entry.clear();
			} else if (this._entry.value) {
				this._entry.value.update(entry);
			} else {
				this._entry.value = this._statusbar.addEntry(entry, CLAUDE_TEND_STATUS_ENTRY_ID, StatusbarAlignment.RIGHT, 98);
			}
		};
		this._register(this._tend.onDidChange(update));
		update();
	}
}

registerWorkbenchContribution2(ClaudeTendStatusBar.ID, ClaudeTendStatusBar, WorkbenchPhase.AfterRestored);

registerSingleton(IClaudeTendPullRequestService, new SyncDescriptor(ClaudeTendPullRequestService, [DEFAULT_SCHEDULER], true));

/** Tend This PR for the pull request the current chat opened. */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CLAUDE_TEND_PR_COMMAND_ID,
			title: { ...localize2('claudeTendPullRequest', "Tend This PR"), original: 'Tend This PR (Tend This PR)' }, // the bracketed words rank it above Stop Tending This PR (issue 1504)
			category: KLAWLY_CATEGORY,
			precondition: CLAUDE_AGENT_ENABLED,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const agent = accessor.get(IClaudeAgentService);
		const notifications = accessor.get(INotificationService);
		const session = agent.getCurrentSession();
		const pullRequest = session ? agent.getViewState(session.id).pullRequest : undefined;
		if (!session || !pullRequest) {
			notifications.info(localize('claudeTendNoPullRequest', "This chat hasn't opened a pull request. Open one from the chat first."));
			return;
		}
		await accessor.get(IClaudeTendPullRequestService).start(session.id, pullRequest);
	}
});

/** Ends Tend This PR for the current chat. */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CLAUDE_STOP_TENDING_PR_COMMAND_ID,
			title: localize2('claudeStopTendingPullRequest', "Stop Tending This PR"),
			category: KLAWLY_CATEGORY,
			// Findable in the palette whenever the agent is on; without a tended PR it says so (issue 1507).
			precondition: CLAUDE_AGENT_ENABLED,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor, sessionId?: unknown): void {
		const tend = accessor.get(IClaudeTendPullRequestService);
		// The status bar entry names its chat; the palette stops the current one.
		const id = typeof sessionId === 'string' ? sessionId : accessor.get(IClaudeAgentService).getCurrentSession()?.id;
		if (id && tend.isTending(id)) {
			tend.stop(id);
		} else {
			accessor.get(INotificationService).info(localize('claudeTendNotTending', "This chat isn't tending a pull request."));
		}
	}
});
