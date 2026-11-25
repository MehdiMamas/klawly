/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Dimension, getWindow } from '../../../../../base/browser/dom.js';
import { Action } from '../../../../../base/common/actions.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event as BaseEvent } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { MenuId, MenuRegistry, isIMenuItem } from '../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { TestClipboardService } from '../../../../../platform/clipboard/test/common/testClipboardService.js';
import { BeginClaudeRequest, ClaudeModelInfo, ClaudeRunHandle, ClaudeUserInput, IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { ClaudeElicitationAnswer } from '../../../../../platform/claude/common/claudeElicitation.js';
import { FakeClaudeRuntimeService } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { CLAUDE_COMMAND_LOG_CHANNEL_ID } from '../../../../services/claude/common/claudeAgentLog.js';
import { agentWorkspaceStubs, TestTrustState } from '../../../../services/claude/test/common/claudeAgentTestUtils.js';
import { NO_SESSION_PERMISSIONS } from '../../../../../platform/claude/common/claudeSessionPermissions.js';
import { ClaudeAgentService, IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ClaudeActionService } from '../../browser/claudeActionService.js';
import { ClaudeContextPicker, outlineSymbolAttachment } from '../../browser/chat/claudeContextPicker.js';
import { IContextMenuService, IContextViewDelegate, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IMarkerService } from '../../../../../platform/markers/common/markers.js';
import { IHistoryService } from '../../../../services/history/common/history.js';
import { IOutlineModelService } from '../../../../../editor/contrib/documentSymbols/browser/outlineModel.js';
import { ISCMService } from '../../../scm/common/scm.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { TestWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { CLAUDE_ACTIONS_PREFER_COMMANDS_SETTING, CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, CLAUDE_COMPOSER_PASTE_AS_REFERENCE_SETTING, CLAUDE_LEGACY_LONG_PASTE_SETTING, CLAUDE_LONG_PASTE_DEFAULT } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { EditorType } from '../../../../../editor/common/editorCommon.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IClaudeCheckpointService } from '../../../../services/claude/common/claudeCheckpointService.js';
import { IFileQuery, ISearchService } from '../../../../services/search/common/search.js';
import { DataTransfers } from '../../../../../base/browser/dnd.js';
import { IClaudeContextService } from '../../../../services/claude/common/claudeContextService.js';
import { CLAUDE_VOICE_IDLE, IClaudeVoiceInputService } from '../../common/claudeVoiceInput.js';
import { IKlawlySyncService } from '../../../../../platform/claude/common/klawlySyncService.js';
import { IClaudeActionService } from '../../../../../platform/claude/common/claudeActions.js';
import { IClaudeReviewService } from '../../../../services/claude/common/claudeReview.js';
import { IClaudeDiagnosticsService } from '../../../../services/claude/common/claudeDiagnostics.js';
import { ClaudePermissionService, IClaudePermissionService } from '../../../../services/claude/common/claudePermissionService.js';
import { ClaudeElicitationService, IClaudeElicitationService } from '../../../../services/claude/common/claudeElicitationService.js';
import { ClaudeCopyTracker, hashCopiedText, IClaudeCopyTracker } from '../../../../services/claude/common/claudeCopyTracker.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { TestEditorGroupView, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry, ViewContainerLocation } from '../../../../common/views.js';
import { ViewDescriptorService } from '../../../../services/views/browser/viewDescriptorService.js';
import { registerClaudePaneActions } from '../../browser/claudeActions.js';
import { registerClaudeViewDescriptors } from '../../browser/claudeViewRegistration.js';
import { ClaudeAgentViewPane } from '../../browser/chat/claudeViewPane.js';
import { ClaudeChatWidget, claudeTimelinePlaceSessions } from '../../browser/chat/claudeChatWidget.js';
import { ClaudeModelSwitchService, IClaudeModelSwitchService } from '../../browser/claudeModelSwitch.js';
import { ClaudeAgentEditor } from '../../browser/chat/claudeAgentEditor.js';
import { CLAUDE_EDIT_GOAL_COMMAND_ID, CLAUDE_GOAL_RUNNING, CLAUDE_RESUME_GOAL_COMMAND_ID, CLAUDE_STOP_GOAL_COMMAND_ID, ClaudeAgentEditorInput } from '../../browser/chat/claudeAgentEditorInput.js';
import { ClaudeTimelineRenderer } from '../../browser/chat/claudeTimelineRenderer.js';
import { IClaudeCloudSessionsService } from '../../browser/claudeCloudSessions.js';
import { IClaudeProjectIndex } from '../../browser/claudeProjects.js';
import { IClaudeSetupService } from '../../browser/claudeSetup.js';
import { IClaudeAutomationService } from '../../../../services/claude/common/claudeAutomationService.js';
import { IClaudeBackgroundAgentService } from '../../../../services/claude/common/claudeBackgroundAgent.js';
import { IClaudeMakerService } from '../../browser/claudeMakerService.js';
import { IClaudeComparisonService } from '../../../../services/claude/common/claudeComparison.js';
import { IClaudeGoalLoopService } from '../../common/claudeGoalLoopService.js';
import { IClaudeMultitaskService } from '../../../../services/claude/common/claudeMultitask.js';
import { IClaudeDelegationService } from '../../../../services/claude/common/claudeDelegation.js';
import { IClaudeWorkerRegistry } from '../../../../services/claude/common/claudeWorkerRegistry.js';
import { readySetupService, TestClaudeSetupService } from './claudeSetupTestUtils.js';
import { IClaudeGitHubDetailsService } from '../../browser/chat/claudeGitHubDetails.js';
import { silentGitHubDetailsService, silentTendService } from './claudeGitHubTestUtils.js';
import { EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../../../services/claude/common/claudeAgentState.js';
import { NormalizedClaudeEvent } from '../../../../../platform/claude/common/claudeProtocol.js';
import { CLAUDE_AGENT_HEADER_ACTION_ID, CLAUDE_AGENT_VIEW_ID, CLAUDE_MOVE_CHAT_TO_SIDE_BAR_COMMAND_ID, CLAUDE_OPEN_CHAT_IN_EDITOR_COMMAND_ID, CLAUDE_PICK_MODEL_COMMAND_ID, CLAUDE_START_GOAL_COMMAND_ID, CLAUDE_SWITCH_ACCOUNT_COMMAND_ID, CLAUDE_VIEW_CONTAINER_ID } from '../../common/claudeViews.js';
import { IClaudeChatShareService } from '../../browser/chat/claudeChatShare.js';
import { IClaudeTendPullRequestService } from '../../browser/chat/claudeTendPullRequest.js';

registerClaudePaneActions();

/** The running row of the `reading` fixture: the file name leads and its folder follows (issue 133). */
const readingRow = 'Reading x.ts src';

suite('Claude agent pane shell', function () {
	// The hidden test window on Windows runs animation frames about once a second, and the
	// timeline paints on a frame, so a test that waits for several paints passes mocha's 5 s (issue 274).
	this.timeout(20_000);

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiationService: TestInstantiationService;
	let runtime: ScriptedRuntime;
	let agent: ClaudeAgentService;
	let trust: TestTrustState;
	let agentConfiguration: TestConfigurationService;
	let clipboard: TestClipboardService;
	let pickedItems: readonly IQuickPickItem[] = [];
	let pickOptions: { activeItem?: IQuickPickItem } | undefined;
	let pickResult: IQuickPickItem | undefined;
	const notifications: string[] = [];
	const infos: string[] = [];
	const openedViews: string[] = [];
	const hiddenParts: string[] = [];
	let holdResolve: Promise<void> | undefined;
	let resolveError: Error | undefined;
	let selectionContent = 'const answer = 1;';
	const commandLog: string[] = [];
	const terminals: { cwd?: string; text?: string; shown?: boolean }[] = [];
	let activeTerminal: { shown?: boolean } | undefined;
	let shownChannel: string | undefined;

	setup(() => {
		pickedItems = [];
		pickOptions = undefined;
		pickResult = undefined;
		notifications.length = 0;
		infos.length = 0;
		openedViews.length = 0;
		commandLog.length = 0;
		terminals.length = 0;
		activeTerminal = undefined;
		shownChannel = undefined;
		holdResolve = undefined;
		resolveError = undefined;
		selectionContent = 'const answer = 1;';
		instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IClaudeTendPullRequestService, silentTendService());
		instantiationService.stub(IContextKeyService, store.add(instantiationService.createInstance(ContextKeyService)));
		registerClaudeViewDescriptors(new SyncDescriptor(ClaudeAgentViewPane));
		instantiationService.stub(IViewDescriptorService, store.add(instantiationService.createInstance(ViewDescriptorService)));
		runtime = store.add(new ScriptedRuntime(streamingFixtures()));
		const outputService = {
			_serviceBrand: undefined,
			getChannel: (id: string) => ({
				append: (line: string) => {
					if (id === CLAUDE_COMMAND_LOG_CHANNEL_ID) {
						commandLog.push(line);
					}
				},
			}),
			showChannel: async (id: string) => { shownChannel = id; },
		} as unknown as IOutputService;
		trust = store.add(new TestTrustState());
		agentConfiguration = new TestConfigurationService();
		agent = store.add(new ClaudeAgentService(runtime, outputService, ...agentWorkspaceStubs({ trust, configuration: agentConfiguration })));
		instantiationService.stub(IOutputService, outputService);
		instantiationService.stub(ITerminalService, {
			createTerminal: async (options: { cwd?: string }) => {
				const created: { cwd?: string; text?: string; shown?: boolean } = { cwd: typeof options.cwd === 'string' ? options.cwd : undefined, text: undefined };
				terminals.push(created);
				return {
					created,
					focusWhenReady: async () => undefined,
					sendText: async (text: string) => { created.text = text; },
				};
			},
			setActiveInstance: (instance: { created: { shown?: boolean } }) => { activeTerminal = instance.created; },
			revealActiveTerminal: async () => {
				if (activeTerminal) {
					activeTerminal.shown = true;
				}
			},
		} as unknown as ITerminalService);
		instantiationService.stub(IClaudeAgentService, agent);
		instantiationService.stub(IClaudeRuntimeService, runtime);
		instantiationService.stub(IClaudeSetupService, readySetupService());
		instantiationService.stub(IClaudeGitHubDetailsService, silentGitHubDetailsService());
		instantiationService.stub(IClaudeMakerService, { onDidChange: BaseEvent.None, role: 'user', previewAsUser: false, active: false, setPreviewAsUser: () => { } } as unknown as IClaudeMakerService);
		instantiationService.stub(IClaudeBackgroundAgentService, { onDidChangeTasks: () => ({ dispose() { } }), getTasks: () => [] } as unknown as IClaudeBackgroundAgentService);
		instantiationService.stub(IClaudeAutomationService, { onDidChange: () => ({ dispose() { } }), automationOfTask: () => undefined } as unknown as IClaudeAutomationService);
		instantiationService.stub(IClaudeCloudSessionsService, { onDidChange: () => ({ dispose() { } }), getSessions: () => [] } as unknown as IClaudeCloudSessionsService);
		instantiationService.stub(IClaudeProjectIndex, { onDidChange: () => ({ dispose() { } }), projectOf: () => undefined, refresh: () => { } } as unknown as IClaudeProjectIndex);
		instantiationService.stub(IClaudeComparisonService, { onDidChangeComparisons: () => ({ dispose() { } }), getHistory: () => [] } as unknown as IClaudeComparisonService);
		instantiationService.stub(IClaudeGoalLoopService, { onDidChange: () => ({ dispose() { } }), getGoal: () => undefined, getEnded: () => undefined, getLoop: () => undefined } as unknown as IClaudeGoalLoopService);
		instantiationService.stub(IClaudeMultitaskService, { onDidChange: () => ({ dispose() { } }), getGroups: () => [] } as unknown as IClaudeMultitaskService);
		instantiationService.stub(IClaudeDelegationService, { onDidChange: () => ({ dispose() { } }), getQuestion: () => undefined, getCardForChild: () => undefined, getRoot: (id: string) => id, getDelegatedCost: () => undefined, getRolledUpCost: () => undefined } as unknown as IClaudeDelegationService);
		instantiationService.stub(IClaudeWorkerRegistry, { sessionTotals: () => ({ costUsd: 0, inputTokens: 0, outputTokens: 0, runs: 0 }) } as unknown as IClaudeWorkerRegistry);
		instantiationService.stub(IClaudePermissionService, store.add(instantiationService.createInstance(ClaudePermissionService)));
		instantiationService.stub(IClaudeElicitationService, instantiationService.createInstance(ClaudeElicitationService));
		instantiationService.stub(IClaudeModelSwitchService, store.add(instantiationService.createInstance(ClaudeModelSwitchService)));
		instantiationService.stub(IClaudeReviewService, {
			onDidChangeReview: () => ({ dispose() { } }),
			onDidNavigate: () => ({ dispose() { } }),
			get: () => undefined,
			ensureTurn: async () => undefined,
			replaceTurn: () => { throw new Error('not used'); },
			decorationsFor: () => [],
			focus: () => undefined,
			focused: () => undefined,
			currentHunk: () => undefined,
			acceptHunk: () => undefined,
			rejectHunk: async () => undefined,
			acceptFile: () => undefined,
			rejectFile: async () => undefined,
			acceptAll: () => undefined,
			rejectAll: async () => undefined,
			next: () => undefined,
			previous: () => undefined,
			onDidChangeAutoKeep: () => ({ dispose() { } }),
			isAutoKeep: () => false,
			autoKept: () => false,
			pendingSummary: () => ({ hunks: 0, files: 0, turns: 0, chats: 0, uris: [], sessionIds: [] }),
		} as unknown as IClaudeReviewService);
		instantiationService.stub(IClaudeDiagnosticsService, {
			onDidChangeProblems: () => ({ dispose() { } }),
			getProblems: () => undefined,
		} as unknown as IClaudeDiagnosticsService);
		instantiationService.stub(IClaudeActionService, {
			resolve: () => ({ kind: 'prompt', templateId: 'explain-selection' }),
			run: async () => undefined,
		} as unknown as IClaudeActionService);
		instantiationService.stub(IClaudeCopyTracker, new ClaudeCopyTracker());
		instantiationService.stub(IClaudeVoiceInputService, { isSupported: false, status: CLAUDE_VOICE_IDLE, onDidChangeStatus: () => ({ dispose() { } }), onDidTranscribe: () => ({ dispose() { } }) } as unknown as IClaudeVoiceInputService);
		instantiationService.stub(IKlawlySyncService, { onDidChangeStatus: BaseEvent.None, listImportedSessions: async () => [] } as unknown as IKlawlySyncService);
		instantiationService.stub(IClaudeContextService, {
			resolve: async (userText: string, mode: 'agent', attachments: readonly { kind: string }[]) => {
				if (holdResolve) {
					await holdResolve;
				}
				if (resolveError) {
					throw resolveError;
				}
				return {
					userText,
					mode,
					workspaceRoot: '/repo',
					attachments: attachments.map(attachment => attachment.kind === 'selection'
						? { kind: 'selection' as const, path: 'src/app.ts', range: { startLine: 12, startColumn: 1, endLine: 14, endColumn: 1 }, content: selectionContent, stale: false, truncated: false }
						: { kind: 'file' as const, path: 'file', unsaved: false, truncated: false }),
					diagnostics: [],
					instructionFiles: [],
				};
			},
			preview: async (userText: string, _mode: string, attachments: readonly unknown[]) => `PREVIEW ${userText}\nchips=${attachments.length}`,
			storeImage: async () => ({ kind: 'image' as const, localUri: 'file:///tmp/shot.png' }),
			copyExternalFile: async () => ({ kind: 'pasted-text' as const, id: 'paste', text: 'x', lineCount: 1 }),
		} as unknown as IClaudeContextService);
		clipboard = new TestClipboardService();
		instantiationService.stub(IClipboardService, clipboard);
		instantiationService.stub(IClaudeChatShareService, { linksEnabled: false, copyMarkdown: async () => { }, shareLink: async () => { } } as unknown as IClaudeChatShareService);
		hiddenParts.length = 0;
		instantiationService.stub(IWorkbenchLayoutService, { setPartHidden: (hidden: boolean, part: Parts) => { hiddenParts.push(`${part}:${hidden}`); } } as unknown as IWorkbenchLayoutService);
		instantiationService.stub(IViewsService, { openView: async (id: string) => { openedViews.push(id); return undefined; }, closeView: () => undefined, isViewVisible: () => false } as unknown as IViewsService);
		instantiationService.stub(INotificationService, {
			error: (message: string | Error) => notifications.push(message instanceof Error ? message.message : message),
			info: (message: string | Error) => infos.push(message instanceof Error ? message.message : message),
			warn: () => undefined,
		} as unknown as INotificationService);
		instantiationService.stub(IQuickInputService, {
			pick: async (items: readonly IQuickPickItem[], options?: { activeItem?: IQuickPickItem }) => {
				pickedItems = items;
				pickOptions = options;
				return pickResult;
			},
		} as unknown as IQuickInputService);
	});

	teardown(() => {
		const views = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		const containers = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
		const container = containers.get(CLAUDE_VIEW_CONTAINER_ID);
		if (container) {
			views.deregisterViews(views.getViews(container), container);
			containers.deregisterViewContainer(container);
		}
	});

	test('renders the header, timeline, and composer, and shows the chosen model', async () => {
		const pane = openAgentPane();
		assert.ok(pane.element.querySelector('.claude-pane-header'));
		assert.ok(pane.element.querySelector('.claude-timeline'));
		assert.ok(pane.element.querySelector('.claude-composer'));
		assert.ok(pane.element.querySelector('button.claude-pill.is-quiet:not(.claude-auto-pill)')?.textContent?.includes('Loading...'));

		const session = agent.getCurrentSession();
		assert.ok(session);
		await agent.setNextModel(session.id, 'fixture-opus');
		assert.ok(pane.element.querySelector('button.claude-pill.is-quiet:not(.claude-auto-pill)')?.textContent?.includes('Fixture Opus'));
	});

	test('lends the header row to the view title while the view is alone in its container (#106)', () => {
		const pane = openAgentPane();
		const title = document.createElement('div');
		const item = store.add(pane.createActionViewItem(store.add(new Action(CLAUDE_AGENT_HEADER_ACTION_ID, 'Agent Sessions')))!);
		item.render(title);
		const placed = () => ({
			inPane: !!pane.element.querySelector('.claude-pane-header'),
			inTitle: !!title.querySelector('.claude-title-header > .claude-pane-header'),
		});
		const before = placed();
		pane.headerVisible = false;
		const merged = placed();
		pane.headerVisible = true;
		assert.deepStrictEqual([before, merged, placed()], [
			{ inPane: true, inTitle: false },
			{ inPane: false, inTitle: true },
			{ inPane: true, inTitle: false },
		]);
	});

	test('in an editor tab the chat has no inner tab row; More still lists its actions (issue 142)', () => {
		const container = document.createElement('div');
		document.body.appendChild(container);
		store.add({ dispose: () => container.remove() });
		const widget = store.add(instantiationService.createInstance(ClaudeChatWidget, container, 'editor'));
		const header = container.querySelector('.claude-pane-header');
		assert.deepStrictEqual({
			header: header?.childElementCount,
			tabs: container.querySelectorAll('[role="tab"]').length,
			moveToSideBar: widget.getMoreActions().some(action => action.id === CLAUDE_MOVE_CHAT_TO_SIDE_BAR_COMMAND_ID),
		}, { header: 0, tabs: 0, moveToSideBar: true });
	});

	test('in an editor tab History drops its popover down under the editor title button the tab hands in (issue 356)', () => {
		const container = document.createElement('div');
		const host = document.createElement('div');
		document.body.append(container, host);
		store.add({ dispose: () => { container.remove(); host.remove(); } });
		const anchors: unknown[] = [];
		let rendered: { dispose(): void } | undefined;
		instantiationService.stub(IContextViewService, {
			showContextView: (delegate: IContextViewDelegate) => {
				anchors.push(delegate.getAnchor());
				rendered = delegate.render(host) ?? undefined;
				return { close: () => { rendered?.dispose(); rendered = undefined; host.textContent = ''; delegate.onHide?.(); } };
			},
		} as unknown as IContextViewService);
		const widget = store.add(instantiationService.createInstance(ClaudeChatWidget, container, 'editor'));
		const open = () => !!host.querySelector('.claude-history-menu');
		widget.toggleHistory();
		const withoutButton = open();
		const titleButton = document.createElement('a');
		host.before(titleButton);
		store.add({ dispose: () => titleButton.remove() });
		widget.setHistoryAnchor(() => titleButton);
		widget.toggleHistory();
		const opened = open();
		widget.toggleHistory();
		assert.deepStrictEqual({ withoutButton, opened, closed: !open(), anchoredOnTitle: anchors.length === 1 && anchors[0] === titleButton }, { withoutButton: false, opened: true, closed: true, anchoredOnTitle: true });
	});

	test('Background Agents asks to widen the pane only by what it measured, and not at all before the first layout (issue 334)', () => {
		const container = document.createElement('div');
		document.body.appendChild(container);
		store.add({ dispose: () => container.remove() });
		const widget = store.add(instantiationService.createInstance(ClaudeChatWidget, container, 'view'));
		const unmeasured = widget.showAgents('background');
		widget.layout(600, 500);
		const narrow = widget.showAgents('background');
		widget.layout(600, 900);
		assert.deepStrictEqual([unmeasured, narrow, widget.showAgents('background')], [0, 140, 0]);
	});

	test('a chat keeps each session\'s place as the reader scrolls: a chat built before the old one closes opens there, a session switched to while hidden opens at its end, and closed sessions leave no place (issue 402)', async function () {
		this.timeout(60_000);
		const host = () => {
			const container = document.createElement('div');
			document.body.appendChild(container);
			store.add({ dispose: () => container.remove() });
			return container;
		};
		const log: Record<string, unknown> = {};
		const firstHost = host();
		const first = store.add(instantiationService.createInstance(ClaudeChatWidget, firstHost, 'editor'));
		first.layout(800, 400);
		const sessionA = agent.getCurrentSession()!;
		runtime.nextFixture = 'plain-answer';
		await agent.submit(sessionA.id, 'Go', 'C:\\testWorkspace');
		const firstTimeline = await tallTimeline(firstHost, 'That skips the check.');
		await waitFor(() => isAtEnd(firstTimeline), 'the first chat at its end');
		const place = wheelUp(firstTimeline);
		log.scrolledToMiddle = place > 0 && !isAtEnd(firstTimeline);

		// Move Chat to Side Bar builds the view's chat before the tab's chat closes.
		const secondHost = host();
		const second = store.add(instantiationService.createInstance(ClaudeChatWidget, secondHost, 'view'));
		second.layout(800, 400);
		// The new chat paints its turn before late content (a plan card, an image) makes the place reachable.
		const secondTimeline = await tallTimeline(secondHost, 'That skips the check.');
		await waitFor(() => Math.abs(secondTimeline.scrollTop - place) <= 1, `the new chat at ${place}, not ${secondTimeline.scrollTop}`);
		log.rebuiltAtPlace = true;
		first.dispose();

		// A session switched to while the pane is hidden opens at its end, not at the old session's offset.
		secondHost.style.display = 'none';
		const sessionB = agent.createSession();
		runtime.nextFixture = 'with-skill';
		await agent.submit(sessionB.id, 'Go', 'C:\\testWorkspace');
		await tallTimeline(secondHost, 'skill ready');
		secondHost.style.display = '';
		await waitFor(() => isAtEnd(secondTimeline) && secondTimeline.scrollHeight > 2000, `the switched session at its end, not ${secondTimeline.scrollTop}`);
		log.switchedWhileHiddenAtEnd = true;
		second.dispose();

		// A session that closes while no chat is open leaves its place until the next chat opens.
		agent.closeSession(sessionA.id);
		log.keptWhileNoChat = claudeTimelinePlaceSessions().includes(sessionA.id);
		store.add(instantiationService.createInstance(ClaudeChatWidget, host(), 'view'));
		log.prunedByNextChat = !claudeTimelinePlaceSessions().includes(sessionA.id);

		assert.deepStrictEqual(log, { scrolledToMiddle: true, rebuiltAtPlace: true, switchedWhileHiddenAtEnd: true, keptWhileNoChat: true, prunedByNextChat: true });
	});

	test('the Agent view tells its chat as its body hides, so a hide and a show in one frame keep the reader\'s place (issue 402)', async function () {
		this.timeout(60_000);
		const pane = openAgentPane();
		pane.setVisible(true);
		pane.layout(800);
		const session = agent.getCurrentSession()!;
		runtime.nextFixture = 'plain-answer';
		await agent.submit(session.id, 'Go', 'C:\\testWorkspace');
		const timeline = await tallTimeline(pane.element, 'That skips the check.');
		await waitFor(() => isAtEnd(timeline), 'the chat at its end');
		const place = wheelUp(timeline);

		pane.setVisible(false);
		const parent = pane.element.parentElement!;
		pane.element.remove();
		parent.appendChild(pane.element);
		// The browser forgets the scroll offset of a node that left the page.
		timeline.scrollTop = 0;
		pane.setVisible(true);
		pane.layout(800);

		assert.deepStrictEqual({ middle: place > 0 && !isAtEnd(timeline), back: Math.abs(timeline.scrollTop - place) <= 1 }, { middle: true, back: true }, `${timeline.scrollTop} vs ${place}`);
	});

	test('restores a draft when switching tabs and keeps keyboard focus on the tab', () => {
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'keep this';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const first = agent.getCurrentSession();
		assert.ok(first);
		const second = agent.createSession();
		assert.strictEqual(input.value, '');

		const firstTab = tab(pane, 0);
		firstTab.focus();
		agent.selectSession(first.id);
		assert.strictEqual(input.value, 'keep this');
		assert.strictEqual(document.activeElement?.getAttribute('data-session-id'), first.id);
		assert.strictEqual(agent.getCurrentSession()?.id, first.id);
		assert.ok(second);
	});

	test('inline Send to Agent text shows in the open composer after what is typed, and only for the session it shows', () => {
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'typed first';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const current = agent.getCurrentSession();
		assert.ok(current);
		const handoff = 'Inline edit in src/cart.ts, line 1, not accepted yet.\nAsked: make this async\n\n';
		const shown = pane.widget?.appendDraft(current.id, handoff);
		const other = pane.widget?.appendDraft('another-session', 'not here');
		assert.deepStrictEqual({ shown, other, value: input.value, draft: agent.getCurrentSession()?.draft, cursor: input.selectionStart }, {
			shown: true,
			other: false,
			value: `typed first\n\n${handoff}`,
			draft: `typed first\n\n${handoff}`,
			cursor: `typed first\n\n${handoff}`.length,
		});
	});

	test('Enter on a tab close button closes that session', () => {
		const pane = openAgentPane();
		const first = agent.getCurrentSession();
		assert.ok(first);
		agent.createSession();
		const close = tabClose(pane, 0);
		const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		close.dispatchEvent(event);
		assert.strictEqual(event.defaultPrevented, false);
		close.click();
		assert.strictEqual(agent.getSessions().some(session => session.id === first.id), false);
	});

	test('closing the last tab of an untouched New Agent closes the Agent view and keeps the session', () => {
		const closedViews: string[] = [];
		instantiationService.stub(IViewsService, 'closeView', (id: string) => { closedViews.push(id); });
		const pane = openAgentPane();
		const session = agent.getCurrentSession();
		assert.ok(session);
		tabClose(pane, 0).click();
		assert.deepStrictEqual({ closedViews, sessions: agent.getSessions().map(candidate => candidate.id) }, { closedViews: [CLAUDE_AGENT_VIEW_ID], sessions: [session.id] });
	});

	test('closing the last tab hides the auxiliary bar when the Agent view lives there, and leaves other parts alone', () => {
		const locate = (location: ViewContainerLocation) => instantiationService.stub(IViewDescriptorService, 'getViewLocationById', () => location);
		const closeLast = () => tabClose(openAgentPane(), 0).click();
		locate(ViewContainerLocation.Panel);
		closeLast();
		const panel = hiddenParts.slice();
		locate(ViewContainerLocation.AuxiliaryBar);
		closeLast();
		assert.deepStrictEqual({ panel, auxiliary: hiddenParts.slice(panel.length) }, { panel: [], auxiliary: [`${Parts.AUXILIARYBAR_PART}:true`] });
	});

	test('closing the last tab after a turn moves it to History, leaves a new one for next time and closes the Agent view', async () => {
		const closedViews: string[] = [];
		instantiationService.stub(IViewsService, 'closeView', (id: string) => { closedViews.push(id); });
		const pane = openAgentPane();
		const closed = agent.getCurrentSession();
		assert.ok(closed);
		runtime.nextFixture = 'plain-answer';
		await agent.submit(closed.id, 'Go', 'C:\\testWorkspace');
		tabClose(pane, 0).click();
		const current = agent.getCurrentSession();
		assert.deepStrictEqual({ closedViews, kept: agent.getSessions().some(candidate => candidate.id === closed.id), fresh: !!current && current.id !== closed.id }, { closedViews: [CLAUDE_AGENT_VIEW_ID], kept: false, fresh: true });
	});

	test('Pick Model keeps the description, marks the current model, and stores the choice', async () => {
		const session = agent.createSession();
		await agent.setNextModel(session.id, 'fixture-sonnet');
		pickResult = { id: 'fixture-opus', label: 'Fixture Opus' };
		await runPick();
		const current = pickedItems.find(item => item.id === 'fixture-sonnet');
		assert.ok(current);
		assert.strictEqual(pickOptions?.activeItem, current);
		assert.strictEqual(current.label, '$(check) Fixture Sonnet');
		assert.strictEqual(current.description, 'Scripted test model');
		assert.strictEqual(pickedItems.find(item => item.id === 'fixture-opus')?.label, 'Fixture Opus');
		assert.strictEqual(agent.getCurrentSession()?.modelId, 'fixture-opus');
	});

	test('Pick Model shows the empty catalog and does not invent a model', async () => {
		agent.createSession();
		runtime.models = [];
		await runPick();
		assert.strictEqual(pickedItems.length, 0);
		assert.strictEqual(agent.getCurrentSession()?.modelId, undefined);
	});

	test('Edit puts an earlier message in the composer, Escape brings the draft back, and Send goes back to it (issue 702)', async () => {
		instantiationService.stub(IClaudeCheckpointService, { readTurnsChanges: async () => [], readOtherChatPaths: async () => new Set<string>(), readHelperTurnIds: async () => [] } as unknown as IClaudeCheckpointService);
		const pane = openAgentPane();
		const session = agent.getCurrentSession()!;
		for (const text of ['First', 'Second']) {
			runtime.nextFixture = 'plain-answer';
			await agent.submit(session.id, text, 'C:\\testWorkspace');
			await waitUntil(pane, '', () => agent.getViewState(session.id).turns.every(turn => turn.status === 'complete'));
		}
		const input = composer(pane);
		input.value = 'Draft';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const editButton = (index: number) => pane.element.querySelectorAll<HTMLButtonElement>('.claude-msg-user .claude-msg-toolbar button[aria-label="Edit"]')[index];
		const strip = () => pane.element.querySelector<HTMLElement>('.claude-edit-strip')!;
		const enabled = [editButton(0).getAttribute('aria-disabled'), editButton(1).getAttribute('aria-disabled')];
		editButton(1).click();
		const editing = { text: input.value, strip: !strip().hidden };
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		const cancelled = { text: input.value, strip: !strip().hidden };
		editButton(1).click();
		input.value = 'Second, edited';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		runtime.nextFixture = 'plain-answer';
		sendButton(pane).click();
		await waitUntil(pane, 'Second, edited', () => agent.getViewState(session.id).turns[1]?.status === 'complete');
		assert.deepStrictEqual({
			enabled,
			editing,
			cancelled,
			turns: agent.getViewState(session.id).turns.map(turn => turn.user.text),
			after: { text: input.value, strip: !strip().hidden },
		}, {
			enabled: ['false', 'false'],
			editing: { text: 'Second', strip: true },
			cancelled: { text: 'Draft', strip: false },
			turns: ['First', 'Second, edited'],
			after: { text: '', strip: false },
		});
	});

	test('another model after a finished turn shows the switch notice, never in an empty chat; Switch Back restores the model (issue 703)', async () => {
		const pane = openAgentPane();
		const session = agent.getCurrentSession()!;
		const notice = () => pane.element.querySelector<HTMLElement>('.claude-model-switch-notice')!;
		await agent.setNextModel(session.id, 'fixture-sonnet');
		pickResult = { id: 'fixture-opus', label: 'Fixture Opus' };
		await runPick();
		const empty = notice().hidden === true;
		await agent.setNextModel(session.id, 'fixture-sonnet');
		runtime.nextFixture = 'plain-answer';
		await agent.submit(session.id, 'Go', 'C:\\testWorkspace');
		await waitUntil(pane, '', () => agent.getViewState(session.id).turns[0]?.status === 'complete');
		await runPick();
		await waitUntil(pane, 'Switching models mid-chat', () => !notice().hidden);
		const shown = {
			live: notice().getAttribute('aria-live'),
			title: notice().querySelector('.title')?.textContent,
			buttons: [...notice().querySelectorAll('button')].map(button => button.textContent),
		};
		[...notice().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Switch Back')!.click();
		await waitUntil(pane, '', () => notice().hidden === true);
		assert.deepStrictEqual({ empty, shown, back: agent.getCurrentSession()?.modelId }, {
			empty: true,
			shown: {
				live: 'polite',
				title: 'Switching models mid-chat uses more of your usage',
				buttons: ['Keep Fixture Opus', 'Switch Back', 'New Chat with Fixture Opus', 'Don\'t Show Again'],
			},
			back: 'fixture-sonnet',
		});
	});

	test('Send stays disabled until there is text, and Shift+Enter does not send', async () => {
		const pane = openAgentPane();
		const send = sendButton(pane);
		assert.strictEqual(send.disabled, true);
		const input = composer(pane);
		input.value = '   ';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		assert.strictEqual(send.disabled, true);
		input.value = 'Why is the total wrong?';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		assert.strictEqual(send.disabled, false);
		const newline = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
		input.dispatchEvent(newline);
		assert.strictEqual(newline.defaultPrevented, false);
		assert.strictEqual(agent.getViewState(agent.getCurrentSession()!.id).turns.length, 0);
	});

	test('a paste of copied editor lines becomes a file:line chip, and the preview shows what will be sent', async () => {
		const pane = openAgentPane();
		const tracker = instantiationService.get(IClaudeCopyTracker);
		const text = 'const answer = 1;';
		tracker.record({
			uri: 'file:///repo/src/app.ts',
			range: { startLine: 12, startColumn: 1, endLine: 14, endColumn: 1 },
			versionId: 1,
			textHash: hashCopiedText(text),
		});
		const input = composer(pane);
		const data = new DataTransfer();
		data.setData('text/plain', text);
		const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(paste, 'clipboardData', { value: data });
		input.dispatchEvent(paste);
		const detail = pane.element.querySelector('.claude-chip:not(.is-add) .detail');
		// allow-any-unicode-next-line
		assert.strictEqual(detail?.textContent, '12–14');
		assert.strictEqual(input.value, '');

		pane.widget?.togglePromptPreview();
		await new Promise(resolve => setTimeout(resolve, 0));
		const shown = pane.element.querySelector('.claude-prompt-preview');
		assert.ok(shown instanceof HTMLElement);
		assert.strictEqual(shown.hidden, false);
		assert.match(shown.textContent ?? '', /chips=1/);
	});

	test('a long paste becomes a pill in the message, and Ctrl+Shift+V stays plain text', () => {
		const pane = openAgentPane();
		const input = composer(pane);
		const long = 'x'.repeat(CLAUDE_LONG_PASTE_DEFAULT);
		const data = new DataTransfer();
		data.setData('text/plain', long);
		const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(paste, 'clipboardData', { value: data });
		input.dispatchEvent(paste);
		assert.strictEqual(input.value, '[Pasted text #1] ');
		assert.ok(pane.element.textContent?.includes('Pasted text'));

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, shiftKey: true, bubbles: true }));
		const plain = new DataTransfer();
		plain.setData('text/plain', 'plain words');
		const plainPaste = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(plainPaste, 'clipboardData', { value: plain });
		input.dispatchEvent(plainPaste);
		input.dispatchEvent(new KeyboardEvent('keyup', { key: 'v', bubbles: true }));
		assert.strictEqual(input.value, '[Pasted text #1] plain words');
		const next = new DataTransfer();
		next.setData('text/plain', 'after');
		const nextPaste = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(nextPaste, 'clipboardData', { value: next });
		input.dispatchEvent(nextPaste);
		assert.strictEqual(nextPaste.defaultPrevented, false);
		assert.strictEqual(input.value, '[Pasted text #1] plain words');
	});

	test('issue 737: a pasted log is a pill the user types around, and one Backspace takes it out', () => {
		const pane = openAgentPane();
		const session = agent.getCurrentSession()!;
		const input = composer(pane);
		const type = (value: string) => {
			input.value = value;
			input.dispatchEvent(new Event('input', { bubbles: true }));
		};
		type('Why does this fail?');
		const log = 'FAIL cart.test.ts\n  x applies a code\n\n  Expected: 21.6\n  Received: 21.59\n';
		const data = new DataTransfer();
		data.setData('text/plain', log);
		const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(paste, 'clipboardData', { value: data });
		input.dispatchEvent(paste);
		type(`${input.value}since the discount change.`);
		const pills = pane.element.querySelector<HTMLElement>('.claude-composer-pills')!;
		const chips = pane.element.querySelector<HTMLElement>('.claude-chips')!;
		assert.deepStrictEqual({
			value: input.value,
			attachments: agent.getCurrentSession()?.attachments.map(attachment => attachment.kind === 'pasted-text' ? [attachment.label, attachment.lineCount, attachment.text === log] : attachment.kind),
			marks: [...pills.querySelectorAll('mark')].map(mark => mark.textContent),
			chipRowHidden: chips.hidden,
		}, {
			value: 'Why does this fail? [Pasted text #1 +5 lines] since the discount change.',
			attachments: [['Pasted text #1 +5 lines', 5, true]],
			marks: ['[Pasted text #1 +5 lines]'],
			chipRowHidden: true,
		});

		// Backspace right after the pill selects all of it, so the key deletes it in one go.
		const end = input.value.indexOf(']') + 1;
		input.setSelectionRange(end, end);
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
		assert.deepStrictEqual([input.selectionStart, input.selectionEnd], [input.value.indexOf('['), end]);
		type('Why does this fail?  since the discount change.');
		assert.deepStrictEqual(agent.getCurrentSession()?.attachments, []);
		assert.strictEqual(session.id, agent.getCurrentSession()?.id);
	});

	test('the old long-paste key still applies, and pasteAsReference off pastes text', async () => {
		const configuration = new TestConfigurationService({ [CLAUDE_LEGACY_LONG_PASTE_SETTING]: 10 });
		instantiationService.stub(IConfigurationService, configuration);
		const pane = openAgentPane();
		const input = composer(pane);
		const paste = (text: string) => {
			const data = new DataTransfer();
			data.setData('text/plain', text);
			const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
			Object.defineProperty(event, 'clipboardData', { value: data });
			input.dispatchEvent(event);
			return event.defaultPrevented;
		};
		assert.strictEqual(paste('twelve chars'), true);
		assert.ok(pane.element.textContent?.includes('Pasted text'));
		await configuration.setUserConfiguration(CLAUDE_COMPOSER_PASTE_AS_REFERENCE_SETTING, false);
		const chips = pane.element.querySelectorAll('.claude-chip').length;
		assert.strictEqual(paste('another long one'), false);
		assert.strictEqual(pane.element.querySelectorAll('.claude-chip').length, chips);
	});

	test('a second Enter while context is resolving does not send the chips again', async () => {
		let release: () => void = () => undefined;
		holdResolve = new Promise(resolve => { release = resolve; });
		const pane = openAgentPane();
		const session = agent.getCurrentSession()!;
		agent.setAttachments(session.id, [{ kind: 'file', uri: 'file:///repo/src/app.ts' }]);
		const input = composer(pane);
		input.value = 'Why?';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		assert.strictEqual(agent.getViewState(session.id).turns.length, 0);
		assert.deepStrictEqual(agent.getCurrentSession()?.attachments, []);
		holdResolve = undefined;
		release();
		await waitForIdle(pane, 'That skips the check.');
		assert.strictEqual(agent.getViewState(session.id).turns.length, 1);
		assert.deepStrictEqual(agent.getCurrentSession()?.attachments, []);
	});

	test('a context failure puts the draft and chips back', async () => {
		resolveError = new Error('cannot read that file');
		const pane = openAgentPane();
		const session = agent.getCurrentSession()!;
		agent.setAttachments(session.id, [{ kind: 'file', uri: 'file:///repo/src/app.ts' }]);
		const input = composer(pane);
		input.value = 'keep me';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(input.value, 'keep me');
		assert.strictEqual(agent.getCurrentSession()?.attachments.length, 1);
		assert.ok(notifications.some(message => message.includes('cannot read that file')));
	});

	test('Show sent prompt redacts a key in the compiled prompt', async () => {
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'token sk-ant-secretvalue';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		await waitForIdle(pane, 'That skips the check.');
		const show = pane.element.querySelector('.claude-msg-toolbar button[aria-label="Show Sent Prompt"]');
		assert.ok(show instanceof HTMLButtonElement);
		show.click();
		const detail = pane.element.querySelector('.claude-sent-prompt');
		assert.ok(detail instanceof HTMLElement);
		assert.strictEqual(detail.hidden, false);
		assert.ok(detail.textContent?.includes('[redacted]'));
		assert.ok(!detail.textContent?.includes('sk-ant-secretvalue'));
	});

	test('a chip with a secret asks first: Remove Secrets sends it redacted, Cancel keeps the draft, Send Anyway sends it as is', async () => {
		const fakeKey = ['sk', '-ant-', 'api03-panetestvalue'].join('');
		selectionContent = `const key = "${fakeKey}";`;
		let choice = 'Remove Secrets';
		const messages: string[] = [];
		instantiationService.stub(IDialogService, {
			prompt: async (prompt: { message: string; buttons?: { label: string; run: () => string }[]; cancelButton?: { label?: string; run: () => string } }) => {
				messages.push(prompt.message);
				const buttons = [...(prompt.buttons ?? []), ...(prompt.cancelButton ? [{ label: prompt.cancelButton.label ?? 'Cancel', run: prompt.cancelButton.run }] : [])];
				return { result: buttons.find(button => button.label.replace(/&&/g, '') === choice)?.run() };
			},
		} as unknown as IDialogService);
		const pane = openAgentPane();
		const session = agent.getCurrentSession()!;
		const selection = { kind: 'selection' as const, uri: 'file:///repo/src/app.ts', range: { startLine: 12, startColumn: 1, endLine: 14, endColumn: 1 }, versionId: 1 };
		const input = composer(pane);
		const send = async (text: string) => {
			agent.setAttachments(session.id, [selection]);
			input.value = text;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
			await new Promise(resolve => setTimeout(resolve, 0));
		};
		const until = async (done: () => boolean) => {
			for (let attempt = 0; attempt < 50 && !done(); attempt++) {
				await new Promise(resolve => setTimeout(resolve, 5));
			}
			assert.ok(done());
		};

		await send('Remove it');
		await waitForIdle(pane, 'That skips the check.');
		const removed = agent.getViewState(session.id).turns[0]?.user.sent?.compiled ?? '';
		assert.ok(removed.includes('const key = "[redacted]";'), removed);
		assert.strictEqual(removed.includes(fakeKey), false);

		choice = 'Cancel';
		await send('Keep my draft');
		assert.strictEqual(agent.getViewState(session.id).turns.length, 1);
		assert.strictEqual(input.value, 'Keep my draft');
		assert.strictEqual(agent.getCurrentSession()?.attachments.length, 1);
		assert.deepStrictEqual(notifications, []);

		choice = 'Send Anyway';
		input.value = '';
		await send('Send it');
		await until(() => agent.getViewState(session.id).turns.length === 2);
		await waitForIdle(pane, 'That skips the check.');
		const sent = agent.getViewState(session.id).turns[1]?.user.sent?.compiled ?? '';
		assert.ok(sent.includes(fakeKey), sent);
		assert.deepStrictEqual(messages, Array(3).fill('This attachment appears to contain 1 secret.'));
	});

	test('an image paste and an inside drop become chips, and an outside drop asks', async () => {
		const prompts: string[] = [];
		instantiationService.stub(IDialogService, {
			prompt: async (prompt: { message?: string; detail?: string; buttons?: { run: () => string }[] }) => {
				prompts.push(`${prompt.message ?? ''} [${prompt.detail ?? ''}]`);
				const button = prompts.length === 1 ? prompt.buttons?.[0] : prompt.buttons?.[1];
				return { result: button?.run() };
			},
		} as unknown as IDialogService);
		const pane = openAgentPane();
		const input = composer(pane);
		const image = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
		const pasted = {
			items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
			files: [image],
			getData: () => '',
		} as unknown as DataTransfer;
		const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(paste, 'clipboardData', { value: pasted });
		input.dispatchEvent(paste);
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.ok(pane.element.textContent?.includes('shot.png'), `${pane.element.textContent ?? ''} attachments=${JSON.stringify(agent.getCurrentSession()?.attachments)} notes=${notifications.join('|')}`);

		const composerNode = pane.element.querySelector('.claude-composer');
		assert.ok(composerNode instanceof HTMLElement);
		const root = instantiationService.get(IWorkspaceContextService).getWorkspace().folders[0].uri;
		const insideUri = URI.joinPath(root, 'src', 'app.ts');
		dropResources(composerNode, [insideUri.toString()]);
		await new Promise(resolve => setTimeout(resolve, 30));
		assert.ok(pane.element.textContent?.includes('app.ts'), `uri=${insideUri.toString()} root=${root.toString()} prompts=${prompts.join('|')} attachments=${JSON.stringify(agent.getCurrentSession()?.attachments)}`);

		dropResources(composerNode, [URI.file('/outside/note.txt').toString()]);
		await new Promise(resolve => setTimeout(resolve, 30));
		assert.ok(prompts[0]?.includes('outside the workspace'), prompts.join('|') || 'no prompt');
		assert.ok(pane.element.textContent?.includes('Pasted text'), pane.element.textContent ?? '');

		dropResources(composerNode, [URI.file('/outside/note.txt').toString()]);
		await new Promise(resolve => setTimeout(resolve, 30));
		assert.ok(agent.getCurrentSession()?.additionalDirectories.some(directory => directory.includes('outside')), JSON.stringify(agent.getCurrentSession()?.additionalDirectories));
	});

	test('the @ picker accepts a file and the / picker accepts a command', async () => {
		runtime.nextFixture = 'with-skill';
		const pane = openAgentPane();
		const session = agent.getCurrentSession()!;
		await agent.submit(session.id, 'Hi', 'C:\\testWorkspace');
		await waitForIdle(pane, 'skill ready');
		const host = document.createElement('div');
		const picker = new ClaudeContextPicker(
			{
				showContextView: (delegate: IContextViewDelegate) => {
					const rendered = delegate.render(host);
					return { close: () => rendered.dispose() };
				},
			} as unknown as IContextViewService,
			new Proxy(instantiationService.get(IFileService), {
				get(target, property, receiver) {
					if (property === 'resolve') {
						return async () => ({ children: [] });
					}
					const value = Reflect.get(target, property, receiver);
					return typeof value === 'function' ? value.bind(target) : value;
				},
			}),
			{ fileSearch: async () => ({ results: [{ resource: URI.file('C:\\testWorkspace\\src\\middleware.ts') }], messages: [] }) } as unknown as ISearchService,
			instantiationService.get(IWorkspaceContextService),
			instantiationService.get(IEditorService),
			instantiationService.get(IHistoryService),
			{ getOrCreate: async () => { throw new Error('no outline'); } } as unknown as IOutlineModelService,
			{ read: () => [] } as unknown as IMarkerService,
			{ repositories: [] } as unknown as ISCMService,
			{ activeInstance: undefined } as unknown as ITerminalService,
			agent,
			new TestConfigurationService(),
		);
		const anchor = document.createElement('textarea');
		picker.show(anchor, 'at', 'mid');
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.ok(host.textContent?.includes('middleware.ts'), host.textContent ?? 'no menu');
		const file = picker.accept();
		assert.strictEqual(file?.attachment?.kind, 'file');

		// Claude Code's own catalog (session.catalog) replaces the names from session.started.
		picker.show(anchor, 'slash', 'expl');
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.ok(host.textContent?.includes('/explain'), host.textContent ?? 'no slash menu');
		const command = picker.accept();
		assert.strictEqual(command?.insert, '/explain ');
		picker.dispose();
	});

	test('issue 736: @terminal lists a terminal named zsh first, and file search skips excluded folders', async () => {
		const host = document.createElement('div');
		const queries: IFileQuery[] = [];
		const picker = new ClaudeContextPicker(
			{
				showContextView: (delegate: IContextViewDelegate) => {
					const rendered = delegate.render(host);
					return { close: () => rendered.dispose() };
				},
			} as unknown as IContextViewService,
			new Proxy(instantiationService.get(IFileService), {
				get(target, property, receiver) {
					if (property === 'resolve') {
						return async () => ({ children: [] });
					}
					const value = Reflect.get(target, property, receiver);
					return typeof value === 'function' ? value.bind(target) : value;
				},
			}),
			{ fileSearch: async (query: IFileQuery) => { queries.push(query); return { results: [{ resource: URI.file('C:\\testWorkspace\\src\\terminal.ts') }], messages: [] }; } } as unknown as ISearchService,
			instantiationService.get(IWorkspaceContextService),
			instantiationService.get(IEditorService),
			instantiationService.get(IHistoryService),
			{ getOrCreate: async () => { throw new Error('no outline'); } } as unknown as IOutlineModelService,
			{ read: () => [] } as unknown as IMarkerService,
			{ repositories: [] } as unknown as ISCMService,
			{ instances: [{ instanceId: 7, title: 'zsh' }] } as unknown as ITerminalService,
			agent,
			new TestConfigurationService({ files: { exclude: { '**/node_modules': true } } }),
		);
		picker.show(document.createElement('textarea'), 'at', 'terminal');
		await new Promise(resolve => setTimeout(resolve, 50));
		const first = picker.accept();
		picker.dispose();
		const folder = queries[0]?.folderQueries[0];
		assert.deepStrictEqual({
			first: first?.attachment,
			ignoreFiles: folder?.disregardIgnoreFiles,
			excludes: folder?.excludePattern?.map(entry => entry.pattern),
		}, {
			first: { kind: 'terminal', terminalId: 7, lines: 200, title: 'zsh' },
			ignoreFiles: false,
			excludes: [{ '**/node_modules': true }],
		});
	});

	test('the / picker shows rows without icons, the argument hint after the name, and "Show N more" opens the rest of a group', () => {
		const host = document.createElement('div');
		const skills = ['one', 'two', 'three', 'four', 'five', 'six'].map(name => ({ name, description: `${name} skill`, source: 'skill' as const }));
		const picks: string[] = [];
		const picker = new ClaudeContextPicker(
			{
				showContextView: (delegate: IContextViewDelegate) => {
					const rendered = delegate.render(host);
					return { close: () => { rendered.dispose(); host.textContent = ''; delegate.onHide?.(); } };
				},
			} as unknown as IContextViewService,
			instantiationService.get(IFileService),
			{} as unknown as ISearchService,
			instantiationService.get(IWorkspaceContextService),
			instantiationService.get(IEditorService),
			instantiationService.get(IHistoryService),
			{} as unknown as IOutlineModelService,
			{ read: () => [] } as unknown as IMarkerService,
			{ repositories: [] } as unknown as ISCMService,
			{} as unknown as ITerminalService,
			{
				getCurrentSession: () => ({
					commands: [{ name: 'compact', description: 'Summarize', argumentHint: '[instructions]', source: 'builtin' }, ...skills],
					agents: [],
					slashCommands: [],
					skills: [],
				}),
			} as unknown as IClaudeAgentService,
			new TestConfigurationService(),
		);
		const listener = picker.onDidPick(item => picks.push(item.id));
		const rows = () => [...host.querySelectorAll<HTMLElement>('.claude-slash-menu .claude-menu-item')];
		picker.show(document.createElement('textarea'), 'slash', '');
		const compact = rows()[0];
		const first = {
			icons: rows().filter(row => row.querySelector(':scope > .codicon')).length,
			compact: [compact.querySelector('.name > .text')?.textContent, compact.querySelector('.name > .hint')?.textContent, compact.querySelector('.desc')?.textContent],
			more: rows().filter(row => row.classList.contains('claude-menu-more')).map(row => row.textContent),
			// Every row but "Show N more" is a command, set in monospace.
			plain: rows().filter(row => !row.classList.contains('claude-slash-command')).map(row => row.textContent),
		};
		// Down past /compact and the four skills shown, to "Show 2 more".
		for (let i = 0; i < 5; i++) {
			picker.move(1);
		}
		const accepted = picker.accept();
		const active = host.querySelector('.claude-menu-item.is-active .name')?.textContent;
		const after = { accepted, open: picker.isOpen, skills: rows().filter(row => row.querySelector('.desc')?.textContent?.endsWith('skill')).length, more: rows().filter(row => row.classList.contains('claude-menu-more')).length, active };
		picker.accept();
		listener.dispose();
		picker.dispose();
		assert.deepStrictEqual({ first, after, picks, closed: picker.isOpen }, {
			// The IDE group gains /split-into-prs (issue 504), /visualize (issue 492), /canvas (issue 1039), /multitask (issue 487), /goal and /loop (issue 486), ten more than it shows, with the four /create-* rows (issue 680) and the four delegate template rows (issue 1110).
			first: { icons: 0, compact: ['/compact', '[instructions]', 'Summarize'], more: ['Show 2 more', 'Show 16 more'], plain: ['Show 2 more', 'Show 16 more'] },
			after: { accepted: undefined, open: true, skills: 6, more: 1, active: '/five' },
			picks: ['cmd:five'],
			closed: false,
		});
	});

	test('issue 488: Use as Mode and Alt+Enter offer a command or skill to pin, never a subagent or an IDE action', () => {
		const host = document.createElement('div');
		const picker = new ClaudeContextPicker(
			{
				showContextView: (delegate: IContextViewDelegate) => {
					const rendered = delegate.render(host);
					return { close: () => { rendered.dispose(); host.textContent = ''; delegate.onHide?.(); } };
				},
			} as unknown as IContextViewService,
			instantiationService.get(IFileService),
			{} as unknown as ISearchService,
			instantiationService.get(IWorkspaceContextService),
			instantiationService.get(IEditorService),
			instantiationService.get(IHistoryService),
			{} as unknown as IOutlineModelService,
			{ read: () => [] } as unknown as IMarkerService,
			{ repositories: [] } as unknown as ISCMService,
			{} as unknown as ITerminalService,
			{
				getCurrentSession: () => ({
					commands: [{ name: 'review-pr', description: 'Review a pull request', source: 'skill' }],
					agents: [{ name: 'tester', description: 'Runs tests' }],
					slashCommands: [],
					skills: [],
				}),
			} as unknown as IClaudeAgentService,
			new TestConfigurationService(),
		);
		const pinned: string[] = [];
		const listener = picker.onDidPinCommand(command => pinned.push(command));
		picker.show(document.createElement('textarea'), 'slash', '');
		const name = (row: Element | null | undefined) => row?.querySelector('.name > .text')?.textContent ?? row?.querySelector('.name')?.textContent;
		const actions = [...host.querySelectorAll<HTMLButtonElement>('.claude-slash-menu .claude-menu-action')].map(button => [name(button.closest('.claude-menu-row')?.querySelector('.claude-menu-item')), button.getAttribute('aria-label')]);
		const active = picker.activeCommand();
		picker.move(1);
		const onSubagent = picker.activeCommand();
		host.querySelector<HTMLButtonElement>('.claude-slash-menu .claude-menu-action')?.click();
		listener.dispose();
		picker.dispose();
		assert.deepStrictEqual({ actions, active, onSubagent, pinned, open: picker.isOpen }, {
			// Only the skill offers it: the subagent and the IDE actions in the list do not.
			actions: [['/review-pr', 'Use as Mode']],
			active: 'review-pr',
			onSubagent: undefined,
			pinned: ['review-pr'],
			open: false,
		});
	});

	test('issue 488: a pinned command runs with every message, a message with its own command runs that one, and the pill unpins it', async () => {
		const pane = openAgentPane();
		const session = agent.getCurrentSession()!;
		agent.setPinnedCommand(session.id, '/review-pr');
		const pill = pane.element.querySelector<HTMLButtonElement>('.claude-pinned-command')!;
		const shown = { hidden: pill.hidden, text: pill.textContent, label: pill.getAttribute('aria-label'), saved: agent.getCurrentSession()?.pinnedCommand };
		const sendText = async (text: string) => {
			const input = composer(pane);
			input.value = text;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			const before = runtime.prompts.length;
			sendButton(pane).click();
			await waitFor(() => runtime.prompts.length > before && !sendButton(pane).classList.contains('is-stop'), `turn for ${text}`);
		};
		await sendText('look at the diff');
		await sendText('/compact');
		pill.click();
		assert.deepStrictEqual({
			shown,
			first: runtime.prompts[0].split('\n\n')[0],
			firstBody: runtime.prompts[0].includes('<ide_request mode="agent">'),
			second: runtime.prompts[1],
			after: { pinned: agent.getCurrentSession()?.pinnedCommand, hidden: pill.hidden },
		}, {
			shown: { hidden: false, text: '/review-pr', label: 'Every message runs /review-pr. Remove', saved: 'review-pr' },
			first: '/review-pr',
			firstBody: true,
			second: '/compact',
			after: { pinned: undefined, hidden: true },
		});
	});

	test('outline symbols attach the full range, not the name', () => {
		const attachment = outlineSymbolAttachment(
			'file:///repo/src/app.ts',
			'foo',
			{ startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 2 },
			{ startLineNumber: 1, startColumn: 10, endLineNumber: 1, endColumn: 13 },
		);
		assert.strictEqual(attachment.kind, 'symbol');
		if (attachment.kind === 'symbol') {
			assert.deepStrictEqual(attachment.range, { startLine: 1, startColumn: 1, endLine: 3, endColumn: 2 });
		}
	});

	test('explain selection labels the turn via the skill, unless templates are preferred', async () => {
		runtime.nextFixture = 'with-skill';
		const pane = openAgentPane();
		const session = agent.getCurrentSession()!;
		await agent.submit(session.id, 'Hi', pane.element.ownerDocument.defaultView ? 'C:\\testWorkspace' : 'C:\\testWorkspace');
		await waitForIdle(pane, 'skill ready');
		instantiationService.stub(IEditorService, {
			activeTextEditorControl: {
				getEditorType: () => EditorType.ICodeEditor,
				getModel: () => ({ uri: URI.file('C:\\testWorkspace\\src\\app.ts'), getVersionId: () => 3 }),
				getSelection: () => ({ isEmpty: () => false, startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 6 }),
			},
		} as unknown as IEditorService);
		const service = new ClaudeActionService(
			agent,
			instantiationService.get(IClaudeContextService),
			instantiationService.get(IEditorService),
			instantiationService.get(IWorkspaceContextService),
			instantiationService.get(IConfigurationService),
			instantiationService.get(INotificationService),
			instantiationService.get(IDialogService),
		);
		await service.run({ id: 'explainSelection', source: 'menu', attachments: [] });
		await waitForIdle(pane, 'That skips the check.');
		const explained = agent.getViewState(session.id).turns[agent.getViewState(session.id).turns.length - 1];
		assert.ok(explained?.user.text.includes('via /explain'), explained?.user.text ?? 'no turn');

		instantiationService.stub(IConfigurationService, {
			getValue: (key?: string) => key === CLAUDE_ACTIONS_PREFER_COMMANDS_SETTING ? false : undefined,
		} as unknown as IConfigurationService);
		const templated = new ClaudeActionService(
			agent,
			instantiationService.get(IClaudeContextService),
			instantiationService.get(IEditorService),
			instantiationService.get(IWorkspaceContextService),
			instantiationService.get(IConfigurationService),
			instantiationService.get(INotificationService),
			instantiationService.get(IDialogService),
		);
		await templated.run({ id: 'explainSelection', source: 'menu', attachments: [] });
		let templateTurn = '';
		for (let attempt = 0; attempt < 40 && !templateTurn.includes('via template'); attempt++) {
			templateTurn = agent.getViewState(session.id).turns.at(-1)?.user.text ?? '';
			await new Promise(resolve => setTimeout(resolve, 15));
		}
		assert.ok(templateTurn.includes('via template'), templateTurn);
	});

	test('review all changes sends without an editor selection, and a preview fix still needs an element', async () => {
		const pane = openAgentPane();
		instantiationService.stub(IEditorService, {
			activeTextEditorControl: undefined,
		} as unknown as IEditorService);
		const service = new ClaudeActionService(
			agent,
			instantiationService.get(IClaudeContextService),
			instantiationService.get(IEditorService),
			instantiationService.get(IWorkspaceContextService),
			instantiationService.get(IConfigurationService),
			instantiationService.get(INotificationService),
			instantiationService.get(IDialogService),
		);
		const session = agent.getCurrentSession()!;
		const before = agent.getViewState(session.id).turns.length;
		await service.run({ id: 'fixPreviewElement', source: 'button', attachments: [] });
		assert.strictEqual(agent.getViewState(session.id).turns.length, before);
		assert.ok(infos.some(message => message.includes('Pick an element')));
		await service.run({ id: 'reviewTurnChanges', source: 'button', attachments: [] });
		await waitForIdle(pane, 'Review changes');
		const reviewed = agent.getViewState(session.id).turns.at(-1);
		assert.ok(reviewed?.user.text.includes('Review changes'), reviewed?.user.text ?? 'no turn');
		assert.ok(!infos.some(message => message.includes('Select some code')));
	});

	test('fix problems is available, and review changes sends without a selection', async () => {
		const pane = openAgentPane();
		const service = new ClaudeActionService(
			agent,
			instantiationService.get(IClaudeContextService),
			instantiationService.get(IEditorService),
			instantiationService.get(IWorkspaceContextService),
			instantiationService.get(IConfigurationService),
			instantiationService.get(INotificationService),
			instantiationService.get(IDialogService),
		);
		await service.run({ id: 'fixProblems', source: 'palette', attachments: [] });
		await waitForIdle(pane, 'Fix problems');
		await service.run({ id: 'reviewChanges', source: 'button', attachments: [] });
		await waitForIdle(pane, 'Review changes');
		const reviewed = agent.getViewState(agent.getCurrentSession()!.id).turns.at(-1);
		assert.ok(reviewed?.user.text.includes('Review changes'), reviewed?.user.text ?? 'no turn');
		assert.ok(!infos.some(message => message.includes('Select some code')));
		assert.deepStrictEqual(service.resolve({ id: 'explainSelection', source: 'menu', attachments: [] }), { kind: 'prompt', templateId: 'explain-selection' });
		assert.deepStrictEqual(service.resolve({ id: 'generateCommitMessage', source: 'button', attachments: [] }), { kind: 'prompt', templateId: 'generate-commit-message' });
	});

	test('the mode pill lists Agent, Plan and Ask with what each may do, applies the choice, and Shift+Tab cycles', async () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		store.add({ dispose: () => host.remove() });
		let rendered: { dispose(): void } | undefined;
		instantiationService.stub(IContextViewService, {
			showContextView: (delegate: IContextViewDelegate) => {
				rendered?.dispose();
				host.textContent = '';
				rendered = delegate.render(host) ?? undefined;
				return { close: () => { rendered?.dispose(); rendered = undefined; host.textContent = ''; delegate.onHide?.(); } };
			},
		} as unknown as IContextViewService);
		const pane = openAgentPane();
		const pill = pane.element.querySelector('button.claude-pill[aria-haspopup="menu"]');
		assert.ok(pill instanceof HTMLButtonElement);
		assert.strictEqual(pill.getAttribute('aria-label'), 'Mode: Agent');
		pill.click();
		const rows = () => [...host.querySelectorAll<HTMLButtonElement>('.claude-mode-menu .claude-menu-item')];
		assert.deepStrictEqual(rows().map(row => [row.querySelector('.name')?.textContent, row.getAttribute('aria-checked'), !!row.querySelector('.desc')?.textContent]), [
			['Agent', 'true', true], ['Plan', 'false', true], ['Ask', 'false', true], ['Debug', 'false', true],
			// Issue 453: one row shows the permission level of every session (Strict by default) and opens Settings.
			['Strict', null, true],
		]);
		// Issue 144: a separator sets off the permission level, and the footer key reads ⇧ Tab on every platform.
		const body = [...host.querySelectorAll('.claude-mode-menu .claude-menu-body > *')].map(child => child.classList.contains('claude-menu-separator') ? '-' : child.querySelector('.name')?.textContent ?? child.textContent);
		// allow-any-unicode-next-line
		assert.deepStrictEqual({ body, footer: [...host.querySelectorAll('.claude-menu-footer kbd')].map(key => key.textContent) }, { body: ['Agent', 'Plan', 'Ask', 'Debug', '-', 'Permissions in Every Session', 'Strict'], footer: ['⇧', 'Tab'] });
		assert.strictEqual(document.activeElement, rows()[0]);
		host.querySelector('.claude-mode-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		assert.strictEqual(document.activeElement, rows()[1]);
		rows()[2].click();
		assert.strictEqual(host.querySelector('.claude-mode-menu'), null);
		assert.strictEqual(agent.getCurrentSession()?.mode, 'ask');
		assert.strictEqual(pill.getAttribute('aria-label'), 'Mode: Ask');
		assert.ok(pill.classList.contains('is-ask'));
		assert.strictEqual(composer(pane).placeholder, 'Ask about the codebase — no files change');

		// Shift+Tab goes on to Debug (issue 484), then back to Agent.
		const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
		composer(pane).dispatchEvent(event);
		assert.strictEqual(event.defaultPrevented, true);
		assert.strictEqual(agent.getCurrentSession()?.mode, 'debug');
		assert.strictEqual(pill.getAttribute('aria-label'), 'Mode: Debug');
		composer(pane).dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
		assert.strictEqual(agent.getCurrentSession()?.mode, 'agent');
		assert.strictEqual(pill.getAttribute('aria-label'), 'Mode: Agent');
	});

	test('a Plan answer is a checklist with notes, and Build runs an Agent turn with the plan and notes', async () => {
		runtime.nextFixture = 'plan';
		const pane = openAgentPane();
		agent.setMode(agent.getCurrentSession()!.id, 'plan');
		const input = composer(pane);
		input.value = 'Add coupon expiry';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForPlan(pane, 'Add expiry');
		const rows = pane.element.querySelectorAll('.claude-plan li.claude-todo');
		assert.deepStrictEqual([...rows].map(row => row.querySelector('.text')?.firstChild?.textContent), ['Check expiresAt in src/coupon.ts', 'Add tests']);
		assert.strictEqual(pane.element.querySelector('.claude-plan .claude-chip .label')?.textContent, 'src/coupon.ts');
		assert.strictEqual(pane.element.querySelector('.claude-msg-assistant'), null);
		const notes = pane.element.querySelector('textarea.claude-plan-notes');
		assert.ok(notes instanceof HTMLTextAreaElement);
		notes.value = 'keep the API';
		notes.dispatchEvent(new Event('input', { bubbles: true }));
		input.value = 'a draft that must survive';
		input.dispatchEvent(new Event('input', { bubbles: true }));

		const build = pane.element.querySelector('button.claude-build');
		assert.ok(build instanceof HTMLButtonElement);
		build.click();
		await waitForIdle(pane, 'Build: Add expiry');
		assert.strictEqual(agent.getCurrentSession()?.mode, 'agent');
		assert.strictEqual(pane.element.querySelector('button.claude-pill[aria-haspopup="menu"]')?.getAttribute('aria-label'), 'Mode: Agent');
		const turns = agent.getViewState(agent.getCurrentSession()!.id).turns;
		assert.strictEqual(turns[1].user.sent?.mode, 'agent');
		assert.ok(turns[1].user.sent?.compiled.includes('Notes from the user:\nkeep the API'));
		const shown = pane.element.querySelectorAll('.claude-msg-user .text');
		assert.strictEqual(shown[shown.length - 1]?.textContent, 'Build: Add expiry\nkeep the API');
		assert.strictEqual(composer(pane).value, 'a draft that must survive');
		assert.strictEqual(pane.element.querySelectorAll('button.claude-build').length, 0);
	});

	test('Build after Edit Plan sends the reordered steps', async () => {
		runtime.nextFixture = 'plan';
		const pane = openAgentPane();
		agent.setMode(agent.getCurrentSession()!.id, 'plan');
		const input = composer(pane);
		input.value = 'Add coupon expiry';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForPlan(pane, 'Add expiry');
		const edit = pane.element.querySelector('button.claude-plan-edit');
		assert.ok(edit instanceof HTMLButtonElement);
		edit.click();
		const first = pane.element.querySelector('input.claude-plan-step-input');
		assert.ok(first instanceof HTMLInputElement);
		first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
		const build = pane.element.querySelector('button.claude-build');
		assert.ok(build instanceof HTMLButtonElement);
		build.click();
		await waitForIdle(pane, 'Build: Add expiry');
		const sent = agent.getViewState(agent.getCurrentSession()!.id).turns[1].user.sent?.compiled ?? '';
		assert.ok(sent.includes('The user edited or reordered the steps of your plan.'));
		assert.ok(sent.includes('1. Add tests\n2. Check expiresAt in src/coupon.ts'));
	});

	test('a usage-limit banner is a warning whose first button, Switch Account..., runs the switch command (issue 450)', async () => {
		const executed: string[] = [];
		instantiationService.stub(ICommandService, {
			executeCommand: async (id: string) => { executed.push(id); return undefined; },
		} as unknown as ICommandService);
		runtime.nextFixture = 'usage-limit';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Why?';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, 'Claude reached its current usage limit.');
		assert.strictEqual(pane.element.querySelector('.claude-banner.is-error'), null);
		const switchAccount = pane.element.querySelector('.claude-banner.is-warning button.claude-limit-action.is-primary');
		assert.ok(switchAccount instanceof HTMLButtonElement);
		switchAccount.click();
		assert.deepStrictEqual(executed.filter(id => id === CLAUDE_SWITCH_ACCOUNT_COMMAND_ID), [CLAUDE_SWITCH_ACCOUNT_COMMAND_ID]);
	});

	test('parallel subagents open as their own read-only chat and can be stopped', async () => {
		runtime.nextFixture = 'parallel-cards';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Investigate login';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, 'Find login');
		await waitForText(pane, 'Review auth');
		assert.strictEqual(pane.element.querySelectorAll('.claude-subagent-group').length, 1);
		assert.strictEqual(pane.element.querySelectorAll('.claude-subagent').length, 2);
		assert.strictEqual(pane.element.textContent?.includes('parent_tool_use_id'), false);
		assert.strictEqual(pane.element.textContent?.includes('"input"'), false);
		const open = pane.element.querySelector('.claude-subagent-open');
		assert.ok(open instanceof HTMLButtonElement);
		open.click();
		await waitForSubagent(pane);
		assert.strictEqual(pane.element.querySelector('.claude-timeline')?.getAttribute('aria-label'), 'Subagent chat, read only');
		const footer = pane.element.querySelector('.claude-pane-footer');
		assert.ok(footer instanceof HTMLElement);
		assert.strictEqual(footer.hidden, true);
		const stop = [...pane.element.querySelectorAll('button')].find(button => button.textContent === 'Stop');
		assert.ok(stop instanceof HTMLButtonElement);
		stop.click();
		await waitForText(pane, 'Partial output is kept.');
		const back = pane.element.querySelector('button.claude-subagent-back');
		assert.ok(back instanceof HTMLButtonElement);
		back.click();
		await waitForText(pane, 'Find login');
		assert.strictEqual((pane.element.querySelector('.claude-pane-footer') as HTMLElement).hidden, false);
	});

	test('Enter streams the answer into the timeline on a later frame', async () => {
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Why is the total wrong?';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const send = sendButton(pane);
		const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		input.dispatchEvent(event);
		assert.strictEqual(event.defaultPrevented, true);
		assert.strictEqual(input.value, '');
		assert.strictEqual(pane.element.querySelector('.claude-msg-user'), null);
		await waitForIdle(pane, 'That skips the check.');
		assert.ok(pane.element.querySelector('.claude-msg-user')?.textContent?.includes('Why is the total wrong?'));
		assert.strictEqual(pane.element.querySelector('.xterm'), null);
		assert.strictEqual(send.classList.contains('is-stop'), false);
		assert.strictEqual(send.getAttribute('aria-label'), 'Send');
	});

	test('a failed turn keeps partial text, and Retry sends it again', async () => {
		runtime.nextFixture = 'crash';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Why?';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, 'Claude stopped unexpectedly.');
		const banner = pane.element.querySelector('.claude-banner.is-error');
		assert.ok(banner?.textContent?.includes('Claude stopped unexpectedly.'));
		assert.ok(banner?.textContent?.includes('process exited'));
		const retry = pane.element.querySelector('button.claude-retry');
		assert.ok(retry instanceof HTMLButtonElement);
		retry.click();
		await waitForIdle(pane, 'That skips the check.');
		assert.ok(pane.element.textContent?.includes('Partial answer'));
	});

	test('a file reference becomes a link and a code block can be copied', async () => {
		runtime.nextFixture = 'with-code';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Show the line';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, 'src/app.ts:12');
		const link = pane.element.querySelector('.claude-file-link');
		assert.ok(link instanceof HTMLElement);
		assert.strictEqual(link.getAttribute('role'), 'link');
		assert.strictEqual(link.tabIndex, 0);
		const copy = pane.element.querySelector('.claude-codeblock button[aria-label="Copy"]');
		assert.ok(copy instanceof HTMLButtonElement);
		copy.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(await clipboard.readText(), 'const n = 1;');
		assert.strictEqual(pane.element.querySelector('.claude-codeblock .claude-file-link'), null);
	});

	test('Enter during a running turn does not stop it', async () => {
		runtime.nextFixture = 'reading';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Look';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, readingRow);
		input.value = 'follow up';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		input.dispatchEvent(event);
		assert.strictEqual(event.defaultPrevented, true);
		await waitForText(pane, 'follow up');
		assert.strictEqual(input.value, '');
		const session = agent.getCurrentSession();
		assert.ok(session);
		assert.strictEqual(agent.getPending(session.id).map(item => item.text).join('\n'), 'follow up');
		assert.strictEqual(agent.getPending(session.id)[0].behavior, 'queue');
		assert.strictEqual(agent.getViewState(session.id).turns.length, 1);
		assert.strictEqual(agent.getViewState(session.id).turns[0].status, 'running');
		assert.strictEqual(sendButton(pane).classList.contains('is-stop'), true);
		assert.strictEqual(sendButton(pane).getAttribute('aria-label'), 'Stop');
		const queue = pane.element.querySelector('button.claude-queue-send');
		assert.ok(queue instanceof HTMLButtonElement);
		assert.ok(queue.textContent?.includes('Queue'));
		assert.strictEqual(pane.element.querySelector('button.claude-steer')?.hasAttribute('hidden'), true);
		// Enter already queues: without Steer the toolbar adds no Queue row (#136).
		assert.strictEqual(pane.element.querySelector('.claude-send-group')?.hasAttribute('hidden'), true);
	});

	test('while Claude waits on a question, the placeholder points to it and Enter sends the text as the reply (issue 537)', async () => {
		runtime.nextFixture = 'ask-question';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Go';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, 'Claude Has a Question');
		const placeholder = input.placeholder;
		input.value = 'Reuse the settings page we have';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		await waitUntil(pane, '', () => runtime.elicitationAnswers.length > 0);
		const session = agent.getCurrentSession()!;
		assert.deepStrictEqual({ placeholder, answers: runtime.elicitationAnswers, input: input.value, queued: agent.getPending(session.id).length }, {
			placeholder: 'Answer Claude\'s question above, or type a reply to send instead',
			answers: [['question-1', { action: 'accept', reply: 'Reuse the settings page we have' }]],
			input: '',
			queued: 0,
		});
	});

	test('a queued follow-up stays editable until the turn ends, then it is sent', async () => {
		runtime.nextFixture = 'reading';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Look';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, readingRow);
		input.value = 'Also add a test';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const queue = pane.element.querySelector('button.claude-queue-send');
		assert.ok(queue instanceof HTMLButtonElement);
		queue.click();
		await waitForText(pane, 'Also add a test');
		const session = agent.getCurrentSession();
		assert.ok(session);
		assert.strictEqual(agent.getViewState(session.id).turns.length, 1);
		assert.strictEqual(input.value, '');
		assert.strictEqual(composer(pane).placeholder, 'Add a follow-up — queued until the agent finishes');

		const edit = pane.element.querySelector('.claude-queue-item button[aria-label="Edit"]');
		assert.ok(edit instanceof HTMLButtonElement);
		edit.click();
		const editor = pane.element.querySelector('input.claude-queue-edit');
		assert.ok(editor instanceof HTMLInputElement);
		editor.value = 'Also add a better test';
		editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		await waitForText(pane, 'Also add a better test');
		assert.strictEqual(agent.getPending(session.id)[0].text, 'Also add a better test');

		input.value = 'second note';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		await waitForText(pane, 'second note');
		assert.strictEqual(agent.getPending(session.id).length, 2);
		const remove = pane.element.querySelectorAll('.claude-queue-item button[aria-label="Delete"]');
		assert.strictEqual(remove.length, 2);
		assert.ok(remove[1] instanceof HTMLButtonElement);
		remove[1].click();
		assert.strictEqual(agent.getPending(session.id).map(item => item.text).join('\n'), 'Also add a better test');

		sendButton(pane).click();
		await waitForText(pane, 'Stopped. Partial output is kept.');
		const turns = agent.getViewState(session.id).turns;
		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].status, 'stopped');
		assert.deepStrictEqual(agent.getPending(session.id).map(item => item.text), ['Also add a better test']);
	});

	test('a draft and its chips survive when a queued follow-up is sent', async () => {
		runtime.stepDelayMs = 30;
		runtime.nextFixture = 'plain-answer';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Look';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitUntil(pane, 'Look', () => sendButton(pane).classList.contains('is-stop'));
		input.value = 'queued note';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const queue = pane.element.querySelector('button.claude-queue-send');
		assert.ok(queue instanceof HTMLButtonElement);
		queue.click();
		await waitForText(pane, 'queued note');
		const session = agent.getCurrentSession();
		assert.ok(session);
		input.value = 'still typing';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		agent.setAttachments(session.id, [{ kind: 'file', uri: 'file:///repo/draft.ts' }]);
		await waitUntil(pane, 'That skips the check.', () => agent.getViewState(session.id).turns[1]?.status === 'complete');
		assert.strictEqual(input.value, 'still typing');
		assert.strictEqual(agent.getCurrentSession()?.draft, 'still typing');
		assert.deepStrictEqual(agent.getCurrentSession()?.attachments, [{ kind: 'file', uri: 'file:///repo/draft.ts' }]);
		assert.ok(pane.element.querySelector('.claude-chip:not(.is-add) .label')?.textContent?.includes('draft.ts'));
		assert.strictEqual(agent.getPending(session.id).length, 0);
	});

	test('queueing keeps the message on the session it was typed in', async () => {
		runtime.nextFixture = 'reading';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Look';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, readingRow);
		let release: () => void = () => undefined;
		holdResolve = new Promise(resolve => { release = resolve; });
		const first = agent.getCurrentSession();
		assert.ok(first);
		input.value = 'follow on first';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const queue = pane.element.querySelector('button.claude-queue-send');
		assert.ok(queue instanceof HTMLButtonElement);
		queue.click();
		const second = agent.createSession();
		assert.strictEqual(input.value, '');
		holdResolve = undefined;
		release();
		for (let i = 0; i < 40 && !agent.getPending(first.id).some(item => item.text === 'follow on first'); i++) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		assert.deepStrictEqual(agent.getPending(first.id).map(item => item.text), ['follow on first']);
		assert.strictEqual(agent.getPending(second.id).length, 0);
		assert.strictEqual(agent.getCurrentSession()?.draft ?? '', '');
		assert.strictEqual(input.value, '');
	});

	test('closing the session while a follow-up is resolving reports the lost message', async () => {
		runtime.nextFixture = 'reading';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Look';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, readingRow);
		let release: () => void = () => undefined;
		holdResolve = new Promise(resolve => { release = resolve; });
		const first = agent.getCurrentSession();
		assert.ok(first);
		input.value = 'do not drop';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const queue = pane.element.querySelector('button.claude-queue-send');
		assert.ok(queue instanceof HTMLButtonElement);
		queue.click();
		agent.closeSession(first.id);
		holdResolve = undefined;
		release();
		await waitUntil(pane, 'Agent', () => notifications.some(message => message.includes('not open')));
		const current = agent.getCurrentSession();
		assert.ok(current);
		assert.notStrictEqual(current.id, first.id);
		assert.strictEqual(current.draft, '');
		assert.strictEqual(input.value, '');
	});

	test('editing a queued item that was removed reports it and keeps chips on one that stays', async () => {
		runtime.nextFixture = 'reading';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Look';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, readingRow);
		const session = agent.getCurrentSession();
		assert.ok(session);
		const chip = { kind: 'file' as const, uri: 'file:///repo/src/app.ts' };
		agent.setAttachments(session.id, [chip]);
		input.value = 'with the file';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const queue = pane.element.querySelector('button.claude-queue-send');
		assert.ok(queue instanceof HTMLButtonElement);
		queue.click();
		await waitForText(pane, 'with the file');
		assert.deepStrictEqual(agent.getPending(session.id)[0].attachments, [chip]);

		const edit = pane.element.querySelector('.claude-queue-item button[aria-label="Edit"]');
		assert.ok(edit instanceof HTMLButtonElement);
		edit.click();
		const editor = pane.element.querySelector('input.claude-queue-edit');
		assert.ok(editor instanceof HTMLInputElement);
		editor.value = 'with the file, edited';
		editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		await waitForText(pane, 'with the file, edited');
		assert.strictEqual(agent.getPending(session.id)[0].text, 'with the file, edited');
		assert.deepStrictEqual(agent.getPending(session.id)[0].attachments, [chip]);

		let release: () => void = () => undefined;
		holdResolve = new Promise(resolve => { release = resolve; });
		const again = pane.element.querySelector('.claude-queue-item button[aria-label="Edit"]');
		assert.ok(again instanceof HTMLButtonElement);
		again.click();
		const secondEdit = pane.element.querySelector('input.claude-queue-edit');
		assert.ok(secondEdit instanceof HTMLInputElement);
		secondEdit.value = 'too late';
		secondEdit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		agent.removePending(session.id, agent.getPending(session.id)[0].id);
		holdResolve = undefined;
		release();
		await waitUntil(pane, readingRow, () => notifications.some(message => message.includes('already sent or removed')));
		assert.strictEqual(agent.getPending(session.id).length, 0);
	});

	test('Steer now delivers into the running turn when the runtime accepts it', async () => {
		runtime.nextFixture = 'reading';
		const steered: string[] = [];
		runtime.canSteer = async () => true;
		runtime.steer = async (_sessionId, text) => {
			steered.push(text);
			return true;
		};
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Look';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitUntil(pane, readingRow, () => {
			const button = pane.element.querySelector('button.claude-steer');
			return button instanceof HTMLButtonElement && !button.hidden;
		});
		const steer = pane.element.querySelector('button.claude-steer');
		assert.ok(steer instanceof HTMLButtonElement);
		input.value = 'Use the helper';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		steer.click();
		await waitUntil(pane, readingRow, () => steered.length === 1);
		assert.ok(steered[0].includes('Use the helper'));
		const session = agent.getCurrentSession();
		assert.ok(session);
		assert.strictEqual(agent.getViewState(session.id).turns.length, 1);
		assert.strictEqual(agent.getViewState(session.id).turns[0].status, 'running');
		assert.strictEqual(agent.getPending(session.id).length, 0);
		assert.strictEqual(input.value, '');
		assert.ok(pane.element.querySelector('.claude-steer-note')?.textContent?.includes('Steered: Use the helper'));
		assert.deepStrictEqual(agent.getViewState(session.id).turns[0].steered, ['Use the helper']);
	});

	test('the Stop button ends a running turn and keeps partial output', async () => {
		runtime.nextFixture = 'reading';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Look';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const send = sendButton(pane);
		send.click();
		await waitForText(pane, readingRow);
		// The running card shows the progress, so no activity line repeats it.
		assert.ok(pane.element.querySelector('.claude-tool.is-running')?.textContent?.includes(readingRow));
		assert.strictEqual(pane.element.querySelector('.claude-activity'), null);
		assert.strictEqual(send.getAttribute('aria-label'), 'Stop');
		assert.strictEqual(send.classList.contains('is-stop'), true);
		send.click();
		await waitForText(pane, 'Stopped. Partial output is kept.');
		assert.ok(pane.element.textContent?.includes('The next message starts a new Claude conversation.'));
		assert.strictEqual(send.classList.contains('is-stop'), false);
		assert.strictEqual(pane.element.querySelector('.xterm'), null);
	});

	test('Retry keeps a typed draft and only the latest turn offers it', async () => {
		runtime.nextFixture = 'reading';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'First';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, readingRow);
		sendButton(pane).click();
		await waitForText(pane, 'Stopped. Partial output is kept.');
		// Stop takes the prompt back for editing; this test keeps the stopped turn and sends a new message.
		agent.discardPendingEdit(agent.getCurrentSession()!.id);

		runtime.nextFixture = 'crash';
		input.value = 'Second';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, 'Claude stopped unexpectedly.');
		const retries = pane.element.querySelectorAll('button.claude-retry');
		assert.strictEqual(retries.length, 1);
		const turns = pane.element.querySelectorAll('.claude-turn');
		assert.strictEqual(turns.length, 2);
		assert.strictEqual(turns[0].querySelector('button.claude-retry'), null);
		assert.ok(turns[1].querySelector('button.claude-retry'));

		input.value = 'keep this draft';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const retry = turns[1].querySelector('button.claude-retry');
		assert.ok(retry instanceof HTMLButtonElement);
		retry.click();
		await waitForIdle(pane, 'That skips the check.');
		assert.strictEqual(input.value, 'keep this draft');
		assert.ok(pane.element.textContent?.includes('Second'));
		assert.strictEqual(agent.getCurrentSession()?.draft, 'keep this draft');
	});

	test('Insert puts the code block at the cursor, and reports when no editor is editable', async () => {
		const inserted: string[] = [];
		let undoStops = 0;
		const editor = {
			hasModel: () => true,
			getOption: (option: EditorOption) => option === EditorOption.readOnly ? false : undefined,
			getSelection: () => ({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 }),
			pushUndoStop: () => { undoStops++; },
			executeEdits: (_source: string, edits: { text: string }[]) => {
				inserted.push(...edits.map(edit => edit.text));
				return true;
			},
			focus: () => undefined,
		};
		instantiationService.stub(ICodeEditorService, {
			getFocusedCodeEditor: () => editor as unknown as ICodeEditor,
			getActiveCodeEditor: () => editor as unknown as ICodeEditor,
		} as unknown as ICodeEditorService);
		runtime.nextFixture = 'with-code';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Show the line';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, 'const n = 1;');
		const insert = pane.element.querySelector('.claude-codeblock button[aria-label="Insert at cursor"]');
		assert.ok(insert instanceof HTMLButtonElement);
		insert.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual(inserted, ['const n = 1;']);
		assert.strictEqual(undoStops, 2);

		instantiationService.stub(ICodeEditorService, {
			getFocusedCodeEditor: () => null,
			getActiveCodeEditor: () => null,
		} as unknown as ICodeEditorService);
		const second = openAgentPane();
		const again = second.element.querySelector('.claude-codeblock button[aria-label="Insert at cursor"]');
		assert.ok(again instanceof HTMLButtonElement);
		again.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.ok(infos.some(message => message.includes('Open an editable file')));
	});

	test('a file link opens the editor at that line', async () => {
		const opened: { path?: string; line?: number; column?: number }[] = [];
		const editors = instantiationService.get(IEditorService);
		const recordOpen = async (editor: { resource?: URI; options?: { selection?: { startLineNumber: number; startColumn: number } } }) => {
			opened.push({
				path: editor.resource?.path,
				line: editor.options?.selection?.startLineNumber,
				column: editor.options?.selection?.startColumn,
			});
			return undefined;
		};
		(editors as { openEditor: typeof recordOpen }).openEditor = recordOpen;
		runtime.nextFixture = 'with-code';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Show the line';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, 'src/app.ts:12');
		const link = pane.element.querySelector('.claude-file-link');
		assert.ok(link instanceof HTMLElement);
		link.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		link.focus();
		link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(opened.length, 2);
		assert.ok(opened[0].path?.endsWith('src/app.ts'));
		assert.strictEqual(opened[0].line, 12);
		assert.strictEqual(opened[0].column, 1);
		assert.strictEqual(opened[1].line, 12);
	});

	test('a streaming repaint keeps focus on the second Copy button', async () => {
		runtime.stepDelayMs = 400;
		runtime.nextFixture = 'two-blocks';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Show both';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, 'const b = 2;');
		const copies = pane.element.querySelectorAll('.claude-codeblock button[aria-label="Copy"]');
		assert.strictEqual(copies.length, 2);
		const second = copies[1];
		assert.ok(second instanceof HTMLButtonElement);
		second.focus();
		assert.strictEqual(document.activeElement, second);
		await waitForText(pane, 'tail');
		await new Promise(resolve => getWindow(pane.element).requestAnimationFrame(() => resolve(undefined)));
		const after = pane.element.querySelectorAll('.claude-codeblock button[aria-label="Copy"]');
		assert.strictEqual(after.length, 2);
		assert.strictEqual(document.activeElement, after[1]);
	});

	test('unsafe Markdown stays inert', async () => {
		runtime.nextFixture = 'unsafe';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Show html';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForIdle(pane, 'plain');
		assert.strictEqual(pane.element.querySelector('script'), null);
		assert.strictEqual(pane.element.querySelector('img'), null);
		assert.strictEqual(pane.element.querySelector('[onerror]'), null);
		assert.strictEqual(pane.element.querySelector('a[href^="command:"]'), null);
		assert.strictEqual(pane.element.querySelector('[data-href^="command:"]'), null);
		assert.ok(!pane.element.innerHTML.includes('onerror'));
		assert.ok(!pane.element.innerHTML.includes('command:'));
	});

	test('a closed failure banner stays closed after switching sessions', async () => {
		runtime.nextFixture = 'crash';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Why?';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, 'Claude stopped unexpectedly.');
		const close = [...pane.element.querySelectorAll('.claude-banner.is-error button')].find(button => button.textContent === 'Close');
		assert.ok(close instanceof HTMLButtonElement);
		const failed = agent.getCurrentSession();
		assert.ok(failed);
		close.click();
		assert.strictEqual(pane.element.querySelector('.claude-banner.is-error'), null);
		agent.createSession();
		agent.selectSession(failed.id);
		await new Promise(resolve => getWindow(pane.element).requestAnimationFrame(() => resolve(undefined)));
		assert.strictEqual(pane.element.querySelector('.claude-banner.is-error'), null);
	});

	test('Pick Model reports a listModels failure', async () => {
		agent.createSession();
		runtime.fail = new Error('runtime down');
		await runPick();
		assert.deepStrictEqual(notifications, ['runtime down']);
		assert.strictEqual(agent.getCurrentSession()?.modelId, undefined);
	});

	async function sendWith(pane: ClaudeAgentViewPane, fixture: string, text = 'Go'): Promise<void> {
		runtime.nextFixture = fixture;
		const input = composer(pane);
		input.value = text;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, 'Allow Once');
	}

	function permissionButton(pane: ClaudeAgentViewPane, label: string): HTMLButtonElement | undefined {
		return [...pane.element.querySelectorAll<HTMLButtonElement>('.claude-permission button')].find(button => button.querySelector('.label')?.textContent === label);
	}

	function permissionLabels(card: Element): (string | null | undefined)[] {
		return [...card.querySelectorAll('.claude-permission-actions button')].map(button => button.querySelector('.label')?.textContent);
	}

	test('a permission card shows the exact command and directory, takes focus, and collapses to a record once answered', async () => {
		const pane = openAgentPane();
		await sendWith(pane, 'ask-command');
		const card = pane.element.querySelector('.claude-permission');
		assert.ok(card);
		assert.strictEqual(card.getAttribute('role'), 'alertdialog');
		assert.strictEqual(card.querySelector('.claude-permission-cmd')?.textContent, 'npm install zod --save-exact');
		assert.ok(card.textContent?.includes('/repo'));
		assert.ok(card.textContent?.includes('Add the validation library'));
		assert.deepStrictEqual(permissionLabels(card), ['Allow Once', 'Allow for Session', 'Deny']);
		assert.strictEqual(document.activeElement, permissionButton(pane, 'Allow Once'));
		// The pending card is the progress; no "Waiting for your approval" line repeats it.
		assert.strictEqual(pane.element.querySelector('.claude-activity'), null);

		permissionButton(pane, 'Allow Once')?.click();
		await waitForText(pane, 'allowed once');
		assert.strictEqual(pane.element.querySelector('.claude-permission'), null);
		assert.strictEqual(pane.element.querySelector('.claude-permission-record .subject')?.textContent, 'npm install zod --save-exact');
	});

	test('a risky command has no session option, starts on Deny, and Escape denies it', async () => {
		const pane = openAgentPane();
		await sendWith(pane, 'ask-danger');
		const card = pane.element.querySelector('.claude-permission');
		assert.ok(card);
		assert.ok(card.classList.contains('is-danger'));
		assert.strictEqual(card.querySelector('.claude-permission-cmd')?.textContent, 'git reset --hard HEAD~3');
		assert.deepStrictEqual(permissionLabels(card), ['Allow Once', 'Deny']);
		assert.strictEqual(document.activeElement, permissionButton(pane, 'Deny'));
		// Enter on a risky card never approves: here it is on Deny, which the browser would press.
		card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		assert.ok(pane.element.querySelector('.claude-permission'));

		// Tab wraps inside the card: forward from the last button, backward from the first.
		const settings = permissionButton(pane, 'Change your permission level in Settings');
		assert.ok(settings);
		settings.focus();
		card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
		assert.strictEqual(document.activeElement, permissionButton(pane, 'Allow Once'));
		card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
		assert.strictEqual(document.activeElement, settings);

		card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await waitForText(pane, 'denied');
		assert.strictEqual(pane.element.querySelector('.claude-permission'), null);
		assert.ok(pane.element.querySelector('.claude-permission-record')?.textContent?.includes('denied'));
	});

	test('Alt+A on a command card turns Allow All Commands on through the permission service and the runtime; the chip turns it off', async () => {
		const pane = openAgentPane();
		await sendWith(pane, 'ask-command-all');
		const card = pane.element.querySelector('.claude-permission');
		assert.ok(card);
		assert.deepStrictEqual(permissionLabels(card), ['Allow Once', 'Allow for Session', 'Allow All Commands', 'Deny']);

		card.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', altKey: true, bubbles: true, cancelable: true }));
		await waitUntil(pane, 'All commands allowed', () => !pane.element.querySelector('.claude-permission'));
		const session = agent.getCurrentSession()!;
		const runtimeId = agent.getRuntimeSessionId(session.id)!;
		assert.deepStrictEqual({
			pane: agent.getSessionPermissions(session.id),
			runtime: runtime.getSessionPermissions(runtimeId),
			card: pane.element.querySelector('.claude-permission'),
			record: pane.element.querySelector('.claude-permission-record .subject')?.textContent,
			chips: [...pane.element.querySelectorAll('.claude-session-switch')].map(chip => chip.className),
		}, {
			pane: { allowAllCommands: true, allowEverything: false },
			runtime: { allowAllCommands: true, allowEverything: false },
			card: null,
			record: 'npm install zod --save-exact',
			chips: ['claude-session-switch is-commands'],
		});

		pane.element.querySelector<HTMLButtonElement>('.claude-session-switch.is-commands')?.click();
		await waitUntil(pane, '', () => !pane.element.querySelector('.claude-session-switch'));
		assert.deepStrictEqual([agent.getSessionPermissions(session.id), runtime.getSessionPermissions(runtimeId)], [NO_SESSION_PERMISSIONS, NO_SESSION_PERMISSIONS]);
	});

	test('picking Allow Everything in Settings warns once, approves the card and shows its badge; an untrusted workspace holds it back (issue 453)', async () => {
		const confirms: string[] = [];
		instantiationService.stub(IDialogService, {
			confirm: async (confirmation: { message: string }) => {
				confirms.push(confirmation.message);
				return { confirmed: true };
			},
		} as unknown as IDialogService);
		agentConfiguration.updateValue = async (key: string, value: unknown) => {
			await agentConfiguration.setUserConfiguration(key, value);
			agentConfiguration.onDidChangeConfigurationEmitter.fire({ affectsConfiguration: (changed: string) => changed === key } as unknown as IConfigurationChangeEvent);
		};
		instantiationService.stub(IConfigurationService, agentConfiguration);
		instantiationService.stub(IClaudePermissionService, store.add(instantiationService.createInstance(ClaudePermissionService)));
		instantiationService.stub(IClaudeElicitationService, instantiationService.createInstance(ClaudeElicitationService));
		const pane = openAgentPane();
		await sendWith(pane, 'ask-command-all');
		await agentConfiguration.updateValue(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, 'allowEverything');
		await waitUntil(pane, '', () => !!pane.element.querySelector('.claude-session-switch.is-everything') && !pane.element.querySelector('.claude-permission'));
		const session = agent.getCurrentSession()!;
		const runtimeId = agent.getRuntimeSessionId(session.id)!;
		const everything = { allowAllCommands: false, allowEverything: true, allowCredentials: true, unasked: true };
		const trusted = {
			confirms,
			pane: agent.getSessionPermissions(session.id),
			runtime: runtime.getSessionPermissions(runtimeId),
			badge: pane.element.querySelector('.claude-session-switch .label')?.textContent,
		};

		trust.set(false);
		await waitUntil(pane, '', () => !pane.element.querySelector('.claude-session-switch'));
		const untrusted = [agent.getSessionPermissions(session.id), runtime.getSessionPermissions(runtimeId)];
		trust.set(true);
		await waitUntil(pane, '', () => !!pane.element.querySelector('.claude-session-switch.is-everything'));
		assert.deepStrictEqual({ trusted, untrusted, again: agent.getSessionPermissions(session.id) }, {
			trusted: { confirms: ['Allow everything in every chat?'], pane: everything, runtime: everything, badge: 'Allow Everything · Bypass' },
			untrusted: [NO_SESSION_PERMISSIONS, NO_SESSION_PERMISSIONS],
			again: everything,
		});
	});

	test('a write outside the workspace shows the absolute target', async () => {
		const pane = openAgentPane();
		await sendWith(pane, 'ask-outside');
		const card = pane.element.querySelector('.claude-permission');
		assert.strictEqual(card?.querySelector('.claude-permission-cmd')?.textContent, '/Users/me/.config/shop/settings.json');
		assert.ok(card?.querySelector('.claude-permission-head')?.textContent?.includes('outside this workspace'));
		assert.deepStrictEqual(permissionLabels(card!), ['Allow Once', 'Deny']);
	});

	test('Stop while a card is open leaves it recorded as denied', async () => {
		const pane = openAgentPane();
		await sendWith(pane, 'ask-command');
		sendButton(pane).click();
		await waitForText(pane, 'Stopped. Partial output is kept.');
		assert.strictEqual(pane.element.querySelector('.claude-permission'), null);
		assert.ok(pane.element.querySelector('.claude-permission-record')?.textContent?.includes('denied, session stopped'));
	});

	test('a command card copies, opens a terminal, re-runs through history, and opens the full log once', async function () {
		// The wait for the log button below allows 45 s, so mocha's 20 s suite timeout cut it off and reported an opaque timeout instead of the wait's own message (issue 1562).
		this.timeout(60_000);
		const pane = openAgentPane();
		runtime.nextFixture = 'command-card';
		const input = composer(pane);
		input.value = 'Run status';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForIdle(pane, 'git status');
		if (!pane.element.querySelector('.claude-terminal')) {
			const summary = pane.element.querySelector('button.claude-tool-row');
			assert.ok(summary instanceof HTMLButtonElement);
			summary.click();
		}
		const copy = pane.element.querySelector('button[aria-label="Copy command"]');
		assert.ok(copy instanceof HTMLButtonElement);
		copy.click();
		assert.strictEqual(await clipboard.readText(), 'git status');
		const openTerminal = pane.element.querySelector('button[aria-label="Open in Terminal"]');
		assert.ok(openTerminal instanceof HTMLButtonElement);
		openTerminal.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(terminals[0]?.cwd, TestWorkspace.folders[0].uri.fsPath);
		const logged = commandLog.length;
		assert.ok(logged > 0);
		assert.strictEqual(commandLog.filter(line => line.includes('On branch')).length, 1);
		// The footer shows the log button once the card paints its output lines, which can be a frame after idle (frames run slowly in the hidden Windows test window, and a batch run on a busy runner stalled past 10 s once, so this wait is longer).
		await waitFor(() => !!pane.element.querySelector('button[aria-label="Open full log"]'), 'the Open full log button', 45_000);
		const fullLog = pane.element.querySelector('button[aria-label="Open full log"]');
		assert.ok(fullLog instanceof HTMLButtonElement);
		fullLog.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(shownChannel, CLAUDE_COMMAND_LOG_CHANNEL_ID);
		assert.strictEqual(commandLog.length, logged);
		const rerun = pane.element.querySelector('button[aria-label="Re-run"]');
		assert.ok(rerun instanceof HTMLButtonElement);
		rerun.click();
		for (let i = 0; i < 30 && terminals.at(-1)?.text !== 'git status'; i++) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		assert.deepStrictEqual({ text: terminals.at(-1)?.text, shown: terminals.at(-1)?.shown }, { text: 'git status', shown: true });
		const history = instantiationService.get(IClaudePermissionService).getHistory(agent.getCurrentSession()!.id);
		assert.ok(history.some(entry => entry.command === 'git status' && entry.state === 'allowed' && entry.source === 'policy'));
	});

	test('inspector filters and copy survive a timeline repaint', async () => {
		const pane = openAgentPane();
		runtime.nextFixture = 'parallel-cards';
		const input = composer(pane);
		input.value = 'Investigate login';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, 'Find login');
		pane.widget?.openInspector();
		await waitForText(pane, 'Copy as JSON');
		const openSubagent = pane.element.querySelector('.claude-subagent-open');
		assert.ok(openSubagent instanceof HTMLButtonElement);
		openSubagent.click();
		await waitForSubagent(pane);
		const tools = [...pane.element.querySelectorAll('button')].find(button => button.textContent === 'Tools');
		assert.ok(tools instanceof HTMLButtonElement);
		tools.click();
		const pressed = [...pane.element.querySelectorAll('button')].find(button => button.textContent === 'Tools');
		assert.strictEqual(pressed?.getAttribute('aria-pressed'), 'true');
		assert.strictEqual(pane.element.querySelector('.claude-inspector-list')?.textContent?.includes('Read'), true);
		const copy = [...pane.element.querySelectorAll('button')].find(button => button.textContent === 'Copy as JSON');
		assert.ok(copy instanceof HTMLButtonElement);
		copy.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		const parsed = JSON.parse(await clipboard.readText()) as { event: { type?: string } }[];
		assert.ok(parsed.length > 0);
		assert.ok(parsed.every(row => row.event.type?.startsWith('tool.') || row.event.type === 'subagent.started' || row.event.type === 'subagent.finished'));
	});

	test('a running command with enough output stays on the tail', async () => {
		const pane = openAgentPane();
		runtime.nextFixture = 'long-command';
		const input = composer(pane);
		input.value = 'Run status';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, 'line 39');
		const scroller = pane.element.querySelector('.claude-terminal');
		assert.ok(scroller instanceof HTMLElement);
		const max = scroller.scrollHeight - scroller.clientHeight;
		assert.ok(max > 0);
		// At a fractional display scale (125%) scrollTop is fractional while the scroll range is whole pixels.
		assert.ok(Math.abs(scroller.scrollTop - max) < 1, `${scroller.scrollTop} vs ${max}`);
		assert.ok(scroller.querySelector('pre')?.textContent?.includes('line 39'));
	});

	test('a long command log keeps only the unstreamed tail and redacts a secret', async () => {
		const pane = openAgentPane();
		runtime.nextFixture = 'long-secret-command';
		const input = composer(pane);
		input.value = 'Run status';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitUntil(pane, 'npm test', () => {
			const session = agent.getCurrentSession();
			const card = session ? agent.getViewState(session.id).turns[0]?.cards[0] : undefined;
			return card?.state === 'success' && card.lines[card.lines.length - 1] === '[redacted]' && !JSON.stringify(card).includes('sk-ant-api03-testsecretvalue');
		});
		const joined = commandLog.join('');
		assert.strictEqual(joined.includes('sk-ant-api03-testsecretvalue'), false);
		assert.strictEqual(joined.split('line 200').length - 1, 1);
		assert.ok(joined.includes('[redacted]'));
		assert.strictEqual(pane.element.textContent?.includes('sk-ant-api03-testsecretvalue'), false);
	});

	test('a grandchild permission is the last event and still repaints', () => {
		const root = document.createElement('div');
		document.body.appendChild(root);
		store.add({ dispose: () => root.remove() });
		const style = document.createElement('style');
		// A running command shows a 5-line tail and follows it (the pane's spacing tokens are not defined here).
		style.textContent = '.claude-terminal{max-height:180px;overflow:auto;line-height:17px;white-space:pre;}.claude-tool.is-command.is-running .claude-terminal{max-height:85px;overflow-y:hidden;}';
		document.head.appendChild(style);
		store.add({ dispose: () => style.remove() });
		const renderer = store.add(instantiationService.createInstance(ClaudeTimelineRenderer, root, {
			retry: () => undefined,
			build: async () => undefined,
			respondPermission: async () => undefined,
			openSubagent: () => undefined,
			stopSubagent: () => undefined,
			copyCommand: () => undefined,
			openInTerminal: () => undefined,
			rerunCommand: () => undefined,
			openCommandLog: () => undefined,
		}));
		const before = grandchildState(false);
		const after = grandchildState(true);
		renderer.render(before);
		assert.strictEqual(root.textContent?.includes('planner wants to run'), false);
		renderer.render(after);
		assert.ok(root.textContent?.includes('planner wants to run `npm test`'));
		renderer.render(before, 'run-outer');
		assert.strictEqual(root.textContent?.includes('planner wants to run'), false);
		renderer.render(after, 'run-outer');
		assert.ok(root.textContent?.includes('planner wants to run `npm test`'));

		root.replaceChildren();
		renderer.reset();
		let scrolling = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text: 'Run' });
		scrolling = reduceAgentState(scrolling, shellCall());
		scrolling = reduceAgentState(scrolling, shellUpdate(Array.from({ length: 40 }, (_value, index) => `row ${index}`).join('\n')));
		renderer.render(scrolling);
		const first = root.querySelector('.claude-terminal');
		assert.ok(first instanceof HTMLElement);
		assert.ok(first.scrollHeight - first.clientHeight > 0);
		assert.ok(Math.abs(first.scrollTop - (first.scrollHeight - first.clientHeight)) < 1, `${first.scrollTop}`);
		scrolling = reduceAgentState(scrolling, shellUpdate(Array.from({ length: 20 }, (_value, index) => `extra ${index}`).join('\n')));
		renderer.render(scrolling);
		const second = root.querySelector('.claude-terminal');
		assert.ok(second instanceof HTMLElement);
		assert.ok(Math.abs(second.scrollTop - (second.scrollHeight - second.clientHeight)) < 1, `${second.scrollTop}`);
		assert.ok(second.querySelector('pre')?.textContent?.includes('extra 19'));
	});

	test('the inspector filters, copies objects, and hides raw messages until retention is on', async () => {
		const pane = openAgentPane();
		await sendWith(pane, 'ask-command');
		pane.widget?.openInspector();
		await waitForText(pane, 'All');
		assert.strictEqual(pane.element.querySelector('[data-kind="raw"]'), null);
		const copy = [...pane.element.querySelectorAll('button')].find(button => button.textContent === 'Copy as JSON');
		assert.ok(copy instanceof HTMLButtonElement);
		copy.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		const parsed = JSON.parse(await clipboard.readText()) as { event: unknown }[];
		assert.ok(parsed.length > 0);
		assert.strictEqual(typeof parsed[0].event, 'object');
		const tools = [...pane.element.querySelectorAll('button')].find(button => button.textContent === 'Tools');
		assert.ok(tools instanceof HTMLButtonElement);
		tools.click();
		assert.strictEqual(pane.element.querySelector('.claude-inspector-list')?.textContent?.includes('Permission'), false);
	});

	test('a nested subagent permission shows on the parent and in the subagent view', async () => {
		const pane = openAgentPane();
		runtime.nextFixture = 'nested-permission';
		const input = composer(pane);
		input.value = 'Look';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, 'reviewer: this command can delete data');
		const open = pane.element.querySelector('.claude-subagent-open');
		assert.ok(open instanceof HTMLButtonElement);
		open.click();
		await waitForSubagent(pane);
		assert.ok(pane.element.textContent?.includes('reviewer: this command can delete data'));
	});

	test('a running subagent elapsed time updates without replacing the card', async () => {
		const pane = openAgentPane();
		runtime.nextFixture = 'parallel-cards';
		const input = composer(pane);
		input.value = 'Investigate login';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		// Hold until the fixture has replayed its last event (run-b's Grep): an event that lands
		// later rebuilds the cards on purpose, which is not what this test measures (issue 296).
		await waitUntil(pane, 'Review auth', () => !!pane.element.querySelector('.claude-subagent[data-run-id="run-b"] .latest'));
		const elapsed = pane.element.querySelector('.claude-elapsed');
		assert.ok(elapsed instanceof HTMLElement);
		const first = elapsed.textContent;
		// Wait for the next tick of the one-second timer instead of sleeping a fixed time.
		await waitUntil(pane, '', () => pane.element.querySelector('.claude-elapsed') !== elapsed || elapsed.textContent !== first);
		assert.deepStrictEqual({ same: pane.element.querySelector('.claude-elapsed') === elapsed, ticked: elapsed.textContent !== first }, { same: true, ticked: true });
	});

	test('opening the inspector does not rebuild the subagent breadcrumb', async () => {
		const pane = openAgentPane();
		runtime.nextFixture = 'parallel-cards';
		const input = composer(pane);
		input.value = 'Investigate login';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, 'Find login');
		const openSubagent = pane.element.querySelector('.claude-subagent-open');
		assert.ok(openSubagent instanceof HTMLButtonElement);
		openSubagent.click();
		await waitForSubagent(pane);
		const back = pane.element.querySelector('button.claude-subagent-back');
		assert.ok(back instanceof HTMLButtonElement);
		back.focus();
		pane.widget?.openInspector();
		assert.strictEqual(document.activeElement, back);
		assert.strictEqual(pane.element.querySelector('button.claude-subagent-back'), back);
	});

	test('a right-click on selected reply text offers Copy and Quote in Reply (issue 468)', async () => {
		const shown: { label: string; run: () => unknown }[] = [];
		instantiationService.stub(IContextMenuService, {
			showContextMenu: (delegate: { getActions(): readonly { label: string; run(): unknown }[] }) => {
				shown.length = 0;
				shown.push(...delegate.getActions().map(action => ({ label: action.label, run: () => action.run() })));
			},
		} as unknown as IContextMenuService);
		runtime.nextFixture = 'plain-answer';
		const pane = openAgentPane();
		const input = composer(pane);
		input.value = 'Go';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForIdle(pane, 'That skips the check.');
		const reply = pane.element.querySelector('.claude-msg-assistant');
		assert.ok(reply instanceof HTMLElement);
		// Nothing selected: the timeline keeps the default menu.
		reply.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		assert.strictEqual(shown.length, 0);
		const walker = document.createTreeWalker(reply, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node && !node.textContent?.includes('That skips the check.')) {
			node = walker.nextNode();
		}
		assert.ok(node?.textContent);
		const start = node.textContent.indexOf('That skips the check.');
		const range = document.createRange();
		range.setStart(node, start);
		range.setEnd(node, start + 'That skips the check.'.length);
		const selection = document.getSelection();
		assert.ok(selection);
		selection.removeAllRanges();
		selection.addRange(range);
		reply.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		assert.deepStrictEqual(shown.map(action => action.label), ['Copy', 'Quote in Reply']);
		await shown[0].run();
		input.value = 'Also';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		shown[1].run();
		selection.removeAllRanges();
		assert.deepStrictEqual([await clipboard.readText(), input.value, document.activeElement === input], ['That skips the check.', 'Also\n\n> That skips the check.\n\n', true]);
	});

	test('a chat chip toggles Summary and Full transcript', () => {
		const shown: { label: string; enabled: boolean; run: () => unknown }[] = [];
		instantiationService.stub(IContextMenuService, {
			showContextMenu: (delegate: { getActions(): readonly { label: string; enabled: boolean; run(): unknown }[] }) => {
				shown.length = 0;
				shown.push(...delegate.getActions().map(action => ({ label: action.label, enabled: action.enabled, run: () => action.run() })));
			},
		} as unknown as IContextMenuService);
		const pane = openAgentPane();
		const session = agent.getCurrentSession();
		assert.ok(session);
		agent.setAttachments(session.id, [{
			kind: 'chat',
			sessionId: 'other-chat',
			scope: 'summary',
			asOfTurn: 2,
			turnRange: [2, 2],
			title: 'Fix login',
		}]);
		const chip = pane.element.querySelector('.claude-chip:not(.is-add)');
		assert.ok(chip instanceof HTMLElement);
		chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		const full = shown.find(action => action.label === 'Full transcript');
		const summary = shown.find(action => action.label === 'Summary');
		assert.ok(full);
		assert.ok(summary);
		assert.strictEqual(summary.enabled, false);
		assert.strictEqual(full.enabled, true);
		full.run();
		const large = pane.element.querySelector('.claude-chip.is-large');
		assert.ok(large instanceof HTMLElement);
		const fullAttachment = agent.getCurrentSession()?.attachments[0];
		assert.ok(fullAttachment?.kind === 'chat' && fullAttachment.scope === 'full');
		large.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		const summaryAgain = shown.find(action => action.label === 'Summary');
		assert.strictEqual(summaryAgain?.enabled, true);
		summaryAgain?.run();
		assert.strictEqual(pane.element.querySelector('.claude-chip.is-large'), null);
		const summaryAttachment = agent.getCurrentSession()?.attachments[0];
		assert.ok(summaryAttachment?.kind === 'chat' && summaryAttachment.scope === 'summary');
	});

	test('a request blocked by policy is a note, not a prompt', async () => {
		const pane = openAgentPane();
		runtime.nextFixture = 'blocked';
		const input = composer(pane);
		input.value = 'Go';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForText(pane, 'Write blocked');
		assert.strictEqual(pane.element.querySelector('.claude-permission'), null);
		assert.ok(pane.element.querySelector('.claude-banner.is-info:not(.claude-plugin-restart):not(.claude-handoff-card)')?.textContent?.includes('Ask mode is read-only'));
	});

	test('Switch to Agent and Retry on a write Ask blocked sends the same request again in Agent mode', async () => {
		const pane = openAgentPane();
		agent.setMode(agent.getCurrentSession()!.id, 'ask');
		runtime.nextFixture = 'blocked-ask';
		const input = composer(pane);
		input.value = 'Rename the handler';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		sendButton(pane).click();
		await waitForIdle(pane, 'Write blocked: Ask mode does not change this file');
		const retry = pane.element.querySelector('button.claude-switch-retry');
		assert.ok(retry instanceof HTMLButtonElement);
		retry.click();
		await waitForIdle(pane, 'The handler returns early.');
		const turns = agent.getViewState(agent.getCurrentSession()!.id).turns;
		assert.deepStrictEqual({
			mode: agent.getCurrentSession()?.mode,
			text: turns.at(-1)?.user.text,
			sentMode: turns.at(-1)?.user.sent?.mode,
			agentPrompt: turns.at(-1)?.user.sent?.compiled.includes('<ide_request mode="agent">'),
			askInstructions: turns.at(-1)?.user.sent?.compiled.includes('Ask mode never changes files'),
			pill: pane.element.querySelector('button.claude-pill[aria-haspopup="menu"]')?.getAttribute('aria-label'),
		}, { mode: 'agent', text: 'Rename the handler', sentMode: 'agent', agentPrompt: true, askInstructions: false, pill: 'Mode: Agent' });
	});

	test('the setup card replaces the composer while Claude is missing or signed out', () => {
		const setup = new TestClaudeSetupService({ installed: false, authenticated: false, error: 'Claude Code is not installed.' });
		store.add(setup);
		instantiationService.stub(IClaudeSetupService, setup);
		const pane = openAgentPane();
		const footer = pane.element.querySelector('.claude-pane-footer') as HTMLElement;
		const host = pane.element.querySelector('.claude-setup-host') as HTMLElement;
		const region = host.querySelector('[role="region"]');
		assert.deepStrictEqual({
			footerHidden: footer.hidden,
			hostHidden: host.hidden,
			label: region ? pane.element.querySelector(`#${region.getAttribute('aria-labelledby')}`)?.textContent : undefined,
			emptyState: pane.element.querySelector('.claude-timeline .claude-empty') !== null,
		}, { footerHidden: true, hostHidden: false, label: 'Set up Claude to use the agent', emptyState: false });

		pane.focus();
		assert.strictEqual(document.activeElement?.textContent, 'Install Claude Code');
		([...host.querySelectorAll('button')].find(button => button.textContent === 'Continue without AI') as HTMLButtonElement).click();
		assert.deepStrictEqual(setup.calls, ['continueWithoutAI']);

		setup.set({ installed: true, authenticated: false, version: '2.1.0', binaryPath: '/usr/local/bin/claude' });
		assert.ok(host.textContent?.includes('Claude Code 2.1.0 found'));
		assert.ok(host.textContent?.includes('/usr/local/bin/claude'));
		setup.set({ installed: true, authenticated: true, version: '2.1.0' });
		assert.deepStrictEqual({ footerHidden: footer.hidden, hostHidden: host.hidden, emptyState: pane.element.querySelector('.claude-timeline .claude-empty') !== null }, { footerHidden: false, hostHidden: true, emptyState: true });
	});

	test('ide-03: while the chat is in an editor tab the Agent view hands it over, and takes it back when the tab closes', () => {
		let inEditor = false;
		const changes: (() => void)[] = [];
		instantiationService.stub(IEditorService, 'findEditors', () => inEditor ? [CLAUDE_AGENT_VIEW_ID] : []);
		instantiationService.stub(IEditorService, 'onDidEditorsChange', (listener: () => void) => {
			changes.push(listener);
			return { dispose() { } };
		});
		const executed: string[] = [];
		instantiationService.stub(ICommandService, {
			executeCommand: async (id: string) => { executed.push(id); return undefined; },
		} as unknown as ICommandService);
		const pane = openAgentPane();
		const state = () => ({
			chat: pane.widget !== undefined && pane.element.querySelector('.claude-pane') !== null,
			moved: pane.element.querySelector('.claude-chat-moved p')?.textContent ?? '',
			buttons: [...pane.element.querySelectorAll('.claude-chat-moved button')].map(button => button.textContent),
		});
		const before = state();
		inEditor = true;
		changes.forEach(listener => listener());
		const moved = state();
		pane.focus();
		const focused = document.activeElement?.textContent;
		pane.element.querySelectorAll<HTMLButtonElement>('.claude-chat-moved button').forEach(button => button.click());
		inEditor = false;
		changes.forEach(listener => listener());
		assert.deepStrictEqual({ before, moved, focused, executed, after: state() }, {
			before: { chat: true, moved: '', buttons: [] },
			moved: { chat: false, moved: 'The chat is open in an editor tab.', buttons: ['Show Chat', 'Move Chat Here'] },
			focused: 'Show Chat',
			executed: [CLAUDE_OPEN_CHAT_IN_EDITOR_COMMAND_ID, CLAUDE_MOVE_CHAT_TO_SIDE_BAR_COMMAND_ID],
			after: { chat: true, moved: '', buttons: [] },
		});
	});

	test('ide-03: the chat editor tab hosts the chat, is named after the session, offers the way back, and drops the chat when hidden', async () => {
		const editor = store.add(instantiationService.createInstance(ClaudeAgentEditor, new TestEditorGroupView(0)));
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		store.add({ dispose: () => parent.remove() });
		editor.create(parent);
		const input = store.add(instantiationService.createInstance(ClaudeAgentEditorInput));
		await editor.setInput(input, undefined, {}, CancellationToken.None);
		editor.layout(new Dimension(640, 480));
		const session = agent.getCurrentSession()!;
		await agent.renameSession(session.id, 'Fix the coupon bug');
		const shown = { chat: editor.widget !== undefined && parent.querySelector('.claude-agent-editor .claude-pane') !== null, name: input.getName(), moveBack: editor.widget?.getMoreActions().some(action => action.id === CLAUDE_MOVE_CHAT_TO_SIDE_BAR_COMMAND_ID) };
		editor.clearInput();
		assert.deepStrictEqual({ shown, hidden: { chat: editor.widget !== undefined || parent.querySelector('.claude-pane') !== null } }, {
			shown: { chat: true, name: 'Fix the coupon bug', moveBack: true },
			hidden: { chat: false },
		});
	});

	test('ide-04: the chat editor tab shows the goal or loop of the session as a pill (issue 888)', () => {
		if (!agent.getCurrentSession()) {
			agent.createSession();
		}
		const goal = { status: 'running', turn: 2, maxTurns: 10 };
		let view: unknown = goal;
		let loop: unknown;
		instantiationService.stub(IClaudeGoalLoopService, { onDidChange: () => ({ dispose() { } }), getGoal: () => view, getLoop: () => loop } as unknown as IClaudeGoalLoopService);
		const input = store.add(instantiationService.createInstance(ClaudeAgentEditorInput));
		const running = input.getDescription();
		view = { status: 'met', turn: 3, maxTurns: 10 };
		const met = input.getDescription();
		view = undefined;
		loop = { status: 'waiting', runs: 4 };
		const looping = input.getDescription();
		loop = undefined;
		assert.deepStrictEqual({ running, met, looping, none: input.getDescription() }, { running: 'Goal 2/10', met: 'Goal met', looping: 'Loop ×4', none: undefined });
	});

	test('ide-05: the goal pill has a tooltip, says why a goal stopped, and Goal met clears when the chat is next opened (issue 1080)', () => {
		const session = agent.getCurrentSession() ?? agent.createSession();
		let view: unknown = { status: 'running', turn: 2, maxTurns: 5 };
		const stopped: string[] = [];
		const activeChange = store.add(new Emitter<void>());
		const shown: { active?: unknown } = {};
		instantiationService.stub(IEditorService, { onDidActiveEditorChange: activeChange.event, get activeEditor() { return shown.active; } } as unknown as IEditorService);
		instantiationService.stub(IClaudeGoalLoopService, { onDidChange: () => ({ dispose() { } }), getGoal: () => view, getLoop: () => undefined, getEnded: () => undefined, stop: (id: string) => { stopped.push(id); } } as unknown as IClaudeGoalLoopService);
		const input = instantiationService.createInstance(ClaudeAgentEditorInput);
		store.add(input);
		const running = { pill: input.getDescription(), tip: input.getTitle().split('\n')[1] };
		view = { status: 'limit', reason: 'max-turns', turn: 5, maxTurns: 5, goal: { kind: 'goal', outcome: 'ship it' } };
		const limit = { pill: input.getDescription(), tip: input.getTitle().split('\n')[1].replace(/ at [^.]*\. /, ' at TIME. ') };
		view = { status: 'limit', reason: 'budget', turn: 3, maxTurns: 5 };
		const budget = input.getDescription();
		view = { status: 'met', turn: 3, maxTurns: 5 };
		input.getDescription();
		shown.active = input;
		activeChange.fire();
		const cleared = [...stopped];
		assert.deepStrictEqual({ running, limit, budget, session: !!session }, {
			running: { pill: 'Goal 2/5', tip: 'Goal: turn 2 of 5' },
			limit: { pill: 'Goal stopped: 5 turns', tip: 'Goal not finished: reached the turn limit (5 turns) at TIME. ship it' },
			budget: 'Goal stopped: spend limit',
			session: true,
		});
		assert.deepStrictEqual({ before: [], cleared }, { before: [], cleared: [session.id] });
	});

	test('ide-05b: Edit Goal... also edits a goal that hit its limit, from the chat notice (issue 1117)', () => {
		const session = agent.getCurrentSession() ?? agent.createSession();
		const edited: unknown[][] = [];
		instantiationService.stub(ICommandService, { executeCommand: (...args: unknown[]) => { edited.push(args); return Promise.resolve(); } } as unknown as ICommandService);
		const ended = { status: 'limit', reason: 'budget', turn: 2, maxTurns: 5, goal: { kind: 'goal', outcome: 'make npm test pass' } };
		instantiationService.stub(IClaudeGoalLoopService, { onDidChange: () => ({ dispose() { } }), getGoal: () => undefined, getLoop: () => undefined, getEnded: (id: string) => id === session.id ? { view: ended, at: 0 } : undefined } as unknown as IClaudeGoalLoopService);
		store.add(instantiationService.createInstance(ClaudeAgentEditorInput));
		instantiationService.invokeFunction(accessor => CommandsRegistry.getCommand(CLAUDE_EDIT_GOAL_COMMAND_ID)!.handler(accessor));
		assert.deepStrictEqual(edited, [[CLAUDE_START_GOAL_COMMAND_ID, 'make npm test pass']]);
	});

	test('ide-06: an ended goal shows on the chat editor tab as an icon, so a truncated title still says it (issue 1102)', () => {
		if (!agent.getCurrentSession()) {
			agent.createSession();
		}
		let view: unknown;
		instantiationService.stub(IClaudeGoalLoopService, { onDidChange: () => ({ dispose() { } }), getGoal: () => view, getLoop: () => undefined, getEnded: () => undefined } as unknown as IClaudeGoalLoopService);
		const input = store.add(instantiationService.createInstance(ClaudeAgentEditorInput));
		const icon = (status?: string) => { view = status && { status, turn: 1, maxTurns: 5 }; return (input.getIcon() as { id: string }).id; };
		assert.deepStrictEqual({ none: icon(), running: icon('running'), met: icon('met'), limit: icon('limit') }, { none: 'sparkle', running: 'sparkle', met: 'pass-filled', limit: 'warning' });
	});

	test('ide-07: Stop Goal and Edit Goal are in the Command Palette, act on a running or paused goal and say so (issues 1099, 1116)', () => {
		const session = agent.getCurrentSession() ?? agent.createSession();
		let view: unknown;
		const stopped: string[] = [];
		const told: string[] = [];
		const edited: unknown[][] = [];
		const changed = store.add(new Emitter<string>());
		instantiationService.stub(INotificationService, { info: (message: string) => { told.push(message); } } as unknown as INotificationService);
		instantiationService.stub(ICommandService, { executeCommand: (...args: unknown[]) => { edited.push(args); return Promise.resolve(); } } as unknown as ICommandService);
		instantiationService.stub(IClaudeGoalLoopService, { onDidChange: changed.event, getGoal: () => view, getLoop: () => undefined, getEnded: () => undefined, stop: (id: string, kind: string) => { stopped.push(`${id}:${kind}`); } } as unknown as IClaudeGoalLoopService);
		const keys = instantiationService.get(IContextKeyService);
		store.add(instantiationService.createInstance(ClaudeAgentEditorInput));
		const enabled = () => !!keys.contextMatchesRules(CLAUDE_GOAL_RUNNING);
		const run = (id: string) => instantiationService.invokeFunction(accessor => CommandsRegistry.getCommand(id)!.handler(accessor));
		const none = enabled();
		run(CLAUDE_STOP_GOAL_COMMAND_ID);
		run(CLAUDE_EDIT_GOAL_COMMAND_ID);
		view = { status: 'paused', turn: 2, maxTurns: 5, goal: { kind: 'goal', outcome: 'make npm test pass', check: 'npm test' } };
		changed.fire(session.id);
		const paused = enabled();
		run(CLAUDE_EDIT_GOAL_COMMAND_ID);
		run(CLAUDE_STOP_GOAL_COMMAND_ID);
		const titleOf = (t: string | { value: string } | undefined) => typeof t === 'string' ? t : t?.value;
		const tabEdit = MenuRegistry.getMenuItems(MenuId.EditorTitleContext).find(item => isIMenuItem(item) && item.command.id === 'claude.tabEditGoal');
		const registered = [...[CLAUDE_STOP_GOAL_COMMAND_ID, CLAUDE_EDIT_GOAL_COMMAND_ID].map(id => titleOf(MenuRegistry.getCommand(id)?.title)), titleOf(tabEdit && isIMenuItem(tabEdit) ? tabEdit.command.title : undefined)];
		const palette = [CLAUDE_STOP_GOAL_COMMAND_ID, CLAUDE_EDIT_GOAL_COMMAND_ID, CLAUDE_RESUME_GOAL_COMMAND_ID].map(id => MenuRegistry.getMenuItems(MenuId.CommandPalette).some(item => isIMenuItem(item) && item.command.id === id));
		assert.deepStrictEqual({ none, paused, registered, palette, stopped, told, edited }, {
			none: false,
			paused: true,
			registered: ['Stop Goal', 'Edit Goal...', 'Edit Goal...'],
			palette: [true, true, true],
			stopped: [`${session.id}:goal`],
			told: ['This chat has no active goal. Use Start Goal to begin one.', 'This chat has no active goal. Use Start Goal to begin one.', 'Goal stopped: make npm test pass'],
			edited: [[CLAUDE_START_GOAL_COMMAND_ID, 'make npm test pass --check npm test']],
		});
	});

	function openAgentPane(): ClaudeAgentViewPane {
		const pane = store.add(instantiationService.createInstance(ClaudeAgentViewPane, {
			id: CLAUDE_AGENT_VIEW_ID,
			title: 'Agent',
		}));
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		store.add({ dispose: () => parent.remove() });
		pane.render();
		parent.appendChild(pane.element);
		pane.orthogonalSize = 320;
		pane.layout(480);
		return pane;
	}

	async function runPick(): Promise<void> {
		await instantiationService.invokeFunction(accessor => {
			return CommandsRegistry.getCommand(CLAUDE_PICK_MODEL_COMMAND_ID)?.handler(accessor);
		});
	}
});

