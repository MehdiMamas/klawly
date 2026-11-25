/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, DisposableResizeObserver, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Action, toAction } from '../../../../../base/common/actions.js';
import { parseChatDrag, CLAUDE_CHAT_DRAG_MIME, withChatAttachment } from '../../../../../platform/claude/common/claudeChatReference.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { basename } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { localize } from '../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { extractEditorsDropData } from '../../../../../platform/dnd/browser/dnd.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ClaudeModelInfo, IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { ClaudeAccountEntry } from '../../../../../platform/claude/common/claudeAccounts.js';
import { CLAUDE_ACCOUNTS_DEFAULT_ACCOUNT_SETTING, claudeChatAccountLabel, readClaudeDefaultAccountId, resolveClaudeChatAccount } from '../../../../../platform/claude/common/claudeChatAccount.js';
import { IClaudeActionService } from '../../../../../platform/claude/common/claudeActions.js';
import { IClaudeWorktreeService } from '../../../../../platform/claude/common/claudeBackground.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ClaudeSessionSettings } from '../../../../../platform/claude/common/claudeSessionSettings.js';
import { CLAUDE_AUTO_ENABLED_SETTING, CLAUDE_COMPOSER_PASTE_AS_REFERENCE_SETTING, CLAUDE_COMPOSER_WHILE_WORKING_SETTING, CLAUDE_LEGACY_LONG_PASTE_SETTING, CLAUDE_LONG_PASTE_SETTING, CLAUDE_MODELS_CUSTOM_SETTING, CLAUDE_MODELS_ENABLED_SETTING, readClaudeLongPasteChars, readClaudePasteAsReference, readClaudeWhileWorking } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { CLAUDE_DEFAULT_MODEL_ALIAS, claudeModelDisplayName, pickableClaudeModels, readClaudeModelIdList } from '../../../../../platform/claude/common/claudeModels.js';
import { AgentMode, ContextAttachment } from '../../../../../platform/claude/common/claudeContext.js';
import { claudeRunsUnasked } from '../../../../../platform/claude/common/claudeSessionPermissions.js';
import { AgentEnvelope, compileSubmission, decidePaste, decideWorkspaceDrop, describeResolved, pinnedCommandResolution, selectionIsStale } from '../../../../../platform/claude/common/claudePrompt.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ClaudeAgentSession, IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { ElicitationEntry } from '../../../../services/claude/common/claudeAgentState.js';
import { askClaudeStoppedChanges } from './claudeStoppedChanges.js';
import { IClaudeCheckpointService } from '../../../../services/claude/common/claudeCheckpointService.js';
import { ClaudeRewindCommit, ClaudeRewindGroups, ClaudeRewindPickItem, claudeRewindCommitsNote, parseClaudeRewindCommits, claudeRewindFiles, claudeRewindGroups, claudeRewindHelperLabel, claudeRewindPickItems, claudeRewindSelection, claudeRewindTurnIds } from '../../../../services/claude/common/claudeRewind.js';
import { IClaudeElicitationService } from '../../../../services/claude/common/claudeElicitationService.js';
import { IClaudeContextService } from '../../../../services/claude/common/claudeContextService.js';
import { IClaudeCopyTracker } from '../../../../services/claude/common/claudeCopyTracker.js';
import { CLAUDE_COMPARE_MODELS_COMMAND_ID } from '../../../../services/claude/common/claudeComparison.js';
import { appendAgentDraft } from '../../../../services/claude/common/claudeInlineEdit.js';
import { redactSecrets } from '../../../../services/claude/common/claudeAgentLog.js';
import { CLAUDE_BACKGROUND_PROMPT_COMMAND_ID } from '../../../../services/claude/common/claudeBackgroundAgent.js';
import { CLAUDE_ADD_SELECTION_COMMAND_ID, CLAUDE_EXPLAIN_SELECTION_COMMAND_ID, CLAUDE_MANAGE_MODELS_COMMAND_ID, CLAUDE_OPEN_REVIEW_EDITOR_COMMAND_ID, CLAUDE_OPEN_SETTINGS_COMMAND_ID, CLAUDE_STOP_AGENT_COMMAND_ID } from '../../common/claudeViews.js';
import { screenClaudeAttachmentSecrets } from '../../common/claudeSecretGuard.js';
import { ClaudeAutoStatusActionId, ClaudeAutoStatusInput, ClaudeAutoStatusState, claudeAutoNoticeSeverity, claudeAutoStatus } from '../../common/claudeAutoStatus.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { setClaudeAutoEnabled } from '../../common/claudeAutoSwitch.js';
import { claudeAutoPickLabel, claudeFastModeDropNotice, claudeModelQualifier, isLongClaudePrompt } from '../../common/claudeModelControls.js';
import { claudeComposerMeta, ClaudeComposerMeta, claudeContextUsage, claudeRuntimeModel, EMPTY_COMPOSER_META, foldClaudeRuntimeModel, claudeSlashDraftWithText, showClaudeTodos, spliceClaudeMention } from '../../common/claudeComposerState.js';
import { withClaudeDelegateTemplateSlash } from '../../common/claudeDelegateTemplateSlash.js';
import { withClaudeVisualize } from '../../common/claudeVisualize.js';
import { withClaudeCanvas } from '../../common/claudeCanvasSlash.js';
import { claudePastePillAt, claudePastePillLabel, claudePastePillRuns, claudePastePillToken, isClaudePastePill, pruneClaudePastePills } from '../../common/claudePastePill.js';
import { isInsideWorkspace } from '../claudeContextService.js';
import { ClaudeComposerTodos } from './claudeComposerTodos.js';
import { CLAUDE_AUTO_COST_NOTIFY_USD_SETTING, CLAUDE_AUTO_COST_STOP_USD_SETTING, claudeAutoCostNotifyDetail, claudeAutoCostNotifyLabel, claudeAutoCostState, claudeAutoCostStopDetail, claudeAutoCostStopLabel, formatClaudeAutoCostLogLine, formatClaudeAutoCostUsd, raiseClaudeAutoCostStop, readClaudeAutoCostNotify, readClaudeAutoCostStop } from '../../../../../platform/claude/common/claudeAutoCostGuard.js';
import { INotificationService, NotificationPriority, Severity } from '../../../../../platform/notification/common/notification.js';
import { IClaudeDelegationService } from '../../../../services/claude/common/claudeDelegation.js';
import { CLAUDE_AUTO_CONTEXT_CAP_TOKENS_SETTING, claudeAutoContextNudgeDetail, claudeAutoContextNudgeLabel, claudeAutoContextState, formatClaudeAutoContextLogLine, readClaudeAutoContextCap } from '../../../../../platform/claude/common/claudeAutoContextGuard.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ClaudeGoalLoopStrip } from './claudeGoalLoopStrip.js';
import { ClaudeMultitaskCards } from './claudeMultitaskCards.js';
import { ClaudeModelSwitchNoticeView } from './claudeModelSwitchNotice.js';
import { IClaudeModelSwitchService } from '../claudeModelSwitch.js';
import { assignMultitaskAttachments, CLAUDE_MULTITASK_RUN_QUEUED_COMMAND_ID, MultitaskPrompt, multitaskPromptsProblem, parseMultitaskPrompts } from '../../../../services/claude/common/claudeMultitask.js';
import { ClaudeComposerVoice } from './claudeComposerVoice.js';
import { ClaudeContextPicker, ContextPickerItem } from './claudeContextPicker.js';
import { appendClaudeImageThumb, ClaudeImageThumbnails } from './claudeImageThumbnails.js';
import { claudeImageLabel } from '../../common/claudeImageAttachments.js';
import { claudeContextMenuEntries, ClaudeContextRing } from './claudeContextRing.js';
import { appendClaudeKbd, claudeEnterKeyLabel, claudeShiftTabLabel, claudeSteerKeyLabel } from './claudeKbd.js';
import { ClaudeModelMenu } from './claudeModelMenu.js';
import { composerPlaceholder, describeMode, nextMode } from './claudeModes.js';
import { ClaudeModeMenu } from './claudeModeMenu.js';
import { ClaudeRunInPicker } from './claudeRunInPicker.js';
import { ClaudeSessionSwitchBadges } from './claudeSessionSwitches.js';
import { ClaudeSideQuestion, claudeSideQuestionUnavailable } from './claudeSideQuestion.js';
import { parseBtwQuestion } from '../../../../../platform/claude/common/claudeSideQuestion.js';
import { ClaudePopoverMenu } from '../widgets/claudePopoverMenu.js';
import { ClaudeNoFolderStrip } from './claudeNoFolderStrip.js';

export interface ClaudeComposerHost {
	localFolder(): string | undefined;
	report(error: unknown): void;
	requestLayout(): void;
}

/**
 * Composer card: chips, multiline input, `@` / `/` menus, paste and drop.
 * The mode pill picks Agent, Plan, or Ask for the next turn.
 */

export class ClaudeComposer extends Disposable {
	private readonly _input: HTMLTextAreaElement;
	private readonly _chips: HTMLElement;
	/** Draws the pasted-text pills behind the input's own text (issue 737, DL-77). */
	private readonly _pills: HTMLElement;
	private readonly _queue: HTMLElement;
	/** Says an earlier message is being edited (issue 702), with Cancel. */
	private readonly _editStrip: HTMLElement;
	/** The edited text set aside while the original message shows in the composer (issue 1054), else undefined. */
	private _editedWhileOriginal: string | undefined;
	private readonly _showOriginalButton: HTMLButtonElement;
	private readonly _contextStrip: HTMLElement;
	private _contextHandoffFor: string | undefined;
	/** Issue 1218, DL-109: the cost strip (notify, then Waiting for You), and per-chat state kept for the window. */
	private readonly _costStrip: HTMLElement;
	/** Issue 996, DL-14 and DL-78: says why Send cannot run without a folder and offers Open Project…, leaving the typed text alone. */
	private readonly _noFolder: ClaudeNoFolderStrip;
	private readonly _costState: HTMLElement;
	private readonly _costLabel: HTMLElement;
	private readonly _costDetail: HTMLElement;
	private readonly _costButtons: HTMLElement;
	private readonly _costNotified = new Set<string>();
	private readonly _costDismissed = new Set<string>();
	private readonly _costStopped = new Set<string>();
	private readonly _costLimit = new Map<string, number>();
	/** Issue 1220, DL-109 and DL-110: the Auto run in plain words, its model, live cost and one main action. */
	private readonly _autoStrip: HTMLElement;
	/** The state last painted per turn, so a notification fires once on the change (issue 1220). */
	private readonly _autoNoticed = new Map<string, ClaudeAutoStatusState>();
	private readonly _autoStatusLabel: HTMLElement;
	private readonly _autoStatusDetail: HTMLElement;
	private readonly _autoStatusCost: HTMLElement;
	private readonly _autoStatusButtons: HTMLElement;
	/** The earlier message in the composer, and the draft it replaced. Sending goes back to it first. */
	private _editing: { readonly sessionId: string; readonly turnId: string; readonly draft: string; readonly attachments: readonly ContextAttachment[] } | undefined;
	private readonly _sendGroup: HTMLElement;
	private readonly _queueButton: HTMLButtonElement;
	private readonly _steerButton: HTMLButtonElement;
	private readonly _send: HTMLButtonElement;
	private readonly _modeButton: HTMLButtonElement;
	/** The command or skill pinned to the chat (issue 488); clicking it unpins it. */
	private readonly _pinnedButton: HTMLButtonElement;
	private readonly _accountButton: HTMLButtonElement;
	private readonly _modelButton: HTMLButtonElement;
	private readonly _modeMenu: ClaudeModeMenu;
	private readonly _switches: ClaudeSessionSwitchBadges;
	/** Suggests Plan mode for a long Agent prompt. */
	private readonly _planHint: HTMLButtonElement;
	/** Inserts `@` to open the context picker; context shows as chips only once attached. */
	private readonly _mention: HTMLButtonElement;
	private readonly _attach: HTMLButtonElement;
	private readonly _voice: ClaudeComposerVoice;
	private readonly _overflow: HTMLButtonElement;
	private readonly _fileInput: HTMLInputElement;
	private readonly _preview: HTMLPreElement;
	private readonly _picker: ClaudeContextPicker;
	private readonly _modelMenu: ClaudeModelMenu;
	private readonly _runIn: ClaudeRunInPicker;
	private readonly _todos: ClaudeComposerTodos;
	/** The chat's `/goal` and `/loop` (issue 486). */
	private readonly _goalLoop: ClaudeGoalLoopStrip;
	private readonly _multitask: ClaudeMultitaskCards;
	private readonly _switchNotice: ClaudeModelSwitchNoticeView;
	/** A question about the chat that is not added to it (issue 433). */
	private readonly _sideQuestion: ClaudeSideQuestion;
	private readonly _ring: ClaudeContextRing;
	private readonly _contextMenu: ClaudePopoverMenu;
	private _meta: ClaudeComposerMeta = EMPTY_COMPOSER_META;
	/**
	 * The runtime model per session, folded from each event as it arrives. The
	 * service's event log keeps only the newest entries, so a long turn would
	 * otherwise drop `session.started`. To-dos and usage come from the view state.
	 */
	private readonly _modelBySession = new Map<string, string | undefined>();
	/** Display names the runtime reported, for a model id that came from `session.started`. */
	private readonly _modelNames = new Map<string, string>();
	/** What each reported model supports, for the rows of the model menu. */
	private readonly _modelInfo = new Map<string, ClaudeModelInfo>();
	private _modelNamesRequested = false;
	private readonly _chipListeners = this._register(new DisposableStore());
	private readonly _chipActions = this._register(new DisposableStore());
	private readonly _thumbnails: ClaudeImageThumbnails;
	private readonly _queueListeners = this._register(new DisposableStore());
	private _boundSessionId: string | undefined;
	private _plainPaste = false;
	private _submitting = false;
	private _canSteer = false;
	/** Whether the send keys were last drawn with Enter on Steer. */
	private _keysSteer: boolean | undefined;
	private _queueKey: HTMLElement;
	private _steerKey: HTMLElement;
	private _steerGeneration = 0;
	private _editingQueue = false;
	/** What the queue rows show now, so a view-state change while a turn streams keeps the rows (and their hover) in place. */
	private _queueSignature: string | undefined;
	private _triggerStart = -1;
	/** The composer's last observed width (0 while hidden), so a new width, first layout or being shown again measures the input again. */
	private _fitWidth = 0;

