/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { buildCheckInvestigationPrompt, ClaudeFailingCheck, ClaudeGhProblem, ClaudeInvestigationSubject, ClaudePullRequestTarget, IClaudeCheckInvestigator, pullRequestCheckSummary } from '../../../../../platform/claude/common/claudeCheckInvestigation.js';
import { ClaudeGitHubReference } from '../../../../../platform/claude/common/claudeProtocol.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { CLAUDE_AGENT_ENABLED } from '../../common/claudeContextKeys.js';
import { KLAWLY_CATEGORY } from '../../common/claudeViews.js';
import { IClaudeGitHubDetailsService } from './claudeGitHubDetails.js';

export const CLAUDE_INVESTIGATE_FAILING_CHECK_COMMAND_ID = 'claude.investigateFailingCheck';

export const IClaudeCheckInvestigationService = createDecorator<IClaudeCheckInvestigationService>('claudeCheckInvestigationService');

/**
 * Investigate Failing Check (issue 505): reads a pull request's failed check
 * through the user's GitHub CLI, then asks Claude in the session for the root
 * cause and a fix in the session's workspace. The fix is a normal turn with
 * normal, reviewable changes; nothing is committed, pushed or posted.
 */
export interface IClaudeCheckInvestigationService {
	readonly _serviceBrand: undefined;
	/** A pull request's investigation started or ended in a session. */
	readonly onDidChange: Event<{ readonly sessionId: string; readonly url: string }>;
	/** Whether the failed log of this pull request is being read for the session. */
	isReading(sessionId: string, url: string): boolean;
	/** Reads the failed check (asking which one when several failed) and sends it to Claude. */
	investigate(sessionId: string, reference: ClaudeGitHubReference): Promise<void>;
	/** Sends any failed run's trimmed log to Claude in a session; a deploy watch (issue 509) reuses it. */
	send(sessionId: string, subject: ClaudeInvestigationSubject, label: string): Promise<void>;
}

interface CheckPick extends IQuickPickItem {
	readonly check: ClaudeFailingCheck;
}

