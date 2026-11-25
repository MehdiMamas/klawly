/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append, Dimension } from '../../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event as BaseEvent } from '../../../../../base/common/event.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeModelInfo, ClaudeRuntimeState, IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { IClaudePluginService } from '../../../../../platform/claude/common/claudePlugins.js';
import { ClaudeAccountOverview, ClaudeUsageRefresh } from '../../../../../platform/claude/common/claudeAccount.js';
import { ClaudeAutomation, ClaudeAutomationScope } from '../../../../../platform/claude/common/claudeAutomation.js';
import { BackgroundAgentTask, ClaudeBackgroundRunOptions } from '../../../../../platform/claude/common/claudeBackground.js';
import { ClaudeMcpAddRequest, ClaudeMcpRemoveRequest } from '../../../../../platform/claude/common/claudeMcpConfig.js';
import { CLAUDE_SANDBOX_ENABLED_SETTING, ClaudeSandboxStatus } from '../../../../../platform/claude/common/claudeSecuritySettings.js';
import { NormalizedClaudeEvent } from '../../../../../platform/claude/common/claudeProtocol.js';
import { FAKE_CLAUDE_ACCOUNT_OVERVIEW } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationChangeEvent, IConfigurationOverrides, IConfigurationService, IConfigurationValue } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextViewDelegate, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfirmation, IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IFilesConfigurationService } from '../../../../services/filesConfiguration/common/filesConfigurationService.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IUpdateService, DisablementReason, State as UpdateState, UpdateType } from '../../../../../platform/update/common/update.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { EMPTY_AGENT_VIEW_STATE } from '../../../../services/claude/common/claudeAgentState.js';
import { ClaudeAutomationService, ClaudeAutomationView, IClaudeAutomationService } from '../../../../services/claude/common/claudeAutomationService.js';
import { IClaudeBackgroundAgentService } from '../../../../services/claude/common/claudeBackgroundAgent.js';
import { IClaudePermissionService } from '../../../../services/claude/common/claudePermissionService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { TestEditorGroupView, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { TestProductService } from '../../../../test/common/workbenchTestServices.js';
import { ClaudeSettingsEditor } from '../../browser/settings/claudeSettingsEditor.js';
import { ClaudeSettingsEditorInput, IClaudeSettingsEditorOptions } from '../../browser/settings/claudeSettingsEditorInput.js';
import { ClaudeMcpControlAction, ClaudeMcpLog } from '../../../../../platform/claude/common/claudeMcpControl.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { IClaudeExtensionAgentService } from '../../../../services/claude/common/claudeExtensionAgentService.js';
import { IKlawlyAccountService, IKlawlyGitHubAccount } from '../../../../services/claude/common/klawlyAccount.js';

