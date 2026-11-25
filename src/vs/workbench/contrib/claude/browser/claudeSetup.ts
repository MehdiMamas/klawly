/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toAction } from '../../../../base/common/actions.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ClaudeRuntimeState, IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { ClaudeAccountSignIn } from '../../../../platform/claude/common/claudeAccounts.js';
import { CLAUDE_AGENT_ENABLED_SETTING, CLAUDE_AGENT_RUNTIME_PATH_SETTING, CLAUDE_AGENT_RUNTIME_SETTING, readClaudeAgentEnabled, readClaudeAgentRuntimeKind } from '../../../../platform/claude/common/claudeConfiguration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { redactSecrets } from '../../../services/claude/common/claudeAgentLog.js';
import { IKlawlyAccountService } from '../../../services/claude/common/klawlyAccount.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { CLAUDE_AGENT_DISABLED, CLAUDE_AGENT_ENABLED } from '../common/claudeContextKeys.js';
import { CLAUDE_CODE_INSTALL_DOCS_URL, CLAUDE_INSTALL_POLL_MS, CLAUDE_INSTALL_STALL_MS, CLAUDE_STAND_IN_INSTALL_STALL_MS, ClaudeImportOffer, claudeInstallerCommand, ClaudeInstallProgress, claudeSetupPhase, ClaudeSetupPhase } from '../common/claudeRuntimeStatus.js';
import { claudeImportEditorName } from '../common/claudeImport.js';
import { IClaudeImportService } from './claudeImport.js';
import { CLAUDE_CHOOSE_RUNTIME_COMMAND_ID, CLAUDE_ENABLE_AGENT_COMMAND_ID, CLAUDE_FOCUS_AGENT_COMMAND_ID, CLAUDE_INLINE_EDIT_COMMAND_ID, CLAUDE_INSTALL_RUNTIME_COMMAND_ID, CLAUDE_REDETECT_RUNTIME_COMMAND_ID, CLAUDE_SIGN_IN_COMMAND_ID, KLAWLY_CATEGORY } from '../common/claudeViews.js';

export const IClaudeSetupService = createDecorator<IClaudeSetupService>('claudeSetupService');

/**
 * Claude onboarding (spec 6, 72). Holds the last runtime state the runtime
 * reported and runs the supported install and sign-in routes. Credentials stay
 * in Claude's own store: this service never reads them.
 */
export interface IClaudeSetupService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** Last probed state. Undefined until the runtime has answered once. */
	readonly runtime: ClaudeRuntimeState | undefined;
	readonly phase: ClaudeSetupPhase;
	/** Probes the runtime again. */
	redetect(): Promise<ClaudeRuntimeState | undefined>;
	/** Explains the official installer, then runs it in a terminal or opens the install guide. */
	install(): Promise<void>;
	/**
	 * The installer run Klawly is watching, while Claude Code is still missing
	 * (issue 783). Undefined when none runs, or once Claude Code was found.
	 */
	readonly installProgress: ClaudeInstallProgress | undefined;
	/** Runs the installer again without asking: the user already chose it. Closes the previous install terminal. */
	retryInstall(): Promise<void>;
	/** Shows the install terminal with the installer's own output. */
	showInstaller(): void;
	/** Stops the installer and closes its terminal. */
	cancelInstall(): void;
	/** Picks the Claude Code executable and writes `claude.agent.runtimePath`. */
	chooseLocation(): Promise<void>;
	/** Runs the official sign-in in a visible terminal and probes again when it ends. */
	signIn(): Promise<void>;
	/**
	 * Adds a Claude account (issue 450): the official sign-in runs in a new
	 * account folder, and once it ends Klawly keeps the account and switches to
	 * it. A runtime that keeps one account signs in as {@link signIn} does.
	 */
	addAccount(): Promise<void>;
	/** Stops waiting for a sign-in and closes its terminal. */
	cancelSignIn(): void;
	/** Turns `claude.agent.enabled` off. A notification offers Undo. */
	continueWithoutAI(): Promise<void>;
	/** The optional Import step. Undefined while neither VS Code nor Cursor was found. */
	readonly importOffer: ClaudeImportOffer | undefined;
	/** Starts the import from VS Code or Cursor. */
	importSettings(): Promise<void>;
	/** The optional Sign In with GitHub step (issue 446): true while no GitHub account is the Klawly profile. */
	readonly githubOffer: boolean;
	/** Signs in with GitHub. Skipping it changes nothing: everything works signed out. */
	signInWithGitHub(): Promise<void>;
}

