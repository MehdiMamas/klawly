/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import Severity from '../../../../base/common/severity.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { backgroundBranchName, backgroundWorktreePath, IClaudeWorktreeService } from '../../../../platform/claude/common/claudeBackground.js';
import { CLAUDE_CLOUD_BRING_BACK_COMMAND_ID, CLAUDE_CLOUD_SEND_COMMAND_ID, CLAUDE_CLOUD_START_COMMAND_ID, ClaudeCloudCapability, ClaudeCloudSendResult, claudeCloudReviewDocument, claudeCloudStartArguments, claudeTeleportArguments, readClaudeCloudSessionId, readClaudeCloudText } from '../../../../platform/claude/common/claudeCloud.js';
import { CLAUDE_GIT_BRANCH_PREFIX_SETTING, readClaudeBranchPrefix } from '../../../../platform/claude/common/claudeGitSettings.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INativeWorkbenchEnvironmentService } from '../../../services/environment/electron-browser/environmentService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IClaudeCloudSessionsService } from '../browser/claudeCloudSessions.js';
import { CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { KLAWLY_CATEGORY } from '../common/claudeViews.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';

type CloudFeature = 'cloud' | 'teleport';

/**
 * Cloud agents (issue 516): Claude Code's own cloud sessions on the user's
 * Claude account, which keep running when Klawly closes. Claude Code starts
 * and teleports them only in its interactive terminal UI, so Klawly runs those
 * steps in a visible terminal after showing the exact command; a follow-up
 * message goes through `claude -p --cloud` in the shared process. Inputs are
 * quick inputs (DL-21); outcomes and missing options are notifications (DL-23).
 */
class ClaudeCloudAgents {

	constructor(
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IClaudeCloudSessionsService private readonly _cloudSessions: IClaudeCloudSessionsService,
		@IClaudeWorktreeService private readonly _worktrees: IClaudeWorktreeService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IDialogService private readonly _dialogs: IDialogService,
		@INativeWorkbenchEnvironmentService private readonly _environment: INativeWorkbenchEnvironmentService,
		@IEditorService private readonly _editors: IEditorService,
		@IHostService private readonly _host: IHostService,
		@INotificationService private readonly _notifications: INotificationService,
		@IOpenerService private readonly _opener: IOpenerService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@ITerminalService private readonly _terminals: ITerminalService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
	) { }

	/** Starts a cloud session for the workspace folder's GitHub remote at its current branch. */
	async start(initialTask?: string): Promise<void> {
		const folder = this.folder();
		const capability = folder && await this.capability('cloud');
		if (!folder || !capability?.binary) {
			return;
		}
		const task = readClaudeCloudText(initialTask) ?? readClaudeCloudText(await this._quickInput.input({
			prompt: localize('claudeCloudTaskPrompt', "What should Claude Code do in the cloud? It runs on your Claude account and keeps going when Klawly closes."),
			placeHolder: localize('claudeCloudTaskPlaceholder', "Fix the flaky checkout test"),
			validateInput: async value => value.trim() && !readClaudeCloudText(value) ? localize('claudeCloudTaskTooLong', "Keep the task under 8,000 characters.") : undefined,
		}));
		if (!task) {
			return;
		}
		const args = claudeCloudStartArguments(task);
		const { confirmed } = await this._dialogs.confirm({
			type: Severity.Info,
			message: localize('claudeCloudStartTitle', "Start a Claude Code Cloud Session?"),
			detail: localize('claudeCloudStartDetail', "Claude Code runs this task on Anthropic's cloud with your Claude account and plan limits. The cloud machine clones this folder's GitHub remote at the current branch, so push local commits first. Without a GitHub remote, Claude Code uploads the repository instead, including uncommitted changes to tracked files.\n\nKlawly runs this in a terminal:\n\n{0}\n\nThe session keeps going when Klawly closes. Follow it at claude.ai/code, then use Bring Back Cloud Session to continue it here.", this.display(args)),
			primaryButton: localize({ key: 'claudeCloudStartRun', comment: ['&& denotes a mnemonic'] }, "&&Start in Cloud"),
		});
		if (!confirmed) {
			return;
		}
		await this.runInTerminal(localize('claudeCloudStartTerminal', "Claude Code Cloud"), capability.binary, args, folder);
		// The Agents column lists it as a cloud agent (issue 532); the terminal start never reports its session ID.
		this._cloudSessions.record({ title: task });
	}

	/** Teleports a cloud session and its branch into a new worktree, so the workspace folder stays as it is. */
	async bringBack(knownSessionId?: string): Promise<void> {
		const folder = this.folder();
		const capability = folder && await this.capability('teleport');
		if (!folder || !capability?.binary) {
			return;
		}
		// An Agents column cloud row passes its session ID (issue 532).
		const value = knownSessionId ?? await this.askSession(localize('claudeCloudBringBackPrompt', "The cloud session ID or its claude.ai/code link. Leave it empty to pick from Claude Code's list."));
		if (value === undefined) {
			return;
		}
		const sessionId = readClaudeCloudSessionId(value);
		const repoRoot = folder.fsPath;
		const id = `cloud-${generateUuid().slice(0, 8)}`;
		const worktreePath = backgroundWorktreePath(this._environment.userDataPath, repoRoot, id);
		let baseRef: string;
		try {
			baseRef = await this._worktrees.head(repoRoot);
			await this._worktrees.add(repoRoot, worktreePath, backgroundBranchName(id, readClaudeBranchPrefix(this._configuration.getValue(CLAUDE_GIT_BRANCH_PREFIX_SETTING))), baseRef);
		} catch (error) {
			this._notifications.error(localize('claudeCloudWorktreeFailed', "Klawly could not create a worktree for the cloud session: {0}", error instanceof Error ? error.message : String(error)));
			return;
		}
		const worktree = URI.file(worktreePath);
		await this.runInTerminal(localize('claudeCloudBringBackTerminal', "Bring Back {0}", sessionId ?? localize('claudeCloudSessionAny', "Cloud Session")), capability.binary, claudeTeleportArguments(sessionId), worktree);
		this._notifications.prompt(Severity.Info, localize('claudeCloudBringBackNotice', "Claude Code fetches the cloud session's branch into a new worktree at {0} and continues the conversation in the terminal. Review the diff before you open the worktree.", worktreePath), [{
			label: localize('claudeCloudReviewDiff', "Review Diff"),
			run: () => this.reviewDiff(worktreePath, baseRef),
		}, {
			label: localize('claudeCloudOpenWorktree', "Open Worktree"),
			run: () => this._host.openWindow([{ folderUri: worktree }], { forceNewWindow: true }),
		}]);
	}

	/** Opens the brought-back worktree's patch against its starting commit in a read-only diff editor, without opening the worktree (issue 864). */
	private async reviewDiff(worktreePath: string, baseRef: string): Promise<void> {
		try {
			const [diff, summary] = await Promise.all([this._worktrees.diff(worktreePath, baseRef), this._worktrees.summarize(worktreePath, baseRef)]);
			const contents = claudeCloudReviewDocument(diff, summary);
			if (!contents) {
				this._notifications.info(localize('claudeCloudReviewEmpty', "The worktree has no changes yet. Claude Code may still be fetching the cloud session's branch in the terminal; try again when it is done."));
				return;
			}
			await this._editors.openEditor({ resource: undefined, contents, languageId: 'diff', options: { pinned: true } });
		} catch (error) {
			this._notifications.error(localize('claudeCloudReviewFailed', "Klawly could not read the worktree's changes: {0}", error instanceof Error ? error.message : String(error)));
		}
	}

	/** Queues one message into a running cloud session. Claude Code does not wait for the reply. */
	async send(knownSessionId?: string): Promise<void> {
		const capability = await this.capability('cloud');
		if (!capability?.binary) {
			return;
		}
		const sessionId = readClaudeCloudSessionId(knownSessionId ?? await this.askSession(localize('claudeCloudSendSessionPrompt', "The cloud session ID or its claude.ai/code link.")));
		if (!sessionId) {
			return;
		}
		const message = readClaudeCloudText(await this._quickInput.input({
			prompt: localize('claudeCloudSendMessagePrompt', "The message for {0}. Claude Code reads it when the session is ready.", sessionId),
		}));
		if (!message) {
			return;
		}
		let result: ClaudeCloudSendResult;
		try {
			if (!this._runtime.sendToCloudSession) {
				throw new Error(localize('claudeCloudNoSend', "This Claude runtime cannot reach cloud sessions."));
			}
			result = await this._runtime.sendToCloudSession({ session: sessionId, message, cwd: this.folder()?.fsPath });
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (!result.ok) {
			this._notifications.error(localize('claudeCloudSendFailed', "Claude Code could not send the message to {0}: {1}", sessionId, result.error ?? ''));
			return;
		}
		this._cloudSessions.record({ sessionId: result.sessionId ?? sessionId, title: message });
		const url = result.url;
		this._notifications.prompt(Severity.Info, localize('claudeCloudSent', "Sent to cloud session {0}.", result.sessionId ?? sessionId), url ? [{
			label: localize('claudeCloudOpenSession', "Open on claude.ai"),
			run: () => this._opener.open(URI.parse(url), { openExternal: true }),
		}] : []);
	}

	/** Asks for a session ID or a claude.ai/code link (DL-21). An empty answer is allowed; Escape is undefined. */
	private askSession(prompt: string): Promise<string | undefined> {
		return this._quickInput.input({
			prompt,
			placeHolder: localize('claudeCloudSessionPlaceholder', "session_01... or https://claude.ai/code/session_01..."),
			validateInput: async input => input.trim() && !readClaudeCloudSessionId(input) ? localize('claudeCloudSessionInvalid', "Use a session ID (session_..., cse_...) or a claude.ai/code link.") : undefined,
		});
	}

	/** The workspace's local folder; cloud sessions start from its git checkout. */
	private folder(): URI | undefined {
		const folder = this._workspace.getWorkspace().folders.find(candidate => candidate.uri.scheme === Schemas.file);
		if (!folder) {
			this._notifications.error(localize('claudeCloudNoFolder', "Open a local folder that is a git checkout before using Claude Code cloud sessions."));
		}
		return folder?.uri;
	}

	/** The installed Claude Code when it has the option; otherwise says which update is needed. */
	private async capability(feature: CloudFeature): Promise<ClaudeCloudCapability | undefined> {
		const capability = await this._runtime.getCloudCapability?.();
		if (capability?.[feature] && capability.binary) {
			return capability;
		}
		if (capability?.error || !capability?.binary) {
			this._notifications.error(localize('claudeCloudNoRuntime', "Klawly could not read what this Claude Code supports: {0}", capability?.error ?? localize('claudeCloudNoRuntimeUnknown', "this runtime cannot reach cloud sessions")));
			return undefined;
		}
		this._notifications.error(feature === 'cloud'
			? localize('claudeCloudNeedsCloud', "Claude Code {0} cannot start cloud sessions: it has no --cloud option. Cloud agents need Claude Code 2.1.296 or later; update Claude Code, then try again.", capability.version ?? '')
			: localize('claudeCloudNeedsTeleport', "Claude Code {0} cannot bring back cloud sessions: it has no --teleport option. Update Claude Code, then try again.", capability.version ?? ''));
		return undefined;
	}

	private display(args: readonly string[]): string {
		return ['claude', ...args.map(arg => /[\s"]/.test(arg) ? JSON.stringify(arg) : arg)].join(' ');
	}

	private async runInTerminal(name: string, executable: string, args: readonly string[], cwd: URI): Promise<void> {
		const instance = await this._terminals.createTerminal({ config: { name, executable, args: [...args], cwd } });
		await this._terminals.revealTerminal(instance);
	}
}

/** Klawly: Start Cloud Agent, Bring Back Cloud Session and Send to Cloud Session, from the command palette and Run in. */
export function registerClaudeCloudAgents(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_CLOUD_START_COMMAND_ID,
				title: localize2('klawlyCloudStart', "Start Cloud Agent..."),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		run(accessor: ServicesAccessor, task?: unknown): Promise<void> {
			return accessor.get(IInstantiationService).createInstance(ClaudeCloudAgents).start(typeof task === 'string' ? task : undefined);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_CLOUD_BRING_BACK_COMMAND_ID,
				title: localize2('klawlyCloudBringBack', "Bring Back Cloud Session..."),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		run(accessor: ServicesAccessor, sessionId?: unknown): Promise<void> {
			return accessor.get(IInstantiationService).createInstance(ClaudeCloudAgents).bringBack(typeof sessionId === 'string' ? sessionId : undefined);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_CLOUD_SEND_COMMAND_ID,
				title: localize2('klawlyCloudSend', "Send to Cloud Session..."),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		run(accessor: ServicesAccessor, sessionId?: unknown): Promise<void> {
			return accessor.get(IInstantiationService).createInstance(ClaudeCloudAgents).send(typeof sessionId === 'string' ? sessionId : undefined);
		}
	});
}
