/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeRuntimeState, IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { CLAUDE_AGENT_ENABLED_SETTING, CLAUDE_AGENT_RUNTIME_PATH_SETTING, CLAUDE_AGENT_RUNTIME_SETTING } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IAsyncPromptResult, IDialogService, IFileDialogService, IOpenDialogOptions, IPrompt, IPromptButton } from '../../../../../platform/dialogs/common/dialogs.js';
import { MockKeybindingService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { INotification, INotificationHandle, Severity } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { TestContextService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IKlawlyAccountService } from '../../../../services/claude/common/klawlyAccount.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ICreateTerminalOptions, ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { IClaudeImportService } from '../../browser/claudeImport.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { ClaudeOnboardingHintContribution, ClaudeSetupService, IClaudeSetupService } from '../../browser/claudeSetup.js';
import { CLAUDE_CODE_INSTALL_DOCS_URL, CLAUDE_INSTALL_STALL_MS, CLAUDE_STAND_IN_INSTALL_STALL_MS } from '../../common/claudeRuntimeStatus.js';
import { CLAUDE_FOCUS_AGENT_COMMAND_ID } from '../../common/claudeViews.js';

const missing: ClaudeRuntimeState = { installed: false, authenticated: false, error: 'Claude Code is not installed.' };
const signedOut: ClaudeRuntimeState = { installed: true, authenticated: false, version: '2.1.0', binaryPath: '/usr/local/bin/claude' };
const ready: ClaudeRuntimeState = { installed: true, authenticated: true, version: '2.1.0', binaryPath: '/usr/local/bin/claude' };

/** Lets queued promise callbacks run. */
function settle(): Promise<void> {
	return timeout(0);
}

class FakeTerminal {
	private readonly _onExit = new Emitter<number | undefined>();
	private readonly _onDisposed = new Emitter<ITerminalInstance>();
	readonly onExit = this._onExit.event;
	readonly onDisposed = this._onDisposed.event;
	disposed = false;
	focused = false;

	constructor(readonly options: ICreateTerminalOptions | undefined) { }

	async focusWhenReady(): Promise<void> {
		this.focused = true;
	}

	/** The process ended. The terminal tab stays open, as a real one does. */
	exit(code = 0): void {
		this._onExit.fire(code);
	}

	dispose(): void {
		if (!this.disposed) {
			this.disposed = true;
			this._onDisposed.fire(this as unknown as ITerminalInstance);
		}
		this._onExit.dispose();
		this._onDisposed.dispose();
	}
}

class RecordingConfiguration extends TestConfigurationService {
	readonly writes: [string, unknown, ConfigurationTarget | undefined][] = [];

	override updateValue(key: string, value: unknown, target?: unknown): Promise<void> {
		this.writes.push([key, value, target as ConfigurationTarget | undefined]);
		return this.setUserConfiguration(key, value);
	}
}

class RecordingNotifications extends TestNotificationService {
	readonly errors: string[] = [];
	readonly notified: INotification[] = [];

	override notify(notification: INotification): INotificationHandle {
		this.notified.push(notification);
		return super.notify(notification);
	}

	override error(error: string | Error): INotificationHandle {
		this.errors.push(String(error));
		return super.error(error);
	}
}

/** Runtime double: a test sets the state the next probe reports, or holds a probe open. */
class FakeRuntime {
	private readonly _onDidChangeRuntimeState = new Emitter<ClaudeRuntimeState>();
	readonly onDidChangeRuntimeState = this._onDidChangeRuntimeState.event;
	probes = 0;
	/** Thrown synchronously by the next `ensureRuntime` call. */
	throwNext: Error | undefined;
	/** While set, `ensureRuntime` waits for it. */
	gate: DeferredPromise<void> | undefined;

	constructor(public state: ClaudeRuntimeState) { }

	getRuntimeState(): Promise<ClaudeRuntimeState> {
		return Promise.resolve(this.state);
	}

	ensureRuntime(): Promise<ClaudeRuntimeState> {
		this.probes++;
		const error = this.throwNext;
		if (error) {
			this.throwNext = undefined;
			throw error;
		}
		const gate = this.gate;
		return gate ? gate.p.then(() => this.state) : Promise.resolve(this.state);
	}

	dispose(): void {
		this._onDidChangeRuntimeState.dispose();
	}
}

suite('Claude setup service', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function create(options: { runtime?: ClaudeRuntimeState; os?: OperatingSystem; choice?: 'run' | 'docs' | 'cancel'; picked?: URI[]; failTerminal?: boolean; fakeRuntime?: boolean } = {}) {
		const store = disposables.add(new DisposableStore());
		const runtime = new FakeRuntime(options.runtime ?? missing);
		store.add(runtime);
		const terminals: FakeTerminal[] = [];
		const revealed: FakeTerminal[] = [];
		// A command that ends, or a terminal that exits, in any terminal of the window.
		const commandFinished = store.add(new Emitter<void>());
		const terminalExited = store.add(new Emitter<void>());
		const terminalService = {
			createOnInstanceCapabilityEvent: () => ({ event: commandFinished.event, dispose: () => { } }),
			createOnInstanceEvent: () => ({ event: terminalExited.event, dispose: () => { } }),
			createTerminal: async (createOptions?: ICreateTerminalOptions) => {
				if (options.failTerminal) {
					throw new Error('No terminal');
				}
				const terminal = new FakeTerminal(createOptions);
				store.add(terminal);
				terminals.push(terminal);
				return terminal;
			},
			revealTerminal: async (terminal: FakeTerminal) => { revealed.push(terminal); },
		} as unknown as ITerminalService;
		const opened: [string, boolean | undefined][] = [];
		const opener = {
			open: async (target: URI, openOptions?: { openExternal?: boolean }) => {
				opened.push([target.toString(true), openOptions?.openExternal]);
				return true;
			},
		} as unknown as IOpenerService;
		const dialogs: { message: string; detail?: string; buttons: string[]; cancel: boolean }[] = [];
		const dialogService = {
			prompt: async <T>(prompt: IPrompt<T>): Promise<IAsyncPromptResult<T>> => {
				const buttons = (prompt.buttons ?? []) as IPromptButton<T>[];
				dialogs.push({ message: prompt.message, detail: typeof prompt.detail === 'string' ? prompt.detail : undefined, buttons: buttons.map(button => button.label), cancel: !!prompt.cancelButton });
				const index = options.choice === 'run' ? 0 : options.choice === 'docs' ? 1 : -1;
				const button = index >= 0 ? buttons[index] : undefined;
				const result: Promise<T> | undefined = button ? Promise.resolve(button.run({ checkboxChecked: false })) : undefined;
				return { result };
			},
		} as unknown as IDialogService;
		const openDialogs: IOpenDialogOptions[] = [];
		const fileDialogs = {
			showOpenDialog: async (dialogOptions: IOpenDialogOptions) => {
				openDialogs.push(dialogOptions);
				return options.picked;
			},
		} as unknown as IFileDialogService;
		const configuration = new RecordingConfiguration();
		if (options.fakeRuntime) {
			void configuration.setUserConfiguration(CLAUDE_AGENT_RUNTIME_SETTING, 'fake');
		}
		const notifications = new RecordingNotifications();
		const focus = store.add(new Emitter<boolean>());
		const host = { onDidChangeFocus: focus.event, hasFocus: true } as unknown as IHostService;
		const importService = {
			onDidChange: Event.None,
			detected: [],
			imported: false,
			detect: async () => [],
			run: async () => undefined,
		} as unknown as IClaudeImportService;
		const profile = { account: undefined, onDidChangeAccount: Event.None } as Partial<IKlawlyAccountService> as IKlawlyAccountService;
		// What the official installer has in ~/.claude/downloads: a test writes the file it is downloading.
		const downloads = new Map<string, number>();
		const resolved: string[] = [];
		const files = {
			resolve: async (resource: URI) => {
				resolved.push(resource.path);
				if (!downloads.size) {
					throw new Error('ENOENT');
				}
				return { resource, children: [...downloads].map(([name, size]) => ({ name, isDirectory: false, size, mtime: Date.now() })) };
			},
		} as unknown as IFileService;
		const paths = { userHome: async () => URI.file('/home/test') } as unknown as IPathService;
		const service = store.add(new ClaudeSetupService(options.os ?? OperatingSystem.Linux, runtime as unknown as IClaudeRuntimeService, terminalService, opener, dialogService, fileDialogs, configuration, notifications, host, importService, profile, files, paths));
		return { store, service, runtime, terminals, revealed, opened, dialogs, openDialogs, configuration, notifications, focus, commandFinished, terminalExited, downloads, resolved };
	}

	function terminalConfig(terminal: FakeTerminal | undefined) {
		const config = terminal?.options?.config as { name?: string; executable?: string; args?: string[] } | undefined;
		return { name: config?.name, executable: config?.executable, args: config?.args };
	}

	test('Install explains the official installer and runs it in a terminal for each OS', async () => {
		const results = [];
		for (const os of [OperatingSystem.Windows, OperatingSystem.Macintosh, OperatingSystem.Linux]) {
			const setup = create({ os, choice: 'run' });
			await setup.service.install();
			results.push({ os, terminal: terminalConfig(setup.terminals[0]), revealed: setup.revealed.length, focused: setup.terminals[0]?.focused, buttons: setup.dialogs[0].buttons, cancel: setup.dialogs[0].cancel, mentionsCommand: !!setup.dialogs[0].detail?.includes(String(terminalConfig(setup.terminals[0]).args?.at(-1))), keepsOpen: (setup.terminals[0]?.options?.config as { waitOnExit?: boolean } | undefined)?.waitOnExit });
		}
		assert.deepStrictEqual(results, [
			{ os: OperatingSystem.Windows, terminal: { name: 'Install Claude Code', executable: 'powershell.exe', args: ['-NoProfile', '-Command', 'irm https://claude.ai/install.ps1 | iex'] }, revealed: 1, focused: true, buttons: ['&&Run Installer', 'Open Install &&Guide'], cancel: true, mentionsCommand: true, keepsOpen: true },
			{ os: OperatingSystem.Macintosh, terminal: { name: 'Install Claude Code', executable: '/bin/bash', args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'] }, revealed: 1, focused: true, buttons: ['&&Run Installer', 'Open Install &&Guide'], cancel: true, mentionsCommand: true, keepsOpen: true },
			{ os: OperatingSystem.Linux, terminal: { name: 'Install Claude Code', executable: '/bin/bash', args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'] }, revealed: 1, focused: true, buttons: ['&&Run Installer', 'Open Install &&Guide'], cancel: true, mentionsCommand: true, keepsOpen: true },
		]);
	});

	test('Install: Open Install Guide opens the docs in the browser; Cancel does nothing', async () => {
		const docs = create({ choice: 'docs' });
		await docs.service.install();
		const cancel = create({ choice: 'cancel' });
		await cancel.service.install();
		assert.deepStrictEqual({
			docs: { opened: docs.opened, terminals: docs.terminals.length },
			cancel: { opened: cancel.opened, terminals: cancel.terminals.length, probes: cancel.runtime.probes },
		}, {
			docs: { opened: [[CLAUDE_CODE_INSTALL_DOCS_URL, true]], terminals: 0 },
			cancel: { opened: [], terminals: 0, probes: 0 },
		});
	});

	test('when the install terminal ends, Claude is detected again; a closed install terminal stops listening', async () => {
		const setup = create({ choice: 'run' });
		await settle();
		const before = setup.service.phase;
		await setup.service.install();
		setup.runtime.state = signedOut;
		setup.terminals[0].exit(0);
		await settle();
		const afterExit = { phase: setup.service.phase, probes: setup.runtime.probes };

		await setup.service.install();
		setup.terminals[1].dispose();
		setup.terminals[1].exit(0);
		await settle();
		assert.deepStrictEqual({ before, afterExit, probesAfterClose: setup.runtime.probes }, {
			before: 'missing',
			afterExit: { phase: 'signed-out', probes: 1 },
			probesAfterClose: 1,
		});
	});

	test('a running install shows its download growing, and Claude Code is found before the installer ends (issue 783)', () => runWithFakedTimers({ maxTaskCount: 1000 }, async () => {
		const setup = create({ choice: 'run' });
		await settle();
		await setup.service.install();
		const started = setup.service.installProgress;
		setup.downloads.set('claude-2.1.299-linux-x64', 10 * 1024 * 1024);
		await timeout(2000);
		const downloading = setup.service.installProgress;
		// The installer removed its download: it is setting Claude Code up, so Klawly looks right away.
		setup.downloads.clear();
		setup.runtime.state = signedOut;
		await timeout(2000);
		assert.deepStrictEqual({
			started: started?.state,
			downloading: { state: downloading?.state, bytes: downloading?.downloadedBytes },
			folder: setup.resolved[0],
			phase: setup.service.phase,
			install: setup.service.installProgress,
			terminalOpen: !setup.terminals[0].disposed,
			probes: setup.runtime.probes,
		}, {
			started: 'running',
			downloading: { state: 'running', bytes: 10 * 1024 * 1024 },
			folder: '/home/test/.claude/downloads',
			phase: 'signed-out',
			install: undefined,
			terminalOpen: true,
			probes: 1,
		});
		setup.store.dispose();
	}));

	test('an install without progress for 3 minutes is stalled; progress clears it, and Retry starts over without asking (issue 783)', () => runWithFakedTimers({ maxTaskCount: 1000 }, async () => {
		const setup = create({ choice: 'run' });
		await settle();
		await setup.service.install();
		await timeout(CLAUDE_INSTALL_STALL_MS - 1000);
		const before = setup.service.installProgress?.state;
		await timeout(2000);
		const stalled = { state: setup.service.installProgress?.state, probes: setup.runtime.probes };
		setup.downloads.set('claude-2.1.299-linux-x64', 1024 * 1024);
		await timeout(2000);
		const moving = setup.service.installProgress?.state;
		setup.downloads.clear();
		await setup.service.retryInstall();
		assert.deepStrictEqual({
			before,
			stalled,
			moving,
			retry: { state: setup.service.installProgress?.state, startedAt: setup.service.installProgress?.startedAt, terminals: setup.terminals.length, firstClosed: setup.terminals[0].disposed, dialogs: setup.dialogs.length },
		}, {
			before: 'running',
			// Every fifth look also probes for Claude Code: 90 looks in 3 minutes.
			stalled: { state: 'stalled', probes: 18 },
			moving: 'running',
			retry: { state: 'running', startedAt: Date.now(), terminals: 2, firstClosed: true, dialogs: 1 },
		});
		setup.store.dispose();
	}));

	test('with the fake runtime, Install runs a stand-in that downloads nothing and stalls after 15 seconds (issue 797)', () => runWithFakedTimers({ maxTaskCount: 1000 }, async () => {
		const windows = create({ os: OperatingSystem.Windows, choice: 'run', fakeRuntime: true });
		await windows.service.install();
		const setup = create({ os: OperatingSystem.Macintosh, choice: 'run', fakeRuntime: true });
		await settle();
		await setup.service.install();
		await timeout(CLAUDE_STAND_IN_INSTALL_STALL_MS - 1000);
		const before = setup.service.installProgress?.state;
		// The install is looked at every 2 seconds: the first look past 15 seconds is at 16.
		await timeout(3000);
		assert.deepStrictEqual({
			windows: terminalConfig(windows.terminals[0]).args,
			mac: terminalConfig(setup.terminals[0]),
			before,
			after: setup.service.installProgress?.state,
		}, {
			windows: ['-NoProfile', '-Command', 'Write-Output \'Klawly test installer: this downloads nothing and fails on purpose.\'; Start-Sleep -Seconds 40; exit 1'],
			mac: { name: 'Install Claude Code', executable: '/bin/bash', args: ['-c', 'echo \'Klawly test installer: this downloads nothing and fails on purpose.\'; sleep 40; exit 1'] },
			before: 'running',
			after: 'stalled',
		});
		windows.store.dispose();
		setup.store.dispose();
	}));

	test('an installer that ends without Claude Code fails with its exit code; Klawly keeps looking for a while (issue 783)', () => runWithFakedTimers({ maxTaskCount: 1000 }, async () => {
		const setup = create({ choice: 'run' });
		await settle();
		await setup.service.install();
		setup.terminals[0].exit(1);
		await settle();
		const failed = setup.service.installProgress;
		const failedView = { state: failed?.state, exitCode: failed?.exitCode, probes: setup.runtime.probes };
		await timeout(CLAUDE_INSTALL_STALL_MS + 10_000);
		const probesLater = setup.runtime.probes;
		await timeout(60_000);
		const stoppedLooking = setup.runtime.probes === probesLater;

		const found = create({ choice: 'run' });
		await settle();
		await found.service.install();
		found.terminals[0].exit(1);
		await settle();
		found.runtime.state = signedOut;
		// The installer has ended; Klawly still probes every fifth look (10 s).
		await timeout(11_000);
		assert.deepStrictEqual({ failedView, stoppedLooking, found: { phase: found.service.phase, install: found.service.installProgress } }, {
			failedView: { state: 'failed', exitCode: 1, probes: 1 },
			stoppedLooking: true,
			found: { phase: 'signed-out', install: undefined },
		});
		setup.store.dispose();
		found.store.dispose();
	}));

	test('Cancel Install closes the installer and stops watching (issue 783)', async () => {
		const setup = create({ choice: 'run' });
		await settle();
		await setup.service.install();
		const running = setup.service.installProgress?.state;
		setup.service.cancelInstall();
		await settle();
		assert.deepStrictEqual({ running, install: setup.service.installProgress, closed: setup.terminals[0].disposed, phase: setup.service.phase }, {
			running: 'running',
			install: undefined,
			closed: true,
			phase: 'missing',
		});
	});

	test('while Claude Code is missing, a command or terminal that ends anywhere and window focus probe again (issue 91)', async () => {
		const setup = create();
		await settle();
		setup.commandFinished.fire();
		await settle();
		setup.terminalExited.fire();
		await settle();
		setup.runtime.state = signedOut;
		setup.focus.fire(true);
		await settle();
		const found = { phase: setup.service.phase, probes: setup.runtime.probes };

		setup.commandFinished.fire();
		setup.terminalExited.fire();
		setup.focus.fire(true);
		await settle();
		assert.deepStrictEqual({ found, probesOnceInstalled: setup.runtime.probes }, {
			found: { phase: 'signed-out', probes: 3 },
			probesOnceInstalled: 3,
		});
	});

	test('before the runtime has answered, nothing probes again', async () => {
		const setup = create();
		setup.commandFinished.fire();
		setup.focus.fire(true);
		assert.strictEqual(setup.runtime.probes, 0);
		await settle();
	});

	test('Sign In runs claude auth login in a terminal; signed out after it ends keeps the sign-in card', async () => {
		const setup = create({ runtime: signedOut });
		await settle();
		await setup.service.signIn();
		const waiting = setup.service.phase;
		setup.terminals[0].exit(0);
		await settle();
		// Closing the tab after the exit must not probe a second time.
		setup.terminals[0].dispose();
		await settle();
		assert.deepStrictEqual({ terminal: terminalConfig(setup.terminals[0]), revealed: setup.revealed.length, waiting, after: setup.service.phase, probes: setup.runtime.probes }, {
			terminal: { name: 'Claude Sign In', executable: '/usr/local/bin/claude', args: ['auth', 'login'] },
			revealed: 1,
			waiting: 'waiting-sign-in',
			after: 'signed-out',
			probes: 1,
		});

		await setup.service.signIn();
		setup.runtime.state = ready;
		setup.terminals[1].exit(0);
		await settle();
		assert.strictEqual(setup.service.phase, 'ready');
	});

	test('Sign In without a probed binary uses claude from PATH; a terminal that fails to start reports and stops waiting', async () => {
		const plain = create({ runtime: { installed: true, authenticated: false } });
		await settle();
		await plain.service.signIn();
		const failing = create({ runtime: signedOut, failTerminal: true });
		await settle();
		await failing.service.signIn();
		assert.deepStrictEqual({
			executable: terminalConfig(plain.terminals[0]).executable,
			failingPhase: failing.service.phase,
			errors: failing.notifications.errors,
		}, {
			executable: 'claude',
			failingPhase: 'signed-out',
			errors: ['No terminal'],
		});
	});

	test('Cancel Sign In closes the terminal and stops waiting; the closed terminal does not probe', async () => {
		const setup = create({ runtime: signedOut });
		await settle();
		await setup.service.signIn();
		setup.service.cancelSignIn();
		await settle();
		assert.deepStrictEqual({ disposed: setup.terminals[0].disposed, phase: setup.service.phase, probes: setup.runtime.probes }, {
			disposed: true,
			phase: 'signed-out',
			probes: 0,
		});
	});

	test('a sign-in started while the previous one is still probing keeps waiting', async () => {
		const setup = create({ runtime: signedOut });
		await settle();
		await setup.service.signIn();
		setup.runtime.gate = new DeferredPromise<void>();
		const gate = setup.runtime.gate;
		setup.terminals[0].exit(1);
		await settle();
		// The user tries again before the first probe answers.
		setup.runtime.gate = undefined;
		await setup.service.signIn();
		gate.complete();
		await settle();
		assert.deepStrictEqual({ phase: setup.service.phase, terminals: setup.terminals.length, firstDisposed: setup.terminals[0].disposed }, {
			phase: 'waiting-sign-in',
			terminals: 2,
			firstDisposed: false,
		});
		setup.terminals[1].exit(0);
		await settle();
		assert.strictEqual(setup.service.phase, 'signed-out');
	});

	test('Choose Location writes claude.agent.runtimePath for the user, then probes again', async () => {
		const exe = URI.file('/opt/claude/bin/claude');
		const setup = create({ picked: [exe] });
		await settle();
		setup.runtime.state = signedOut;
		await setup.service.chooseLocation();
		const windows = create({ os: OperatingSystem.Windows, picked: undefined });
		await windows.service.chooseLocation();
		assert.deepStrictEqual({
			writes: setup.configuration.writes,
			probes: setup.runtime.probes,
			phase: setup.service.phase,
			filters: [setup.openDialogs[0].filters, windows.openDialogs[0].filters?.map(filter => filter.extensions)],
			cancelled: { writes: windows.configuration.writes, probes: windows.runtime.probes },
		}, {
			writes: [[CLAUDE_AGENT_RUNTIME_PATH_SETTING, exe.fsPath, ConfigurationTarget.USER]],
			probes: 1,
			phase: 'signed-out',
			filters: [undefined, [['exe']]],
			cancelled: { writes: [], probes: 0 },
		});
	});

	test('Continue without AI turns claude.agent.enabled off for the user, names Klawly as the toast source, and Undo turns it back on', async () => {
		const setup = create({ runtime: signedOut });
		await settle();
		await setup.service.signIn();
		await setup.service.continueWithoutAI();
		const offWrites = [...setup.configuration.writes];
		const toast = setup.notifications.notified[setup.notifications.notified.length - 1];
		const undo = toast.actions?.primary ?? [];
		await undo[0].run();
		assert.deepStrictEqual({ offWrites, source: toast.source, undo: undo.map(action => action.label), writes: setup.configuration.writes, signInClosed: setup.terminals[0].disposed, phase: setup.service.phase }, {
			offWrites: [[CLAUDE_AGENT_ENABLED_SETTING, false, ConfigurationTarget.USER]],
			source: 'Klawly',
			undo: ['Undo'],
			writes: [[CLAUDE_AGENT_ENABLED_SETTING, false, ConfigurationTarget.USER], [CLAUDE_AGENT_ENABLED_SETTING, true, ConfigurationTarget.USER]],
			signInClosed: true,
			phase: 'signed-out',
		});
	});

	test('a probe that fails at once is reported and the next Detect Again probes again', async () => {
		const setup = create({ runtime: signedOut });
		await settle();
		setup.runtime.throwNext = new Error('spawn failed');
		await setup.service.redetect();
		setup.runtime.state = ready;
		await setup.service.redetect();
		assert.deepStrictEqual({ errors: setup.notifications.errors, probes: setup.runtime.probes, phase: setup.service.phase }, {
			errors: ['spawn failed'],
			probes: 2,
			phase: 'ready',
		});
	});
});

suite('Claude onboarding hint', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('the ready toast names Klawly as its source and offers Open Agent, then Import Settings', () => {
		const notifications = new RecordingNotifications();
		const ran: string[] = [];
		const setup = {
			onDidChange: Event.None,
			phase: 'ready',
			importOffer: { editors: ['VS Code'], done: false },
			importSettings: async () => { ran.push('import'); },
		} as unknown as IClaudeSetupService;
		const commands = { executeCommand: async (id: string) => { ran.push(id); } } as unknown as ICommandService;
		disposables.add(new ClaudeOnboardingHintContribution(setup, new TestContextService(), disposables.add(new TestStorageService()), new RecordingConfiguration(), notifications, new MockKeybindingService(), commands, { isWorkspaceTrusted: () => true } as unknown as IWorkspaceTrustManagementService));
		const toasts = notifications.notified.map(toast => ({ severity: toast.severity, source: toast.source, buttons: toast.actions?.primary?.map(action => action.label) }));
		for (const action of notifications.notified[0]?.actions?.primary ?? []) {
			action.run();
		}
		assert.deepStrictEqual({ toasts, ran }, {
			toasts: [{ severity: Severity.Info, source: 'Klawly', buttons: ['Open Agent', 'Import Settings...'] }],
			ran: [CLAUDE_FOCUS_AGENT_COMMAND_ID, 'import'],
		});
	});

	test('the first-run Open Agent button explains Restricted Mode with a Trust action', async () => {
		const notifications = new RecordingNotifications();
		const setup = { phase: 'ready', onDidChange: Event.None, importOffer: undefined } as unknown as IClaudeSetupService;
		const ran: string[] = [];
		const commands = { executeCommand: async (id: string) => { ran.push(id); } } as unknown as ICommandService;
		const trust = { isWorkspaceTrusted: () => false } as unknown as IWorkspaceTrustManagementService;
		disposables.add(new ClaudeOnboardingHintContribution(setup, new TestContextService(), disposables.add(new TestStorageService()), new RecordingConfiguration(), notifications, new MockKeybindingService(), commands, trust));
		await notifications.notified[0].actions!.primary![0].run();
		await notifications.notified[1].actions!.primary![0].run();
		assert.deepStrictEqual({ ran, notice: notifications.notified[1].actions!.primary!.map(action => action.label) }, {
			ran: [CLAUDE_FOCUS_AGENT_COMMAND_ID, 'workbench.trust.manage'],
			notice: ['Trust Folder...'],
		});
	});
});