const MODELS: ClaudeModelInfo[] = [
	{ id: 'fixture-opus', source: 'runtime', displayName: 'Fixture Opus', description: 'Scripted test model', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
	{ id: 'fixture-sonnet', source: 'runtime', displayName: 'Fixture Sonnet', description: 'Scripted test model' },
];

/** Settings that write through to the values the editor reads, as the real service does. */
class WritableConfiguration extends TestConfigurationService {
	readonly writes: [string, unknown][] = [];
	private readonly _changes = new Emitter<IConfigurationChangeEvent>();
	override readonly onDidChangeConfiguration = this._changes.event;
	/** Registered schema defaults: what `getValue` returns while the user set nothing, as the real registry does. */
	readonly defaults = new Map<string, unknown>();
	/** Values an organization's policy sets; they win over the user's, as the real service does. */
	readonly policies = new Map<string, unknown>();

	override getValue<T>(arg1?: string | IConfigurationOverrides, arg2?: IConfigurationOverrides): T | undefined {
		if (typeof arg1 === 'string' && this.policies.has(arg1)) {
			return this.policies.get(arg1) as T;
		}
		const value = super.getValue<T>(arg1, arg2);
		return value === undefined && typeof arg1 === 'string' ? this.defaults.get(arg1) as T | undefined : value;
	}

	override inspect<T>(key: string): IConfigurationValue<T> {
		const userValue = super.getValue<T>(key);
		const defaultValue = this.defaults.get(key) as T | undefined;
		const policyValue = this.policies.get(key) as T | undefined;
		return { value: policyValue ?? userValue ?? defaultValue, defaultValue, userValue, userLocalValue: userValue, policyValue };
	}

	override async updateValue(key: string, value: unknown, target?: unknown): Promise<void> {
		assert.strictEqual(target, ConfigurationTarget.USER);
		this.writes.push([key, value]);
		await this.setUserConfiguration(key, value);
		this._changes.fire({ affectsConfiguration: (section: string) => key.startsWith(section) } as IConfigurationChangeEvent);
	}

	dispose(): void {
		this._changes.dispose();
	}
}

/** A ResizeObserver the test fires as the browser would after a layout. */
class FakeResizeObserver implements ResizeObserver {
	static last: FakeResizeObserver | undefined;
	readonly targets = new Set<Element>();
	constructor(private readonly _callback: ResizeObserverCallback) {
		FakeResizeObserver.last = this;
	}
	observe(target: Element): void {
		this.targets.add(target);
	}
	unobserve(target: Element): void {
		this.targets.delete(target);
	}
	disconnect(): void {
		this.targets.clear();
	}
	fire(): void {
		this._callback([], this);
	}
}

/** The settings editor with an observer the test controls. */
class ObservedSettingsEditor extends ClaudeSettingsEditor {
	protected override resizeObserverCtor(): typeof ResizeObserver {
		return FakeResizeObserver;
	}
}

suite('Klawly settings editor', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiation: TestInstantiationService;
	let configuration: WritableConfiguration;
	let commands: [string, unknown[]][];
	let warnings: string[];
	let menus: { host: HTMLElement; close: () => void }[];
	let state: ClaudeRuntimeState;
	let updateState: UpdateState;
	let updateChanges: Emitter<UpdateState>;
	let updateCalls: string[];
	let copied: string[];
	let readOnly: string[];
	let infos: string[];
	let overview: ClaudeAccountOverview | undefined;
	let overviewFails = false;
	let runtimeChanges: Emitter<ClaudeRuntimeState>;
	let files: Set<string>;
	let opened: string[];
	let runtimeEvents: Emitter<NormalizedClaudeEvent>;
	/** Text files by path; `files` holds the paths that only need to exist. */
	let contents: Map<string, string>;
	let confirms: string[];
	let mcpChanges: (ClaudeMcpAddRequest | ClaudeMcpRemoveRequest)[] | undefined;
	/** Issue 512: what Reconnect, Turn Off and Turn On asked, and the log Show Logs reads, while a test sets them. */
	let mcpControls: [string, ClaudeMcpControlAction][] | undefined;
	let mcpLog: ClaudeMcpLog | undefined;
	let outputText: string[];
	let automations: ClaudeAutomationView[];
	let automationCalls: string[];
	let sandboxStatus: ClaudeSandboxStatus | undefined;
	/** Issue 446: the GitHub account that is the Klawly profile, while a test signs it in. */
	let profile: IKlawlyGitHubAccount | undefined;
	let profileChanges: Emitter<IKlawlyGitHubAccount | undefined>;
	/** Issue 704: how fresh each account overview asked for the plan limits to be. */
	let usageAsks: (ClaudeUsageRefresh | undefined)[];
	let focus: Emitter<boolean>;

	setup(() => {
		instantiation = workbenchInstantiationService(undefined, store);
		usageAsks = [];
		focus = store.add(new Emitter<boolean>());
		instantiation.stub(IHostService, { hasFocus: true, onDidChangeFocus: focus.event } as Partial<IHostService> as IHostService);
		configuration = store.add(new WritableConfiguration({ claude: {} }));
		commands = [];
		warnings = [];
		menus = [];
		state = { installed: true, authenticated: true, version: '2.1.281', authMode: 'claude-account' };
		overview = undefined;
		overviewFails = false;
		files = new Set();
		opened = [];
		contents = new Map();
		confirms = [];
		mcpChanges = undefined;
		mcpControls = undefined;
		mcpLog = undefined;
		outputText = [];
		automations = [];
		automationCalls = [];
		sandboxStatus = undefined;
		profile = undefined;
		profileChanges = store.add(new Emitter<IKlawlyGitHubAccount | undefined>());
		instantiation.stub(IClaudeExtensionAgentService, {
			onDidChangeGrants: BaseEvent.None,
			getGrants: () => [],
			revokeGrant: () => { },
		} as Partial<IClaudeExtensionAgentService> as IClaudeExtensionAgentService);
		instantiation.stub(IKlawlyAccountService, {
			get account() { return profile; },
			onDidChangeAccount: profileChanges.event,
			serviceAccounts: [],
			onDidChangeServiceAccounts: BaseEvent.None,
		} as Partial<IKlawlyAccountService> as IKlawlyAccountService);
		instantiation.stub(IConfigurationService, configuration);
		const automationChanges = store.add(new Emitter<void>());
		instantiation.stub(IClaudeAutomationService, {
			onDidChange: automationChanges.event,
			getAutomations: () => automations,
			run: async (key: string) => { automationCalls.push(`run ${key}`); },
			save: async (scope: ClaudeAutomationScope, automation: ClaudeAutomation, replaceId?: string) => {
				automationCalls.push(`save ${scope}:${automation.id}${replaceId ? ` over ${replaceId}` : ''}`);
				const key = `${scope}:${automation.id}`;
				const index = automations.findIndex(view => view.automation.key === `${scope}:${replaceId ?? automation.id}`);
				const view = { automation: { ...automation, scope, key } };
				if (index >= 0) {
					automations[index] = view;
				} else {
					automations.push(view);
				}
				automationChanges.fire();
			},
			remove: async (key: string) => {
				automationCalls.push(`remove ${key}`);
				automations = automations.filter(view => view.automation.key !== key);
				automationChanges.fire();
			},
			readMemory: async () => '',
		} as unknown as IClaudeAutomationService);
		instantiation.stub(ICommandService, { executeCommand: async (id: string, ...args: unknown[]) => { commands.push([id, args]); } } as unknown as ICommandService);
		updateState = UpdateState.Idle(UpdateType.Setup, undefined, true);
		updateChanges = store.add(new Emitter<UpdateState>());
		updateCalls = [];
		copied = [];
		readOnly = [];
		infos = [];
		instantiation.stub(IUpdateService, {
			get state() { return updateState; },
			onStateChange: updateChanges.event,
			checkForUpdates: async () => { updateCalls.push('check'); },
			downloadUpdate: async () => { updateCalls.push('download'); },
			applyUpdate: async () => { updateCalls.push('install'); },
			quitAndInstall: async () => { updateCalls.push('restart'); },
		} as unknown as IUpdateService);
		instantiation.stub(IFilesConfigurationService, { updateReadonly: async (resource: URI, readonly: boolean) => { readOnly.push(`${resource.path}:${readonly}`); } } as unknown as IFilesConfigurationService);
		instantiation.stub(IClipboardService, { writeText: async (text: string) => { copied.push(text); } } as unknown as IClipboardService);
		instantiation.stub(INotificationService, { status: () => undefined, info: (message: string) => infos.push(message), warn: (message: string) => warnings.push(message), error: (message: string) => warnings.push(message) } as unknown as INotificationService);
		instantiation.stub(IOutputService, { getChannel: () => ({ replace: (text: string) => outputText.push(text) }), showChannel: async () => undefined } as unknown as IOutputService);
		runtimeChanges = store.add(new Emitter<ClaudeRuntimeState>());
		runtimeEvents = store.add(new Emitter<NormalizedClaudeEvent>());
		instantiation.stub(IClaudeRuntimeService, {
			onDidChangeRuntimeState: runtimeChanges.event,
			onDidEmitEvent: runtimeEvents.event,
			getRuntimeState: async () => state,
			listModels: async () => MODELS,
			getAccountOverview: async (refresh?: ClaudeUsageRefresh) => {
				usageAsks.push(refresh);
				if (overviewFails) {
					throw new Error('offline');
				}
				return overview ?? { live: false };
			},
			getSandboxStatus: async () => sandboxStatus,
			// Present only when a test turns MCP changes on.
			get addMcpServer() { return mcpChanges && (async (request: ClaudeMcpAddRequest) => { mcpChanges!.push(request); }); },
			get removeMcpServer() { return mcpChanges && (async (request: ClaudeMcpRemoveRequest) => { mcpChanges!.push(request); }); },
			get controlMcpServer() {
				return mcpControls && (async (name: string, action: ClaudeMcpControlAction) => {
					mcpControls!.push([name, action]);
					overview = { live: true, mcpServers: (overview?.mcpServers ?? []).map(server => server.name === name ? { ...server, state: action === 'disable' ? 'disabled' as const : 'connected' as const } : server) };
					return overview;
				});
			},
			get readMcpServerLog() { return mcpLog && (async () => mcpLog!); },
		} as unknown as IClaudeRuntimeService);
		// One workspace folder, a home folder, and memory files that exist only when a test adds them.
		instantiation.stub(IWorkspaceContextService, { getWorkspace: () => ({ folders: [{ uri: URI.file('/work'), name: 'work' }] }) } as unknown as IWorkspaceContextService);
		instantiation.stub(IClaudePluginService, { getInstalled: async () => [] } as unknown as IClaudePluginService);
		instantiation.stub(IPathService, { userHome: async () => URI.file('/home') } as unknown as IPathService);
		// Issue 455: Klawly's user layer is in the build's data folder; the released one, here.
		instantiation.stub(IProductService, { ...TestProductService, dataFolderName: '.klawly' });
		instantiation.stub(IFileService, {
			exists: async (resource: URI) => files.has(resource.path),
			createFile: async (resource: URI) => { files.add(resource.path); },
			readFile: async (resource: URI) => {
				const text = contents.get(resource.path);
				if (text === undefined) {
					throw new FileOperationError('not found', FileOperationResult.FILE_NOT_FOUND);
				}
				return { resource, value: VSBuffer.fromString(text), etag: 'e', mtime: 1 };
			},
			writeFile: async (resource: URI, buffer: VSBuffer) => { contents.set(resource.path, buffer.toString()); },
			// No .claude/rules folders here: Customize lists them through resolve (issue 500).
			resolve: async () => { throw new FileOperationError('not found', FileOperationResult.FILE_NOT_FOUND); },
		} as unknown as IFileService);
		instantiation.stub(IFileDialogService, { showSaveDialog: async () => undefined, defaultFilePath: async () => URI.file('/work') } as unknown as IFileDialogService);
		instantiation.stub(IDialogService, { confirm: async (confirmation: IConfirmation) => { confirms.push(confirmation.message); return { confirmed: true }; } } as unknown as IDialogService);
		instantiation.stub(IEditorService, { openEditor: async (input: { resource: URI }) => { opened.push(input.resource.path); } } as unknown as IEditorService);
		instantiation.stub(IOpenerService, { open: async (target: URI) => { opened.push(target.toString()); return true; } } as unknown as IOpenerService);
		instantiation.stub(IContextViewService, {
			showContextView: (delegate: IContextViewDelegate) => {
				const host = document.createElement('div');
				document.body.appendChild(host);
				const rendered: IDisposable = delegate.render(host);
				let open = true;
				const close = () => {
					if (open) {
						open = false;
						rendered.dispose();
						host.remove();
						delegate.onHide?.();
					}
				};
				menus.push({ host, close });
				return { close };
			},
			hideContextView: () => undefined,
		} as unknown as IContextViewService);
	});

	teardown(() => {
		for (const menu of menus) {
			menu.close();
		}
	});

	async function open(options?: IClaudeSettingsEditorOptions, width = 1200, ctor: typeof ClaudeSettingsEditor = ClaudeSettingsEditor) {
		const editor = store.add(instantiation.createInstance(ctor, new TestEditorGroupView(0)));
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		store.add({ dispose: () => parent.remove() });
		editor.create(parent);
		editor.layout(new Dimension(width, 800));
		const input = store.add(instantiation.createInstance(ClaudeSettingsEditorInput));
		await editor.setInput(input, options, {}, CancellationToken.None);
		await editor.refreshRuntime();
		const texts = (selector: string) => [...parent.querySelectorAll(selector)].map(element => element.textContent);
		const row = (id: string) => parent.querySelector<HTMLElement>(`[data-row="${id}"]`)!;
		const model = (id: string) => parent.querySelector<HTMLElement>(`[data-model="${id}"]`)!;
		return { editor, parent, input, texts, row, model };
	}

	async function settle(): Promise<void> {
		await new Promise(resolve => setTimeout(resolve, 0));
	}

	test('the editor id is the one the Split Editor icon is hidden for', () => {
		// browser/parts/editor/editor.contribution.ts names this id: a singleton cannot be split (#177)
		assert.deepStrictEqual([ClaudeSettingsEditor.ID, ClaudeSettingsEditorInput.EDITOR_ID], ['workbench.editor.claudeSettings', 'workbench.editor.claudeSettings']);
	});

	test('general: the version row copies the details and the update row follows the update state (issue 833)', async () => {
		const { parent } = await open();
		const rows = () => [...parent.querySelectorAll<HTMLElement>('.claude-settings-row')];
		const updateRow = () => rows().find(row => row.dataset.updateState !== undefined)!;
		const read = () => ({ status: updateRow().querySelector('.claude-settings-row-description, .description')?.textContent, button: updateRow().querySelector('button')?.textContent, disabled: updateRow().querySelector('button')?.disabled });
		const first = read();
		updateRow().querySelector('button')!.click();
		await settle();
		// Issue 1580: Update, then an indeterminate bar while it downloads, then Restart to Update.
		updateState = UpdateState.AvailableForDownload({ version: 'abc' });
		updateChanges.fire(updateState);
		await settle();
		const available = read();
		updateRow().querySelector('button')!.click();
		await settle();
		updateState = UpdateState.Downloading({ version: 'abc' }, true, false);
		updateChanges.fire(updateState);
		await settle();
		const downloading = { ...read(), bars: updateRow().querySelectorAll('.monaco-progress-container.infinite').length };
		updateState = UpdateState.Ready({ version: 'abc' }, true, false);
		updateChanges.fire(updateState);
		await settle();
		const ready = read();
		updateRow().querySelector('button')!.click();
		await settle();
		updateState = UpdateState.Disabled(DisablementReason.NotBuilt);
		updateChanges.fire(updateState);
		await settle();
		const disabled = read();
		const versionRow = rows().find(row => row.querySelector('button')?.textContent === 'Copy')!;
		versionRow.querySelector('button')!.click();
		await settle();
		assert.deepStrictEqual({ first, available, downloading, ready, disabled, updateCalls, copied: copied.length }, {
			first: { status: 'Up to date', button: 'Check for Updates', disabled: false },
			available: { status: 'A new version is available', button: 'Update', disabled: false },
			downloading: { status: 'Downloading...', button: 'Check for Updates', disabled: true, bars: 1 },
			ready: { status: 'Ready: restart to finish updating', button: 'Restart to Update', disabled: false },
			disabled: { status: 'Updates are off in a build run from source', button: 'Check for Updates', disabled: true },
			updateCalls: ['check', 'download', 'restart'],
			copied: 1,
		});
	});

	test('opens on General with the account, and the nav moves between pages', async () => {
		const { editor, parent, input, texts } = await open();
		assert.deepStrictEqual({
			name: input.getName().endsWith(' Settings'),
			pages: texts('.claude-settings-nav-item .label'),
			current: texts('.claude-settings-nav-item[aria-current="page"] .label'),
			account: texts('.claude-settings-account-text > div'),
			title: texts('.claude-settings-header h2'),
			sections: texts('.claude-settings-section-label'),
		}, {
			name: true,
			pages: ['General', 'Plan & Usage', 'Agents', 'Auto', 'Privacy', 'Models', 'Git and Pull Requests', 'Customize', 'Tab', 'Beta', 'Editor Settings'],
			current: ['General'],
			account: ['Claude Code', 'Claude account'],
			title: ['General'],
			sections: ['Version and Updates', 'Preferences', 'Agent', 'Voice', 'Runtime'],
		});

		const general = parent.querySelector<HTMLButtonElement>('[data-page="general"]')!;
		general.focus();
		general.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		assert.strictEqual(document.activeElement, parent.querySelector('[data-page="plan"]'));
		parent.querySelector<HTMLButtonElement>('[data-page="agents"]')!.click();
		assert.deepStrictEqual([editor.page, texts('.claude-settings-header h2'), texts('.claude-settings-nav-item[aria-current="page"] .label')], ['agents', ['Agents'], ['Agents']]);
	});

	test('a toggle and a select write the user setting, and the default is written as no value', async () => {
		const { row } = await open({ page: 'agents' });
		const reads = row('autoApproveReads').querySelector<HTMLButtonElement>('[role="switch"]')!;
		assert.strictEqual(reads.getAttribute('aria-checked'), 'false');
		reads.click();
		await settle();
		const select = row('defaultMode').querySelector<HTMLButtonElement>('.claude-settings-select')!;
		select.click();
		const items = [...menus.at(-1)!.host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
		const labels = items.map(item => item.querySelector('.label')?.textContent);
		items[1].click();
		await settle();
		assert.deepStrictEqual({
			labels,
			writes: configuration.writes,
			toggle: row('autoApproveReads').querySelector('[role="switch"]')!.getAttribute('aria-checked'),
			focus: document.activeElement === row('autoApproveReads').querySelector('[role="switch"]'),
			select: row('defaultMode').querySelector('.claude-settings-select .label')!.textContent,
		}, {
			labels: ['AgentReads and edits the workspace', 'PlanResearches and writes a plan to build', 'AskAnswers without changing files'],
			writes: [['claude.agent.autoApproveWorkspaceReads', true], ['claude.agent.defaultMode', 'plan']],
			toggle: 'true',
			focus: false,
			select: 'Plan',
		});
	});

	test('sandbox: a policy locks its row as managed, and the machine row says what to install', async () => {
		configuration.policies.set(CLAUDE_SANDBOX_ENABLED_SETTING, true);
		sandboxStatus = { state: 'missing', platform: 'linux', missing: ['bubblewrap', 'socat'] };
		const { row } = await open({ page: 'agents' });
		const status = row('sandboxStatus');
		assert.deepStrictEqual({
			managed: row('sandboxEnabled').querySelector('.claude-settings-row-managed')?.textContent,
			locked: row('sandboxEnabled').querySelector<HTMLButtonElement>('[role="switch"]')!.disabled,
			unmanaged: row('sandboxAutoAllowBash').querySelector('.claude-settings-row-managed') === null,
			badge: status.querySelector('.claude-badge')?.className,
			label: status.querySelector('.claude-badge')?.textContent,
			description: status.querySelector('.claude-settings-row-description')?.textContent,
		}, {
			managed: 'Managed by your organization',
			locked: true,
			unmanaged: true,
			badge: 'claude-badge is-warning',
			label: 'Install First',
			description: 'Install bubblewrap, socat first, for example with apt install bubblewrap socat. Until then a sandboxed turn fails',
		});
	});

	test('agents: messages while Claude works and the notification switches', async () => {
		// The registered defaults; this test service has no registry.
		await configuration.setUserConfiguration('claude.notifications.approval', true);
		await configuration.setUserConfiguration('claude.notifications.finished', true);
		const { row, texts } = await open({ page: 'agents' });
		const switches = ['notifyApproval', 'notifyFinished', 'notifySound'].map(id => row(id).querySelector('[role="switch"]')!.getAttribute('aria-checked'));
		row('whileWorking').querySelector<HTMLButtonElement>('.claude-settings-select')!.click();
		const items = [...menus.at(-1)!.host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
		const labels = items.map(item => item.querySelector('.label')?.textContent);
		items[1].click();
		await settle();
		row('notifySound').querySelector<HTMLButtonElement>('[role="switch"]')!.click();
		await settle();
		assert.deepStrictEqual({
			sections: texts('.claude-settings-section-label'),
			switches,
			labels,
			writes: configuration.writes,
			select: row('whileWorking').querySelector('.claude-settings-select .label')!.textContent,
		}, {
			sections: ['Permissions', 'Sandbox', 'Telemetry Export', 'Chat', 'Notifications', 'Review and Checkpoints', 'Subagents', 'Tend This PR', 'Automations0'],
			switches: ['true', 'true', 'false'],
			labels: ['QueueHold it until the turn ends', 'SteerSend it into the running turn'],
			writes: [['claude.composer.whileWorking', 'steer'], ['claude.notifications.sound', true]],
			select: 'Steer',
		});
	});

	test('git: attribution and git-step switches, the branch prefix field and where worktrees start', async () => {
		// The registered defaults; this test service has no registry.
		for (const key of ['claude.git.commitAttribution', 'claude.git.prAttribution', 'claude.git.workflowInstructions']) {
			await configuration.setUserConfiguration(key, true);
		}
		configuration.defaults.set('claude.git.branchPrefix', 'agent/');
		const { row, texts } = await open({ page: 'git' });
		const switches = ['commitAttribution', 'prAttribution', 'gitInstructions'].map(id => row(id).querySelector('[role="switch"]')!.getAttribute('aria-checked'));
		const prefix = row('branchPrefix').querySelector<HTMLInputElement>('input')!;
		const before = [prefix.value, prefix.placeholder];
		row('commitAttribution').querySelector<HTMLButtonElement>('[role="switch"]')!.click();
		await settle();
		prefix.value = 'alex/';
		prefix.dispatchEvent(new Event('change'));
		await settle();
		row('worktreeBase').querySelector<HTMLButtonElement>('.claude-settings-select')!.click();
		const items = [...menus.at(-1)!.host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
		const labels = items.map(item => item.querySelector('.label')?.textContent);
		items[1].click();
		await settle();
		assert.deepStrictEqual({
			title: texts('.claude-settings-header h2'),
			sections: texts('.claude-settings-section-label'),
			switches,
			before,
			short: prefix.classList.contains('is-short'),
			labels,
			writes: configuration.writes,
		}, {
			title: ['Git and Pull Requests'],
			sections: ['Commits and Pull Requests', 'Branches'],
			switches: ['true', 'true', 'true'],
			// A clean profile: the default is only the faint placeholder (#178).
			before: ['', 'agent/'],
			short: true,
			labels: [`Default BranchThe remote's default branch, a clean tree`, 'Current CommitYour HEAD, with unpushed work'],
			writes: [['claude.git.commitAttribution', false], ['claude.git.branchPrefix', 'alex/'], ['claude.git.worktreeBase', 'head']],
		});
	});

	test('a text field shows the value the user set, and clearing it removes the setting', async () => {
		configuration.defaults.set('claude.git.branchPrefix', 'agent/');
		await configuration.setUserConfiguration('claude.git.branchPrefix', 'alex/');
		const { row } = await open({ page: 'git' });
		const prefix = () => row('branchPrefix').querySelector<HTMLInputElement>('input')!;
		const before = prefix().value;
		prefix().value = '  ';
		prefix().dispatchEvent(new Event('change'));
		await settle();
		assert.deepStrictEqual([before, prefix().value, prefix().placeholder, configuration.writes], ['alex/', '', 'agent/', [['claude.git.branchPrefix', undefined]]]);
	});

	test('the Auto page leads with the claude.auto.enabled switch, on by default (issue 1221)', async () => {
		configuration.defaults.set('claude.auto.enabled', true);
		const { row } = await open({ page: 'auto' });
		const control = row('autoEnabled').querySelector<HTMLElement>('[role="switch"]')!;
		assert.strictEqual(control.getAttribute('aria-checked'), 'true');
		control.click();
		await settle();
		assert.deepStrictEqual(configuration.writes, [['claude.auto.enabled', false]]);
	});

	test('the Auto instruction lists show one rule per line, and saving drops blank lines (issue 671)', async () => {
		await configuration.setUserConfiguration('claude.agent.autoMode.allowInstructions', ['Run the tests', 'Read any file']);
		const { row } = await open({ page: 'auto' });
		const allow = () => row('autoAllow').querySelector<HTMLTextAreaElement>('textarea')!;
		const block = () => row('autoBlock').querySelector<HTMLTextAreaElement>('textarea')!;
		const before = [allow().value, block().value];
		allow().value = ' Run the tests \n\n Push to my fork ';
		allow().dispatchEvent(new Event('change'));
		await settle();
		block().value = '  ';
		block().dispatchEvent(new Event('change'));
		await settle();
		assert.deepStrictEqual([before, configuration.writes], [
			['Run the tests\nRead any file', ''],
			[['claude.agent.autoMode.allowInstructions', ['Run the tests', 'Push to my fork']], ['claude.agent.autoMode.blockInstructions', undefined]],
		]);
	});

	test('the Auto review toggles default off, show a warning, and turning one on writes the setting (issue 908)', async () => {
		configuration.defaults.set('claude.agent.autoMode.reviewDeletions', false);
		configuration.defaults.set('claude.agent.autoMode.reviewOutsideWrites', false);
		const { row } = await open({ page: 'auto' });
		const before = [row('autoReviewDeletions').textContent?.includes('loses files'), row('autoReviewOutsideWrites').textContent?.includes('overwrite files'), row('autoReviewDeletions').querySelector('[role="switch"]')!.getAttribute('aria-checked')];
		const control = row('autoReviewDeletions').querySelector<HTMLElement>('[role="switch"]')!;
		control.click();
		await settle();
		assert.deepStrictEqual([before, configuration.writes], [[true, true, 'false'], [['claude.agent.autoMode.reviewDeletions', true]]]);
	});

	test('wide blocks (learned rules, statistics) carry is-block so they stack under their text at any width (issue 1578)', async () => {
		const page = await open({ page: 'agents' });
		await settle();
		assert.deepStrictEqual(['learnedRules', 'reviewStats'].map(id => page.row(id).classList.contains('is-block')), [true, true]);
	});

	test('learned rules: the empty text names the threshold, the file is named with Open File, and Remove offers Undo (issue 1109)', async () => {
		let promptMessage = '';
		let promptChoices: { label: string; run: () => void | Promise<void> }[] = [];
		instantiation.stub(INotificationService, { status: () => undefined, info: (message: string) => infos.push(message), warn: (message: string) => warnings.push(message), error: (message: string) => warnings.push(message), prompt: (_severity: unknown, message: string, choices: { label: string; run: () => void | Promise<void> }[]) => { promptMessage = message; promptChoices = choices; } } as unknown as INotificationService);
		await configuration.setUserConfiguration('claude.review.learnAfter', 5);
		const empty = await open({ page: 'agents' });
		await settle();
		const emptyText = empty.row('learnedRules').querySelector('.claude-settings-learned-empty')?.textContent;
		const text = JSON.stringify({ rules: [{ id: 'learned-style-x-1', text: 'Do not flag style findings.' }] });
		contents.set('/work/.claude/review.json', text);
		const full = await open({ page: 'agents' });
		await settle();
		const header = full.row('learnedRules').querySelector('.claude-settings-learned-item')!;
		const headerText = header.querySelector('.claude-settings-learned-text')?.textContent;
		header.querySelector<HTMLElement>('button')!.click();
		await settle();
		const buttons = [...full.row('learnedRules').querySelectorAll<HTMLElement>('button')];
		buttons.find(button => button.textContent === 'Remove')!.click();
		await settle();
		const removed = contents.get('/work/.claude/review.json') !== text;
		await promptChoices[0].run();
		assert.deepStrictEqual({ emptyText, headerText, opened: opened.includes('/work/.claude/review.json'), removed, promptMessage, undone: contents.get('/work/.claude/review.json') === text, undo: promptChoices[0].label }, {
			emptyText: 'Nothing learned yet. After you dismiss the same finding 5 times in this project (see Learn After above), Klawly offers a rule here.',
			headerText: 'Saved in .claude/review.json',
			opened: true,
			removed: true,
			promptMessage: 'Removed the rule from .claude/review.json. Klawly can flag that finding again.',
			undone: true,
			undo: 'Undo',
		});
	});

	test('a number clamps to its range and keeps focus across the re-render', async () => {
		const { row } = await open({ page: 'tab' });
		const input = row('debounce').querySelector<HTMLInputElement>('input')!;
		input.focus();
		input.value = '900';
		input.dispatchEvent(new Event('change'));
		await settle();
		const after = row('debounce').querySelector<HTMLInputElement>('input')!;
		assert.deepStrictEqual([configuration.writes, after.value, document.activeElement === after], [[['claude.autocomplete.debounceMs', 500]], '500', true]);
	});

	test('search finds rows on every page, links runtime blocks to their page, and offers all settings when nothing matches', async () => {
		const { editor, parent, texts } = await open();
		editor.search('effort');
		assert.deepStrictEqual({
			page: editor.page,
			current: texts('.claude-settings-nav-item[aria-current="page"]'),
			sections: texts('.claude-settings-section-label'),
			rows: texts('.claude-settings-row-title'),
		}, {
			page: undefined,
			current: [],
			sections: ['Models'],
			rows: ['Ultracode', 'Models'],
		});
		parent.querySelector<HTMLButtonElement>('[data-row="modelList"] .claude-settings-button')!.click();
		assert.deepStrictEqual([editor.page, parent.querySelector<HTMLInputElement>('.claude-settings-search')!.value], ['models', '']);

		editor.search('zzz');
		parent.querySelector<HTMLButtonElement>('.claude-settings-empty .claude-btn')!.click();
		const search = parent.querySelector<HTMLInputElement>('.claude-settings-search')!;
		search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.deepStrictEqual([commands, editor.page], [[['workbench.action.openSettings', ['zzz']]], 'models']);
	});

	test('a search for "theme" says where the theme is chosen and opens that picker (issue 904)', async () => {
		const { editor, parent, texts } = await open();
		editor.search('theme');
		const buttons = () => [...parent.querySelectorAll<HTMLButtonElement>('.claude-settings-empty .claude-btn')];
		const shown = {
			text: texts('.claude-settings-empty > p'),
			buttons: buttons().map(button => button.textContent),
		};
		buttons()[0].click();
		editor.search('icon theme');
		buttons()[0].click();
		editor.search('zzz');
		assert.deepStrictEqual({ shown, commands, noHint: buttons().map(button => button.textContent) }, {
			shown: {
				text: ['No Klawly setting matches "theme".', 'The color theme is chosen in VS Code, not in Klawly Settings.'],
				buttons: ['Choose Color Theme', 'Search All Settings'],
			},
			commands: [['workbench.action.selectTheme', []], ['workbench.action.selectIconTheme', []]],
			noHint: ['Search All Settings'],
		});
	});

	test('narrow: the nav folds to icons and search moves above the content', async () => {
		const { editor, parent } = await open(undefined, 600);
		const search = parent.querySelector('.claude-settings-search')!;
		assert.deepStrictEqual({
			narrow: editor.narrow,
			className: parent.querySelector('.claude-settings')!.classList.contains('is-narrow'),
			searchOnTop: search.parentElement!.classList.contains('is-top'),
			labels: [...parent.querySelectorAll('[data-page]')].map(button => button.getAttribute('aria-label')),
		}, {
			narrow: true,
			className: true,
			searchOnTop: true,
			labels: ['General', 'Plan & Usage', 'Agents', 'Auto', 'Privacy', 'Models', 'Git and Pull Requests', 'Customize', 'Tab', 'Beta'],
		});
		editor.layout(new Dimension(1200, 800));
		assert.deepStrictEqual([editor.narrow, search.parentElement!.classList.contains('is-top')], [false, false]);
	});

	test('models: effort per model, a picker switch that keeps one model on, and custom IDs', async () => {
		const { parent, model, texts } = await open({ page: 'models' });
		assert.deepStrictEqual(texts('.claude-settings-row.is-model .name'), ['Fixture Opus', 'Fixture Sonnet']);
		// Sonnet takes no effort, so only Opus has an effort menu; Max is a session choice, not a default.
		assert.deepStrictEqual([!!model('fixture-opus').querySelector('.claude-settings-select'), !!model('fixture-sonnet').querySelector('.claude-settings-select')], [true, false]);
		model('fixture-opus').querySelector<HTMLButtonElement>('.claude-settings-select')!.click();
		const efforts = [...menus.at(-1)!.host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
		const effortLabels = efforts.map(item => item.querySelector('.label')?.textContent);
		efforts[3].click();
		await settle();

		model('fixture-sonnet').querySelector<HTMLButtonElement>('[role="switch"]')!.click();
		await settle();
		model('fixture-opus').querySelector<HTMLButtonElement>('[role="switch"]')!.click();
		await settle();

		const filter = parent.querySelector<HTMLInputElement>('.claude-settings-model-filter')!;
		filter.value = 'claude-opus-5-5';
		filter.dispatchEvent(new Event('input'));
		const hint = texts('.claude-settings-model-rows .claude-settings-row-description');
		filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await settle();
		const custom = texts('.claude-settings-row.is-model .name');
		model('claude-opus-5-5').querySelector<HTMLButtonElement>('.claude-icon-btn')!.click();
		await settle();

		assert.deepStrictEqual({
			effortLabels,
			hint,
			custom,
			warnings,
			writes: configuration.writes,
			rows: texts('.claude-settings-row.is-model .name'),
		}, {
			effortLabels: ['Last Used', 'Low', 'Medium', 'High', 'Extra High'],
			hint: ['No model matches. Press Enter to add "claude-opus-5-5" as a custom model ID.'],
			custom: ['Fixture Opus', 'Fixture Sonnet', 'claude-opus-5-5'],
			warnings: ['Keep at least one model on.'],
			writes: [
				['claude.models.effort', { 'fixture-opus': 'high' }],
				['claude.models.enabled', ['fixture-opus']],
				['claude.models.custom', ['claude-opus-5-5']],
				['claude.models.custom', []],
			],
			rows: ['Fixture Opus', 'Fixture Sonnet'],
		});
	});

	test('the GitHub profile heads the accounts, Claude sits under it, and each signs in and out on its own (issue 446)', async () => {
		state = { installed: true, authenticated: false };
		const { parent, row, texts } = await open();
		const signedOut = {
			profile: texts('.claude-settings-profile-text > div'),
			claude: texts('.claude-settings-account-text > div'),
			rows: [...parent.querySelectorAll<HTMLElement>('[data-row="profile"], [data-row="account"]')].map(element => [element.dataset.row, element.classList.contains('is-nested'), element.querySelector('.claude-settings-button')?.textContent]),
		};
		parent.querySelector<HTMLButtonElement>('.claude-settings-profile-sign-in')!.click();
		row('profile').querySelector<HTMLButtonElement>('.claude-settings-button')!.click();
		profile = { login: 'octocat', id: '583231', avatarUrl: undefined };
		profileChanges.fire(profile);
		await settle();
		parent.querySelector<HTMLButtonElement>('.claude-settings-profile-menu')!.click();
		const items = [...menus.at(-1)!.host.querySelectorAll<HTMLElement>('[role="menuitem"]')];
		const menu = items.map(item => item.querySelector('.label')?.textContent);
		items[0].click();
		await settle();
		assert.deepStrictEqual({
			signedOut,
			signedIn: {
				profile: texts('.claude-settings-profile-text > div'),
				row: [row('profile').querySelector('.claude-settings-row-title')!.textContent, row('profile').querySelector('.claude-settings-button')!.textContent],
				menu,
			},
			commands: commands.map(([id]) => id),
		}, {
			signedOut: {
				profile: ['Not Signed In', 'GitHub'],
				claude: ['Claude Code', 'Signed out'],
				rows: [['profile', false, 'Sign In with GitHub'], ['account', true, 'Sign In']],
			},
			signedIn: {
				profile: ['@octocat', 'GitHub'],
				row: ['GitHub: @octocat', 'Sign Out'],
				menu: ['Sign Out of GitHub'],
			},
			commands: ['klawly.github.signIn', 'klawly.github.signIn', 'klawly.github.signOut'],
		});
	});

	test('the account row offers the one action that fixes sign-in', async () => {
		state = { installed: true, authenticated: false };
		const { row, texts } = await open();
		row('account').querySelector<HTMLButtonElement>('.claude-settings-button')!.click();
		assert.deepStrictEqual([texts('.claude-settings-account-text .plan'), row('account').querySelector('.claude-settings-button')!.textContent, commands], [['Signed out'], 'Sign In', [['claude.signIn', []]]]);
	});

	test('plan & usage: the plan, a meter per limit, and the account in the nav', async () => {
		overview = {
			live: true,
			account: { email: 'someone@example.invalid', organization: 'Example', plan: 'max', provider: 'firstParty' },
			usage: [
				{ kind: 'session', percent: 12.4, resetsAt: Date.now() + 3 * 60 * 60 * 1000 },
				{ kind: 'week', percent: 85 },
				{ kind: 'model', label: 'Fable', percent: 100 },
			],
		};
		const { parent, texts } = await open({ page: 'plan' });
		const meters = [...parent.querySelectorAll<HTMLElement>('.claude-settings-meter')].map(meter => {
			const bar = meter.querySelector('[role="meter"]')!;
			return [meter.dataset.row, meter.querySelector('.title')!.textContent, meter.querySelector('.value')!.textContent, bar.getAttribute('aria-valuenow'), bar.className];
		});
		const note = texts('.claude-settings-meter-note')[0]!;
		parent.querySelector<HTMLButtonElement>('[data-focus-key="plan.manage"]')!.click();
		assert.deepStrictEqual({
			account: texts('.claude-settings-account-text > div'),
			plan: texts('.claude-settings-plan-text > div'),
			sections: texts('.claude-settings-section-label'),
			meters,
			resets: /^Every model, over a rolling five hours\. Resets in /.test(note),
			info: texts('.claude-settings-value'),
			opened,
		}, {
			account: ['someone@example.invalid', 'Max Plan'],
			plan: ['Current Plan', 'Max', 'someone@example.invalid \u00b7 Example'],
			sections: ['Usage Limits', 'Claude Code'],
			meters: [
				['usage:session', 'Current Session', '12% used', '12', 'claude-settings-meter-bar'],
				['usage:week', 'This Week', '85% used', '85', 'claude-settings-meter-bar is-high'],
				['usage:Fable', 'This Week, Fable', '100% used', '100', 'claude-settings-meter-bar is-full'],
			],
			resets: true,
			info: ['Claude account', '2.1.281'],
			opened: ['https://claude.ai/settings/billing'],
		});
	});

	test('plan & usage says why there are no meters', async () => {
		const { parent, texts } = await open({ page: 'plan' });
		const before = texts('[data-row="limits"]');
		overview = { live: true, account: { provider: 'bedrock' }, usage: [] };
		parent.querySelector<HTMLButtonElement>('[data-focus-key="plan.refresh"]')!.click();
		await settle();
		assert.deepStrictEqual({
			before,
			after: texts('[data-row="limits"]'),
			manage: !!parent.querySelector('[data-focus-key="plan.manage"]'),
		}, {
			before: ['Claude Code has not reported your limits yet. Sign in, then refresh.'],
			after: ['This sign-in has no plan limits to show. API keys and cloud providers bill per request.'],
			manage: false,
		});
	});

	test('switching to another signed-in account clears the old limits and shows the new ones (issue 942)', async () => {
		overview = { live: false, account: { email: 'old@example.invalid' }, usage: [{ kind: 'session', percent: 88 }], usageCheckedAt: Date.now() };
		const { editor, parent, texts } = await open({ page: 'plan' });
		editor.setVisible(true);
		await settle();
		const before = texts('.claude-settings-meter .value');
		overview = { live: false, account: { email: 'new@example.invalid' }, usage: [{ kind: 'session', percent: 7 }], usageCheckedAt: Date.now() };
		usageAsks.length = 0;
		runtimeChanges.fire({ installed: true, authenticated: true, version: '2.1.281', authMode: 'claude-account' });
		const cleared = { meters: texts('.claude-settings-meter .value'), note: texts('[data-row="limits"]') };
		await settle();
		assert.deepStrictEqual({ before, cleared, after: texts('.claude-settings-meter .value'), asks: usageAsks, none: !parent.querySelector('[data-state="none"]') }, {
			before: ['88% used'],
			cleared: { meters: [], note: ['Loading your limits...'] },
			after: ['7% used'],
			asks: ['now'],
			none: true,
		});
	});

	test('plan & usage tells loading, could not load (with Try Again) and truly none apart (issue 942)', async () => {
		overviewFails = true;
		const { editor, parent, texts } = await open({ page: 'plan' });
		editor.setVisible(true);
		await settle();
		const failed = { note: texts('[data-row="limits"]'), state: parent.querySelector('[data-row="limits"]')!.getAttribute('data-state'), retry: !!parent.querySelector('[data-focus-key="plan.retryLimits"]') };
		overviewFails = false;
		overview = { live: true, account: { provider: 'bedrock' }, usage: [] };
		parent.querySelector<HTMLButtonElement>('[data-focus-key="plan.retryLimits"]')!.click();
		const loading = texts('[data-row="limits"]');
		await settle();
		assert.deepStrictEqual({ failed, loading, none: texts('[data-row="limits"]'), retry: !!parent.querySelector('[data-focus-key="plan.retryLimits"]') }, {
			failed: { note: ['Couldn\'t load your limits. Check your connection, then try again.Try Again'], state: 'failed', retry: true },
			loading: ['Loading your limits...'],
			none: ['This sign-in has no plan limits to show. API keys and cloud providers bill per request.'],
			retry: false,
		});
	});

	test('plan & usage says how old the limits are and asks again on focus, on Refresh and after a turn (issue 704)', async () => {
		overview = { live: false, usage: [{ kind: 'session', percent: 20 }], usageCheckedAt: Date.now() - 5 * 60_000 };
		const { editor, parent, texts } = await open({ page: 'plan' });
		editor.setVisible(true);
		const opened = { asks: usageAsks.splice(0).every(ask => ask === 'stale'), updated: texts('[data-row="usageUpdated"]') };
		overview = { live: false, usage: [{ kind: 'session', percent: 40 }], usageCheckedAt: Date.now() };
		focus.fire(false);
		focus.fire(true);
		await settle();
		const focused = { updated: texts('[data-row="usageUpdated"]'), used: texts('.claude-settings-meter .value') };
		parent.querySelector<HTMLButtonElement>('[data-focus-key="plan.refresh"]')!.click();
		await settle();
		runtimeEvents.fire({ type: 'session.usageLimits', sessionId: 's1', windows: [{ kind: 'session', percent: 90 }] });
		assert.deepStrictEqual({ opened, focused, asks: usageAsks, afterTurn: texts('.claude-settings-meter .value') }, {
			opened: { asks: true, updated: ['Updated 5 mins ago'] },
			focused: { updated: ['Updated just now'], used: ['40% used'] },
			asks: ['stale', 'now'],
			afterTurn: ['90% used'],
		});
	});

	test('plan & usage: the sign-in row says how Claude Code is signed in', async () => {
		const values: Record<string, string | null> = {};
		for (const authMode of ['claude-account', 'api-key', 'bedrock', 'vertex', 'unknown'] as const) {
			state = { installed: true, authenticated: true, version: '2.1.281', authMode };
			const { row } = await open({ page: 'plan' });
			values[authMode] = row('signIn').querySelector('.claude-settings-value')!.textContent;
		}
		assert.deepStrictEqual(values, {
			'claude-account': 'Claude account',
			'api-key': 'API key',
			'bedrock': 'Amazon Bedrock',
			'vertex': 'Google Vertex AI',
			'unknown': 'Signed in',
		});
	});

	test('plan & usage: Switch Account and Log Out for a Claude account, and the reason when log out cannot reach the sign-in (issue 536)', async () => {
		const { parent, row, texts } = await open({ page: 'plan' });
		const buttons = texts('[data-row="signIn"] .claude-settings-button');
		row('signIn').querySelector<HTMLButtonElement>('[data-focus-key="plan.logOut"]')!.click();
		parent.querySelector<HTMLButtonElement>('.claude-settings-account-menu')!.click();
		const items = [...menus.at(-1)!.host.querySelectorAll<HTMLElement>('[role="menuitem"]')];
		const menu = items.map(item => item.querySelector('.label')?.textContent);
		items[0].click();
		await settle();
		state = { installed: true, authenticated: true, version: '2.1.281', authMode: 'api-key' };
		const apiKey = await open({ page: 'plan' });
		assert.deepStrictEqual({
			buttons,
			menu,
			commands,
			apiKey: {
				buttons: apiKey.texts('[data-row="signIn"] .claude-settings-button'),
				reason: apiKey.texts('[data-row="signIn"] .claude-settings-row-managed'),
				menu: !!apiKey.parent.querySelector('.claude-settings-account-menu'),
			},
		}, {
			buttons: ['Switch Account...', 'Log Out'],
			menu: ['Switch Account...', 'Log Out'],
			commands: [['claude.logOut', []], ['claude.switchAccount', []]],
			apiKey: {
				buttons: [],
				reason: ['Claude Code signs in with an API key here. Change or remove the key where it is set.'],
				menu: false,
			},
		});
	});

	test('customize lists what Claude Code loaded, by kind, and filters it', async () => {
		overview = FAKE_CLAUDE_ACCOUNT_OVERVIEW;
		files.add('/work/CLAUDE.md');
		files.add('/home/.claude/CLAUDE.md');
		const { parent, texts } = await open({ page: 'customize' });
		const group = (kind: string) => [...parent.querySelectorAll(`.claude-customize-group[data-kind="${kind}"] .claude-customize-item`)].map(item => [item.querySelector('.name')!.textContent, item.querySelector('.detail')!.textContent, item.querySelector('.claude-badge')?.textContent]);
		const all = {
			chips: texts('.claude-customize-chip'),
			groups: texts('.claude-customize-group .claude-settings-section-label'),
			mcp: group('mcp'),
			commands: group('commands'),
			memory: group('memory'),
		};
		parent.querySelector<HTMLButtonElement>('.claude-customize-group[data-kind="memory"] .claude-customize-item')!.click();
		parent.querySelector<HTMLButtonElement>('[data-kind="subagents"].claude-customize-chip')!.click();
		const subagents = [texts('.claude-customize-group .claude-settings-section-label'), group('subagents'), texts('.claude-customize-chip[aria-pressed="true"]')];
		parent.querySelector<HTMLButtonElement>('[data-kind="all"].claude-customize-chip')!.click();
		const search = parent.querySelector<HTMLInputElement>('.claude-customize-search')!;
		search.value = 'pull req';
		search.dispatchEvent(new Event('input'));
		const filtered = texts('.claude-customize-item .name');
		search.value = 'zzz';
		search.dispatchEvent(new Event('input'));
		assert.deepStrictEqual({ all, opened, subagents, filtered, none: texts('.claude-customize-list .claude-settings-row-description'), sameSearch: parent.querySelector('.claude-customize-search') === search }, {
			all: {
				chips: ['All', 'MCP Servers', 'Skills', 'Subagents', 'Commands', 'Hooks', 'Network Domains', 'Permission Rules', 'Memory', 'Rules'],
				groups: ['MCP Servers3', 'Skills1', 'Subagents1', 'Commands3', 'Hooks0', 'Network Domains0', 'Permission Rules0', 'Memory3', 'Rules0'],
				mcp: [
					['fixture-docs', '4 tools \u00b7 project', 'Connected'],
					['fixture-tracker', '0 tools \u00b7 user', 'Needs Sign-In'],
					['fixture-broken', 'The server exited during startup.', 'Failed'],
				],
				commands: [
					['/ship', 'Project \u00b7 Run the checks and open a pull request', undefined],
					['/compact', 'Built in \u00b7 Summarize the conversation to free context', undefined],
					['/clear', 'Built in \u00b7 Start over with an empty conversation', undefined],
				],
				// Issue 455: your rules are Klawly's, listed before the file exists; Claude Code's own file is read only.
				memory: [
					['Project Memory', 'CLAUDE.md', undefined],
					['Your Rules', '~/.klawly/claude/CLAUDE.md · Not created yet. Open it to write instructions for every project', undefined],
					['Claude Code Memory', '~/.claude/CLAUDE.md · from Claude Code', undefined],
				],
			},
			opened: ['/work/CLAUDE.md'],
			subagents: [['Subagents1'], [['code-reviewer', 'Reviews a change for bugs and missing tests \u00b7 fixture-sonnet', undefined]], ['Subagents']],
			filtered: ['/ship'],
			none: ['Nothing matches "zzz".'],
			sameSearch: true,
		});
	});

	test('customize offers to create CLAUDE.md, and waits for an agent before listing the rest', async () => {
		const { parent, texts } = await open({ page: 'customize' });
		const before = {
			groups: texts('.claude-customize-group .claude-settings-section-label'),
			notes: texts('.claude-customize-list .claude-settings-row-description'),
		};
		parent.querySelector<HTMLButtonElement>('[data-focus-key="customize.createMemory"]')!.click();
		await settle();
		await settle();
		assert.deepStrictEqual({ before, files: [...files], opened, memory: texts('.claude-customize-group[data-kind="memory"] .claude-customize-item .detail') }, {
			before: {
				// Your rules row is always there to write in (issue 455).
				groups: ['Skills0', 'Subagents0', 'Commands0', 'Hooks0', 'Network Domains0', 'Permission Rules0', 'Memory1', 'Rules0'],
				// Skills, subagents and commands come from a running agent; they show empty with Add until then (issue 500).
				notes: [
					'Claude Code lists these once an agent has started in this window. Start one, then refresh.',
					'Claude Code lists these once an agent has started in this window. Start one, then refresh.',
					'Claude Code lists these once an agent has started in this window. Start one, then refresh.',
					'No hooks in your Claude Code settings. A hook runs a command when Claude Code reaches an event, such as before a tool runs.',
					'No domains allowed or denied in your Claude Code settings. Claude Code asks before it fetches from a new domain.',
					'No allow or deny rules in your Claude Code settings. Claude Code asks before it does anything a rule does not cover.',
					'No rules in .claude/rules here or in ~/.klawly/claude/rules. A rule is a Markdown file of instructions Claude Code loads in every session, or only for the files its paths match.',
				],
			},
			files: ['/work/CLAUDE.md'],
			opened: ['/work/CLAUDE.md'],
			memory: ['CLAUDE.md', '~/.klawly/claude/CLAUDE.md · Not created yet. Open it to write instructions for every project'],
		});
	});

	test('issue 455: your rules are created in ~/.klawly/claude, and ~/.claude is listed read only and only while Klawly uses it', async () => {
		configuration.defaults.set('claude.customize.useClaudeCodeSetup', true);
		files.add('/home/.claude/CLAUDE.md');
		contents.set('/home/.claude/settings.json', '{\n  "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "say bye" }] }] },\n  "permissions": { "allow": ["WebFetch(domain:example.com)"] }\n}\n');
		const { parent, row } = await open({ page: 'customize' });
		const rows = (kind: string) => [...parent.querySelectorAll(`.claude-customize-group[data-kind="${kind}"] .claude-customize-item`)].map(item => `${item.querySelector('.name')!.textContent} | ${item.querySelector('.detail')!.textContent}`);
		const actions = () => parent.querySelectorAll('.claude-customize-group[data-kind="hooks"] .claude-customize-action, .claude-customize-group[data-kind="network"] .claude-customize-action').length;
		const toggle = () => row('useClaudeCodeSetup').querySelector<HTMLElement>('[role="switch"]')!;
		const on = { toggle: toggle().getAttribute('aria-checked'), memory: rows('memory'), hooks: rows('hooks'), network: rows('network'), actions: actions() };
		parent.querySelector<HTMLButtonElement>('.claude-customize-group[data-kind="memory"] .claude-customize-item')!.click();
		await settle();
		await settle();
		toggle().click();
		await settle();
		await settle();
		assert.deepStrictEqual({ on, files: [...files], opened, writes: configuration.writes, off: { memory: rows('memory'), hooks: rows('hooks'), network: rows('network') } }, {
			on: {
				toggle: 'true',
				memory: [
					// allow-any-unicode-next-line
					'Your Rules | ~/.klawly/claude/CLAUDE.md · Not created yet. Open it to write instructions for every project',
					// allow-any-unicode-next-line
					'Claude Code Memory | ~/.claude/CLAUDE.md · from Claude Code',
				],
				// allow-any-unicode-next-line
				hooks: ['Stop | say bye · from Claude Code'],
				// allow-any-unicode-next-line
				network: ['example.com | Allowed · from Claude Code'],
				// One Copy to Klawly on the hook and one on the allowed domain, none to edit or remove.
				actions: 2,
			},
			files: ['/home/.claude/CLAUDE.md', '/home/.klawly/claude/CLAUDE.md'],
			opened: ['/home/.klawly/claude/CLAUDE.md'],
			writes: [['claude.customize.useClaudeCodeSetup', false]],
			off: {
				memory: ['Your Rules | ~/.klawly/claude/CLAUDE.md'],
				hooks: [],
				network: [],
			},
		});
	});

	test('issue 807: a from-Claude-Code row opens read only and Copy to Klawly writes only the user layer', async () => {
		configuration.defaults.set('claude.customize.useClaudeCodeSetup', true);
		files.add('/home/.claude/CLAUDE.md');
		const claudeCodeSettings = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say bye' }] }] }, permissions: { allow: ['WebFetch(domain:example.com)'] } });
		contents.set('/home/.claude/settings.json', claudeCodeSettings);
		const { parent } = await open({ page: 'customize' });
		const memoryRows = parent.querySelectorAll<HTMLButtonElement>('.claude-customize-group[data-kind="memory"] .claude-customize-item');
		memoryRows[1].click();
		await settle();
		const copy = (kind: string) => parent.querySelector<HTMLButtonElement>(`.claude-customize-group[data-kind="${kind}"] .claude-customize-action`)!;
		copy('hooks').click();
		await settle();
		await settle();
		copy('network').click();
		await settle();
		await settle();
		assert.deepStrictEqual({
			readOnly,
			opened,
			userLayer: JSON.parse(contents.get('/home/.klawly/claude/settings.json')!),
			source: contents.get('/home/.claude/settings.json') === claudeCodeSettings,
			infos,
		}, {
			readOnly: ['/home/.claude/CLAUDE.md:true'],
			opened: ['/home/.claude/CLAUDE.md'],
			userLayer: {
				hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say bye' }] }] },
				permissions: { allow: ['WebFetch(domain:example.com)'] },
				sandbox: { network: { allowedDomains: ['example.com'] } },
			},
			source: true,
			infos: ["Copied to ~/.klawly/claude/settings.json. Claude Code's files were not changed.", "Copied to ~/.klawly/claude/settings.json. Claude Code's files were not changed."],
		});
	});

	test('hooks: the list reads the settings files, the form adds to the chosen file, and remove asks first', async () => {
		contents.set('/work/.claude/settings.json', '{\n  "model": "opus",\n  "hooks": {\n    "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }]\n  }\n}\n');
		contents.set('/home/.claude/settings.json', '{ broken');
		const { parent, texts } = await open({ page: 'customize' });
		const hookRows = () => [...parent.querySelectorAll('.claude-customize-group[data-kind="hooks"] .claude-customize-item')].map(item => `${item.querySelector('.name')!.textContent} | ${item.querySelector('.detail')!.textContent}`);
		const focusKey = (key: string) => parent.querySelector<HTMLElement>(`[data-focus-key="${key}"]`)!;
		const type = (key: string, value: string) => {
			const input = focusKey(key) as HTMLInputElement;
			input.value = value;
			input.dispatchEvent(new Event('input'));
		};
		const listed = hookRows();

		focusKey('customize.add:hooks').click();
		const form = texts('.claude-customize-form .claude-settings-row-title');
		const scopeAfterOpen = focusKey('customize.hooks.scope').textContent;
		// An empty command is refused in place.
		focusKey('customize.hooks.submit').click();
		await settle();
		const refused = texts('.claude-customize-form-note.is-error');
		type('customize.hooks.matcher', 'Bash');
		type('customize.hooks.command', 'npm run lint');
		focusKey('customize.hooks.command').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
		await settle();
		await settle();
		const added = { rows: hookRows(), formOpen: !!parent.querySelector('.claude-customize-form'), file: JSON.parse(contents.get('/work/.claude/settings.json')!) };

		parent.querySelector<HTMLButtonElement>('[data-focus-key="customize.remove:hooks:project:Stop:0:0"]')!.click();
		await settle();
		await settle();
		assert.deepStrictEqual({ listed, form, scopeAfterOpen, refused, added, confirms, after: hookRows(), file: JSON.parse(contents.get('/work/.claude/settings.json')!) }, {
			// allow-any-unicode-next-line
			listed: ['Stop | Project · say done'],
			form: ['Event', 'Tools', 'Command', 'Saved In'],
			scopeAfterOpen: 'For This Project, Shared with the Team',
			refused: ['Enter the one-line command the hook runs.'],
			added: {
				// allow-any-unicode-next-line
				rows: ['Stop | Project · say done', 'PreToolUse · Bash | Project · npm run lint'],
				formOpen: false,
				file: { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'npm run lint' }] }] } },
			},
			confirms: ['Remove the Stop hook?'],
			// allow-any-unicode-next-line
			after: ['PreToolUse · Bash | Project · npm run lint'],
			file: { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'npm run lint' }] }] } },
		});
	});

	test('network: domains list from the settings files, the form writes the WebFetch rule and the sandbox list, and remove asks first', async () => {
		contents.set('/work/.claude/settings.json', '{\n  "permissions": { "allow": ["WebFetch(domain:github.com)"] },\n  "sandbox": { "network": { "allowedDomains": ["github.com"] } }\n}\n');
		const { parent, texts } = await open({ page: 'customize' });
		const domainRows = () => [...parent.querySelectorAll('.claude-customize-group[data-kind="network"] .claude-customize-item')].map(item => `${item.querySelector('.name')!.textContent} | ${item.querySelector('.detail')!.textContent}`);
		const focusKey = (key: string) => parent.querySelector<HTMLElement>(`[data-focus-key="${key}"]`)!;
		const type = (value: string) => {
			const input = focusKey('customize.network.first') as HTMLInputElement;
			input.value = value;
			input.dispatchEvent(new Event('input'));
		};
		const listed = domainRows();

		focusKey('customize.add:network').click();
		const form = texts('.claude-customize-form .claude-settings-row-title');
		type('https://npmjs.org');
		focusKey('customize.network.submit').click();
		await settle();
		const refused = texts('.claude-customize-form-note.is-error');
		type('*.npmjs.org');
		focusKey('customize.network.submit').click();
		await settle();
		await settle();
		const added = domainRows();

		focusKey('customize.remove:network:project:allow:github.com').click();
		await settle();
		await settle();
		assert.deepStrictEqual({ listed, form, refused, added, confirms, after: domainRows(), file: JSON.parse(contents.get('/work/.claude/settings.json')!) }, {
			// allow-any-unicode-next-line
			listed: ['github.com | Allowed · Project · WebFetch and sandbox'],
			form: ['Domain', 'Rule', 'Saved In'],
			refused: ['Enter a host name such as github.com or *.github.com, without https:// or a path.'],
			// allow-any-unicode-next-line
			added: ['github.com | Allowed · Project · WebFetch and sandbox', '*.npmjs.org | Allowed · Project · WebFetch and sandbox'],
			confirms: ['Stop allowing github.com?'],
			// allow-any-unicode-next-line
			after: ['*.npmjs.org | Allowed · Project · WebFetch and sandbox'],
			file: { permissions: { allow: ['WebFetch(domain:*.npmjs.org)'] }, sandbox: { network: { allowedDomains: ['*.npmjs.org'] } } },
		});
	});

	test('issue 512: a loaded server reconnects, turns off and on while the session runs, and Show Logs fills the MCP log channel', async () => {
		mcpControls = [];
		mcpLog = { file: '/cache/mcp-logs-docs/1.jsonl', lines: ['2026-10-12T10:00:00Z [error] connect ECONNREFUSED'] };
		overview = { live: true, mcpServers: [{ name: 'docs', state: 'failed', toolCount: 0, scope: 'user', error: 'connect ECONNREFUSED' }] };
		const { parent } = await open({ page: 'customize' });
		const actions = () => [...parent.querySelectorAll<HTMLButtonElement>('.claude-customize-group[data-kind="mcp"] .claude-customize-action')].map(button => button.getAttribute('aria-label'));
		const press = async (key: string) => {
			parent.querySelector<HTMLButtonElement>(`[data-focus-key="${key}"]`)!.click();
			await settle();
			await settle();
		};
		const failed = actions();
		await press('customize.reconnect:mcp:docs');
		await press('customize.disable:mcp:docs');
		const off = actions();
		await press('customize.enable:mcp:docs');
		await press('customize.logs:mcp:docs');
		assert.deepStrictEqual({ failed, off, mcpControls, outputText }, {
			failed: ['Reconnect', 'Turn Off for This Session', 'Show Logs'],
			off: ['Turn On', 'Show Logs'],
			mcpControls: [['docs', 'reconnect'], ['docs', 'disable'], ['docs', 'enable']],
			outputText: ['docs: /cache/mcp-logs-docs/1.jsonl\n2026-10-12T10:00:00Z [error] connect ECONNREFUSED\n'],
		});
	});

	test('mcp: the form adds a server through Claude Code, it shows until a session loads it, and remove asks first', async () => {
		mcpChanges = [];
		overview = { live: true, mcpServers: [{ name: 'docs', state: 'connected', toolCount: 2, scope: 'user' }] };
		const { parent, texts } = await open({ page: 'customize' });
		const mcpRows = () => [...parent.querySelectorAll('.claude-customize-group[data-kind="mcp"] .claude-customize-item')].map(item => [item.querySelector('.name')!.textContent, item.querySelector('.claude-badge')?.textContent]);
		const focusKey = (key: string) => parent.querySelector<HTMLElement>(`[data-focus-key="${key}"]`)!;
		const type = (key: string, value: string) => {
			const input = focusKey(key) as HTMLInputElement;
			input.value = value;
			input.dispatchEvent(new Event('input'));
		};
		focusKey('customize.add:mcp').click();
		const form = texts('.claude-customize-form .claude-settings-row-title');
		type('customize.mcp.first', '-bad');
		focusKey('customize.mcp.submit').click();
		await settle();
		const badName = texts('.claude-customize-form-note.is-error');
		type('customize.mcp.first', 'github');
		type('customize.mcp.target', 'npx -y "gh server"');
		focusKey('customize.mcp.submit').click();
		await settle();
		await settle();
		const added = mcpRows();
		parent.querySelector<HTMLButtonElement>('[data-focus-key="customize.remove:mcp:docs"]')!.click();
		await settle();
		await settle();
		assert.deepStrictEqual({ form, badName, added, confirms, after: mcpRows(), mcpChanges }, {
			form: ['Name', 'Scope', 'Transport', 'Command'],
			badName: ['Name the server with letters, digits, dots, dashes or underscores, starting with a letter or digit.'],
			added: [['docs', 'Connected'], ['github', 'Next Session']],
			confirms: ['Remove the docs MCP server?'],
			after: [['github', 'Next Session']],
			mcpChanges: [
				{ name: 'github', scope: 'user', config: { type: 'stdio', command: 'npx', args: ['-y', 'gh server'] }, cwd: URI.file('/work').fsPath },
				{ name: 'docs', scope: 'user', cwd: URI.file('/work').fsPath },
			],
		});
	});

	test('mcp: a project server opens the workspace .mcp.json to edit, a user server does not', async () => {
		mcpChanges = [];
		overview = { live: true, mcpServers: [{ name: 'docs', state: 'connected', toolCount: 2, scope: 'project' }, { name: 'mine', state: 'connected', toolCount: 1, scope: 'user' }] };
		const { parent } = await open({ page: 'customize' });
		const edit = (name: string) => parent.querySelector<HTMLButtonElement>(`[data-focus-key="customize.edit:mcp:${name}"]`);
		const before = opened.length;
		edit('docs')!.click();
		await settle();
		assert.deepStrictEqual({ userHasEdit: !!edit('mine'), opened: opened.slice(before) }, { userHasEdit: false, opened: [URI.file('/work/.mcp.json').path] });
	});

	test('automations: the editor shows only the fields its trigger uses, refuses a bad schedule, adds, edits, runs and removes', async () => {
		automations = [{
			automation: { key: 'user:daily', scope: 'user', id: 'daily', name: 'Daily notes', prompt: 'Write notes.', trigger: { type: 'schedule', cron: '0 18 * * *' }, permissionMode: 'agent', target: 'worktree', budgetUsd: 1, allowedTools: [], enabled: true },
			lastRun: { automationKey: 'user:daily', taskId: 't1', trigger: 'schedule', startedAt: Date.now() - 60_000, state: 'failed', message: 'Spend cap reached' },
		}];
		const { parent, texts } = await open({ page: 'agents' });
		const section = parent.querySelector<HTMLElement>('.claude-automations')!;
		const rows = () => [...section.querySelectorAll('.claude-customize-item')].map(item => [item.querySelector('.name')!.textContent, item.querySelector('.claude-badge')?.textContent]);
		const formRows = () => texts('.claude-automations .claude-customize-form .claude-settings-row-title');
		const focusKey = (key: string) => parent.querySelector<HTMLElement>(`[data-focus-key="${key}"]`)!;
		const type = (key: string, value: string) => {
			const input = focusKey(key) as HTMLInputElement;
			input.value = value;
			input.dispatchEvent(new Event('input'));
		};
		const listed = rows();
		focusKey('automations.new').click();
		const form = formRows();
		type('automation.name', 'Lint check');
		type('automation.prompt', 'Run the linter and fix what it reports.');
		type('automation.cron', '0 9 * *');
		focusKey('automation.submit').click();
		await settle();
		const refused = texts('.claude-automations .claude-customize-form-note.is-error');
		type('automation.cron', '0  9 * * 1');
		focusKey('automation.submit').click();
		await settle();
		const added = { rows: rows(), formOpen: !!section.querySelector('.claude-customize-form'), saved: automations[1]?.automation.trigger };
		focusKey('automation.edit:user:daily').click();
		const editForm = formRows();
		type('automation.name', 'Evening notes');
		focusKey('automation.submit').click();
		await settle();
		focusKey('automation.run:workspace:lint-check').click();
		focusKey('automation.remove:workspace:lint-check').click();
		await settle();
		await settle();
		assert.deepStrictEqual({ listed, form, refused, added, editForm, confirms, after: rows(), automationCalls }, {
			listed: [['Daily notes', 'Failed']],
			form: ['Start From', 'Name', 'Prompt', 'Saved In', 'Trigger', 'Schedule', 'Mode', 'Model', 'Effort', 'Spend Cap', 'Turn Cap', 'Allowed Tools', 'Memory'],
			refused: ['Enter a schedule of five fields: minute, hour, day of the month, month and weekday, such as 0 9 * * 1-5.'],
			added: { rows: [['Daily notes', 'Failed'], ['Lint check', undefined]], formOpen: false, saved: { type: 'schedule', cron: '0 9 * * 1' } },
			editForm: ['Name', 'Prompt', 'Trigger', 'Schedule', 'Mode', 'Model', 'Effort', 'Spend Cap', 'Turn Cap', 'Allowed Tools', 'Memory'],
			confirms: ['Remove the Lint check automation?'],
			after: [['Evening notes', undefined]],
			automationCalls: ['save workspace:lint-check', 'save user:daily over daily', 'run workspace:lint-check', 'remove workspace:lint-check'],
		});
	});

	test('automations: Run Now starts a background agent through the automation service, and the row shows the run (issue 426)', async () => {
		// The real automation service, reading automations.json and starting runs on a fake background agent service.
		const started: string[] = [];
		const tasks: BackgroundAgentTask[] = [];
		const taskChanges = store.add(new Emitter<void>());
		const background = {
			onDidChangeTasks: taskChanges.event,
			getTasks: () => tasks,
			start: async (prompt: string, options?: ClaudeBackgroundRunOptions) => {
				const { taskId, ...rest } = options!;
				started.push(`${prompt} | ${JSON.stringify(rest)}`);
				const task = { id: taskId!, sessionId: `session-${taskId}`, status: 'running', title: options!.title, filesChanged: 0, added: 0, removed: 0 } as BackgroundAgentTask;
				tasks.push(task);
				taskChanges.fire();
				return task;
			},
		} as unknown as IClaudeBackgroundAgentService;
		const agent = { onDidChangeViewState: BaseEvent.None, getViewState: () => EMPTY_AGENT_VIEW_STATE, getCurrentSession: () => undefined } as unknown as IClaudeAgentService;
		const automationsFile = URI.file('/work/.klawly/automations.json');
		const automationFiles = {
			onDidFilesChange: BaseEvent.None,
			exists: async (resource: URI) => resource.path === automationsFile.path,
			readFile: async (resource: URI) => {
				if (resource.path !== automationsFile.path) {
					throw new FileOperationError('not found', FileOperationResult.FILE_NOT_FOUND);
				}
				return { resource, value: VSBuffer.fromString(JSON.stringify({ automations: [{ id: 'triage', name: 'Triage issues', prompt: 'Label the new issues.', trigger: { type: 'manual' }, model: 'fixture-sonnet', budgetUsd: 0.5 }] })) };
			},
		} as unknown as IFileService;
		const service = store.add(new ClaudeAutomationService(
			background,
			agent,
			{} as IClaudePermissionService,
			automationFiles,
			{ userHome: async () => URI.file('/home') } as unknown as IPathService,
			{ getWorkspace: () => ({ folders: [{ uri: URI.file('/work') }] }), onDidChangeWorkspaceFolders: BaseEvent.None } as unknown as IWorkspaceContextService,
			{ isWorkspaceTrusted: () => true, onDidChangeTrust: BaseEvent.None } as unknown as IWorkspaceTrustManagementService,
			{ files: { onDidSave: BaseEvent.None } } as unknown as ITextFileService,
			store.add(new InMemoryStorageService()),
			configuration,
			{ warn: (message: string) => warnings.push(message), error: (message: string) => warnings.push(message) } as unknown as INotificationService,
			new NullLogService(),
			{ _serviceBrand: undefined, get: async () => ({ status: 304 }) },
			{ _serviceBrand: undefined, sync: async () => [] },
		));
		await service.reload();
		instantiation.stub(IClaudeAutomationService, service);
		const { parent } = await open({ page: 'agents' });
		const rows = () => [...parent.querySelectorAll('.claude-automations .claude-customize-item')].map(item => [item.querySelector('.name')!.textContent, item.querySelector('.claude-badge')?.textContent]);
		const before = rows();
		parent.querySelector<HTMLElement>('[data-focus-key="automation.run:workspace:triage"]')!.click();
		await settle();
		await settle();
		assert.deepStrictEqual({ before, started, task: [tasks[0]?.id.startsWith('automation-triage-'), service.automationOfTask(tasks[0]?.id)?.key], after: rows(), warnings }, {
			before: [['Triage issues', undefined]],
			started: ['Label the new issues. | {"title":"Triage issues (automation)","modelId":"fixture-sonnet","maxBudgetUsd":0.5,"maxTurns":32,"mode":"agent","select":false}'],
			task: [true, 'workspace:triage'],
			after: [['Triage issues', 'Running']],
			warnings: [],
		});
	});

	test('a page that grows after its render still scrolls to its last row (issue 533)', async () => {
		const { editor, parent } = await open({ page: 'agents' }, 1200, ObservedSettingsEditor);
		// Browser tests do not load claude.css: give the body the height it sets there.
		parent.querySelector<HTMLElement>('.claude-settings-body')!.style.height = '100%';
		editor.layout(new Dimension(1200, 200));
		const content = parent.querySelector<HTMLElement>('.claude-settings-content')!;
		// A row that fills in after the render, as the sandbox status or the usage meters do.
		append(content, $('div')).style.height = '2000px';
		const stale = editor.scrollSize;
		FakeResizeObserver.last!.fire();
		assert.deepStrictEqual({
			observed: FakeResizeObserver.last!.targets.has(content),
			height: editor.scrollSize.height,
			staleCovers: stale.scrollHeight >= content.offsetHeight,
			covers: editor.scrollSize.scrollHeight >= content.offsetHeight,
		}, { observed: true, height: 200, staleCovers: false, covers: true });
	});

	test('a session that lists its catalog refreshes the page', async () => {
		const { texts } = await open({ page: 'customize' });
		overview = FAKE_CLAUDE_ACCOUNT_OVERVIEW;
		runtimeEvents.fire({ type: 'session.catalog', sessionId: 's1', commands: [], agents: [] });
		await settle();
		assert.deepStrictEqual(texts('.claude-settings-account-text > div'), ['fixture@example.invalid', 'Max Plan']);
	});
});
