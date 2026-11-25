/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { getActiveElement, getWindow } from '../../../../../base/browser/dom.js';
import { AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import { IDelayedHoverOptions, IHoverOptions, IHoverWidget } from '../../../../../base/browser/ui/hover/hover.js';
import { IAction } from '../../../../../base/common/actions.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BeginClaudeRequest, ClaudeModelInfo, ClaudeRunHandle, ClaudeUserInput, IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { ClaudeContextBreakdown } from '../../../../../platform/claude/common/claudeProtocol.js';
import { IClaudeActionService } from '../../../../../platform/claude/common/claudeActions.js';
import { JsonlSessionStore } from '../../../../../platform/claude/common/claudeSessionStore.js';
import { FakeClaudeRuntimeService } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { CLAUDE_COMPOSER_WHILE_WORKING_SETTING } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { TestClipboardService } from '../../../../../platform/clipboard/test/common/testClipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService, IContextViewDelegate, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IMarkerService } from '../../../../../platform/markers/common/markers.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { TestWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { IOutlineModelService } from '../../../../../editor/contrib/documentSymbols/browser/outlineModel.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry } from '../../../../common/views.js';
import { CLAUDE_COMMAND_LOG_CHANNEL_ID } from '../../../../services/claude/common/claudeAgentLog.js';
import { AgentReducerEvent } from '../../../../services/claude/common/claudeAgentState.js';
import { CLAUDE_EVENT_LOG_CAP, ClaudeAgentService, IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudeContextService } from '../../../../services/claude/common/claudeContextService.js';
import { CLAUDE_VOICE_IDLE, IClaudeVoiceInputService } from '../../common/claudeVoiceInput.js';
import { IKlawlySyncService } from '../../../../../platform/claude/common/klawlySyncService.js';
import { Event as BaseEvent } from '../../../../../base/common/event.js';
import { ClaudeCopyTracker, IClaudeCopyTracker } from '../../../../services/claude/common/claudeCopyTracker.js';
import { IClaudeDiagnosticsService } from '../../../../services/claude/common/claudeDiagnostics.js';
import { ClaudePermissionService, IClaudePermissionService } from '../../../../services/claude/common/claudePermissionService.js';
import { ClaudeElicitationService, IClaudeElicitationService } from '../../../../services/claude/common/claudeElicitationService.js';
import { ClaudeModelSwitchService, IClaudeModelSwitchService } from '../../browser/claudeModelSwitch.js';
import { IClaudeReviewService } from '../../../../services/claude/common/claudeReview.js';
import { IClaudeMakerService } from '../../browser/claudeMakerService.js';
import { agentWorkspaceStubs, MemorySessionStorage } from '../../../../services/claude/test/common/claudeAgentTestUtils.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IHistoryService } from '../../../../services/history/common/history.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { ViewDescriptorService } from '../../../../services/views/browser/viewDescriptorService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { TestWorkspaceTrustManagementService } from '../../../../test/common/workbenchTestServices.js';
import { ISCMService } from '../../../scm/common/scm.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { ClaudeContextPicker } from '../../browser/chat/claudeContextPicker.js';
import { IClaudeGitHubDetailsService } from '../../browser/chat/claudeGitHubDetails.js';
import { ClaudeAgentViewPane } from '../../browser/chat/claudeViewPane.js';
import { IClaudeCloudSessionsService } from '../../browser/claudeCloudSessions.js';
import { IClaudeProjectIndex } from '../../browser/claudeProjects.js';
import { IClaudeSetupService } from '../../browser/claudeSetup.js';
import { IClaudeAutomationService } from '../../../../services/claude/common/claudeAutomationService.js';
import { IClaudeBackgroundAgentService } from '../../../../services/claude/common/claudeBackgroundAgent.js';
import { CLAUDE_COMPARE_MODELS_COMMAND_ID, IClaudeComparisonService } from '../../../../services/claude/common/claudeComparison.js';
import { IClaudeGoalLoopService } from '../../common/claudeGoalLoopService.js';
import { IClaudeMultitaskService } from '../../../../services/claude/common/claudeMultitask.js';
import { IClaudeDelegationService } from '../../../../services/claude/common/claudeDelegation.js';
import { IClaudeWorkerRegistry } from '../../../../services/claude/common/claudeWorkerRegistry.js';
import { registerClaudeViewDescriptors } from '../../browser/claudeViewRegistration.js';
import { CLAUDE_AGENT_VIEW_ID, CLAUDE_MANAGE_MODELS_COMMAND_ID, CLAUDE_VIEW_CONTAINER_ID } from '../../common/claudeViews.js';
import { moveClaudeTestFocus } from './claudeFocusTestUtils.js';
import { silentGitHubDetailsService, silentTendService } from './claudeGitHubTestUtils.js';
import { IClaudeTendPullRequestService } from '../../browser/chat/claudeTendPullRequest.js';
import { readySetupService, TestClaudeSetupService } from './claudeSetupTestUtils.js';
import { IClaudeChatShareService } from '../../browser/chat/claudeChatShare.js';

interface RecordedHover {
	readonly target: HTMLElement;
	readonly options: () => IDelayedHoverOptions;
}

interface ShownMenu {
	readonly anchor: unknown;
	readonly actions: readonly IAction[];
}

suite('Claude pane chrome (Phase 29)', function () {
	// `settle` waits for an animation frame, and a hidden test window can draw one a second.
	this.timeout(30_000);
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiationService: TestInstantiationService;
	let runtime: ChromeRuntime;
	let agent: ClaudeAgentService;
	let hovers: RecordedHover[];
	let focusHovers: { readonly target: IHoverOptions['target']; open: boolean }[];
	let menus: ShownMenu[];
	let contextViews: { delegate: IContextViewDelegate; host: HTMLElement }[];
	let commands: string[];
	let views: { opened: string[]; closed: string[]; visible: Set<string> };
	let resolved: string;
	let compareModels: IDisposable | undefined;

	// The model menu offers Compare Models when its command exists, as in the app; register it here so the menu does not depend on which suites loaded first.
	suiteSetup(() => {
		compareModels = CommandsRegistry.getCommand(CLAUDE_COMPARE_MODELS_COMMAND_ID) ? undefined : CommandsRegistry.registerCommand(CLAUDE_COMPARE_MODELS_COMMAND_ID, () => undefined);
	});

	suiteTeardown(() => compareModels?.dispose());

	setup(() => {
		hovers = [];
		focusHovers = [];
		menus = [];
		contextViews = [];
		commands = [];
		views = { opened: [], closed: [], visible: new Set() };
		resolved = 'src/app.ts lines 1-3';
		instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IContextKeyService, store.add(instantiationService.createInstance(ContextKeyService)));
		registerClaudeViewDescriptors(new SyncDescriptor(ClaudeAgentViewPane));
		instantiationService.stub(IViewDescriptorService, store.add(instantiationService.createInstance(ViewDescriptorService)));
		runtime = store.add(new ChromeRuntime(chromeFixtures()));
		const outputService = {
			_serviceBrand: undefined,
			getChannel: (id: string) => ({ append: () => { assert.ok(id === CLAUDE_COMMAND_LOG_CHANNEL_ID || id); } }),
			showChannel: async () => undefined,
		} as unknown as IOutputService;
		agent = store.add(new ClaudeAgentService(runtime, outputService, ...agentWorkspaceStubs()));
		instantiationService.stub(IOutputService, outputService);
		instantiationService.stub(ITerminalService, { activeInstance: undefined, createTerminal: async () => ({}) } as unknown as ITerminalService);
		instantiationService.stub(IClaudeAgentService, agent);
		instantiationService.stub(IClaudeRuntimeService, runtime);
		instantiationService.stub(IClaudeSetupService, readySetupService());
		instantiationService.stub(IClaudeBackgroundAgentService, { onDidChangeTasks: () => ({ dispose() { } }), getTasks: () => [] } as unknown as IClaudeBackgroundAgentService);
		instantiationService.stub(IClaudeAutomationService, { onDidChange: () => ({ dispose() { } }), automationOfTask: () => undefined } as unknown as IClaudeAutomationService);
		instantiationService.stub(IClaudeCloudSessionsService, { onDidChange: () => ({ dispose() { } }), getSessions: () => [] } as unknown as IClaudeCloudSessionsService);
		instantiationService.stub(IClaudeProjectIndex, { onDidChange: () => ({ dispose() { } }), projectOf: () => undefined, refresh: () => { } } as unknown as IClaudeProjectIndex);
		instantiationService.stub(IClaudeGitHubDetailsService, silentGitHubDetailsService());
		instantiationService.stub(IClaudeTendPullRequestService, silentTendService());
		instantiationService.stub(IClaudeComparisonService, { onDidChangeComparisons: () => ({ dispose() { } }), getHistory: () => [] } as unknown as IClaudeComparisonService);
		instantiationService.stub(IClaudeGoalLoopService, { onDidChange: () => ({ dispose() { } }), getGoal: () => undefined, getEnded: () => undefined, getLoop: () => undefined } as unknown as IClaudeGoalLoopService);
		instantiationService.stub(IClaudeMultitaskService, { onDidChange: () => ({ dispose() { } }), getGroups: () => [] } as unknown as IClaudeMultitaskService);
		instantiationService.stub(IClaudeDelegationService, { onDidChange: () => ({ dispose() { } }), getQuestion: () => undefined, getCardForChild: () => undefined, getRoot: (id: string) => id, getDelegatedCost: () => undefined, getRolledUpCost: () => undefined } as unknown as IClaudeDelegationService);
		instantiationService.stub(IClaudeWorkerRegistry, { sessionTotals: () => ({ costUsd: 0, inputTokens: 0, outputTokens: 0, runs: 0 }) } as unknown as IClaudeWorkerRegistry);
		instantiationService.stub(IClaudePermissionService, store.add(instantiationService.createInstance(ClaudePermissionService)));
		instantiationService.stub(IClaudeElicitationService, instantiationService.createInstance(ClaudeElicitationService));
		instantiationService.stub(IClaudeModelSwitchService, store.add(instantiationService.createInstance(ClaudeModelSwitchService)));
		instantiationService.stub(IClaudeMakerService, { onDidChange: () => ({ dispose() { } }), role: 'user', previewAsUser: false, active: false, setPreviewAsUser: () => { } } as unknown as IClaudeMakerService);
		instantiationService.stub(IClaudeReviewService, {
			onDidChangeReview: () => ({ dispose() { } }),
			onDidNavigate: () => ({ dispose() { } }),
			get: () => undefined,
			ensureTurn: async () => undefined,
			onDidChangeAutoKeep: () => ({ dispose() { } }),
			isAutoKeep: () => false,
			autoKept: () => false,
			pendingSummary: () => ({ hunks: 0, files: 0, turns: 0, chats: 0, uris: [], sessionIds: [] }),
		} as unknown as IClaudeReviewService);
		instantiationService.stub(IClaudeDiagnosticsService, {
			onDidChangeProblems: () => ({ dispose() { } }),
			getProblems: () => undefined,
		} as unknown as IClaudeDiagnosticsService);
		instantiationService.stub(IClaudeActionService, { run: async () => undefined } as unknown as IClaudeActionService);
		instantiationService.stub(IClaudeCopyTracker, new ClaudeCopyTracker());
		instantiationService.stub(IClaudeVoiceInputService, { isSupported: false, status: CLAUDE_VOICE_IDLE, onDidChangeStatus: () => ({ dispose() { } }), onDidTranscribe: () => ({ dispose() { } }) } as unknown as IClaudeVoiceInputService);
		instantiationService.stub(IKlawlySyncService, { onDidChangeStatus: BaseEvent.None, listImportedSessions: async () => [] } as unknown as IKlawlySyncService);
		instantiationService.stub(IClaudeContextService, {
			resolve: async (userText: string, mode: 'agent', attachments: readonly { kind: string }[]) => ({
				userText,
				mode,
				workspaceRoot: '/repo',
				attachments: attachments.map(() => ({ kind: 'selection' as const, path: resolved.split(' ')[0], range: { startLine: 1, startColumn: 1, endLine: 3, endColumn: 1 }, content: 'x', stale: false, truncated: false })),
				diagnostics: [],
				instructionFiles: [],
			}),
			preview: async () => 'PREVIEW',
		} as unknown as IClaudeContextService);
		instantiationService.stub(IClipboardService, new TestClipboardService());
		instantiationService.stub(IClaudeChatShareService, { linksEnabled: false, copyMarkdown: async () => { }, shareLink: async () => { } } as unknown as IClaudeChatShareService);
		// The @ menu searches files, folders and symbols; keep those quick and local.
		instantiationService.stub(ISearchService, { fileSearch: async () => ({ results: [{ resource: URI.joinPath(TestWorkspace.folders[0].uri, 'src', 'app.ts') }], messages: [] }) } as unknown as ISearchService);
		instantiationService.stub(IFileService, 'resolve', async () => ({ children: [] }));
		instantiationService.stub(IMarkerService, { read: () => [] } as unknown as IMarkerService);
		instantiationService.stub(ISCMService, { repositories: [] } as unknown as ISCMService);
		instantiationService.stub(IOutlineModelService, { getOrCreate: async () => { throw new Error('no outline'); } } as unknown as IOutlineModelService);
		instantiationService.stub(IViewsService, {
			openView: async (id: string) => { views.opened.push(id); views.visible.add(id); return undefined; },
			closeView: (id: string) => { views.closed.push(id); views.visible.delete(id); },
			isViewVisible: (id: string) => views.visible.has(id),
		} as unknown as IViewsService);
		instantiationService.stub(INotificationService, { error: () => undefined, info: () => undefined, warn: () => undefined, status: () => ({ dispose() { } }) } as unknown as INotificationService);
		instantiationService.stub(ICommandService, { executeCommand: async (id: string) => { commands.push(id); return undefined; } } as unknown as ICommandService);
		instantiationService.stub(IHoverService, {
			...NullHoverService,
			setupDelayedHover: (target: HTMLElement, options: RecordedHover['options'] | ReturnType<RecordedHover['options']>) => {
				const entry = { target, options: typeof options === 'function' ? options : () => options };
				hovers.push(entry);
				return toDisposable(() => hovers.splice(hovers.indexOf(entry), 1));
			},
			showDelayedHover: (options: IHoverOptions) => {
				const entry = { target: options.target, open: true };
				focusHovers.push(entry);
				return { isDisposed: false, dispose: () => { entry.open = false; } } as IHoverWidget;
			},
		} satisfies IHoverService);
		instantiationService.stub(IContextMenuService, {
			showContextMenu: (delegate: IContextMenuDelegate) => {
				menus.push({ anchor: delegate.getAnchor(), actions: delegate.getActions() });
			},
			onDidShowContextMenu: () => ({ dispose() { } }),
			onDidHideContextMenu: () => ({ dispose() { } }),
		} as unknown as IContextMenuService);
		instantiationService.stub(IContextViewService, {
			showContextView: (delegate: IContextViewDelegate) => {
				const host = document.createElement('div');
				document.body.appendChild(host);
				const rendered: IDisposable = delegate.render(host);
				const entry = { delegate, host };
				contextViews.push(entry);
				let open = true;
				return {
					close: () => {
						if (open) {
							open = false;
							rendered.dispose();
							host.remove();
							delegate.onHide?.();
						}
					},
				};
			},
			hideContextView: () => undefined,
		} as unknown as IContextViewService);
	});

	teardown(() => {
		const registry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		const containers = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
		const container = containers.get(CLAUDE_VIEW_CONTAINER_ID);
		if (container) {
			registry.deregisterViews(registry.getViews(container), container);
			containers.deregisterViewContainer(container);
		}
	});

	test('audit 3: the pane, the @ menu, the model menu, the history popover and hovers carry .claude-root', async () => {
		const pane = openAgentPane();
		const picker = store.add(instantiationService.createInstance(ClaudeContextPicker));
		picker.show(composer(pane), 'at', '');
		await settle();
		modelPill(pane).click();
		await settle();
		headerButton(pane, 'Agent History').click();
		await settle();
		assert.deepStrictEqual({
			pane: pane.element.querySelector('.claude-pane')?.classList.contains('claude-root'),
			menus: contextViews.map(view => view.host.firstElementChild?.classList.contains('claude-root')),
			hovers: hovers.length > 0 && hovers.every(hover => hover.options().additionalClasses?.includes('claude-root')),
		}, { pane: true, menus: [true, true, true], hovers: true });
		picker.close();
	});

	test('audit 4, #82: Agent is the only view; History drops down from its button, toggles, and a pick closes it', () => {
		const model = instantiationService.get(IViewDescriptorService).getViewContainerModel(Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).get(CLAUDE_VIEW_CONTAINER_ID)!);
		assert.deepStrictEqual(model.visibleViewDescriptors.map(view => view.id), [CLAUDE_AGENT_VIEW_ID]);

		const pane = openAgentPane();
		const first = agent.getCurrentSession()!;
		agent.createSession();
		const button = headerButton(pane, 'Agent History');
		button.click();
		const opened = !!historyMenu();
		button.click();
		const toggled = !!historyMenu();
		button.click();
		historyRow(first.id)!.click();
		assert.deepStrictEqual({ opened, toggled, current: agent.getCurrentSession()?.id, open: !!historyMenu(), views: views.opened }, { opened: true, toggled: false, current: first.id, open: false, views: [] });
	});

	test('#82: history groups pinned chats first, folds archived ones away, and Pin and Archive act in place', async () => {
		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		agent.attachDurableHistory(sessions);
		const pane = openAgentPane();
		const first = agent.getCurrentSession()!;
		const second = agent.createSession();
		const third = agent.createSession();
		// An empty chat is not kept once it closes, so the archived one has a turn.
		await send(pane, 'Archive me');
		await until(() => agent.getViewState(third.id).turns[0]?.status === 'complete');
		await until(() => !!disk.files.get(sessions.indexPath())?.includes(third.id));
		headerButton(pane, 'Agent History').click();
		const groups = () => [...historyMenu()!.querySelectorAll<HTMLElement>('.claude-menu-group, .claude-menu-item')].map(element => element.classList.contains('claude-menu-group') ? `# ${element.textContent}` : element.dataset.sessionId ?? element.querySelector('.label')?.textContent);
		const action = (sessionId: string, id: string) => historyRow(sessionId)!.parentElement!.querySelector<HTMLButtonElement>(`.claude-menu-action[data-action="${id}"]`)!;
		action(second.id, 'pin').click();
		await settle();
		action(third.id, 'archive').click();
		await settle();
		const listed = groups();
		historyMenu()!.querySelector<HTMLButtonElement>('.claude-history-group')!.click();
		await settle();
		const expanded = groups();
		assert.deepStrictEqual({
			listed,
			expanded,
			tabs: agent.getSessions().map(session => session.id),
			pinned: agent.getHistory().find(session => session.id === second.id)?.pinned,
			actions: [...historyRow(third.id)!.parentElement!.querySelectorAll<HTMLElement>('.claude-menu-action')].map(button => button.dataset.action),
		}, {
			listed: ['# Pinned', second.id, '# Today', first.id, '# Cloud', 'Bring Back a Session from claude.ai...', 'Archived'],
			expanded: ['# Pinned', second.id, '# Today', first.id, '# Cloud', 'Bring Back a Session from claude.ai...', 'Archived', third.id],
			tabs: [first.id, second.id],
			pinned: true,
			actions: ['unarchive', 'more'],
		});
	});

	test('#82: the history search matches the workspace too, and More opens the session menu inside the popover (issue 746)', async () => {
		const pane = openAgentPane();
		const first = agent.getCurrentSession()!;
		const second = agent.createSession();
		headerButton(pane, 'Agent History').click();
		const search = historyMenu()!.querySelector<HTMLInputElement>('input')!;
		const filter = (text: string) => {
			search.value = text;
			search.dispatchEvent(new Event('input', { bubbles: true }));
			return historyMenu()!.querySelectorAll('.claude-menu-item').length;
		};
		const matched = filter(first.workspaceName!.toLowerCase());
		const none = filter('no such agent');
		filter('');
		const contextMenus = menus.length;
		historyRow(first.id)!.parentElement!.querySelector<HTMLButtonElement>('.claude-menu-action[data-action="more"]')!.click();
		const submenu = () => historyMenu()?.parentElement?.querySelector<HTMLElement>('.claude-submenu');
		const more = { open: !!historyMenu(), rows: [...submenu()?.querySelectorAll<HTMLElement>('.claude-menu-item') ?? []].map(row => row.querySelector('.label')?.textContent) };
		// Streaming repaints the rows; the session menu stays open over them.
		agent.setPinned(second.id, true);
		await settle();
		const afterRepaint = !!submenu();
		[...submenu()!.querySelectorAll<HTMLElement>('.claude-menu-item')].find(row => row.querySelector('.label')?.textContent === 'Pin')!.click();
		await settle();
		assert.deepStrictEqual({ matched, none, more: { open: more.open, pin: more.rows.includes('Pin') }, afterRepaint, closed: !historyMenu(), pinned: agent.getHistory().find(session => session.id === first.id)?.pinned, contextMenus: menus.length - contextMenus }, {
			matched: 2,
			none: 0,
			more: { open: true, pin: true },
			afterRepaint: true,
			closed: true,
			pinned: true,
			contextMenus: 0,
		});
	});

	test('issue 489: the history search finds text inside a chat and opens that chat at the turn', async () => {
		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		agent.attachDurableHistory(sessions);
		const pane = openAgentPane();
		const first = agent.getCurrentSession()!;
		await send(pane, 'Why is the flaky retry test slow');
		await until(() => agent.getViewState(first.id).turns[0]?.status === 'complete');
		await until(() => !!disk.files.get(sessions.indexPath())?.includes(first.id));
		const turnId = agent.getViewState(first.id).turns[0].id;
		const second = agent.createSession();
		headerButton(pane, 'Agent History').click();
		const search = historyMenu()!.querySelector<HTMLInputElement>('input')!;
		search.value = 'flaky retr';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		await until(() => !!historyMenu()?.querySelector('.claude-history-hit'));
		const hits = [...historyMenu()!.querySelectorAll<HTMLElement>('.claude-history-hit')].map(row => ({ sessionId: row.dataset.sessionId, turnId: row.dataset.turnId }));
		const header = [...historyMenu()!.querySelectorAll<HTMLElement>('.claude-menu-group')].map(group => group.textContent);
		historyMenu()!.querySelector<HTMLButtonElement>('.claude-history-hit')!.click();
		await until(() => agent.getCurrentSession()?.id === first.id);
		assert.deepStrictEqual({ hits, header: header.includes('In Chats'), current: agent.getCurrentSession()?.id, left: second.id !== first.id }, {
			hits: [{ sessionId: first.id, turnId }],
			header: true,
			current: first.id,
			left: true,
		});
	});

	test('issue 98: sessions sit on top by default; Show Agents Sidebar puts the agents column beside a wide pane, and History only drops down its popover', async () => {
		const configuration = instantiationService.get(IConfigurationService) as TestConfigurationService;
		const writes: unknown[] = [];
		configuration.updateValue = async (key: string, value: unknown) => {
			writes.push(value);
			await configuration.setUserConfiguration(key, value);
			configuration.onDidChangeConfigurationEmitter.fire({
				source: ConfigurationTarget.USER,
				affectedKeys: new Set([key]),
				change: { keys: [key], overrides: [] },
				affectsConfiguration: changed => changed === key,
			});
		};
		const pane = openAgentPane(800);
		const column = pane.element.querySelector<HTMLElement>('.claude-agents')!;
		const chat = pane.element.querySelector<HTMLElement>('.claude-pane')!;
		const sidebar = () => pane.element.querySelector<HTMLButtonElement>('.claude-pane-actions button[aria-pressed]')!;
		const state = () => ({
			column: !column.hidden,
			chatWidth: chat.style.width,
			button: `${sidebar().getAttribute('aria-label')}${sidebar().classList.contains('is-active') ? '*' : ''}`,
		});
		const top = state();
		headerButton(pane, 'Agent History').click();
		const history = { popover: !!historyMenu(), opened: [...views.opened], wide: state() };
		headerButton(pane, 'Agent History').click();
		const closed = !!historyMenu();
		headerButton(pane, 'Show Agents Sidebar').click();
		await until(() => !column.hidden);
		const side = state();
		pane.orthogonalSize = 360;
		pane.layout(560);
		const narrow = state();
		headerButton(pane, 'Hide Agents Sidebar').click();
		await until(() => sidebar().getAttribute('aria-label') === 'Show Agents Sidebar');
		pane.orthogonalSize = 800;
		pane.layout(560);
		assert.deepStrictEqual({ top, history, closed, side, narrow, back: state(), writes }, {
			top: { column: false, chatWidth: '800px', button: 'Show Agents Sidebar' },
			history: { popover: true, opened: [], wide: { column: false, chatWidth: '800px', button: 'Show Agents Sidebar' } },
			closed: false,
			side: { column: true, chatWidth: '586px', button: 'Hide Agents Sidebar*' },
			narrow: { column: false, chatWidth: '360px', button: 'Hide Agents Sidebar' },
			back: { column: false, chatWidth: '800px', button: 'Show Agents Sidebar' },
			writes: ['side', 'top'],
		});
	});

	test('issue 103: widening the pane opens neither the agents sidebar nor Session History; only a click does', () => {
		const pane = openAgentPane(360);
		const column = pane.element.querySelector<HTMLElement>('.claude-agents')!;
		const chat = pane.element.querySelector<HTMLElement>('.claude-pane')!;
		const widths = [800, 1200, 1600].map(width => {
			pane.orthogonalSize = width;
			pane.layout(560);
			return { column: !column.hidden, chatWidth: chat.style.width };
		});
		assert.deepStrictEqual({ widths, popover: !!historyMenu(), opened: views.opened }, {
			widths: [{ column: false, chatWidth: '800px' }, { column: false, chatWidth: '1200px' }, { column: false, chatWidth: '1600px' }],
			popover: false,
			opened: [],
		});
	});

	test('audit 8: a streaming turn keeps the queued rows in place so their hover actions stay reachable', async () => {
		runtime.hold = true;
		const pane = openAgentPane();
		await send(pane, 'Look');
		await until(() => sendButton(pane).classList.contains('is-stop'));
		const input = composer(pane);
		input.value = 'Then check the tests';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		pane.element.querySelector<HTMLButtonElement>('button.claude-queue-send')!.click();
		await until(() => !!pane.element.querySelector('.claude-queue-item'));
		const row = pane.element.querySelector('.claude-queue-item');
		runtime.stream('Reading');
		runtime.stream(' the file');
		await settle();
		const kept = [pane.element.querySelector('.claude-queue-item') === row, !!row?.isConnected];
		runtime.release();
		await until(() => !sendButton(pane).classList.contains('is-stop'));
		assert.deepStrictEqual(kept, [true, true]);
	});

	test('a queued message shows its images as themselves, by their own names (DL-74, issue 791)', async () => {
		runtime.hold = true;
		const pane = openAgentPane();
		await send(pane, 'Look');
		await until(() => sendButton(pane).classList.contains('is-stop'));
		const session = agent.getCurrentSession()!;
		await agent.queue(session.id, 'Match this mockup', '/repo', 'queue', { attachments: [{ kind: 'image', localUri: 'file:///tmp/mockup.png', name: 'mockup.png' }, { kind: 'image', localUri: 'file:///tmp/0b5e7a52-1c1f-4c6e-9d43-3f1a2b9c7d10.png' }] });
		await until(() => !!pane.element.querySelector('.claude-queue-item'));
		const row = pane.element.querySelector('.claude-queue-item')!;
		const queued = {
			thumbs: [...row.querySelectorAll('.claude-image-thumb')].map(thumb => thumb.getAttribute('aria-label')),
			text: row.querySelector('.text')?.textContent,
		};
		runtime.release();
		await until(() => !sendButton(pane).classList.contains('is-stop'));
		assert.deepStrictEqual(queued, { thumbs: ['mockup.png', 'Image'], text: 'Match this mockup' });
	});

	test('audit 8, #136: the queued placeholder clears when the turn ends and a follow-up one takes its place', async () => {
		runtime.hold = true;
		const pane = openAgentPane();
		const input = composer(pane);
		const idle = input.placeholder;
		await send(pane, 'Look');
		await until(() => sendButton(pane).classList.contains('is-stop'));
		const running = input.placeholder;
		runtime.release();
		await until(() => !sendButton(pane).classList.contains('is-stop'));
		assert.deepStrictEqual([idle, running, input.placeholder], ['Plan, build, / for commands, @ for context', 'Add a follow-up — queued until the agent finishes', 'Add a follow-up']);
	});

	test('audit 9: the pill shows the effective model and opens an anchored menu with a check and Manage Models', async () => {
		const pane = openAgentPane();
		const before = modelPill(pane).textContent;
		await send(pane, 'Hi');
		await until(() => modelPill(pane).textContent === 'Fixture Opus');
		modelPill(pane).click();
		await settle();
		const view = contextViews.at(-1)!;
		const top = menuRows(view.host);
		view.host.querySelector<HTMLElement>('[data-setting="model"]')!.click();
		await settle();
		const list = [...view.host.querySelectorAll('.claude-submenu > .claude-menu-body > *')].map(row =>
			row.classList.contains('claude-menu-group') ? row.textContent
				: row.classList.contains('claude-menu-separator') ? null
					: [rowName(row), row.querySelector('.desc')?.textContent ?? '', row.getAttribute('aria-checked')]);
		assert.deepStrictEqual({
			before,
			above: view.delegate.anchorPosition === AnchorPosition.ABOVE,
			expanded: modelPill(pane).getAttribute('aria-expanded'),
			// The runtime model has a 1M variant, so the Context row shows. Claude Code's default model reports no effort.
			top,
			list,
		}, {
			before: 'Loading...',
			above: true,
			expanded: 'true',
			top: [['Context', 'Standard', null], ['Model', 'Fixture Opus', null]],
			// One line per model: what a model is for lives in its hover card. Auto leads the list as a model entry (#1579).
			list: [['Auto', 'Picks the model for each turn', 'false'], null, ['Fixture Opus', '', 'true'], ['Fixture Sonnet', '', 'false'], null, ['Compare Models...', '', null], ['Manage Models...', '', null]],
		});
		const submenu = view.host.querySelector<HTMLElement>('.claude-submenu')!;
		submenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		submenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await until(() => agent.getCurrentSession()?.modelId === 'fixture-sonnet');
		assert.deepStrictEqual([modelPill(pane).textContent, document.activeElement === modelPill(pane), modelPill(pane).getAttribute('aria-expanded')], ['Fixture Sonnet', true, 'false']);

		modelPill(pane).click();
		await settle();
		contextViews.at(-1)!.host.querySelector<HTMLElement>('[data-setting="model"]')!.click();
		await settle();
		[...contextViews.at(-1)!.host.querySelectorAll<HTMLElement>('.claude-submenu [role="menuitem"]')].find(row => row.textContent?.startsWith('Manage Models'))!.click();
		assert.deepStrictEqual(commands, [CLAUDE_MANAGE_MODELS_COMMAND_ID]);
	});

	test('Phase 33: the model menu shows only what the model takes; switches stay open and the pill names the choice', async () => {
		const pane = openAgentPane();
		const session = agent.getCurrentSession()!;
		await agent.setNextModel(session.id, 'fixture-sonnet');
		await settle();
		modelPill(pane).click();
		await settle();
		const sonnet = menuRows(contextViews.at(-1)!.host);
		contextViews.at(-1)!.host.querySelector<HTMLElement>('.claude-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await settle();

		await agent.setNextModel(session.id, 'fixture-opus');
		await settle();
		modelPill(pane).click();
		await settle();
		let view = contextViews.at(-1)!;
		const opus = menuRows(view.host);
		view.host.querySelector<HTMLElement>('[data-setting="fast"]')!.click();
		await until(() => agent.getSessionSettings(session.id).fastMode === true);
		const afterFast = [view.host.isConnected, view.host.querySelector('[data-setting="fast"]')!.getAttribute('aria-checked')];
		view.host.querySelector<HTMLElement>('[data-setting="effort"]')!.click();
		await settle();
		const efforts = [...view.host.querySelectorAll('.claude-submenu .claude-menu-item')].map(rowName);
		view.host.querySelector<HTMLElement>('.claude-submenu [data-effort="ultracode"]')!.click();
		await until(() => agent.getSessionSettings(session.id).ultracode === true);
		await settle();
		const ultracode = [view.host.isConnected, modelPill(pane).querySelector('.qualifier')?.textContent, modelPill(pane).getAttribute('aria-label')];

		modelPill(pane).click();
		await settle();
		view = contextViews.at(-1)!;
		const effortValue = view.host.querySelector('[data-setting="effort"] .value')?.textContent;
		view.host.querySelector<HTMLElement>('[data-setting="effort"]')!.click();
		await settle();
		const checked = view.host.querySelector('.claude-submenu [aria-checked="true"]')?.getAttribute('data-effort');
		view.host.querySelector<HTMLElement>('.claude-submenu [data-effort="max"]')!.click();
		await until(() => agent.getSessionSettings(session.id).effort === 'max');

		modelPill(pane).click();
		await settle();
		view = contextViews.at(-1)!;
		view.host.querySelector<HTMLElement>('[data-setting="context"]')!.click();
		await settle();
		const contexts = [...view.host.querySelectorAll('.claude-submenu .claude-menu-item')].map(row => [rowName(row), row.getAttribute('aria-checked')]);
		view.host.querySelectorAll<HTMLElement>('.claude-submenu .claude-menu-item')[1].click();
		await until(() => agent.getCurrentSession()?.modelId === 'fixture-opus[1m]');
		await settle();
		assert.deepStrictEqual({ sonnet, opus, afterFast, efforts, ultracode, effortValue, checked, contexts, settings: agent.getSessionSettings(session.id), pill: modelPill(pane).textContent }, {
			sonnet: [['Model', 'Fixture Sonnet', null]],
			opus: [['Fast', 'Faster, costs more', 'false'], ['Context', 'Standard', null], ['Effort', 'Medium', null], ['Thinking', 'Adaptive', 'true'], ['Model', 'Fixture Opus', null]],
			afterFast: [true, 'true'],
			efforts: ['Low', 'Medium', 'High', 'Extra High', 'Max', 'Ultracode'],
			ultracode: [false, 'Ultracode \u00b7 Fast', 'Model: Fixture Opus, Ultracode \u00b7 Fast'],
			effortValue: 'Ultracode',
			checked: 'ultracode',
			contexts: [['Standard', 'true'], ['1M Tokens', 'false']],
			settings: { effort: 'max', fastMode: true },
			pill: 'Fixture Opus (1M context)Max \u00b7 Fast',
		});
	});

	test('issue 319: the Fast and Thinking switches say in a hover what they change and when', async () => {
		const pane = openAgentPane();
		const session = agent.getCurrentSession()!;
		await agent.setNextModel(session.id, 'fixture-opus');
		await settle();
		modelPill(pane).click();
		await settle();
		const host = contextViews.at(-1)!.host;
		const hoverOf = (setting: string) => {
			const row = host.querySelector(`[data-setting="${setting}"]`);
			return hovers.find(hover => hover.target === row)?.options().content;
		};
		assert.deepStrictEqual({ fast: hoverOf('fast'), thinking: hoverOf('thinking'), effort: hoverOf('effort') }, {
			fast: 'Claude Code\'s fast mode: faster answers from this model, billed at a higher rate. Changes this agent from your next message. New agents start in fast mode when Fast Mode is on in Settings.',
			thinking: 'Adaptive thinking: Claude decides when to think before it answers. Turned off, Claude answers without thinking. Changes this agent from your next message.',
			effort: undefined,
		});
	});

	test('Phase 33: a long prompt in Agent mode offers Plan mode, and the hint switches to it', async () => {
		const pane = openAgentPane();
		const hint = pane.element.querySelector<HTMLButtonElement>('button.claude-plan-hint')!;
		const input = composer(pane);
		const type = (text: string) => {
			input.value = text;
			input.dispatchEvent(new Event('input', { bubbles: true }));
		};
		const states = [hint.hidden];
		type('fix the bug');
		states.push(hint.hidden);
		type('one\ntwo\nthree\nfour\nfive\nsix');
		states.push(hint.hidden);
		hint.click();
		await settle();
		states.push(hint.hidden);
		assert.deepStrictEqual({ states, mode: agent.getCurrentSession()?.mode, focus: document.activeElement === input, label: hint.getAttribute('aria-label') }, {
			states: [true, true, false, true],
			mode: 'plan',
			focus: true,
			label: 'Switch to Plan mode: Claude plans the change before it edits',
		});
	});

	test('the pill and the menu name a canonical model id by the row that resolves to it, once Claude Code lists models', async () => {
		runtime.models = [];
		runtime.nextFixture = 'canonical-model';
		const pane = openAgentPane();
		await send(pane, 'Hi');
		await until(() => modelPill(pane).textContent === 'claude-opus-5-5');
		const unnamed = modelPill(pane).textContent;
		runtime.models = [
			{ id: 'default', displayName: 'Default (recommended)', source: 'runtime', resolvedModel: 'claude-opus-5-5[1m]' },
			{ id: 'opus', displayName: 'Opus', source: 'runtime', resolvedModel: 'claude-opus-5-5' },
			{ id: 'sonnet', displayName: 'Sonnet', source: 'runtime', resolvedModel: 'claude-sonnet-5' },
		];
		modelPill(pane).click();
		await settle();
		const view = contextViews.at(-1)!;
		const model = menuRows(view.host).find(row => row[0] === 'Model');
		view.host.querySelector<HTMLElement>('[data-setting="model"]')!.click();
		await settle();
		const checked = [...view.host.querySelectorAll('.claude-submenu [aria-checked="true"]')].map(rowName);
		assert.deepStrictEqual({ unnamed, pill: modelPill(pane).textContent, model, checked }, {
			unnamed: 'claude-opus-5-5',
			pill: 'Opus 5.5',
			model: ['Model', 'Opus 5.5', null],
			checked: ['Opus 5.5'],
		});
	});

	test('older models Claude Code still runs follow its lineup under one header, one line each, and can be picked', async () => {
		runtime.models = [
			{ id: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5 for most tasks', source: 'runtime', resolvedModel: 'claude-opus-5-5[1m]' },
			{ id: 'opus', displayName: 'Opus', description: 'For complex work', source: 'runtime', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'max'] },
			{ id: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5', source: 'runtime', resolvedModel: 'claude-sonnet-4-5', older: true },
			{ id: 'claude-opus-4-6', displayName: 'Opus 4.6', source: 'runtime', resolvedModel: 'claude-opus-4-6', older: true },
		];
		const pane = openAgentPane();
		modelPill(pane).click();
		await settle();
		const view = contextViews.at(-1)!;
		view.host.querySelector<HTMLElement>('[data-setting="model"]')!.click();
		await settle();
		const body = view.host.querySelector('.claude-submenu > .claude-menu-body')!;
		const list = [...body.children].map(row =>
			row.classList.contains('claude-menu-group') ? row.textContent
				: row.classList.contains('claude-menu-separator') ? null
					: rowName(row));
		const twoLine = body.querySelectorAll('.desc').length;
		body.querySelector<HTMLElement>('[data-model-id="claude-opus-4-6"]')!.click();
		await until(() => modelPill(pane).textContent === 'Opus 4.6');
		assert.deepStrictEqual({ list, twoLine, pill: modelPill(pane).textContent }, {
			// Auto leads as a model entry and is the only row with a description line (#1579).
			list: ['Auto', null, 'Opus 5.5', 'Older Models', 'Opus 4.6', 'Sonnet 4.5', null, 'Compare Models...', 'Manage Models...'],
			twoLine: 1,
			pill: 'Opus 4.6',
		});
	});

	test('a new agent with no model picked names the model the runtime default resolves to, and the list has no Default row', async () => {
		runtime.models = [
			{ id: 'default', displayName: 'Default (recommended)', source: 'runtime', resolvedModel: 'claude-opus-5-5[1m]' },
			{ id: 'opus[1m]', displayName: 'Opus (1M context)', source: 'runtime', resolvedModel: 'claude-opus-5-5[1m]' },
			{ id: 'opus', displayName: 'Opus', source: 'runtime', resolvedModel: 'claude-opus-5-5' },
			{ id: 'sonnet', displayName: 'Sonnet', source: 'runtime', resolvedModel: 'claude-sonnet-5' },
		];
		const pane = openAgentPane();
		await until(() => modelPill(pane).textContent === 'Opus 5.5');
		modelPill(pane).click();
		await settle();
		const view = contextViews.at(-1)!;
		const rows = menuRows(view.host).filter(row => row[0] === 'Context' || row[0] === 'Model');
		view.host.querySelector<HTMLElement>('[data-setting="model"]')!.click();
		await settle();
		const list = [...view.host.querySelectorAll('.claude-submenu [data-model-id]')].map(rowName);
		const checked = [...view.host.querySelectorAll('.claude-submenu [aria-checked="true"]')].map(rowName);
		assert.deepStrictEqual({ pill: modelPill(pane).textContent, session: agent.getCurrentSession()?.modelId, rows, list, checked }, {
			pill: 'Opus 5.5',
			session: undefined,
			rows: [['Context', '1M', null], ['Model', 'Opus 5.5 (1M context)', null]],
			list: ['Opus 5.5', 'Sonnet 5'],
			checked: ['Opus 5.5'],
		});
	});

	test('#108, #95: a new agent names the default model and the effort it sends, Medium on a fresh install, then the level last picked', async () => {
		const levels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
		runtime.models = [
			{ id: 'default', displayName: 'Default (recommended)', source: 'runtime', resolvedModel: 'claude-opus-5-5', supportsEffort: true, supportedEffortLevels: levels },
			{ id: 'opus', displayName: 'Opus', source: 'runtime', resolvedModel: 'claude-opus-5-5', supportsEffort: true, supportedEffortLevels: levels },
			{ id: 'haiku', displayName: 'Haiku', source: 'runtime', resolvedModel: 'claude-haiku-5-5' },
		];
		const pane = openAgentPane();
		const pill = () => [modelPill(pane).querySelector('.label')?.textContent, modelPill(pane).querySelector('.qualifier')?.textContent, modelPill(pane).getAttribute('aria-label')];
		await until(() => modelPill(pane).textContent === 'Opus 5.5Medium');
		const fresh = pill();
		const session = agent.getCurrentSession()!;
		await agent.setNextSettings(session.id, { effort: 'high' });
		await until(() => modelPill(pane).querySelector('.qualifier')?.textContent === 'High');
		const picked = pill();
		const next = agent.createSession();
		await until(() => agent.getCurrentSession()?.id === next.id && modelPill(pane).textContent === 'Opus 5.5High');
		const nextAgent = pill();
		await agent.setNextModel(next.id, 'haiku');
		await until(() => modelPill(pane).querySelector('.label')?.textContent === 'Haiku 5.5');
		assert.deepStrictEqual({ fresh, picked, nextAgent, noEffort: pill() }, {
			fresh: ['Opus 5.5', 'Medium', 'Model: Opus 5.5, Medium'],
			picked: ['Opus 5.5', 'High', 'Model: Opus 5.5, High'],
			nextAgent: ['Opus 5.5', 'High', 'Model: Opus 5.5, High'],
			noEffort: ['Haiku 5.5', undefined, 'Model: Haiku 5.5'],
		});
	});

	test('a runtime that reports no default alias names and checks its first model on a new agent', async () => {
		runtime.models = [
			{ id: 'sonnet', displayName: 'Sonnet', source: 'runtime', resolvedModel: 'claude-sonnet-5' },
			{ id: 'opus', displayName: 'Opus', source: 'runtime', resolvedModel: 'claude-opus-5-5' },
		];
		const pane = openAgentPane();
		await until(() => modelPill(pane).textContent === 'Sonnet 5');
		modelPill(pane).click();
		await settle();
		const view = contextViews.at(-1)!;
		view.host.querySelector<HTMLElement>('[data-setting="model"]')!.click();
		await settle();
		const checked = [...view.host.querySelectorAll('.claude-submenu [aria-checked="true"]')].map(rowName);
		assert.deepStrictEqual({ pill: modelPill(pane).textContent, checked }, { pill: 'Sonnet 5', checked: ['Sonnet 5'] });
	});

	test('audit 9: the model menu closes on focus or a click outside it, and its row ids are unique', async () => {
		const pane = openAgentPane();
		const pill = modelPill(pane);
		const input = composer(pane);
		pill.click();
		await settle();
		const ids = [...contextViews.at(-1)!.host.querySelectorAll('.claude-menu-item[id]')].map(row => row.id);
		moveClaudeTestFocus(input);
		const afterFocus = [contextViews.at(-1)!.host.isConnected, pill.getAttribute('aria-expanded')];
		pill.click();
		await settle();
		const view = contextViews.at(-1)!;
		const again = [...view.host.querySelectorAll('.claude-menu-item[id]')].map(row => row.id);
		const forward = (event: Event) => view.delegate.onDOMEvent?.(event, document.activeElement as HTMLElement);
		document.addEventListener('click', forward, true);
		try {
			view.host.querySelector<HTMLElement>('.claude-menu-body')!.click();
			const insideClick = view.host.isConnected;
			input.click();
			assert.deepStrictEqual({
				afterFocus,
				insideClick,
				afterClick: [view.host.isConnected, pill.getAttribute('aria-expanded')],
				unique: new Set([...ids, ...again]).size === ids.length + again.length,
			}, { afterFocus: [false, 'false'], insideClick: true, afterClick: [false, 'false'], unique: true });
		} finally {
			document.removeEventListener('click', forward, true);
		}
	});

	/** Opens the agent pane with clicks forwarded to the open menu's context view, as the real one does. */
	async function withMenuClicks(run: (pane: ClaudeAgentViewPane, modePill: HTMLButtonElement) => Promise<void>): Promise<void> {
		const pane = openAgentPane();
		const modePill = pane.element.querySelector<HTMLButtonElement>('button.claude-pill[aria-haspopup="menu"]:not(.claude-model-pill)')!;
		const forward = (event: Event) => contextViews.at(-1)?.delegate.onDOMEvent?.(event, document.activeElement as HTMLElement);
		document.addEventListener('click', forward, true);
		try {
			await run(pane, modePill);
		} finally {
			document.removeEventListener('click', forward, true);
		}
	}

	test('a click on a menu part that is not a row keeps the mode and model menus open', async () => {
		// Untrusted, so the mode menu's permission level row says it is held back.
		instantiationService.stub(IWorkspaceTrustManagementService, store.add(new TestWorkspaceTrustManagementService(false)));
		await withMenuClicks(async (pane, modePill) => {
			const pressParts = async (pill: HTMLButtonElement, parts: string[]) => {
				press(pill);
				await settle();
				const view = contextViews.at(-1)!;
				return parts.map(part => {
					press(view.host.querySelector<HTMLElement>(part)!);
					return [part, view.host.isConnected && view.host.contains(document.activeElement)];
				});
			};
			const modeParts = ['.claude-menu-separator', '.claude-menu-footer kbd', '.claude-menu-group', '.claude-mode-menu'];
			const modelParts = ['.claude-menu-body', '.claude-menu-item .value', '.claude-model-menu'];
			assert.deepStrictEqual({
				mode: await pressParts(modePill, modeParts),
				model: await pressParts(modelPill(pane), modelParts),
			}, {
				mode: modeParts.map(part => [part, true]),
				model: modelParts.map(part => [part, true]),
			});
		});
	});

	test('a click on the mode or model pill while its menu is open closes the menu', async () => {
		await withMenuClicks(async (pane, modePill) => {
			const toggle = async (pill: HTMLButtonElement) => {
				press(pill);
				await settle();
				const view = contextViews.at(-1)!;
				const opened = [view.host.isConnected, pill.getAttribute('aria-expanded')];
				press(pill);
				await settle();
				return { opened, closed: [view.host.isConnected, contextViews.at(-1) === view, pill.getAttribute('aria-expanded')] };
			};
			const expected = { opened: [true, 'true'], closed: [false, true, 'false'] };
			assert.deepStrictEqual({ mode: await toggle(modePill), model: await toggle(modelPill(pane)) }, { mode: expected, model: expected });
		});
	});

	test('audit 11, 12: while running, Stop is a neutral square, Steer is labeled and steers, and attach moves to an overflow', async () => {
		runtime.hold = true;
		runtime.canSteer = async () => true;
		const steered: string[] = [];
		runtime.steer = async (_session, text) => { steered.push(text); return true; };
		const pane = openAgentPane();
		await send(pane, 'Look');
		const steer = pane.element.querySelector<HTMLButtonElement>('button.claude-steer')!;
		await until(() => !steer.hidden);
		const toolbarState = () => ({
			stop: sendButton(pane).querySelector('.codicon')?.classList.contains('codicon-primitive-square'),
			mention: toolbarButton(pane, 'Add context').hidden,
			attach: toolbarButton(pane, 'Attach image').hidden,
			overflow: toolbarButton(pane, 'More composer actions').hidden,
		});
		const running = toolbarState();
		toolbarButton(pane, 'More composer actions').click();
		const overflow = menus.at(-1)!.actions.map(action => action.label);
		const input = composer(pane);
		input.value = 'Use the helper';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		steer.click();
		await until(() => steered.length === 1);
		assert.deepStrictEqual({ running, steerText: steer.textContent?.startsWith('Steer'), steerMenu: steer.getAttribute('aria-haspopup'), overflow, steered: steered[0].includes('Use the helper') }, {
			running: { stop: true, mention: true, attach: true, overflow: false },
			steerText: true,
			steerMenu: null,
			overflow: ['Add Context', 'Attach Image', 'Show What Will Be Sent', 'Ask a Side Question', 'Run Parallel Agents'],
			steered: true,
		});
		runtime.release();
		await until(() => !sendButton(pane).classList.contains('is-stop'));
		assert.deepStrictEqual(toolbarState(), { stop: false, mention: false, attach: false, overflow: true });
	});

	test('with Steer picked for messages while Claude works, Enter steers, Ctrl+Enter queues, and the key chips swap', async () => {
		runtime.hold = true;
		runtime.canSteer = async () => true;
		const steered: string[] = [];
		runtime.steer = async (_session, text) => { steered.push(text); return true; };
		const pane = openAgentPane();
		await send(pane, 'Look');
		const steer = pane.element.querySelector<HTMLButtonElement>('button.claude-steer')!;
		const queue = pane.element.querySelector<HTMLButtonElement>('button.claude-queue-send')!;
		await until(() => !steer.hidden);
		// allow-any-unicode-next-line
		const buttons = () => [queue, steer].map(button => ({ enter: [...button.querySelectorAll('.claude-kbd kbd')].map(key => key.textContent).join() === '↵', ghost: button.classList.contains('is-ghost') }));
		const before = buttons();
		const configuration = instantiationService.get(IConfigurationService) as TestConfigurationService;
		await configuration.setUserConfiguration(CLAUDE_COMPOSER_WHILE_WORKING_SETTING, 'steer');
		configuration.onDidChangeConfigurationEmitter.fire({
			source: ConfigurationTarget.USER,
			affectedKeys: new Set([CLAUDE_COMPOSER_WHILE_WORKING_SETTING]),
			change: { keys: [CLAUDE_COMPOSER_WHILE_WORKING_SETTING], overrides: [] },
			affectsConfiguration: key => key === CLAUDE_COMPOSER_WHILE_WORKING_SETTING,
		});
		const after = buttons();
		const input = composer(pane);
		const type = (text: string, ctrlKey: boolean) => {
			input.value = text;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey, bubbles: true, cancelable: true }));
		};
		const placeholder = input.placeholder;
		type('Use the helper', false);
		await until(() => steered.length === 1);
		type('Then run the tests', true);
		await until(() => !!pane.element.querySelector('.claude-queue-item'));
		assert.deepStrictEqual({ before, after, placeholder, steered: steered.map(text => text.includes('Use the helper')), queued: pane.element.querySelector('.claude-queue-item')?.textContent?.includes('Then run the tests') }, {
			before: [{ enter: true, ghost: false }, { enter: false, ghost: true }],
			after: [{ enter: false, ghost: true }, { enter: true, ghost: false }],
			placeholder: 'Add a message for the running turn',
			steered: [true],
			queued: true,
		});
		await configuration.setUserConfiguration(CLAUDE_COMPOSER_WHILE_WORKING_SETTING, 'queue');
		runtime.release();
		await until(() => !sendButton(pane).classList.contains('is-stop'));
	});

	test('a narrow pane: the running toolbar with the Phase 27 Allow Everything badge never overflows, and the badge keeps its icon and label for screen readers', async () => {
		runtime.hold = true;
		runtime.canSteer = async () => true;
		const pane = openAgentPane(600);
		await send(pane, 'Look');
		const steer = pane.element.querySelector<HTMLButtonElement>('button.claude-steer')!;
		await until(() => !steer.hidden);
		agent.setSessionPermissions(agent.getCurrentSession()!.id, { allowAllCommands: false, allowEverything: true });
		await until(() => !!pane.element.querySelector('.claude-session-switch.is-everything'));
		const toolbar = pane.element.querySelector<HTMLElement>('.claude-composer-toolbar')!;
		const measure = async (width: number) => {
			pane.element.style.width = `${width}px`;
			pane.orthogonalSize = width;
			pane.layout(560);
			await settle();
			const bounds = toolbar.getBoundingClientRect();
			const badge = toolbar.querySelector<HTMLElement>('.claude-session-switch.is-everything')!;
			const shown = (element: Element | null) => !!element && getWindow(element).getComputedStyle(element).display !== 'none';
			return {
				overflows: toolbar.scrollWidth > toolbar.clientWidth,
				outside: [...toolbar.children].filter(child => !(child as HTMLElement).hidden && (child.getBoundingClientRect().right > bounds.right + 0.5 || child.getBoundingClientRect().left < bounds.left - 0.5)).map(child => child.className),
				badgeClipped: badge.getBoundingClientRect().right > badge.parentElement!.getBoundingClientRect().right + 0.5,
				badgeWords: shown(badge.querySelector('.label')),
				badgeAria: badge.getAttribute('aria-label'),
				steerKey: shown(steer.querySelector('.claude-kbd')),
				stop: sendButton(pane).getBoundingClientRect().width,
				rows: toolbar.getBoundingClientRect().height > 30,
			};
		};
		const aria = 'Allow Everything Except Credentials: every tool call runs without asking, but credential files still ask. Click to change the permission level in Settings.';
		assert.deepStrictEqual({ wide: await measure(760), medium: await measure(440), narrow: await measure(260) }, {
			wide: { overflows: false, outside: [], badgeClipped: false, badgeWords: true, badgeAria: aria, steerKey: true, stop: 24, rows: false },
			medium: { overflows: false, outside: [], badgeClipped: false, badgeWords: false, badgeAria: aria, steerKey: false, stop: 24, rows: false },
			narrow: { overflows: false, outside: [], badgeClipped: false, badgeWords: false, badgeAria: aria, steerKey: false, stop: 24, rows: true },
		});
		runtime.release();
		await until(() => !sendButton(pane).classList.contains('is-stop'));
	});

	test('issue 738: with Allow Everything and the plan hint, the badge keeps its icon first, the hint drops its words and key together, and the model name stays readable', async () => {
		const pane = openAgentPane(760);
		agent.setSessionPermissions(agent.getCurrentSession()!.id, { allowAllCommands: false, allowEverything: true });
		await until(() => !!pane.element.querySelector('.claude-session-switch.is-everything'));
		const input = composer(pane);
		input.value = 'one\ntwo\nthree\nfour\nfive\nsix';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const hint = pane.element.querySelector<HTMLButtonElement>('button.claude-plan-hint')!;
		await until(() => !hint.hidden);
		const toolbar = pane.element.querySelector<HTMLElement>('.claude-composer-toolbar')!;
		const shown = (element: Element | null) => !!element && getWindow(element).getComputedStyle(element).display !== 'none';
		const measure = async (width: number) => {
			pane.element.style.width = `${width}px`;
			pane.orthogonalSize = width;
			pane.layout(560);
			await settle();
			const badge = toolbar.querySelector<HTMLElement>('.claude-session-switch.is-everything')!;
			const controls = [...toolbar.children].filter(child => !(child as HTMLElement).hidden && shown(child) && child.getBoundingClientRect().width > 0).map(child => ({ name: child.className, box: child.getBoundingClientRect() }));
			const overlaps = controls.flatMap((a, i) => controls.slice(i + 1).filter(b => a.box.right > b.box.left + 0.5 && b.box.right > a.box.left + 0.5).map(b => `${a.name} / ${b.name}`));
			return {
				overlaps,
				badgeWords: shown(badge.querySelector('.label')),
				hintWords: shown(hint.querySelector('.label')),
				hintKey: shown(hint.querySelector('.claude-kbd')),
				// The hint is a fixed control: it never clips its icon or its key.
				hintClipped: hint.scrollWidth > hint.clientWidth + 0.5,
				modelReadable: modelPill(pane).getBoundingClientRect().width >= 80,
			};
		};
		assert.deepStrictEqual({ wide: await measure(760), medium: await measure(680), narrow: await measure(560) }, {
			wide: { overlaps: [], badgeWords: true, hintWords: true, hintKey: true, hintClipped: false, modelReadable: true },
			medium: { overlaps: [], badgeWords: false, hintWords: true, hintKey: true, hintClipped: false, modelReadable: true },
			narrow: { overlaps: [], badgeWords: false, hintWords: false, hintKey: false, hintClipped: false, modelReadable: true },
		});
	});

	test('issue 531: no toolbar control draws over another at any width, idle or with Queue and Steer, and Run In keeps its icon', async () => {
		const levels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
		runtime.models = [
			{ id: 'default', displayName: 'Default (recommended)', source: 'runtime', resolvedModel: 'claude-opus-5-5', supportsEffort: true, supportedEffortLevels: levels },
			{ id: 'opus', displayName: 'Opus', source: 'runtime', resolvedModel: 'claude-opus-5-5', supportsEffort: true, supportedEffortLevels: levels },
		];
		runtime.hold = true;
		runtime.canSteer = async () => true;
		const pane = openAgentPane(560);
		await until(() => modelPill(pane).textContent === 'Opus 5.5Medium');
		const toolbar = pane.element.querySelector<HTMLElement>('.claude-composer-toolbar')!;
		const style = (element: Element) => getWindow(element).getComputedStyle(element);
		// What a control paints: its own box when it clips, else its box and every descendant that spills out of it.
		const painted = (control: Element) => {
			const own = control.getBoundingClientRect();
			const parts = style(control).overflowX === 'hidden' ? [] : [...control.querySelectorAll('*')].map(part => part.getBoundingClientRect()).filter(box => box.width > 0);
			return parts.reduce((all, box) => ({ left: Math.min(all.left, box.left), right: Math.max(all.right, box.right), top: Math.min(all.top, box.top), bottom: Math.max(all.bottom, box.bottom) }), { left: own.left, right: own.right, top: own.top, bottom: own.bottom });
		};
		const measure = async (width: number) => {
			pane.element.style.width = `${width}px`;
			pane.orthogonalSize = width;
			pane.layout(560);
			await settle();
			const controls = [...toolbar.children].filter(child => !(child as HTMLElement).hidden && style(child).display !== 'none' && child.getBoundingClientRect().width > 0).map(child => ({ name: child.className, box: painted(child) }));
			const overlaps = controls.flatMap((a, i) => controls.slice(i + 1)
				.filter(b => a.box.right > b.box.left + 0.5 && b.box.right > a.box.left + 0.5 && a.box.bottom > b.box.top + 0.5 && b.box.bottom > a.box.top + 0.5)
				.map(b => `${a.name} / ${b.name}`));
			const runIn = toolbar.querySelector<HTMLElement>('.claude-run-in-pill')!;
			return { overlaps, runInIcon: style(runIn.firstElementChild!).display !== 'none', runInWord: style(runIn.querySelector('.label')!).display !== 'none' };
		};
		const idle = { wide: await measure(560), narrow: await measure(300) };
		await send(pane, 'Look');
		const steer = pane.element.querySelector<HTMLButtonElement>('button.claude-steer')!;
		await until(() => !steer.hidden);
		const running = { wide: await measure(760), medium: await measure(560), narrow: await measure(300) };
		assert.deepStrictEqual({ idle, running }, {
			idle: {
				wide: { overlaps: [], runInIcon: true, runInWord: true },
				narrow: { overlaps: [], runInIcon: true, runInWord: false },
			},
			running: {
				wide: { overlaps: [], runInIcon: true, runInWord: true },
				medium: { overlaps: [], runInIcon: true, runInWord: false },
				narrow: { overlaps: [], runInIcon: true, runInWord: false },
			},
		});
		runtime.release();
		await until(() => !sendButton(pane).classList.contains('is-stop'));
	});

	test('issue 531: Send shows its arrow when disabled and when enabled, even on a see-through input background', async () => {
		const pane = openAgentPane();
		// Klawly Dark's input background is 3% white; an arrow in that color vanished into the circle.
		pane.element.style.setProperty('--vscode-input-background', '#ffffff08');
		const style = (element: Element) => getWindow(element).getComputedStyle(element);
		const glyph = () => {
			const button = sendButton(pane);
			const icon = button.querySelector('.codicon');
			const color = icon ? style(icon).color : '';
			return {
				disabled: button.disabled,
				arrow: !!icon?.classList.contains('codicon-arrow-up') && style(icon).display !== 'none',
				opaque: /^rgb\(/.test(color),
				apart: color !== style(button).backgroundColor,
				buttonOpacity: style(button).opacity,
			};
		};
		const empty = glyph();
		const input = composer(pane);
		input.value = 'Look';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		assert.deepStrictEqual({ empty, typed: glyph() }, {
			empty: { disabled: true, arrow: true, opaque: true, apart: true, buttonOpacity: '1' },
			typed: { disabled: false, arrow: true, opaque: true, apart: true, buttonOpacity: '1' },
		});
	});

	test('audit 12, 30: the header keeps New, History and More; More holds the preview and the inspector; every button has a hover', async () => {
		const pane = openAgentPane();
		const buttons = [...pane.element.querySelectorAll<HTMLButtonElement>('.claude-pane-actions .claude-icon-btn')];
		headerButton(pane, 'More actions').click();
		const more = menus.at(-1)!.actions.filter(action => action.label).map(action => action.label);
		menus.at(-1)!.actions.find(action => action.label === 'Session Inspector')!.run();
		await settle();
		const iconButtons = [...pane.element.querySelectorAll<HTMLButtonElement>('button.claude-icon-btn:not([hidden])')];
		assert.deepStrictEqual({
			tabClose: iconButtons.some(button => !!button.closest('.claude-tab')),
			labels: buttons.map(button => button.getAttribute('aria-label')),
			more,
			inspector: !!pane.element.querySelector('.claude-inspector'),
			hovered: iconButtons.every(button => hovers.some(hover => hover.target === button && !!hover.options().content)),
			nativeTitles: iconButtons.filter(button => button.title).length,
		}, {
			tabClose: true,
			labels: ['New Agent', 'Agent History', 'Show Agents Sidebar', 'More actions'],
			more: ['Export Transcript...', 'Copy Chat as Markdown', 'Copy Session ID', 'Resume in Terminal', 'Share to Phone...', 'Show What Will Be Sent', 'Ask a Side Question', 'Go to Turn...', 'Session Inspector', 'Open Chat in Editor', 'Open Chat in New Window', 'Background Agents', 'Manage Models', 'Klawly Settings'],
			inspector: true,
			hovered: true,
			nativeTitles: 0,
		});
	});

	test('ai-12, ai-13, issue 102: the composer stays at the bottom with the empty state centered above it in a new chat; the first turn keeps focus', async () => {
		const pane = openAgentPane(289);
		pane.layout(800);
		const root = pane.element.querySelector<HTMLElement>('.claude-pane')!;
		const order = () => [...root.children].filter(child => child.matches('.claude-pane-footer, .claude-timeline-host')).map(child => child.className.split(' ')[0]);
		const toolbar = pane.element.querySelector<HTMLElement>('.claude-composer-toolbar')!;
		const emptyNode = pane.element.querySelector<HTMLElement>('.claude-empty')!;
		const empty = getWindow(emptyNode).getComputedStyle(emptyNode);
		const centered = parseFloat(empty.marginTop) > 0 && empty.marginTop === empty.marginBottom;
		const newChat = { order: order(), marked: root.classList.contains('is-new-chat'), oneRow: toolbar.getBoundingClientRect().height <= 30, centered };
		composer(pane).focus();
		await send(pane, 'Fix it');
		await until(() => !sendButton(pane).classList.contains('is-stop'));
		assert.deepStrictEqual({
			newChat,
			after: { order: order(), marked: root.classList.contains('is-new-chat'), focused: getActiveElement() === composer(pane) },
		}, {
			newChat: { order: ['claude-timeline-host', 'claude-pane-footer'], marked: true, oneRow: true, centered: true },
			after: { order: ['claude-timeline-host', 'claude-pane-footer'], marked: false, focused: true },
		});
	});

	test('More: the session items wait for a turn, Copy Session ID copies it, and Resume in Terminal types the command without running it', async () => {
		const typed: { cwd?: unknown; text: string; run: boolean | undefined }[] = [];
		instantiationService.stub(ITerminalService, {
			activeInstance: undefined,
			createTerminal: async (options: { cwd?: unknown }) => ({
				sendText: async (text: string, run?: boolean) => { typed.push({ cwd: options.cwd, text, run }); },
				focusWhenReady: async () => undefined,
			}),
		} as unknown as ITerminalService);
		const pane = openAgentPane();
		const moreButton = headerButton(pane, 'More actions');
		const enabled = () => {
			moreButton.click();
			const actions = menus.at(-1)!.actions;
			return Object.fromEntries(['Export Transcript...', 'Copy Session ID', 'Resume in Terminal'].map(label => [label, actions.find(action => action.label === label)!.enabled]));
		};
		const before = enabled();
		await send(pane, 'Fix it');
		await until(() => !sendButton(pane).classList.contains('is-stop'));
		const id = agent.getCurrentSession()!.claudeSessionId!;
		const after = enabled();
		const actions = menus.at(-1)!.actions;
		await actions.find(action => action.label === 'Copy Session ID')!.run();
		await actions.find(action => action.label === 'Resume in Terminal')!.run();
		await actions.find(action => action.label === 'Klawly Settings')!.run();
		await settle();
		assert.deepStrictEqual({
			before,
			after,
			copied: await instantiationService.get(IClipboardService).readText() === id,
			typed: typed.map(entry => ({ ...entry, cwd: !!entry.cwd })),
			settings: commands.at(-1),
		}, {
			before: { 'Export Transcript...': false, 'Copy Session ID': false, 'Resume in Terminal': false },
			after: { 'Export Transcript...': true, 'Copy Session ID': true, 'Resume in Terminal': true },
			copied: true,
			typed: [{ cwd: true, text: `claude --resume ${id}`, run: false }],
			settings: 'claude.openSettings',
		});
	});

	test('audit 13, #82: tabs are patched in place, the active one is marked, and cut-off tabs scroll with the wheel', async () => {
		const pane = openAgentPane(220);
		const first = agent.getCurrentSession()!;
		const tabBefore = tab(pane, first.id);
		for (let i = 0; i < 5; i++) {
			agent.createSession();
		}
		await agent.renameSession(first.id, 'Renamed first');
		await settle();
		const strip = pane.element.querySelector<HTMLElement>('.claude-tabs')!;
		const before = strip.scrollLeft;
		strip.dispatchEvent(new WheelEvent('wheel', { deltaY: -4000, cancelable: true }));
		const state = {
			same: tab(pane, first.id) === tabBefore,
			title: tabBefore.querySelector('.label')?.textContent,
			active: [...pane.element.querySelectorAll('.claude-tab.is-active')].map(element => element.getAttribute('data-session-id')),
			more: !!pane.element.querySelector('.claude-tabs-more'),
			startedAtEnd: before > 0,
			scrolledBack: strip.scrollLeft === 0,
			fades: [strip.classList.contains('is-clipped-start'), strip.classList.contains('is-clipped-end')],
		};
		assert.deepStrictEqual(state, { same: true, title: 'Renamed first', active: [agent.getCurrentSession()?.id], more: false, startedAtEnd: true, scrolledBack: true, fades: [false, true] });
	});

	test('audit 13: a title that grows keeps the active tab in view instead of under N more', async () => {
		const pane = openAgentPane(480);
		for (let i = 0; i < 6; i++) {
			agent.createSession();
		}
		await settle();
		const current = agent.getCurrentSession()!;
		await agent.renameSession(current.id, 'A much longer title for the active agent session');
		await settle();
		const strip = pane.element.querySelector<HTMLElement>('.claude-tabs')!.getBoundingClientRect();
		const active = tab(pane, current.id).getBoundingClientRect();
		assert.deepStrictEqual([active.width < strip.width, active.left >= strip.left - 1, active.right <= strip.right + 1], [true, true, true]);
	});

	test('audit 18: a subagent opens on one header line, Stop only while it runs, and a read-only hint replaces the composer', async () => {
		runtime.nextFixture = 'subagent';
		const pane = openAgentPane();
		await send(pane, 'Investigate');
		await until(() => !!pane.element.querySelector('.claude-subagent-open'));
		pane.element.querySelector<HTMLButtonElement>('.claude-subagent-open')!.click();
		await settle();
		const header = pane.element.querySelector('.claude-pane-header')!;
		const crumb = () => header.querySelector('.claude-breadcrumb');
		const hint = pane.element.querySelector<HTMLElement>('.claude-readonly-hint')!;
		const running = {
			text: [...crumb()!.children].map(child => child.textContent),
			tabsHidden: header.querySelector<HTMLElement>('.claude-tabs')!.hidden,
			hint: !hint.hidden && !!hint.textContent?.includes('read only'),
		};
		runtime.release();
		await until(() => !crumb()?.textContent?.includes('Stop'));
		const done = [...crumb()!.querySelectorAll('button')].map(button => button.textContent);
		crumb()!.querySelector<HTMLButtonElement>('.claude-subagent-back')!.click();
		await settle();
		assert.deepStrictEqual({ running, done, back: [crumb(), hint.hidden, header.querySelector<HTMLElement>('.claude-tabs')!.hidden] }, {
			running: { text: ['Agent', '/', 'Subagent (Explore): Find callers', 'Stop'], tabsHidden: true, hint: true },
			done: ['Agent', 'Continue in new chat'],
			back: [null, true, false],
		});
	});

	test('audit 19: a chip hover goes through the hover service with the resolved source, and the composer has no inline card', async () => {
		const pane = openAgentPane();
		const session = agent.getCurrentSession()!;
		agent.setAttachments(session.id, [{ kind: 'selection', uri: URI.joinPath(TestWorkspace.folders[0].uri, 'src', 'app.ts').toString(), range: { startLine: 1, startColumn: 1, endLine: 3, endColumn: 1 }, versionId: 1 }]);
		await settle();
		const chip = pane.element.querySelector<HTMLElement>('.claude-chip:not(.is-add)')!;
		const hover = hovers.find(entry => entry.target === chip)!;
		const content = hover.options().content as HTMLElement;
		await settle();
		assert.deepStrictEqual({
			inline: pane.element.querySelector('.claude-composer .claude-hovercard'),
			title: content.querySelector('.claude-hover-title')?.textContent,
			detail: content.querySelector('.claude-hover-detail')?.textContent?.includes('src/app.ts'),
			classes: hover.options().additionalClasses,
		}, { inline: null, title: 'app.ts', detail: true, classes: ['claude-root'] });
	});

	test('audit 20: to-dos sit above the composer and the context ring shows only real numbers', async () => {
		runtime.hold = true;
		runtime.nextFixture = 'meta';
		const pane = openAgentPane();
		const ring = pane.element.querySelector<HTMLElement>('.claude-context-ring')!;
		const strip = pane.element.querySelector<HTMLElement>('.claude-todo-strip')!;
		const before = { ring: ring.hidden, strip: strip.hidden };
		await send(pane, 'Fix it');
		await until(() => !strip.hidden && !ring.hidden);
		const head = strip.querySelector<HTMLButtonElement>('.claude-todo-strip-head')!;
		head.click();
		assert.deepStrictEqual({
			before,
			above: strip.compareDocumentPosition(pane.element.querySelector('.claude-composer')!) === Node.DOCUMENT_POSITION_FOLLOWING,
			head: [head.querySelector('.count')?.textContent, head.querySelector('.current')?.textContent, head.getAttribute('aria-expanded')],
			items: [...strip.querySelectorAll('.claude-todo')].map(item => item.className),
			ring: ring.getAttribute('aria-label'),
		}, {
			before: { ring: true, strip: true },
			above: true,
			head: ['1/3', 'Add the routes', 'true'],
			items: ['claude-todo is-done', 'claude-todo is-active', 'claude-todo is-pending'],
			ring: `Context: 60% used (${(120000).toLocaleString()} of ${(200000).toLocaleString()} tokens)`,
		});
		const first = agent.getCurrentSession()!.id;
		agent.createSession();
		agent.selectSession(first);
		await settle();
		assert.deepStrictEqual([strip.hidden, head.getAttribute('aria-expanded'), strip.querySelector<HTMLElement>('.claude-todo-strip-list')?.hidden], [false, 'false', true]);
	});

	test('issue 93: the context ring is a button that opens the breakdown and sends /compact', async () => {
		runtime.hold = true;
		runtime.nextFixture = 'meta';
		runtime.breakdown = {
			usedTokens: 120000,
			windowTokens: 200000,
			categories: [
				{ name: 'Messages', tokens: 110000, kind: 'used' },
				{ name: 'Free space', tokens: 80000, kind: 'free' },
			],
		};
		const pane = openAgentPane();
		const ring = pane.element.querySelector<HTMLButtonElement>('.claude-context-ring')!;
		await send(pane, 'Fix it');
		await until(() => !ring.hidden);
		ring.click();
		await until(() => !!contextViews.at(-1)?.host.querySelector('.claude-context-menu'));
		const menu = contextViews.at(-1)!.host;
		const rows = () => [...menu.querySelectorAll<HTMLButtonElement>('.claude-menu-item')];
		const name = (row: HTMLElement) => (row.querySelector('.label .text') ?? row.querySelector('.label'))?.textContent;
		const running = rows().map(row => [name(row), row.getAttribute('aria-disabled')]);
		const opened = {
			button: [ring.tagName, ring.type, ring.getAttribute('role'), ring.getAttribute('aria-haspopup'), ring.getAttribute('aria-expanded')],
			header: menu.querySelector('.claude-menu-group')?.textContent,
			details: rows().map(row => row.querySelector('.detail')?.textContent ?? null),
			running,
		};
		ring.click();
		await settle();
		const closed = ring.getAttribute('aria-expanded');
		runtime.release();
		await settle();
		// The closed menu keeps its rows in its detached host: wait for a new view.
		const shown = contextViews.length;
		ring.click();
		await until(() => contextViews.length > shown && !!contextViews.at(-1)!.host.querySelector('.claude-context-menu'));
		[...contextViews.at(-1)!.host.querySelectorAll<HTMLButtonElement>('.claude-menu-item')].find(row => name(row) === 'Compact Conversation')!.click();
		await until(() => runtime.prompts.some(prompt => prompt.includes('/compact')));
		assert.deepStrictEqual({ opened, closed, draft: composer(pane).value }, {
			opened: {
				button: ['BUTTON', 'button', null, 'menu', 'true'],
				header: `Context: 60% used (${(120000).toLocaleString()} of ${(200000).toLocaleString()} tokens)`,
				details: [`${(110000).toLocaleString()} tokens (${(55).toLocaleString()}%)`, `${(80000).toLocaleString()} tokens (${(40).toLocaleString()}%)`, null, null],
				running: [['Messages', 'true'], ['Free space', 'true'], ['Compact Conversation', 'true'], ['Show Full Context', 'true']],
			},
			closed: 'false',
			draft: '',
		});
	});

	test('audit 9, 20: the model, the ring and the to-dos survive a turn longer than the event log keeps', async () => {
		runtime.hold = true;
		runtime.nextFixture = 'meta';
		const pane = openAgentPane();
		const strip = pane.element.querySelector<HTMLElement>('.claude-todo-strip')!;
		const ring = pane.element.querySelector<HTMLElement>('.claude-context-ring')!;
		await send(pane, 'Fix it');
		await until(() => !strip.hidden && !ring.hidden && modelPill(pane).textContent === 'Fixture Opus');
		for (let i = 0; i < CLAUDE_EVENT_LOG_CAP + 100; i++) {
			runtime.stream('x');
		}
		await settle();
		const events = agent.getSessionEvents(agent.getCurrentSession()!.id);
		assert.deepStrictEqual({
			rolled: events.length === CLAUDE_EVENT_LOG_CAP && events.every(event => event.type === 'assistant.delta'),
			model: modelPill(pane).textContent,
			ring: ring.hidden,
			todos: [strip.hidden, strip.querySelector('.claude-todo-strip-head .count')?.textContent],
		}, { rolled: true, model: 'Fixture Opus', ring: false, todos: [false, '1/3'] });
		runtime.release();
		await settle();
	});

	test('audit 9, 20: a saved session that ends in session.completed shows its model, ring and to-dos when it loads', async () => {
		const disk = new MemorySessionStorage();
		const sessions = new JsonlSessionStore('/data', disk);
		await sessions.upsertIndex({ id: 'saved-1', workspaceId: URI.file('/work/project').toString(), title: 'Saved work', updatedAt: 1, mode: 'agent', firstUser: 'Fix it', open: true });
		const saved: AgentReducerEvent[] = [
			{ type: 'turn.submitted', turnId: 'turn-1', text: 'Fix it' },
			{ type: 'session.started', sessionId: 'runtime', model: 'fixture-opus' },
			{ type: 'todo.changed', sessionId: 'runtime', items: [{ id: 'a', content: 'Find the loop', status: 'completed' }, { id: 'b', content: 'Add the routes', status: 'pending' }] },
			{ type: 'usage.changed', sessionId: 'runtime', usage: { inputTokens: 12, outputTokens: 3, contextTokens: 120000, contextWindow: 200000 } },
			{ type: 'assistant.completed', sessionId: 'runtime', text: 'Done.' },
			{ type: 'session.completed', sessionId: 'runtime' },
		];
		for (const event of saved) {
			await sessions.append('saved-1', event);
		}
		const loaded = store.add(new ClaudeAgentService(runtime, { _serviceBrand: undefined, getChannel: () => undefined, showChannel: async () => undefined } as unknown as IOutputService, ...agentWorkspaceStubs()));
		loaded.attachDurableHistory(sessions);
		instantiationService.stub(IClaudeAgentService, loaded);
		// The saved session is current before its events load; loading it then fires no session change.
		await loaded.loadDurableHistory();
		const pane = openAgentPane();
		await settle();
		await loaded.exportSession('saved-1', 'markdown');
		await settle();
		const strip = pane.element.querySelector<HTMLElement>('.claude-todo-strip')!;
		const ring = pane.element.querySelector<HTMLElement>('.claude-context-ring')!;
		assert.deepStrictEqual({
			current: loaded.getCurrentSession()?.id,
			last: loaded.getSessionEvents('saved-1').at(-1)?.type,
			model: modelPill(pane).textContent,
			ring: ring.getAttribute('aria-label'),
			todos: [strip.hidden, strip.querySelector('.claude-todo-strip-head .count')?.textContent],
		}, {
			current: 'saved-1',
			last: 'session.completed',
			model: 'Fixture Opus',
			ring: `Context: 60% used (${(120000).toLocaleString()} of ${(200000).toLocaleString()} tokens)`,
			todos: [false, '1/2'],
		});
	});

	test('audit 21: the runtime hint follows setup from Checking to Ready with the version', async () => {
		const setup = store.add(new TestClaudeSetupService(undefined));
		instantiationService.stub(IClaudeSetupService, setup);
		const pane = openAgentPane();
		await settle();
		const hint = pane.element.querySelector<HTMLElement>('.claude-composer-hint')!;
		const checking = hint.textContent;
		setup.set({ installed: true, authenticated: true, version: '2.1.0' });
		await settle();
		assert.deepStrictEqual([hint.hidden, checking?.includes('Claude Code · Checking...'), hint.textContent?.includes('Claude Code 2.1.0 · Ready')], [false, true, true]);
	});

	test('audit 19: a chip hover opened by keyboard focus closes when focus leaves the chip', async () => {
		const pane = openAgentPane();
		const session = agent.getCurrentSession()!;
		agent.setAttachments(session.id, [{ kind: 'selection', uri: URI.joinPath(TestWorkspace.folders[0].uri, 'src', 'app.ts').toString(), range: { startLine: 1, startColumn: 1, endLine: 3, endColumn: 1 }, versionId: 1 }]);
		await settle();
		const chip = pane.element.querySelector<HTMLElement>('.claude-chip:not(.is-add)')!;
		moveClaudeTestFocus(chip);
		const focused = focusHovers.map(entry => [entry.target === chip, entry.open]);
		moveClaudeTestFocus(composer(pane));
		assert.deepStrictEqual({ focused, after: focusHovers.map(entry => [entry.target === chip, entry.open]) }, { focused: [[true, true]], after: [[true, false]] });
	});

	test('audit 13: streamed frames leave the tab strip alone, so a user scrolling it is not pulled back', async () => {
		runtime.hold = true;
		const pane = openAgentPane(200);
		const first = agent.getCurrentSession()!;
		for (let i = 0; i < 5; i++) {
			agent.createSession();
		}
		agent.selectSession(first.id);
		await settle();
		await send(pane, 'Long answer');
		const strip = pane.element.querySelector<HTMLElement>('.claude-tabs')!;
		strip.scrollLeft = strip.scrollWidth;
		const scrolled = strip.scrollLeft;
		runtime.stream('more text');
		await settle();
		runtime.stream('and more');
		await settle();
		assert.deepStrictEqual({ scrolled: scrolled > 0, kept: strip.scrollLeft }, { scrolled: true, kept: scrolled });
		runtime.release();
		await settle();
	});

	test('issue 147: an idle tab is just its title; a running tab shows a spinner', async () => {
		runtime.hold = true;
		const pane = openAgentPane();
		const session = agent.getCurrentSession()!;
		await settle();
		const icon = () => tab(pane, session.id).firstElementChild as HTMLElement;
		const idle = [icon().hidden, icon().className, tab(pane, session.id).textContent];
		await send(pane, 'Look');
		// The send button flips at once; the tabs repaint with the timeline on the next frame.
		await until(() => sendButton(pane).classList.contains('is-stop'));
		await settle();
		const running = [icon().hidden, icon().classList.contains('codicon-loading')];
		runtime.release();
		await until(() => !sendButton(pane).classList.contains('is-stop'));
		await settle();
		assert.deepStrictEqual({ idle, running, done: icon().hidden }, { idle: [true, '', 'New Agent'], running: [false, true], done: true });
	});

	test('audit 21, issue 147: the empty state lists shortcuts and recent sessions with their state and age, with the runtime hint under the composer', async () => {
		const pane = openAgentPane();
		const old = agent.getCurrentSession()!;
		await send(pane, 'Earlier work');
		await until(() => !sendButton(pane).classList.contains('is-stop'));
		agent.createSession();
		await settle();
		const empty = pane.element.querySelector('.claude-empty')!;
		const hint = pane.element.querySelector<HTMLElement>('.claude-composer-hint')!;
		const state = {
			shortcuts: [...empty.querySelectorAll('.claude-shortcuts dt')].map(item => item.textContent).includes('Plan Mode'),
			recent: [...empty.querySelectorAll('.claude-recent .claude-session-row')].map(row => [row.getAttribute('data-session-id'), row.querySelector('.icon')?.classList.contains('codicon-check'), row.querySelector('.sub')?.textContent]),
			hint: [hint.hidden, hint.textContent?.includes('Claude Code test · Ready')],
		};
		empty.querySelector<HTMLButtonElement>('.claude-recent .claude-session-row')!.click();
		await settle();
		assert.deepStrictEqual({ state, current: agent.getCurrentSession()?.id, hintHidden: hint.hidden }, {
			state: { shortcuts: true, recent: [[old.id, true, 'now']], hint: [false, true] },
			current: old.id,
			hintHidden: true,
		});
	});

	test('audit 21, 33: Add context inserts @, and accepting an @ file leaves no double space', async () => {
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Explain';
		input.selectionStart = input.selectionEnd = input.value.length;
		toolbarButton(pane, 'Add context').click();
		const added = input.value;
		input.value = 'Explain @app and why';
		input.selectionStart = input.selectionEnd = 'Explain @app'.length;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await until(() => !!contextViews.at(-1)?.host.querySelector('.claude-menu-item'));
		const first = contextViews.at(-1)!.host.querySelector('.claude-menu-item')!;
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		await settle();
		assert.deepStrictEqual({ added, value: input.value, chip: !!first }, { added: 'Explain @', value: 'Explain and why', chip: true });
	});

	test('#107: no chip row until context is attached, and the input is three lines for a new chat, one for a follow-up, and measured again when shown', async () => {
		// Wide enough that the placeholder stays on one line.
		const pane = openAgentPane(620);
		const input = composer(pane);
		const chips = pane.element.querySelector<HTMLElement>('.claude-chips')!;
		await settle();
		const newChat = { chips: chips.hidden, height: input.offsetHeight };
		const session = agent.getCurrentSession()!;
		agent.setAttachments(session.id, [{ kind: 'file', uri: URI.file('C:\\testWorkspace\\src\\app.ts').toString() }]);
		await settle();
		const attached = { chips: chips.hidden, count: chips.querySelectorAll('.claude-chip').length };
		agent.setAttachments(session.id, []);
		await settle();
		await send(pane, 'Fix it');
		await until(() => !sendButton(pane).classList.contains('is-stop'));
		await settle();
		const followUp = input.offsetHeight;
		// Typed while hidden, the input is measured once it is shown again.
		pane.element.style.display = 'none';
		await settle();
		input.value = 'one\ntwo';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		pane.element.style.display = '';
		await until(() => input.offsetHeight > followUp);
		assert.deepStrictEqual({ newChat, attached, followUp, shown: input.offsetHeight, rows: input.rows }, {
			newChat: { chips: true, height: 66 },
			attached: { chips: false, count: 1 },
			followUp: 22,
			shown: 44,
			rows: 1,
		});
	});

	test('audit 34: @ menu files show the folder relative to the workspace', async () => {
		const host = document.createElement('div');
		const picker = new ClaudeContextPicker(
			{ showContextView: (delegate: IContextViewDelegate) => { const rendered = delegate.render(host); return { close: () => rendered.dispose() }; } } as unknown as IContextViewService,
			{ resolve: async () => ({ children: [] }) } as unknown as IFileService,
			{ fileSearch: async () => ({ results: [{ resource: URI.joinPath(TestWorkspace.folders[0].uri, 'src', 'auth', 'middleware.ts') }], messages: [] }) } as unknown as ISearchService,
			{ getWorkspace: () => TestWorkspace } as unknown as IWorkspaceContextService,
			{ getEditors: () => [], activeTextEditorControl: undefined } as unknown as IEditorService,
			{ getHistory: () => [] } as unknown as IHistoryService,
			{ getOrCreate: async () => { throw new Error('no outline'); } } as unknown as IOutlineModelService,
			{ read: () => [] } as unknown as IMarkerService,
			{ repositories: [] } as unknown as ISCMService,
			{ activeInstance: undefined } as unknown as ITerminalService,
			agent,
			new TestConfigurationService(),
		);
		picker.show(document.createElement('textarea'), 'at', 'middle');
		await until(() => host.textContent?.includes('middleware.ts') ?? false);
		const row = [...host.querySelectorAll('.claude-menu-item')].find(item => item.textContent?.includes('middleware.ts'))!;
		assert.strictEqual(row.querySelector('.detail')?.textContent, 'src/auth');
		picker.dispose();
	});

	test('issue 145: @ menu context rows put what they add on a second line and show counts only above 0', async () => {
		const host = document.createElement('div');
		const picker = new ClaudeContextPicker(
			{ showContextView: (delegate: IContextViewDelegate) => { const rendered = delegate.render(host); return { close: () => rendered.dispose() }; } } as unknown as IContextViewService,
			{ resolve: async () => ({ children: [] }) } as unknown as IFileService,
			{ fileSearch: async () => ({ results: [], messages: [] }) } as unknown as ISearchService,
			{ getWorkspace: () => TestWorkspace } as unknown as IWorkspaceContextService,
			{ getEditors: () => [], activeTextEditorControl: undefined } as unknown as IEditorService,
			{ getHistory: () => [] } as unknown as IHistoryService,
			{ getOrCreate: async () => { throw new Error('no outline'); } } as unknown as IOutlineModelService,
			{ read: () => [{ message: 'unused' }] } as unknown as IMarkerService,
			{ repositories: [] } as unknown as ISCMService,
			{ activeInstance: undefined } as unknown as ITerminalService,
			agent,
			new TestConfigurationService(),
		);
		picker.show(document.createElement('textarea'), 'at', '');
		await until(() => host.textContent?.includes('Problems') ?? false);
		const rows = [...host.querySelectorAll('.claude-menu-item')]
			.filter(row => ['Git changes', 'Staged changes', 'Problems'].some(label => row.textContent?.startsWith(label)))
			.map(row => ({ desc: row.querySelector('.desc')?.textContent, detail: row.querySelector('.detail')?.textContent }));
		assert.deepStrictEqual(rows, [
			{ desc: 'staged, working tree, untracked', detail: undefined },
			{ desc: undefined, detail: undefined },
			{ desc: undefined, detail: '1' },
		]);
		picker.dispose();
	});

	test('ai-08: in the narrow @ menu a long grey detail gives way and the label keeps its full width', async () => {
		// Context rows carry their description on a second line (issue 145): the grey detail here is a deep file folder.
		const deep = URI.joinPath(TestWorkspace.folders[0].uri, 'packages', 'checkout-service', 'src', 'integration', 'payments', 'app.ts');
		instantiationService.stub(ISearchService, { fileSearch: async () => ({ results: [{ resource: deep }], messages: [] }) } as unknown as ISearchService);
		const pane = openAgentPane(289);
		const input = composer(pane);
		input.value = '@app';
		input.selectionStart = input.selectionEnd = input.value.length;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await until(() => [...contextViews.at(-1)?.host.querySelectorAll('.claude-menu-item .detail') ?? []].some(detail => detail.textContent));
		// Narrower than the menu so the row overflows whatever font the test browser uses.
		contextViews.at(-1)!.host.querySelector<HTMLElement>('.claude-mention-menu')!.style.width = '180px';
		const rows = [...contextViews.at(-1)!.host.querySelectorAll<HTMLElement>('.claude-menu-item')].filter(row => row.querySelector('.detail')?.textContent);
		// An ellipsis replaces whole letters even when the label is a fraction of a pixel short, so compare
		// the laid-out width with the label's natural width rather than the rounded scrollWidth.
		const clipped = rows.map(row => row.querySelector<HTMLElement>('.label')!).filter(label => {
			const width = label.getBoundingClientRect().width;
			label.style.flex = 'none';
			const natural = label.getBoundingClientRect().width;
			label.style.flex = '';
			return natural - width > 0.01;
		}).map(label => label.textContent);
		const overflowing = rows.some(row => row.querySelector<HTMLElement>('.detail')!.scrollWidth > row.querySelector<HTMLElement>('.detail')!.clientWidth);
		assert.deepStrictEqual({ overflowing, clipped }, { overflowing: true, clipped: [] });
	});

	function openAgentPane(width = 360): ClaudeAgentViewPane {
		const pane = store.add(instantiationService.createInstance(ClaudeAgentViewPane, { id: CLAUDE_AGENT_VIEW_ID, title: 'Agent' }));
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		store.add(toDisposable(() => parent.remove()));
		pane.render();
		parent.appendChild(pane.element);
		pane.orthogonalSize = width;
		pane.layout(560);
		return pane;
	}

	async function send(pane: ClaudeAgentViewPane, text: string): Promise<void> {
		const input = composer(pane);
		input.value = text;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await settle();
	}

	/** The history popover while it is open. */
	function historyMenu(): HTMLElement | undefined {
		return contextViews.map(view => view.host.querySelector<HTMLElement>('.claude-history-menu')).find(menu => !!menu?.isConnected) ?? undefined;
	}

	function historyRow(sessionId: string): HTMLButtonElement | undefined {
		return historyMenu()?.querySelector<HTMLButtonElement>(`button.claude-menu-item[data-session-id="${sessionId}"]`) ?? undefined;
	}

	async function until(check: () => boolean): Promise<void> {
		for (let i = 0; i < 60; i++) {
			if (check()) {
				return;
			}
			await settle();
		}
		assert.fail('timed out');
	}
});