export class ClaudeCheckInvestigationService extends Disposable implements IClaudeCheckInvestigationService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<{ readonly sessionId: string; readonly url: string }>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _reading = new Set<string>();

	constructor(
		@IClaudeCheckInvestigator private readonly _investigator: IClaudeCheckInvestigator,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeGitHubDetailsService private readonly _details: IClaudeGitHubDetailsService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@INotificationService private readonly _notifications: INotificationService,
		@IProgressService private readonly _progress: IProgressService,
		@IOpenerService private readonly _opener: IOpenerService,
	) {
		super();
	}

	isReading(sessionId: string, url: string): boolean {
		return this._reading.has(`${sessionId}\n${url}`);
	}

	async investigate(sessionId: string, reference: ClaudeGitHubReference): Promise<void> {
		const key = `${sessionId}\n${reference.url}`;
		if (reference.kind !== 'pullRequest' || this._reading.has(key)) {
			return;
		}
		this._reading.add(key);
		this._onDidChange.fire({ sessionId, url: reference.url });
		try {
			await this._progress.withProgress({ location: ProgressLocation.Window, title: localize('claudeCheckReading', "Reading the failed check of #{0}", reference.number) }, () => this.read(sessionId, reference));
		} finally {
			this._reading.delete(key);
			this._onDidChange.fire({ sessionId, url: reference.url });
		}
	}

	async send(sessionId: string, subject: ClaudeInvestigationSubject, label: string): Promise<void> {
		const cwd = this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === 'file')?.uri.fsPath;
		if (!cwd) {
			this._notifications.error(localize('claudeNeedsFolder', "Open a local folder before messaging the agent."));
			return;
		}
		if (this._agent.getCurrentSession()?.id !== sessionId) {
			this._agent.selectSession(sessionId);
		}
		// A session in a background worktree runs in its pinned folder, not `cwd`. A running turn keeps it queued.
		await this._agent.queue(sessionId, label, cwd, 'queue', { compiled: buildCheckInvestigationPrompt(subject), label, keepDraft: true });
	}

	private async read(sessionId: string, reference: ClaudeGitHubReference): Promise<void> {
		const target: ClaudePullRequestTarget = { owner: reference.owner, repo: reference.repo, number: reference.number };
		const listed = await this._investigator.failingChecks(target);
		if (!listed.ok) {
			this.report(listed.problem, listed.message, reference);
			return;
		}
		if (listed.checks.length === 0) {
			this._notifications.info(localize('claudeCheckNoneFailed', "No check failed on #{0}. Cancelled and pending checks have no failed log to read.", reference.number));
			return;
		}
		const check = listed.checks.length === 1 ? listed.checks[0] : await this.pick(listed.checks);
		if (!check) {
			return;
		}
		const read = await this._investigator.failedLog(target, check);
		if (!read.ok) {
			this.report(read.problem, read.message, reference, check);
			return;
		}
		const state = this._details.get(sessionId, reference);
		const branch = state.status === 'loaded' && state.details.kind === 'pullRequest' && state.details.headRef ? state.details.headRef : undefined;
		await this.send(sessionId, {
			summary: pullRequestCheckSummary(target, check),
			url: check.url || reference.url,
			branch,
			log: read.log,
		}, localize('claudeCheckTurnLabel', "Investigate Failing Check: {0} on #{1}", check.name, reference.number));
	}

	private async pick(checks: readonly ClaudeFailingCheck[]): Promise<ClaudeFailingCheck | undefined> {
		const picked = await this._quickInput.pick<CheckPick>(checks.map(check => ({
			label: check.name,
			description: check.workflow,
			detail: check.runId ? undefined : localize('claudeCheckNoLog', "Not a GitHub Actions job: its log can't be read here"),
			check,
		})), { placeHolder: localize('claudeCheckPick', "Which failed check should Claude investigate?") });
		return picked?.check;
	}

	private report(problem: ClaudeGhProblem, message: string, reference: ClaudeGitHubReference, check?: ClaudeFailingCheck): void {
		switch (problem) {
			case 'ghMissing':
				this._notifications.prompt(Severity.Warning, localize('claudeCheckGhMissing', "Investigate Failing Check reads the log through the GitHub CLI. Install gh, run \"gh auth login\", then try again."), [{
					label: localize('claudeCheckInstallGh', "Get the GitHub CLI"),
					run: () => this._opener.open(URI.parse('https://cli.github.com'), { openExternal: true }),
				}]);
				return;
			case 'signedOut':
				this._notifications.warn(localize('claudeCheckSignedOut', "The GitHub CLI can't read {0}/{1}. Run \"gh auth login\" with an account that can see it, then try again.", reference.owner, reference.repo));
				return;
			case 'notActions':
				this._notifications.prompt(Severity.Info, localize('claudeCheckNotActions', "\"{0}\" is not a GitHub Actions job, so its log can't be read here.", check?.name ?? ''), [{
					label: localize('claudeCheckOpen', "Open Check"),
					run: () => this._opener.open(URI.parse(check?.url || reference.url), { openExternal: true }),
				}]);
				return;
			case 'noLog':
				this._notifications.info(localize('claudeCheckNoLogFound', "GitHub has no log for the failed steps of \"{0}\". It may have expired, or the run was restarted.", check?.name ?? ''));
				return;
			default:
				this._notifications.error(localize('claudeCheckFailed', "Couldn't read the checks of #{0}: {1}", reference.number, message));
		}
	}
}

registerSingleton(IClaudeCheckInvestigationService, ClaudeCheckInvestigationService, InstantiationType.Delayed);

/** Investigate Failing Check for the pull request the current session opened (its pill). */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CLAUDE_INVESTIGATE_FAILING_CHECK_COMMAND_ID,
			title: localize2('claudeInvestigateFailingCheck', "Investigate Failing Check"),
			category: KLAWLY_CATEGORY,
			precondition: CLAUDE_AGENT_ENABLED,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const agent = accessor.get(IClaudeAgentService);
		const investigation = accessor.get(IClaudeCheckInvestigationService);
		const notifications = accessor.get(INotificationService);
		const session = agent.getCurrentSession();
		const pullRequest = session ? agent.getViewState(session.id).pullRequest : undefined;
		if (!session || !pullRequest) {
			notifications.info(localize('claudeCheckNoPullRequest', "This chat hasn't opened a pull request. Use Investigate Failing Check on a pull request card instead."));
			return;
		}
		await investigation.investigate(session.id, pullRequest);
	}
});
