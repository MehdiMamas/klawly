/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, Dimension, EventType, getTotalHeight } from '../../../../../base/browser/dom.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, IObservable, observableValue } from '../../../../../base/common/observable.js';
import { Schemas } from '../../../../../base/common/network.js';
import { isAbsolute } from '../../../../../base/common/path.js';
import { isEqual, joinPath, relativePath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IDiffEditor } from '../../../../../editor/common/editorCommon.js';
import { DiffEditorViewMode, IDiffEditorOptions } from '../../../../../editor/common/config/editorOptions.js';
import { MultiDiffEditorWidget } from '../../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.js';
import { MultiDiffEditorViewModel } from '../../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorViewModel.js';
import { IMultiDiffEditorViewState } from '../../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidgetImpl.js';
import { IResourceLabel, IWorkbenchUIElementFactory, MultiDiffEditorItemLabelKind } from '../../../../../editor/browser/widget/multiDiffEditor/workbenchUIElementFactory.js';
import { ITextResourceConfigurationService } from '../../../../../editor/common/services/textResourceConfiguration.js';
import { localize } from '../../../../../nls.js';
import { AgentActionId, IClaudeActionService } from '../../../../../platform/claude/common/claudeActions.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { CLAUDE_ACTIONS_PREFER_COMMANDS_SETTING, CLAUDE_COMPOSER_WHILE_WORKING_SETTING, readClaudeWhileWorking } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { CLAUDE_REVIEW_USE_TICKETS_SETTING, ClaudeReviewTicketRequest, claudeReviewTicketSources, claudeReviewTicketTools, extractClaudeTicketIds } from '../../../../../platform/claude/common/claudeReviewTickets.js';
import { claudeBranchContext } from '../claudeGitHistory.js';
import { ISCMService } from '../../../scm/common/scm.js';
import { CLAUDE_REVIEW_SHOW_READINESS_SETTING, ClaudeReviewSummary, ClaudeReviewSummaryMode, formatClaudeReviewSummary, claudeFindingFeedback, claudeHasOwnReviewCommand, claudeLineReference, ClaudeReviewFeedback, ClaudeReviewFilter, ClaudeReviewFinding, filterClaudeReviewFindings, formatClaudeReviewFeedback, formatClaudeReviewMarkdown, formatClaudeReviewSarif, normalizeClaudeFindingPath, readClaudeReviewFindingsFromText, readClaudeReviewSettings } from '../../../../../platform/claude/common/claudeReviewLoop.js';
import { claudeReviewDepthMessage, planClaudeReviewRun } from '../../../../../platform/claude/common/claudeReviewDepth.js';
import { formatClaudeGitHubReview } from '../../../../../platform/claude/common/claudeReviewBot.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { removeClaudeSecrets } from '../../../../../platform/claude/common/claudeSecretScan.js';
import { ITextEditorOptions, TextEditorSelectionRevealType } from '../../../../../platform/editor/common/editor.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ResourceLabel } from '../../../../browser/labels.js';
import { AbstractEditorWithViewState } from '../../../../browser/parts/editor/editorWithViewState.js';
import { EditorInputCapabilities, IEditorOpenContext, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { CLAUDE_NOTEBOOK_SNAPSHOT_SCHEME, CLAUDE_SNAPSHOT_SCHEME, formatTurnDiff, IClaudeReviewService, isNotebookReviewFile, ReviewConflictError, ReviewScope } from '../../../../services/claude/common/claudeReview.js';
import { MultiDiffEditorInput } from '../../../multiDiffEditor/browser/multiDiffEditorInput.js';
import { CLAUDE_AGENT_VIEW_ID, CLAUDE_COMMIT_ACCEPTED_COMMAND_ID, CLAUDE_OPEN_SETTINGS_COMMAND_ID, CLAUDE_SPLIT_PULL_REQUESTS_COMMAND_ID } from '../../common/claudeViews.js';
import Severity from '../../../../../base/common/severity.js';
import { CLAUDE_REVIEW_CONFIG_FILE_SETTING, addClaudeReviewRule, readClaudeReviewConfigFile } from '../../../../../platform/claude/common/claudeReviewConfig.js';
import { CLAUDE_REVIEW_LEARN_AFTER_SETTING, ClaudeDismissReason, ClaudeReviewSignalCounter, claudeLearnedRuleOffer, learnedClaudeReviewRule, readClaudeLearnAfter } from '../../../../../platform/claude/common/claudeReviewLearning.js';
import { ClaudePopoverEntry, ClaudePopoverMenu } from '../widgets/claudePopoverMenu.js';
import { ClaudeFindingConversations, ClaudeFindingConversationView } from '../../common/claudeFindingConversations.js';
import { CLAUDE_REVIEW_STATS_STORAGE_KEY, ClaudeReviewStatEventKind, recordClaudeReviewStats } from '../../../../../platform/claude/common/claudeReviewStats.js';
import { deserializeFindingThreads, deserializeReviewSignals, deserializeReviewStats, serializeFindingThreads, serializeReviewSignals, serializeReviewStats } from '../../../../services/claude/common/claudeReviewPersist.js';
import { claudeScopeActionLabel } from '../../common/claudeKeepAll.js';
import { appendDiffStat } from './claudeChangesCard.js';
import { ClaudeReviewReadiness, ClaudeReviewReadinessBand, claudeReviewReadinessBand, formatClaudeReviewReadiness } from '../../../../../platform/claude/common/claudeReviewReadiness.js';
import { lastClaudeReflogCommit } from '../../../../../platform/claude/common/claudeCommitReview.js';
import { claudeUndoAllPending } from './claudeKeepAll.js';
import { ClaudeDiagramBlocks } from '../chat/claudeDiagramBlocks.js';
import { buildClaudeReproduceTestPrompt, buildClaudeWriteTestPrompt, ClaudeReviewTestState, parseClaudeReviewTestResult } from '../../../../../platform/claude/common/claudeReviewTests.js';
import { ClaudeReviewDiagramKind } from '../../../../../platform/claude/common/claudeReviewDiagram.js';
import { IClaudeVerifyEvidenceService } from '../../../../services/claude/common/claudeVerifyEvidenceService.js';
import { ClaudeReviewDescriptionState, ClaudeReviewSummaryCard, submitClaudeReviewDescription } from './claudeReviewSummary.js';
import { ClaudeReviewFeedbackTray } from './claudeReviewFeedback.js';
import { ClaudeReviewEvidenceCard } from './claudeReviewEvidence.js';
import { ClaudeReviewFindingsBar, ClaudeReviewFindingsHost, ClaudeReviewFindingZones, ClaudeShownFinding, renderClaudeLearnedOffer } from './claudeReviewFindings.js';
import { IClaudeReviewBotService } from './claudeReviewBotService.js';
import { CLAUDE_REVIEW_EDITOR, claudeReviewEntries, ClaudeReviewEntry, claudeReviewIgnoredUris, claudeReviewSourceUri, ClaudeReviewTarget, claudeSessionReviews, KLAWLY_REVIEW_SCHEME } from './claudeReviewSource.js';

/** What the review editor shows: the turn it was opened for, or every turn of the chat. */
export type ClaudeReviewScope = 'turn' | 'all';

const HEADER_HEIGHT = 36;
/** Where the dismissal counters of learned rules are kept per workspace (issue 1068). */
const SIGNALS_STORAGE_KEY = 'klawly.review.signals';
const TICKETS_CONSENT_STORAGE_KEY = 'klawly.review.ticketsConsent';
const BOTTOM_PADDING = 24;

/** A line comment waiting in the tray, with the diff it was left on so the tray can show it again. */
interface ClaudeReviewDraft {
	readonly item: ClaudeReviewFeedback;
	readonly original: URI | undefined;
	readonly modified: URI;
}

/**
 * Folding is off so the hidden-lines bars are the one way to see more context.
 * The minimap is off too: each file's card scrolls with the review, so a minimap
 * only adds a wide slider beside the change marks (#963).
 */
export const REVIEW_DIFF_OPTIONS: IDiffEditorOptions = {
	folding: false,
	minimap: { enabled: false },
	lineNumbersMinChars: 3,
};

/**
 * The review editor of one chat. Its resource is `klawly-review:/<sessionId>`,
 * so a chat has one review tab; opening it for another turn switches the tab
 * to that turn.
 */
export class ClaudeReviewInput extends EditorInput {

	static readonly ID = 'workbench.input.klawlyReview';

	private readonly _inner = this._register(new MutableDisposable<MultiDiffEditorInput>());
	private _turnId: string | undefined;
	private _scope: ClaudeReviewScope;

	constructor(
		readonly sessionId: string,
		turnId: string | undefined,
		@IInstantiationService private readonly _instantiation: IInstantiationService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
	) {
		super();
		this._turnId = turnId;
		this._scope = turnId ? 'turn' : 'all';
		this._register(this._agent.onDidChangeSession(() => this._onDidChangeLabel.fire()));
	}

	override get typeId(): string {
		return ClaudeReviewInput.ID;
	}

	override get editorId(): string | undefined {
		return ClaudeReviewEditor.ID;
	}

	override get resource(): URI {
		return URI.from({ scheme: KLAWLY_REVIEW_SCHEME, path: `/${this.sessionId}` });
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	/** The turn the editor was opened for, if any. */
	get turnId(): string | undefined {
		return this._turnId;
	}

	get scope(): ClaudeReviewScope {
		return this._scope;
	}

	get target(): ClaudeReviewTarget {
		return this._scope === 'turn' && this._turnId ? { sessionId: this.sessionId, turnId: this._turnId } : { sessionId: this.sessionId };
	}

	/** Shows `turnId` (or every turn). Returns whether the shown files change. */
	show(turnId: string | undefined, scope: ClaudeReviewScope = turnId ? 'turn' : 'all'): boolean {
		const before = claudeReviewSourceUri(this.target).toString();
		this._turnId = turnId ?? this._turnId;
		this._scope = scope === 'turn' && this._turnId ? 'turn' : 'all';
		if (claudeReviewSourceUri(this.target).toString() === before) {
			return false;
		}
		this._inner.clear();
		return true;
	}

	/** The tab reads "Review"; the chat's title goes in the description and tooltip. */
	override getName(): string {
		return localize('claudeReviewEditorName', "Review");
	}

	override getDescription(): string | undefined {
		return this._sessionTitle();
	}

	override getTitle(): string {
		const title = this._sessionTitle();
		return title ? localize('claudeReviewEditorTitle', "Review: {0}", title) : this.getName();
	}

	private _sessionTitle(): string | undefined {
		return this._agent.getSessions().find(session => session.id === this.sessionId)?.title || undefined;
	}

	override getIcon(): ThemeIcon {
		return Codicon.diffMultiple;
	}

	async getViewModel(): Promise<MultiDiffEditorViewModel> {
		if (!this._inner.value) {
			this._inner.value = MultiDiffEditorInput.fromResourceMultiDiffEditorInput({
				multiDiffSource: claudeReviewSourceUri(this.target),
				label: this.getTitle(),
			}, this._instantiation);
		}
		return this._inner.value.getViewModel();
	}

	/** Drops the resolved diffs. The next {@link getViewModel} resolves them again. */
	clear(): void {
		this._inner.clear();
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof ClaudeReviewInput && other.sessionId === this.sessionId;
	}
}

/** Shows the file name, its folder and `+a -b` in each file header. */
class ClaudeReviewElementFactory implements IWorkbenchUIElementFactory {

	constructor(
		private readonly _entries: IObservable<readonly ClaudeReviewEntry[]>,
		@IInstantiationService private readonly _instantiation: IInstantiationService,
		@IEditorService private readonly _editors: IEditorService,
	) { }

	createResourceLabel(element: HTMLElement, kind: MultiDiffEditorItemLabelKind, accessory: HTMLElement): IResourceLabel {
		const label = this._instantiation.createInstance(ResourceLabel, element, {});
		return new ClaudeReviewResourceLabel(label, kind === MultiDiffEditorItemLabelKind.Primary ? accessory : undefined, this._entries);
	}

	openDiffEditor(original: URI, modified: URI): void {
		// A notebook opens in the notebook diff editor, which reads the snapshot as a file (issue 526).
		const left = original.scheme === CLAUDE_SNAPSHOT_SCHEME && isNotebookReviewFile(modified) ? original.with({ scheme: CLAUDE_NOTEBOOK_SNAPSHOT_SCHEME, fragment: '' }) : original;
		void this._editors.openEditor({ original: { resource: left }, modified: { resource: modified }, options: { pinned: true } });
	}
}

class ClaudeReviewResourceLabel extends Disposable implements IResourceLabel {

	private readonly _uri = observableValue<URI | undefined>(this, undefined);

	constructor(
		private readonly _label: ResourceLabel,
		accessory: HTMLElement | undefined,
		entries: IObservable<readonly ClaudeReviewEntry[]>,
	) {
		super();
		this._register(_label);
		if (!accessory) {
			return;
		}
		accessory.classList.add('claude-review-file-stat');
		this._register(autorun(reader => {
			const uri = this._uri.read(reader);
			const entry = uri && entries.read(reader).find(candidate => isEqual(candidate.uri, uri));
			clearNode(accessory);
			if (!entry) {
				accessory.removeAttribute('aria-label');
				return;
			}
			appendDiffStat(accessory, entry.added, entry.removed);
			accessory.setAttribute('aria-label', localize('claudeReviewFileStat', "{0} lines added, {1} lines removed", entry.added, entry.removed));
		}));
	}

	setUri(uri: URI | undefined, options: { strikethrough?: boolean } = {}): void {
		if (uri) {
			this._label.element.setFile(uri, { strikethrough: options.strikethrough });
		} else {
			this._label.element.clear();
		}
		this._uri.set(uri, undefined);
	}
}

/**
 * The review editor: every file a turn (or the whole chat) changed, as one
 * scrolling list of diffs. The header switches between This Turn and All
 * Changes, asks Claude to review or security-review the changes, and commits
 * what was kept. Each file header has Keep and Undo.
 */
export class ClaudeReviewEditor extends AbstractEditorWithViewState<IMultiDiffEditorViewState> {

	static readonly ID = 'workbench.editor.klawlyReview';

	private _widget: MultiDiffEditorWidget | undefined;
	private _viewModel: MultiDiffEditorViewModel | undefined;
	private _header!: HTMLElement;
	private _scopeButtons!: { readonly turn: HTMLButtonElement; readonly all: HTMLButtonElement };
	private _summary!: HTMLElement;
	private _reviewMain!: HTMLButtonElement;
	private _commit!: HTMLButtonElement;
	private _keep!: { readonly split: HTMLElement; readonly main: HTMLButtonElement; readonly label: HTMLElement; readonly more: HTMLButtonElement };
	/** What the Keep button covers; undefined follows the shown changes (issue 706). */
	private _keepScope: ReviewScope['kind'] | undefined;
	private _more!: HTMLButtonElement;
	private _reviewMore!: HTMLButtonElement;
	private _menu!: ClaudePopoverMenu;
	private _viewMode: DiffEditorViewMode = 'sideBySide';
	private _busy = false;
	private readonly _entries = observableValue<readonly ClaudeReviewEntry[]>(this, []);
	/** The changed files .claude/review.json ignores (issue 1038): out of the list, named in a collapsed note. */
	private _ignored: readonly ClaudeReviewEntry[] = [];
	private readonly _inputListener = this._register(new MutableDisposable());
	private _tray: ClaudeReviewFeedbackTray | undefined;
	/** Line comments per chat, kept while the editor lives so switching chats does not lose them (issue 431). */
	private readonly _drafts = new Map<string, ClaudeReviewDraft[]>();
	private _sendingFeedback = false;
	private _dimension: Dimension | undefined;
	/** Which findings the chips hide (issue 921); seeded from the settings, kept for the editor's life. */
	private _filter: ClaudeReviewFilter = readClaudeReviewSettings(key => this._configuration.getValue(key));
	private _findingsBar: ClaudeReviewFindingsBar | undefined;
	private _summaryCard: ClaudeReviewSummaryCard | undefined;
	private _evidenceCard: ClaudeReviewEvidenceCard | undefined;
	/** Where the offer to learn a rule shows, under the findings bar (issue 1068). */
	private _learnedOffer: HTMLElement | undefined;
	private readonly _learnedOfferStore = this._register(new DisposableStore());
	/** The hovers of the readiness chip and reason, rebuilt with the summary bar (issue 1126). */
	private readonly _readinessHoverStore = this._register(new DisposableStore());
	/** The summary of the last review pass per chat, and whether its proposed description was dealt with (issue 918). */
	/** The merge-readiness score of each chat's last review pass: advice only, never an approval (issue 920). */
	private readonly _readiness = new Map<string, ClaudeReviewReadiness>();
	/** Why the summary of a chat could not be produced; cleared when a review starts. */
	private readonly _summaryFailures = new Map<string, string>();
	/** Whether the review under way was asked for a summary, so the card only shows its state then. */
	private _summaryWanted = false;
	/** Where the test of each summary gap stands, per chat (issue 936). */
	private readonly _testStates = new Map<string, ClaudeReviewTestState[]>();
	private readonly _summaries = new Map<string, { summary: ClaudeReviewSummary; mode: ClaudeReviewSummaryMode; description: ClaudeReviewDescriptionState }>();
	private _findingZones: ClaudeReviewFindingZones | undefined;
	/** Findings of the last review pass per chat, until they are fixed or dismissed (issue 431). */
	private readonly _findings = new Map<string, ClaudeShownFinding[]>();
	/** The finding threads (replies to Claude) per chat (issue 929). */
	private readonly _conversations = this._register(new DisposableMap<string, ClaudeFindingConversations>());
	/** The review pass in flight: its chat, and its id while it is the structured pass. */
	private _reviewing: { readonly sessionId: string; readonly reviewId?: string } | undefined;
	/** Waits for the answer of the project's own `/review` to read findings from it. */
	private readonly _reviewTurn = this._register(new MutableDisposable());
	/** Waits for the agent's reply to the Write Test turn to turn the Sent chip into Passed or Failed (issue 1361). */
	private readonly _testTurn = this._register(new MutableDisposable());
	/** Reproduce with a Test state per finding id (issue 1398). */
	private readonly _reproduceStates = new Map<string, ClaudeReviewTestState>();
	private readonly _reproduceTurn = this._register(new MutableDisposable());

	override get scopedContextKeyService(): IContextKeyService | undefined {
		return this._widget?.getContextKeyService();
	}

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly _storage: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ITextResourceConfigurationService textResourceConfigurationService: ITextResourceConfigurationService,
		@IEditorService editorService: IEditorService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IContextKeyService private readonly _contextKeys: IContextKeyService,
		@IClaudeReviewService private readonly _review: IClaudeReviewService,
		@IClaudeVerifyEvidenceService private readonly _verifyEvidence: IClaudeVerifyEvidenceService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeActionService private readonly _actions: IClaudeActionService,
		@ICommandService private readonly _commands: ICommandService,
		@IViewsService private readonly _views: IViewsService,
		@INotificationService private readonly _notifications: INotificationService,
		@IContextViewService private readonly _contextView: IContextViewService,
		@IHoverService private readonly _hover: IHoverService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IDialogService private readonly _dialogs: IDialogService,
		@IClipboardService private readonly _clipboard: IClipboardService,
		@ILabelService private readonly _labels: ILabelService,
		@IFileDialogService private readonly _fileDialogs: IFileDialogService,
		@IFileService private readonly _files: IFileService,
		@IClaudeReviewBotService private readonly _reviewBot: IClaudeReviewBotService,
		@ISCMService private readonly _scm: ISCMService,
	) {
		super(ClaudeReviewEditor.ID, group, 'klawlyReviewEditorViewState', telemetryService, instantiationService, _storage, textResourceConfigurationService, themeService, editorService, editorGroupService);
	}

	protected override createEditor(parent: HTMLElement): void {
		const root = append(parent, $('.claude-root.claude-review-editor'));
		const scoped = this._register(this._contextKeys.createScoped(root));
		CLAUDE_REVIEW_EDITOR.bindTo(scoped).set(true);
		const instantiation = this._register(this.instantiationService.createChild(new ServiceCollection([IContextKeyService, scoped])));

		this._header = append(root, $('.claude-review-editor-header'));
		this.renderHeader(this._header);
		this._tray = this._register(new ClaudeReviewFeedbackTray(root, {
			send: () => this.sendFeedback(),
			clear: () => this.setDrafts([]),
			remove: id => this.setDrafts(this.drafts().filter(draft => draft.item.id !== id)),
			reveal: item => this.revealDraft(item.id),
		}));
		const findingsHost: ClaudeReviewFindingsHost = {
			fix: id => this.fixFinding(id),
			fixOnBranch: id => this.fixOnBranch(id),
			reproduceWithTest: id => void this.reproduceWithTest(id),
			reproduceState: id => this._reproduceStates.get(id) ?? 'idle',
			rerun: () => void this.review(),
			dismiss: (id, reason) => this.dismissFinding(id, reason),
			reveal: id => this.revealFinding(id),
			conversation: id => this.findingConversation(id),
			cancel: () => this.cancelReview(),
			dismissAll: () => this.dismissAllFindings(),
			filter: () => this._filter,
			setFilter: filter => {
				this._filter = filter;
				this.renderFindings();
			},
		};
		this._summaryCard = this._register(new ClaudeReviewSummaryCard(root, {
			copy: () => void this.copySummary(),
			copyDescription: () => void this.copyDescription(),
			applyDescription: description => void this.applyDescription(description),
			setDescriptionDismissed: dismissed => this.setDescriptionDismissed(dismissed),
			openChat: () => void this._views.openView(CLAUDE_AGENT_VIEW_ID, false),
			openFile: path => this.openSummaryFile(path),
			setCollapsed: collapsed => this.setSummaryCollapsed(collapsed),
			retry: () => void this.runStructuredReview(),
			drawDiagram: (mermaid, store) => this._diagramBlocks().render('mermaid', mermaid, false, store),
			redrawDiagram: () => void this.redrawDiagram(),
			writeTest: index => void this.writeTest(index),
		}));
		this._evidenceCard = this._register(new ClaudeReviewEvidenceCard(root));
		this._register(this._verifyEvidence.onDidChange(sessionId => {
			if (sessionId === this.input?.sessionId) {
				this.renderEvidence();
			}
		}));
		this._findingsBar = this._register(new ClaudeReviewFindingsBar(root, findingsHost));
		this._learnedOffer = append(root, $('.claude-review-learned-host'));
		this._learnedOffer.hidden = true;
		this._review.setSignals(deserializeReviewSignals(this._storage.get(SIGNALS_STORAGE_KEY, StorageScope.WORKSPACE, '[]')));
		this._register(this._review.onDidChangeSignals(() => {
			const json = serializeReviewSignals(this._review.signals());
			if (json === '[]') {
				this._storage.remove(SIGNALS_STORAGE_KEY, StorageScope.WORKSPACE);
			} else {
				this._storage.store(SIGNALS_STORAGE_KEY, json, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			}
		}));
		const body = append(root, $('.claude-review-editor-body'));
		this._widget = this._register(instantiation.createInstance(
			MultiDiffEditorWidget,
			body,
			instantiation.createInstance(ClaudeReviewElementFactory, this._entries),
			{ variant: 'cards', diffEditorOptions: REVIEW_DIFF_OPTIONS },
		));
		this._widget.setPaddingBottom(BOTTOM_PADDING);
		this._widget.setDiffLayoutOptions(this._viewMode);
		this._register(this._widget.onDidChangeActiveControl(() => this._onDidChangeControl.fire()));
		this._findingZones = this._register(instantiation.createInstance(ClaudeReviewFindingZones, this._widget, findingsHost));
	}

	private renderHeader(header: HTMLElement): void {
		const scope = append(header, $('.claude-segmented.claude-review-scope'));
		scope.setAttribute('role', 'radiogroup');
		scope.setAttribute('aria-label', localize('claudeReviewScope', "Changes to Show"));
		const scopeButton = (value: ClaudeReviewScope, label: string): HTMLButtonElement => {
			const button = append(scope, $<HTMLButtonElement>('button'));
			button.type = 'button';
			button.textContent = label;
			button.setAttribute('role', 'radio');
			this._register(addDisposableListener(button, EventType.CLICK, () => this.setScope(value)));
			return button;
		};
		this._scopeButtons = {
			turn: scopeButton('turn', localize('claudeReviewThisTurn', "This Turn")),
			all: scopeButton('all', localize('claudeReviewAllChanges', "All Changes")),
		};
		this._summary = append(header, $('.claude-review-summary'));
		this._summary.setAttribute('aria-live', 'polite');
		append(header, $('span.spacer'));

		const split = append(header, $('.claude-split.is-compact.claude-review-ask'));
		this._reviewMain = append(split, $<HTMLButtonElement>('button.main'));
		this._reviewMain.type = 'button';
		append(this._reviewMain, $(ThemeIcon.asCSSSelector(Codicon.commentDiscussion)));
		append(this._reviewMain, $('span.label')).textContent = localize('claudeReviewAsk', "Review");
		this._reviewMain.title = localize('claudeReviewAskHint', "Ask Claude to review these changes");
		this._register(addDisposableListener(this._reviewMain, EventType.CLICK, () => this.review()));
		this._reviewMore = append(split, $<HTMLButtonElement>('button.more'));
		this._reviewMore.type = 'button';
		this._reviewMore.setAttribute('aria-haspopup', 'menu');
		this._reviewMore.setAttribute('aria-label', localize('claudeReviewAskMore', "More Review Options"));
		this._reviewMore.title = localize('claudeReviewAskMore', "More Review Options");
		append(this._reviewMore, $(ThemeIcon.asCSSSelector(Codicon.chevronDown)));
		this._register(addDisposableListener(this._reviewMore, EventType.CLICK, () => this.toggleReviewMenu(split)));

		// Issue 706: Keep says what it keeps (DL-70); the chevron picks This Turn, This Chat or Everything, and offers Undo for the same scope.
		const keep = append(header, $('.claude-split.is-compact.claude-review-keep'));
		const keepMain = append(keep, $<HTMLButtonElement>('button.main'));
		keepMain.type = 'button';
		append(keepMain, $(ThemeIcon.asCSSSelector(Codicon.check)));
		const keepLabel = append(keepMain, $('span.label'));
		this._register(addDisposableListener(keepMain, EventType.CLICK, () => this.keepScope()));
		const keepMore = append(keep, $<HTMLButtonElement>('button.more'));
		keepMore.type = 'button';
		keepMore.setAttribute('aria-haspopup', 'menu');
		keepMore.setAttribute('aria-label', localize('claudeReviewKeepOptions', "Keep Options"));
		keepMore.title = localize('claudeReviewKeepOptions', "Keep Options");
		append(keepMore, $(ThemeIcon.asCSSSelector(Codicon.chevronDown)));
		this._register(addDisposableListener(keepMore, EventType.CLICK, () => this.toggleKeepMenu(keep)));
		this._keep = { split: keep, main: keepMain, label: keepLabel, more: keepMore };

		this._commit = append(header, $<HTMLButtonElement>('button.claude-btn.is-small.is-primary.claude-review-commit'));
		this._commit.type = 'button';
		this._commit.textContent = localize('claudeReviewCommit', "Commit");
		this._register(addDisposableListener(this._commit, EventType.CLICK, () => this.commit()));

		this._menu = this._register(new ClaudePopoverMenu(this._contextView, this._hover));
		this._more = append(header, $<HTMLButtonElement>('button.claude-icon-btn.claude-review-more'));
		this._more.type = 'button';
		this._more.setAttribute('aria-haspopup', 'menu');
		this._more.setAttribute('aria-label', localize('claudeReviewMore', "More Review Actions"));
		this._more.title = localize('claudeReviewMore', "More Review Actions");
		append(this._more, $(ThemeIcon.asCSSSelector(Codicon.ellipsis)));
		this._register(addDisposableListener(this._more, EventType.CLICK, () => this.toggleMoreMenu()));
	}

	override get input(): ClaudeReviewInput | undefined {
		return super.input instanceof ClaudeReviewInput ? super.input : undefined;
	}

	override async setInput(input: ClaudeReviewInput, options: undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested) {
			return;
		}
		this._keepScope = undefined;
		this.renderEvidence();
		this._inputListener.value = this._review.onDidChangeReview(event => {
			if (event.sessionId === input.sessionId) {
				this.refresh();
			} else {
				// Everything counts other chats too.
				this.renderKeep();
			}
		});
		await this.resolve(input, context);
	}

	private async resolve(input: ClaudeReviewInput, context?: IEditorOpenContext): Promise<void> {
		this.refresh();
		const viewModel = await input.getViewModel();
		if (this.input !== input) {
			return;
		}
		this._viewModel = viewModel;
		this._widget?.setViewModel(viewModel, { viewState: context ? this.loadEditorViewState(input, context) : undefined });
		this.refresh();
	}

	/** Shows a turn, or every turn, in the open editor. */
	async show(turnId: string | undefined, scope?: ClaudeReviewScope): Promise<void> {
		const input = this.input;
		if (input?.show(turnId, scope)) {
			await this.resolve(input);
		}
	}

	private async setScope(scope: ClaudeReviewScope): Promise<void> {
		const input = this.input;
		if (input && input.scope !== scope) {
			await this.show(input.turnId, scope);
		}
	}

	/** The entries now shown. Kept or undone files update it. */
	get entries(): readonly ClaudeReviewEntry[] {
		return this._entries.get();
	}

	private refresh(): void {
		const input = this.input;
		const all = input ? claudeReviewEntries(claudeSessionReviews(this._review, this._agent, input.target)) : [];
		const ignoredUris = new Set(this._ignored.map(entry => entry.uri.toString()));
		const entries = all.filter(entry => !ignoredUris.has(entry.uri.toString()));
		this._entries.set(entries, undefined);
		void this.updateIgnored(all);
		if (!this._header) {
			return;
		}
		const scope = input?.scope ?? 'all';
		for (const [value, button] of [['turn', this._scopeButtons.turn], ['all', this._scopeButtons.all]] as const) {
			const active = scope === value;
			button.classList.toggle('is-active', active);
			button.setAttribute('aria-checked', String(active));
		}
		this._scopeButtons.turn.disabled = !input?.turnId;
		clearNode(this._summary);
		this._readinessHoverStore.clear();
		const added = entries.reduce((sum, entry) => sum + entry.added, 0);
		const removed = entries.reduce((sum, entry) => sum + entry.removed, 0);
		append(this._summary, $('span.count')).textContent = entries.length === 1
			? localize('claudeReviewOneFile', "1 file")
			: localize('claudeReviewFiles', "{0} files", entries.length);
		appendDiffStat(this._summary, added, removed);
		const readiness = input && this._configuration.getValue(CLAUDE_REVIEW_SHOW_READINESS_SETTING) !== false ? this._readiness.get(input.sessionId) : undefined;
		if (readiness) {
			const band = claudeReviewReadinessBand(readiness.score);
			const badge = append(this._summary, $(`span.readiness.band-${band}`));
			badge.textContent = localize('claudeReviewReadinessBadge', "Readiness {0}/5, {1}", readiness.score, claudeReviewReadinessBandLabel(band));
			// The reason is cut off at 32em; the hover carries all of it, and so does a keyboard focus (issues 1126, 1159).
			const full = formatClaudeReviewReadiness(readiness);
			this._readinessHoverStore.add(this._hover.setupDelayedHover(badge, { content: full, additionalClasses: ['claude-root'] }));
			const reason = append(this._summary, $('span.readiness-reason'));
			reason.textContent = readiness.reason;
			reason.tabIndex = 0;
			reason.setAttribute('role', 'note');
			reason.setAttribute('aria-label', readiness.reason);
			reason.setAttribute('aria-description', full);
			this._readinessHoverStore.add(this._hover.setupDelayedHover(reason, { content: full, additionalClasses: ['claude-root'] }));
			let focusHover: IDisposable | undefined;
			this._readinessHoverStore.add(addDisposableListener(reason, EventType.FOCUS, () => {
				focusHover?.dispose();
				focusHover = this._hover.showInstantHover({ target: reason, content: full, additionalClasses: ['claude-root'] });
			}));
			this._readinessHoverStore.add(addDisposableListener(reason, EventType.BLUR, () => focusHover?.dispose()));
			this._readinessHoverStore.add(toDisposable(() => focusHover?.dispose()));
		}
		this.renderIgnoredNote(this._ignored.filter(entry => all.some(candidate => isEqual(candidate.uri, entry.uri))));
		const empty = entries.length === 0;
		this._reviewMain.disabled = empty || this._busy || this._reviewing !== undefined;
		this._reviewMore.disabled = empty || this._busy || this._reviewing !== undefined;
		const commitTurn = this.commitTurn();
		this._commit.disabled = !commitTurn.turnId;
		this._commit.title = commitTurn.reason;
		this.renderKeep();
		this.renderFeedback();
		this.renderFindings();
	}

	private async updateIgnored(all: readonly ClaudeReviewEntry[]): Promise<void> {
		const input = this.input;
		const ignored = await claudeReviewIgnoredUris(all, this._workspace, this._files, this._configuration);
		const next = all.filter(entry => ignored.has(entry.uri.toString()));
		const same = next.length === this._ignored.length && next.every((entry, index) => isEqual(entry.uri, this._ignored[index].uri));
		if (!same && this.input === input) {
			this._ignored = next;
			this.refresh();
		}
	}

	/** A collapsed note that names the files review.json ignores, so a missing file is discoverable. */
	private renderIgnoredNote(ignored: readonly ClaudeReviewEntry[]): void {
		if (ignored.length === 0) {
			return;
		}
		const note = append(this._summary, $<HTMLDetailsElement>('details.claude-review-ignored'));
		append(note, $('summary')).textContent = ignored.length === 1
			? localize('claudeReviewOneIgnored', "1 file ignored by review.json")
			: localize('claudeReviewIgnoredFiles', "{0} files ignored by review.json", ignored.length);
		const list = append(note, $('ul'));
		for (const entry of ignored) {
			append(list, $('li')).textContent = entry.directory ? `${entry.directory}/${entry.name}` : entry.name;
		}
	}

	/** The line comments of the shown chat, in the order they were left. */
	get feedback(): readonly ClaudeReviewFeedback[] {
		return this.drafts().map(draft => draft.item);
	}

	private drafts(): readonly ClaudeReviewDraft[] {
		const input = this.input;
		return input ? this._drafts.get(input.sessionId) ?? [] : [];
	}

	private setDrafts(drafts: readonly ClaudeReviewDraft[]): void {
		const input = this.input;
		if (input) {
			this._drafts.set(input.sessionId, [...drafts]);
			this.renderFeedback();
		}
	}

	private renderFeedback(): void {
		if (!this._tray) {
			return;
		}
		const before = this._tray.height;
		this._tray.render(this.feedback, this._sendingFeedback);
		if (this._dimension && this._tray.height !== before) {
			this.layout(this._dimension);
		}
	}

	/**
	 * Comment for Claude: asks for a comment on the selected lines of the focused
	 * file and adds it to the tray. Does nothing outside a changed file.
	 */
	async addComment(): Promise<void> {
		const diff = this._widget?.getActiveControl();
		const model = diff?.getModel();
		const selection = diff?.getModifiedEditor().getSelection();
		if (!diff || !model || !selection) {
			return;
		}
		const modified = model.modified.uri;
		const path = this.workspacePath(modified);
		// A selection that ends at the start of a line does not include that line.
		const endLine = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
		const reference = claudeLineReference(path, selection.startLineNumber, endLine);
		const text = await this._quickInput.input({
			title: localize('claudeReviewCommentTitle', "Comment for Claude on {0}", reference),
			placeHolder: localize('claudeReviewCommentPlaceholder', "What should Claude change here?"),
			validateInput: async value => value.trim() ? undefined : localize('claudeReviewCommentEmpty', "Write a comment, or press Escape."),
		});
		if (!text?.trim()) {
			return;
		}
		const entry = this.entries.find(candidate => isEqual(candidate.uri, modified));
		this.addFeedback({
			id: generateUuid(),
			path,
			startLine: selection.startLineNumber,
			endLine,
			text: text.trim(),
			turnId: entry?.turnIds[entry.turnIds.length - 1],
		}, model.original.uri, modified);
	}

	/** Adds a comment to the tray of the shown chat. */
	addFeedback(item: ClaudeReviewFeedback, original: URI | undefined, modified: URI): void {
		this.setDrafts([...this.drafts(), { item, original, modified }]);
	}

	/** Send to Agent: every comment in the tray as one message. */
	async sendFeedback(): Promise<void> {
		const input = this.input;
		const drafts = this.drafts();
		if (!input || drafts.length === 0 || this._sendingFeedback) {
			return;
		}
		this._sendingFeedback = true;
		this.renderFeedback();
		try {
			const label = drafts.length === 1
				? localize('claudeReviewFeedbackLabelOne', "1 review comment")
				: localize('claudeReviewFeedbackLabelMany', "{0} review comments", drafts.length);
			if (await this.sendToAgent(input.sessionId, drafts.map(draft => draft.item), label)) {
				this._drafts.delete(input.sessionId);
			}
		} finally {
			this._sendingFeedback = false;
			this.renderFeedback();
		}
	}

	/**
	 * Sends review comments to the agent as one message of `path:line` references.
	 * It goes through the composer's queue, so an idle chat starts a turn and a
	 * running one gets it queued, or steered when the While Working setting says so.
	 * Resolves whether it was sent.
	 */
	private async sendToAgent(sessionId: string, items: readonly ClaudeReviewFeedback[], label: string): Promise<boolean> {
		return this.sendTextToAgent(sessionId, formatClaudeReviewFeedback(items), label);
	}

	private async sendTextToAgent(sessionId: string, text: string, label: string): Promise<boolean> {
		const cwd = this.localFolder();
		if (!cwd) {
			this._notifications.error(localize('claudeReviewFeedbackNoFolder', "Open a local folder to send comments to Claude."));
			return false;
		}
		try {
			const steer = readClaudeWhileWorking(this._configuration.getValue(CLAUDE_COMPOSER_WHILE_WORKING_SETTING)) === 'steer' && await this._agent.supportsSteer(sessionId);
			await this._agent.queue(sessionId, text, cwd, steer ? 'steer' : 'queue', { label });
			if (this._agent.getCurrentSession()?.id !== sessionId) {
				this._agent.selectSession(sessionId);
			}
			await this._views.openView(CLAUDE_AGENT_VIEW_ID, false);
			return true;
		} catch (error) {
			this._notifications.error(toErrorMessage(error));
			return false;
		}
	}

	private revealDraft(id: string): void {
		const draft = this.drafts().find(candidate => candidate.item.id === id);
		if (!draft) {
			return;
		}
		try {
			this._widget?.reveal({ original: draft.original, modified: draft.modified }, { range: new Range(draft.item.startLine, 1, draft.item.endLine, 1), highlight: true });
		} catch {
			// The file left the review (kept or undone): open it at the line instead.
			void this.editorService.openEditor({ resource: draft.modified, options: { pinned: true, selection: { startLineNumber: draft.item.startLine, startColumn: 1 } } satisfies ITextEditorOptions });
		}
	}

	/** `uri` relative to the workspace folder that holds it, with forward slashes; else its full path. */
	private workspacePath(uri: URI): string {
		const folder = this._workspace.getWorkspaceFolder(uri);
		return (folder && relativePath(folder.uri, uri)) || uri.fsPath;
	}

	/** The last commit of the first local folder, from its reflog, for the review exports (issue 920). */
	private async headCommit(): Promise<string | undefined> {
		const folder = this.localFolder();
		if (!folder) {
			return undefined;
		}
		try {
			return lastClaudeReflogCommit((await this._files.readFile(joinPath(URI.file(folder), '.git', 'logs', 'HEAD'))).value.toString())?.sha;
		} catch {
			return undefined;
		}
	}

	/** The key the dismissal counters are kept under: the first local folder of the workspace. */
	private signalRepo(): string | undefined {
		return this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.toString();
	}

	/** Dismisses a finding; the dismissal counts toward a learned rule (issue 1068). */
	private dismissFinding(id: string, _reason?: ClaudeDismissReason): void {
		const item = this.findings.find(candidate => candidate.id === id);
		this.setFindings(this.findings.filter(candidate => candidate.id !== id));
		if (item) {
			this.recordStats('dismissed', [item.finding]);
			this.countSignal(item.finding);
		}
	}

	/** Dismiss All: every shown finding counts as dismissed in the statistics (issue 937). */
	private dismissAllFindings(): void {
		this.recordStats('dismissed', this.findings.map(item => item.finding));
		this.setFindings([]);
	}

	/** Adds one event per finding to the on-device statistics log (issue 937); nothing leaves the machine. */
	private recordStats(kind: ClaudeReviewStatEventKind, findings: readonly ClaudeReviewFinding[]): void {
		if (findings.length === 0) {
			return;
		}
		const now = Date.now();
		const events = deserializeReviewStats(this._storage.get(CLAUDE_REVIEW_STATS_STORAGE_KEY, StorageScope.WORKSPACE, '[]'));
		const next = recordClaudeReviewStats(events, findings.map(finding => ({ time: now, kind, severity: finding.severity, category: finding.category, file: normalizeClaudeFindingPath(finding.file) })), now);
		this._storage.store(CLAUDE_REVIEW_STATS_STORAGE_KEY, serializeReviewStats(next), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	/** Counts one dismissal; at the threshold, offers the rule (DL-12: one question, two buttons). */
	private countSignal(finding: ClaudeReviewFinding): void {
		const repo = this.signalRepo();
		if (!repo) {
			return;
		}
		const threshold = readClaudeLearnAfter(this._configuration.getValue(CLAUDE_REVIEW_LEARN_AFTER_SETTING));
		const counter = this._review.recordFindingSignal(repo, finding, threshold);
		if (counter) {
			this.offerLearnedRule(repo, counter);
		}
	}

	private offerLearnedRule(repo: string, counter: ClaudeReviewSignalCounter): void {
		const host = this._learnedOffer;
		if (!host) {
			return;
		}
		const file = readClaudeReviewConfigFile(this._configuration.getValue(CLAUDE_REVIEW_CONFIG_FILE_SETTING));
		const close = () => {
			this._learnedOfferStore.clear();
			clearNode(host);
			host.hidden = true;
			this.relayout();
		};
		this._learnedOfferStore.clear();
		clearNode(host);
		host.hidden = false;
		renderClaudeLearnedOffer(host, claudeLearnedRuleOffer(counter), learnedClaudeReviewRule(counter).text, file, () => void this.addLearnedRule(repo, counter, file).then(close), () => {
			this._review.resolveFindingSignal(repo, counter);
			close();
		}, () => void this._commands.executeCommand(CLAUDE_OPEN_SETTINGS_COMMAND_ID, 'review'), this._learnedOfferStore);
		this.relayout();
	}

	/** Add Rule: writes the learned rule into the project's review file. A file that is not a JSON object is never overwritten. */
	private async addLearnedRule(repo: string, counter: ClaudeReviewSignalCounter, file: string): Promise<void> {
		const folder = this._workspace.getWorkspace().folders.find(candidate => candidate.uri.scheme === Schemas.file);
		if (!folder) {
			return;
		}
		const target = joinPath(folder.uri, ...file.split('/'));
		try {
			let text: string | undefined;
			try {
				text = (await this._files.readFile(target)).value.toString();
			} catch {
				text = undefined;
			}
			const next = addClaudeReviewRule(text, learnedClaudeReviewRule(counter));
			if (next === undefined) {
				this._notifications.error(localize("claudeReviewLearnedBadFile", "{0} is not a JSON object, so Klawly left it as it is.", file));
				return;
			}
			await this._files.writeFile(target, VSBuffer.fromString(next));
			this._review.resolveFindingSignal(repo, counter);
			this._notifications.prompt(Severity.Info, localize("claudeReviewLearnedAdded", "Added a rule to {0}. Claude will stop flagging this here.", file), [{
				label: localize("claudeReviewLearnedManage", "Manage Rules"),
				run: () => void this._commands.executeCommand(CLAUDE_OPEN_SETTINGS_COMMAND_ID, 'review'),
			}]);
		} catch (error) {
			this._notifications.error(toErrorMessage(error));
		}
	}

	private relayout(): void {
		if (this._dimension) {
			this.layout(this._dimension);
		}
	}

	private localFolder(): string | undefined {
		return this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri.fsPath;
	}

	/** The turn whose kept changes Commit commits, or why there is none. */
	private commitTurn(): { readonly turnId?: string; readonly reason: string } {
		const input = this.input;
		if (!input) {
			return { reason: '' };
		}
		const kept = claudeSessionReviews(this._review, this._agent, input.target).filter(review => review.files.some(file => file.state === 'accepted'));
		if (kept.length === 0) {
			return { reason: localize('claudeReviewCommitNone', "Keep a change before committing it") };
		}
		if (kept.length > 1) {
			return { reason: localize('claudeReviewCommitSpread', "Kept changes come from more than one turn. Switch to This Turn to commit one turn at a time.") };
		}
		return { turnId: kept[0].turnId, reason: localize('claudeReviewCommitHint', "Stage and commit the kept changes") };
	}

	private async commit(): Promise<void> {
		const input = this.input;
		const { turnId } = this.commitTurn();
		if (input && turnId) {
			await this._commands.executeCommand(CLAUDE_COMMIT_ACCEPTED_COMMAND_ID, turnId, input.sessionId);
		}
	}

	/** Sends the shown changes to the chat with a review prompt. Claude reads them; it does not edit. */
	async askClaude(id: Extract<AgentActionId, 'reviewTurnChanges' | 'securityReviewChanges'>): Promise<void> {
		const input = this.input;
		if (!input || this._busy) {
			return;
		}
		const diff = claudeSessionReviews(this._review, this._agent, input.target).map(formatTurnDiff).filter(Boolean).join('\n');
		if (!diff) {
			return;
		}
		this._busy = true;
		this.refresh();
		try {
			if (this._agent.getCurrentSession()?.id !== input.sessionId) {
				this._agent.selectSession(input.sessionId);
			}
			await this._views.openView(CLAUDE_AGENT_VIEW_ID, false);
			await this._actions.run({
				id,
				source: 'button',
				attachments: [{ kind: 'pasted-text', id: `review-${input.sessionId}-${input.scope}`, text: diff, lineCount: diff.split('\n').length }],
			});
		} catch (error) {
			this._notifications.error(toErrorMessage(error));
		} finally {
			this._busy = false;
			this.refresh();
		}
	}

	/**
	 * Review (spec 34a): the project's own `/review` command or review skill runs
	 * in the chat as before, and when its answer carries findings they land on the
	 * diff; when it carries none, the structured pass runs. Without the project's
	 * own review, the structured pass reviews the diff and its findings land on the
	 * lines they are about (issue 431). A runtime without the pass reviews in the chat.
	 */
	async review(): Promise<void> {
		const input = this.input;
		if (!input || this._busy || this._reviewing) {
			return;
		}
		const session = this._agent.getSessions().find(candidate => candidate.id === input.sessionId);
		const prefer = this._configuration.getValue(CLAUDE_ACTIONS_PREFER_COMMANDS_SETTING) !== false;
		if (claudeHasOwnReviewCommand(session?.commands ?? [], session?.skills ?? [], prefer)) {
			const turns = this._agent.getViewState(input.sessionId).turns.length;
			await this.askClaude('reviewTurnChanges');
			this.watchReviewTurn(input.sessionId, turns);
			return;
		}
		if (!this._runtime.reviewChanges) {
			await this.askClaude('reviewTurnChanges');
			return;
		}
		await this.runStructuredReview();
	}

	/** Reads findings from the answer of the turn the project's own `/review` started; none runs the structured pass. */
	private watchReviewTurn(sessionId: string, turnsBefore: number): void {
		const check = () => {
			const turn = this._agent.getViewState(sessionId).turns.slice(turnsBefore).find(candidate => candidate.status !== 'running');
			if (!turn) {
				return;
			}
			this._reviewTurn.clear();
			if (turn.status !== 'complete') {
				return;
			}
			const findings = readClaudeReviewFindingsFromText(turn.assistantText);
			if (findings) {
				this.showFindings(sessionId, findings);
			} else if (this.input?.sessionId === sessionId && this._runtime.reviewChanges) {
				void this.runStructuredReview();
			}
		};
		this._reviewTurn.value = this._agent.onDidChangeViewState(event => {
			if (event.sessionId === sessionId) {
				check();
			}
		});
	}

	/** Reads the closing `Test result:` line of the Write Test turn: Passed or Failed, or Sent stays when the reply has none (issue 1361). */
	private watchTestTurn(sessionId: string, index: number, turnsBefore: number): void {
		const check = () => {
			const turn = this._agent.getViewState(sessionId).turns.slice(turnsBefore).find(candidate => candidate.status !== 'running');
			if (!turn) {
				return;
			}
			this._testTurn.clear();
			const states = this._testStates.get(sessionId);
			if (!states) {
				return;
			}
			states[index] = (turn.status === 'complete' ? parseClaudeReviewTestResult(turn.assistantText) : undefined) ?? (turn.status === 'complete' ? 'sent' : 'idle');
			this.renderSummary();
		};
		this._testTurn.value = this._agent.onDidChangeViewState(event => {
			if (event.sessionId === sessionId) {
				check();
			}
		});
		check();
	}

	/**
	 * The structured pass: one read-only query over the shown diff whose answer is
	 * a list of findings. An answer that is not one goes to the chat as a review.
	 */
	private _diagrams: ClaudeDiagramBlocks | undefined;

	private _diagramBlocks(): ClaudeDiagramBlocks {
		return this._diagrams ??= this.instantiationService.createInstance(ClaudeDiagramBlocks);
	}

	/** Write Test (issue 936): the gap goes to the agent as a fixed template turn; commands still ask the person first. */
	private async writeTest(index: number): Promise<void> {
		const input = this.input;
		const gap = input ? this._summaries.get(input.sessionId)?.summary.testGaps?.[index] : undefined;
		const cwd = this.localFolder();
		if (!input || !gap || !cwd) {
			return;
		}
		const states = this._testStates.get(input.sessionId) ?? [];
		states[index] = 'sent';
		this._testStates.set(input.sessionId, states);
		this.renderSummary();
		try {
			await this._views.openView(CLAUDE_AGENT_VIEW_ID, false);
			const turnsBefore = this._agent.getViewState(input.sessionId).turns.length;
			await this._agent.submit(input.sessionId, buildClaudeWriteTestPrompt(gap), cwd);
			this.watchTestTurn(input.sessionId, index, turnsBefore);
		} catch (error) {
			states[index] = 'idle';
			this.renderSummary();
			this._notifications.error(localize('claudeReviewWriteTestFailed', "Could not send the test request to the chat: {0}", error instanceof Error ? error.message : String(error)));
		}
	}

	/** Reads the closing `Test result:` line of the Reproduce turn: failed means reproduced, passed means unexpected; Sent stays when the reply has none (issue 1398). */
	private watchReproduceTurn(sessionId: string, id: string, turnsBefore: number): void {
		const check = () => {
			const turn = this._agent.getViewState(sessionId).turns.slice(turnsBefore).find(candidate => candidate.status !== 'running');
			if (!turn) {
				return;
			}
			this._reproduceTurn.clear();
			this._reproduceStates.set(id, (turn.status === 'complete' ? parseClaudeReviewTestResult(turn.assistantText) : undefined) ?? (turn.status === 'complete' ? 'sent' : 'idle'));
			this.renderFindings();
		};
		this._reproduceTurn.value = this._agent.onDidChangeViewState(event => {
			if (event.sessionId === sessionId) {
				check();
			}
		});
		check();
	}

	/** Reproduce with a Test (issue 936): asks for a failing test that shows the finding; the finding stays. */
	private async reproduceWithTest(id: string): Promise<void> {
		const input = this.input;
		const item = this.findings.find(candidate => candidate.id === id);
		const cwd = this.localFolder();
		if (!input || !item || !cwd) {
			return;
		}
		this._reproduceStates.set(id, 'sent');
		this.renderFindings();
		try {
			await this._views.openView(CLAUDE_AGENT_VIEW_ID, false);
			const turnsBefore = this._agent.getViewState(input.sessionId).turns.length;
			await this._agent.submit(input.sessionId, buildClaudeReproduceTestPrompt(item.finding), cwd);
			this.watchReproduceTurn(input.sessionId, id, turnsBefore);
		} catch (error) {
			this._reproduceStates.set(id, 'idle');
			this.renderFindings();
			this._notifications.error(localize('claudeReviewReproduceFailed', "Could not send the test request to the chat: {0}", error instanceof Error ? error.message : String(error)));
		}
	}

	/** Asks for a kind and runs the review again with a diagram of it (issue 919). */
	private async redrawDiagram(): Promise<void> {
		const picks: (IQuickPickItem & { kind: ClaudeReviewDiagramKind })[] = [
			{ kind: 'sequence', label: localize('claudeReviewDiagramSequence', "Sequence"), description: localize('claudeReviewDiagramSequenceHint', "Who calls whom, in order") },
			{ kind: 'flow', label: localize('claudeReviewDiagramFlow', "Flow"), description: localize('claudeReviewDiagramFlowHint', "Steps and branches") },
			{ kind: 'er', label: localize('claudeReviewDiagramEr', "Entities"), description: localize('claudeReviewDiagramErHint', "Data and its relations") },
			{ kind: 'class', label: localize('claudeReviewDiagramClass', "Classes"), description: localize('claudeReviewDiagramClassHint', "Types and how they relate") },
		];
		const pick = await this._quickInput.pick(picks, { placeHolder: localize('claudeReviewDiagramPick', "Pick the kind of diagram to draw") });
		if (pick) {
			await this.runStructuredReview(pick.kind);
		}
	}

	/**
	 * The ticket request of a review: ids from the diff, the branch name and the head commit's subject, and the read-only
	 * tracker tools of the connected MCP servers. The first time tools would run, it asks; declining turns the setting off (issue 1378).
	 * Undefined when the review runs without tickets.
	 */
	private async ticketRequest(diff: string, patterns: readonly string[]): Promise<ClaudeReviewTicketRequest | undefined> {
		const [overview, context] = await Promise.all([
			this._runtime.getAccountOverview?.().catch(() => undefined),
			claudeBranchContext(this._scm, CancellationToken.None).catch((): { branch?: string; subject?: string } => ({})),
		]);
		const { tools, readOnlyHints } = claudeReviewTicketTools(overview?.mcpServers ?? []);
		const ids = extractClaudeTicketIds(claudeReviewTicketSources(diff, context.branch, context.subject), patterns);
		if (tools.length && !this._storage.getBoolean(TICKETS_CONSENT_STORAGE_KEY, StorageScope.APPLICATION, false)) {
			const { confirmed } = await this._dialogs.confirm({
				message: localize('claudeReviewTicketsConsent', "Let the review read your tickets?"),
				detail: localize('claudeReviewTicketsConsentDetail', "The review will call these read-only tools to read the linked ticket:\n{0}", tools.join('\n')),
				primaryButton: localize({ key: 'claudeReviewTicketsAllow', comment: ['&& denotes a mnemonic'] }, "&&Allow"),
			});
			if (!confirmed) {
				await this._configuration.updateValue(CLAUDE_REVIEW_USE_TICKETS_SETTING, false);
				return undefined;
			}
			this._storage.store(TICKETS_CONSENT_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
		}
		return { ids, tools, ...(Object.keys(readOnlyHints).length ? { readOnlyHints } : {}) };
	}

	private async runStructuredReview(diagramKind?: ClaudeReviewDiagramKind): Promise<void> {
		const input = this.input;
		const reviewChanges = this._runtime.reviewChanges;
		const diff = input && claudeSessionReviews(this._review, this._agent, input.target).map(formatTurnDiff).filter(Boolean).join('\n');
		if (!input || !reviewChanges || !diff || this._reviewing) {
			return;
		}
		const cwd = this.localFolder();
		if (!cwd) {
			this._notifications.error(localize('claudeReviewNoFolder', "Open a local folder to review changes with Claude."));
			return;
		}
		const sessionId = input.sessionId;
		const reviewId = generateUuid();
		const model = this._agent.getSessions().find(candidate => candidate.id === sessionId)?.modelId;
		const settings = readClaudeReviewSettings(key => this._configuration.getValue(key));
		this._filter = settings;
		this._reviewing = { sessionId, reviewId };
		this._summaryFailures.delete(sessionId);
		this._summaryWanted = settings.summary !== 'off';
		this.refresh();
		this.renderSummary();
		try {
			// Issue 926: Quick, Deep or Auto, and say which one runs and why.
			const plan = planClaudeReviewRun(diff, key => this._configuration.getValue(key), { model });
			this._notifications.status(claudeReviewDepthMessage(plan), { hideAfter: 8000 });
			const tickets = settings.useTickets ? await this.ticketRequest(diff, settings.ticketPatterns) : undefined;
			const result = await this._runtime.reviewChanges?.({ reviewId, sessionId, cwd, diff, strictness: settings.strictness, categories: settings.categories, summary: settings.summary, readiness: settings.showReadiness, depth: plan.depth, maxTurns: plan.maxTurns, ...(tickets ? { tickets } : {}), ...(diagramKind ? { diagramKind } : {}), ...(plan.model ? { model: plan.model } : {}) });
			if (!result) {
				return;
			}
			if (result.ok) {
				if (settings.showReadiness && result.event.readiness) {
					this._readiness.set(sessionId, result.event.readiness);
				} else {
					this._readiness.delete(sessionId);
				}
				this.showSummary(sessionId, result.event.summary, settings.summary);
				this.showFindings(sessionId, result.event.findings);
			} else if (result.failure.kind === 'malformed') {
				// Claude answered with prose: the chat review shows it as a message instead (issue 431).
				this._reviewing = undefined;
				if (this.input?.sessionId === sessionId) {
					await this.askClaude('reviewTurnChanges');
				}
			} else if (result.failure.kind === 'failed') {
				this._notifications.error(localize('claudeReviewFailed', "Claude could not review these changes: {0}", result.failure.message));
				if (this._summaryWanted) {
					this._summaryFailures.set(sessionId, result.failure.message);
				}
			}
		} catch (error) {
			this._notifications.error(toErrorMessage(error));
			if (this._summaryWanted) {
				this._summaryFailures.set(sessionId, toErrorMessage(error));
			}
		} finally {
			if (this._reviewing?.reviewId === reviewId) {
				this._reviewing = undefined;
			}
			this.refresh();
			this.renderSummary();
		}
	}

	private cancelReview(): void {
		const reviewId = this._reviewing?.reviewId;
		if (reviewId) {
			void this._runtime.cancelReview?.(reviewId);
		}
	}

	/** Shows the summary of the review pass of chat `sessionId`; none clears the one it showed (issue 918). */
	private showSummary(sessionId: string, summary: ClaudeReviewSummary | undefined, mode: ClaudeReviewSummaryMode): void {
		if (summary && mode !== 'off') {
			this._summaries.set(sessionId, { summary, mode, description: { status: 'open' } });
		} else {
			this._summaries.delete(sessionId);
		}
		this.renderSummary();
	}

	/** Shows what the Agent Browser collected for the turn on show, or the newest turn that has any (issue 1495). */
	private renderEvidence(): void {
		if (!this._evidenceCard) {
			return;
		}
		const before = this._evidenceCard.height;
		const input = this.input;
		const evidence = !input ? undefined : input.turnId ? this._verifyEvidence.get(input.sessionId, input.turnId) : this._verifyEvidence.getLatest(input.sessionId)?.evidence;
		this._evidenceCard.render(evidence);
		if (this._dimension && this._evidenceCard.height !== before) {
			this.layout(this._dimension);
		}
	}

	private renderSummary(): void {
		if (!this._summaryCard) {
			return;
		}
		const before = this._summaryCard.height;
		const shown = this.input ? this._summaries.get(this.input.sessionId) : undefined;
		const sessionId = this.input?.sessionId;
		const failure = sessionId ? this._summaryFailures.get(sessionId) : undefined;
		const loading = !!sessionId && this._reviewing?.sessionId === sessionId && this._summaryWanted;
		this._summaryCard.render(shown?.summary, shown?.mode === 'summaryAndDescription', {
			description: shown?.description ?? { status: 'open' },
			canAccept: !!this.localFolder(),
			collapsed: this.input ? this.summaryCollapsed(this.input.sessionId) : false,
			testStates: sessionId ? this._testStates.get(sessionId) : undefined,
			...(loading ? { state: { kind: 'loading' as const } } : failure !== undefined ? { state: { kind: 'failed' as const, message: failure } } : {}),
		});
		if (this._dimension && this._summaryCard.height !== before) {
			this.layout(this._dimension);
		}
	}

	/** Copy Summary: the shown summary as Markdown on the clipboard. */
	private async copySummary(): Promise<void> {
		const shown = this.input ? this._summaries.get(this.input.sessionId) : undefined;
		if (shown) {
			await this._clipboard.writeText(formatClaudeReviewSummary(shown.summary, this.input ? this._readiness.get(this.input.sessionId) : undefined, true));
			this._notifications.info(localize('claudeReviewSummaryCopied', "Copied the review summary."));
		}
	}

	/** Copy Description: only the proposed pull request description on the clipboard (issue 1088). */
	private async copyDescription(): Promise<void> {
		const description = this.input ? this._summaries.get(this.input.sessionId)?.summary.description : undefined;
		if (description) {
			await this._clipboard.writeText(description);
			this._notifications.info(localize('claudeReviewDescriptionCopied', "Copied the proposed description."));
		}
	}

	/**
	 * Accept on a proposed description: Claude updates the pull request in the chat, where
	 * `gh pr edit` asks the person first. The proposal only counts as sent once the prompt was
	 * submitted; a failure keeps it open and says why (issue 1087).
	 */
	private async applyDescription(description: string): Promise<void> {
		const input = this.input;
		const shown = input ? this._summaries.get(input.sessionId) : undefined;
		const cwd = this.localFolder();
		if (!input || !shown || !description || !cwd) {
			return;
		}
		const error = await submitClaudeReviewDescription(shown.description, {
			openChat: () => this._views.openView(CLAUDE_AGENT_VIEW_ID, false),
			submit: prompt => this._agent.submit(input.sessionId, prompt, cwd),
		}, localize('claudeReviewDescriptionPrompt', "Update the description of this branch's pull request to the text below. Write it to a temporary file and run `gh pr edit --body-file <file>`. Change nothing else.\n\n{0}", description));
		if (error !== undefined) {
			this._notifications.error(localize('claudeReviewDescriptionFailed', "Could not send the description to the chat: {0}", error));
		}
		this.renderSummary();
	}

	/** Dismiss keeps a way back: Undo and Copy Description stay on the card (issue 1087). */
	private setDescriptionDismissed(dismissed: boolean): void {
		const shown = this.input ? this._summaries.get(this.input.sessionId) : undefined;
		if (shown) {
			shown.description = { status: dismissed ? 'dismissed' : 'open' };
			this.renderSummary();
		}
	}

	private summaryCollapsedKey(sessionId: string): string {
		return `klawly.review.summaryCollapsed.${sessionId}`;
	}

	private summaryCollapsed(sessionId: string): boolean {
		return this._storage.getBoolean(this.summaryCollapsedKey(sessionId), StorageScope.WORKSPACE, false);
	}

	/** Collapses or expands the summary card; remembered per chat (issue 1088). */
	private setSummaryCollapsed(collapsed: boolean): void {
		if (!this.input) {
			return;
		}
		const key = this.summaryCollapsedKey(this.input.sessionId);
		if (collapsed) {
			this._storage.store(key, true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this._storage.remove(key, StorageScope.WORKSPACE);
		}
		this.renderSummary();
	}

	/** Opens a file of the summary at its first finding, or at the top when it has none (issue 1088). */
	private openSummaryFile(path: string): void {
		const uri = this.findingUri(path);
		const wanted = normalizeClaudeFindingPath(path);
		const first = this.findings.find(item => normalizeClaudeFindingPath(item.finding.file) === wanted);
		void this.editorService.openEditor({
			resource: uri,
			options: { pinned: true, selection: { startLineNumber: first?.finding.startLine ?? 1, startColumn: 1 } } satisfies ITextEditorOptions,
		});
	}

	/** Puts `findings` on the diff of chat `sessionId`, in place of the ones it showed. */
	private showFindings(sessionId: string, findings: readonly ClaudeReviewFinding[]): void {
		if (findings.length === 0) {
			this._notifications.info(localize('claudeReviewNoFindings', "Claude found no problems in these changes."));
		}
		this.recordStats('ignored', (this._findings.get(sessionId) ?? []).map(item => item.finding));
		this.recordStats('raised', findings);
		this._findings.set(sessionId, findings.map(finding => ({ id: generateUuid(), finding, uri: this.findingUri(finding.file) })));
		this.renderFindings();
	}

	/** The shown file a finding names, matched by its workspace path; else the path itself. */
	private findingUri(file: string): URI {
		const wanted = normalizeClaudeFindingPath(file);
		const entry = this.entries.find(candidate => this.workspacePath(candidate.uri) === wanted || candidate.uri.fsPath === file);
		if (entry) {
			return entry.uri;
		}
		const folder = this._workspace.getWorkspace().folders.find(candidate => candidate.uri.scheme === Schemas.file);
		return isAbsolute(file) || !folder ? URI.file(file) : URI.joinPath(folder.uri, wanted);
	}

	/** The findings of the shown chat that are not fixed or dismissed yet. */
	get findings(): readonly ClaudeShownFinding[] {
		const input = this.input;
		return input ? this._findings.get(input.sessionId) ?? [] : [];
	}

	private setFindings(findings: readonly ClaudeShownFinding[]): void {
		const input = this.input;
		if (input) {
			this._findings.set(input.sessionId, [...findings]);
			this.renderFindings();
		}
	}

	private renderFindings(): void {
		if (!this._findingsBar) {
			return;
		}
		const before = this._findingsBar.height;
		const running = this._reviewing !== undefined && this._reviewing.sessionId === this.input?.sessionId;
		this._findingsBar.render(running ? { kind: 'running' } : { kind: 'done', findings: this.findings });
		this._findingZones?.set(filterClaudeReviewFindings(this.findings.map(item => item.finding), this._filter).map(finding => this.findings.find(item => item.finding === finding)!));
		if (this._dimension && this._findingsBar.height !== before) {
			this.layout(this._dimension);
		}
	}

	/** Fix with Agent: sends the finding as a line comment, the way Send to Agent sends comments. */
	async fixFinding(id: string): Promise<void> {
		const input = this.input;
		const item = this.findings.find(candidate => candidate.id === id);
		if (!input || !item) {
			return;
		}
		const feedback = claudeFindingFeedback(item.finding, item.id);
		const sent = await this.sendToAgent(input.sessionId, [{ ...feedback, path: this.workspacePath(item.uri) }], localize('claudeReviewFindingLabel', "Fix: {0}", item.finding.title));
		if (sent) {
			this.recordStats('fixed', [item.finding]);
			this._findings.set(input.sessionId, (this._findings.get(input.sessionId) ?? []).filter(candidate => candidate.id !== id));
			this.renderFindings();
		}
	}

	/** Fix on PR Branch (issue 872): a new chat in a worktree that checks out the pull request's branch and fixes only this finding. */
	private async fixOnBranch(id: string): Promise<void> {
		const input = this.input;
		const item = this.findings.find(candidate => candidate.id === id);
		if (input && item) {
			await this._reviewBot.fix(input.sessionId, item.finding);
		}
	}

	/** The thread of a shown finding: replies run a read-only turn of Claude (issue 929). */
	private findingConversation(id: string): ClaudeFindingConversationView | undefined {
		const input = this.input;
		const item = this.findings.find(candidate => candidate.id === id);
		if (!input || !item || !this._runtime.askSideQuestion) {
			return undefined;
		}
		return this.conversationsFor(input.sessionId).view(id, item.finding);
	}

	private conversationsFor(sessionId: string): ClaudeFindingConversations {
		let conversations = this._conversations.get(sessionId);
		if (!conversations) {
			const key = `klawly.review.threads.${sessionId}`;
			const saved = deserializeFindingThreads(this._storage.get(key, StorageScope.WORKSPACE, '[]'));
			conversations = new ClaudeFindingConversations({
				askReadOnly: prompt => this.askReadOnly(sessionId, prompt),
				codeAround: finding => this.codeAround(finding),
				summary: () => undefined,
				markIntended: (_findingId, finding) => this.countSignal(finding),
				save: threads => {
					const json = serializeFindingThreads(threads);
					if (json === '[]') {
						this._storage.remove(key, StorageScope.WORKSPACE);
					} else {
						this._storage.store(key, json, StorageScope.WORKSPACE, StorageTarget.MACHINE);
					}
				},
				continueInChat: findingId => void this.continueFindingInChat(sessionId, findingId),
				fail: message => this._notifications.error(localize('claudeReviewReplyFailed', "Claude could not answer: {0}", message)),
			}, saved);
			this._conversations.set(sessionId, conversations);
		}
		return conversations;
	}

	/** One read-only turn (Read, Grep, Glob) that answers `prompt` from the project folder. */
	private async askReadOnly(sessionId: string, prompt: string): Promise<string> {
		const cwd = this.localFolder();
		if (!cwd || !this._runtime.askSideQuestion) {
			throw new Error(localize('claudeReviewReplyNoFolder', "Open a local folder to ask Claude."));
		}
		const model = this._agent.getSessions().find(candidate => candidate.id === sessionId)?.modelId;
		const result = await this._runtime.askSideQuestion({ id: generateUuid(), question: prompt, cwd, ...(model ? { model } : {}) });
		if (result.kind === 'answer') {
			return result.text;
		}
		throw new Error(result.kind === 'failed' ? result.message : localize('claudeReviewReplyCancelled', "The answer was cancelled."));
	}

	/** The lines around a finding in the shown file, for the reply prompt. */
	private codeAround(finding: ClaudeReviewFinding): string[] {
		const item = this.findings.find(candidate => candidate.finding === finding);
		const model = item && this._widget?.tryGetCodeEditor(item.uri)?.editor.getModel();
		if (!model) {
			return [];
		}
		const first = Math.max(1, finding.startLine - 3);
		const last = Math.min(model.getLineCount(), finding.endLine + 3);
		const lines: string[] = [];
		for (let line = first; line <= last; line++) {
			lines.push(`${line}: ${model.getLineContent(line)}`);
		}
		return lines;
	}

	/** Continue in Chat: sends the finding and its thread to the agent; the finding stays shown. */
	private async continueFindingInChat(sessionId: string, id: string): Promise<void> {
		const item = (this._findings.get(sessionId) ?? []).find(candidate => candidate.id === id);
		if (!item) {
			return;
		}
		const feedback = claudeFindingFeedback(item.finding, item.id);
		const replies = this._conversations.get(sessionId)?.threads().find(thread => thread.findingId === id)?.replies ?? [];
		const text = [feedback.text, ...replies.map(reply => `${reply.role === 'user' ? 'Author' : 'Reviewer'}: ${reply.text}`)].join(String.fromCharCode(10));
		await this.sendToAgent(sessionId, [{ ...feedback, text, path: this.workspacePath(item.uri) }], localize('claudeReviewFindingChatLabel', "Discuss: {0}", item.finding.title));
	}

	private revealFinding(id: string): void {
		const item = this.findings.find(candidate => candidate.id === id);
		if (!item) {
			return;
		}
		const entry = this.entries.find(candidate => isEqual(candidate.uri, item.uri));
		const range = new Range(item.finding.startLine, 1, item.finding.endLine, 1);
		if (entry) {
			this._widget?.reveal({ original: entry.original, modified: entry.uri }, { range, highlight: true });
			return;
		}
		void this.editorService.openEditor({ resource: item.uri, options: { pinned: true, selection: { startLineNumber: item.finding.startLine, startColumn: 1 } } satisfies ITextEditorOptions });
	}

	/** Keeps `uri` in every shown turn that changed it. */
	keepFile(uri: URI): void {
		const input = this.input;
		const entry = this.entries.find(candidate => isEqual(candidate.uri, uri));
		if (input && entry) {
			for (const turnId of entry.turnIds) {
				this._review.acceptFile(input.sessionId, turnId, uri);
			}
		}
	}

	/** Undoes `uri` in every shown turn that changed it, newest turn first, so each undo finds the text it wrote. */
	async undoFile(uri: URI): Promise<void> {
		const input = this.input;
		const entry = this.entries.find(candidate => isEqual(candidate.uri, uri));
		if (!input || !entry) {
			return;
		}
		try {
			for (const turnId of [...entry.turnIds].reverse()) {
				await this._review.rejectFile(input.sessionId, turnId, uri);
			}
		} catch (error) {
			this.reportUndoError(error);
		}
	}

	async keepAll(): Promise<void> {
		const input = this.input;
		if (input) {
			for (const review of claudeSessionReviews(this._review, this._agent, input.target)) {
				this._review.acceptAll(input.sessionId, review.turnId);
			}
		}
	}

	async undoAll(): Promise<void> {
		const input = this.input;
		if (!input) {
			return;
		}
		try {
			for (const review of claudeSessionReviews(this._review, this._agent, input.target).reverse()) {
				await this._review.rejectAll(input.sessionId, review.turnId);
			}
		} catch (error) {
			this.reportUndoError(error);
		}
	}

	/** The Keep button's scope: the one picked, else the shown turn, else the shown chat. */
	private keepReviewScope(): ReviewScope | undefined {
		const input = this.input;
		if (!input) {
			return undefined;
		}
		const kind = this._keepScope ?? (input.scope === 'turn' ? 'turn' : 'chat');
		if (kind === 'turn' && input.turnId) {
			return { kind: 'turn', sessionId: input.sessionId, turnId: input.turnId };
		}
		return kind === 'all' ? { kind: 'all' } : { kind: 'chat', sessionId: input.sessionId };
	}

	private renderKeep(): void {
		if (!this._keep) {
			return;
		}
		const scope = this.keepReviewScope();
		const summary = scope && this._review.pendingSummary(scope);
		const label = summary && summary.hunks > 0 ? claudeScopeActionLabel('keep', summary) : localize('claudeReviewKeepNothing', "Nothing to Keep");
		this._keep.label.textContent = label;
		this._keep.main.title = label;
		this._keep.main.setAttribute('aria-label', label);
		this._keep.main.disabled = !summary || summary.hunks === 0;
		this._keep.more.disabled = !scope;
	}

	private keepScope(): void {
		const scope = this.keepReviewScope();
		if (scope) {
			this._review.keepAllPending(scope);
		}
	}

	private toggleKeepMenu(anchor: HTMLElement): void {
		if (this._menu.isOpen) {
			this._menu.close();
			return;
		}
		const input = this.input;
		const scope = this.keepReviewScope();
		if (!input || !scope) {
			return;
		}
		const summary = this._review.pendingSummary(scope);
		const scopeRow = (kind: ReviewScope['kind'], label: string, disabled = false): ClaudePopoverEntry => ({
			id: `scope-${kind}`,
			label,
			role: 'menuitemradio',
			checked: scope.kind === kind,
			disabled,
			dataset: { scope: kind },
			run: () => {
				this._keepScope = kind;
				this.renderKeep();
			},
		});
		this._menu.show({
			anchor,
			label: localize('claudeReviewKeepOptions', "Keep Options"),
			className: 'claude-review-keep-menu',
			position: AnchorPosition.BELOW,
			alignment: AnchorAlignment.RIGHT,
			activeId: `scope-${scope.kind}`,
			entries: [
				{ kind: 'header', label: localize('claudeReviewKeepScope', "Keep and Undo Changes In") },
				scopeRow('turn', localize('claudeReviewKeepThisTurn', "This Turn"), !input.turnId),
				scopeRow('chat', localize('claudeReviewKeepThisChat', "This Chat")),
				scopeRow('all', localize('claudeReviewKeepEverything', "Everything")),
				{ kind: 'separator' },
				{ id: 'keep', label: summary.hunks > 0 ? claudeScopeActionLabel('keep', summary) : localize('claudeReviewKeepNothing', "Nothing to Keep"), icon: Codicon.check, disabled: summary.hunks === 0, run: () => this._review.keepAllPending(scope) },
				{ id: 'undo', label: summary.hunks > 0 ? claudeScopeActionLabel('undo', summary) : localize('claudeReviewUndoNothing', "Nothing to Undo"), icon: Codicon.discard, disabled: summary.hunks === 0, run: () => void claudeUndoAllPending(this._review, this._dialogs, this._notifications, this._labels, scope) },
			],
		});
	}

	private reportUndoError(error: unknown): void {
		this._notifications.error(error instanceof ReviewConflictError
			? localize('claudeReviewUndoConflict', "A file changed after Claude edited it, so Undo stopped. Open the file to resolve it.")
			: toErrorMessage(error));
	}

	private toggleReviewMenu(anchor: HTMLElement): void {
		if (this._menu.isOpen) {
			this._menu.close();
			return;
		}
		this._menu.show({
			anchor,
			label: localize('claudeReviewAskMenu', "Review Options"),
			className: 'claude-review-ask-menu',
			position: AnchorPosition.BELOW,
			alignment: AnchorAlignment.RIGHT,
			entries: [
				{ id: 'review', label: localize('claudeReviewAskChanges', "Review Changes"), icon: Codicon.commentDiscussion, hover: localize('claudeReviewAskChangesHover', "Claude reads the diff and points out bugs, risks and missing tests. It does not edit files."), run: () => this.review() },
				{ id: 'security', label: localize('claudeReviewAskSecurity', "Security Review"), icon: Codicon.shield, hover: localize('claudeReviewAskSecurityHover', "Claude looks for injection, unsafe input handling, leaked secrets and permission mistakes. It does not edit files."), run: () => this.askClaude('securityReviewChanges') },
			],
		});
	}

	private toggleMoreMenu(): void {
		if (this._menu.isOpen) {
			this._menu.close();
			return;
		}
		const empty = this.entries.length === 0;
		const nothing = this.findings.length === 0;
		const nothingToExport = localize('claudeReviewNothingToExport', "Nothing to export");
		const entries: ClaudePopoverEntry[] = [
			{ id: 'keepAll', label: localize('claudeReviewKeepAll', "Keep All"), icon: Codicon.check, disabled: empty, run: () => this.keepAll() },
			{ id: 'undoAll', label: localize('claudeReviewUndoAll', "Undo All"), icon: Codicon.discard, disabled: empty, run: () => this.undoAll() },
			{ kind: 'separator' },
			{ id: 'inline', label: localize('claudeReviewInline', "Inline View"), icon: Codicon.diffSingle, checked: this._viewMode === 'inline', run: () => this.setViewMode(this._viewMode === 'inline' ? 'sideBySide' : 'inline') },
			{ id: 'collapse', label: localize('claudeReviewCollapseAll', "Collapse All Files"), icon: Codicon.collapseAll, disabled: empty, run: () => this._viewModel?.collapseAll() },
			{ id: 'expand', label: localize('claudeReviewExpandAll', "Expand All Files"), icon: Codicon.expandAll, disabled: empty, run: () => this._viewModel?.expandAll() },
			{ kind: 'separator' },
			{ id: 'split', label: localize('claudeReviewSplitPullRequests', "Split into Pull Requests"), icon: Codicon.gitPullRequestCreate, run: () => this._commands.executeCommand(CLAUDE_SPLIT_PULL_REQUESTS_COMMAND_ID, this.input?.sessionId) },
			{ kind: 'separator' },
			{ id: 'exportMarkdown', label: localize('claudeReviewExportMarkdown', "Export Review as Markdown"), icon: Codicon.markdown, disabled: nothing, ...(nothing ? { description: nothingToExport } : {}), run: () => this.exportReview('markdown') },
			{ id: 'exportSarif', label: localize('claudeReviewExportSarif', "Export Review as SARIF 2.1"), icon: Codicon.json, disabled: nothing, description: nothing ? nothingToExport : localize('claudeReviewSarifHint', "A standard format for code scanning results; upload it to GitHub code scanning"), run: () => this.exportReview('sarif') },
			{ id: 'postReview', label: localize('claudeReviewPostComments', "Post as Review Comments"), icon: Codicon.gitPullRequest, run: () => this.postReview() },
			{ id: 'remember', label: localize('claudeReviewRememberRules', "Remember Rules from PR Comments"), icon: Codicon.book, run: () => this.rememberRules() },
			{ id: 'exportComment', label: localize('claudeReviewCopyPrComment', "Copy Review as PR Comment"), icon: Codicon.copy, disabled: nothing, ...(nothing ? { description: nothingToExport } : {}), run: () => this.exportReview('comment') },
			{ kind: 'separator' },
			{ id: 'chat', label: localize('claudeReviewOpenChat', "Open Chat"), icon: Codicon.commentDiscussion, run: () => this.openChat() },
		];
		this._menu.show({
			anchor: this._more,
			label: localize('claudeReviewMore', "More Review Actions"),
			className: 'claude-review-more-menu',
			position: AnchorPosition.BELOW,
			alignment: AnchorAlignment.RIGHT,
			entries,
		});
	}

	/**
	 * Export Review (issue 938): the findings that pass the filter as Markdown or SARIF 2.1 in a file the person picks,
	 * or as a PR comment on the clipboard. Secrets are removed from everything that leaves the editor (rule 40).
	 */
	async exportReview(format: 'markdown' | 'sarif' | 'comment'): Promise<void> {
		const input = this.input;
		if (!input) {
			return;
		}
		if (this.findings.length === 0) {
			this._notifications.info(localize('claudeReviewExportNothing', "Nothing to export: the review has no findings."));
			return;
		}
		const findings = this.findings.map(item => item.finding);
		const readiness = this._readiness.get(input.sessionId);
		const commitSha = await this.headCommit();
		const options = {
			summary: this._summaries.get(input.sessionId)?.summary,
			...(readiness ? { readinessScore: readiness.score, readinessReason: readiness.reason } : {}),
			...(commitSha ? { commitSha } : {}),
		};
		try {
			if (format === 'comment') {
				await this._clipboard.writeText(removeClaudeSecrets(formatClaudeReviewMarkdown(findings, this._filter, options)));
				this._notifications.info(localize('claudeReviewCommentCopied', "Copied the review as a pull request comment."));
				return;
			}
			const sarif = format === 'sarif';
			const folder = this._workspace.getWorkspace().folders[0]?.uri ?? await this._fileDialogs.defaultFilePath();
			const target = await this._fileDialogs.showSaveDialog({
				title: sarif ? localize('claudeReviewExportSarifTitle', "Export Review as SARIF 2.1") : localize('claudeReviewExportMarkdownTitle', "Export Review as Markdown"),
				defaultUri: joinPath(folder, sarif ? 'klawly-review.sarif' : 'klawly-review.md'),
				filters: sarif ? [{ name: 'SARIF', extensions: ['sarif', 'json'] }] : [{ name: 'Markdown', extensions: ['md'] }],
			});
			if (!target) {
				return;
			}
			const text = sarif ? formatClaudeReviewSarif(findings, this._filter, options) : formatClaudeReviewMarkdown(findings, this._filter, options);
			await this._files.writeFile(target, VSBuffer.fromString(removeClaudeSecrets(text)));
			this._notifications.info(localize('claudeReviewExported', "Exported the review to {0}.", this._labels.getUriLabel(target)));
		} catch (error) {
			this._notifications.error(localize('claudeReviewExportFailed', "Could not export the review: {0}", toErrorMessage(error)));
		}
	}

	/**
	 * Post as Review Comments (issue 872): the findings that pass the filter as one pull request review, the summary
	 * on top and one line comment per finding, with a suggestion block when it has a fix. It is posted with the
	 * person's own GitHub sign-in only after a dialog shows every comment; secrets are removed (rule 40).
	 */
	private async postReview(): Promise<void> {
		const input = this.input;
		if (!input) {
			return;
		}
		const findings = this.findings.map(item => item.finding);
		if (!filterClaudeReviewFindings(findings, this._filter).length) {
			this._notifications.info(localize('claudeReviewPostNothing', "There are no findings to post."));
			return;
		}
		const commitSha = await this.headCommit();
		await this._reviewBot.post(input.sessionId, formatClaudeGitHubReview(findings, this._filter, { summary: this._summaries.get(input.sessionId)?.summary, ...(commitSha ? { commitSha } : {}) }));
	}

	/** `@klawly remember <rule>` in the pull request's comments goes into REVIEW.md as a local edit (issue 872). */
	private async rememberRules(): Promise<void> {
		const input = this.input;
		if (input) {
			await this._reviewBot.rememberForSession(input.sessionId);
		}
	}

	private setViewMode(mode: DiffEditorViewMode): void {
		this._viewMode = mode;
		this._widget?.setDiffLayoutOptions(mode);
	}

	private async openChat(): Promise<void> {
		const input = this.input;
		if (input && this._agent.getCurrentSession()?.id !== input.sessionId) {
			this._agent.selectSession(input.sessionId);
		}
		await this._views.openView(CLAUDE_AGENT_VIEW_ID, true);
	}

	/** Opens `uri` in a normal editor at the first change the shown turns made to it (issue 354). */
	async openFile(uri: URI): Promise<void> {
		const input = this.input;
		const lines = input ? claudeSessionReviews(this._review, this._agent, input.target)
			.flatMap(review => review.files.filter(file => isEqual(file.uri, uri)))
			.flatMap(file => file.hunks.filter(hunk => hunk.state !== 'rejected').map(hunk => hunk.currentRange.startLineNumber)) : [];
		const line = lines.length > 0 ? Math.max(1, Math.min(...lines)) : undefined;
		await this.editorService.openEditor({
			resource: uri,
			options: {
				pinned: true,
				selection: line ? { startLineNumber: line, startColumn: 1 } : undefined,
				selectionRevealType: TextEditorSelectionRevealType.CenterIfOutsideViewport,
			} satisfies ITextEditorOptions,
		});
	}

	override getControl(): IDiffEditor | undefined {
		return this._widget?.getActiveControl();
	}

	protected override computeEditorViewState(): IMultiDiffEditorViewState | undefined {
		return this._viewModel ? this._widget?.getViewState() : undefined;
	}

	protected override tracksEditorViewState(input: EditorInput): boolean {
		return input instanceof ClaudeReviewInput;
	}

	protected override toEditorViewStateResource(input: EditorInput): URI | undefined {
		return input instanceof ClaudeReviewInput ? claudeReviewSourceUri(input.target) : undefined;
	}

	override clearInput(): void {
		const input = this.input;
		this._inputListener.clear();
		this._menu?.close();
		super.clearInput();
		this._viewModel = undefined;
		this._widget?.setViewModel(undefined);
		this._entries.set([], undefined);
		input?.clear();
	}

	override focus(): void {
		super.focus();
		if (!this._widget?.focus()) {
			this._reviewMain?.focus();
		}
	}

	override dispose(): void {
		this.cancelReview();
		super.dispose();
	}

	override layout(dimension: Dimension): void {
		this._dimension = dimension;
		this._widget?.layout(new Dimension(dimension.width, Math.max(0, dimension.height - HEADER_HEIGHT - (this._tray?.height ?? 0) - (this._summaryCard?.height ?? 0) - (this._evidenceCard?.height ?? 0) - (this._findingsBar?.height ?? 0) - (this._learnedOffer && !this._learnedOffer.hidden ? getTotalHeight(this._learnedOffer) : 0))));
	}
}

/** The word shown next to the readiness score (DL-11). */
function claudeReviewReadinessBandLabel(band: ClaudeReviewReadinessBand): string {
	switch (band) {
		case 'ready': return localize('claudeReviewReadinessReady', "Ready");
		case 'reviewNeeded': return localize('claudeReviewReadinessReviewNeeded', "Review needed");
		case 'notReady': return localize('claudeReviewReadinessNotReady', "Not ready");
	}
}