class ChromeRuntime extends FakeClaudeRuntimeService {
	hold = false;
	nextFixture: string | undefined;
	/** Replaces the fixture catalog when set. */
	models: readonly ClaudeModelInfo[] | undefined;
	private _release: (() => void) | undefined;
	private _held: string | undefined;

	override async begin(request: BeginClaudeRequest): Promise<ClaudeRunHandle> {
		const fixture = this.nextFixture ?? (this.hold ? 'held' : request.fixture);
		this.nextFixture = undefined;
		this.prompts.push(request.prompt);
		const handle = await super.begin({ ...request, fixture });
		if (this.hold || fixture === 'subagent') {
			this._held = handle.sessionId;
			this._release = () => this.emitEvent({ type: 'session.completed', sessionId: handle.sessionId });
		}
		return handle;
	}

	override async listModels(): Promise<readonly ClaudeModelInfo[]> {
		return this.models ?? super.listModels();
	}

	/** A turn runs on, and checks its effort against, the replaced catalog; an empty one (Claude Code lists no models yet) keeps the fixture models. */
	protected override catalog(): readonly ClaudeModelInfo[] {
		return this.models?.length ? this.models : super.catalog();
	}

	/** What `getContextBreakdown` reports. */
	breakdown: ClaudeContextBreakdown | undefined;
	/** Every turn's text, in order. */
	readonly prompts: string[] = [];

