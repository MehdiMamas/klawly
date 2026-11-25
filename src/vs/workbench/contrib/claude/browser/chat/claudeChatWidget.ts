/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getActiveElement, getWindow, isHTMLElement, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { IAction, Separator, toAction } from '../../../../../base/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { FileAccess, Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { claudeStatusText } from '../../../../../platform/claude/common/claudeStatusTool.js';
import { ClaudeLimitPolicy } from '../../../../../platform/claude/common/claudeLimitPolicy.js';
import { buildPlanPrompt, PlanArtifact } from '../../../../../platform/claude/common/claudePlan.js';
import { acceptEditedPlan, isPlanEdited } from '../../../../../platform/claude/common/claudePlanEdit.js';
import { CLAUDE_SHARE_TO_PHONE_COMMAND_ID } from '../../../../../platform/claude/common/claudeRemoteControl.js';
import { CLAUDE_BACKGROUND_PROMPT_COMMAND_ID } from '../../../../services/claude/common/claudeBackgroundAgent.js';
import { ScrollbarVisibility } from '../../../../../base/common/scrollable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { CLAUDE_CHAT_DRAG_MIME, encodeChatDrag } from '../../../../../platform/claude/common/claudeChatReference.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { CLAUDE_AUTO_ENABLED_SETTING, CLAUDE_DEBUG_RETAIN_RAW_SETTING, CLAUDE_REVIEW_OPEN_AFTER_EDIT_SETTING, CLAUDE_SUBAGENTS_OPEN_ON_START_SETTING, readClaudePermissionPolicy } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { CLAUDE_SESSION_LIST_LOCATION_SETTING, CLAUDE_TOGGLE_AGENTS_SIDEBAR_COMMAND_ID, claudeAgentRow, claudeAgentRowAuto, claudeAgentRowIcon, ClaudeAgentsFilter, readClaudeSessionListLocation } from '../../common/claudeAgentsList.js';
import { claudeSessionTurnKey, claudeTurnsToOpenAfterEdit, forgetClosedSessionTurns } from '../../common/claudeCommandState.js';
import { compileSubmission, retargetCompiledPrompt } from '../../../../../platform/claude/common/claudePrompt.js';
import { IClaudeGoalLoopService } from '../../common/claudeGoalLoopService.js';
import { CLAUDE_GOAL_MAX_BUDGET_SETTING, CLAUDE_GOAL_MAX_TURNS_SETTING } from '../../../../../platform/claude/common/claudeGoalLoop.js';
import { CLAUDE_EDIT_GOAL_COMMAND_ID } from './claudeAgentEditorInput.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudeContextService } from '../../../../services/claude/common/claudeContextService.js';
import { ClaudePermissionCardChoice, IClaudePermissionService } from '../../../../services/claude/common/claudePermissionService.js';
import { IClaudeElicitationService } from '../../../../services/claude/common/claudeElicitationService.js';
import { ClaudeElicitationAnswer } from '../../../../../platform/claude/common/claudeElicitation.js';
import { IClaudeActionService } from '../../../../../platform/claude/common/claudeActions.js';
import { commandFailureText, IClaudeDiagnosticsService } from '../../../../services/claude/common/claudeDiagnostics.js';
import { formatTurnDiff, IClaudeReviewService, ReviewConflictError, ReviewScope, reviewTurnsPendingLoad } from '../../../../services/claude/common/claudeReview.js';
import { ClaudeChangesBar } from '../review/claudeChangesBar.js';
import { ClaudeReviewCardController } from '../review/claudeChangesCard.js';
import { ClaudeReviewPane } from '../review/claudeReviewPane.js';
import { CLAUDE_COMMAND_LOG_CHANNEL_ID, redactSecrets } from '../../../../services/claude/common/claudeAgentLog.js';
import { EMPTY_AGENT_VIEW_STATE } from '../../../../services/claude/common/claudeAgentState.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { planCommandRerun } from '../../../../services/claude/common/claudeToolCards.js';
import { buildInspectorRows, InspectorFilter, inspectorFilterLabel, inspectorJson } from '../../../../services/claude/common/claudeSessionInspector.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { CLAUDE_ADD_SELECTION_COMMAND_ID, CLAUDE_ASK_SIDE_QUESTION_COMMAND_ID, CLAUDE_GO_TO_TURN_COMMAND_ID, CLAUDE_COMMIT_ACCEPTED_COMMAND_ID, CLAUDE_FOCUS_AGENT_COMMAND_ID, CLAUDE_INLINE_EDIT_COMMAND_ID, CLAUDE_MANAGE_MODELS_COMMAND_ID, CLAUDE_MOVE_CHAT_TO_SIDE_BAR_COMMAND_ID, CLAUDE_NEW_SESSION_COMMAND_ID, CLAUDE_OPEN_CHAT_IN_EDITOR_COMMAND_ID, CLAUDE_OPEN_CHAT_IN_WINDOW_COMMAND_ID, CLAUDE_OPEN_BACKGROUND_AGENTS_COMMAND_ID, CLAUDE_OPEN_INSPECTOR_COMMAND_ID, CLAUDE_OPEN_REVIEW_EDITOR_COMMAND_ID, CLAUDE_OPEN_SESSION_HISTORY_COMMAND_ID, CLAUDE_OPEN_SETTINGS_COMMAND_ID, CLAUDE_RESTORE_CHECKPOINT_COMMAND_ID, CLAUDE_SHOW_STATUS_COMMAND_ID, CLAUDE_AGENT_VIEW_ID, CLAUDE_STOP_AGENT_COMMAND_ID } from '../../common/claudeViews.js';
import { ClaudeTimelineRenderer } from './claudeTimelineRenderer.js';
import { ClaudeTimelineScroll, IClaudeTimelinePlace } from './claudeTimelineScroll.js';
import { ClaudeTimelineSelection } from './claudeTimelineSelection.js';
import { CLAUDE_OPEN_CHAT_PLAN_COMMAND_ID } from '../plan/claudePlanCommands.js';
import { ClaudeComposer } from './claudeComposer.js';
import { ClaudeChatFindWidget } from './claudeChatFindWidget.js';
import { claudeSideQuestionUnavailable } from './claudeSideQuestion.js';
import { ClaudeSessionTabs } from './claudeSessionTabs.js';
import { CLAUDE_COPY_CHAT_MARKDOWN_COMMAND_ID, CLAUDE_EXPORT_TRANSCRIPT_COMMAND_ID, CLAUDE_SHARE_CHAT_LINK_COMMAND_ID, IClaudeChatShareService } from './claudeChatShare.js';
import { ClaudeStatusLine } from './claudeStatusLine.js';
import { ClaudeUsageIndicator } from './claudeUsageIndicator.js';
import { CLAUDE_AGENTS_COLUMN_MIN_CHAT_WIDTH, CLAUDE_AGENTS_COLUMN_WIDTH, ClaudeAgentsColumn } from './claudeAgentsColumn.js';
import { ClaudeSessionHistoryPopover } from './claudeSessionHistoryPopover.js';
import { ClaudeEmptyRecent, renderClaudeEmptyState } from './claudeEmptyState.js';
import { appendClaudeKbd, claudeShiftTabLabel } from './claudeKbd.js';
import { ClaudeHandoffCard } from './claudeHandoffCard.js';
import { claudeHandoffCardKey, readStoredClaudeHandoffCard } from '../../common/claudeTerminalHandoff.js';
import { ClaudePluginRestartNotice } from './claudePluginRestartNotice.js';
import { IClaudeSetupService } from '../claudeSetup.js';
import { renderClaudeSetupCard } from '../claudeSetupCard.js';
import { toggleClaudeAgentsSidebar } from '../claudeAgentsSidebar.js';
import { claudeSetupBlocksComposer } from '../../common/claudeRuntimeStatus.js';
import { ClaudeTerminalRunView, IClaudeTerminalRunService } from '../../common/claudeTerminalRuns.js';
import { IClaudeReproductionService } from '../../common/claudeReproductions.js';
import { IClaudeDelegationService } from '../../../../services/claude/common/claudeDelegation.js';
import '../media/claude.css';
import { claudeSubagentKindLabel, isBackgroundCommand } from '../../common/claudeCommandMirror.js';

/** The old History-driven column flag; `claude.agents.sessionListLocation` replaced it (issue 98). */
const AGENTS_COLUMN_HIDDEN_KEY = 'claude.agentsColumn.hidden';

const markUri = FileAccess.asBrowserUri('vs/workbench/contrib/claude/browser/media/klawly-mark.svg').toString(true);

/**
 * Where each session's timeline is in the last chat that showed it, kept as the reader scrolls. A
 * chat tab sent to the background or a moved view builds a new chat, which opens at the same
 * place even when it is built before the old chat closes; a session switched back to does too
 * (issue 402).
 */
const timelinePlaces = new Map<string, IClaudeTimelinePlace>();

/** A session switched to with no kept place opens at its end. */
const TIMELINE_END: IClaudeTimelinePlace = { scrollTop: 0, atBottom: true };

/** Drops the kept places of sessions that are not in `open`. */
function forgetClosedTimelinePlaces(open: ReadonlySet<string>): void {
	for (const sessionId of [...timelinePlaces.keys()]) {
		if (!open.has(sessionId)) {
			timelinePlaces.delete(sessionId);
		}
	}
}

/** The sessions with a kept timeline place. Exported for tests. */
export function claudeTimelinePlaceSessions(): string[] {
	return [...timelinePlaces.keys()];
}

/** Where a chat widget lives: the Agent view, or an editor tab (in the main window or its own). */
export type ClaudeChatHost = 'view' | 'editor';

/** How long a streamed change may wait for an animation frame before the timeline paints without one. */
const TIMELINE_FRAME_FALLBACK_MS = 100;

/**
 * The agent chat: session tabs, timeline, review, changes bar, composer and the
 * agents column. It follows the current session. The Agent view and the Agent
 * editor each host one, and only one of them shows the chat at a time.
 */
export class ClaudeChatWidget extends Disposable {

	private readonly _overlayDisposables = this._register(new DisposableStore());
	/** Inspector buttons. Cleared when the inspector is rebuilt or closed, not on a timeline repaint. */
	private readonly _inspectorDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _timelineFrame = this._register(new MutableDisposable());
	private _pane: HTMLElement | undefined;
	private _header: HTMLElement | undefined;
	private _banner: HTMLElement | undefined;
	private readonly _bannerStore = this._register(new MutableDisposable<DisposableStore>());
	private _pluginNotice: ClaudePluginRestartNotice | undefined;
	private _handoffCard: ClaudeHandoffCard | undefined;
	private _tabs: ClaudeSessionTabs | undefined;
	private _actionsBar: HTMLElement | undefined;
	/** Empty-state DOM and its listeners, rebuilt when the recent sessions change. */
	private readonly _emptyStore = this._register(new MutableDisposable<DisposableStore>());
	private _emptyKey: string | undefined;
	/** "Try Plan" and the runtime state under the composer, shown with the empty state. */
	private _composerHint: HTMLElement | undefined;
	private _composerHintRuntime: HTMLElement | undefined;
	/** Takes the composer's place while a read-only subagent chat is open. */
	private _readonlyHint: HTMLElement | undefined;
	private _timeline: HTMLElement | undefined;
	private _timelineScroll: DomScrollableElement | undefined;
	private _timelineFollow: ClaudeTimelineScroll | undefined;
	/** What the timeline shows, a session or a subagent; a place kept for the next scan belongs to it. */
	private _timelineShows: string | undefined;
	/** The session whose turns the timeline shows; undefined while it shows a subagent, whose place is not kept. */
	private _timelineSession: string | undefined;
	private _timelineRenderer: ClaudeTimelineRenderer | undefined;
	private _empty: HTMLElement | undefined;
	private _footer: HTMLElement | undefined;
	private _composer: ClaudeComposer | undefined;
	private _reviewPane: ClaudeReviewPane | undefined;
	private _changesBar: ClaudeChangesBar | undefined;
	/** The chat's own size: the body minus the agents column when it shows. */
	private _lastLayout: { height: number; width: number } | undefined;
	private _bodySize: { height: number; width: number } | undefined;
	private _agentsColumn: ClaudeAgentsColumn | undefined;
	private _historyButton: HTMLButtonElement | undefined;
	private _historyAnchor: (() => HTMLElement | undefined) | undefined;
	private _historyPopover: ClaudeSessionHistoryPopover | undefined;
	private _sidebarButton: HTMLButtonElement | undefined;
	private _subagentId: string | undefined;
	private _breadcrumb: HTMLElement | undefined;
	private _breadcrumbKey: string | undefined;
	private readonly _breadcrumbStore = this._register(new MutableDisposable<DisposableStore>());
	private _inspectorStamp: string | undefined;
	private _inspectorHost: HTMLElement | undefined;
	private _inspectorFilter: InspectorFilter = 'all';
	private _inspectorOpen = false;
	/** Setup card shown instead of the composer while Claude is missing or signed out. */
	private _setupHost: HTMLElement | undefined;
	private readonly _setupStore = this._register(new MutableDisposable<DisposableStore>());
	private _setupKey: string | undefined;
	private _setupFocus: HTMLButtonElement | undefined;
	private _setupActive = false;
	private _subagentShown = false;
	/** The open subagent view is a background command (issue 1257). */
	private _commandShown = false;
	/** The current chat is a read-only delegated chat (issue 693); `_subagentShown` is true with it. */
	private _delegatedShown = false;
	/** Asks once whether to switch from Auto after Stop on a delegate card (issue 693). */
	private _delegateQuestion: HTMLElement | undefined;
	private readonly _delegateQuestionStore = this._register(new MutableDisposable<DisposableStore>());
	/** What each agent last said with klawly_status, dropped when the user writes again (issue 1302). */
	private readonly _statuses = new Map<string, { text: string; kind: 'info' | 'attention' | 'done'; turns: number }>();
	private _hasTurns = false;
	private _timelineHost: HTMLElement | undefined;
	private _find: ClaudeChatFindWidget | undefined;