export class ClaudeSetupService extends Disposable implements IClaudeSetupService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _runtime: ClaudeRuntimeState | undefined;
	private _waiting = false;
	private _probe: Promise<ClaudeRuntimeState | undefined> | undefined;
	/** Watches the install terminal until Claude Code is found. A new install replaces it. */
	private readonly _install = this._register(new MutableDisposable<DisposableStore>());
	private _installTerminal: ITerminalInstance | undefined;
	private _installProgress: ClaudeInstallProgress | undefined;
	/** When the running install last moved: it started, its download grew, or its setup began. */
	private _installMovedAt = 0;
	/** When the installer ended without Claude Code. Klawly keeps looking for a while after. */
	private _installEndedAt: number | undefined;
	private _installTicks = 0;
	private _installWatching = false;
	private readonly _signIn = this._register(new MutableDisposable<DisposableStore>());
	private _signInTerminal: ITerminalInstance | undefined;
	/** Bumped by every sign-in start and cancel, so an older sign-in that ends late changes nothing. */
	private _signInGeneration = 0;
	/** What an Add Account sign-in runs when it ends or is cancelled: keep the account, or drop its folder. */
	private _signInEnded: (() => Promise<void>) | undefined;

	/** `_os` picks the installer and the file filter: the workbench passes the OS it runs on. */
	constructor(
		private readonly _os: OperatingSystem,
		@IClaudeRuntimeService private readonly _runtimeService: IClaudeRuntimeService,
		@ITerminalService private readonly _terminals: ITerminalService,
		@IOpenerService private readonly _opener: IOpenerService,
		@IDialogService private readonly _dialogs: IDialogService,
		@IFileDialogService private readonly _fileDialogs: IFileDialogService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@INotificationService private readonly _notifications: INotificationService,
		@IHostService private readonly _host: IHostService,
		@IClaudeImportService private readonly _import: IClaudeImportService,
		@IKlawlyAccountService private readonly _profile: IKlawlyAccountService,
		@IFileService private readonly _files: IFileService,
		@IPathService private readonly _paths: IPathService,
	) {
		super();
		this._register(this._runtimeService.onDidChangeRuntimeState(state => this.apply(state)));
		this._register(this._import.onDidChange(() => this._onDidChange.fire()));
		this._register(this._profile.onDidChangeAccount(() => this._onDidChange.fire()));
		void this._import.detect();
		// Coming back from the browser sign-in page is when a waiting sign-in usually finished,
		// and coming back from another window is when an install made there may have finished.
		this._register(this._host.onDidChangeFocus(focused => {
			if (focused && (this._waiting || this.missing)) {
				void this.redetect();
			}
		}));
		// Claude Code installed from any terminal in this window, not only the Install one (issue 91).
		const recheckIfMissing = () => {
			if (this.missing) {
				void this.redetect();
			}
		};
		const commandFinished = this._register(this._terminals.createOnInstanceCapabilityEvent(TerminalCapability.CommandDetection, detection => detection.onCommandFinished));
		this._register(commandFinished.event(recheckIfMissing));
		const terminalExited = this._register(this._terminals.createOnInstanceEvent(instance => instance.onExit));
		this._register(terminalExited.event(recheckIfMissing));
		void this._runtimeService.getRuntimeState().then(state => {
			if (!this._runtime) {
				this.apply(state);
			}
		}, () => undefined);
	}

	get runtime(): ClaudeRuntimeState | undefined {
		return this._runtime;
	}

	get phase(): ClaudeSetupPhase {
		return claudeSetupPhase(this._runtime, this._waiting);
	}

	/** The runtime answered that Claude Code is not installed, so it is worth asking again. */
	private get missing(): boolean {
		return this._runtime?.installed === false;
	}

	get importOffer(): ClaudeImportOffer | undefined {
		const editors = this._import.detected;
		return editors.length ? { editors: editors.map(claudeImportEditorName), done: this._import.imported } : undefined;
	}

	importSettings(): Promise<void> {
		return this._import.run();
	}

	get githubOffer(): boolean {
		return !this._profile.account;
	}

	async signInWithGitHub(): Promise<void> {
		try {
			await this._profile.signIn();
		} catch (error) {
			this._notifications.error(localize('claudeSetupGitHubFailed', "Could not sign in with GitHub: {0}", redactSecrets(error instanceof Error ? error.message : String(error))));
		}
	}

	redetect(): Promise<ClaudeRuntimeState | undefined> {
		if (!this._probe) {
			// Cleared after the probe settles, never inside it: a probe that fails before
			// its first await would otherwise clear the field before it is set.
			const probe = this.probe();
			this._probe = probe;
			void probe.finally(() => {
				if (this._probe === probe) {
					this._probe = undefined;
				}
			});
		}
		return this._probe;
	}

	private async probe(): Promise<ClaudeRuntimeState | undefined> {
		try {
			const state = await this._runtimeService.ensureRuntime();
			if (!this._store.isDisposed) {
				this.apply(state);
			}
			return state;
		} catch (error) {
			this.report(error);
			return this._runtime;
		}
	}

	/** The fake runtime runs a stand-in installer, so tests and screenshots never download Claude Code (issue 797). */
	private get standInInstaller(): boolean {
		return readClaudeAgentRuntimeKind(this._configuration.getValue(CLAUDE_AGENT_RUNTIME_SETTING)) === 'fake';
	}

	private get installStallMs(): number {
		return this.standInInstaller ? CLAUDE_STAND_IN_INSTALL_STALL_MS : CLAUDE_INSTALL_STALL_MS;
	}

	async install(): Promise<void> {
		const installer = claudeInstallerCommand(this._os, this.standInInstaller);
		const { result } = await this._dialogs.prompt<'run' | 'docs' | undefined>({
			type: Severity.Info,
			message: localize('claudeInstallTitle', "Install Claude Code"),
			detail: localize('claudeInstallDetail', "Klawly can run the official Claude Code installer in a terminal:\n\n{0}\n\nIt installs Claude Code for your user account and does not ask for administrator rights. When it finishes, Klawly looks for Claude Code again. You can also follow the install guide in your browser.", installer.display),
			buttons: [
				{ label: localize({ key: 'claudeInstallRun', comment: ['&& denotes a mnemonic'] }, "&&Run Installer"), run: () => 'run' as const },
				{ label: localize({ key: 'claudeInstallDocs', comment: ['&& denotes a mnemonic'] }, "Open Install &&Guide"), run: () => 'docs' as const },
			],
			cancelButton: true,
		});
		const choice = await result;
		if (choice === 'docs') {
			await this._opener.open(URI.parse(CLAUDE_CODE_INSTALL_DOCS_URL), { openExternal: true });
			return;
		}
		if (choice !== 'run') {
			return;
		}
		await this.runInstaller();
	}

	get installProgress(): ClaudeInstallProgress | undefined {
		return this._installProgress;
	}

	retryInstall(): Promise<void> {
		return this.runInstaller();
	}

	showInstaller(): void {
		const terminal = this._installTerminal;
		if (terminal) {
			void this._terminals.revealTerminal(terminal).then(() => terminal.focusWhenReady(true));
		}
	}

	cancelInstall(): void {
		const terminal = this._installTerminal;
		this.stopWatchingInstall();
		terminal?.dispose();
	}

	/**
	 * Runs the official installer in a visible terminal and watches it (issue 783):
	 * the download's size and the time it has run, a stall after
	 * {@link CLAUDE_INSTALL_STALL_MS} without progress, and Claude Code itself, so a
	 * finished install is found without the installer ending or Klawly restarting.
	 */
	private async runInstaller(): Promise<void> {
		const previous = this._installTerminal;
		this.stopWatchingInstall();
		previous?.dispose();
		const installer = claudeInstallerCommand(this._os, this.standInInstaller);
		try {
			const instance = await this._terminals.createTerminal({
				config: {
					name: localize('claudeInstallTerminal', "Install Claude Code"),
					executable: installer.executable,
					args: [...installer.args],
					// A failed installer keeps its output on screen, and its terminal open while Klawly says it failed.
					waitOnExit: true,
				},
			});
			if (this._store.isDisposed) {
				instance.dispose();
				return;
			}
			const store = new DisposableStore();
			this._install.value = store;
			this._installTerminal = instance;
			const now = Date.now();
			this._installMovedAt = now;
			this._installEndedAt = undefined;
			this._installTicks = 0;
			this.setInstallProgress({ state: 'running', startedAt: now });
			const timer = store.add(new IntervalTimer());
			timer.cancelAndSet(() => void this.watchInstall(store, timer), CLAUDE_INSTALL_POLL_MS);
			store.add(instance.onExit(code => void this.installEnded(store, typeof code === 'number' ? code : undefined)));
			store.add(instance.onDisposed(() => {
				if (this._install.value === store) {
					this.stopWatchingInstall();
				}
			}));
			await this._terminals.revealTerminal(instance);
			await instance.focusWhenReady(true);
		} catch (error) {
			this.report(error);
		}
	}

	/** One look at the running install: its download, a stall, and every few looks Claude Code itself. */
	private async watchInstall(store: DisposableStore, timer: IntervalTimer): Promise<void> {
		const progress = this._installProgress;
		if (this._installWatching || this._install.value !== store || !progress) {
			return;
		}
		this._installWatching = true;
		try {
			const now = Date.now();
			let probe = ++this._installTicks % 5 === 0;
			if (this._installEndedAt !== undefined) {
				if (now - this._installEndedAt >= this.installStallMs) {
					// Long after the installer ended. Focus, Detect Again and other terminals still probe.
					timer.cancel();
					return;
				}
			} else {
				const bytes = await this.downloadedBytes(progress.startedAt);
				if (this._install.value !== store) {
					return;
				}
				let next = progress;
				if (bytes !== undefined && bytes !== progress.downloadedBytes) {
					next = { ...next, downloadedBytes: bytes };
					this._installMovedAt = now;
				} else if (bytes === undefined && progress.downloadedBytes !== undefined && !progress.settingUp) {
					// The installer removes its download once Claude Code is set up: look now.
					next = { ...next, settingUp: true };
					this._installMovedAt = now;
					probe = true;
				}
				const stalled = now - this._installMovedAt >= this.installStallMs;
				this.setInstallProgress({ ...next, state: stalled ? 'stalled' : 'running' });
			}
			if (probe) {
				await this.redetect();
			}
		} finally {
			this._installWatching = false;
		}
	}

	/** The installer ended. Claude Code found: done. Not found: say so, and keep looking for a while. */
	private async installEnded(store: DisposableStore, exitCode: number | undefined): Promise<void> {
		if (this._install.value !== store) {
			return;
		}
		this._installEndedAt = Date.now();
		await this.redetect();
		const progress = this._installProgress;
		if (this._install.value === store && progress && this.missing) {
			this.setInstallProgress({ ...progress, state: 'failed', exitCode, settingUp: false });
		}
	}

	/**
	 * Size of the download the official installer writes to `~/.claude/downloads`
	 * (`claude-<version>-<platform>`): the newest file, and only one this run wrote.
	 */
	private async downloadedBytes(startedAt: number): Promise<number | undefined> {
		try {
			const folder = joinPath(await this._paths.userHome(), '.claude', 'downloads');
			const stat = await this._files.resolve(folder, { resolveMetadata: true });
			let newest: { size: number; mtime: number } | undefined;
			for (const child of stat.children ?? []) {
				if (!child.isDirectory && child.name.startsWith('claude-') && child.mtime >= startedAt - CLAUDE_INSTALL_POLL_MS && (!newest || child.mtime > newest.mtime)) {
					newest = { size: child.size, mtime: child.mtime };
				}
			}
			return newest?.size;
		} catch {
			return undefined;
		}
	}

	private setInstallProgress(progress: ClaudeInstallProgress | undefined): void {
		const current = this._installProgress;
		if (current === progress || (current && progress && current.state === progress.state && current.startedAt === progress.startedAt && current.downloadedBytes === progress.downloadedBytes && current.settingUp === progress.settingUp && current.exitCode === progress.exitCode)) {
			return;
		}
		this._installProgress = progress;
		this._onDidChange.fire();
	}

	/** Stops watching the installer. Its terminal stays open, with the installer's output. */
	private stopWatchingInstall(): void {
		this._install.clear();
		this._installTerminal = undefined;
		this._installEndedAt = undefined;
		this.setInstallProgress(undefined);
	}

	async chooseLocation(): Promise<void> {
		const picked = await this._fileDialogs.showOpenDialog({
			title: localize('claudeChooseRuntimeTitle', "Choose Claude Code"),
			openLabel: localize({ key: 'claudeChooseRuntimeOpen', comment: ['&& denotes a mnemonic'] }, "&&Use This Claude Code"),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			availableFileSystems: [Schemas.file],
			filters: this._os === OperatingSystem.Windows ? [{ name: localize('claudeExecutables', "Programs"), extensions: ['exe'] }] : undefined,
		});
		const uri = picked?.[0];
		if (!uri) {
			return;
		}
		await this._configuration.updateValue(CLAUDE_AGENT_RUNTIME_PATH_SETTING, uri.fsPath, ConfigurationTarget.USER);
		await this.redetect();
	}

	signIn(): Promise<void> {
		return this.startSignIn(undefined, undefined);
	}

	async addAccount(): Promise<void> {
		const runtime = this._runtimeService;
		if (!runtime.addAccount || !runtime.finishAddAccount) {
			return this.signIn();
		}
		let account: ClaudeAccountSignIn;
		try {
			account = await runtime.addAccount();
		} catch (error) {
			this.report(error);
			return;
		}
		const id = account.id;
		await this.startSignIn(account.env, async () => {
			try {
				const added = await runtime.finishAddAccount!(id);
				if (added) {
					this._notifications.notify({
						severity: Severity.Info,
						message: added.email
							? localize('claudeAccountAdded', "Klawly now uses the Claude account {0}. Switch back with Switch Claude Account.", added.email)
							: localize('claudeAccountAddedUnnamed', "Klawly now uses the new Claude account. Switch back with Switch Claude Account."),
						source: KLAWLY_CATEGORY.value,
					});
				}
			} catch (error) {
				this.report(error);
			}
		});
	}

	/**
	 * Runs `claude auth login` in a visible terminal. `env` points it at an added
	 * account's folder; `ended` runs once the terminal ends or is cancelled.
	 */
	private async startSignIn(env: Readonly<Record<string, string>> | undefined, ended: (() => Promise<void>) | undefined): Promise<void> {
		this.cancelSignIn();
		const generation = this._signInGeneration;
		const store = new DisposableStore();
		this._signIn.value = store;
		this._signInEnded = ended;
		this.setWaiting(true);
		try {
			const instance = await this._terminals.createTerminal({
				config: {
					name: localize('claudeSignInTerminal', "Claude Sign In"),
					executable: this._runtime?.binaryPath || 'claude',
					args: ['auth', 'login'],
					...(env ? { env: { ...env } } : {}),
				},
			});
			if (store.isDisposed) {
				instance.dispose();
				return;
			}
			this._signInTerminal = instance;
			store.add(instance.onExit(() => void this.finishSignIn(instance)));
			store.add(instance.onDisposed(() => void this.finishSignIn(instance)));
			await this._terminals.revealTerminal(instance);
			await instance.focusWhenReady(true);
		} catch (error) {
			if (generation === this._signInGeneration) {
				// Only this sign-in's own state: a newer one may have started meanwhile.
				this._signInTerminal = undefined;
				this._signIn.clear();
				this.setWaiting(false);
				void this.takeSignInEnded()?.();
			}
			this.report(error);
		}
	}

	cancelSignIn(): void {
		this._signInGeneration++;
		const terminal = this._signInTerminal;
		this._signInTerminal = undefined;
		this._signIn.clear();
		terminal?.dispose();
		this.setWaiting(false);
		// A cancelled Add Account keeps nothing: its folder goes unless it signed in meanwhile.
		void this.takeSignInEnded()?.();
	}

	private takeSignInEnded(): (() => Promise<void>) | undefined {
		const ended = this._signInEnded;
		this._signInEnded = undefined;
		return ended;
	}

	async continueWithoutAI(): Promise<void> {
		this.cancelSignIn();
		await this._configuration.updateValue(CLAUDE_AGENT_ENABLED_SETTING, false, ConfigurationTarget.USER);
		// `notify` rather than `prompt`, so the toast names Klawly in its "Source: ..." line like the ready hint (issue 293).
		this._notifications.notify({
			severity: Severity.Info,
			message: localize('claudeContinuedWithoutAI', "Claude features are off and the editor works as usual. Turn them back on with Klawly: Turn On Claude Agent or the claude.agent.enabled setting."),
			source: KLAWLY_CATEGORY.value,
			actions: {
				primary: [toAction({
					id: 'claude.continueWithoutAI.undo',
					label: localize('claudeUndoWithoutAI', "Undo"),
					run: () => this._configuration.updateValue(CLAUDE_AGENT_ENABLED_SETTING, true, ConfigurationTarget.USER),
				})],
			},
		});
	}

	private async finishSignIn(instance: ITerminalInstance): Promise<void> {
		if (this._signInTerminal !== instance) {
			return;
		}
		const generation = this._signInGeneration;
		this._signInTerminal = undefined;
		this._signIn.clear();
		const ended = this.takeSignInEnded();
		if (ended) {
			// Add Account: keep the account and switch to it, which probes again.
			await ended();
		}
		await this.redetect();
		// The terminal ended: show what the probe found, signed in or not. A sign-in
		// started (or cancelled) while the probe ran owns the waiting state now.
		if (generation === this._signInGeneration && !this._store.isDisposed) {
			this.setWaiting(false);
		}
	}

	private apply(state: ClaudeRuntimeState): void {
		this._runtime = { ...state };
		if (state.authenticated || !state.installed) {
			this._waiting = false;
		}
		if (state.installed && this._installProgress) {
			// Found, however it was found: the install is done. Its terminal stays open.
			this._install.clear();
			this._installTerminal = undefined;
			this._installEndedAt = undefined;
			this._installProgress = undefined;
		}
		this._onDidChange.fire();
	}

	private setWaiting(waiting: boolean): void {
		if (this._waiting !== waiting) {
			this._waiting = waiting;
			this._onDidChange.fire();
		}
	}

	private report(error: unknown): void {
		this._notifications.error(redactSecrets(error instanceof Error ? error.message : String(error)));
	}
}