function dropResources(target: Element, resources: string[]): void {
	const transfer = {
		types: [DataTransfers.RESOURCES],
		files: [] as File[],
		getData: (type: string) => type === DataTransfers.RESOURCES ? JSON.stringify(resources) : '',
	};
	const event = new DragEvent('drop', { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'dataTransfer', { value: transfer });
	target.dispatchEvent(event);
}

function composer(pane: ClaudeAgentViewPane): HTMLTextAreaElement {
	const input = pane.element.querySelector('textarea.claude-composer-input');
	assert.ok(input instanceof HTMLTextAreaElement);
	return input;
}

function tab(pane: ClaudeAgentViewPane, index: number): HTMLElement {
	const tabs = pane.element.querySelectorAll('.claude-tab');
	const item = tabs[index];
	assert.ok(item instanceof HTMLElement);
	return item;
}

function tabClose(pane: ClaudeAgentViewPane, index: number): HTMLButtonElement {
	const button = tab(pane, index).querySelector('button.claude-icon-btn');
	assert.ok(button instanceof HTMLButtonElement);
	return button;
}

class ScriptedRuntime extends FakeClaudeRuntimeService {
	models: readonly ClaudeModelInfo[] | undefined;
	fail: Error | undefined;
	nextFixture: string | undefined;
	/** Every turn's prompt as Claude Code gets it. */
	readonly prompts: string[] = [];

	readonly elicitationAnswers: [string, ClaudeElicitationAnswer][] = [];

	async resolveElicitation(_sessionId: string, id: string, answer: ClaudeElicitationAnswer): Promise<void> {
		this.elicitationAnswers.push([id, answer]);
	}

	override async begin(request: BeginClaudeRequest): Promise<ClaudeRunHandle> {
		this.prompts.push(request.prompt);
		const fixture = this.nextFixture ?? request.fixture;
		this.nextFixture = undefined;
		return super.begin({ ...request, fixture });
	}

	override async send(sessionId: string, input: ClaudeUserInput): Promise<void> {
		this.prompts.push(input.text);
		return super.send(sessionId, input);
	}

	override async listModels(): Promise<readonly ClaudeModelInfo[]> {
		if (this.fail) {
			throw this.fail;
		}
		if (this.models !== undefined) {
			return this.models;
		}
		return super.listModels();
	}
}

function streamingFixtures(): Map<string, string> {
	const event = (value: unknown) => JSON.stringify(value);
	const folder = TestWorkspace.folders[0].uri.fsPath;
	return new Map([
		['with-skill', [
			event({ type: 'session.started', sessionId: '$session', skills: ['explain'], slashCommands: ['review'] }),
			event({ type: 'assistant.completed', sessionId: '$session', text: 'skill ready' }),
			event({ type: 'session.completed', sessionId: '$session' }),
		].join('\n')],
		['plain-answer', [
			event({ type: 'session.started', sessionId: '$session', model: 'fixture-sonnet' }),
			event({ type: 'assistant.delta', sessionId: '$session', text: 'The handler returns early. ' }),
			event({ type: 'assistant.delta', sessionId: '$session', text: 'That skips the check.' }),
			event({ type: 'assistant.completed', sessionId: '$session', text: 'The handler returns early. That skips the check.' }),
			event({ type: 'session.completed', sessionId: '$session' }),
		].join('\n')],
		['crash', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({ type: 'assistant.delta', sessionId: '$session', text: 'Partial answer' }),
			event({ type: 'session.failed', sessionId: '$session', message: 'process exited', kind: 'process-crash' }),
		].join('\n')],
		['usage-limit', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({ type: 'session.failed', sessionId: '$session', message: 'rate limited', kind: 'usage-limit' }),
		].join('\n')],
		['with-code', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({ type: 'assistant.completed', sessionId: '$session', text: 'See src/app.ts:12.\n\n```ts\nconst n = 1;\n```' }),
			event({ type: 'session.completed', sessionId: '$session' }),
		].join('\n')],
		['plan', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({ type: 'assistant.completed', sessionId: '$session', text: '# Add expiry\n\nReject expired coupons.\n\n1. Check `expiresAt` in `src/coupon.ts`\n2. Add tests' }),
			event({ type: 'session.completed', sessionId: '$session' }),
		].join('\n')],
		['ask-question', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({ type: 'tool.started', sessionId: '$session', call: { id: 'question-1', name: 'AskUserQuestion', category: 'other', input: {}, display: { label: 'AskUserQuestion' } } }),
			event({ type: 'elicitation.requested', sessionId: '$session', request: { id: 'question-1', server: 'Claude', mode: 'question', message: 'Which layout?', expiresAt: Number.MAX_SAFE_INTEGER, questions: [{ question: 'Which layout?', header: 'Layout', multiSelect: false, options: [{ label: 'Tabs', description: 'One tab per section.' }, { label: 'One page', description: 'Every section on one page.' }] }] } }),
		].join('\n')],
		['ask-command', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({ type: 'permission.requested', sessionId: '$session', request: { id: 'perm-1', toolName: 'Bash', category: 'shell', input: { command: 'npm install zod --save-exact' }, command: 'npm install zod --save-exact', cwd: '/repo', risk: 'network', reason: 'Add the validation library you asked for', why: 'This command uses the network.', canRemember: true } }),
		].join('\n')],
		['ask-command-all', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({ type: 'permission.requested', sessionId: '$session', request: { id: 'perm-6', toolName: 'Bash', category: 'shell', input: { command: 'npm install zod --save-exact' }, command: 'npm install zod --save-exact', cwd: '/repo', risk: 'network', why: 'Commands ask in Agent mode.', canRemember: true, mode: 'agent', canAllowAllCommands: true, workspaceTrusted: true } }),
		].join('\n')],
		['ask-danger', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({ type: 'permission.requested', sessionId: '$session', request: { id: 'perm-2', toolName: 'Bash', category: 'shell', input: { command: 'git reset --hard HEAD~3' }, command: 'git reset --hard HEAD~3', cwd: '/repo', risk: 'destructive', why: 'This command can delete data or rewrite history.', canRemember: false } }),
		].join('\n')],
		['ask-outside', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({ type: 'permission.requested', sessionId: '$session', request: { id: 'perm-3', toolName: 'Write', category: 'write', input: { file_path: '/Users/me/.config/shop/settings.json' }, targetPath: '/Users/me/.config/shop/settings.json', outsideWorkspace: true, why: 'This file is outside the workspace.', canRemember: false } }),
		].join('\n')],
		['blocked-ask', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({ type: 'permission.resolved', sessionId: '$session', outcome: { requestId: 'perm-5', toolName: 'Write', decision: 'deny', source: 'policy', subject: 'src/handler.ts', message: 'Ask mode never changes files. Switch to Agent to allow changes.', blockedByMode: 'ask' } }),
			event({ type: 'assistant.completed', sessionId: '$session', text: 'I cannot edit in Ask mode.' }),
			event({ type: 'session.completed', sessionId: '$session' }),
		].join('\n')],
		['blocked', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({ type: 'permission.resolved', sessionId: '$session', outcome: { requestId: 'perm-4', toolName: 'Write', decision: 'deny', source: 'policy', subject: 'cart.ts', message: 'Ask mode is read-only. Switch to Agent to allow changes.' } }),
		].join('\n')],
		['parallel-cards', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({ type: 'subagent.started', sessionId: '$session', run: { id: 'run-a', agentType: 'Explore', description: 'Find login', background: false, state: 'running', startedAt: 1, toolCallCount: 0 } }),
			event({ type: 'tool.started', sessionId: '$session', parentRunId: 'run-a', call: { id: 'read-a', name: 'Read', category: 'read', input: { secret: 'hidden-input' }, display: { label: 'Read', file: 'src/login.ts' } } }),
			event({ type: 'subagent.started', sessionId: '$session', run: { id: 'run-b', agentType: 'general-purpose', description: 'Review auth', background: false, state: 'running', startedAt: 2, toolCallCount: 0 } }),
			event({ type: 'tool.started', sessionId: '$session', parentRunId: 'run-b', call: { id: 'grep-b', name: 'Grep', category: 'search', input: {}, display: { label: 'Grep', query: 'session' } } }),
		].join('\n')],
		['long-command', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({ type: 'tool.started', sessionId: '$session', call: { id: 'bash-long', name: 'Bash', category: 'shell', input: { command: 'npm test', cwd: folder }, display: { label: 'Bash', command: 'npm test' } } }),
			event({ type: 'tool.updated', sessionId: '$session', callId: 'bash-long', update: { stdout: Array.from({ length: 40 }, (_value, index) => `line ${index}`).join('\n') } }),
		].join('\n')],
		['long-secret-command', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({ type: 'tool.started', sessionId: '$session', call: { id: 'bash-secret', name: 'Bash', category: 'shell', input: { command: 'npm test', cwd: folder }, display: { label: 'Bash', command: 'npm test' } } }),
			event({ type: 'tool.updated', sessionId: '$session', callId: 'bash-secret', update: { stdout: Array.from({ length: 201 }, (_value, index) => `line ${index}`).join('\n') } }),
			event({ type: 'tool.completed', sessionId: '$session', callId: 'bash-secret', result: { ok: true, output: `${Array.from({ length: 201 }, (_value, index) => `line ${index}`).join('\n')}\nsk-ant-api03-testsecretvalue` } }),
			event({ type: 'session.completed', sessionId: '$session' }),
		].join('\n')],
		['command-card', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({ type: 'tool.started', sessionId: '$session', call: { id: 'bash-1', name: 'Bash', category: 'shell', input: { command: 'git status', cwd: folder }, display: { label: 'Bash', command: 'git status' } } }),
			event({ type: 'tool.updated', sessionId: '$session', callId: 'bash-1', update: { stdout: 'On branch main\n' } }),
			event({ type: 'tool.completed', sessionId: '$session', callId: 'bash-1', result: { ok: true, output: 'On branch main\n' } }),
			event({ type: 'session.completed', sessionId: '$session' }),
		].join('\n')],
		['nested-permission', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({ type: 'subagent.started', sessionId: '$session', run: { id: 'run-outer', agentType: 'Explore', description: 'Outer', background: false, state: 'running', startedAt: 1, toolCallCount: 0 } }),
			event({ type: 'subagent.started', sessionId: '$session', parentRunId: 'run-outer', run: { id: 'run-inner', parentRunId: 'run-outer', agentType: 'reviewer', description: 'Inner', background: false, state: 'running', startedAt: 2, toolCallCount: 0 } }),
			event({ type: 'permission.requested', sessionId: '$session', parentRunId: 'run-inner', request: { id: 'perm-nested', toolName: 'Bash', category: 'shell', input: { command: 'rm -rf dist' }, command: 'rm -rf dist', risk: 'destructive', why: 'This command can delete data.' } }),
		].join('\n')],
		['reading', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({
				type: 'tool.started',
				sessionId: '$session',
				call: { id: 'call-1', name: 'Read', category: 'read', input: {}, display: { label: 'Read', file: 'src/x.ts' } },
			}),
		].join('\n')],
		['two-blocks', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({ type: 'assistant.completed', sessionId: '$session', text: '```ts\nconst a = 1;\n```\n\n```ts\nconst b = 2;\n```' }),
			event({ type: 'assistant.delta', sessionId: '$session', text: 'tail' }),
			event({ type: 'session.completed', sessionId: '$session' }),
		].join('\n')],
		['unsafe', [
			event({ type: 'session.started', sessionId: '$session' }),
			event({
				type: 'assistant.completed',
				sessionId: '$session',
				text: 'plain\n\n<img src="x" onerror="alert(1)">\n\n<script>alert(1)</script>\n\n[Save](command:workbench.action.files.save)',
			}),
			event({ type: 'session.completed', sessionId: '$session' }),
		].join('\n')],
	]);
}