	async getContextBreakdown(): Promise<ClaudeContextBreakdown | undefined> {
		return this.breakdown;
	}

	override async send(sessionId: string, input: ClaudeUserInput): Promise<void> {
		this.prompts.push(input.text);
		return super.send(sessionId, input);
	}

	/** Streams text into the held turn, which changes the view state without touching the queue. */
	stream(text: string): void {
		if (this._held) {
			this.emitEvent({ type: 'assistant.delta', sessionId: this._held, text });
		}
	}

	release(): void {
		const release = this._release;
		this._release = undefined;
		release?.();
	}
}

function chromeFixtures(): Map<string, string> {
	const event = (value: unknown) => JSON.stringify(value);
	return new Map([
		['canonical-model', [
			event({ type: 'session.started', sessionId: '$session', model: 'claude-opus-5-5' }),
			event({ type: 'assistant.completed', sessionId: '$session', text: 'Done.' }),
			event({ type: 'session.completed', sessionId: '$session' }),
		].join('\n')],
		['plain-answer', [
			event({ type: 'session.started', sessionId: '$session', model: 'fixture-opus' }),
			event({ type: 'assistant.completed', sessionId: '$session', text: 'Done.' }),
			event({ type: 'session.completed', sessionId: '$session' }),
		].join('\n')],
		['held', [
			event({ type: 'session.started', sessionId: '$session', model: 'fixture-opus' }),
			event({ type: 'tool.started', sessionId: '$session', call: { id: 'read-1', name: 'Read', category: 'read', input: {}, display: { label: 'Read', file: 'src/x.ts' } } }),
		].join('\n')],
		['meta', [
			event({ type: 'session.started', sessionId: '$session', model: 'fixture-opus' }),
			event({ type: 'todo.changed', sessionId: '$session', items: [{ id: 'a', content: 'Find the loop', status: 'completed' }, { id: 'b', content: 'Add the routes', status: 'in_progress' }, { id: 'c', content: 'Run the tests', status: 'pending' }] }),
			event({ type: 'usage.changed', sessionId: '$session', usage: { inputTokens: 12, outputTokens: 3, contextTokens: 120000, contextWindow: 200000 } }),
		].join('\n')],
		['subagent', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({ type: 'subagent.started', sessionId: '$session', run: { id: 'run-a', agentType: 'Explore', description: 'Find callers', background: false, state: 'running', startedAt: 1, toolCallCount: 0 } }),
		].join('\n')],
	]);
}