const HINT_SHOWN_KEY = 'claude.onboarding.readyHintShown';

/**
 * Once per profile, when a folder is open and Claude is ready, points to the
 * Agent pane and the inline edit key (spec 72). Nothing is shown before that.
 */
export class ClaudeOnboardingHintContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeOnboardingHint';

	constructor(
		@IClaudeSetupService private readonly _setup: IClaudeSetupService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IStorageService private readonly _storage: IStorageService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@INotificationService private readonly _notifications: INotificationService,
		@IKeybindingService private readonly _keybindings: IKeybindingService,
		@ICommandService private readonly _commands: ICommandService,
		@IWorkspaceTrustManagementService private readonly _trust: IWorkspaceTrustManagementService,
	) {
		super();
		if (this.shown()) {
			return;
		}
		this._register(this._setup.onDidChange(() => this.check()));
		this._register(this._workspace.onDidChangeWorkbenchState(() => this.check()));
		this._register(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_AGENT_ENABLED_SETTING)) {
				this.check();
			}
		}));
		this.check();
	}

	private shown(): boolean {
		return this._storage.getBoolean(HINT_SHOWN_KEY, StorageScope.PROFILE, false);
	}

	/**
	 * Opens and focuses the Agent. In Restricted Mode the Agent opens all the same;
	 * a notice says what is limited, with a Trust action (issue 1001, DL-14, DL-67).
	 */
	private async openAgent(): Promise<void> {
		await this._commands.executeCommand(CLAUDE_FOCUS_AGENT_COMMAND_ID);
		if (this._trust.isWorkspaceTrusted()) {
			return;
		}
		this._notifications.notify({
			severity: Severity.Info,
			message: localize('claudeRestrictedHint', "This folder is in Restricted Mode. The Agent is open, but it asks before running commands and edits outside the folder until you trust it."),
			source: KLAWLY_CATEGORY.value,
			actions: { primary: [toAction({
				id: 'claude.readyHint.trust',
				label: localize('claudeRestrictedHintTrust', "Trust Folder..."),
				run: () => this._commands.executeCommand('workbench.trust.manage'),
			})] },
		});
	}

	private check(): void {
		if (this.shown()
			|| this._workspace.getWorkbenchState() === WorkbenchState.EMPTY
			|| !readClaudeAgentEnabled(this._configuration.getValue(CLAUDE_AGENT_ENABLED_SETTING))
			|| this._setup.phase !== 'ready') {
			return;
		}
		this._storage.store(HINT_SHOWN_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
		const agentKey = this._keybindings.lookupKeybinding(CLAUDE_FOCUS_AGENT_COMMAND_ID)?.getLabel();
		const inlineKey = this._keybindings.lookupKeybinding(CLAUDE_INLINE_EDIT_COMMAND_ID)?.getLabel();
		const message = agentKey && inlineKey
			? localize('claudeReadyHintKeys', "Claude is ready. Open the Agent with {0}, or select code and press {1} to edit it inline.", agentKey, inlineKey)
			: localize('claudeReadyHint', "Claude is ready. Open the Agent in the secondary side bar, or select code and run Inline Edit.");
		const primary = [toAction({
			id: 'claude.readyHint.openAgent',
			label: localize('claudeReadyHintOpen', "Open Agent"),
			run: () => this.openAgent(),
		})];
		const offer = this._setup.importOffer;
		if (offer && !offer.done) {
			primary.push(toAction({
				id: 'claude.readyHint.importSettings',
				label: localize('claudeReadyHintImport', "Import Settings..."),
				run: () => this._setup.importSettings(),
			}));
		}
		// The toast names Klawly in its "Source: ..." line, which `prompt` cannot set (issue 164). The import action stays neutral and opens the source picker; "Do not show again" is offered (issue 1000, DL-23).
		this._notifications.notify({ severity: Severity.Info, message, source: KLAWLY_CATEGORY.value, actions: { primary }, neverShowAgain: { id: 'claude.readyHint', isSecondary: true } });
	}
}