	constructor(
		container: HTMLElement,
		private readonly _host: ClaudeComposerHost,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IContextMenuService private readonly _contextMenus: IContextMenuService,
		@IClaudeContextService private readonly _context: IClaudeContextService,
		@IClaudeCopyTracker private readonly _copies: IClaudeCopyTracker,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IDialogService private readonly _dialogs: IDialogService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@ICommandService private readonly _commands: ICommandService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IModelService private readonly _models: IModelService,
		@IFileService private readonly _files: IFileService,
		@IHoverService private readonly _hovers: IHoverService,
		@IStorageService private readonly _storage: IStorageService,
		@IKeybindingService private readonly _keybindings: IKeybindingService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IClaudeActionService private readonly _actions: IClaudeActionService,
		@IContextViewService contextViews: IContextViewService,
		@IClaudeElicitationService private readonly _elicitations: IClaudeElicitationService,
		@IClaudeCheckpointService private readonly _checkpoints: IClaudeCheckpointService,
		@IClaudeWorktreeService private readonly _git: IClaudeWorktreeService,
		@IClaudeModelSwitchService private readonly _modelSwitches: IClaudeModelSwitchService,
		@ILogService private readonly _log: ILogService,
		@IClaudeDelegationService private readonly _delegation: IClaudeDelegationService,
		@INotificationService private readonly _notifications: INotificationService,
	) {
		super();
		this._thumbnails = this._register(instantiationService.createInstance(ClaudeImageThumbnails));
		this._sideQuestion = this._register(instantiationService.createInstance(ClaudeSideQuestion, container, {
			insert: text => {
				this._input.focus();
				this.insertText(text);
			},
			requestLayout: () => this._host.requestLayout(),
		}));
		this._goalLoop = this._register(instantiationService.createInstance(ClaudeGoalLoopStrip, container, () => this._host.requestLayout(), (error: unknown) => this._host.report(error)));
		this._todos = this._register(new ClaudeComposerTodos(container, () => this._host.requestLayout()));
		this._multitask = this._register(instantiationService.createInstance(ClaudeMultitaskCards, container, () => this._host.requestLayout()));
		// DL-84: an earlier message being edited says so above the composer, in the goal strip's row (DL-61).
		this._editStrip = append(container, $('.claude-goal-strip.claude-edit-strip'));
		this._editStrip.hidden = true;
		const editRow = append(this._editStrip, $('.claude-goal-strip-row'));
		append(editRow, $(ThemeIcon.asCSSSelector(Codicon.edit))).classList.add('state');
		append(editRow, $('span.label')).textContent = localize('claudeEditingEarlier', "Editing an earlier message");
		append(editRow, $('span.detail')).textContent = localize('claudeEditingEarlierDetail', "Sending removes it and every later message");
		// Issue 1054: flip between the original message and the edit in progress.
		const originalLabel = () => this.originalButtonLabel();
		this._showOriginalButton = this.toolbarButton(editRow, Codicon.history, originalLabel());
		this._register(addDisposableListener(this._showOriginalButton, EventType.CLICK, () => {
			this.toggleOriginal();
			this.syncOriginalButton();
			this._input.focus();
		}));
		this.hover(this._showOriginalButton, originalLabel);
		const cancelEdit = this.toolbarButton(editRow, Codicon.close, localize('claudeEditingCancel', "Cancel Editing (Escape)"));
		this._register(addDisposableListener(cancelEdit, EventType.CLICK, () => {
			this.cancelEdit();
			this._input.focus();
		}));
		// Issue 846, DL-109: Auto says the context is near full in the goal strip's row; no action, Auto compacts at the cap.
		this._contextStrip = append(container, $('.claude-goal-strip.claude-context-strip'));
		this._contextStrip.hidden = true;
		const contextRow = append(this._contextStrip, $('.claude-goal-strip-row'));
		append(contextRow, $(ThemeIcon.asCSSSelector(Codicon.warning))).classList.add('state');
		append(contextRow, $('span.label')).textContent = claudeAutoContextNudgeLabel();
		append(contextRow, $('span.detail')).textContent = claudeAutoContextNudgeDetail();
		this._noFolder = new ClaudeNoFolderStrip(container, () => void this._commands.executeCommand('workbench.action.files.openFolder'));
		this._register(this._workspace.onDidChangeWorkspaceFolders(() => this.updateSendButton()));
		// Issue 1218, DL-109: Auto's cost guard in the same strip style. Notify has Continue and Stop; the stop state has Raise Limit, Stop and Hand Off With a Summary.
		this._costStrip = append(container, $('.claude-goal-strip.claude-cost-strip'));
		this._costStrip.hidden = true;
		const costRow = append(this._costStrip, $('.claude-goal-strip-row'));
		this._costState = append(costRow, $(ThemeIcon.asCSSSelector(Codicon.warning)));
		this._costState.classList.add('state');
		this._costLabel = append(costRow, $('span.label'));
		this._costDetail = append(costRow, $('span.detail'));
		this._costButtons = append(costRow, $('span.claude-cost-actions'));
		this._autoStrip = append(container, $('.claude-goal-strip.claude-auto-status'));
		this._autoStrip.hidden = true;
		this._autoStrip.setAttribute('role', 'status');
		const autoRow = append(this._autoStrip, $('.claude-goal-strip-row'));
		this._autoStatusLabel = append(autoRow, $('span.label'));
		this._autoStatusDetail = append(autoRow, $('span.detail'));
		this._autoStatusCost = append(autoRow, $('span.claude-auto-status-cost'));
		this._autoStatusButtons = append(autoRow, $('span.claude-cost-actions'));
		this.hover(this._autoStatusCost, () => localize('claudeAutoStatusCostHover', "What this chat and its helpers have cost so far"));
		// Issue 703: right above the composer, next to the model pill the user just changed.
		this._switchNotice = this._register(instantiationService.createInstance(ClaudeModelSwitchNoticeView, container, () => this._host.requestLayout(), (error: unknown) => this._host.report(error)));
		this._queue = append(container, $('.claude-queue'));
		this._queue.setAttribute('aria-label', localize('claudeQueuedMessages', "Queued messages"));
		this._queue.hidden = true;
		const composer = append(container, $('.claude-composer'));
		this._chips = append(composer, $('.claude-chips'));
		const field = append(composer, $('.claude-composer-field'));
		this._pills = append(field, $('.claude-composer-pills'));
		this._pills.setAttribute('aria-hidden', 'true');
		this._input = append(field, $<HTMLTextAreaElement>('textarea.claude-composer-input'));
		this._input.rows = 1;
		this._input.setAttribute('aria-label', localize('claudeComposerLabel', "Message the agent"));
		this._preview = append(composer, $<HTMLPreElement>('pre.claude-prompt-preview'));
		this._preview.hidden = true;
		// The input wraps by width: measure it on first layout and whenever it is shown again or resized.
		// Measured after the callback: resizing the input inside it would loop the observer.
		const fitLater = this._register(new MutableDisposable());
		const resizes = this._register(new DisposableResizeObserver('claudeComposerFit', entries => {
			const width = entries.at(-1)?.contentRect.width ?? 0;
			if (width !== this._fitWidth) {
				this._fitWidth = width;
				fitLater.value = width > 0 ? disposableTimeout(() => this.fit()) : undefined;
			}
		}, getWindow(container)));
		this._register(resizes.observe(composer));

		const toolbar = append(composer, $('.claude-composer-toolbar'));
		this._modeButton = append(toolbar, $<HTMLButtonElement>('button.claude-pill.claude-mode-pill'));
		this._modeButton.type = 'button';
		this._modeButton.setAttribute('aria-haspopup', 'menu');
		this._modeButton.setAttribute('aria-expanded', 'false');
		this._register(addDisposableListener(this._modeButton, EventType.CLICK, () => this.showModeMenu()));
		// A narrow composer shows only the mode's icon (DL-52, issue 793), so the hover names it.
		this.hover(this._modeButton, () => this._modeButton.getAttribute('aria-label') ?? '');
		this._modeMenu = this._register(instantiationService.createInstance(ClaudeModeMenu));
		this._pinnedButton = append(toolbar, $<HTMLButtonElement>('button.claude-pill.claude-pinned-command'));
		this._pinnedButton.type = 'button';
		this._pinnedButton.hidden = true;
		this._register(addDisposableListener(this._pinnedButton, EventType.CLICK, () => {
			const session = this._agent.getCurrentSession();
			if (session) {
				this._agent.setPinnedCommand(session.id, undefined);
			}
			this._input.focus();
		}));
		this.hover(this._pinnedButton, () => localize('claudePinnedCommandHover', "Every message in this chat runs /{0}. Click to stop.", this._agent.getCurrentSession()?.pinnedCommand ?? ''));
		this._switches = this._register(instantiationService.createInstance(ClaudeSessionSwitchBadges, append(toolbar, $('span.claude-session-switches')), (error: unknown) => this._host.report(error)));
		this._planHint = append(toolbar, $<HTMLButtonElement>('button.claude-plan-hint'));
		this._planHint.type = 'button';
		this._planHint.hidden = true;
		append(this._planHint, $(ThemeIcon.asCSSSelector(describeMode('plan').icon)));
		append(this._planHint, $('span.label')).textContent = localize('claudeTryPlan', "Try Plan Mode");
		appendClaudeKbd(this._planHint, claudeShiftTabLabel());
		this._planHint.setAttribute('aria-label', localize('claudeTryPlanLabel', "Switch to Plan mode: Claude plans the change before it edits"));
		this._register(addDisposableListener(this._planHint, EventType.CLICK, () => {
			this.setMode('plan');
			this._input.focus();
		}));

		// The model the next turn uses, in a menu anchored above the pill (audit 9).
		this._modelButton = append(toolbar, $<HTMLButtonElement>('button.claude-pill.is-quiet.claude-model-pill'));
		this._modelButton.type = 'button';
		this._modelButton.setAttribute('aria-haspopup', 'menu');
		this._modelButton.setAttribute('aria-expanded', 'false');
		this._modelMenu = this._register(instantiationService.createInstance(ClaudeModelMenu));
		this._register(addDisposableListener(this._modelButton, EventType.CLICK, () => void this.showModelMenu()));
		this.hover(this._modelButton, () => localize('claudeModelPillHover', "Model for the next turn: {0}", this.modelLabel()));
		// The account the next turn runs on; shown only when two accounts are signed in (issue 1350, DL-05).
		this._accountButton = append(toolbar, $<HTMLButtonElement>('button.claude-pill.is-quiet.claude-account-pill'));
		this._accountButton.type = 'button';
		this._accountButton.hidden = true;
		this._accountButton.setAttribute('aria-haspopup', 'menu');
		this._register(addDisposableListener(this._accountButton, EventType.CLICK, () => this.showAccountMenu()));
		this.hover(this._accountButton, () => localize('claudeAccountPillHover', "Account for this chat"));
		// Where Claude Code runs this agent (issue 425).
		this._runIn = this._register(instantiationService.createInstance(ClaudeRunInPicker, toolbar, (error: unknown) => this._host.report(error)));
		append(toolbar, $('span.spacer'));

		this._ring = this._register(instantiationService.createInstance(ClaudeContextRing, toolbar));
		// The ring opens what fills the context window, as `/context` lists it (issue 93).
		this._contextMenu = this._register(new ClaudePopoverMenu(contextViews, this._hovers));
		this._register(this._ring.onDidClick(() => void this.showContextMenu()));

		this._mention = this.toolbarButton(toolbar, Codicon.mention, localize('claudeAddContext', "Add context"));
		this._register(addDisposableListener(this._mention, EventType.CLICK, () => this.startMention()));
		this._attach = this.toolbarButton(toolbar, Codicon.fileMedia, localize('claudeAttachImage', "Attach image"));
		this._fileInput = append(composer, $<HTMLInputElement>('input.claude-file-input'));
		const fileInput = this._fileInput;
		fileInput.type = 'file';
		fileInput.accept = 'image/*';
		fileInput.hidden = true;
		this._register(addDisposableListener(this._attach, EventType.CLICK, () => fileInput.click()));
		this._register(addDisposableListener(fileInput, EventType.CHANGE, () => {
			const file = fileInput.files?.[0];
			fileInput.value = '';
			if (file) {
				void this.attachImageFile(file, file.name);
			}
		}));

		this._sendGroup = append(toolbar, $('span.claude-send-group'));
		this._sendGroup.hidden = true;
		this._voice = this._register(instantiationService.createInstance(ClaudeComposerVoice, composer, toolbar, this._sendGroup, this._input, {
			didChangeText: () => this.onInput(),
			submit: () => this.beginSubmit(),
			requestLayout: () => this._host.requestLayout(),
		}));
		this._queueButton = append(this._sendGroup, $<HTMLButtonElement>('button.claude-btn.is-small.claude-queue-send'));
		this._queueButton.type = 'button';
		this._queueButton.textContent = localize('claudeQueue', "Queue");
		this._queueKey = appendClaudeKbd(this._queueButton, claudeEnterKeyLabel());
		this.hover(this._queueButton, () => localize('claudeQueueHoverKey', "Send after the running turn ends ({0})", this.steersOnEnter() ? claudeSteerKeyLabel() : localize('claudeEnterKey', "Enter")));
		this._register(addDisposableListener(this._queueButton, EventType.CLICK, event => {
			event.preventDefault();
			this.beginPending('queue');
		}));
		// Steer is a labeled button with its key, not a chevron that opens a one-item menu (audit 12).
		this._steerButton = append(this._sendGroup, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost.claude-steer'));
		this._steerButton.type = 'button';
		this._steerButton.setAttribute('aria-label', localize('claudeSteerNow', "Steer now"));
		append(this._steerButton, $('span')).textContent = localize('claudeSteer', "Steer");
		this._steerKey = appendClaudeKbd(this._steerButton, claudeSteerKeyLabel());
		this.hover(this._steerButton, () => localize('claudeSteerHover', "Steer now: send into the running turn ({0})", this.steersOnEnter() ? localize('claudeEnterKey', "Enter") : claudeSteerKeyLabel()));
		this._register(addDisposableListener(this._steerButton, EventType.CLICK, event => {
			event.preventDefault();
			if (this._canSteer) {
				this.beginPending('steer');
			}
		}));

		// While a turn runs, Attach Image and the prompt preview move here (audit 11).
		this._overflow = this.toolbarButton(toolbar, Codicon.ellipsis, localize('claudeComposerMore', "More composer actions"));
		this._overflow.hidden = true;
		this._overflow.setAttribute('aria-haspopup', 'menu');
		this._register(addDisposableListener(this._overflow, EventType.CLICK, () => this.showOverflow()));

		this._send = append(toolbar, $<HTMLButtonElement>('button.claude-send'));
		this._send.type = 'button';
		this._send.disabled = true;
		this._send.setAttribute('aria-label', localize('claudeSend', "Send"));
		append(this._send, $(ThemeIcon.asCSSSelector(Codicon.arrowUp)));
		this.hover(this._send, () => this.isWorking()
			? this.withKey(localize('claudeStop', "Stop"), CLAUDE_STOP_AGENT_COMMAND_ID)
			: localize('claudeSendHover', "Send (Enter)"));
		this._register(addDisposableListener(this._send, EventType.CLICK, event => {
			event.preventDefault();
			if (this.isWorking() && !this._editing) {
				void this.stop();
			} else {
				this.beginSubmit();
			}
		}));

		this._picker = this._register(instantiationService.createInstance(ClaudeContextPicker));
		this._register(this._picker.onDidPick(item => this.applyPick(item)));
		this._register(this._picker.onDidPinCommand(command => this.pinCommand(command)));
		this._register(addDisposableListener(this._input, EventType.INPUT, () => this.onInput()));
		this._register(addDisposableListener(this._input, EventType.KEY_DOWN, event => this.onKeyDown(event)));
		this._register(addDisposableListener(this._input, EventType.KEY_UP, () => { this._plainPaste = false; }));
		this._register(addDisposableListener(this._input, EventType.PASTE, event => this.onPaste(event)));
		this._register(addDisposableListener(this._input, EventType.SCROLL, () => this.paintPills()));
		this._register(addDisposableListener(composer, EventType.DRAG_OVER, event => {
			event.preventDefault();
		}));
		this._register(addDisposableListener(composer, EventType.DROP, event => {
			event.preventDefault();
			void this.onDrop(event);
		}));
		this._register(this._agent.onDidChangeSession(change => this.applySession(change.reason === 'restored')));
		// Fast mode dropping mid-session gets one quiet notice, never a toast (issue 456).
		this._register(this._agent.onDidDropFastMode(drop => {
			const message = drop.sessionId === this._agent.getCurrentSession()?.id ? claudeFastModeDropNotice(drop.previous, drop.status) : undefined;
			if (message) {
				this._notifications.notify({ severity: Severity.Info, message, priority: NotificationPriority.SILENT });
			}
		}));
		this._register(this._modelSwitches.onDidChange(sessionId => {
			if (sessionId === this._agent.getCurrentSession()?.id) {
				this._switchNotice.update(sessionId);
			}
		}));
		this._register(this._agent.onDidChangeViewState(change => {
			this.refreshSteer();
			this.observeViewState(change.sessionId);
			this.paintAutoStatus();
		}));
		this._register(this._agent.onDidChangePending(() => this.renderQueue()));
		this._register(this._delegation.onDidChange(() => { this.guardCost(); this.paintAutoStatus(); }));
		this._register(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_COMPOSER_WHILE_WORKING_SETTING)) {
				this.updateSendButton();
			}
			if (event.affectsConfiguration(CLAUDE_AUTO_ENABLED_SETTING) || event.affectsConfiguration(CLAUDE_AUTO_CONTEXT_CAP_TOKENS_SETTING)) {
				this.guardContext();
			}
			if (event.affectsConfiguration(CLAUDE_AUTO_ENABLED_SETTING) || event.affectsConfiguration(CLAUDE_AUTO_COST_NOTIFY_USD_SETTING) || event.affectsConfiguration(CLAUDE_AUTO_COST_STOP_USD_SETTING)) {
				this.guardCost();
			}
			if (event.affectsConfiguration(CLAUDE_AUTO_ENABLED_SETTING)) {
				this.paintModel();
			}
		}));
		// The reported model comes from the session's events.
		this._register(this._agent.onDidChangeInspector(change => this.observeModel(change.sessionId)));
		// A saved session replaces its event log in one step, so read it again in full.
		this._register(this._agent.onDidLoadSession(change => {
			this._modelBySession.set(change.sessionId, claudeRuntimeModel(this._agent.getSessionEvents(change.sessionId)));
			if (this._agent.getCurrentSession()?.id === change.sessionId) {
				this.refreshMeta();
			}
		}));
		this.applySession();
	}

	/** The prompt preview, from the pane's More menu or the running overflow. */
	togglePromptPreview(): void {
		void this.togglePreview();
	}

	/** Opens the side question card; false while the chat has no Claude Code conversation to ask about. */
	openSideQuestion(): boolean {
		if (!this._sideQuestion.canAsk()) {
			return false;
		}
		this._sideQuestion.open();
		return true;
	}

	focus(): void {
		this._input.focus();
	}

	/**
	 * Run Parallel Agents (issue 686): starts a `/multitask` in the composer.
	 * Text already typed becomes its first prompts, one per line.
	 */
	beginMultitaskDraft(): void {
		const value = this._input.value;
		if (!parseMultitaskPrompts(value)) {
			const typed = value.trim();
			this._input.value = typed ? `/multitask\n${typed}\n` : '/multitask\n';
		}
		this._input.focus();
		this._input.selectionStart = this._input.selectionEnd = this._input.value.length;
		this.onInput();
	}

	/**
	 * Goal and Loop from the Command Palette (issue 901): starts a `/goal` or `/loop` in the
	 * composer. Text already typed becomes what the command is about.
	 */
	beginSlashDraft(name: string, text?: string): void {
		const value = this._input.value;
		if (text !== undefined) {
			this._input.value = claudeSlashDraftWithText(name, text, value);
		} else if (!value.startsWith(`/${name} `) && value !== `/${name}`) {
			const typed = value.trim();
			this._input.value = typed ? `/${name} ${typed}` : `/${name} `;
		}
		this._input.focus();
		this._input.selectionStart = this._input.selectionEnd = this._input.value.length;
		this.onInput();
	}

	/** Edit Message from the Command Palette (issue 901): edits the latest message you sent, like Edit on it. */
	editLastMessage(): void {
		const session = this._agent.getCurrentSession();
		const turn = session ? this._agent.getViewState(session.id).turns.at(-1) : undefined;
		if (turn) {
			this.editEarlier(turn.id);
		}
	}

	/** Add File to Agent: the same chips a drop from the Explorer makes. */
	async attachFiles(uris: readonly URI[]): Promise<void> {
		for (const uri of uris) {
			await this.attachDropped(uri);
		}
	}

	/**
	 * Send to Agent from an inline edit: adds `text` after what is typed, with the
	 * cursor at the end. False when this composer shows another session, so the
	 * caller keeps the text in that session's draft instead.
	 */
	appendDraft(sessionId: string, text: string): boolean {
		if (sessionId !== this._boundSessionId) {
			return false;
		}
		this._input.value = appendAgentDraft(this._input.value, text);
		this._input.selectionStart = this._input.selectionEnd = this._input.value.length;
		this.onInput();
		return true;
	}

	/** Queue Message: holds the draft until the running turn ends, or sends it when nothing runs. */
	queueDraft(): void {
		this.beginPending('queue');
		this._input.focus();
	}

	/** Toggle Voice Input: starts dictating at the caret, or finishes the running dictation. */
	toggleVoice(): void {
		this._voice.toggle();
	}

	private onInput(): void {
		const session = this._agent.getCurrentSession();
		if (session) {
			this._agent.setDraft(session.id, this._input.value);
			// A pill whose text the user deleted takes its pasted text with it.
			const kept = pruneClaudePastePills(this._input.value, session.attachments);
			if (kept) {
				this.setAttachments(kept);
			}
		}
		this.fit();
		this.updateSendButton();
		this.syncPicker();
		this.paintPlanHint();
	}

	/** Shows the Plan mode hint while a long prompt waits in Agent mode. */
	private paintPlanHint(): void {
		const session = this._agent.getCurrentSession();
		this._planHint.hidden = !session || session.mode !== 'agent' || this.isRunning() || !isLongClaudePrompt(this._input.value);
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (this._voice.handleKeyDown(event)) {
			return;
		}
		if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v') {
			this._plainPaste = true;
			return;
		}
		if (this._picker.isOpen) {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				this._picker.move(event.key === 'ArrowDown' ? 1 : -1);
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				this._picker.close();
				return;
			}
			// Alt+Enter on a command or skill pins it to the chat instead of inserting it (issue 488).
			const pinnable = event.key === 'Enter' && event.altKey && !event.shiftKey ? this._picker.activeCommand() : undefined;
			if (pinnable) {
				event.preventDefault();
				this._picker.close();
				this.pinCommand(pinnable);
				return;
			}
			if ((event.key === 'Enter' && !event.shiftKey) || (event.key === 'Tab' && !event.shiftKey)) {
				event.preventDefault();
				// A pick comes back through onDidPick; a category opens its submenu instead.
				this._picker.accept();
				return;
			}
			if ((event.key === 'ArrowRight' && this._picker.expand()) || (event.key === 'ArrowLeft' && this._picker.collapse())) {
				event.preventDefault();
				return;
			}
		} else if (event.key === 'Escape' && this._editing && !event.isComposing) {
			event.preventDefault();
			event.stopPropagation();
			this.cancelEdit();
			return;
		} else if (event.key === 'Escape' && !event.isComposing && this.discardStoppedEdit()) {
			// Esc after Stop: the stopped turn stays and the box holds a new message (issue 1178).
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (event.key === 'Tab' && event.shiftKey && !event.isComposing) {
			event.preventDefault();
			this.cycleMode();
			return;
		}
		if ((event.key === 'Backspace' || event.key === 'Delete') && !event.isComposing && this._input.selectionStart === this._input.selectionEnd) {
			// A pill goes in one key: select all of it and let the key delete the selection, so Undo brings it back.
			const pill = claudePastePillAt(this._input.value, this._input.selectionStart, event.key === 'Backspace' ? 'before' : 'after', this.attachments());
			if (pill) {
				this._input.setSelectionRange(pill.start, pill.end);
				return;
			}
		}
		if (event.key === 'Backspace' && this._input.selectionStart === 0 && this._input.selectionEnd === 0) {
			// Pills sit in the text, so Backspace at the start removes the last chip above it.
			const attachments = this.attachments();
			const chips = attachments.filter(attachment => !isClaudePastePill(attachment));
			if (chips.length > 0 && !event.shiftKey) {
				event.preventDefault();
				const last = chips[chips.length - 1];
				this.setAttachments(attachments.filter(attachment => attachment !== last));
				return;
			}
		}
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
			return;
		}
		if (this._submitting) {
			event.preventDefault();
			return;
		}
		if (this.isRunning() && !this._editing) {
			event.preventDefault();
			// Enter again on an empty composer with a message queued interrupts the turn and sends that message now (DL-111, issue 1242).
			const current = this._agent.getCurrentSession();
			if (current && !this.canSend() && this._agent.getPending(current.id).length > 0) {
				this._submitting = true;
				void this._agent.sendQueuedNow(current.id).catch(error => this._host.report(error)).finally(() => {
					this._submitting = false;
					this.updateSendButton();
				});
				return;
			}
			// Claude waits on a question, not on itself: Enter sends the text as the reply to it, like Reply Instead (issue 537).
			const question = event.metaKey || event.ctrlKey ? undefined : this.pendingQuestion();
			if (question) {
				void this.replyToQuestion(question);
				return;
			}
			// Enter does what the setting picks; Ctrl/Cmd+Enter does the other.
			const steer = (event.metaKey || event.ctrlKey) !== this.steersOnEnter();
			if (steer && this._canSteer) {
				this.beginPending('steer');
			} else if (this.canSend()) {
				this.beginPending('queue');
			}
			return;
		}
		if (this.canSend()) {
			event.preventDefault();
			this.beginSubmit();
		}
	}

	private onPaste(event: ClipboardEvent): void {
		const plain = this._plainPaste;
		this._plainPaste = false;
		const data = event.clipboardData;
		if (!data) {
			return;
		}
		const text = data.getData('text/plain');
		const image = imageFile(data);
		const copied = text ? this._copies.match(text) : undefined;
		const asReference = readClaudePasteAsReference(this._configuration.getValue(CLAUDE_COMPOSER_PASTE_AS_REFERENCE_SETTING));
		switch (decidePaste({ plain, hasImage: !!image, text, copied: !!copied, longPasteCharacters: this.longPasteLimit(), asReference })) {
			case 'image':
				if (image) {
					event.preventDefault();
					void this.attachImageFile(image, localize('claudePastedImage', "Pasted image"));
				}
				return;
			case 'plain':
				event.preventDefault();
				this.insertText(text);
				return;
			case 'selection-chip':
				if (!copied) {
					return;
				}
				event.preventDefault();
				this.setAttachments([...this.attachments(), {
					kind: 'selection',
					uri: copied.uri,
					range: copied.range,
					versionId: copied.versionId,
				}]);
				return;
			case 'paste-pill': {
				// The paste sits in the message as "[Pasted text #1 +12 lines]", where it was pasted, and the user types on both sides of it (issue 737).
				if (!this._agent.getCurrentSession()) {
					return;
				}
				event.preventDefault();
				const lineCount = text.replace(/\n+$/, '').split('\n').length;
				const pill = { kind: 'pasted-text' as const, id: generateUuid(), text, lineCount, label: claudePastePillLabel(this.attachments(), lineCount) };
				this.setAttachments([...this.attachments(), pill]);
				const start = this._input.selectionStart ?? this._input.value.length;
				const end = this._input.selectionEnd ?? start;
				const before = start > 0 && !/\s/.test(this._input.value[start - 1]) ? ' ' : '';
				const after = end >= this._input.value.length || !/\s/.test(this._input.value[end]) ? ' ' : '';
				this.insertText(`${before}${claudePastePillToken(pill)}${after}`);
				return;
			}
			case 'insert':
				return;
		}
	}

	private async onDrop(event: DragEvent): Promise<void> {
		const chat = parseChatDrag(event.dataTransfer?.getData(CLAUDE_CHAT_DRAG_MIME) ?? '');
		if (chat) {
			event.preventDefault();
			const source = this._agent.getHistory().find(session => session.id === chat.sessionId);
			const session = this._agent.getCurrentSession();
			if (!session) {
				return;
			}
			this.setAttachments(withChatAttachment(this.attachments(), {
				kind: 'chat',
				sessionId: chat.sessionId,
				subagentId: chat.subagentId,
				turnRange: chat.turnId ? [chat.asOfTurn, chat.asOfTurn] : [1, chat.asOfTurn],
				scope: 'summary',
				asOfTurn: chat.asOfTurn,
				title: source?.title,
				workspaceName: source?.workspaceName,
			}));
			return;
		}
		const uris: URI[] = [];
		for (const editor of extractEditorsDropData(event)) {
			if (editor.resource) {
				uris.push(editor.resource);
			}
		}
		const files = event.dataTransfer?.files;
		if (files) {
			for (const file of files) {
				const path = (file as File & { path?: string }).path;
				if (path) {
					uris.push(URI.file(path));
				} else if (file.type.startsWith('image/')) {
					await this.attachImageFile(file, file.name);
				}
			}
		}
		for (const uri of uris) {
			await this.attachDropped(uri);
		}
	}

	private async attachDropped(uri: URI): Promise<void> {
		if (!isInsideWorkspace(uri, this._workspace)) {
			const choice = await this._dialogs.prompt<'copy' | 'folder'>({
				type: 'question',
				message: localize('claudeOutsideDrop', "This file is outside the workspace."),
				detail: uri.fsPath,
				buttons: [
					{ label: localize('claudeAttachCopy', "Attach a copy"), run: () => 'copy' },
					{ label: localize('claudeAddFolder', "Add its folder"), run: () => 'folder' },
				],
				cancelButton: true,
			});
			const session = this._agent.getCurrentSession();
			if (!session || !choice.result) {
				return;
			}
			if (choice.result === 'folder') {
				const directory = uri.path.endsWith('/') ? uri.fsPath : dirnameFs(uri);
				this._agent.addAdditionalDirectory(session.id, directory);
				return;
			}
			try {
				const attachment = await this._context.copyExternalFile(uri);
				this.setAttachments([...this.attachments(), attachment]);
			} catch (error) {
				this._host.report(error);
			}
			return;
		}
		const name = basename(uri);
		let isDirectory = false;
		if (!/\.(png|jpe?g|gif|webp)$/i.test(name)) {
			try {
				const stat = await this._files.stat(uri);
				isDirectory = stat.isDirectory;
			} catch {
				isDirectory = false;
			}
		}
		switch (decideWorkspaceDrop(true, /\.(png|jpe?g|gif|webp)$/i.test(name), isDirectory)) {
			case 'image':
				this.setAttachments([...this.attachments(), { kind: 'image', localUri: uri.toString() }]);
				return;
			case 'folder':
				this.setAttachments([...this.attachments(), { kind: 'folder', uri: uri.toString() }]);
				return;
			case 'file':
				this.setAttachments([...this.attachments(), { kind: 'file', uri: uri.toString() }]);
				return;
			case 'ask':
				return;
		}
	}

	/** Stores an image and attaches it under the name people know it by, never its stored id (issue 743). */
	private async attachImageFile(file: File, name: string | undefined): Promise<void> {
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const attachment = await this._context.storeImage(bytes, file.type || 'image/png', name || undefined);
			this.setAttachments([...this.attachments(), attachment]);
		} catch (error) {
			this._host.report(error);
		}
	}

	private async togglePreview(): Promise<void> {
		if (!this._preview.hidden) {
			this._preview.hidden = true;
			this._host.requestLayout();
			return;
		}
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		try {
			const text = await this._context.preview(this._input.value, session.mode, this.attachments(), session.id);
			this._preview.textContent = redactSecrets(text);
			this._preview.hidden = false;
			this._host.requestLayout();
		} catch (error) {
			this._host.report(error);
		}
	}

	/**
	 * `/goal` and `/loop` start, stop or report in the strip above the composer
	 * instead of going to Claude as typed (issue 486). True when it was one.
	 */
	private startGoalLoop(sessionId: string, text: string, cwd: string): boolean {
		// A worktree agent runs its goal or loop turns inside its worktree (issue 888).
		const folder = this._agent.getCurrentSession()?.worktreePath || cwd;
		if (!this._goalLoop.handle(sessionId, text, folder)) {
			return false;
		}
		this.clearCommand(sessionId);
		return true;
	}

	/**
	 * `/btw <question>` asks a side question in the card above the composer,
	 * while a turn keeps running (issue 965). True when it was one; with no
	 * Claude Code conversation yet it stays in the composer and says why.
	 */
	private startSideQuestion(sessionId: string, text: string): boolean {
		const question = parseBtwQuestion(text);
		if (question === undefined) {
			return false;
		}
		if (!this._sideQuestion.canAsk()) {
			this._host.report(new Error(claudeSideQuestionUnavailable()));
			return true;
		}
		this.clearCommand(sessionId);
		this._sideQuestion.open(question);
		return true;
	}

	/**
	 * `/multitask` with one prompt per line runs the prompts in parallel as
	 * background agents instead of sending or queueing the message (issue 487).
	 * True when the message was a multitask; a bad one stays in the composer.
	 */
	private startMultitask(sessionId: string, text: string, cwd: string): boolean {
		const prompts = parseMultitaskPrompts(text);
		if (!prompts) {
			return false;
		}
		const session = this._agent.getSessions().find(candidate => candidate.id === sessionId);
		const problem = multitaskPromptsProblem(prompts);
		if (!session || problem) {
			this._host.report(new Error(problem ?? localize('claudeSubmitClosed', "That agent session is not open.")));
			return true;
		}
		const attachments = this.attachments();
		this.clearCommand(sessionId);
		this.setAttachments([]);
		void this.runMultitask(session, text, prompts, attachments, cwd);
		return true;
	}

	/**
	 * Starts a `/multitask` in the chat's mode (issue 686). Each chip goes to the
	 * lines that name it, or to every line when none does; a line with chips
	 * runs with its own compiled context, so its agent sees the attachment.
	 */
	private async runMultitask(session: ClaudeAgentSession, text: string, prompts: readonly string[], attachments: readonly ContextAttachment[], cwd: string): Promise<void> {
		try {
			let ready: (string | MultitaskPrompt)[] = [...prompts];
			if (attachments.length) {
				const assigned = assignMultitaskAttachments(prompts, attachments);
				const screened = new Map<string, AgentEnvelope>();
				ready = [];
				for (let index = 0; index < prompts.length; index++) {
					const chips = assigned[index];
					if (!chips.length) {
						ready.push(prompts[index]);
						continue;
					}
					// One context read and secret scan per distinct set of chips.
					const key = chips.map(chip => attachments.indexOf(chip)).join(',');
					let envelope = screened.get(key);
					if (!envelope) {
						envelope = await this.screenSecrets(await this._context.resolve(text, session.mode, chips, session.id));
						if (!envelope) {
							this.restoreCancelled(session.id, text, attachments);
							return;
						}
						screened.set(key, envelope);
					}
					ready.push({ text: prompts[index], compiled: compileSubmission(withClaudeCanvas(withClaudeVisualize({ ...envelope, userText: prompts[index] }, session), session)) });
				}
			}
			this._multitask.start(session.id, ready, cwd, session.mode);
		} catch (error) {
			this.restoreCancelled(session.id, text, attachments);
			this._host.report(error);
		}
	}

	/** Empties the composer and its draft after a command ran from it. */
	private clearCommand(sessionId: string): void {
		this._picker.close();
		this._input.value = '';
		this._agent.setDraft(sessionId, '');
		this.fit();
		this.updateSendButton();
	}

	/** The question Claude waits on in the current session, if any. */
	private pendingQuestion(): ElicitationEntry | undefined {
		const session = this._agent.getCurrentSession();
		return session ? this._elicitations.getPending(session.id).find(entry => !!entry.questions?.length) : undefined;
	}

	/** Sends the composer text as the reply to a pending question; a failed send puts the text back. */
	private async replyToQuestion(question: ElicitationEntry): Promise<void> {
		const session = this._agent.getCurrentSession();
		const text = this._input.value;
		if (!session || !text.trim() || this._submitting) {
			return;
		}
		this._submitting = true;
		this._input.value = '';
		this._agent.setDraft(session.id, '');
		this.fit();
		this.updateSendButton();
		try {
			await this._elicitations.respond(session.id, question.id, { action: 'accept', reply: text.trim() });
		} catch (error) {
			if (this._agent.getCurrentSession()?.id === session.id && !this._input.value) {
				this._input.value = text;
				this._agent.setDraft(session.id, text);
				this.fit();
			}
			this._host.report(error);
		} finally {
			this._submitting = false;
			this.updateSendButton();
		}
	}

	private beginPending(behavior: 'queue' | 'steer'): void {
		if (this._submitting) {
			return;
		}
		if (!this.isRunning()) {
			this.beginSubmit();
			return;
		}
		const session = this._agent.getCurrentSession();
		const text = this._input.value;
		const attachments = this.attachments();
		if (!session || (!text.trim() && attachments.length === 0)) {
			return;
		}
		const cwd = this._host.localFolder();
		if (!cwd) {
			this._host.report(new Error(localize('claudeNeedsFolder', "Open a local folder before messaging the agent.")));
			return;
		}
		if (this.startSideQuestion(session.id, text) || this.startGoalLoop(session.id, text, cwd) || this.startMultitask(session.id, text, cwd)) {
			return;
		}
		this._submitting = true;
		this._picker.close();
		this._preview.hidden = true;
		this._input.value = '';
		this._agent.setDraft(session.id, '');
		this.setAttachments([]);
		this.fit();
		this.updateSendButton();
		void this.enqueue(session.id, text, attachments, cwd, behavior);
	}

	private async enqueue(sessionId: string, text: string, attachments: readonly ContextAttachment[], cwd: string, behavior: 'queue' | 'steer'): Promise<void> {
		try {
			const session = this._agent.getSessions().find(candidate => candidate.id === sessionId);
			if (!session) {
				throw new Error(localize('claudeSubmitClosed', "That agent session is not open."));
			}
			const envelope = await this.screenSecrets(await this._context.resolve(text, session.mode, attachments, session.id));
			if (!envelope) {
				this.restoreCancelled(sessionId, text, attachments);
				return;
			}
			const compiled = compileSubmission(withClaudeDelegateTemplateSlash(withClaudeCanvas(withClaudeVisualize(envelope, session), session), session), pinnedCommandResolution(session.pinnedCommand, text));
			await this._agent.queue(sessionId, text, cwd, behavior, { compiled, attachments });
		} catch (error) {
			const session = this._agent.getCurrentSession();
			if (session?.id === sessionId && !this._input.value) {
				this._input.value = text;
				this._agent.setDraft(session.id, text);
				this.setAttachments(attachments);
			}
			this._host.report(error);
		} finally {
			this._submitting = false;
			const draft = this._agent.getCurrentSession()?.draft;
			if (draft !== undefined && !this._input.value) {
				this._input.value = draft;
			}
			this.fit();
			this.renderChips();
			this.refreshSteer();
		}
	}

	/** The secret scan before a send. Undefined means the user cancelled it. */
	private screenSecrets(envelope: AgentEnvelope): Promise<AgentEnvelope | undefined> {
		return screenClaudeAttachmentSecrets(envelope, this._dialogs, this._configuration);
	}

	/** After Cancel on the secret scan: the draft and chips come back, nothing is reported. */
	private restoreCancelled(sessionId: string, text: string, attachments: readonly ContextAttachment[]): void {
		const session = this._agent.getCurrentSession();
		if (session?.id === sessionId && !this._input.value) {
			this._input.value = text;
			this._agent.setDraft(session.id, text);
			this.setAttachments(attachments);
		}
	}

	private showOverflow(): void {
		this._contextMenus.showContextMenu({
			getAnchor: () => this._overflow,
			getActions: () => [
				toAction({ id: 'claude.composer.addContext', label: localize('claudeAddContextAction', "Add Context"), run: () => this.startMention() }),
				toAction({ id: 'claude.composer.attachImage', label: localize('claudeAttachImageAction', "Attach Image"), run: () => this._fileInput.click() }),
				toAction({ id: 'claude.composer.preview', label: localize('claudePreviewPromptAction', "Show What Will Be Sent"), run: () => this.togglePreview() }),
				toAction({ id: 'claude.composer.sideQuestion', label: localize('claudeSideQuestionAction', "Ask a Side Question"), tooltip: this._sideQuestion.canAsk() ? '' : claudeSideQuestionUnavailable(), enabled: this._sideQuestion.canAsk(), run: () => this._sideQuestion.open() }),
				toAction({ id: 'claude.composer.multitask', label: localize('claudeMultitaskAction', "Run Parallel Agents"), run: () => this.beginMultitaskDraft() }),
			],
			onHide: () => this._overflow.focus(),
		});
	}

	private async showModelMenu(): Promise<void> {
		if (this._modelMenu.isOpen) {
			this._modelMenu.close();
			return;
		}
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		let models;
		try {
			const reported = await this._runtime.listModels();
			this.noteModels(reported);
			// The list may name the pill's model for the first time.
			this.paintModel();
			// Only enabled models and custom ids (spec 34b), as Pick Model shows.
			models = pickableClaudeModels(
				reported,
				readClaudeModelIdList(this._configuration.getValue(CLAUDE_MODELS_ENABLED_SETTING)),
				readClaudeModelIdList(this._configuration.getValue(CLAUDE_MODELS_CUSTOM_SETTING)),
			);
		} catch (error) {
			this._host.report(error);
			return;
		}
		if (this._store.isDisposed || this._agent.getCurrentSession()?.id !== session.id) {
			return;
		}
		this._modelMenu.show(this._modelButton, {
			models,
			// A session on Claude Code's default runs the model that alias resolves to.
			currentId: session.modelId ?? this._meta.runtimeModel ?? this.defaultModelId(),
			// The settings rows follow what the agent service checks: the picked model, else Claude Code's default.
			model: this._modelInfo.get(session.modelId ?? CLAUDE_DEFAULT_MODEL_ALIAS),
			settings: this._agent.getSessionSettings(session.id),
			fastMode: this._agent.getFastModeStatus(session.id),
			pickModel: id => void this.pickModel(session.id, id),
			pickAuto: () => void this.pickAuto(session.id),
			setSettings: settings => void this.pickSettings(session.id, settings),
			manage: () => void this._commands.executeCommand(CLAUDE_MANAGE_MODELS_COMMAND_ID),
			compare: CommandsRegistry.getCommand(CLAUDE_COMPARE_MODELS_COMMAND_ID) ? () => void this._commands.executeCommand(CLAUDE_COMPARE_MODELS_COMMAND_ID) : undefined,
			autoOn: !!this._agent.getAutoModel(session.id),
		});
	}

	private async showContextMenu(): Promise<void> {
		if (this._contextMenu.isOpen) {
			this._contextMenu.close();
			return;
		}
		const session = this._agent.getCurrentSession();
		const usage = claudeContextUsage(this._meta.usage);
		if (!session || !usage) {
			return;
		}
		this._hovers.hideHover(true);
		// Only numbers Claude Code reported: without a breakdown the popover shows the ring's numbers alone.
		const runtimeId = this._agent.getRuntimeSessionId(session.id);
		const breakdown = runtimeId ? await this._runtime.getContextBreakdown?.(runtimeId).catch(() => undefined) : undefined;
		if (this._store.isDisposed || this._agent.getCurrentSession()?.id !== session.id || this._ring.element.hidden) {
			return;
		}
		this._contextMenu.show({
			anchor: this._ring.element,
			entries: claudeContextMenuEntries(usage, breakdown, {
				busy: this._submitting || this.isRunning(),
				compact: () => this.runCommand('/compact'),
				showFull: () => this.runCommand('/context'),
			}),
			label: localize('claudeContextMenu', "Context Window"),
			className: 'claude-context-menu',
			position: AnchorPosition.ABOVE,
		});
	}

	/** Sends a slash command as if it were typed, without touching the draft. */
	private runCommand(text: string): void {
		const session = this._agent.getCurrentSession();
		const cwd = this._host.localFolder();
		if (!session || !cwd || this._submitting || this.isRunning()) {
			return;
		}
		this._submitting = true;
		this.updateSendButton();
		void this.submit(session.id, text, [], cwd);
	}

	private async pickSettings(sessionId: string, settings: ClaudeSessionSettings): Promise<void> {
		try {
			await this._agent.setNextSettings(sessionId, settings);
		} catch (error) {
			this._host.report(error);
		}
	}

	/** The id a session with no model picked runs: what the default alias resolves to, else the runtime's first model. */
	private defaultModelId(): string | undefined {
		const model = this._modelInfo.get(CLAUDE_DEFAULT_MODEL_ALIAS);
		return model?.id === CLAUDE_DEFAULT_MODEL_ALIAS ? model.resolvedModel : model?.id;
	}

	private noteModels(models: readonly ClaudeModelInfo[]): void {
		// The pill names the model without the "(1M context)" the Context row already shows.
		for (const model of models) {
			this._modelNames.set(model.id, claudeModelDisplayName(model));
			this._modelInfo.set(model.id, model);
		}
		// A runtime that reports no default alias runs its first model when none is picked.
		if (models.length && !models.some(model => model.id === CLAUDE_DEFAULT_MODEL_ALIAS)) {
			this._modelNames.set(CLAUDE_DEFAULT_MODEL_ALIAS, claudeModelDisplayName(models[0]));
			this._modelInfo.set(CLAUDE_DEFAULT_MODEL_ALIAS, models[0]);
		}
		// `session.started` names the canonical id (`claude-opus-5-5`), so it takes the name of the row that resolves to it.
		for (const model of models) {
			const resolved = model.resolvedModel;
			if (resolved && model.id !== CLAUDE_DEFAULT_MODEL_ALIAS && !this._modelNames.has(resolved)) {
				this._modelNames.set(resolved, claudeModelDisplayName(model));
			}
		}
	}

	private async pickModel(sessionId: string, modelId: string): Promise<void> {
		try {
			if (this.autoOn()) {
				// A concrete model ends Auto; the permission level is not touched (issue 1579).
				await setClaudeAutoEnabled(this._configuration, false);
				this._agent.setAutoModel(sessionId, false);
			}
			await this._modelSwitches.switchModel(sessionId, modelId);
		} catch (error) {
			this._host.report(error);
		}
	}

	/**
	 * The effective model: the session's choice, else what the runtime reported,
	 * else the model Claude Code's default resolves to. Never "Default".
	 */
	private modelLabel(): string {
		const session = this._agent.getCurrentSession();
		if (session && this._agent.getAutoModel(session.id)) {
			return localize('claudeAutoModelLabel', "Auto");
		}
		const id = session?.modelId ?? this._meta.runtimeModel ?? CLAUDE_DEFAULT_MODEL_ALIAS;
		const name = this._modelNames.get(id);
		if (!name) {
			void this.loadModelNames();
		}
		return name ?? session?.modelName ?? (id === CLAUDE_DEFAULT_MODEL_ALIAS ? localize('claudeModelLoading', "Loading...") : id);
	}

	private async loadModelNames(): Promise<void> {
		if (this._modelNamesRequested) {
			return;
		}
		this._modelNamesRequested = true;
		try {
			const models = await this._runtime.listModels();
			this.noteModels(models);
			// An empty list (Claude Code not ready yet) lets the next repaint ask again.
			this._modelNamesRequested = models.length > 0;
		} catch {
			// The raw id stays on the pill.
			return;
		}
		if (!this._store.isDisposed && this._modelNamesRequested) {
			this.paintModel();
		}
	}

	/** The signed-in accounts, as last read from the runtime. Refreshed whenever the pill repaints. */
	private _accounts: readonly ClaudeAccountEntry[] = [];

	private async refreshAccounts(): Promise<void> {
		try {
			this._accounts = (await this._runtime.listAccounts?.()) ?? [];
		} catch {
			this._accounts = [];
		}
		if (!this._store.isDisposed) {
			this.paintAccount();
		}
	}

	private paintAccount(): void {
		const signedIn = this._accounts.filter(account => account.signedIn);
		const session = this._agent.getCurrentSession();
		if (signedIn.length < 2 || !session) {
			this._accountButton.hidden = true;
			return;
		}
		const choice = resolveClaudeChatAccount({
			chatAccountId: this._agent.getSessionAccount(session.id),
			globalDefaultAccountId: readClaudeDefaultAccountId(this._configuration.getValue(CLAUDE_ACCOUNTS_DEFAULT_ACCOUNT_SETTING)),
			accounts: this._accounts,
		});
		const account = this._accounts.find(entry => entry.id === choice?.accountId);
		clearNode(this._accountButton);
		this._accountButton.hidden = !account;
		if (account) {
			append(this._accountButton, $('span.label')).textContent = claudeChatAccountLabel(account);
			append(this._accountButton, $(ThemeIcon.asCSSSelector(Codicon.chevronDown)));
			this._accountButton.setAttribute('aria-label', localize('claudeAccountPillLabel', "Account: {0}", claudeChatAccountLabel(account)));
		}
	}

	private showAccountMenu(): void {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		const current = this._agent.getSessionAccount(session.id);
		this._contextMenus.showContextMenu({
			getAnchor: () => this._accountButton,
			getActions: () => this._accounts.filter(account => account.signedIn).map(account => toAction({
				id: `claude.composer.account.${account.id}`,
				label: claudeChatAccountLabel(account),
				checked: (current ?? this._accounts.find(entry => entry.active)?.id) === account.id,
				run: () => {
					this._agent.setSessionAccount(session.id, account.id);
					this.paintAccount();
				},
			})),
			onHide: () => this._accountButton.focus(),
		});
	}

	private paintModel(): void {
		void this.refreshAccounts();
		const label = this.modelLabel();
		const session = this._agent.getCurrentSession();
		// The settings the agent service resolves are what the next turn sends, so the pill names exactly that effort.
		const auto = session ? this._agent.getAutoModel(session.id) : undefined;
		// Auto names what it ran the last turn on, or just Auto until the first turn (issue 521).
		const qualifier = auto
			? auto.last ? claudeAutoPickLabel(auto.last) : localize('claudeAutoQualifier', "Auto")
			: session ? claudeModelQualifier(this._agent.getSessionSettings(session.id), this._agent.getFastModeStatus(session.id)) : undefined;
		clearNode(this._modelButton);
		append(this._modelButton, $('span.label')).textContent = label;
		if (qualifier) {
			append(this._modelButton, $('span.qualifier')).textContent = qualifier;
		}
		append(this._modelButton, $(ThemeIcon.asCSSSelector(Codicon.chevronDown)));
		this._modelButton.setAttribute('aria-label', qualifier
			? localize('claudeModelPillLabelQualified', "Model: {0}, {1}", label, qualifier)
			: localize('claudeModelPillLabel', "Model: {0}", label));
	}

	/** Folds the newest event of `sessionId` into its model, and repaints when it is the current session. */
	private observeModel(sessionId: string): void {
		const known = this._modelBySession.has(sessionId);
		const before = this._modelBySession.get(sessionId);
		const next = known ? foldClaudeRuntimeModel(before, this._agent.getSessionEvents(sessionId).at(-1)) : this.modelFor(sessionId);
		this._modelBySession.set(sessionId, next);
		if (next !== before && this._agent.getCurrentSession()?.id === sessionId) {
			this.refreshMeta();
		}
	}

	/** Repaints when the current session's to-dos or usage changed. Streamed deltas leave both alone. */
	private observeViewState(sessionId: string): void {
		if (this._agent.getCurrentSession()?.id !== sessionId) {
			return;
		}
		const state = this._agent.getViewState(sessionId);
		if ((state.todos ?? EMPTY_COMPOSER_META.todos) !== this._meta.todos || state.usage !== this._meta.usage) {
			this.refreshMeta();
		}
	}

	private modelFor(sessionId: string): string | undefined {
		if (!this._modelBySession.has(sessionId)) {
			this._modelBySession.set(sessionId, claudeRuntimeModel(this._agent.getSessionEvents(sessionId)));
		}
		return this._modelBySession.get(sessionId);
	}

	private refreshMeta(): void {
		const session = this._agent.getCurrentSession();
		this._meta = session ? claudeComposerMeta(this._agent.getViewState(session.id), this.modelFor(session.id)) : EMPTY_COMPOSER_META;
		this.paintModel();
		this._ring.update(this._meta.usage);
		this.paintTodos();
		this.guardContext();
		this.guardCost();
		this.paintAutoStatus();
	}

	/** Issue 1220, DL-109: one status line for the Auto run. A guard hit stays on the cost strip, so this hides while that shows. */
	private paintAutoStatus(): void {
		const session = this._agent.getCurrentSession();
		const turn = session ? this._agent.getViewState(session.id).turns.at(-1) : undefined;
		if (!session || !turn || !this.autoOn() || !this._costStrip.hidden || turn.status === 'stopped') {
			this._autoStrip.hidden = true;
			return;
		}
		const root = this._delegation.getRoot(session.id);
		const costUsd = this._delegation.getRolledUpCost(root);
		const runtime = this.modelFor(session.id);
		const modelLabel = runtime ? (this._modelNames.get(runtime) ?? runtime) : undefined;
		const question = this._delegation.getQuestion(root) ? localize('claudeAutoStatusSwitchQuestion', "Switch to a stronger model for this task?") : undefined;
		let input: ClaudeAutoStatusInput;
		if (turn.status === 'running') {
			const waiting = turn.permissions.some(entry => entry.state === 'pending') || turn.elicitations?.some(entry => entry.state === 'pending') || !!question;
			input = waiting
				? { state: 'waiting', question, modelLabel, costUsd }
				: { state: 'working', modelLabel, costUsd, helpers: turn.delegates?.filter(card => card.state === 'running').length };
		} else if (turn.status === 'failed') {
			input = { state: 'failed', modelLabel, costUsd, reason: turn.failure?.message, opusTried: /opus/i.test(runtime ?? '') };
		} else {
			const minutes = turn.startedAt !== undefined && turn.endedAt !== undefined ? Math.max(1, Math.round((turn.endedAt - turn.startedAt) / 60_000)) : undefined;
			input = { state: 'done', modelLabel, costUsd, filesChanged: turn.changedFiles.length, minutes };
		}
		const status = claudeAutoStatus(input);
		const noticeKey = `${session.id}:${turn.id}`;
		const severity = claudeAutoNoticeSeverity(this._autoNoticed.get(noticeKey), status.state);
		this._autoNoticed.set(noticeKey, status.state);
		if (severity) {
			const message = localize('claudeAutoStatusNotice', "{0}: {1}", status.label, status.detail);
			this._notifications[severity](message);
		}
		this._autoStrip.hidden = false;
		this._autoStrip.className = `claude-goal-strip claude-auto-status is-${status.state}`;
		this._autoStrip.setAttribute('aria-label', status.aria);
		this._autoStatusLabel.textContent = status.label;
		this._autoStatusDetail.textContent = status.detail;
		this._autoStatusCost.textContent = status.cost ?? '';
		clearNode(this._autoStatusButtons);
		for (const entry of status.actions) {
			const button = append(this._autoStatusButtons, $<HTMLButtonElement>('button.claude-goal-strip-btn'));
			button.type = 'button';
			button.textContent = entry.label;
			button.classList.toggle('is-primary', entry.primary);
			button.setAttribute('aria-label', localize('claudeAutoStatusActionNamed', "{0}: {1}", entry.label, status.label));
			button.addEventListener('click', () => this.runAutoStatusAction(entry.id, root));
		}
	}

	private async retryLastTurn(sessionId: string, onOpus: boolean): Promise<void> {
		const text = this._agent.getViewState(sessionId).turns.at(-1)?.user.text;
		const cwd = this._host.localFolder();
		if (!text || !cwd) {
			this.runCommand(localize('claudeAutoStatusTryAgain', "Try again."));
			return;
		}
		await this._agent.submit(sessionId, text, cwd, { keepDraft: true, ...(onOpus ? { modelId: 'opus' } : {}) });
	}

	private runAutoStatusAction(id: ClaudeAutoStatusActionId, root: string): void {
		switch (id) {
			case 'stop':
				void this.stopCostTree(root);
				break;
			case 'retry':
			case 'retryOnOpus':
				// Issue 1269: send the failed message again; Retry on Opus runs this turn on Opus and leaves the chat's own model alone.
				void this.retryLastTurn(root, id === 'retryOnOpus');
				break;
			case 'viewChanges':
				this.runCommand('/diff');
				break;
			default:
				// answer and openPr: the question card and the PR link are already in the chat above.
				this._input.focus();
		}
	}

	/** Issue 1218: with Auto on, notify once at the notify amount; at the stop amount stop the chat and its helpers and wait for the user. */
	private guardCost(): void {
		const session = this._agent.getCurrentSession();
		if (!session || !this.autoOn()) {
			this._costStrip.hidden = true;
			return;
		}
		const root = this._delegation.getRoot(session.id);
		const cost = this._delegation.getRolledUpCost(root);
		const notifyUsd = readClaudeAutoCostNotify(key => this._configuration.getValue(key));
		const stopUsd = this._costLimit.get(root) ?? readClaudeAutoCostStop(key => this._configuration.getValue(key));
		const state = claudeAutoCostState(cost, notifyUsd, stopUsd);
		if (state === 'ok' || cost === undefined) {
			this._costStopped.delete(root);
			this._costDismissed.delete(root);
			this._costStrip.hidden = true;
			return;
		}
		if (state === 'notify' && !this._costNotified.has(root)) {
			this._costNotified.add(root);
			this._notifications.info(localize('claudeAutoCostNotification', "This chat and its helpers have used {0}. Auto stops and asks at {1}", formatClaudeAutoCostUsd(cost), formatClaudeAutoCostUsd(stopUsd)));
		}
		if (state === 'stop' && !this._costStopped.has(root)) {
			this._costStopped.add(root);
			this._log.info(formatClaudeAutoCostLogLine(root, cost, stopUsd));
			void this.stopCostTree(root);
		}
		const stopped = state === 'stop';
		this._costStrip.hidden = !stopped && this._costDismissed.has(root);
		if (this._costStrip.hidden) {
			return;
		}
		this._costStrip.classList.toggle('is-stopped', stopped);
		this._costLabel.textContent = stopped ? claudeAutoCostStopLabel(cost) : claudeAutoCostNotifyLabel(cost);
		this._costDetail.textContent = stopped ? claudeAutoCostStopDetail() : claudeAutoCostNotifyDetail();
		this.paintCostButtons(root, stopped, stopUsd);
	}

	private paintCostButtons(root: string, stopped: boolean, stopUsd: number): void {
		clearNode(this._costButtons);
		const add = (label: string, run: () => void) => {
			const button = append(this._costButtons, $<HTMLButtonElement>('button.claude-goal-strip-btn'));
			button.type = 'button';
			button.textContent = label;
			button.addEventListener('click', run);
		};
		if (stopped) {
			add(localize('claudeAutoCostRaise', "Raise Limit"), () => {
				const step = readClaudeAutoCostStop(key => this._configuration.getValue(key));
				this._costLimit.set(root, raiseClaudeAutoCostStop(stopUsd, step));
				this._costStopped.delete(root);
				this.guardCost();
			});
			add(localize('claudeAutoCostStopNow', "Stop"), () => void this.stopCostTree(root));
			add(localize('claudeAutoCostHandoff', "Hand Off With a Summary"), () => this.runCommand('/compact'));
		} else {
			add(localize('claudeAutoCostContinue', "Continue"), () => {
				this._costDismissed.add(root);
				this._costStrip.hidden = true;
			});
			add(localize('claudeAutoCostStopNow', "Stop"), () => void this.stopCostTree(root));
		}
	}

	/** Interrupts the top-level chat and every helper under it, nested ones included. */
	private async stopCostTree(root: string): Promise<void> {
		const ids = this._agent.getSessions().map(session => session.id).filter(id => id !== root && this._delegation.getRoot(id) === root);
		await Promise.all([root, ...ids].map(id => this._agent.stop(id).catch(error => this._host.report(error))));
	}

	/** Issue 846: nudge at 80% of the cap; at the cap, with Auto on and the chat idle, compact once and log it. */
	private guardContext(): void {
		const session = this._agent.getCurrentSession();
		const usage = claudeContextUsage(this._meta.usage);
		const cap = readClaudeAutoContextCap(key => this._configuration.getValue(key));
		const state = session && usage && this.autoOn() ? claudeAutoContextState(usage.used, cap, usage.window) : 'ok';
		this._contextStrip.hidden = state === 'ok';
		if (state !== 'handoff') {
			this._contextHandoffFor = undefined;
			return;
		}
		if (!session || !usage || this._contextHandoffFor === session.id || this._submitting || this.isRunning()) {
			return;
		}
		this._contextHandoffFor = session.id;
		this._log.info(formatClaudeAutoContextLogLine(session.id, usage.used, cap));
		this.runCommand('/compact');
	}

	private paintTodos(): void {
		const todos = this._meta.todos;
		this._todos.update(showClaudeTodos(todos, this.isRunning()) ? todos : undefined);
	}

	private toolbarButton(toolbar: HTMLElement, icon: ThemeIcon, label: string): HTMLButtonElement {
		const button = append(toolbar, $<HTMLButtonElement>('button.claude-icon-btn'));
		button.type = 'button';
		button.setAttribute('aria-label', label);
		append(button, $(ThemeIcon.asCSSSelector(icon)));
		this.hover(button, () => label);
		return button;
	}

	private hover(target: HTMLElement, content: () => string): void {
		this._register(this._hovers.setupDelayedHover(target, () => ({ content: content(), additionalClasses: ['claude-root'] })));
	}

	private withKey(label: string, commandId: string): string {
		const key = this._keybindings.lookupKeybinding(commandId)?.getLabel();
		return key ? localize('claudeLabelWithKey', "{0} ({1})", label, key) : label;
	}

	private beginSubmit(): void {
		if (this._editing) {
			this.beginEditSubmit();
			return;
		}
		if (this._submitting || this.isRunning()) {
			return;
		}
		const session = this._agent.getCurrentSession();
		const text = this._input.value;
		const attachments = this.attachments();
		if (!session || (!text.trim() && attachments.length === 0)) {
			return;
		}
		const cwd = this._host.localFolder();
		if (!cwd) {
			this._host.report(new Error(localize('claudeNeedsFolder', "Open a local folder before messaging the agent.")));
			return;
		}
		if (this.startSideQuestion(session.id, text) || this.startGoalLoop(session.id, text, cwd) || this.startMultitask(session.id, text, cwd)) {
			return;
		}
		this._submitting = true;
		this._picker.close();
		this._preview.hidden = true;
		this._input.value = '';
		this._agent.setDraft(session.id, '');
		this.setAttachments([]);
		this.fit();
		this.updateSendButton();
		void this.submit(session.id, text, attachments, cwd);
	}

	/**
	 * Puts an earlier message in the composer to edit (issue 702). Sending takes the chat
	 * back to before it, then sends the edited text; Cancel or Escape puts the draft back.
	 */
	editEarlier(turnId: string): void {
		const session = this._agent.getCurrentSession();
		const turn = session ? this._agent.getViewState(session.id).turns.find(candidate => candidate.id === turnId) : undefined;
		if (!session || !turn || this._submitting) {
			return;
		}
		const check = this._agent.canRewind(session.id, turnId);
		if (!check.enabled) {
			this._host.report(new Error(check.reason));
			return;
		}
		this._editing = this._editing?.sessionId === session.id
			? { ...this._editing, turnId }
			: { sessionId: session.id, turnId, draft: this._input.value, attachments: this.attachments() };
		this._picker.close();
		this._editedWhileOriginal = undefined;
		this.syncOriginalButton();
		this._input.value = turn.user.text;
		this.setAttachments(this._agent.getTurnAttachments(session.id, turnId).filter(attachment => !isClaudePastePill(attachment)));
		this._editStrip.hidden = false;
		this.fit();
		this.renderChips();
		this.updateSendButton();
		this._input.focus();
		this._input.setSelectionRange(this._input.value.length, this._input.value.length);
	}

	private originalButtonLabel(): string {
		return this._editedWhileOriginal === undefined
			? localize('claudeEditingShowOriginal', "Show Original Message")
			: localize('claudeEditingShowEdit', "Back to My Edit");
	}

	private syncOriginalButton(): void {
		this._showOriginalButton.setAttribute('aria-label', this.originalButtonLabel());
		this._showOriginalButton.setAttribute('aria-pressed', String(this._editedWhileOriginal !== undefined));
	}

	/** Swaps the composer between the original text of the message being edited and the edit in progress. */
	private toggleOriginal(): void {
		const editing = this._editing;
		const session = this._agent.getCurrentSession();
		if (!editing || !session || session.id !== editing.sessionId) {
			return;
		}
		if (this._editedWhileOriginal !== undefined) {
			this._input.value = this._editedWhileOriginal;
			this._editedWhileOriginal = undefined;
		} else {
			const turn = this._agent.getViewState(session.id).turns.find(candidate => candidate.id === editing.turnId);
			if (!turn) {
				return;
			}
			this._editedWhileOriginal = this._input.value;
			this._input.value = turn.user.text;
		}
		this.fit();
		this.updateSendButton();
	}

	/** Leaves edit mode and puts back the draft the edited message replaced. */
	private cancelEdit(): void {
		const editing = this._editing;
		if (!editing) {
			return;
		}
		this.endEdit();
		this._agent.setDraft(editing.sessionId, editing.draft);
		this._agent.setAttachments(editing.sessionId, editing.attachments);
		if (this._agent.getCurrentSession()?.id === editing.sessionId) {
			this._input.value = editing.draft;
			this.fit();
			this.renderChips();
		}
		this.updateSendButton();
	}

	private endEdit(): void {
		this._editing = undefined;
		this._editedWhileOriginal = undefined;
		this.syncOriginalButton();
		this._editStrip.hidden = true;
		this._host.requestLayout();
	}

	private beginEditSubmit(): void {
		const editing = this._editing;
		const session = this._agent.getCurrentSession();
		if (!editing || this._submitting) {
			return;
		}
		if (session?.id !== editing.sessionId) {
			this.cancelEdit();
			return;
		}
		const text = this._input.value;
		const attachments = this.attachments();
		if (!text.trim() && attachments.length === 0) {
			return;
		}
		const cwd = this._host.localFolder();
		if (!cwd) {
			this._host.report(new Error(localize('claudeNeedsFolder', "Open a local folder before messaging the agent.")));
			return;
		}
		this._submitting = true;
		this._picker.close();
		this._preview.hidden = true;
		this.updateSendButton();
		void this.submitEdit(editing, text, attachments, cwd);
	}

	/** Stops a running turn, asks about the files changed since the message, goes back to it and sends the edit. */
	private async submitEdit(editing: { readonly sessionId: string; readonly turnId: string }, text: string, attachments: readonly ContextAttachment[], cwd: string): Promise<void> {
		let sent = false;
		try {
			if (this.isRunning()) {
				// Files stop changing before the question about them.
				await this._agent.stop(editing.sessionId);
			}
			const kept = await this.undoLaterChanges(editing.sessionId, editing.turnId);
			if (!kept || this._agent.getCurrentSession()?.id !== editing.sessionId) {
				return;
			}
			await this._agent.rewind(editing.sessionId, editing.turnId, kept);
			this.endEdit();
			this._input.value = '';
			this._agent.setDraft(editing.sessionId, '');
			this.setAttachments([]);
			this.fit();
			sent = true;
			await this.submit(editing.sessionId, text, attachments, cwd);
		} catch (error) {
			this._host.report(error);
		} finally {
			if (!sent) {
				this._submitting = false;
				this.updateSendButton();
			}
		}
	}

	/**
	 * Asks whether to undo what agents changed since the message (issue 702). Resolves to the
	 * paths left as they are, empty when nothing changed or it was undone, undefined on Cancel.
	 */
	private async undoLaterChanges(sessionId: string, turnId: string): Promise<readonly string[] | undefined> {
		const turnIds = claudeRewindTurnIds(this._agent.getViewState(sessionId), turnId);
		const ownFiles = claudeRewindFiles(sessionId, turnId, await this._checkpoints.readTurnsChanges(sessionId, turnIds));
		const otherSessions = this._agent.getSessions();
		const helperIds = otherSessions.filter(session => session.delegatedFrom).map(session => session.id);
		// Issue 1406: what helper chats wrote since the turn goes back with it, each file labeled with the helper's model.
		const helperTurns = await this._checkpoints.readHelperTurnIds(sessionId, turnId, helperIds);
		const files = [...ownFiles];
		const helperLabels = new Map<string, string>();
		for (const helper of helperTurns) {
			const name = otherSessions.find(session => session.id === helper.sessionId)?.modelName;
			for (const file of claudeRewindFiles(helper.sessionId, turnId, await this._checkpoints.readTurnsChanges(helper.sessionId, helper.turnIds))) {
				if (!files.some(known => known.uri.toString() === file.uri.toString())) {
					files.push(file);
					helperLabels.set(file.uri.toString(), claudeRewindHelperLabel(name));
				}
			}
		}
		if (files.length === 0) {
			return [];
		}
		const restoreTurns = async (only?: readonly string[]): Promise<boolean> => {
			for (const helper of helperTurns) {
				if (!await this._checkpoints.restoreTurns(helper.sessionId, helper.turnIds, only)) {
					return false;
				}
			}
			return this._checkpoints.restoreTurns(sessionId, turnIds, only);
		};
		const groups = claudeRewindGroups(files,
			await this._checkpoints.readOtherChatPaths(sessionId, turnId, otherSessions.map(session => session.id)),
			await this._checkpoints.readOtherChatPaths(sessionId, turnId, helperIds));
		const commits = await this.commitsSinceTurn(sessionId, turnId);
		const listed = files.map(file => localize('claudeRewindFileLine', "{0}  {1}  +{2} -{3}", file.name, file.directory, file.added, file.removed)).join('\n');
		while (true) {
			const { result } = await this._dialogs.prompt<'undo' | 'keep' | 'choose' | 'review'>({
				type: 'question',
				message: localize('claudeRewindUndoQuestion', "Undo the changes made after this message?"),
				detail: localize('claudeRewindUndoDetail', "{0}\n\nKeep Files leaves them as they are, and Claude is told they changed.", listed) + claudeRewindCommitsNote(commits),
				buttons: [
					{ label: localize({ key: 'claudeRewindUndo', comment: ['&& denotes a mnemonic'] }, "&&Undo Changes"), run: () => 'undo' },
					{ label: localize({ key: 'claudeRewindKeep', comment: ['&& denotes a mnemonic'] }, "&&Keep Files"), run: () => 'keep' },
					{ label: localize({ key: 'claudeRewindReview', comment: ['&& denotes a mnemonic'] }, "&&Review First"), run: () => 'review' as const },
					...(files.length > 1 ? [{ label: localize({ key: 'claudeRewindChoose', comment: ['&& denotes a mnemonic'] }, "&&Choose Files to Undo..."), run: () => 'choose' as const }] : []),
				],
				cancelButton: true,
			});
			if (result === 'review') {
				// Issue 1054: the dialog is modal, so Review First leaves the rewind; the edit stays in the composer to send again.
				await this._commands.executeCommand(CLAUDE_OPEN_REVIEW_EDITOR_COMMAND_ID, sessionId);
				return undefined;
			}
			if (result === 'choose') {
				// Per-file choice (issue 818): the picked files go back, the rest stay and Claude is told.
				const picked = await this.pickRewindFiles(groups);
				if (!picked) {
					// Escape on the picker goes back to the dialog, not out of the rewind (issue 1060).
					continue;
				}
				const selection = claudeRewindSelection(groups, picked);
				if (selection.restore.length > 0 && !await restoreTurns(selection.restore)) {
					return undefined;
				}
				const kept = new Set(selection.keep);
				return files.filter(file => kept.has(file.uri.toString())).map(file => file.uri.fsPath);
			}
			if (result === 'undo') {
				return await restoreTurns() ? [] : undefined;
			}
			return result === 'keep' ? files.map(file => file.uri.fsPath) : undefined;
		}
	}

	/** The commits made since the turn began, newest first; none when git or the turn's HEAD is unknown (issue 1054). */
	private async commitsSinceTurn(sessionId: string, turnId: string): Promise<readonly ClaudeRewindCommit[]> {
		const root = this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri;
		const head = await this._checkpoints.readTurnGitHead(sessionId, turnId);
		if (!root || !head || !this._git.commitsSince) {
			return [];
		}
		try {
			return parseClaudeRewindCommits(await this._git.commitsSince(root.fsPath, head));
		} catch {
			return [];
		}
	}

	/**
	 * The "Files to Undo" picker (issue 1060): says what happens to unticked files and
	 * confirms with Undo Selected. Resolves to the picked checkpoint URIs, undefined on Escape.
	 */
	private async pickRewindFiles(groups: ClaudeRewindGroups): Promise<ReadonlySet<string> | undefined> {
		const disposables = new DisposableStore();
		try {
			const picker = disposables.add(this._quickInput.createQuickPick<IQuickPickItem & ClaudeRewindPickItem>());
			picker.canSelectMany = true;
			picker.title = localize('claudeRewindPickTitle', "Files to Undo");
			picker.placeholder = localize('claudeRewindPickPlaceholder', "Unticked files stay as they are; Claude is told they changed");
			picker.ok = true;
			picker.okLabel = localize('claudeRewindPickOk', "Undo Selected");
			picker.items = claudeRewindPickItems(groups);
			picker.selectedItems = picker.items.filter(item => item.picked);
			return await new Promise<ReadonlySet<string> | undefined>(resolve => {
				disposables.add(picker.onDidAccept(() => {
					resolve(new Set(picker.selectedItems.map(item => item.id)));
					picker.hide();
				}));
				disposables.add(picker.onDidHide(() => resolve(undefined)));
				picker.show();
			});
		} finally {
			disposables.dispose();
		}
	}

	private async submit(sessionId: string, text: string, attachments: readonly ContextAttachment[], cwd: string): Promise<void> {
		try {
			const session = this._agent.getCurrentSession();
			if (!session || session.id !== sessionId) {
				return;
			}
			const envelope = await this.screenSecrets(await this._context.resolve(text, session.mode, attachments, session.id));
			if (!envelope) {
				this.restoreCancelled(sessionId, text, attachments);
				return;
			}
			const compiled = compileSubmission(withClaudeDelegateTemplateSlash(withClaudeCanvas(withClaudeVisualize(envelope, session), session), session), pinnedCommandResolution(session.pinnedCommand, text));
			if (session.executionTarget?.kind === 'worktree') {
				// New Worktree in Run in: a background agent on its own branch (issue 425).
				await this._commands.executeCommand(CLAUDE_BACKGROUND_PROMPT_COMMAND_ID, compiled);
				return;
			}
			// The attachments travel with the turn so the message shows its images (issue 744).
			await this._agent.submit(session.id, text, cwd, { compiled, attachments });
		} catch (error) {
			const session = this._agent.getCurrentSession();
			if (!this.isRunning() && session?.id === sessionId && !this._input.value) {
				this._input.value = text;
				this._agent.setDraft(session.id, text);
				this.setAttachments(attachments);
			}
			this._host.report(error);
		} finally {
			this._submitting = false;
			const draft = this._agent.getCurrentSession()?.draft;
			if (draft !== undefined && !this._input.value) {
				this._input.value = draft;
			}
			this.fit();
			this.renderChips();
			this.updateSendButton();
		}
	}

	private paintMode(mode: AgentMode): void {
		const descriptor = describeMode(mode);
		clearNode(this._modeButton);
		this._modeButton.classList.toggle('is-ask', mode === 'ask');
		this._modeButton.classList.toggle('is-plan', mode === 'plan');
		this._modeButton.classList.toggle('is-agent', mode === 'agent');
		this._modeButton.classList.toggle('is-debug', mode === 'debug');
		// Issue 694: Agent at Allow Everything is Claude Code's bypass permissions mode; the pill says so in the error tone and an icon (DL-85).
		const session = this._agent.getCurrentSession();
		const bypass = !!session && claudeRunsUnasked(this._agent.getSessionPermissions(session.id), mode, true);
		this._modeButton.classList.toggle('is-bypass', bypass);
		this._modeButton.setAttribute('aria-label', bypass
			? localize('claudeModeLabelBypass', "Mode: {0}, bypass permissions: tools run without asking", descriptor.label)
			: localize('claudeModeLabel', "Mode: {0}", descriptor.label));
		append(this._modeButton, $(ThemeIcon.asCSSSelector(descriptor.icon)));
		append(this._modeButton, $('span.label')).textContent = descriptor.label;
		if (bypass) {
			append(this._modeButton, $(ThemeIcon.asCSSSelector(Codicon.unlock)));
		}
		append(this._modeButton, $(ThemeIcon.asCSSSelector(Codicon.chevronDown)));
		this.paintPlaceholder(mode);
	}

	private paintPinned(command: string | undefined): void {
		this._pinnedButton.hidden = !command;
		clearNode(this._pinnedButton);
		if (!command) {
			return;
		}
		this._pinnedButton.setAttribute('aria-label', localize('claudePinnedCommandLabel', "Every message runs /{0}. Remove", command));
		append(this._pinnedButton, $(ThemeIcon.asCSSSelector(Codicon.pin)));
		append(this._pinnedButton, $('span.label')).textContent = `/${command}`;
		append(this._pinnedButton, $(ThemeIcon.asCSSSelector(Codicon.close)));
	}

	/** The placeholder follows the state in both directions (audit 8): the question Claude waits on, steer or queue while a turn runs, then a follow-up once the session has a turn. */
	private paintPlaceholder(mode: AgentMode): void {
		const session = this._agent.getCurrentSession();
		this._input.placeholder = this.isRunning()
			? this.pendingQuestion()
				? localize('claudeQuestionPlaceholder', "Answer Claude's question above, or type a reply to send instead")
				: this.steersOnEnter()
					? localize('claudeSteerPlaceholder', "Add a message for the running turn")
					: localize('claudeQueuePlaceholder', "Add a follow-up — queued until the agent finishes")
			: composerPlaceholder(mode, !!session && this._agent.getViewState(session.id).turns.length > 0);
	}

	private showModeMenu(): void {
		// The pill toggles: a click while the menu is open closes it.
		if (this._modeMenu.isOpen) {
			this._modeMenu.close();
			return;
		}
		const session = this._agent.getCurrentSession();
		if (!session || this._modeButton.disabled) {
			return;
		}
		// Each mode with what it may do, then the session's Allow Everything switch (Phase 27).
		this._modeMenu.show(this._modeButton, this._switches.modeMenuModel(session.id, session.mode, mode => this.setMode(mode)));
	}

	private cycleMode(): void {
		const session = this._agent.getCurrentSession();
		if (session && !this.isRunning()) {
			this.setMode(nextMode(session.mode));
		}
	}

	private autoOn(): boolean {
		return this._configuration.getValue<boolean>(CLAUDE_AUTO_ENABLED_SETTING) === true;
	}

	/** Issue 1579: Auto is a model-picker entry. Picking it lets Claude choose the model each turn; the permission level stays as the user set it. */
	private async pickAuto(sessionId: string): Promise<void> {
		try {
			await setClaudeAutoEnabled(this._configuration, true);
			this._agent.setAutoModel(sessionId, true, true);
		} catch (error) {
			this._host.report(error);
		}
		this.paintModel();
	}

	private setMode(mode: AgentMode): void {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		try {
			this._agent.setMode(session.id, mode);
		} catch (error) {
			this._host.report(error);
		}
	}

	private discardStoppedEdit(): boolean {
		const session = this._agent.getCurrentSession();
		if (!session || !this._agent.pendingEditTurnId(session.id)) {
			return false;
		}
		this._agent.discardPendingEdit(session.id);
		return true;
	}

	private async stop(): Promise<void> {
		const session = this._agent.getCurrentSession();
		if (session) {
			await this._agent.stopAndTakeBack(session.id, turnId => askClaudeStoppedChanges(session.id, turnId, this._checkpoints, this._dialogs, this._storage));
		}
	}

	private syncPicker(): void {
		const cursor = this._input.selectionStart ?? this._input.value.length;
		const before = this._input.value.slice(0, cursor);
		const match = /(^|\s)([@/])([^\s@/]*)$/.exec(before);
		if (!match) {
			this._triggerStart = -1;
			this._picker.close();
			return;
		}
		this._triggerStart = cursor - match[3].length - 1;
		this._picker.show(this._input, match[2] === '@' ? 'at' : 'slash', match[3]);
	}

	/** Puts a picked `@` or `/` row into the composer: its text, its chip, or its IDE action. */
	/** Pins a command or skill to the chat and takes the typed `/query` out of the composer (issue 488). */
	private pinCommand(command: string): void {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		if (this._triggerStart >= 0) {
			const cursor = this._input.selectionStart ?? this._input.value.length;
			const spliced = spliceClaudeMention(this._input.value, this._triggerStart, cursor, '');
			this._input.value = spliced.value;
			this._input.selectionStart = spliced.cursor;
			this._input.selectionEnd = spliced.cursor;
			this._triggerStart = -1;
			this._agent.setDraft(session.id, this._input.value);
		}
		this._agent.setPinnedCommand(session.id, command);
		this.fit();
		this.updateSendButton();
		this._input.focus();
	}

	private applyPick(item: ContextPickerItem): void {
		if (this._triggerStart < 0) {
			return;
		}
		const cursor = this._input.selectionStart ?? this._input.value.length;
		const spliced = spliceClaudeMention(this._input.value, this._triggerStart, cursor, item.insert ?? '');
		this._input.value = spliced.value;
		this._input.selectionStart = spliced.cursor;
		this._input.selectionEnd = spliced.cursor;
		this._triggerStart = -1;
		const session = this._agent.getCurrentSession();
		if (session) {
			this._agent.setDraft(session.id, this._input.value);
		}
		if (item.attachment) {
			this.setAttachments(withChatAttachment(this.attachments(), item.attachment));
		}
		if (item.action === 'addSelection') {
			void this._commands.executeCommand(CLAUDE_ADD_SELECTION_COMMAND_ID);
		} else if (item.action === 'explainSelection') {
			void this._commands.executeCommand(CLAUDE_EXPLAIN_SELECTION_COMMAND_ID);
		} else if (item.command) {
			void this._commands.executeCommand(item.command);
		} else if (item.form) {
			void this._commands.executeCommand(CLAUDE_OPEN_SETTINGS_COMMAND_ID, { page: 'customize', form: item.form });
		} else if (item.action) {
			void this._actions.run({ id: item.action, source: 'menu', attachments: [] });
		}
		this.fit();
		this.updateSendButton();
		this._input.focus();
	}

	/** `restored`: Stop gave the message back, so the box shows the chat's draft again (issue 948). */
	private applySession(restored = false): void {
		const current = this._agent.getCurrentSession();
		const open = new Set(this._agent.getSessions().map(session => session.id));
		for (const id of [...this._modelBySession.keys()]) {
			if (!open.has(id)) {
				this._modelBySession.delete(id);
			}
		}
		this.paintMode(current?.mode ?? 'agent');
		this.paintPinned(current?.pinnedCommand);
		this._runIn.update(current);
		this.refreshMeta();
		if (current?.id !== this._boundSessionId) {
			if (this._editing) {
				// Another chat: the edit ends and the chat it was in gets its draft back.
				this.cancelEdit();
			}
			this._voice.abandon();
			this._boundSessionId = current?.id;
			this._todos.collapse();
			this._sideQuestion.close();
			this._input.value = current?.draft ?? '';
			this.fit();
		} else if (restored && current) {
			this._input.value = current.draft;
			this.fit();
			this.updateSendButton();
			this._input.focus();
			this._input.setSelectionRange(this._input.value.length, this._input.value.length);
		}
		this.renderChips();
		this.refreshSteer();
		this.paintPlanHint();
		this._switchNotice.update(current?.id);
	}

	private renderChips(): void {
		this._chipListeners.clear();
		clearNode(this._chips);
		const attachments = this.attachments();
		// No chip row until context is attached; @ in the toolbar adds it. Pasted-text pills sit in the text instead.
		this._chips.hidden = attachments.every(isClaudePastePill);
		this.paintPills();
		attachments.forEach((attachment, index) => {
			if (isClaudePastePill(attachment)) {
				return;
			}
			const chip = append(this._chips, $('.claude-chip'));
			chip.tabIndex = 0;
			if (attachment.kind === 'image') {
				chip.classList.add('is-image');
			}
			if (attachment.kind === 'selection' && this.isStale(attachment)) {
				chip.classList.add('is-stale');
				append(chip, $(ThemeIcon.asCSSSelector(Codicon.warning)));
			} else if (attachment.kind === 'chat' && !this._agent.getHistory().some(session => session.id === attachment.sessionId)) {
				chip.classList.add('is-error');
				append(chip, $(ThemeIcon.asCSSSelector(Codicon.error)));
			} else if (attachment.kind === 'image') {
				// An image chip shows the image itself, not a generic icon (issue 743, DL-74).
				appendClaudeImageThumb(chip, this._thumbnails, attachment.localUri);
			} else {
				append(chip, $(ThemeIcon.asCSSSelector(chipIcon(attachment))));
			}
			if (attachment.kind === 'chat' && attachment.scope === 'full') {
				chip.classList.add('is-large');
				chip.title = localize('claudeChatFullWarn', "Full transcript is large. Summary is the default.");
			}
			append(chip, $('span.label')).textContent = chipLabel(attachment);
			const detail = chipDetail(attachment);
			if (detail) {
				append(chip, $('span.detail')).textContent = detail;
			}
			const remove = append(chip, $<HTMLButtonElement>('button.remove'));
			remove.type = 'button';
			remove.setAttribute('aria-label', localize('claudeRemoveChip', "Remove {0}", chipLabel(attachment)));
			append(remove, $(ThemeIcon.asCSSSelector(Codicon.close)));
			// The source and range show in a hover above the chip; the composer never grows (audit 19).
			const hoverOptions = () => ({ content: this.chipHover(chip, attachment), additionalClasses: ['claude-root'] });
			this._chipListeners.add(this._hovers.setupDelayedHover(chip, hoverOptions, { groupId: 'claude-chips' }));
			// A hover opened by keyboard focus closes again when focus leaves the chip.
			const focusHover = this._chipListeners.add(new MutableDisposable());
			this._chipListeners.add(addDisposableListener(chip, EventType.FOCUS, () => {
				focusHover.value = this._hovers.showDelayedHover({ ...hoverOptions(), target: chip }, { groupId: 'claude-chips' });
			}));
			this._chipListeners.add(addDisposableListener(chip, EventType.BLUR, () => focusHover.clear()));
			this._chipListeners.add(addDisposableListener(remove, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				const next = this.attachments().slice();
				next.splice(index, 1);
				this.setAttachments(next);
			}));
			if (attachment.kind === 'chat') {
				this._chipListeners.add(addDisposableListener(chip, EventType.CONTEXT_MENU, event => {
					event.preventDefault();
					const current = attachment;
					this._contextMenus.showContextMenu({
						getAnchor: () => chip,
						getActions: () => {
							this._chipActions.clear();
							return [
								this._chipActions.add(new Action('claude.chat.summary', localize('claudeChatSummary', "Summary"), undefined, current.scope !== 'summary', () => this.setChatScope(current, 'summary'))),
								this._chipActions.add(new Action('claude.chat.full', localize('claudeChatFull', "Full transcript"), undefined, current.scope !== 'full', () => this.setChatScope(current, 'full'))),
							];
						},
					});
				}));
			}
			this._chipListeners.add(addDisposableListener(chip, EventType.KEY_DOWN, event => {
				if (event.key === 'Backspace' || event.key === 'Delete') {
					event.preventDefault();
					const next = this.attachments().slice();
					next.splice(index, 1);
					this.setAttachments(next);
					this._input.focus();
				}
			}));
		});
	}

	/** Puts `@` at the cursor so the context picker opens (the Add context button). */
	private startMention(): void {
		this._input.focus();
		const start = this._input.selectionStart ?? this._input.value.length;
		const before = this._input.value.slice(0, start);
		this.insertText(before.length > 0 && !/\s$/.test(before) ? ' @' : '@');
	}

	/**
	 * The chip's hover: its label at once, then the exact source and range
	 * once the context service resolves them.
	 */
	private chipHover(chip: HTMLElement, attachment: ContextAttachment): HTMLElement {
		const content = $('.claude-hover-content');
		if (attachment.kind === 'image') {
			// The hover is where the image is big enough to check before sending (issue 743).
			appendClaudeImageThumb(content, this._thumbnails, attachment.localUri).classList.add('is-preview');
		}
		append(content, $('span.claude-hover-title')).textContent = chipLabel(attachment);
		const detail = append(content, $('span.claude-hover-detail'));
		const known = chip.getAttribute('data-claude-source');
		if (known) {
			detail.textContent = known;
		}
		const session = this._agent.getCurrentSession();
		if (session) {
			void this._context.resolve('', session.mode, [attachment], session.id).then(envelope => {
				const resolved = envelope.attachments[0];
				if (resolved) {
					detail.textContent = describeResolved(resolved);
					chip.setAttribute('data-claude-source', detail.textContent);
				}
			}, () => undefined);
		}
		return content;
	}

	private isStale(attachment: { uri: string; versionId: number }): boolean {
		const model = this._models.getModel(URI.parse(attachment.uri));
		return selectionIsStale(attachment.versionId, model?.getVersionId());
	}

	private setAttachments(attachments: readonly ContextAttachment[]): void {
		const session = this._agent.getCurrentSession();
		if (session) {
			this._agent.setAttachments(session.id, attachments);
		}
	}

	private attachments(): readonly ContextAttachment[] {
		return this._agent.getCurrentSession()?.attachments ?? [];
	}

	private insertText(text: string): void {
		const start = this._input.selectionStart ?? this._input.value.length;
		const end = this._input.selectionEnd ?? start;
		this._input.value = this._input.value.slice(0, start) + text + this._input.value.slice(end);
		const cursor = start + text.length;
		this._input.selectionStart = cursor;
		this._input.selectionEnd = cursor;
		this.onInput();
	}

	private longPasteLimit(): number {
		// The registered default must not hide a value still stored under the old name.
		const inspected = this._configuration.inspect<number>(CLAUDE_LONG_PASTE_SETTING);
		const explicit = inspected.policyValue ?? inspected.applicationValue ?? inspected.userValue;
		return readClaudeLongPasteChars(explicit, this._configuration.getValue(CLAUDE_LEGACY_LONG_PASTE_SETTING));
	}

	private canSend(): boolean {
		return !this._submitting && (this._input.value.trim().length > 0 || this.attachments().length > 0);
	}

	private _wasRunning = false;

	/** The Stop square shows while background work runs under a finished turn too (issue 1617). */
	private isWorking(): boolean {
		const session = this._agent.getCurrentSession();
		return !!session && this._agent.isWorking(session.id);
	}

	private isRunning(): boolean {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return false;
		}
		const turns = this._agent.getViewState(session.id).turns;
		return turns.length > 0 && turns[turns.length - 1].status === 'running';
	}

	/** True when Enter steers the running turn: the setting asks for it and the runtime can steer. */
	private steersOnEnter(): boolean {
		return this._canSteer && readClaudeWhileWorking(this._configuration.getValue(CLAUDE_COMPOSER_WHILE_WORKING_SETTING)) === 'steer';
	}

	/** Puts Enter on the button it runs and the other key on the other; the Enter one is the solid button. */
	private paintSendKeys(): void {
		const steer = this.steersOnEnter();
		if (steer === this._keysSteer) {
			return;
		}
		this._keysSteer = steer;
		this._queueKey.remove();
		this._steerKey.remove();
		this._queueKey = appendClaudeKbd(this._queueButton, steer ? claudeSteerKeyLabel() : claudeEnterKeyLabel());
		this._steerKey = appendClaudeKbd(this._steerButton, steer ? claudeEnterKeyLabel() : claudeSteerKeyLabel());
		this._queueButton.classList.toggle('is-ghost', steer);
		this._steerButton.classList.toggle('is-ghost', !steer);
	}

	private refreshSteer(): void {
		const generation = ++this._steerGeneration;
		const session = this._agent.getCurrentSession();
		if (!session || !this.isRunning()) {
			this._canSteer = false;
			this.updateSendButton();
			this.renderQueue();
			return;
		}
		void this._agent.supportsSteer(session.id).then(value => {
			if (generation !== this._steerGeneration || this._store.isDisposed) {
				return;
			}
			this._canSteer = value;
			this.updateSendButton();
		});
		this.updateSendButton();
		this.renderQueue();
	}

	private renderQueue(): void {
		if (this._editingQueue) {
			return;
		}
		const session = this._agent.getCurrentSession();
		const items = session ? this._agent.getPending(session.id) : [];
		const signature = JSON.stringify([session?.id, items.map(item => [item.id, item.text, item.attachments.length])]);
		if (signature === this._queueSignature) {
			return;
		}
		this._queueSignature = signature;
		this._queueListeners.clear();
		clearNode(this._queue);
		this._queue.hidden = items.length === 0;
		for (const item of items) {
			const row = append(this._queue, $('.claude-queue-item'));
			append(row, $(ThemeIcon.asCSSSelector(Codicon.clock)));
			// A queued image shows as itself, and names the message when it has no text (DL-74, issue 791).
			const images = item.attachments.flatMap(attachment => attachment.kind === 'image' ? [{ uri: attachment.localUri, name: claudeImageLabel(attachment.localUri, attachment.name) }] : []);
			for (const image of images) {
				const thumb = appendClaudeImageThumb(row, this._thumbnails, image.uri);
				thumb.setAttribute('role', 'img');
				thumb.setAttribute('aria-label', image.name);
			}
			const label = append(row, $('span.text'));
			label.textContent = item.text || images.map(image => image.name).join(', ');
			if (item === items[0]) {
				// Enter again sends the first queued message now (DL-111, issue 1242).
				append(row, $('span.claude-queue-hint')).textContent = localize('claudeQueueSendNowHint', "Press Enter Again to Send Now");
			}
			const edit = append(row, $<HTMLButtonElement>('button.claude-icon-btn'));
			edit.type = 'button';
			edit.setAttribute('aria-label', localize('claudeEditQueued', "Edit"));
			append(edit, $(ThemeIcon.asCSSSelector(Codicon.edit)));
			this._queueListeners.add(this._hovers.setupDelayedHover(edit, { content: localize('claudeEditQueuedHover', "Edit queued message"), additionalClasses: ['claude-root'] }));
			const remove = append(row, $<HTMLButtonElement>('button.claude-icon-btn'));
			remove.type = 'button';
			remove.setAttribute('aria-label', localize('claudeDeleteQueued', "Delete"));
			append(remove, $(ThemeIcon.asCSSSelector(Codicon.close)));
			this._queueListeners.add(this._hovers.setupDelayedHover(remove, { content: localize('claudeDeleteQueuedHover', "Remove from the queue"), additionalClasses: ['claude-root'] }));
			this._queueListeners.add(addDisposableListener(edit, EventType.CLICK, event => {
				event.preventDefault();
				this.editQueued(row, label, item.id, item.text, item.attachments);
			}));
			this._queueListeners.add(addDisposableListener(remove, EventType.CLICK, event => {
				event.preventDefault();
				if (session) {
					this._agent.removePending(session.id, item.id);
				}
			}));
		}
		if (items.length >= 2) {
			// Run Queued in Parallel (issue 487): the queued messages become one multitask.
			const parallel = append(this._queue, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost.claude-queue-parallel'));
			parallel.type = 'button';
			append(parallel, $(ThemeIcon.asCSSSelector(Codicon.layers)));
			append(parallel, $('span')).textContent = localize('claudeQueueParallel', "Run Queued in Parallel");
			this._queueListeners.add(this._hovers.setupDelayedHover(parallel, { content: localize('claudeQueueParallelHover', "Run each queued message now as its own background agent, then combine the results in this chat"), additionalClasses: ['claude-root'] }));
			this._queueListeners.add(addDisposableListener(parallel, EventType.CLICK, event => {
				event.preventDefault();
				void this._commands.executeCommand(CLAUDE_MULTITASK_RUN_QUEUED_COMMAND_ID);
			}));
		}
		this._host.requestLayout();
	}

	private editQueued(row: HTMLElement, label: HTMLElement, id: string, text: string, attachments: readonly ContextAttachment[]): void {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		this._editingQueue = true;
		const input = append(row, $<HTMLInputElement>('input.claude-queue-edit'));
		input.type = 'text';
		input.value = text;
		input.setAttribute('aria-label', localize('claudeEditQueued', "Edit"));
		label.hidden = true;
		const finish = (commit: boolean) => {
			if (!this._editingQueue) {
				return;
			}
			this._editingQueue = false;
			const next = input.value;
			input.remove();
			label.hidden = false;
			if (commit && next.trim()) {
				void this.commitQueuedEdit(session.id, id, next, attachments);
				return;
			}
			this.renderQueue();
		};
		this._queueListeners.add(addDisposableListener(input, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter') {
				event.preventDefault();
				finish(true);
			} else if (event.key === 'Escape') {
				event.preventDefault();
				finish(false);
			}
		}));
		this._queueListeners.add(addDisposableListener(input, EventType.BLUR, () => finish(true)));
		input.focus();
	}

	private async commitQueuedEdit(sessionId: string, id: string, text: string, attachments: readonly ContextAttachment[]): Promise<void> {
		const session = this._agent.getSessions().find(candidate => candidate.id === sessionId);
		if (!session) {
			this._host.report(new Error(localize('claudeQueueGone', "That queued message was already sent or removed.")));
			this.renderQueue();
			return;
		}
		let compiled: string | undefined;
		try {
			const envelope = await this.screenSecrets(await this._context.resolve(text, session.mode, attachments, session.id));
			if (!envelope) {
				// Cancel keeps the queued message as it was.
				this.renderQueue();
				return;
			}
			compiled = compileSubmission(withClaudeDelegateTemplateSlash(withClaudeCanvas(withClaudeVisualize(envelope, session), session), session), pinnedCommandResolution(session.pinnedCommand, text));
		} catch (error) {
			this._host.report(error);
		}
		if (!this._agent.updatePending(sessionId, id, text, compiled)) {
			this._host.report(new Error(localize('claudeQueueGone', "That queued message was already sent or removed.")));
		}
		this.renderQueue();
	}

	private updateSendButton(): void {
		// While an earlier message is edited, Send sends it, stopping the running turn first.
		const running = this.isRunning() && !this._editing;
		const stoppable = this.isWorking() && !this._editing;
		const wasStoppable = this._send.classList.contains('is-stop');
		const wasRunning = this._wasRunning;
		this._wasRunning = running;
		this._send.classList.toggle('is-stop', stoppable);
		// Enter already queues, so the group shows only when Steer offers a second choice (#136).
		this._sendGroup.hidden = !running || !this._canSteer;
		this._steerButton.hidden = !this._canSteer;
		this._steerButton.disabled = !this.canSend();
		this._queueButton.disabled = !this.canSend();
		this.paintSendKeys();
		this._modeButton.disabled = running;
		this._mention.hidden = running;
		this._attach.hidden = running;
		this._overflow.hidden = !running;
		this._send.disabled = stoppable ? false : !this.canSend();
		this._send.setAttribute('aria-label', stoppable ? localize('claudeStop', "Stop") : localize('claudeSend', "Send"));
		if (stoppable !== wasStoppable || !this._send.firstChild) {
			clearNode(this._send);
			append(this._send, $(ThemeIcon.asCSSSelector(stoppable ? Codicon.primitiveSquare : Codicon.arrowUp)));
		}
		this._noFolder.paint(!!this._host.localFolder());
		this.paintPlaceholder(this._agent.getCurrentSession()?.mode ?? 'agent');
		if (running !== wasRunning) {
			this.paintTodos();
		}
	}

	private setChatScope(attachment: Extract<ContextAttachment, { kind: 'chat' }>, scope: 'summary' | 'full'): void {
		const session = this._agent.getCurrentSession();
		if (!session) {
			return;
		}
		this.setAttachments(session.attachments.map(item => item.kind === 'chat' && item.sessionId === attachment.sessionId && item.asOfTurn === attachment.asOfTurn ? { ...item, scope } : item));
	}

	/** Measures the input again after its width or its minimum height (new chat or follow-up) changed. */
	refit(): void {
		this.fit();
	}

	private fit(): void {
		if (this._input.clientWidth === 0) {
			// Hidden or not laid out yet: every word would wrap and clamp the box at its maximum. The resize observer measures it once it has a width.
			this.paintPills();
			return;
		}
		this._input.style.height = 'auto';
		this._input.style.height = `${this._input.scrollHeight}px`;
		this.paintPills();
		this._host.requestLayout();
	}

	/**
	 * Copies the input's text behind it with every pill marked (DL-77). The copy's text is
	 * transparent, so the input's own text shows on top and the mark only lends its fill.
	 */
	private paintPills(): void {
		const runs = claudePastePillRuns(this._input.value, this.attachments());
		clearNode(this._pills);
		if (!runs.some(run => run.pill)) {
			return;
		}
		for (const run of runs) {
			append(this._pills, run.pill ? $('mark') : $('span')).textContent = run.text;
		}
		// The input's width without its scrollbar, so both wrap the same.
		this._pills.style.width = `${this._input.clientWidth}px`;
		this._pills.style.transform = `translateY(${-this._input.scrollTop}px)`;
	}
}