function grandchildState(withPermission: boolean) {
	let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text: 'Look' });
	const started = (id: string, parent: string | undefined, agentType: string, description: string): NormalizedClaudeEvent => ({
		type: 'subagent.started',
		sessionId: 's',
		parentRunId: parent,
		run: { id, parentRunId: parent, agentType, description, background: false, state: 'running', startedAt: 1, toolCallCount: 0 },
	});
	state = reduceAgentState(state, started('run-outer', undefined, 'Explore', 'Outer'));
	state = reduceAgentState(state, started('run-child', 'run-outer', 'reviewer', 'Child'));
	state = reduceAgentState(state, started('run-grand', 'run-child', 'planner', 'Grandchild'));
	if (withPermission) {
		state = reduceAgentState(state, {
			type: 'permission.requested',
			sessionId: 's',
			parentRunId: 'run-grand',
			request: { id: 'perm-grand', toolName: 'Bash', category: 'shell', input: {}, command: 'npm test' },
		});
	}
	return state;
}

function shellCall(): NormalizedClaudeEvent {
	return { type: 'tool.started', sessionId: 's', call: { id: 'bash-scroll', name: 'Bash', category: 'shell', input: { command: 'npm test' }, display: { label: 'Bash', command: 'npm test' } } };
}

function shellUpdate(stdout: string): NormalizedClaudeEvent {
	return { type: 'tool.updated', sessionId: 's', callId: 'bash-scroll', update: { stdout } };
}