/**
 * A mouse press as the browser runs it: focus moves to the nearest ancestor that can
 * take focus, or leaves to the body when none can, then the click fires. A synthetic
 * click skips the focus step, which is what closes a menu on focus loss.
 */
function press(target: HTMLElement): void {
	let node: HTMLElement | null = target;
	while (node && node !== document.body) {
		node.focus();
		if (document.activeElement === node) {
			break;
		}
		node = node.parentElement;
	}
	if (!node || node === document.body) {
		(document.activeElement as HTMLElement | null)?.blur();
	}
	target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function settle(): Promise<void> {
	return new Promise(resolve => setTimeout(() => getWindow(document.body).requestAnimationFrame(() => resolve()), 0));
}

function composer(pane: ClaudeAgentViewPane): HTMLTextAreaElement {
	return pane.element.querySelector<HTMLTextAreaElement>('textarea.claude-composer-input')!;
}

function sendButton(pane: ClaudeAgentViewPane): HTMLButtonElement {
	return pane.element.querySelector<HTMLButtonElement>('button.claude-send')!;
}

/** A menu row's name, without the description under it. */
function rowName(row: Element): string | null | undefined {
	return (row.querySelector('.name') ?? row.querySelector('.label'))?.textContent;
}

/** The top rows of an open menu: name, then its value or detail, then its checked state. */
function menuRows(host: HTMLElement): (string | null | undefined)[][] {
	return [...host.querySelectorAll('.claude-menu:not(.claude-submenu) > .claude-menu-body > .claude-menu-item')].map(row => [
		rowName(row),
		(row.querySelector('.value') ?? row.querySelector('.detail'))?.textContent,
		row.getAttribute('aria-checked'),
	]);
}

function modelPill(pane: ClaudeAgentViewPane): HTMLButtonElement {
	return pane.element.querySelector<HTMLButtonElement>('button.claude-model-pill')!;
}

function headerButton(pane: ClaudeAgentViewPane, label: string): HTMLButtonElement {
	return pane.element.querySelector<HTMLButtonElement>(`.claude-pane-actions button[aria-label="${label}"]`)!;
}

function toolbarButton(pane: ClaudeAgentViewPane, label: string): HTMLButtonElement {
	return pane.element.querySelector<HTMLButtonElement>(`.claude-composer-toolbar button[aria-label="${label}"]`)!;
}

function tab(pane: ClaudeAgentViewPane, sessionId: string): HTMLElement {
	return pane.element.querySelector<HTMLElement>(`.claude-tab[data-session-id="${sessionId}"]`)!;
}