function chipIcon(attachment: ContextAttachment): ThemeIcon {
	switch (attachment.kind) {
		case 'file': return Codicon.file;
		case 'folder': return Codicon.folder;
		case 'symbol': return Codicon.symbolMethod;
		case 'selection': return Codicon.listSelection;
		case 'diagnostics': return Codicon.warning;
		case 'git-diff': return attachment.scope === 'commit' ? Codicon.gitCommit : attachment.scope === 'branch' ? Codicon.gitBranch : Codicon.gitCompare;
		case 'terminal': return Codicon.terminal;
		case 'image': return Codicon.fileMedia;
		case 'pasted-text': return Codicon.note;
		case 'chat': return Codicon.commentDiscussion;
	}
}

function chipLabel(attachment: ContextAttachment): string {
	switch (attachment.kind) {
		case 'file':
		case 'folder':
		case 'symbol':
		case 'selection':
			return basename(URI.parse(attachment.uri));
		case 'diagnostics':
			return localize('claudeProblems', "Problems");
		case 'git-diff':
			if (attachment.path) {
				return attachment.path.split(/[/\\]/).pop() || attachment.path;
			}
			if (attachment.title) {
				return attachment.title;
			}
			if (attachment.scope === 'branch') {
				return localize('claudeBranchChanges', "Branch changes");
			}
			if (attachment.scope === 'commit') {
				return attachment.ref?.slice(0, 7) || localize('claudeCommitChip', "Commit");
			}
			if (attachment.scope === 'staged') {
				return localize('claudeStaged', "Staged");
			}
			if (attachment.scope === 'all') {
				return localize('claudeGitChanges', "Git changes");
			}
			return localize('claudeWorkingTreeLabel', "Working tree");
		case 'terminal':
			// The terminal's name, or the command it carries (issue 734).
			return attachment.title || localize('claudeTerminal', "Terminal");
		case 'image':
			return claudeImageLabel(attachment.localUri, attachment.name);
		case 'pasted-text':
			return attachment.label || localize('claudePastedText', "Pasted text");
		case 'chat':
			return attachment.title || localize('claudeChatChip', "Chat");
	}
}