function sendButton(pane: ClaudeAgentViewPane): HTMLButtonElement {
	const button = pane.element.querySelector('button.claude-send');
	assert.ok(button instanceof HTMLButtonElement);
	return button;
}

/** Polls on short timers until `condition` holds (issue 274: the hidden test window runs frames about once a second). */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	do {
		await new Promise(resolve => setTimeout(resolve, 5));
		if (condition()) {
			return;
		}
	} while (Date.now() < deadline);
	assert.fail(`timed out waiting for ${what}`);
}

/** Waits for the chat in `container` to paint `text`, then puts 3000 px of content under it, as a plan card or an image that renders late. */
async function tallTimeline(container: HTMLElement, text: string): Promise<HTMLElement> {
	const timeline = container.querySelector<HTMLElement>('.claude-timeline');
	assert.ok(timeline);
	await waitFor(() => !!timeline.textContent?.includes(text), text);
	const late = document.createElement('div');
	late.style.height = '3000px';
	timeline.appendChild(late);
	return timeline;
}

function isAtEnd(timeline: HTMLElement): boolean {
	return timeline.clientHeight > 0 && Math.abs(timeline.scrollTop - (timeline.scrollHeight - timeline.clientHeight)) < 1;
}

/** Scrolls the timeline up with the mouse wheel, as the reader would, and returns where it landed. */
function wheelUp(timeline: HTMLElement): number {
	const wheel = new WheelEvent('wheel', { deltaY: -720, bubbles: true, cancelable: true });
	// Chromium gives synthetic legacy deltas the wrong sign; keep both representations consistent.
	Object.defineProperty(wheel, 'wheelDeltaY', { value: 720 });
	timeline.dispatchEvent(wheel);
	return Math.round(timeline.scrollTop);
}