/** Palette entries for every onboarding action, so none needs the setup card. */
export function registerClaudeSetupCommands(): void {
	const category = KLAWLY_CATEGORY;

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: CLAUDE_REDETECT_RUNTIME_COMMAND_ID, title: localize2('claudeRedetectRuntime', "Re-detect Claude Runtime"), category, f1: true, precondition: CLAUDE_AGENT_ENABLED });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IClaudeSetupService).redetect();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: CLAUDE_SIGN_IN_COMMAND_ID, title: { ...localize2('claudeSignIn', "Sign In to Claude"), original: 'Sign In to Claude (Log In, Login)' }, category, f1: true, precondition: CLAUDE_AGENT_ENABLED });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IClaudeSetupService).signIn();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: CLAUDE_INSTALL_RUNTIME_COMMAND_ID, title: localize2('claudeInstallRuntime', "Install Claude Code"), category, f1: true, precondition: CLAUDE_AGENT_ENABLED });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IClaudeSetupService).install();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: CLAUDE_CHOOSE_RUNTIME_COMMAND_ID, title: localize2('claudeChooseRuntime', "Choose Claude Code Location..."), category, f1: true, precondition: CLAUDE_AGENT_ENABLED });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IClaudeSetupService).chooseLocation();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: CLAUDE_ENABLE_AGENT_COMMAND_ID, title: localize2('claudeEnableAgent', "Turn On Claude Agent"), category, f1: true, precondition: CLAUDE_AGENT_DISABLED });
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const configuration = accessor.get(IConfigurationService);
			const commands = accessor.get(ICommandService);
			await configuration.updateValue(CLAUDE_AGENT_ENABLED_SETTING, true, ConfigurationTarget.USER);
			await commands.executeCommand(CLAUDE_FOCUS_AGENT_COMMAND_ID);
		}
	});
}