function chipDetail(attachment: ContextAttachment): string | undefined {
	switch (attachment.kind) {
		case 'selection':
		case 'symbol':
			// allow-any-unicode-next-line
			return `${attachment.range.startLine}–${attachment.range.endLine}`;
		case 'pasted-text':
			return String(attachment.lineCount);
		case 'terminal':
			return String(typeof attachment.text === 'string' ? attachment.text.split('\n').length : attachment.lines);
		case 'chat': {
			const range = attachment.turnRange ? `${attachment.turnRange[0]}-${attachment.turnRange[1]}` : '';
			const where = attachment.workspaceName ? ` · ${attachment.workspaceName}` : '';
			return localize('claudeChatAsOf', "turns {0} · as of turn {1}{2}", range, attachment.asOfTurn, where);
		}
		default:
			return undefined;
	}
}

function imageFile(data: DataTransfer): File | undefined {
	for (const item of data.items) {
		if (item.kind === 'file' && item.type.startsWith('image/')) {
			const file = item.getAsFile();
			if (file) {
				return file;
			}
		}
	}
	for (const file of data.files) {
		if (file.type.startsWith('image/')) {
			return file;
		}
	}
	return undefined;
}

function dirnameFs(uri: URI): string {
	const parts = uri.fsPath.split(/[/\\]/);
	parts.pop();
	return parts.join(uri.fsPath.includes('\\') ? '\\' : '/') || uri.fsPath;
}