async function waitForText(pane: ClaudeAgentViewPane, text: string): Promise<void> {
	await waitUntil(pane, text, () => true);
}

async function waitForSubagent(pane: ClaudeAgentViewPane): Promise<void> {
	await waitUntil(pane, '', () => !!pane.element.querySelector('button.claude-subagent-back'));
}

async function waitForIdle(pane: ClaudeAgentViewPane, text: string): Promise<void> {
	await waitUntil(pane, text, () => !sendButton(pane).classList.contains('is-stop'));
}

/**
 * Waits for a finished Plan answer: the send button leaves Stop before the timeline's last
 * repaint, so the streaming draft card can still be shown for a frame.
 */
async function waitForPlan(pane: ClaudeAgentViewPane, text: string): Promise<void> {
	await waitUntil(pane, text, () => !sendButton(pane).classList.contains('is-stop') && !pane.element.querySelector('.claude-plan.is-draft'));
}

/**
 * Polls the pane on short timers until it shows `text` and `extra` holds. It does not wait an
 * animation frame per poll: the hidden test window on Windows runs frames about once a second, so
 * that made every wait cost a second even when the pane had already painted (issue 274).
 */
async function waitUntil(pane: ClaudeAgentViewPane, text: string, extra: () => boolean): Promise<void> {
	const deadline = Date.now() + 4000;
	do {
		await new Promise(resolve => setTimeout(resolve, 5));
		if (pane.element.textContent?.includes(text) && extra()) {
			return;
		}
	} while (Date.now() < deadline);
	assert.fail(`timed out waiting for ${text}`);
}