	constructor(
		container: HTMLElement,
		private readonly _host: ClaudeChatHost,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IHoverService private readonly hoverService: IHoverService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeContextService private readonly _context: IClaudeContextService,
		@IClaudePermissionService private readonly _permissions: IClaudePermissionService,
		@IClaudeElicitationService private readonly _elicitations: IClaudeElicitationService,
		@ICommandService private readonly _commandService: ICommandService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly _trust: IWorkspaceTrustManagementService,
		@INotificationService private readonly _notifications: INotificationService,
		@IClaudeReviewService private readonly _review: IClaudeReviewService,
		@IClaudeActionService private readonly _actions: IClaudeActionService,
		@IClaudeDiagnosticsService private readonly _diagnostics: IClaudeDiagnosticsService,
		@IDialogService private readonly _dialog: IDialogService,
		@ITerminalService private readonly _terminal: ITerminalService,
		@IOutputService private readonly _output: IOutputService,
		@IClipboardService private readonly _clipboard: IClipboardService,
		@IClaudeChatShareService private readonly _share: IClaudeChatShareService,
		@IClaudeSetupService private readonly _setup: IClaudeSetupService,
		@IStorageService private readonly _storage: IStorageService,
		@IViewsService private readonly _views: IViewsService,
		@IViewDescriptorService private readonly _viewDescriptors: IViewDescriptorService,
		@IWorkbenchLayoutService private readonly _layout: IWorkbenchLayoutService,
		@IClaudeTerminalRunService private readonly _terminalRuns: IClaudeTerminalRunService,
		@IClaudeReproductionService private readonly _reproductions: IClaudeReproductionService,
		@IClaudeDelegationService private readonly _delegation: IClaudeDelegationService,
		@IClaudeGoalLoopService private readonly _goalLoop: IClaudeGoalLoopService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
	) {
		super();
		if (this._runtime.onDidReportStatus) {
			this._register(this._runtime.onDidReportStatus(report => {
				const text = claudeStatusText(report.text);
				const session = this._agent.getSessions().find(candidate => this._agent.getRuntimeSessionId(candidate.id) === report.sessionId);
				if (text && session) {
					this._statuses.set(session.id, { text, kind: report.kind, turns: this._agent.getViewState(session.id).turns.length });
					this.syncTabs();
				}
			}));
		}
		this._register(this._delegation.onDidChange(() => this.scheduleTimeline()));
		this._register(this._goalLoop.onDidChange(() => this.scheduleTimeline()));
		this._register(this._agent.onDidChangeSession(change => {
			if (change.reason === 'closed') {
				this.forgetClosedSessions();
			}
			this.applySession();
			this.paintTimeline();
		}));
		this._register(this._agent.onDidChangeViewState(change => {
			if (change.sessionId === this._agent.getCurrentSession()?.id) {
				this.scheduleTimeline();
			}
		}));
		this._register(this._diagnostics.onDidChangeProblems(() => {
			if (this._agent.getCurrentSession()) {
				this.scheduleTimeline();
			}
		}));
		this._register(this._agent.onDidChangeInspector(change => {
			if (change.sessionId === this._agent.getCurrentSession()?.id && this._inspectorOpen) {
				this.paintInspector();
			}
		}));
		this._register(this._review.onDidChangeReview(() => this.scheduleTimeline()));
		this._register(this._agent.onDidStartFreshClaudeSession(event => {
			// Status bar message, not a toast (spec 48): the turn itself still runs.
			this._notifications.status(localize('claudeFreshSession', "Started a new Claude session for {0}. The previous Claude session was not continued.", event.title), { hideAfter: 8000 });
		}));
		this._register(this._setup.onDidChange(() => this.syncSetup()));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_SESSION_LIST_LOCATION_SETTING) && this._bodySize) {
				this.layout(this._bodySize.height, this._bodySize.width);
			}
		}));
		// Sessions sit on top by default now; the old column flag has no reader left.
		this._storage.remove(AGENTS_COLUMN_HIDDEN_KEY, StorageScope.PROFILE);
		this._register(this._agent.onDidRejectModel(event => {
			this._notifications.error(event.fallback
				? localize('claudeModelRejectedFallback', "Claude could not use the model {0}: {1}. This turn uses {2} instead.", event.modelId, event.message, event.fallback)
				: localize('claudeModelRejected', "Claude could not use the model {0}: {1}. This turn keeps the model it already had.", event.modelId, event.message));
		}));
		this._register(this._agent.onDidReceiveEvent(event => {
			if (event.type !== 'subagent.started' || this._subagentId || this.configurationService.getValue(CLAUDE_SUBAGENTS_OPEN_ON_START_SETTING) !== true) {
				return;
			}
			const session = this._agent.getCurrentSession();
			if (session && this._agent.getRuntimeSessionId(session.id) === event.sessionId) {
				this.showSubagent(event.run.id);
			}
		}));
		this.render(container);
	}

	private render(container: HTMLElement): void {
		// The chat and, when the host is wide enough, the agents column on its right (ide-03).
		const shell = append(container, $('.claude-agent-shell'));
		this._register(toDisposable(() => shell.remove()));
		this._pane = append(shell, $('.claude-pane.claude-root'));
		this._pane.setAttribute('role', 'region');
		this._pane.setAttribute('aria-label', localize('claudeAgentRegion', "Agent"));

		// Header (spec 01): session tabs, then New, History, Agents Sidebar and More. Nothing else (audit 12, 30).
		const header = this._header = append(this._pane, $('.claude-pane-header'));
		// The view can lend the header to its title row (setHeaderHost); it goes with the chat.
		this._register(toDisposable(() => header.remove()));
		if (this._host === 'view') {
			this.renderHeader(header);
		}
		// In an editor the tab is the session's tab and New, History, Agents Sidebar and More are editor
		// actions (issue 142): the header stays empty, and hidden, unless a subagent's crumb shows.
		this._banner = append(this._pane, $('.claude-banner.is-warning'));
		this._banner.hidden = true;
		this._pluginNotice = this._register(new ClaudePluginRestartNotice(this._pane));
		this._handoffCard = this._register(new ClaudeHandoffCard(this._pane));

		const timelineHost = append(this._pane, $('.claude-timeline-host'));
		this._timelineHost = timelineHost;
		this._timeline = $('.claude-timeline');
		this._timeline.setAttribute('role', 'log');
		this._timeline.setAttribute('aria-live', 'polite');
		this._timeline.setAttribute('aria-label', localize('claudeTimeline', "Agent timeline"));
		this._timelineScroll = this._register(new DomScrollableElement(this._timeline, {
			vertical: ScrollbarVisibility.Auto,
			horizontal: ScrollbarVisibility.Hidden,
			consumeMouseWheelIfScrollbarIsNeeded: true,
		}));
		const scrollNode = this._timelineScroll.getDomNode();
		scrollNode.style.height = '100%';
		scrollNode.style.width = '100%';
		timelineHost.appendChild(scrollNode);
		this._timelineFollow = this._register(new ClaudeTimelineScroll(this._timeline, this._timelineScroll, getWindow(timelineHost)));
		this._register(this.instantiationService.createInstance(ClaudeTimelineSelection, this._timeline, this._timelineScroll, {
			quote: quote => {
				const session = this._agent.getCurrentSession();
				if (session && this.appendDraft(session.id, quote)) {
					this._composer?.focus();
				}
			},
		}));
		// Sessions that closed while no chat was open leave no place behind.
		forgetClosedTimelinePlaces(new Set(this._agent.getSessions().map(session => session.id)));
		const placeSession = this._agent.getCurrentSession();
		this._timelineShows = this._timelineSession = placeSession?.id;
		this._timelineFollow.restore(placeSession && timelinePlaces.get(placeSession.id));
		this._register(this._timelineFollow.onDidChangePlace(place => this.keepTimelinePlace(place)));
		const review: ClaudeReviewCardController = {
			get: turnId => {
				const session = this._agent.getCurrentSession();
				return session ? this._review.get(session.id, turnId) : undefined;
			},
			openFile: (turnId, uri) => this.openReview(turnId, uri, false),
			acceptFile: (turnId, uri) => this.acceptReviewFile(turnId, uri),
			rejectFile: (turnId, uri) => this.rejectReviewFile(turnId, uri),
			acceptAll: turnId => this.acceptReviewAll(turnId),
			rejectAll: turnId => this.rejectReviewAll(turnId),
			reviewAll: turnId => { void this.reviewAllChanges(turnId); },
			openReview: turnId => this.openReviewEditor(turnId),
			resolve: (turnId, uri) => this.openReview(turnId, uri, true),
			commitAccepted: turnId => this._commandService.executeCommand(CLAUDE_COMMIT_ACCEPTED_COMMAND_ID, turnId),
			reportCommitError: message => this._notifications.error(message),
			wideScope: turnId => {
				const scope = this.wideReviewScope(turnId);
				return scope && this._review.pendingSummary(scope);
			},
			keepWide: turnId => {
				const scope = this.wideReviewScope(turnId);
				if (scope) {
					this._review.keepAllPending(scope);
				}
			},
			undoKept: (turnId, uri) => this.undoKeptReview(turnId, uri),
		};
		this._timelineRenderer = this._register(this.instantiationService.createInstance(ClaudeTimelineRenderer, this._timeline, {
			retry: () => this.retryCurrent(),
			limitChoices: {
				accounts: async () => await this._runtime.listAccounts?.() ?? [],
				currentAccountId: () => {
					const id = this._agent.getCurrentSession()?.id;
					return id ? this._agent.getSessionAccount(id) : undefined;
				},
				chatPolicy: () => {
					const id = this._agent.getCurrentSession()?.id;
					return id ? this._agent.getSessionLimitPolicy(id) : undefined;
				},
				retryWith: (accountId, policy) => this.retryCurrent(accountId, policy),
			},
			continueTurn: () => this.continueCurrent(),
			goalEnded: () => {
				const sessionId = this._agent.getCurrentSession()?.id;
				return sessionId ? this._goalLoop.getEnded(sessionId) : undefined;
			},
			restartGoal: () => {
				const sessionId = this._agent.getCurrentSession()?.id;
				const ended = sessionId ? this._goalLoop.getEnded(sessionId) : undefined;
				if (sessionId && ended) {
					void this._goalLoop.startGoal(sessionId, ended.cwd, ended.view.goal);
				}
			},
			editGoal: () => void this._commandService.executeCommand(CLAUDE_EDIT_GOAL_COMMAND_ID),
			openGoalSpendSetting: () => void this._commandService.executeCommand('workbench.action.openSettings', CLAUDE_GOAL_MAX_BUDGET_SETTING),
			openGoalTurnsSetting: () => void this._commandService.executeCommand('workbench.action.openSettings', CLAUDE_GOAL_MAX_TURNS_SETTING),
			dismissGoalEnded: () => {
				const sessionId = this._agent.getCurrentSession()?.id;
				if (sessionId) {
					this._goalLoop.dismissEnded(sessionId);
				}
			},
			build: (turnId, notes, plan) => this.buildCurrent(turnId, notes, plan),
			buildInBackground: (turnId, notes, plan) => this.buildInBackground(turnId, notes, plan),
			openPlan: (turnId, notes, plan) => this.openPlanFile(turnId, notes, plan),
			openStatus: () => void this._commandService.executeCommand(CLAUDE_SHOW_STATUS_COMMAND_ID),
			respondPermission: (requestId, choice) => this.respondPermission(requestId, choice),
			respondElicitation: (id, answer) => this.respondElicitation(id, answer),
			switchToAgentAndRetry: turnId => this.switchToAgentAndRetry(turnId),
			review,
			dockedReview: () => this._changesBar?.turnId,
			openSubagent: runId => this.openSubagent(runId),
			delegate: {
				open: childSessionId => this._agent.selectSession(childSessionId),
				stop: cardId => void this._delegation.stop(cardId),
				rerun: cardId => void this._delegation.rerun(cardId),
				retry: cardId => void this._delegation.rerun(cardId),
				retryOnOpus: cardId => void this._delegation.rerun(cardId, { modelId: 'opus' }),
				openLog: () => void this.openCommandLog(),
				hover: (target, content) => this.hoverService.setupDelayedHover(target, { content, additionalClasses: ['claude-root'] }),
			},
			stopSubagent: runId => this.stopSubagent(runId),
			copyCommand: command => void this._clipboard.writeText(command),
			openInTerminal: cwd => void this.openInTerminal(cwd),
			rerunCommand: (command, cwd) => void this.rerunCommand(command, cwd),
			openCommandLog: () => void this.openCommandLog(),
			workingDirectory: () => this._agent.getCurrentSession()?.worktreePath,
			pendingEdit: turnId => this._agent.pendingEditTurnId(this._agent.getCurrentSession()?.id ?? '') === turnId,
			problems: {
				get: turnId => this._diagnostics.getProblems(turnId),
				fix: turnId => this.fixTurnProblems(turnId),
			},
			fixCommandError: card => this.fixCommandError(card),
			terminalRuns: {
				onDidChange: listener => this._terminalRuns.onDidChange(listener),
				find: command => this.findTerminalRun(command),
				open: requestId => void this._terminalRuns.open(requestId),
				cancel: requestId => this._terminalRuns.cancel(requestId),
			},
			reproductions: {
				onDidChange: listener => this._reproductions.onDidChange(listener),
				find: () => {
					const session = this._agent.getCurrentSession();
					const runtimeSessionId = session ? this._agent.getRuntimeSessionId(session.id) : undefined;
					return runtimeSessionId ? this._reproductions.find(runtimeSessionId) : undefined;
				},
				start: requestId => this._reproductions.start(requestId),
				finish: requestId => this._reproductions.finish(requestId),
				cancel: requestId => this._reproductions.cancel(requestId),
			},
			stop: () => void this._commandService.executeCommand(CLAUDE_STOP_AGENT_COMMAND_ID),
			forkFrom: turnId => this.forkFrom(turnId),
			restoreCheckpoint: turnId => void this._commandService.executeCommand(CLAUDE_RESTORE_CHECKPOINT_COMMAND_ID, turnId),
			editPrompt: turnId => this._composer?.editEarlier(turnId),
			canEditPrompt: turnId => {
				const session = this._agent.getCurrentSession();
				return session ? this._agent.canRewind(session.id, turnId) : { enabled: false };
			},
			mcpApps: {
				runtimeSessionId: () => {
					const session = this._agent.getCurrentSession();
					return session ? this._agent.getRuntimeSessionId(session.id) : undefined;
				},
				draft: text => {
					const session = this._agent.getCurrentSession();
					return !!session && this.appendDraft(session.id, text);
				},
			},
		}));
		this._reviewPane = this._register(this.instantiationService.createInstance(ClaudeReviewPane));

		this._footer = append(this._pane, $('.claude-pane-footer'));
		this._delegateQuestion = append(this._footer, $('.claude-delegate-question'));
		this._delegateQuestion.hidden = true;
		this._changesBar = this._register(new ClaudeChangesBar(this._footer, review, { folderOf: uri => this._timelineRenderer?.displayFolder(uri) ?? '' }, () => this.relayout()));
		this._composer = this._register(this.instantiationService.createInstance(ClaudeComposer, this._footer, {
			localFolder: () => this.localFolder(),
			report: error => this.report(error),
			requestLayout: () => {
				if (this._lastLayout) {
					this.layoutTimeline(this._lastLayout.height, this._lastLayout.width);
				}
			},
		}));
		this._composerHint = append(this._footer, $('.claude-composer-hint'));
		const tryPlan = append(this._composerHint, $('span'));
		tryPlan.append(localize('claudeHintTry', "Try"), ' ');
		append(tryPlan, $('b')).textContent = localize('claudeHintPlan', "Plan");
		appendClaudeKbd(tryPlan, claudeShiftTabLabel());
		tryPlan.append(localize('claudeHintLarger', "for larger changes"));
		this._composerHintRuntime = append(this._composerHint, $('span'));
		// Issue 515: Claude Code's status line, when the Claude settings define one, above the plan usage.
		this._register(this.instantiationService.createInstance(ClaudeStatusLine, this._footer, () => this.relayout()));
		this._register(this.instantiationService.createInstance(ClaudeUsageIndicator, this._footer, () => this.relayout()));
		this._readonlyHint = append(this._pane, $('.claude-readonly-hint'));
		this._readonlyHint.hidden = true;
		this._setupHost = append(this._pane, $('.claude-setup-host'));
		this._setupHost.hidden = true;
		this._agentsColumn = this._register(this.instantiationService.createInstance(ClaudeAgentsColumn, shell, () => undefined));
		this._historyPopover = this._register(this.instantiationService.createInstance(ClaudeSessionHistoryPopover, () => undefined, turnId => this.revealTurn(turnId)));

		if (!this._agent.getCurrentSession()) {
			this._agent.createSession();
		}
		this.applySession();
		this.paintTimeline();
		this.syncSetup();
	}

	/** The host hides the chat (a closed part, another view container, a folded view): the timeline keeps the reader's place (issue 402). */
	hide(): void {
		this._timelineFollow?.hold();
	}

	override dispose(): void {
		// The next chat for this session opens where this one was, also when it was hidden (issue 402).
		if (this._timelineFollow && !this._store.isDisposed) {
			this.keepTimelinePlace(this._timelineFollow.place());
		}
		super.dispose();
	}

	/** Keeps the place of the session the timeline shows, unless it shows a subagent or the session closed. */
	private keepTimelinePlace(place: IClaudeTimelinePlace): void {
		const sessionId = this._timelineSession;
		if (sessionId && this._agent.getSessions().some(session => session.id === sessionId)) {
			timelinePlaces.set(sessionId, place);
		}
	}

	/** Lays out the chat and, when it fits, the agents column in the host's size. */
	layout(height: number, width: number): void {
		this._bodySize = { height, width };
		const side = readClaudeSessionListLocation(this.configurationService.getValue(CLAUDE_SESSION_LIST_LOCATION_SETTING)) === 'side';
		const fits = this.agentsColumnFits(width);
		const column = side && fits;
		this._agentsColumn?.setVisible(column);
		this._agentsColumn?.layout(height);
		this.paintSidebarButton(side, fits);
		const chatWidth = column ? width - CLAUDE_AGENTS_COLUMN_WIDTH : width;
		const widthChanged = this._lastLayout?.width !== chatWidth;
		this._lastLayout = { height, width: chatWidth };
		if (widthChanged) {
			// The input wraps differently at the new width; refit lays the timeline out again.
			this._composer?.refit();
		}
		this.layoutTimeline(height, chatWidth);
		this._tabs?.layout();
	}

	/**
	 * Closes a session tab. Closing the last tab closes the Agent view instead
	 * of leaving an empty New Agent in its place, and hides the auxiliary bar
	 * when the view lives there so no empty bar stays behind. A last session with turns
	 * still goes to History first; an untouched one stays for the next time the
	 * view opens. Only the view has tabs; a chat in an editor tab has none.
	 */
	private closeTab(sessionId: string): void {
		const sessions = this._agent.getSessions();
		if (sessions.length !== 1 || sessions[0].id !== sessionId) {
			this._agent.closeSession(sessionId);
			return;
		}
		if (this._agent.getViewState(sessionId).turns.length > 0) {
			this._agent.closeSession(sessionId);
		}
		this._views.closeView(CLAUDE_AGENT_VIEW_ID);
		if (this._viewDescriptors.getViewLocationById(CLAUDE_AGENT_VIEW_ID) === ViewContainerLocation.AuxiliaryBar) {
			this._layout.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		}
	}

	/** The view's header row: session tabs, then New, History, Agents Sidebar and More. */
	private renderHeader(header: HTMLElement): void {
		this._tabs = this._register(this.instantiationService.createInstance(ClaudeSessionTabs, header, {
			select: sessionId => this._agent.selectSession(sessionId),
			openPullRequest: sessionId => this.showPullRequest(sessionId),
			close: sessionId => this.closeTab(sessionId),
			dragStart: (sessionId, event) => {
				const asOfTurn = Math.max(1, this._agent.getViewState(sessionId).turns.length);
				event.dataTransfer?.setData(CLAUDE_CHAT_DRAG_MIME, encodeChatDrag({ sessionId, asOfTurn }));
			},
			reorder: (sessionId, beforeSessionId) => this._agent.moveSession(sessionId, beforeSessionId),
			contextMenu: (sessionId, event) => this.contextMenuService.showContextMenu({
				getAnchor: () => ({ x: event.clientX, y: event.clientY }),
				getActions: () => [
					toAction({
						id: 'claude.tab.reference',
						label: localize('claudeHistoryReference', "Reference in new chat"),
						run: () => { void this._agent.referenceInNewSession(sessionId); },
					}),
				],
			}),
		}));
		const actions = this._actionsBar = append(header, $('.claude-pane-actions'));
		actions.appendChild(this.iconButton(Codicon.add, localize('claudeNewAgent', "New Agent"), CLAUDE_NEW_SESSION_COMMAND_ID, () => this._commandService.executeCommand(CLAUDE_NEW_SESSION_COMMAND_ID)));
		this._historyButton = this.iconButton(Codicon.history, localize('claudeHistory', "Agent History"), CLAUDE_OPEN_SESSION_HISTORY_COMMAND_ID, () => this.toggleHistory());
		actions.appendChild(this._historyButton);
		// Sessions live in the tabs on top; this button adds the agents sidebar on the right (issue 98).
		this._sidebarButton = this.iconButton(Codicon.layoutSidebarRight, localize('claudeShowAgentsSidebar', "Show Agents Sidebar"), CLAUDE_TOGGLE_AGENTS_SIDEBAR_COMMAND_ID, () => { void toggleClaudeAgentsSidebar(this.configurationService); });
		actions.appendChild(this._sidebarButton);
		const more = this.iconButton(Codicon.ellipsis, localize('claudeMore', "More actions"), undefined, () => this.showMore(more));
		more.setAttribute('aria-haspopup', 'menu');
		actions.appendChild(more);
	}

	/**
	 * Moves the header row (session tabs, New, History and More) into `host`, such as the
	 * Agent view's title row, so the pane has one header row level with the editor tabs (#106).
	 * Without a host the row goes back to the top of the pane.
	 */
	setHeaderHost(host: HTMLElement | undefined): void {
		const pane = this._pane;
		const header = this._header;
		if (!pane || !header || header.parentElement === (host ?? pane)) {
			return;
		}
		if (host) {
			host.appendChild(header);
		} else {
			pane.insertBefore(header, pane.firstChild);
		}
		if (this._lastLayout) {
			this.layoutTimeline(this._lastLayout.height, this._lastLayout.width);
		}
		this._tabs?.layout();
	}

	/**
	 * Applies `filter` to the agents sidebar (More > Background Agents shows the
	 * background ones, issue 334). Returns how many pixels the pane is short of
	 * fitting the sidebar beside the chat; 0 when it fits, or when the pane has not
	 * been laid out yet and its width is unknown.
	 */
	showAgents(filter: ClaudeAgentsFilter): number {
		this._agentsColumn?.setFilter(filter);
		if (!this._bodySize) {
			return 0;
		}
		return Math.max(0, CLAUDE_AGENTS_COLUMN_WIDTH + CLAUDE_AGENTS_COLUMN_MIN_CHAT_WIDTH - this._bodySize.width);
	}

	private agentsColumnFits(width: number): boolean {
		return width - CLAUDE_AGENTS_COLUMN_WIDTH >= CLAUDE_AGENTS_COLUMN_MIN_CHAT_WIDTH;
	}

	/** The Agents Sidebar button says what a click does, and why a narrow pane shows no sidebar. */
	private paintSidebarButton(side: boolean, fits: boolean): void {
		const button = this._sidebarButton;
		if (!button) {
			return;
		}
		button.classList.toggle('is-active', side && fits);
		button.setAttribute('aria-pressed', String(side));
		button.setAttribute('aria-label', side
			? localize('claudeHideAgentsSidebar', "Hide Agents Sidebar")
			: localize('claudeShowAgentsSidebar', "Show Agents Sidebar"));
		if (fits) {
			delete button.dataset.hoverNote;
		} else {
			button.dataset.hoverNote = localize('claudeAgentsSidebarNarrow', "The sidebar shows when the Agent pane is at least {0} pixels wide.", CLAUDE_AGENTS_COLUMN_WIDTH + CLAUDE_AGENTS_COLUMN_MIN_CHAT_WIDTH);
		}
	}

	focus(): void {
		if (this._setupActive && this._setupFocus) {
			this._setupFocus.focus();
			return;
		}
		this._composer?.focus();
	}

	/** Opens the session inspector (Open Session Inspector). */
	openInspector(): void {
		if (!this._inspectorOpen) {
			this.toggleInspector();
		}
	}

	/** Shows a subagent as its own read-only chat (Open Subagent Chat). */
	showSubagent(runId: string): void {
		this.openSubagent(runId);
	}

	/** Expands the sent prompt of a turn in the current session (Show Sent Prompt). */
	revealSentPrompt(turnId: string): boolean {
		if (this._subagentId) {
			this._subagentId = undefined;
			this.paintTimeline();
		}
		return this._timelineRenderer?.revealSentPrompt(turnId) ?? false;
	}

	/** Scrolls to a turn of the current session, or a card in it (chat outline and Go to Turn, issue 433). */
	revealTurn(turnId: string, targetId?: string): boolean {
		if (this._subagentId) {
			this._subagentId = undefined;
			this.paintTimeline();
		}
		return this._timelineRenderer?.revealTurn(turnId, targetId) ?? false;
	}

	/** Opens the inline find bar over the timeline, seeded with the selected text (Find in Chat, issue 890). */
	findInChat(): void {
		if (!this._timeline || !this._timelineHost) {
			return;
		}
		if (!this._find) {
			const timeline = this._timeline;
			this._find = this._register(this.instantiationService.createInstance(ClaudeChatFindWidget, {
				timeline,
				parent: this._timelineHost,
				reveal: range => {
					this._timelineRenderer?.openWorkContaining(range.startContainer);
					const target = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement;
					target?.scrollIntoView({ block: 'center' });
				},
				insetChanged: () => this._timelineScroll?.scanDomNode(),
				restoreFocus: () => this._composer?.focus(),
			}));
		}
		const selection = getWindow(this._timeline).getSelection();
		const seed = selection && !selection.isCollapsed && this._timeline.contains(selection.anchorNode) ? selection.toString().trim() : '';
		this._find.open(seed && !seed.includes('\n') ? seed : undefined);
	}

	/** Opens the side question card above the composer (Ask a Side Question, issue 433). */
	askSideQuestion(): boolean {
		return this._composer?.openSideQuestion() ?? false;
	}

	/** Starts a `/multitask` in the composer (Run Parallel Agents); false without a composer. */
	beginMultitask(): boolean {
		this._composer?.beginMultitaskDraft();
		return !!this._composer;
	}

	/** Starts a `/goal` or `/loop` in the composer (Start Goal, Start Loop), with `text` after it when given (Edit Goal); false without a composer. */
	beginSlashCommand(name: 'goal' | 'loop', text?: string): boolean {
		this._composer?.beginSlashDraft(name, text);
		return !!this._composer;
	}

	/** Puts the latest message you sent in the composer to edit (Edit Message); false without a composer. */
	editLastMessage(): boolean {
		this._composer?.editLastMessage();
		return !!this._composer;
	}

	/** Adds files to the composer as chips (Add File to Agent). */
	async attachFiles(uris: readonly URI[]): Promise<void> {
		await this._composer?.attachFiles(uris);
	}

	/** Adds text after what the composer holds for `sessionId` (inline Send to Agent); false when it shows another session. */
	appendDraft(sessionId: string, text: string): boolean {
		return this._composer?.appendDraft(sessionId, text) ?? false;
	}

	/** Queues the composer text, or sends it when nothing runs (Queue Message). */
	queueMessage(): void {
		this._composer?.queueDraft();
	}

	/** Toggle Voice Input (issue 429). */
	toggleVoice(): void {
		this._composer?.toggleVoice();
	}

	/** Shows or hides exactly what the composer will send (More > Show What Will Be Sent). */
	togglePromptPreview(): void {
		this._composer?.togglePromptPreview();
	}

	private applySession(): void {
		if (this._store.isDisposed || !this._header || !this._timeline) {
			return;
		}
		this._subagentId = undefined;
		if (this._agent.getSessions().length === 0) {
			this._agent.createSession();
			return;
		}
		this.syncTabs();
	}

	/** Patches the session tabs in place: titles, running spinners and the active tab. */
	private syncTabs(): void {
		const current = this._agent.getCurrentSession();
		// A delegated chat is not a tab of its own (issue 693).
		this._tabs?.update(this._agent.getSessions().filter(session => !session.delegatedFrom).map(session => ({
			id: session.id,
			title: session.title,
			running: this._agent.getViewState(session.id).turns.at(-1)?.status === 'running',
			pullRequest: this._agent.getViewState(session.id).pullRequest,
			status: this.statusOf(session.id),
			target: session.targetInfo,
		})), current?.delegatedFrom ? this._delegation.getRoot(current.id) : current?.id);
	}

	/** The agent's status for a tab; a newer user message (another turn) ends it. */
	private statusOf(sessionId: string): { text: string; kind: 'info' | 'attention' | 'done' } | undefined {
		const status = this._statuses.get(sessionId);
		if (status && this._agent.getViewState(sessionId).turns.length > status.turns) {
			this._statuses.delete(sessionId);
			return undefined;
		}
		return status;
	}

	/** The pull request pill on a tab: shows that session with its pull request card in view (issue 430). */
	showPullRequest(sessionId: string): void {
		const reference = this._agent.getViewState(sessionId).pullRequest;
		if (!reference) {
			return;
		}
		this._agent.selectSession(sessionId);
		this.paintTimeline();
		this._timelineRenderer?.showGitHubReference(reference);
	}

	/**
	 * Coalesces streamed events onto one animation frame. A window that gets
	 * no frames (hidden, occluded or throttled, as the Windows test window is
	 * in a long batch) would leave the last events unpainted, so a short timer
	 * paints them too; whichever fires first wins (issue 1593).
	 */
	private scheduleTimeline(): void {
		if (!this._timeline || this._timelineFrame.value) {
			return;
		}
		const targetWindow = getWindow(this._timeline);
		const paint = () => {
			this._timelineFrame.clear();
			this.paintTimeline();
		};
		const timer = setTimeout(paint, TIMELINE_FRAME_FALLBACK_MS);
		const frame = scheduleAtNextAnimationFrame(targetWindow, paint);
		this._timelineFrame.value = toDisposable(() => {
			clearTimeout(timer);
			frame.dispose();
		});
	}

	private paintTimeline(): void {
		if (this._store.isDisposed || !this._timeline || !this._timelineFollow || !this._timelineRenderer) {
			return;
		}
		const atBottom = this._timelineFollow.isAtBottom();
		const session = this._agent.getCurrentSession();
		const state = session ? this._agent.getViewState(session.id) : EMPTY_AGENT_VIEW_STATE;
		if (this._subagentId && !state.subagents.some(subagent => subagent.run.id === this._subagentId)) {
			this._subagentId = undefined;
		}
		this._overlayDisposables.clear();
		this.syncTabs();
		if (!this.syncDelegatedChrome(session)) {
			this.syncSubagentChrome(state);
		}
		this.syncDelegateQuestion(session);
		this.syncRecoveryBanner(session);
		if (this._pluginNotice?.sync(session?.id, session ? this._agent.getPluginChanges(session.id) : [], id => this._agent.restartSession(id))) {
			this.relayout();
		}
		if (this._handoffCard?.sync(session?.id, session ? readStoredClaudeHandoffCard(this._storage.get(claudeHandoffCardKey(session.id), StorageScope.WORKSPACE)) : undefined, id => this.dismissHandoffCard(id))) {
			this.relayout();
		}
		this._timelineRenderer.setDragSession(session?.id);
		this._changesBar?.update(state.turns.map(turn => turn.id));
		const hasTurns = this._timelineRenderer.render(state, this._subagentId);
		this._hasTurns = hasTurns;
		this.syncReview();
		this.paintInspector();
		if (hasTurns || this._setupActive) {
			this._empty?.remove();
			this._empty = undefined;
			this._emptyKey = undefined;
			this._emptyStore.clear();
		} else {
			this.showEmpty();
		}
		this.syncComposerHint();
		const shows = this._subagentId ?? session?.id;
		if (shows !== this._timelineShows) {
			// A place kept while hidden belongs to what the timeline showed then. What it shows now
			// opens at its own kept place, else at its end, whether the pane is shown or hidden.
			this._timelineShows = shows;
			this._timelineSession = this._subagentId ? undefined : shows;
			this._timelineFollow.restore((this._timelineSession && timelinePlaces.get(this._timelineSession)) || TIMELINE_END);
		}
		this._timelineFollow.update(atBottom);
		this._find?.contentChanged();
	}

	/** The empty state (spec 01): shortcuts and the latest sessions to pick up again (audit 21). */
	private showEmpty(): void {
		if (!this._timeline) {
			return;
		}
		const current = this._agent.getCurrentSession();
		const now = Date.now();
		// Each row says how the session stands and what it left behind, like the agents list: "Edited 3 files · 12 mins".
		const recent: ClaudeEmptyRecent[] = this._agent.getSessions()
			.filter(session => session.id !== current?.id)
			.map(session => ({ session, turns: this._agent.getViewState(session.id).turns }))
			.filter(({ turns }) => turns.length > 0)
			.map(({ session, turns }) => claudeAgentRow({ id: session.id, title: session.title, updatedAt: session.updatedAt, workspaceName: session.workspaceName, interrupted: session.interrupted, resumeFailed: session.resumeFailed, turns, auto: claudeAgentRowAuto(turns, this.configurationService.getValue<boolean>(CLAUDE_AUTO_ENABLED_SETTING) === true, session.modelName, this._delegation.getRolledUpCost(session.id)) }, now))
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, 3)
			.map(row => ({
				id: row.id,
				title: row.title,
				detail: [row.subtitle, fromNow(row.updatedAt)].filter(Boolean).join(' · '),
				icon: claudeAgentRowIcon(row.state, row.background),
			}));
		const key = JSON.stringify(recent);
		if (this._empty?.parentElement === this._timeline && key === this._emptyKey) {
			return;
		}
		this._empty?.remove();
		const store = new DisposableStore();
		this._emptyStore.value = store;
		this._emptyKey = key;
		const keyOf = (commandId: string) => this.keybindingService.lookupKeybinding(commandId)?.getLabel() ?? undefined;
		this._empty = renderClaudeEmptyState(this._timeline, {
			markUri,
			shortcuts: [
				{ label: localize('claudeEmptyFocus', "Focus Agent"), keys: keyOf(CLAUDE_FOCUS_AGENT_COMMAND_ID) },
				{ label: localize('claudeEmptyInlineEdit', "Inline Edit"), keys: keyOf(CLAUDE_INLINE_EDIT_COMMAND_ID) },
				{ label: localize('claudeEmptyAddContext', "Add Selection to Agent"), keys: keyOf(CLAUDE_ADD_SELECTION_COMMAND_ID) },
				{ label: localize('claudeEmptyPlan', "Plan Mode"), keys: claudeShiftTabLabel() },
			],
			recent,
		}, store, sessionId => {
			this._agent.selectSession(sessionId);
			void this._agent.resume(sessionId).catch(() => undefined);
		});
	}

	/** Shows the hint row with the empty state, with the runtime state the setup service reports. */
	private syncComposerHint(): void {
		const hint = this._composerHint;
		if (!hint || !this._composerHintRuntime) {
			return;
		}
		const show = !this._hasTurns && !this._subagentShown;
		this.markNewChat(show);
		const runtime = this._setup.runtime;
		const state = this._setup.phase === 'ready'
			? localize('claudeHintReady', "Ready")
			: this._setup.phase === 'checking' ? localize('claudeHintChecking', "Checking...") : undefined;
		const text = state
			? runtime?.version
				? localize('claudeHintRuntimeVersion', "Claude Code {0} · {1}", runtime.version, state)
				: localize('claudeHintRuntime', "Claude Code · {0}", state)
			: '';
		this._composerHintRuntime.textContent = text;
		if (hint.hidden === !show) {
			return;
		}
		hint.hidden = !show;
		if (this._lastLayout) {
			this.layoutTimeline(this._lastLayout.height, this._lastLayout.width);
		}
	}

	private fixTurnProblems(turnId: string): void {
		const items = this._diagnostics.getProblems(turnId) ?? [];
		if (items.length === 0) {
			return;
		}
		void this._actions.run({
			id: 'fixProblems',
			source: 'button',
			attachments: [{ kind: 'diagnostics', items: items.slice() }],
		}).catch(error => this.report(error));
	}

	/** The run_in_terminal call of this chat's session that waits for the user on `command` (issue 452). */
	private findTerminalRun(command: string): ClaudeTerminalRunView | undefined {
		const session = this._agent.getCurrentSession();
		const runtimeSessionId = session ? this._agent.getRuntimeSessionId(session.id) : undefined;
		return runtimeSessionId ? this._terminalRuns.find(runtimeSessionId, command) : undefined;
	}

	private fixCommandError(card: { command?: string; cwd?: string; exitCode?: number; lines: readonly string[]; error?: string }): void {
		void this._actions.run({
			id: 'fixTerminalError',
			source: 'button',
			attachments: [{
				kind: 'terminal',
				terminalId: 0,
				lines: 200,
				title: card.command ?? 'Command',
				text: commandFailureText(card),
			}],
		}).catch(error => this.report(error));
	}

	private retryCurrent(accountId?: string, policy?: ClaudeLimitPolicy): void {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		if (policy !== undefined) {
			this._agent.setSessionLimitPolicy(session.id, policy);
		}
		const cwd = this.localFolder();
		if (!cwd) {
			this.report(localize('claudeNeedsFolder', "Open a local folder before messaging the agent."));
			return;
		}
		const pending = this._agent.retry(session.id, cwd, accountId);
		void pending.catch(error => this.report(error));
	}

	/** Continue after a turn stopped at its step limit: a new turn in the same Claude conversation (issues 696, 707). */
	private continueCurrent(): void {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		const cwd = this.localFolder();
		if (!cwd) {
			this.report(localize('claudeNeedsFolder', "Open a local folder before messaging the agent."));
			return;
		}
		void this._agent.submit(session.id, localize('claudeContinuePrompt', "Continue"), cwd, { keepDraft: true }).catch(error => this.report(error));
	}

	private _syncingReview = false;
	/** Session id, a newline, and turn id, mapped to the status last attempted. A new status loads again. */
	private readonly _reviewAttempts = new Map<string, string>();
	/** Same keys, for turns this pane saw running. Only those open their review on their own. */
	private readonly _seenRunning = new Set<string>();
	private readonly _openedAfterEdit = new Set<string>();

	/** Drops per-turn state of sessions that closed, here and in the timeline. */
	private forgetClosedSessions(): void {
		const sessions = this._agent.getSessions();
		const open = new Set(sessions.map(session => session.id));
		forgetClosedSessionTurns(this._seenRunning, open);
		forgetClosedSessionTurns(this._openedAfterEdit, open);
		forgetClosedSessionTurns(this._reviewAttempts, open);
		forgetClosedTimelinePlaces(open);
		const liveTurns = new Set<string>();
		for (const session of sessions) {
			const state = this._agent.getViewState(session.id);
			for (const turn of state.turns) {
				liveTurns.add(turn.id);
			}
			for (const subagent of state.subagents) {
				liveTurns.add(subagent.chat.id);
			}
		}
		this._timelineRenderer?.retainTurns(liveTurns);
		this._changesBar?.retainTurns(liveTurns);
	}

	private syncReview(): void {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		for (const turn of this._agent.getViewState(session.id).turns) {
			if (turn.status === 'running') {
				this._seenRunning.add(claudeSessionTurnKey(session.id, turn.id));
			}
		}
		if (this._syncingReview) {
			return;
		}
		const pending = reviewTurnsPendingLoad(
			this._agent.getViewState(session.id).turns.map(turn => ({ id: claudeSessionTurnKey(session.id, turn.id), status: turn.status })),
			this._reviewAttempts,
		);
		if (pending.length === 0) {
			return;
		}
		this._syncingReview = true;
		void (async () => {
			try {
				for (const turn of pending) {
					const turnId = turn.id.slice(session.id.length + 1);
					try {
						await this._review.ensureTurn(session.id, turnId);
						this.openAfterAgentEdit(session.id, { id: turnId, status: turn.status });
					} catch (error) {
						this.report(error instanceof Error ? error.message : String(error));
					}
					if (!this._agent.getSessions().some(candidate => candidate.id === session.id)) {
						// The session closed while its reviews loaded: keep nothing for it.
						break;
					}
					this._reviewAttempts.set(turn.id, turn.status);
				}
			} finally {
				this._syncingReview = false;
			}
		})();
	}

	/** `claude.review.openAfterAgentEdit`: opens the first change of a turn this pane saw edit files. */
	private openAfterAgentEdit(sessionId: string, turn: { readonly id: string; readonly status: string }): void {
		if (this.configurationService.getValue(CLAUDE_REVIEW_OPEN_AFTER_EDIT_SETTING) === false) {
			return;
		}
		// Under Allow Everything the user may be away: the review waits in the pane instead of taking the editor (issue 741).
		if (this._agent.getSessionPermissions(sessionId).allowEverything) {
			return;
		}
		const seen = new Set([...this._seenRunning].filter(key => key.startsWith(`${sessionId}\n`)).map(key => key.slice(sessionId.length + 1)));
		const opened = new Set([...this._openedAfterEdit].filter(key => key.startsWith(`${sessionId}\n`)).map(key => key.slice(sessionId.length + 1)));
		for (const turnId of claudeTurnsToOpenAfterEdit([turn], seen, opened, id => this._agent.isInlineEditTurn(sessionId, id))) {
			this._openedAfterEdit.add(claudeSessionTurnKey(sessionId, turnId));
			this._seenRunning.delete(claudeSessionTurnKey(sessionId, turnId));
			const review = this._review.get(sessionId, turnId);
			if (review?.files.some(file => file.state === 'pending' || file.state === 'mixed')) {
				this._review.next(sessionId, turnId);
			}
		}
	}

	private openReview(turnId: string, uri: URI, conflict: boolean): void {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		void this._reviewPane?.openFile(session.id, turnId, uri, conflict);
	}

	private acceptReviewFile(turnId: string, uri: URI): void {
		const session = this._agent.getCurrentSession();
		if (session) {
			this._review.acceptFile(session.id, turnId, uri);
		}
	}

	private rejectReviewFile(turnId: string, uri: URI): void {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		void this._review.rejectFile(session.id, turnId, uri).catch(error => {
			if (error instanceof ReviewConflictError) {
				this.openReview(turnId, uri, true);
				return;
			}
			this.report(error instanceof Error ? error.message : String(error));
		});
	}

	acceptReviewAll(turnId: string): void {
		const session = this._agent.getCurrentSession();
		if (session) {
			this._review.acceptAll(session.id, turnId);
		}
	}

	rejectReviewAll(turnId: string): void {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		void this._review.rejectAll(session.id, turnId).catch(error => {
			if (error instanceof ReviewConflictError) {
				const review = this._review.get(session.id, turnId);
				const conflicted = review?.files.find(file => file.state === 'conflicted');
				if (conflicted) {
					this.openReview(turnId, conflicted.uri, true);
				}
				return;
			}
			this.report(error instanceof Error ? error.message : String(error));
		});
	}

	/**
	 * What Keep All on the changes bar covers past the docked turn (issue 706):
	 * this chat when other turns of it wait, else every chat when other chats wait.
	 */
	private wideReviewScope(turnId: string): ReviewScope | undefined {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return undefined;
		}
		const turn = this._review.pendingSummary({ kind: 'turn', sessionId: session.id, turnId }).hunks;
		const chat = this._review.pendingSummary({ kind: 'chat', sessionId: session.id }).hunks;
		if (chat > turn) {
			return { kind: 'chat', sessionId: session.id };
		}
		return this._review.pendingSummary({ kind: 'all' }).hunks > chat ? { kind: 'all' } : undefined;
	}

	private undoKeptReview(turnId: string, uri?: URI): void {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		void this._review.undoKept(session.id, turnId, uri).catch(error => {
			if (error instanceof ReviewConflictError) {
				const conflicted = this._review.get(session.id, turnId)?.files.find(file => file.state === 'conflicted');
				if (conflicted) {
					this.openReview(turnId, conflicted.uri, true);
				}
				return;
			}
			this.report(error instanceof Error ? error.message : String(error));
		});
	}

	/** Review on the changes bar and card: every file of the turn in the review editor. */
	private openReviewEditor(turnId: string): void {
		const session = this._agent.getCurrentSession();
		if (session) {
			void this._commandService.executeCommand(CLAUDE_OPEN_REVIEW_EDITOR_COMMAND_ID, session.id, turnId).catch(error => this.report(error instanceof Error ? error.message : String(error)));
		}
	}

	private async reviewAllChanges(turnId: string): Promise<void> {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		const review = this._review.get(session.id, turnId);
		const diff = review ? formatTurnDiff(review) : '';
		try {
			await this._actions.run({
				id: 'reviewTurnChanges',
				source: 'button',
				attachments: diff ? [{ kind: 'pasted-text', id: `review-${turnId}`, text: diff, lineCount: diff.split('\n').length }] : [],
			});
		} catch (error) {
			this.report(error instanceof Error ? error.message : String(error));
		}
	}

	private async respondPermission(requestId: string, choice: ClaudePermissionCardChoice): Promise<void> {
		const session = this._agent.getCurrentSession();
		if (session) {
			await this._permissions.respond(session.id, requestId, choice);
		}
	}

	/** Answers an MCP form or sign-in in the current session (issue 428). */
	private async respondElicitation(id: string, answer: ClaudeElicitationAnswer): Promise<void> {
		const session = this._agent.getCurrentSession();
		if (session) {
			await this._elicitations.respond(session.id, id, answer);
		}
	}

	/**
	 * Switch to Agent and Retry on a write that Plan or Ask blocked: stops the
	 * turn if it still runs, switches the session to Agent, and sends the same
	 * request again with Agent's prompt.
	 */
	private async switchToAgentAndRetry(turnId: string): Promise<void> {
		const session = this._agent.getCurrentSession();
		const cwd = this.localFolder();
		if (!session) {
			return;
		}
		if (!cwd) {
			throw new Error(localize('claudeNeedsFolder', "Open a local folder before messaging the agent."));
		}
		const turn = this._agent.getViewState(session.id).turns.find(candidate => candidate.id === turnId);
		if (!turn) {
			return;
		}
		if (turn.status === 'running') {
			await this._agent.stop(session.id);
		}
		this._agent.setMode(session.id, 'agent');
		const compiled = turn.user.sent ? retargetCompiledPrompt(turn.user.sent.compiled, 'agent') : undefined;
		await this._agent.submit(session.id, turn.user.text, cwd, { compiled, keepDraft: true });
	}

	private async buildCurrent(turnId: string, notes: string, plan?: PlanArtifact): Promise<void> {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		const cwd = this.localFolder();
		if (!cwd) {
			throw new Error(localize('claudeNeedsFolder', "Open a local folder before messaging the agent."));
		}
		await this._agent.buildPlan(session.id, turnId, notes, cwd, async buildText => {
			const envelope = await this._context.resolve(buildText, 'agent', []);
			return compileSubmission(envelope);
		}, plan);
	}

	/** Build in Background Worktree on the plan card: the same prompt as Build, run by a background agent. */
	private async buildInBackground(turnId: string, notes: string, edited?: PlanArtifact): Promise<void> {
		const session = this._agent.getCurrentSession();
		const original = session && this._agent.getViewState(session.id).turns.find(turn => turn.id === turnId)?.plan;
		if (!original) {
			return;
		}
		const plan = edited ? acceptEditedPlan(original, edited) : original;
		if (!plan) {
			throw new Error(localize('claudeBuildBadEdit', "The edited plan no longer matches the plan Claude wrote."));
		}
		await this._commandService.executeCommand(CLAUDE_BACKGROUND_PROMPT_COMMAND_ID, buildPlanPrompt(plan, notes, isPlanEdited(original, plan)));
	}

	/** Open Plan on the plan card: the plan as a file in the user plans folder, `~/.klawly/plans` (issue 322), or the workspace copy once saved there, opened in the plan editor. */
	private async openPlanFile(turnId: string, notes: string, plan: PlanArtifact): Promise<void> {
		const session = this._agent.getCurrentSession();
		if (session) {
			await this._commandService.executeCommand(CLAUDE_OPEN_CHAT_PLAN_COMMAND_ID, session.id, turnId, notes, plan);
		}
	}

	private localFolder(): string | undefined {
		return this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.fsPath;
	}

	private openSubagent(runId: string): void {
		this._subagentId = runId;
		this.paintTimeline();
	}

	/** Fork from Here: a new chat holding the turns up to `turnId`. The pane follows the new session. */
	private forkFrom(turnId: string): void {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		void this._agent.forkSession(session.id, turnId).catch(error => this.report(error));
	}

	private stopSubagent(runId: string): void {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		void this._agent.stopSubagent(session.id, runId).catch(error => this.report(error));
	}

	/** Drops the pinned handoff card of chat `sessionId` for good and gives its room back. */
	private dismissHandoffCard(sessionId: string): void {
		this._storage.remove(claudeHandoffCardKey(sessionId), StorageScope.WORKSPACE);
		this._handoffCard?.sync(undefined, undefined, () => { });
		this.relayout();
	}

	private syncRecoveryBanner(session: { readonly id: string; readonly interrupted?: boolean; readonly resumeFailed?: boolean } | undefined): void {
		const banner = this._banner;
		if (!banner) {
			return;
		}
		const show = !!session && (session.interrupted || session.resumeFailed);
		banner.hidden = !show;
		if (!show || !session) {
			return;
		}
		const key = `${session.id}:${session.interrupted ? 1 : 0}:${session.resumeFailed ? 1 : 0}`;
		if (banner.dataset.key === key) {
			return;
		}
		banner.dataset.key = key;
		const store = new DisposableStore();
		this._bannerStore.value = store;
		clearNode(banner);
		append(banner, $(ThemeIcon.asCSSSelector(Codicon.warning)));
		const body = append(banner, $('.body'));
		append(body, $('.title')).textContent = session.resumeFailed
			? localize('claudeResumeFailed', "Claude could not resume this session")
			: localize('claudeInterruptedBanner', "Agent session was interrupted");
		append(body, $('.desc')).textContent = localize('claudeInterruptedDetail', "The transcript is kept. Tools are not resumed on their own.");
		const actions = append(body, $('.actions'));
		const resume = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small'));
		resume.type = 'button';
		resume.textContent = localize('claudeResume', "Resume");
		store.add(addDisposableListener(resume, EventType.CLICK, () => { void this._agent.resume(session.id); }));
		const review = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
		review.type = 'button';
		review.textContent = localize('claudeReviewChanges', "Review Changes");
		store.add(addDisposableListener(review, EventType.CLICK, () => {
			const turn = this._agent.getViewState(session.id).turns.at(-1);
			if (turn) {
				this._review.focus(session.id, turn.id);
			}
		}));
		if (session.resumeFailed) {
			const cont = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.is-primary'));
			cont.type = 'button';
			cont.textContent = localize('claudeContinueNew', "Continue in new session");
			store.add(addDisposableListener(cont, EventType.CLICK, () => { void this._agent.continueInNewSession(session.id); }));
		}
	}

	private syncSubagentChrome(state: { readonly subagents: readonly { readonly run: { readonly id: string; readonly agentType: string; readonly description: string; readonly state: string; readonly interruptedParent?: boolean } }[] }): void {
		if (!this._header || !this._footer || !this._timeline) {
			return;
		}
		const subagent = this._subagentId ? state.subagents.find(candidate => candidate.run.id === this._subagentId) : undefined;
		this._subagentShown = !!subagent;
		this._delegatedShown = false;
		this.updateFooter();
		this._commandShown = !!subagent && isBackgroundCommand(subagent.run.agentType);
		this.syncReadonlyHint(subagent?.run.interruptedParent === true);
		if (this._tabs) {
			this._tabs.element.hidden = !!subagent;
		}
		// In an editor the header holds only the crumb, so it grows and shrinks with it.
		const hadCrumb = !!this._breadcrumb;
		if (!subagent) {
			const restore = !!this._breadcrumb && this._breadcrumb.contains(getActiveElement());
			this._breadcrumb?.remove();
			this._breadcrumb = undefined;
			if (hadCrumb && this._host === 'editor') {
				this.relayout();
			}
			this._breadcrumbKey = undefined;
			this._breadcrumbStore.clear();
			this._timeline.setAttribute('aria-label', localize('claudeTimeline', "Agent timeline"));
			this._tabs?.layout();
			if (restore) {
				this._composer?.focus();
			}
			return;
		}
		const key = `${subagent.run.id}\n${subagent.run.state}\n${subagent.run.interruptedParent ? 1 : 0}\n${subagent.run.agentType}\n${subagent.run.description}`;
		if (this._breadcrumb && this._breadcrumbKey === key) {
			this._timeline.setAttribute('aria-label', this._commandShown ? localize('claudeCommandTimeline', "Background command") : localize('claudeSubagentTimeline', "Subagent chat, read only"));
			return;
		}
		if (!this._breadcrumb) {
			this._breadcrumb = $('.claude-breadcrumb');
			this._header.insertBefore(this._breadcrumb, this._actionsBar ?? null);
		}
		this._breadcrumbKey = key;
		const store = new DisposableStore();
		this._breadcrumbStore.value = store;
		const bar = this._breadcrumb;
		const active = getActiveElement();
		const restoreFocus = isHTMLElement(active) && bar.contains(active);
		clearNode(bar);
		bar.draggable = true;
		store.add(addDisposableListener(bar, 'dragstart', event => {
			const drag = event as DragEvent;
			const current = this._agent.getCurrentSession();
			if (!current) {
				return;
			}
			const asOfTurn = Math.max(1, this._agent.getViewState(current.id).turns.length);
			drag.dataTransfer?.setData(CLAUDE_CHAT_DRAG_MIME, encodeChatDrag({
				sessionId: current.id,
				subagentId: subagent.run.id,
				asOfTurn,
			}));
		}));
		// One line, "Agent / Explore: task", with Stop only while it runs (audit 18).
		const back = append(bar, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost.claude-subagent-back'));
		back.type = 'button';
		back.setAttribute('aria-label', localize('claudeBackToParent', "Back to parent"));
		append(back, $(ThemeIcon.asCSSSelector(Codicon.chevronLeft)));
		append(back, $('span')).textContent = localize('claudeAgentCrumb', "Agent");
		store.add(this.hoverService.setupDelayedHover(back, { content: localize('claudeBackToParent', "Back to parent"), additionalClasses: ['claude-root'] }));
		store.add(addDisposableListener(back, EventType.CLICK, () => {
			this._subagentId = undefined;
			this.paintTimeline();
		}));
		append(bar, $('span.sep')).textContent = '/';
		const title = append(bar, $('span.title'));
		title.textContent = `${claudeSubagentKindLabel(subagent.run.agentType)}: ${subagent.run.description}`;
		store.add(this.hoverService.setupDelayedHover(title, { content: title.textContent, additionalClasses: ['claude-root'] }));
		if (subagent.run.state === 'running') {
			const stop = append(bar, $<HTMLButtonElement>('button.claude-btn.is-small'));
			stop.type = 'button';
			stop.textContent = localize('claudeStopSubagent', "Stop");
			store.add(addDisposableListener(stop, EventType.CLICK, () => this.stopSubagent(subagent.run.id)));
		}
		if (subagent.run.state !== 'running' && !this._commandShown) {
			const continueChat = append(bar, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
			continueChat.type = 'button';
			continueChat.textContent = localize('claudeContinueSubagent', "Continue in new chat");
			store.add(addDisposableListener(continueChat, EventType.CLICK, () => {
				const current = this._agent.getCurrentSession();
				if (current) {
					void this._agent.referenceInNewSession(current.id, { subagentId: subagent.run.id });
				}
			}));
		}
		if (restoreFocus) {
			back.focus();
		}
		this._timeline.setAttribute('aria-label', this._commandShown ? localize('claudeCommandTimeline', "Background command") : localize('claudeSubagentTimeline', "Subagent chat, read only"));
		if (!hadCrumb && this._host === 'editor') {
			this.relayout();
		}
	}

	/**
	 * DL-71: a delegated chat (issue 693) reads like a subagent chat: one crumb,
	 * "Chat / Delegated · Sonnet: task", Stop while it works, and no composer.
	 * Returns false when the current chat is not a delegated chat.
	 */
	private syncDelegatedChrome(session: { readonly id: string; readonly delegatedFrom?: string } | undefined): boolean {
		if (!session?.delegatedFrom || !this._header || !this._footer || !this._timeline) {
			return false;
		}
		const parentId = session.delegatedFrom;
		const card = this._delegation.getCardForChild(session.id);
		this._subagentId = undefined;
		this._subagentShown = true;
		this._delegatedShown = true;
		this.updateFooter();
		this.syncReadonlyHint(false);
		if (this._tabs) {
			this._tabs.element.hidden = true;
		}
		this._timeline.setAttribute('aria-label', localize('claudeDelegatedTimeline', "Delegated chat, read only"));
		const running = card?.state === 'running';
		const key = `delegate\n${session.id}\n${card?.state}\n${card?.modelLabel}\n${card?.title}`;
		if (this._breadcrumb && this._breadcrumbKey === key) {
			return true;
		}
		const hadCrumb = !!this._breadcrumb;
		if (!this._breadcrumb) {
			this._breadcrumb = $('.claude-breadcrumb');
			this._header.insertBefore(this._breadcrumb, this._actionsBar ?? null);
		}
		this._breadcrumbKey = key;
		const store = new DisposableStore();
		this._breadcrumbStore.value = store;
		const bar = this._breadcrumb;
		const active = getActiveElement();
		const restoreFocus = isHTMLElement(active) && bar.contains(active);
		clearNode(bar);
		bar.draggable = false;
		const back = append(bar, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost.claude-subagent-back'));
		back.type = 'button';
		const backLabel = localize('claudeBackToDelegating', "Back to the chat that delegated");
		back.setAttribute('aria-label', backLabel);
		append(back, $(ThemeIcon.asCSSSelector(Codicon.chevronLeft)));
		append(back, $('span')).textContent = localize('claudeChatCrumb', "Chat");
		store.add(this.hoverService.setupDelayedHover(back, { content: backLabel, additionalClasses: ['claude-root'] }));
		store.add(addDisposableListener(back, EventType.CLICK, () => this._agent.selectSession(parentId)));
		append(bar, $('span.sep')).textContent = '/';
		const title = append(bar, $('span.title'));
		title.textContent = card
			? localize('claudeDelegatedCrumb', "Delegated · {0}: {1}", card.modelLabel, card.title)
			: localize('claudeDelegatedCrumbBare', "Delegated chat");
		store.add(this.hoverService.setupDelayedHover(title, { content: title.textContent, additionalClasses: ['claude-root'] }));
		if (card && running) {
			const stop = append(bar, $<HTMLButtonElement>('button.claude-btn.is-small'));
			stop.type = 'button';
			stop.textContent = localize('claudeDelegateStop', "Stop");
			store.add(addDisposableListener(stop, EventType.CLICK, () => void this._delegation.stop(card.id)));
		}
		if (restoreFocus) {
			back.focus();
		}
		if (!hadCrumb && this._host === 'editor') {
			this.relayout();
		}
		return true;
	}

	/**
	 * Stop on a delegate card pauses the top-level chat and asks here, once,
	 * above the composer: "Switch from Auto to Haiku for this chat?" (issue 693).
	 */
	private syncDelegateQuestion(session: { readonly id: string; readonly delegatedFrom?: string } | undefined): void {
		const host = this._delegateQuestion;
		if (!host) {
			return;
		}
		const question = session && !session.delegatedFrom ? this._delegation.getQuestion(session.id) : undefined;
		const key = question && session ? `${session.id}\n${question.cardId}\n${question.modelLabel}` : '';
		if ((host.dataset.key ?? '') === key) {
			return;
		}
		host.dataset.key = key;
		const hadFocus = host.contains(getActiveElement());
		clearNode(host);
		host.hidden = !question;
		if (!question || !session) {
			this._delegateQuestionStore.clear();
			this.relayout();
			if (hadFocus) {
				this._composer?.focus();
			}
			return;
		}
		const store = new DisposableStore();
		this._delegateQuestionStore.value = store;
		host.setAttribute('role', 'group');
		const text = localize('claudeDelegateSwitchQuestion', "Switch from Auto to {0} for this chat?", question.modelLabel);
		host.setAttribute('aria-label', text);
		append(host, $(ThemeIcon.asCSSSelector(Codicon.debugPause) + '.status'));
		const body = append(host, $('.body'));
		append(body, $('.title')).textContent = text;
		append(body, $('.desc')).textContent = localize('claudeDelegateSwitchDetail', "You stopped a delegated chat. Yes keeps {0} for every message here and stops delegating. No keeps Auto.", question.modelLabel);
		const actions = append(host, $('.actions'));
		const no = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.is-secondary'));
		no.type = 'button';
		no.textContent = localize('claudeDelegateKeepAuto', "No, Keep Auto");
		const yes = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.is-primary'));
		yes.type = 'button';
		yes.textContent = localize('claudeDelegateSwitchYes', "Yes, Switch");
		const sessionId = session.id;
		store.add(addDisposableListener(no, EventType.CLICK, () => this._delegation.answer(sessionId, false)));
		store.add(addDisposableListener(yes, EventType.CLICK, () => this._delegation.answer(sessionId, true)));
		this.relayout();
		yes.focus();
	}

	private async openInTerminal(cwd: string | undefined): Promise<void> {
		const folder = cwd || this.localFolder();
		if (!folder) {
			this.report(localize('claudeNeedsFolder', "Open a local folder before messaging the agent."));
			return;
		}
		const instance = await this._terminal.createTerminal({ cwd: folder });
		await instance.focusWhenReady(true);
	}

	private async rerunCommand(command: string, cwd: string | undefined): Promise<void> {
		const folder = cwd || this.localFolder();
		if (!folder) {
			this.report(localize('claudeNeedsFolder', "Open a local folder before messaging the agent."));
			return;
		}
		let askedUser = false;
		const decision = await planCommandRerun(command, {
			cwd: folder,
			workspaceFolders: this._workspace.getWorkspace().folders.filter(candidate => candidate.uri.scheme === Schemas.file).map(candidate => candidate.uri.fsPath),
			additionalDirectories: this._agent.getCurrentSession()?.additionalDirectories ?? [],
			trusted: this._trust.isWorkspaceTrusted(),
			policy: readClaudePermissionPolicy(key => this.configurationService.getValue(key)),
		}, async (why, exact) => {
			askedUser = true;
			const answer = await this._dialog.confirm({
				message: why,
				detail: exact,
				primaryButton: localize('claudeAllowOnce', "Allow once"),
			});
			return answer.confirmed;
		});
		const session = this._agent.getCurrentSession();
		if (session) {
			this._agent.recordCommandRerun(session.id, command, folder, decision.run, askedUser ? 'user' : 'policy', decision.reason);
		}
		if (!decision.run) {
			if (decision.reason) {
				this._notifications.info(decision.reason);
			}
			return;
		}
		const instance = await this._terminal.createTerminal({ cwd: folder });
		// The user asked for the run, so the terminal comes forward; focus stays in the chat (issue 733).
		this._terminal.setActiveInstance(instance);
		await this._terminal.revealActiveTerminal(true);
		await instance.sendText(command, true);
	}

	private async openCommandLog(): Promise<void> {
		await this._output.showChannel(CLAUDE_COMMAND_LOG_CHANNEL_ID, false);
	}

	private toggleInspector(): void {
		this._inspectorOpen = !this._inspectorOpen;
		this.paintTimeline();
	}

	private paintInspector(): void {
		if (!this._pane) {
			return;
		}
		if (!this._inspectorOpen) {
			this._inspectorHost?.remove();
			this._inspectorHost = undefined;
			this._inspectorStamp = undefined;
			this._inspectorDisposables.clear();
			return;
		}
		const session = this._agent.getCurrentSession();
		const retainRaw = this.configurationService.getValue(CLAUDE_DEBUG_RETAIN_RAW_SETTING) === true;
		const revision = session ? this._agent.getInspectorRevision(session.id) : 0;
		const stamp = `${session?.id ?? ''}:${revision}:${this._inspectorFilter}:${retainRaw}`;
		if (stamp === this._inspectorStamp && this._inspectorHost) {
			return;
		}
		this._inspectorStamp = stamp;
		const rows = buildInspectorRows({
			events: session ? this._agent.getSessionEvents(session.id) : [],
			rawMessages: session ? this._agent.getRawSdkMessages(session.id) : [],
			retainRaw,
			filter: this._inspectorFilter,
		});
		if (!this._inspectorHost) {
			this._inspectorHost = append(this._pane, $('.claude-inspector'));
		}
		const host = this._inspectorHost;
		const store = new DisposableStore();
		this._inspectorDisposables.value = store;
		clearNode(host);
		const filters = append(host, $('.claude-inspector-filters'));
		const choices: InspectorFilter[] = ['all', 'input', 'output', 'tool', 'permission', 'error'];
		for (const choice of choices) {
			const button = append(filters, $<HTMLButtonElement>('button.claude-btn.is-small' + (choice === this._inspectorFilter ? '.is-primary' : '.is-ghost')));
			button.type = 'button';
			button.textContent = inspectorFilterLabel(choice);
			button.setAttribute('aria-pressed', choice === this._inspectorFilter ? 'true' : 'false');
			store.add(addDisposableListener(button, EventType.CLICK, () => {
				this._inspectorFilter = choice;
				this.paintInspector();
			}));
		}
		const copy = append(filters, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
		copy.type = 'button';
		copy.textContent = localize('claudeCopyJson', "Copy as JSON");
		store.add(addDisposableListener(copy, EventType.CLICK, () => {
			void this._clipboard.writeText(inspectorJson(rows));
		}));
		const list = append(host, $('ol.claude-inspector-list'));
		for (const row of rows) {
			const item = append(list, $('li'));
			item.setAttribute('data-kind', row.kind);
			append(item, $('span.label')).textContent = row.label;
			append(item, $('span.summary')).textContent = row.summary;
		}
	}

	private report(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this._notifications.error(redactSecrets(message));
	}

	/**
	 * Shows the setup card instead of the composer while Claude is missing or
	 * signed out (spec 6, 72). A subagent chat is read only and shows neither.
	 */
	private syncSetup(): void {
		const host = this._setupHost;
		if (this._store.isDisposed || !host) {
			return;
		}
		const phase = this._setup.phase;
		const active = claudeSetupBlocksComposer(phase);
		const runtime = this._setup.runtime;
		const importOffer = this._setup.importOffer;
		const githubOffer = !!this._setup.githubOffer;
		const install = phase === 'missing' ? this._setup.installProgress : undefined;
		// The install's state, not its size: the card rewrites its live line itself, so focus stays put.
		const key = active ? JSON.stringify([phase, runtime ?? null, importOffer ?? null, githubOffer, install ? [install.state, install.startedAt, install.exitCode ?? null] : null]) : undefined;
		const changed = active !== this._setupActive;
		this._setupActive = active;
		if (key !== this._setupKey) {
			this._setupKey = key;
			const hadFocus = host.contains(getActiveElement());
			clearNode(host);
			this._setupFocus = undefined;
			if (active) {
				const store = new DisposableStore();
				this._setupStore.value = store;
				this._setupFocus = renderClaudeSetupCard(host, phase, runtime, {
					install: () => void this._setup.install(),
					installProgress: () => this._setup.installProgress,
					retryInstall: () => void this._setup.retryInstall(),
					showInstaller: () => this._setup.showInstaller(),
					cancelInstall: () => this._setup.cancelInstall(),
					redetect: () => void this._setup.redetect(),
					chooseLocation: () => void this._setup.chooseLocation(),
					signIn: () => void this._setup.signIn(),
					cancelSignIn: () => this._setup.cancelSignIn(),
					continueWithoutAI: () => void this._setup.continueWithoutAI(),
					importSettings: () => void this._setup.importSettings(),
					signInWithGitHub: githubOffer ? () => void this._setup.signInWithGitHub() : undefined,
				}, store, markUri, importOffer, install);
				if (hadFocus) {
					this._setupFocus?.focus();
				}
			} else {
				this._setupStore.clear();
			}
		}
		this.updateFooter();
		if (changed) {
			this.paintTimeline();
		} else {
			// Checking to ready, or a runtime version that arrives later, blocks nothing but changes the hint.
			this.syncComposerHint();
		}
		if (this._lastLayout) {
			this.layoutTimeline(this._lastLayout.height, this._lastLayout.width);
		}
	}

	/** The read-only hint in the composer's place while a subagent chat is open. */
	private syncReadonlyHint(interruptedParent: boolean): void {
		const hint = this._readonlyHint;
		if (!hint) {
			return;
		}
		const key = this._subagentShown ? `${this._delegatedShown}:${interruptedParent}:${this._commandShown}` : '';
		if (hint.dataset.key === key) {
			return;
		}
		hint.dataset.key = key;
		hint.hidden = !this._subagentShown;
		clearNode(hint);
		if (this._delegatedShown) {
			hint.append(localize('claudeDelegatedReadonly', "Delegated chats are read only. Go back to the chat that delegated to send a message."));
		} else if (this._subagentShown && this._commandShown) {
			// A background command is not a subagent or a chat (issue 1257).
			hint.append(localize('claudeCommandHint', "Started by the agent in the background. Stop it here or go back to the agent."));
		} else if (this._subagentShown) {
			hint.append(localize('claudeSubagentReadonly', "Subagent chats are read only. Go back to the agent to send a message."));
			if (interruptedParent) {
				append(hint, $('span.note')).textContent = localize('claudeStopInterruptedParent', "Stop interrupted the parent turn.");
			}
		}
		if (this._lastLayout) {
			this.layoutTimeline(this._lastLayout.height, this._lastLayout.width);
		}
	}

	private updateFooter(): void {
		if (this._footer) {
			this._footer.hidden = this._subagentShown || this._setupActive;
		}
		if (this._setupHost) {
			this._setupHost.hidden = this._subagentShown || !this._setupActive;
		}
	}

	/**
	 * ai-12, ai-13: the composer always sits at the bottom of the pane (issue 102); a new chat
	 * only marks the pane, so the empty state centers in the space above the composer.
	 */
	private markNewChat(newChat: boolean): void {
		const pane = this._pane;
		if (!pane || pane.classList.contains('is-new-chat') === newChat) {
			return;
		}
		pane.classList.toggle('is-new-chat', newChat);
		// A new chat's input is taller than a follow-up's (#107).
		this._composer?.refit();
	}

	/** Lays the timeline out again at the last size, after a part of the pane changed height. */
	private relayout(): void {
		if (this._lastLayout) {
			this.layoutTimeline(this._lastLayout.height, this._lastLayout.width);
		}
	}

	private layoutTimeline(height: number, width: number): void {
		if (!this._pane || !this._header || !this._footer || !this._timeline || !this._timelineScroll || !this._timelineFollow) {
			return;
		}
		// A taller composer or banner keeps the end of the chat in view when it was (issue 318).
		const atBottom = this._timelineFollow.isAtBottom();
		this._pane.style.height = `${height}px`;
		this._pane.style.width = `${width}px`;
		// A header lent to the view's title row takes no room in the pane.
		const headerHeight = this._header.parentElement === this._pane ? this._header.offsetHeight : 0;
		const banner = (this._banner && !this._banner.hidden ? this._banner.offsetHeight : 0)
			+ (this._pluginNotice && !this._pluginNotice.element.hidden ? this._pluginNotice.element.offsetHeight : 0)
			+ (this._handoffCard && !this._handoffCard.element.hidden ? this._handoffCard.element.offsetHeight : 0)
			+ (this._readonlyHint && !this._readonlyHint.hidden ? this._readonlyHint.offsetHeight + 12 : 0);
		const setup = this._setupHost && !this._setupHost.hidden ? this._setupHost : undefined;
		// With no turns the setup card takes the whole pane, as the empty state would.
		const setupFills = !!setup && !this._hasTurns;
		if (setup) {
			setup.style.height = setupFills ? `${Math.max(0, height - headerHeight - banner)}px` : '';
		}
		const setupHeight = setup && !setupFills ? setup.offsetHeight : 0;
		const timelineHeight = setupFills ? 0 : Math.max(0, height - headerHeight - this._footer.offsetHeight - banner - setupHeight);
		const scrollNode = this._timelineScroll.getDomNode();
		scrollNode.style.height = `${timelineHeight}px`;
		scrollNode.style.width = `${width}px`;
		this._timeline.style.height = `${timelineHeight}px`;
		this._timelineFollow.update(atBottom);
	}

	/**
	 * More (ai-11): the session's transcript, ID and terminal resume; then the prompt
	 * preview and the inspector; then Background Agents, models and settings (audit 12, 30).
	 */
	private showMore(anchor: HTMLElement): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => this.getMoreActions(),
			getKeyBinding: action => this.keybindingService.lookupKeybinding(action.id),
			onHide: () => anchor.focus(),
		});
	}

	/** The More menu's actions, also shown by the chat editor's More button (issue 142). */
	getMoreActions(): IAction[] {
		const session = this._agent.getCurrentSession();
		const claudeSessionId = session?.claudeSessionId;
		const turns = session ? this._agent.getViewState(session.id).turns : [];
		return [
			toAction({
				id: CLAUDE_EXPORT_TRANSCRIPT_COMMAND_ID,
				label: localize('claudeExportTranscript', "Export Transcript..."),
				enabled: turns.length > 0,
				run: () => this.exportTranscript(),
			}),
			toAction({
				id: CLAUDE_COPY_CHAT_MARKDOWN_COMMAND_ID,
				label: localize('claudeCopyChatMarkdown', "Copy Chat as Markdown"),
				enabled: turns.length > 0,
				run: () => session && this._share.copyMarkdown(session.id),
			}),
			...(this._share.linksEnabled ? [toAction({
				id: CLAUDE_SHARE_CHAT_LINK_COMMAND_ID,
				label: localize('claudeShareLinkAction', "Share Link..."),
				tooltip: localize('claudeShareLinkTip', "Publish this chat, with secrets removed, as a secret GitHub gist and copy the link"),
				enabled: turns.length > 0,
				run: () => session && this._share.shareLink(session.id),
			})] : []),
			toAction({
				id: 'claude.more.copySessionId',
				label: localize('claudeCopySessionId', "Copy Session ID"),
				enabled: !!claudeSessionId,
				run: () => this._clipboard.writeText(claudeSessionId ?? ''),
			}),
			toAction({
				id: 'claude.more.resumeInTerminal',
				label: localize('claudeResumeInTerminal', "Resume in Terminal"),
				tooltip: localize('claudeResumeInTerminalTip', "Type claude --resume with this session's ID in a new terminal"),
				enabled: !!claudeSessionId && turns.at(-1)?.status !== 'running',
				run: () => this.resumeInTerminal(),
			}),
			toAction({
				id: CLAUDE_SHARE_TO_PHONE_COMMAND_ID,
				label: localize('claudeShareToPhoneAction', "Share to Phone..."),
				tooltip: localize('claudeShareToPhoneTip', "Follow and answer this chat from the Claude app or claude.ai with Claude Code's Remote Control"),
				enabled: !!claudeSessionId,
				run: () => this._commandService.executeCommand(CLAUDE_SHARE_TO_PHONE_COMMAND_ID),
			}),
			new Separator(),
			toAction({
				id: 'claude.more.preview',
				label: localize('claudePreviewPromptAction', "Show What Will Be Sent"),
				enabled: !this._subagentShown && !this._setupActive,
				run: () => this.togglePromptPreview(),
			}),
			toAction({
				id: CLAUDE_ASK_SIDE_QUESTION_COMMAND_ID,
				label: localize('claudeSideQuestionAction', "Ask a Side Question"),
				tooltip: claudeSessionId ? '' : claudeSideQuestionUnavailable(),
				enabled: !!claudeSessionId && !this._subagentShown && !this._setupActive,
				run: () => this.askSideQuestion(),
			}),
			toAction({
				id: CLAUDE_GO_TO_TURN_COMMAND_ID,
				label: localize('claudeGoToTurnAction', "Go to Turn..."),
				enabled: turns.length > 0,
				run: () => this._commandService.executeCommand(CLAUDE_GO_TO_TURN_COMMAND_ID),
			}),
			toAction({
				id: CLAUDE_OPEN_INSPECTOR_COMMAND_ID,
				label: localize('claudeInspectorAction', "Session Inspector"),
				checked: this._inspectorOpen,
				run: () => this.toggleInspector(),
			}),
			new Separator(),
			this._host === 'view'
				? toAction({
					id: CLAUDE_OPEN_CHAT_IN_EDITOR_COMMAND_ID,
					label: localize('claudeOpenChatInEditor', "Open Chat in Editor"),
					run: () => this._commandService.executeCommand(CLAUDE_OPEN_CHAT_IN_EDITOR_COMMAND_ID),
				})
				: toAction({
					id: CLAUDE_MOVE_CHAT_TO_SIDE_BAR_COMMAND_ID,
					label: localize('claudeMoveChatToSideBar', "Move Chat to Side Bar"),
					run: () => this._commandService.executeCommand(CLAUDE_MOVE_CHAT_TO_SIDE_BAR_COMMAND_ID),
				}),
			toAction({
				id: CLAUDE_OPEN_CHAT_IN_WINDOW_COMMAND_ID,
				label: localize('claudeOpenChatInWindow', "Open Chat in New Window"),
				run: () => this._commandService.executeCommand(CLAUDE_OPEN_CHAT_IN_WINDOW_COMMAND_ID),
			}),
			new Separator(),
			toAction({
				id: CLAUDE_OPEN_BACKGROUND_AGENTS_COMMAND_ID,
				label: localize('claudeBackgroundAction', "Background Agents"),
				run: () => this._commandService.executeCommand(CLAUDE_OPEN_BACKGROUND_AGENTS_COMMAND_ID),
			}),
			toAction({
				id: CLAUDE_MANAGE_MODELS_COMMAND_ID,
				label: localize('claudeManageModelsAction', "Manage Models"),
				run: () => this._commandService.executeCommand(CLAUDE_MANAGE_MODELS_COMMAND_ID),
			}),
			toAction({
				id: 'claude.more.settings',
				// The gear, the palette and the guide call it Klawly Settings (DL-30, issue 766).
				label: localize('claudeAgentSettings', "Klawly Settings"),
				run: () => this._commandService.executeCommand(CLAUDE_OPEN_SETTINGS_COMMAND_ID, 'agents'),
			}),
		];
	}

	/** Saves the current chat as Markdown where the user picks. Secrets are already removed. */
	private async exportTranscript(): Promise<void> {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		try {
			await this._share.exportTranscript(session.id);
		} catch (error) {
			this.report(error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * Opens a terminal in the session's folder with `claude --resume <id>` typed but not run,
	 * so the user sees the command before Claude Code starts.
	 */
	private async resumeInTerminal(): Promise<void> {
		const session = this._agent.getCurrentSession();
		const id = session?.claudeSessionId;
		// Claude Code session IDs are UUIDs; anything else never reaches a shell.
		if (!session || !id || !/^[\w-]+$/.test(id)) {
			return;
		}
		const folder = session.worktreePath || this.localFolder();
		if (!folder) {
			this.report(localize('claudeNeedsFolder', "Open a local folder before messaging the agent."));
			return;
		}
		const instance = await this._terminal.createTerminal({ cwd: folder });
		await instance.sendText(`claude --resume ${id}`, false);
		await instance.focusWhenReady(true);
	}

	/**
	 * History drops down from its button at any width and closes again on a second
	 * click (audit 4, #82). The agents sidebar has its own button (issue 98).
	 */
	toggleHistory(): void {
		const anchor = this.historyAnchor();
		if (anchor) {
			this._historyPopover?.toggle(anchor);
		}
	}

	/** Open Agent History: the history dropdown under the History button, at any width. */
	showHistory(): void {
		const anchor = this.historyAnchor();
		if (anchor) {
			this._historyPopover?.show(anchor);
		}
	}

	/**
	 * An editor tab has no header row: its History button is in the editor title,
	 * so the tab hands that button in for the history dropdown (issue 356).
	 */
	setHistoryAnchor(anchor: () => HTMLElement | undefined): void {
		this._historyAnchor = anchor;
	}

	private historyAnchor(): HTMLElement | undefined {
		return this._historyButton ?? this._historyAnchor?.();
	}

	/** Header icon buttons: an aria label, and a hover with the label and keybinding (audit 12). */
	private iconButton(icon: ThemeIcon, label: string, commandId: string | undefined, run: () => void): HTMLButtonElement {
		const button = $<HTMLButtonElement>('button.claude-icon-btn');
		button.type = 'button';
		button.setAttribute('aria-label', label);
		this._register(this.hoverService.setupDelayedHover(button, () => {
			const key = commandId ? this.keybindingService.lookupKeybinding(commandId)?.getLabel() : undefined;
			// A button can change its label as its state changes (Show/Hide Agents Sidebar).
			const current = button.getAttribute('aria-label') ?? label;
			const content = key ? localize('claudeLabelWithKey', "{0} ({1})", current, key) : current;
			const note = button.dataset.hoverNote;
			return { content: note ? localize('claudeLabelWithNote', "{0}. {1}", content, note) : content, additionalClasses: ['claude-root'] };
		}));
		append(button, $(ThemeIcon.asCSSSelector(icon)));
		this._register(addDisposableListener(button, EventType.CLICK, event => {
			event.preventDefault();
			run();
		}));
		return button;
	}
}
