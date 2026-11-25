/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, DisposableResizeObserver, EventType, getActiveElement, getWindow, isHTMLElement, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Schemas } from '../../../../../base/common/network.js';
import { isAbsolute } from '../../../../../base/common/path.js';
import { isLinux, language } from '../../../../../base/common/platform.js';
import { basename, dirname, isEqual, joinPath } from '../../../../../base/common/resources.js';
import { isHighSurrogate } from '../../../../../base/common/strings.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { TokenizationRegistry } from '../../../../../editor/common/languages.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { getIconClassesForLanguageId } from '../../../../../editor/common/services/getIconClasses.js';
import { IconLabel } from '../../../../../base/browser/ui/iconLabel/iconLabel.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IMarkdownRendererService, openLinkFromMarkdown } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { PlanArtifact, parsePlanArtifact } from '../../../../../platform/claude/common/claudePlan.js';
import { isPlanEdited, movePlanStep, planDetailSource, planStepSource, renamePlanStep } from '../../../../../platform/claude/common/claudePlanEdit.js';
import { planFileKey } from '../../../../../platform/claude/common/claudePlanDocument.js';
import { AgentViewState, describeActivity, describeFailure, ElicitationEntry, permissionsForTimeline, PermissionEntry, SubagentViewModel, TurnTextPart, TurnThinkingPart, TurnViewModel } from '../../../../services/claude/common/claudeAgentState.js';
import { ClaudePermissionCardChoice } from '../../../../services/claude/common/claudePermissionService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ClaudePermissionCards, isAutoApproved } from './claudePermissionCard.js';
import { ClaudeElicitationCards } from './claudeElicitationCard.js';
import { ClaudeQuestionCards } from './claudeQuestionCard.js';
import { ClaudeDiagramBlocks } from './claudeDiagramBlocks.js';
import { splitClaudeFoldedMarkdown } from '../../common/claudeFoldedMarkdown.js';
import { ClaudeGoalEnd } from '../../common/claudeGoalLoopService.js';
import { goalIcon, goalLimitSentence } from './claudeGoalLoopStrip.js';
import { ClaudeAccountEntry } from '../../../../../platform/claude/common/claudeAccounts.js';
import { claudeLimitBanner, claudeLimitPolicyLine, claudeLimitRetryOptions } from '../../common/claudeLimitBanner.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { CLAUDE_ACCOUNTS_LIMIT_OPTIONS_SETTING, CLAUDE_ACCOUNTS_ON_LIMIT_SETTING, readClaudeLimitOptions, readClaudeLimitPolicy, resolveClaudeLimitPolicy, ClaudeLimitPolicy } from '../../../../../platform/claude/common/claudeLimitPolicy.js';
import { CLAUDE_ACCOUNTS_DEFAULT_ACCOUNT_SETTING, readClaudeDefaultAccountId } from '../../../../../platform/claude/common/claudeChatAccount.js';
import { ClaudeElicitationAnswer } from '../../../../../platform/claude/common/claudeElicitation.js';
import { formatElapsed, ToolCardModel } from '../../../../services/claude/common/claudeToolCards.js';
import { ReviewFile, TurnReview } from '../../../../services/claude/common/claudeReview.js';
import { redactSecrets } from '../../../../services/claude/common/claudeAgentLog.js';
import { DiagnosticSummary, formatSentPrompt, SentChip, SentImage } from '../../../../../platform/claude/common/claudePrompt.js';
import { CLAUDE_CHAT_DRAG_MIME, encodeChatDrag } from '../../../../../platform/claude/common/claudeChatReference.js';
import { ClaudeGitHubReference } from '../../../../../platform/claude/common/claudeProtocol.js';
import { findFileReferences, parseWorkspacePath, SessionWorkFolders, sessionWorkFolders, WorkspacePathReference } from '../../common/claudeFileReferences.js';
import { inlineShellCommand, shellCommandFromBlock } from '../../common/claudeShellCommands.js';
import { tokenizeCodeLines } from '../../common/claudeCodeTokens.js';
import { claudeAutoPickHover, claudeAutoPickLabel } from '../../common/claudeModelControls.js';
import { ClaudeBuildButton, ClaudeBuildTarget } from '../plan/claudeBuildButton.js';
import { openClaudeCanvas } from '../claudeCanvasEditor.js';
import { CLAUDE_PLAN_EDITOR_ID, userPlansFolder } from '../plan/claudePlanCommands.js';
import { renderGitHubCard } from './claudeGitHubCard.js';
import { CLAUDE_STOP_TENDING_PR_COMMAND_ID, CLAUDE_TEND_PR_COMMAND_ID, ClaudeTendEnd, IClaudeTendPullRequestService } from './claudeTendPullRequest.js';
import { claudeFallbackSentence } from '../../../../services/claude/common/claudeDelegationModel.js';
import { ClaudeDelegateCardActions, renderClaudeDelegateCard } from './claudeDelegateCard.js';
import { IClaudeGitHubDetailsService } from './claudeGitHubDetails.js';
import { IClaudeCheckInvestigationService } from './claudeCheckInvestigation.js';
import { IClaudeReviewerSuggestionService } from './claudeReviewerSuggestions.js';
import { describePlanSize, describeQuiet, describeSubagentMeta, describeThinking, describeWork, inlineMarkdownRuns, matchesCardFile, showsProgress, splitPath, TimelineBlock, timelineBlocks, turnWork, turnWroteFiles, workspaceRelativeFolder, workspaceRelativePath } from '../../common/claudeTimelineModel.js';
import { ClaudeReviewCardController, renderClaudeChangesCard } from '../review/claudeChangesCard.js';
import { claudeFailureOffersStatus } from '../../common/claudeRuntimeStatus.js';
import { ClaudeMcpAppChat, ClaudeMcpAppView } from './claudeMcpAppView.js';
import { ClaudeCommandScroll, ClaudeToolCardActions, ClaudeToolCardView, ClaudeToolReproductions, ClaudeToolTerminalRuns, reviewSignature } from './claudeToolCardView.js';
import { appendClaudeImageThumb, ClaudeImageThumbnails } from './claudeImageThumbnails.js';
import { claudeImageLabel, SentImageIndex } from '../../common/claudeImageAttachments.js';
import { encodeBase64 } from '../../../../../base/common/buffer.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { claudeDepartmentCardOf, claudeDepartmentSenderOf } from '../../common/claudeDepartmentCard.js';
import { renderClaudeDepartmentCard } from './claudeDepartmentCardView.js';
import { claudeSubagentKindLabel, describeStillRunning, isBackgroundCommand } from '../../common/claudeCommandMirror.js';

/** SVG files above this size show no image card (issue 494). */
const MAX_SVG_PREVIEW_BYTES = 2 * 1024 * 1024;
/** Lines a sent prompt shows before it folds under a fade. */
const PROMPT_CLAMP_LINES = 4;
/** Streamed text that has arrived shows within about this many frames (DL-80). */
const REVEAL_FRAMES = 20;
/** The slowest a reveal goes, in characters per frame. */
const REVEAL_MIN_STEP = 2;
/** A Markdown link to a workspace path; only this renderer's link handler reads it. */
const PATH_LINK = `${Schemas.internal}:claude-path?`;
/** How long a path that was not found stays unlinked before it is looked up again. */
const MISSING_PATH_TTL = 5_000;
/** How many folders of the session's files are searched for their repository root. */
const MAX_WORK_FOLDERS = 20;
/** How far up from a file's folder the search for `.git` goes. */
const MAX_ROOT_DEPTH = 32;
/** A `.git` file holds one `gitdir:` line; more than this is not one. */
const MAX_GIT_FILE_BYTES = 4096;

interface ResolvedPath {
	readonly resource: URI;
	readonly isDirectory: boolean;
}

/** A repository found above a file the session touched. */
interface RepoRoot {
	readonly resource: URI;
	/** Whether it is a linked git worktree: its `.git` is a file that points into a repository's `worktrees` folder. */
	readonly worktree: boolean;
}

interface PathLookup {
	readonly result: Promise<ResolvedPath | undefined>;
	readonly time: number;
	found?: boolean;
}

/**
 * One keyed block of a painted turn. Its element stays in the DOM while its
 * dependencies are unchanged, so a finished part is never rebuilt.
 */
class TimelineBlockView implements IDisposable {
	readonly store = new DisposableStore();
	deps: readonly unknown[] = [];
	tool: ClaudeToolCardView | undefined;
	/** Shows Stop or Restore Checkpoint on a prompt bubble without rebuilding it. */
	setRunning: ((running: boolean, restorable: boolean) => void) | undefined;

	constructor(readonly key: string, readonly element: HTMLElement) { }

	clear(): void {
		this.store.clear();
		this.tool = undefined;
		this.setRunning = undefined;
		clearNode(this.element);
	}

	dispose(): void {
		this.store.dispose();
		this.element.remove();
	}
}

interface BlockSpec {
	readonly key: string;
	readonly deps: readonly unknown[];
	/** A one-line row (a tool call, a read group, thinking). Rows next to each other sit without the turn's gap. */
	readonly row?: boolean;
	render(view: TimelineBlockView): void;
	/** Patches the block in place. `before` holds the old dependencies. Returns false to rebuild it instead. */
	update?(view: TimelineBlockView, before: readonly unknown[]): boolean;
}

interface TurnEntry {
	turn: TurnViewModel;
	isLast: boolean;
	/** Every subagent whose change should repaint this turn, including nested runs. */
	watched: readonly SubagentViewModel[];
	problems?: readonly DiagnosticSummary[];
	reviewKey: string;
	readonly element: HTMLElement;
	readonly blocks: DisposableMap<string, TimelineBlockView>;
}

export interface ClaudeTimelineCallbacks {
	retry(): void;
	/** The limit banner's account choices (issue 1385): the signed-in accounts, the account this chat runs under, and the policy it set. */
	readonly limitChoices?: {
		accounts(): Promise<readonly ClaudeAccountEntry[]>;
		currentAccountId(): string | undefined;
		chatPolicy(): ClaudeLimitPolicy | undefined;
		/** Keeps `policy` for this chat and retries, under `accountId` when given. */
		retryWith(accountId: string | undefined, policy: ClaudeLimitPolicy): void;
	};
	/** The turn Stop took back and whose prompt is back in the composer: its partial output is greyed until the edited prompt is sent (issue 1178). */
	pendingEdit?(turnId: string): boolean;
	/** Continue on a turn that stopped at its step limit: the same Claude conversation goes on (issues 696, 707). */
	continueTurn?(): void;
	/**
	 * Build the plan shown on `turnId`. `plan` is set when the user edited or
	 * reordered its steps on the card. Rejects when the build cannot start.
	 */
	build(turnId: string, notes: string, plan?: PlanArtifact): Promise<void>;
	/** Build in Background Worktree on the plan card. Same arguments as {@link build}. */
	buildInBackground?(turnId: string, notes: string, plan?: PlanArtifact): Promise<void>;
	/** Open Plan on the plan card: writes the plan as a file and opens it in the plan editor. `plan` is the plan as the card shows it. */
	openPlan?(turnId: string, notes: string, plan: PlanArtifact): Promise<void>;
	/** Open Claude Status on a failure banner whose cause the status menu can explain. */
	openStatus?(): void;
	/** The goal that ended in this chat (met, turn or spend limit), kept after the tab pill clears (issue 1102). */
	goalEnded?(): ClaudeGoalEnd | undefined;
	/** Start Goal Again on the chat notice: the same goal, the same folder. */
	restartGoal?(): void;
	/** Edit Goal... on the chat notice: the composer opens on /goal with the ended goal filled in (issue 1117). */
	editGoal?(): void;
	/** Change Spend Limit on the spend-limit notice: opens the setting. */
	openGoalSpendSetting?(): void;
	openGoalTurnsSetting?(): void;
	/** Dismiss on the chat notice: forgets the ended goal. */
	dismissGoalEnded?(): void;
	/** Sends the user's answer to a pending permission card. Rejects when the request has ended. */
	respondPermission(requestId: string, choice: ClaudePermissionCardChoice): Promise<void>;
	/** Sends the user's answer to a pending MCP form or sign-in (issue 428). Rejects when the request has ended. */
	respondElicitation?(id: string, answer: ClaudeElicitationAnswer): Promise<void>;
	/** Switch to Agent and Retry on a write the Plan or Ask mode blocked in `turnId`. */
	switchToAgentAndRetry?(turnId: string): Promise<void>;
	openSubagent(runId: string): void;
	stopSubagent(runId: string): void;
	/** Open Chat, Stop and Rerun on a delegated chat's card (issue 693). */
	readonly delegate?: ClaudeDelegateCardActions;
	copyCommand(command: string): void;
	openInTerminal(cwd: string | undefined): void;
	rerunCommand(command: string, cwd: string | undefined): void;
	openCommandLog(): void;
	/** The folder the session runs in when it is not the workspace folder, such as a background worktree. */
	workingDirectory?(): string | undefined;
	review?: ClaudeReviewCardController;
	/** The turn whose changes the bar above the composer shows; its card stays out of the timeline. */
	dockedReview?(): string | undefined;
	problems?: {
		get(turnId: string): readonly DiagnosticSummary[] | undefined;
		fix(turnId: string): void;
	};
	fixCommandError?(card: ToolCardModel): void;
	/** Interactive commands of this chat that wait for the user in a terminal. */
	readonly terminalRuns?: ClaudeToolTerminalRuns;
	/** Debug mode's reproductions of this chat that wait for the user (issue 484). */
	readonly reproductions?: ClaudeToolReproductions;
	/** Stop on the running prompt. */
	stop?(): void;
	/** Fork from Here on a finished answer: a new chat with the turns up to `turnId`. */
	forkFrom?(turnId: string): void;
	/** Restore Checkpoint on a finished prompt: puts the files `turnId` changed back as they were before it. */
	restoreCheckpoint?(turnId: string): void;
	/** Edit on a prompt: puts it in the composer, and sending goes back to it first (issue 702). */
	editPrompt?(turnId: string): void;
	/** Whether Edit can go back to `turnId`, and if not, why. Asked when the pointer or focus reaches the prompt. */
	canEditPrompt?(turnId: string): { readonly enabled: boolean; readonly reason?: string };
	/** The running session and composer the MCP Apps under MCP tool cards use (issue 513). */
	readonly mcpApps?: ClaudeMcpAppChat;
}

/**
 * Paints the reducer's view state into the timeline. Each turn is a list of
 * keyed blocks in event order: text segments, tool cards, subagents,
 * permissions and the plan. Streaming re-renders the open text segment only;
 * a card patches in place when it changes. Markdown goes through the
 * workbench renderer and sanitizer.
 */
export class ClaudeTimelineRenderer extends Disposable {
	private readonly _entries = new Map<string, TurnEntry>();
	private readonly _hiddenFailures = new Set<string>();
	/** Turns waiting for their limit to reset, each retrying at the reset time (issue 1182). */
	private readonly _resumeAtReset = this._register(new DisposableMap<string>());
	/** Notes typed on a plan card. Kept here so a repaint does not lose them. */
	private readonly _planNotes = new Map<string, string>();
	/** Plans the user edited or reordered on the card, by turn. A repaint keeps them. */
	private readonly _planEdits = new Map<string, PlanArtifact>();
	/** Turns whose plan card is in edit mode. */
	private readonly _planEditing = new Set<string>();
	/** Controls of the plan card being edited, by step id, so focus can follow a moved step. */
	private readonly _planControls = new Map<string, { readonly input: HTMLInputElement; readonly up: HTMLButtonElement; readonly down: HTMLButtonElement }>();
	private _planEditButton: HTMLButtonElement | undefined;
	/** Turns whose plan card the user showed in full again while its file is open in an editor. */
	private readonly _planShown = new Set<string>();
	/** The plan card's last rendered Show the Plan in the Chat or Collapse the Plan button, so focus can follow a toggle. */
	private _planToggle: HTMLButtonElement | undefined;
	/** Permission cards that already took focus once. A repaint must not take it again. */
	private readonly _focusedPermissions = new Set<string>();
	/** Open tool cards. Until the user toggles one, it follows its default: only a running command is open. */
	private readonly _openCards = new Set<string>();
	/** Folded sections in replies the user opened or closed, so a repaint keeps them that way (issue 462). */
	private readonly _folds = new Map<string, boolean>();
	/** Prompts the user expanded past the clamp. */
	private readonly _userExpanded = new Set<string>();
	/** Finished turns the user opened or folded. Without a choice only the newest turn is open. */
	private readonly _workOpen = new Map<string, boolean>();
	/** Turns whose sent prompt is expanded. Kept here so a repaint does not close it. */
	private readonly _sentOpen = new Set<string>();
	/** The Show Sent Prompt toggle and its text, per painted turn. */
	private readonly _sentNodes = new Map<string, { readonly toggle: HTMLElement; readonly detail: HTMLElement }>();
	private _dragSessionId: string | undefined;
	/** Tool cards the user opened or closed. They keep that choice. */
	private readonly _toggledCards = new Set<string>();
	/** Command preview scroll, so a repaint does not jump back to the first line. */
	private readonly _commandScroll = new Map<string, ClaudeCommandScroll>();
	/** Paths named in replies, looked up once each; a miss is looked up again after {@link MISSING_PATH_TTL}. */
	private readonly _resolvedPaths = new Map<string, PathLookup>();
	/** Folders the session changed or read files in ({@link sessionWorkFolders}). Reply paths are looked up in their repositories first. */
	private _workFolders: SessionWorkFolders = { changed: [], read: [] };
	private _workState: AgentViewState | undefined;
	private _workKey = '';
	/** The repository root above each folder the session worked in. */
	private readonly _repoRoots = new Map<string, Promise<RepoRoot | undefined>>();
	private readonly _elapsedNodes = new Map<string, { readonly node: HTMLElement; readonly startedAt: number; readonly endedAt?: number; readonly toolCount: number }>();
	/** When each run's tool count or latest step last changed, so a running row can say how long it has been silent (issue 1258). */
	private readonly _lastOutput = new Map<string, { readonly signature: string; readonly at: number }>();
	private _elapsedHandle: number | undefined;
	/** How much of each streaming text part shows, by turn and block key (DL-80, issue 740). */
	private readonly _reveal = new Map<string, { readonly turnId: string; shown: number; target: number }>();
	private readonly _revealFrame = this._register(new MutableDisposable());
	private _subagents: readonly SubagentViewModel[] = [];
	/** Painted subagent cards by run id, for Go to Turn and the chat outline (issue 433). */
	private readonly _subagentCards = new Map<string, HTMLElement>();
	private _subagentId: string | undefined;
	private _showingSubagent = false;
	/** Permission cards and records (Phase 27, `claudePermissionCard.ts`). */
	private readonly _permissionCards: ClaudePermissionCards;
	private _elicitationCards: ClaudeElicitationCards | undefined;
	private _questionCards: ClaudeQuestionCards | undefined;
	private readonly _toolActions: ClaudeToolCardActions;
	/** Images people sent in this chat, so Claude's Read of one folds into "Viewed attached image" (issue 744). */
	private readonly _sentImages = new SentImageIndex();
	private readonly _thumbnails: ClaudeImageThumbnails;
	/** Mermaid diagrams and charts in replies (issue 492). */
	private readonly _diagrams: ClaudeDiagramBlocks;

	constructor(
		private readonly _root: HTMLElement,
		private readonly _callbacks: ClaudeTimelineCallbacks,
		@IMarkdownRendererService private readonly _markdown: IMarkdownRendererService,
		@IClipboardService private readonly _clipboard: IClipboardService,
		@ICodeEditorService private readonly _codeEditors: ICodeEditorService,
		@IEditorService private readonly _editors: IEditorService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IFileService private readonly _files: IFileService,
		@INotificationService private readonly _notifications: INotificationService,
		@IInstantiationService private readonly _instantiation: IInstantiationService,
		@ICommandService private readonly _commands: ICommandService,
		@IOpenerService private readonly _opener: IOpenerService,
		@ILanguageService private readonly _languages: ILanguageService,
		@IPathService private readonly _paths: IPathService,
		@IProductService private readonly _product: IProductService,
		@IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
		@IClaudeGitHubDetailsService private readonly _gitHubDetails: IClaudeGitHubDetailsService,
		@IHoverService private readonly _hover: IHoverService,
		@IClaudeCheckInvestigationService private readonly _checkInvestigation: IClaudeCheckInvestigationService,
		@IClaudeReviewerSuggestionService private readonly _reviewerSuggestions: IClaudeReviewerSuggestionService,
		@IClaudeTendPullRequestService private readonly _tend: IClaudeTendPullRequestService,
		@IFileDialogService private readonly _fileDialogs: IFileDialogService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
	) {
		super();
		this._register(_workspace.onDidChangeWorkspaceFolders(() => {
			this._resolvedPaths.clear();
			this._repoRoots.clear();
		}));
		this._register(_editors.onDidEditorsChange(() => this.repaintPlans()));
		this._register(_tend.onDidChange(e => {
			if (e.sessionId === this._dragSessionId && this._entries.size) {
				this.renderTendNotice();
			}
		}));
		this._permissionCards = _instantiation.createInstance(ClaudePermissionCards);
		this._diagrams = _instantiation.createInstance(ClaudeDiagramBlocks);
		this._thumbnails = this._register(_instantiation.createInstance(ClaudeImageThumbnails));
		const mcpApps = _callbacks.mcpApps;
		this._toolActions = {
			toggle: cardId => this.toggleCard(cardId),
			displayPath: path => this.displayPath(path),
			openFile: (path, line) => this.openPath(path, line),
			attachedImage: path => this._sentImages.labelFor(path),
			copyCommand: command => this._callbacks.copyCommand(command),
			rerunCommand: (command, cwd) => this._callbacks.rerunCommand(command, cwd),
			openCommandLog: () => this._callbacks.openCommandLog(),
			openInTerminal: cwd => this._callbacks.openInTerminal(cwd),
			fixCommandError: this._callbacks.fixCommandError ? card => this._callbacks.fixCommandError?.(card) : undefined,
			keepFile: (turnId, uri) => this._callbacks.review?.acceptFile(turnId, uri),
			undoFile: (turnId, uri) => this._callbacks.review?.rejectFile(turnId, uri),
			openDiff: (turnId, uri, conflict) => conflict ? this._callbacks.review?.resolve(turnId, uri) : this._callbacks.review?.openFile(turnId, uri),
			commandScroll: this._commandScroll,
			terminalRuns: this._callbacks.terminalRuns,
			reproductions: this._callbacks.reproductions,
			previewImage: path => this.svgDataUri(path),
			saveImageAs: path => void this.saveImageAs(path),
			openCanvas: (path, title) => void openClaudeCanvas(this._editors, URI.file(path), title, false),
			mountMcpApp: mcpApps ? (container, card) => _instantiation.createInstance(ClaudeMcpAppView, container, card, mcpApps) : undefined,
		};
	}

	/** An SVG file as a data URI for an image card (issue 494); larger files show no preview. */
	private async svgDataUri(path: string): Promise<string | undefined> {
		if (!isAbsolute(path)) {
			return undefined;
		}
		try {
			const stat = await this._files.stat(URI.file(path));
			if (stat.size > MAX_SVG_PREVIEW_BYTES) {
				return undefined;
			}
			const content = await this._files.readFile(URI.file(path));
			return `data:image/svg+xml;base64,${encodeBase64(content.value)}`;
		} catch {
			return undefined;
		}
	}

	private async saveImageAs(path: string): Promise<void> {
		const source = URI.file(path);
		const folder = this._workspace.getWorkspace().folders[0]?.uri ?? await this._fileDialogs.defaultFilePath();
		const target = await this._fileDialogs.showSaveDialog({
			title: localize('claudeSaveImageTitle', "Save Image"),
			defaultUri: joinPath(folder, basename(source)),
			filters: [{ name: localize('claudeSvgFilter', "SVG Image"), extensions: ['svg'] }],
		});
		if (!target) {
			return;
		}
		try {
			await this._files.copy(source, target, true);
		} catch (error) {
			this._notifications.error(error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * Expands the sent prompt of `turnId`, scrolls it into view and focuses its
	 * toggle. Returns false when that turn is not painted or has no sent prompt.
	 */
	revealSentPrompt(turnId: string): boolean {
		const entry = this._entries.get(turnId);
		if (!entry?.turn.user.sent) {
			return false;
		}
		this._sentOpen.add(turnId);
		this.paintTurn(entry);
		const nodes = this._sentNodes.get(turnId);
		nodes?.detail.scrollIntoView({ block: 'nearest' });
		nodes?.toggle.focus();
		return true;
	}

	/**
	 * Scrolls the card of a pull request or issue into view and focuses it (the
	 * session's pull request pill, issue 430). When no painted turn shows the
	 * card, opens it on GitHub instead.
	 */
	showGitHubReference(reference: ClaudeGitHubReference): void {
		for (const entry of this._entries.values()) {
			// The block's element holds the card alone (renderGitHubCard).
			const card = entry.blocks.get(`github:${reference.url}`)?.element.firstElementChild;
			if (isHTMLElement(card)) {
				card.scrollIntoView({ block: 'nearest' });
				card.focus();
				return;
			}
		}
		void this._gitHubDetails.open(reference);
	}

	/**
	 * Scrolls a turn, or a tool card or subagent card inside it, to the top of
	 * the timeline (chat outline and Go to Turn, issue 433). False when the turn
	 * is not painted.
	 */
	revealTurn(turnId: string, targetId?: string): boolean {
		const entry = this._entries.get(turnId);
		if (!entry) {
			return false;
		}
		let target = targetId === undefined ? undefined : entry.blocks.get(`tool:${targetId}`)?.element;
		// A nested subagent is not painted in the turn: its outermost painted parent stands for it.
		for (let runId = target ? undefined : targetId; runId !== undefined && !target; runId = this._subagents.find(subagent => subagent.run.id === runId)?.run.parentRunId) {
			target = this._subagentCards.get(runId);
		}
		(target ?? entry.element).scrollIntoView({ block: 'start' });
		return true;
	}

	/**
	 * Unfolds the finished work of the turn a node sits in, so a find match inside it can be seen
	 * (issue 890). The folded blocks stay in the page, only hidden.
	 */
	openWorkContaining(node: Node): void {
		for (const entry of this._entries.values()) {
			if (!entry.element.contains(node)) {
				continue;
			}
			for (let element = node.parentElement; element && element !== entry.element; element = element.parentElement) {
				if (element.hidden) {
					this._workOpen.set(entry.turn.id, true);
					this.paintTurn(entry);
					return;
				}
			}
			return;
		}
	}

	setDragSession(sessionId: string | undefined): void {
		this._dragSessionId = sessionId;
	}

	private turnIndex(turnId: string): number {
		const index = [...this._entries.keys()].indexOf(turnId);
		return index < 0 ? 1 : index + 1;
	}

	/** Returns false when there are no turns, so the caller can show its empty state. */
	private readonly _goalNotice = this._register(new MutableDisposable<DisposableStore>());
	private _goalNoticeElement: HTMLElement | undefined;
	private _goalNoticeKey = '';
	private readonly _tendNotice = this._register(new MutableDisposable<DisposableStore>());
	private _tendNoticeElement: HTMLElement | undefined;
	private _tendNoticeEnd: ClaudeTendEnd | undefined;
	private readonly _dismissedTendEnds = new WeakSet<ClaudeTendEnd>();

	render(state: AgentViewState, subagentId?: string): boolean {
		this._subagents = state.subagents;
		this._subagentId = subagentId;
		this.updateWorkFolders(state);
		const showing = subagentId !== undefined;
		if (showing !== this._showingSubagent) {
			this.reset();
			this._showingSubagent = showing;
		}
		if (subagentId) {
			const subagent = state.subagents.find(candidate => candidate.run.id === subagentId);
			if (!subagent) {
				this.reset();
				return false;
			}
			return this.renderSingle(subagent.chat, descendantsOfRun(subagentId, state.subagents));
		}
		if (state.turns.length === 0) {
			this.reset();
			return false;
		}
		const live = new Set(state.turns.map(turn => turn.id));
		for (const [id, entry] of this._entries) {
			if (!live.has(id)) {
				this.removeEntry(id, entry);
			}
		}
		if (this._entries.size === 0) {
			clearNode(this._root);
		}
		const lastId = state.turns[state.turns.length - 1].id;
		for (const turn of state.turns) {
			const isLast = turn.id === lastId;
			const existing = this._entries.get(turn.id);
			const watched = state.subagents.filter(subagent => subagent.parentTurnId === turn.id);
			const problems = this._callbacks.problems?.get(turn.id);
			const reviewKey = this.reviewKey(turn.id);
			if (!existing) {
				const entry = this.createEntry(turn, isLast, watched, problems, reviewKey);
				this.paintTurn(entry);
			} else if (existing.turn !== turn || existing.isLast !== isLast || !sameList(existing.watched, watched) || existing.problems !== problems || existing.reviewKey !== reviewKey) {
				existing.turn = turn;
				existing.isLast = isLast;
				existing.watched = watched;
				existing.problems = problems;
				existing.reviewKey = reviewKey;
				this.paintTurn(existing);
			}
		}
		const running = state.turns[state.turns.length - 1].status === 'running';
		// Screen readers announce the finished answer once instead of every token.
		this._root.setAttribute('aria-busy', running ? 'true' : 'false');
		this.renderGoalNotice(lastId);
		this.renderTendNotice();
		return true;
	}

	/**
	 * A goal that ended leaves a lasting note at the end of the chat, under the turn it ended
	 * on, with Start Goal Again; it stays until the user dismisses it or sends a message, which starts a new turn (issues 1102, 1117, DL-50).
	 */
	private renderGoalNotice(lastId: string): void {
		const ended = this._callbacks.goalEnded?.();
		if (!ended || ended.afterTurnId !== lastId) {
			this._goalNotice.clear();
			this._goalNoticeElement?.remove();
			this._goalNoticeElement = undefined;
			this._goalNoticeKey = '';
			return;
		}
		const key = `${lastId}:${ended.at}`;
		if (this._goalNoticeElement && this._goalNoticeElement.parentElement === this._root && this._goalNoticeKey === key) {
			if (this._root.lastElementChild !== this._goalNoticeElement) {
				this._root.appendChild(this._goalNoticeElement);
			}
			return;
		}
		this._goalNoticeElement?.remove();
		const store = new DisposableStore();
		this._goalNotice.value = store;
		const line = append(this._root, $('.claude-activity.is-goal-ended'));
		line.setAttribute('role', 'status');
		line.setAttribute('aria-live', 'polite');
		append(line, $(ThemeIcon.asCSSSelector(goalIcon(ended.view)))).setAttribute('aria-hidden', 'true');
		const time = new Date(ended.at).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' });
		const label = ended.view.status === 'met'
			? localize('claudeGoalEndedMet', "Goal met at {0}: {1}", time, ended.view.goal.outcome)
			: goalLimitSentence(ended.view, time);
		append(line, $('span.text')).textContent = label;
		const spendSetting = this._callbacks.openGoalSpendSetting;
		if (ended.view.status === 'limit' && ended.view.reason === 'budget' && spendSetting) {
			const link = append(line, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
			link.type = 'button';
			link.textContent = localize('claudeGoalChangeSpendLimit', "Change Spend Limit");
			store.add(addDisposableListener(link, EventType.CLICK, () => spendSetting()));
		}
		const turnsSetting = this._callbacks.openGoalTurnsSetting;
		if (ended.view.status === 'limit' && ended.view.reason === 'max-turns' && turnsSetting) {
			const link = append(line, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
			link.type = 'button';
			link.textContent = localize('claudeGoalChangeTurnLimit', "Change Turn Limit");
			store.add(addDisposableListener(link, EventType.CLICK, () => turnsSetting()));
		}
		const edit = this._callbacks.editGoal;
		if (edit && ended.view.status === 'limit') {
			const button = append(line, $<HTMLButtonElement>('button.claude-btn.is-small'));
			button.type = 'button';
			button.textContent = localize('claudeGoalEditAgain', "Edit Goal...");
			store.add(addDisposableListener(button, EventType.CLICK, () => edit()));
		}
		const restart = this._callbacks.restartGoal;
		if (restart) {
			const button = append(line, $<HTMLButtonElement>('button.claude-btn.is-small.is-primary'));
			button.type = 'button';
			button.textContent = localize('claudeGoalStartAgain', "Start Goal Again");
			store.add(addDisposableListener(button, EventType.CLICK, () => restart()));
		}
		const dismiss = this._callbacks.dismissGoalEnded;
		if (dismiss) {
			const button = append(line, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
			button.type = 'button';
			button.textContent = localize('claudeGoalNoticeDismiss', "Dismiss");
			store.add(addDisposableListener(button, EventType.CLICK, () => {
				dismiss();
				this._goalNotice.clear();
				line.remove();
				this._goalNoticeElement = undefined;
				this._goalNoticeKey = '';
			}));
		}
		this._goalNoticeElement = line;
		this._goalNoticeKey = key;
	}

	/** DL-67 (issue 1194): a Tend This PR run that ended leaves a quiet line at the end of the chat saying why, with Tend Again when tending can go on. */
	private renderTendNotice(): void {
		const sessionId = this._dragSessionId;
		const end = sessionId && !this._tend.isTending(sessionId) ? this._tend.lastEnd(sessionId) : undefined;
		if (!end || this._dismissedTendEnds.has(end)) {
			this._tendNotice.clear();
			this._tendNoticeElement?.remove();
			this._tendNoticeElement = undefined;
			this._tendNoticeEnd = undefined;
			return;
		}
		if (this._tendNoticeElement && this._tendNoticeElement.parentElement === this._root && this._tendNoticeEnd === end) {
			if (this._root.lastElementChild !== this._tendNoticeElement) {
				this._root.appendChild(this._tendNoticeElement);
			}
			return;
		}
		this._tendNoticeElement?.remove();
		const store = new DisposableStore();
		this._tendNotice.value = store;
		const line = append(this._root, $('.claude-activity.is-tend-ended'));
		line.setAttribute('role', 'status');
		line.setAttribute('aria-live', 'polite');
		append(line, $(ThemeIcon.asCSSSelector(tendEndIcon(end)))).setAttribute('aria-hidden', 'true');
		append(line, $('span.text')).textContent = end.message;
		if (end.reason === 'turnCap' || end.reason === 'stopped' || end.reason === 'ghProblem') {
			const again = append(line, $<HTMLButtonElement>('button.claude-btn.is-small.is-primary'));
			again.type = 'button';
			again.textContent = localize('claudeTendAgain', "Tend Again");
			store.add(addDisposableListener(again, EventType.CLICK, () => void this._commands.executeCommand(CLAUDE_TEND_PR_COMMAND_ID)));
		}
		const dismiss = append(line, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
		dismiss.type = 'button';
		dismiss.textContent = localize('claudeTendNoticeDismiss', "Dismiss");
		store.add(addDisposableListener(dismiss, EventType.CLICK, () => {
			this._dismissedTendEnds.add(end);
			this.renderTendNotice();
		}));
		this._tendNoticeElement = line;
		this._tendNoticeEnd = end;
	}

	private renderSingle(turn: TurnViewModel, watched: readonly SubagentViewModel[]): boolean {
		const existing = this._entries.get(turn.id);
		const problems = this._callbacks.problems?.get(turn.id);
		if (!existing) {
			clearNode(this._root);
			this.paintTurn(this.createEntry(turn, true, watched, problems, ''));
		} else if (existing.turn !== turn || !sameList(existing.watched, watched) || existing.problems !== problems) {
			existing.turn = turn;
			existing.watched = watched;
			existing.problems = problems;
			this.paintTurn(existing);
		}
		this._root.setAttribute('aria-busy', turn.status === 'running' ? 'true' : 'false');
		return true;
	}

	private createEntry(turn: TurnViewModel, isLast: boolean, watched: readonly SubagentViewModel[], problems: readonly DiagnosticSummary[] | undefined, reviewKey: string): TurnEntry {
		const element = append(this._root, $('.claude-turn'));
		element.setAttribute('data-turn-id', turn.id);
		const entry: TurnEntry = { turn, isLast, watched, problems, reviewKey, element, blocks: new DisposableMap<string, TimelineBlockView>() };
		this._entries.set(turn.id, entry);
		return entry;
	}

	/** Changes when the review of `turnId` changes. Reviews are updated in place, so identity is not enough. */
	private reviewKey(turnId: string): string {
		if (this._callbacks.dockedReview?.() === turnId) {
			return 'docked';
		}
		const review = this._callbacks.review?.get(turnId);
		return review ? review.files.map(file => reviewSignature(file)).join('\n') : '';
	}

	/**
	 * Forgets per-turn state kept across repaints (plan edits and notes, an open
	 * sent prompt, a dismissed failure) for turns not in `liveTurnIds`, such as
	 * the turns of a closed session.
	 */
	retainTurns(liveTurnIds: ReadonlySet<string>): void {
		for (const kept of [this._planEdits, this._planEditing, this._planNotes, this._planShown, this._sentOpen, this._hiddenFailures, this._userExpanded, this._workOpen]) {
			for (const turnId of [...kept.keys()]) {
				if (!liveTurnIds.has(turnId)) {
					kept.delete(turnId);
				}
			}
		}
	}

	reset(): void {
		for (const [id, entry] of this._entries) {
			this.removeEntry(id, entry);
		}
		this._openCards.clear();
		this._folds.clear();
		this._toggledCards.clear();
		this._commandScroll.clear();
		this._elapsedNodes.clear();
		this._lastOutput.clear();
		this._reveal.clear();
		this._revealFrame.clear();
		this._sentImages.clear();
		this._goalNotice.clear();
		this._goalNoticeElement = undefined;
		this._goalNoticeKey = '';
		this._tendNotice.clear();
		this._tendNoticeElement = undefined;
		this._tendNoticeEnd = undefined;
		this._root.setAttribute('aria-busy', 'false');
	}

	override dispose(): void {
		this.stopElapsedTimer();
		this.reset();
		super.dispose();
	}

	private removeEntry(id: string, entry: TurnEntry): void {
		for (const permission of entry.turn.permissions) {
			this._focusedPermissions.delete(permission.id);
		}
		entry.blocks.dispose();
		entry.element.remove();
		this._entries.delete(id);
		this._sentNodes.delete(id);
	}

	/**
	 * Brings one turn's blocks up to date. A block whose dependencies did not
	 * change keeps its DOM node; a changed one is patched or rebuilt in place;
	 * blocks move only when their order changes.
	 */
	private paintTurn(entry: TurnEntry): void {
		const { turn, isLast } = entry;
		const painted = entry.blocks.size > 0;
		entry.element.classList.toggle('is-last', isLast);
		entry.element.classList.toggle('is-pending-edit', !!this._callbacks.pendingEdit?.(turn.id));
		const blocks = timelineBlocks(turn, this._subagents, this._subagentId);
		const specs: BlockSpec[] = [this.userSpec(turn, isLast)];
		if (turn.steered.length > 0) {
			specs.push({ key: 'steered', deps: [turn.steered], render: view => this.renderSteered(view.element, turn.steered) });
		}
		const { work, answer } = turnWork(turn, blocks);
		const workOpen = this._workOpen.get(turn.id) ?? isLast;
		if (work.length > 0) {
			const label = describeWork(turn, work.length);
			specs.push({ key: 'work', deps: [label, workOpen], render: view => this.renderWorkToggle(view.element, entry, label, workOpen, view.store) });
		}
		let pending: { readonly id: string; focus(): void } | undefined;
		const autoApproved: PermissionEntry[] = [];
		for (const block of blocks) {
			if (block.kind === 'permission' && isAutoApproved(block.entry)) {
				autoApproved.push(block.entry);
				continue;
			}
			specs.push(this.blockSpec(block, turn, isLast, (id, focus) => { pending ??= { id, focus }; }, painted && !entry.blocks.has(block.key)));
		}
		if (autoApproved.length > 0) {
			// Calls an earlier approval or a session switch let through get one quiet line per turn, not a row each.
			specs.push({ key: 'auto-approved', deps: autoApproved, render: view => this._permissionCards.renderAutoApproved(view.element, autoApproved) });
		}
		if (turn.status === 'complete' && turn.assistantText.trim()) {
			const text = (answer.length > 0 ? answer.map(part => part.text).join('\n\n') : turn.assistantText).trim();
			specs.push({ key: 'meta', deps: [text, turn.endedAt], render: view => this.renderMeta(view.element, turn, text, view.store) });
		}
		if (turn.status === 'running' && !showsProgress(blocks)) {
			const permissions = permissionsForTimeline(turn, this._subagents, this._subagentId);
			const waitingOn = this._subagents.find(subagent => subagent.run.state === 'running' && isBackgroundCommand(subagent.run.agentType));
			const activity = describeActivity({ ...turn, permissions })
				?? (waitingOn ? localize('claudeWaitingOnCommand', "Waiting on {0}", waitingOn.run.description) : localize('claudeWorking', "Working..."));
			specs.push({ key: 'activity', deps: [activity], render: view => this.renderActivity(view.element, activity) });
		}
		if (turn.status === 'stopped') {
			specs.push({ key: 'stopped', deps: [isLast], render: view => this.renderStopped(view.element, isLast, view.store) });
		} else if (turn.status === 'failed' && !this._hiddenFailures.has(turn.id)) {
			const review = this._callbacks.review?.get(turn.id);
			const changed = review?.files.length ?? 0;
			specs.push({ key: 'failure', deps: [turn.failure, isLast, changed], render: view => this.renderFailure(view, turn, isLast, changed) });
		}
		const changes = this._callbacks.review?.get(turn.id);
		if (changes && changes.files.length > 0 && this._callbacks.review && entry.reviewKey !== 'docked') {
			const controller = this._callbacks.review;
			specs.push({ key: 'changes', deps: [entry.reviewKey], render: view => renderClaudeChangesCard(view.element, turn.id, changes, controller, view.store, { folderOf: uri => this.displayFolder(uri) }) });
		}
		const problems = this._callbacks.problems?.get(turn.id);
		if (problems && problems.length > 0) {
			specs.push({ key: 'problems', deps: [problems.length], render: view => this.renderNewProblems(view.element, turn.id, problems.length, view.store) });
		}
		this.reconcile(entry, specs);
		// Folding hides blocks instead of dropping them, so opening the fold rebuilds nothing.
		const folded = new Set(workOpen ? [] : [...work, ...(work.length > 0 ? ['auto-approved'] : [])]);
		for (const [key, view] of entry.blocks) {
			view.element.hidden = folded.has(key);
		}
		for (const block of blocks) {
			if (block.kind === 'permission' && block.entry.state !== 'pending') {
				// A settled card no longer needs its "already focused" mark.
				this._focusedPermissions.delete(block.entry.id);
			}
		}
		const card = pending as { readonly id: string; focus(): void } | undefined;
		if (card && !this._focusedPermissions.has(card.id)) {
			// The agent is blocked on this card, so it takes keyboard focus once.
			this._focusedPermissions.add(card.id);
			card.focus();
		}
	}

	private reconcile(entry: TurnEntry, specs: readonly BlockSpec[]): void {
		const wanted = new Set(specs.map(spec => spec.key));
		for (const key of [...entry.blocks.keys()]) {
			if (!wanted.has(key)) {
				entry.blocks.deleteAndDispose(key);
			}
		}
		let previous: HTMLElement | undefined;
		for (const spec of specs) {
			const expected = previous ? previous.nextSibling : entry.element.firstChild;
			let view = entry.blocks.get(spec.key);
			if (!view) {
				// Placed before it renders, so a command preview can measure and scroll.
				view = new TimelineBlockView(spec.key, $('.claude-part'));
				view.element.setAttribute('data-part', spec.key);
				view.element.classList.toggle('is-row', !!spec.row);
				entry.blocks.set(spec.key, view);
				entry.element.insertBefore(view.element, expected);
				view.deps = spec.deps;
				spec.render(view);
			} else {
				if (view.element !== expected) {
					entry.element.insertBefore(view.element, expected);
				}
				if (!sameDeps(view.deps, spec.deps)) {
					const before = view.deps;
					view.deps = spec.deps;
					if (!spec.update?.(view, before)) {
						const focused = this.captureFocus(view.element);
						view.clear();
						spec.render(view);
						this.restoreFocus(view.element, focused);
					}
				}
			}
			previous = view.element;
		}
	}

	private userSpec(turn: TurnViewModel, isLast: boolean): BlockSpec {
		const open = this._sentOpen.has(turn.id);
		const running = isLast && turn.status === 'running' && !!this._callbacks.stop && !this._subagentId;
		// A turn that wrote files saved a checkpoint first, so its prompt can put them back.
		const restorable = turn.status !== 'running' && turnWroteFiles(turn) && !!this._callbacks.restoreCheckpoint && !this._subagentId;
		// Known before this turn's tool rows draw, so the Read of an attached image folds.
		this._sentImages.add(turn.user.sent?.images);
		return {
			key: 'user',
			deps: [turn.user, open, running, restorable, turn.fallback],
			render: view => this.renderUser(view, turn, open, running, restorable),
			// Only Stop and Restore change while the prompt is on screen; the prompt itself stays.
			update: (view, before) => {
				if (before[0] !== turn.user || before[1] !== open || before[4] !== turn.fallback) {
					return false;
				}
				if (!view.setRunning) {
					return false;
				}
				view.setRunning(running, restorable);
				return true;
			},
		};
	}

	/** `fresh` is true for a block that first shows in a turn painted before, so it streams in from its start. */
	private blockSpec(block: TimelineBlock, turn: TurnViewModel, isLast: boolean, onPending: (id: string, focus: () => void) => void, fresh: boolean): BlockSpec {
		switch (block.kind) {
			case 'text': {
				const text = block.caret ? this.revealedText(turn.id, block.key, block.part.text, fresh) : this.revealDone(turn.id, block.key, block.part.text);
				// Text still to reveal keeps the part live, so a half-shown fence or list still renders as one.
				const part = text === block.part.text ? block.part : { ...block.part, text, open: true };
				return { key: block.key, deps: [part.text, block.caret, part.open], render: view => this.renderText(view, block.key, part, block.caret) };
			}
			case 'planDraft':
				return { key: block.key, deps: [block.part.text], render: view => this.renderPlanDraft(view.element, block.part, view.store) };
			case 'thinking': {
				// Thinking keys repeat in every turn (`thinking:k0`), so its open state is kept per turn (issue 1179).
				const cardId = `${turn.id}:${block.key}`;
				// The text streams in while Claude thinks, then folds into "Thought for Ns" unless the user opened or closed it (issue 461).
				const open = this.cardOpen(cardId, block.live);
				const label = describeThinking(block.part, block.live);
				const hasText = block.part.text.trim().length > 0;
				// A closed line does not change while more thinking streams in.
				return { key: block.key, deps: [label, hasText, open, open ? block.part.text : ''], row: true, render: view => this.renderThinking(view.element, cardId, turn.id, block.part, label, block.live, open, view.store) };
			}
			case 'plan':
				return {
					key: block.key,
					deps: [block.part, block.plan, isLast, this._planEdits.get(turn.id), this._planEditing.has(turn.id), this.planCollapsed(turn.id)],
					render: view => this.renderPlan(view.element, turn, block.plan, block.part.text, isLast, view.store),
				};
			case 'tool': {
				const card = block.card;
				const department = claudeDepartmentCardOf(card);
				if (department) {
					// DL-117: a hand-off to another project's chat reads as a card, not a tool row.
					return { key: block.key, deps: [card], render: view => renderClaudeDepartmentCard(view.element, department) };
				}
				// A running command shows its output tail and folds to its row once it ends.
				const open = this.cardOpen(card.id, card.kind === 'command' && card.state === 'running');
				const reviewFile = card.kind === 'edit' ? this.reviewFileFor(turn.id, card) : undefined;
				const patch = (view: TimelineBlockView) => {
					view.tool ??= view.store.add(new ClaudeToolCardView(view.element, turn.id, this._toolActions));
					view.tool.update(card, open, reviewFile);
					return true;
				};
				// DL-04: every tool is a row, a command too; its output reads as a block under the row (issue 578).
				return { key: block.key, deps: [card, open, reviewSignature(reviewFile)], row: true, render: patch, update: patch };
			}
			case 'reads': {
				const cardId = `${turn.id}:${block.key}`;
				const open = this.cardOpen(cardId, false);
				return { key: block.key, deps: [...block.cards, open], row: true, render: view => this.renderReadGroup(view.element, cardId, turn.id, block.cards, open, view.store) };
			}
			case 'github':
				return { key: block.key, deps: [block.reference, this._dragSessionId], render: view => { renderGitHubCard(view.element, block.reference, { sessionId: this._dragSessionId ?? '', details: this._gitHubDetails, hover: this._hover, investigation: this._checkInvestigation, reviewers: this._reviewerSuggestions, tend: this.tendContext() }, view.store); } };
			case 'subagents':
				return { key: block.key, deps: block.subagents.flatMap(subagentCardDeps), render: view => this.renderSubagents(view.element, block.subagents, view.store) };
			case 'permission':
				return {
					key: block.key,
					deps: [block.entry, isLast],
					render: view => {
						const focus = this.renderPermission(view.element, block.entry, turn.id, isLast, view.store);
						if (focus) {
							onPending(block.entry.id, focus);
						}
					},
				};
			case 'delegate': {
				const running = turn.status === 'running';
				const actions = this._callbacks.delegate;
				return { key: block.key, deps: [block.card, running], render: view => { if (actions) { renderClaudeDelegateCard(view.element, block.card, running, actions, view.store); } } };
			}
			case 'elicitation':
				return {
					key: block.key,
					deps: [block.entry],
					render: view => {
						const focus = this.renderElicitation(view.element, block.entry, view.store);
						if (focus) {
							onPending(block.entry.id, focus);
						}
					},
				};
		}
	}

	private renderUser(view: TimelineBlockView, turn: TurnViewModel, open: boolean, running: boolean, restorable: boolean): void {
		const store = view.store;
		const user = append(view.element, $('.claude-msg-user'));
		user.draggable = true;
		// The bubble drags into another chat from its edge; a drag that starts on the text selects it (issue 732).
		store.add(addDisposableListener(user, EventType.POINTER_DOWN, event => {
			user.draggable = !(isHTMLElement(event.target) && event.target.closest('.text'));
		}));
		store.add(addDisposableListener(user, 'dragstart', event => {
			const drag = event as DragEvent;
			const asOfTurn = this.turnIndex(turn.id);
			if (this._dragSessionId) {
				drag.dataTransfer?.setData(CLAUDE_CHAT_DRAG_MIME, encodeChatDrag({ sessionId: this._dragSessionId, turnId: turn.id, asOfTurn }));
			}
		}));
		const handoff = claudeDepartmentSenderOf(turn.user.text);
		if (handoff) {
			// DL-117: the first message of a chat another project started says who it is from.
			user.classList.add('is-handoff');
			append(user, $('.claude-handoff-from')).textContent = localize('claudeDepartmentFrom', "From {0}", handoff.from);
		}
		this.renderPromptText(user, turn.id, handoff ? handoff.body : turn.user.text, store);
		this.renderSentImages(user, turn.user.sent?.images, store);
		this.renderSentChips(user, turn.user.sent?.chips);
		const stop = this._callbacks.stop ? this.iconAction(user, store, Codicon.debugStop, localize('claudeStop', "Stop"), () => this._callbacks.stop?.()) : undefined;
		stop?.classList.add('claude-msg-stop');
		const restore = this._callbacks.restoreCheckpoint ? this.iconAction(user, store, Codicon.discard, localize('claudeRestoreCheckpointHere', "Restore Checkpoint"), () => this._callbacks.restoreCheckpoint?.(turn.id)) : undefined;
		restore?.classList.add('claude-msg-restore');
		view.setRunning = (isRunning, canRestore) => {
			if (stop) {
				stop.hidden = !isRunning;
			}
			if (restore) {
				restore.hidden = isRunning || !canRestore;
			}
			// Both sit in the same corner; the text keeps clear of whichever shows.
			user.classList.toggle('is-running', !!stop && isRunning);
			user.classList.toggle('is-restorable', !!restore && !isRunning && canRestore);
		};
		view.setRunning(running, restorable);
		// Message actions stay out of the way until the pointer or keyboard reaches the message.
		const toolbar = append(user, $('.claude-msg-toolbar'));
		toolbar.setAttribute('role', 'toolbar');
		toolbar.setAttribute('aria-label', localize('claudeMessageActions', "Message actions"));
		this.iconAction(toolbar, store, Codicon.copy, localize('claudeCopyMessage', "Copy"), () => void this._clipboard.writeText(turn.user.text));
		if (this._callbacks.editPrompt && !this._subagentId) {
			// DL-84: Edit stays in place when the chat can't go back; its hover says why.
			const edit = this.iconAction(toolbar, store, Codicon.edit, localize('claudeEditMessage', "Edit"), () => {
				if (edit.getAttribute('aria-disabled') !== 'true') {
					this._callbacks.editPrompt?.(turn.id);
				}
			});
			const refresh = () => {
				const check = this._callbacks.canEditPrompt?.(turn.id) ?? { enabled: true };
				edit.setAttribute('aria-disabled', String(!check.enabled));
				edit.title = check.enabled ? localize('claudeEditMessageHover', "Edit and send again from here") : check.reason ?? '';
			};
			refresh();
			store.add(addDisposableListener(user, EventType.MOUSE_ENTER, refresh));
			store.add(addDisposableListener(user, EventType.FOCUS_IN, refresh));
		}
		const sent = turn.user.sent;
		if (sent?.auto) {
			// Auto picked this turn's model (issue 521): the line names it, the hover says why.
			const chip = append(view.element, $('.claude-auto-pick'));
			append(chip, $(ThemeIcon.asCSSSelector(Codicon.sparkle)));
			append(chip, $('span.text')).textContent = localize('claudeAutoPickLine', "Auto \u00b7 {0}", claudeAutoPickLabel(sent.auto));
			store.add(this._hover.setupDelayedHover(chip, { content: claudeAutoPickHover(sent.auto), additionalClasses: ['claude-root'] }));
		}
		if (turn.fallback) {
			// DL-105 (issue 1009): the turn went back to the chat's own model; one muted line says so, like the delegate card's "Moved up".
			const note = append(view.element, $('.claude-auto-pick.is-fallback'));
			append(note, $(ThemeIcon.asCSSSelector(Codicon.arrowUp)));
			append(note, $('span.text')).textContent = claudeFallbackSentence(turn.fallback);
		}
		if (!sent) {
			return;
		}
		const show = this.iconAction(toolbar, store, Codicon.eye, open ? localize('claudeHideSent', "Hide Sent Prompt") : localize('claudeShowSent', "Show Sent Prompt"), () => {
			const opening = detail.hidden !== false;
			detail.hidden = !opening;
			show.setAttribute('aria-expanded', opening ? 'true' : 'false');
			const label = opening ? localize('claudeHideSent', "Hide Sent Prompt") : localize('claudeShowSent', "Show Sent Prompt");
			show.setAttribute('aria-label', label);
			show.title = label;
			user.classList.toggle('is-sent-open', opening);
			if (opening) {
				this._sentOpen.add(turn.id);
				detail.textContent = redactSecrets(formatSentPrompt(sent));
			} else {
				this._sentOpen.delete(turn.id);
			}
			// The toggle is the block's dependency; keep it in step without a rebuild.
			view.deps = [turn.user, opening, view.deps[2], view.deps[3], view.deps[4]];
		});
		show.classList.add('claude-show-sent');
		show.setAttribute('aria-expanded', open ? 'true' : 'false');
		const detail = append(user, $('pre.claude-sent-prompt'));
		show.setAttribute('aria-controls', detail.id = `claude-sent-${turn.id.replace(/[^A-Za-z0-9_-]/g, '_')}`);
		detail.hidden = !open;
		user.classList.toggle('is-sent-open', open);
		if (open) {
			detail.textContent = redactSecrets(formatSentPrompt(sent));
		}
		this._sentNodes.set(turn.id, { toggle: show, detail });
	}

	private renderSteered(parent: HTMLElement, steered: readonly string[]): void {
		for (const text of steered) {
			const note = append(parent, $('.claude-steer-note'));
			append(note, $(ThemeIcon.asCSSSelector(Codicon.comment)));
			append(note, $('span.text')).textContent = localize('claudeSteered', "Steered: {0}", text);
		}
	}

	/**
	 * DL-80: Claude Code sends a reply in bursts, a few hundred characters at once
	 * and then a pause (issue 740). A streaming part reveals at a steady pace that
	 * drains whatever has arrived in about {@link REVEAL_FRAMES} frames, so the
	 * reply types in instead of jumping. A part already on screen when its turn
	 * first painted (a reopened chat, a test) shows whole.
	 */
	private revealedText(turnId: string, key: string, text: string, fresh: boolean): string {
		const id = `${turnId}
${key}`;
		let state = this._reveal.get(id);
		if (!state) {
			state = { turnId, shown: fresh ? 0 : text.length, target: text.length };
			this._reveal.set(id, state);
		}
		state.target = text.length;
		state.shown = Math.min(state.shown, text.length);
		if (state.shown >= text.length) {
			return text;
		}
		this.scheduleReveal();
		// Never split a surrogate pair.
		const end = isHighSurrogate(text.charCodeAt(state.shown - 1)) ? state.shown + 1 : state.shown;
		return text.slice(0, end);
	}

	/** A part that stopped streaming, or was followed by another part, shows whole at once. */
	private revealDone(turnId: string, key: string, text: string): string {
		this._reveal.delete(`${turnId}
${key}`);
		return text;
	}

	private scheduleReveal(): void {
		if (!this._revealFrame.value) {
			this._revealFrame.value = scheduleAtNextAnimationFrame(getWindow(this._root), () => this.advanceReveal());
		}
	}

	private advanceReveal(): void {
		this._revealFrame.clear();
		const turns = new Set<string>();
		for (const [id, state] of this._reveal) {
			if (!this._entries.has(state.turnId)) {
				this._reveal.delete(id);
				continue;
			}
			if (state.shown < state.target) {
				const step = Math.max(REVEAL_MIN_STEP, Math.ceil((state.target - state.shown) / REVEAL_FRAMES));
				state.shown = Math.min(state.target, state.shown + step);
				turns.add(state.turnId);
			}
		}
		for (const turnId of turns) {
			const entry = this._entries.get(turnId);
			if (entry) {
				this.paintTurn(entry);
			}
		}
	}

	private renderText(view: TimelineBlockView, key: string, part: TurnTextPart, caret: boolean): void {
		const body = append(view.element, $('.claude-msg-assistant'));
		const rendered = this.renderMarkdown(body, part.text, view.store, { live: part.open }, key);
		if (caret) {
			const caretNode = $('span.claude-caret');
			caretNode.setAttribute('aria-hidden', 'true');
			caretHost(rendered).appendChild(caretNode);
		}
	}

	/**
	 * Claude's thinking as one quiet line: "Thinking" while it streams, then how
	 * long it took. When the runtime sent the thinking text, the line opens to it
	 * and a chevron leads it, as on "Worked for".
	 */
	private renderThinking(parent: HTMLElement, key: string, turnId: string, part: TurnThinkingPart, label: string, live: boolean, open: boolean, store: DisposableStore): void {
		const row = append(parent, $('.claude-thinking' + (live ? '.is-live' : '') + (open ? '.is-open' : '')));
		if (part.text.trim().length === 0) {
			append(append(row, $('span.claude-thinking-line')), $('span.text')).textContent = label;
			return;
		}
		const toggle = append(row, $<HTMLButtonElement>('button.claude-thinking-line'));
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
		append(toggle, $(ThemeIcon.asCSSSelector(open ? Codicon.chevronDown : Codicon.chevronRight) + '.chev'));
		append(toggle, $('span.text')).textContent = label;
		store.add(addDisposableListener(toggle, EventType.CLICK, event => {
			event.preventDefault();
			this.toggleCard(key, turnId);
		}));
		if (!open) {
			return;
		}
		const body = append(row, $('.claude-thinking-body'));
		body.id = `claude-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
		toggle.setAttribute('aria-controls', body.id);
		this.renderMarkdown(body, part.text, store);
		if (live) {
			body.scrollTop = body.scrollHeight;
		}
	}

	/** The prompt clamps to four lines under a fade. Clicking it, or Enter on it, shows the rest. */
	/** The images a message carried, as thumbnails that open the image (issue 744, DL-74). */
	private renderSentImages(user: HTMLElement, images: readonly SentImage[] | undefined, store: DisposableStore): void {
		if (!images?.length) {
			return;
		}
		const row = append(user, $('.claude-msg-images'));
		for (const image of images) {
			const label = claudeImageLabel(image.uri, image.name);
			const button = append(row, $<HTMLButtonElement>('button.claude-msg-image'));
			button.type = 'button';
			button.setAttribute('aria-label', localize('claudeOpenSentImage', "Open {0}", label));
			appendClaudeImageThumb(button, this._thumbnails, image.uri);
			store.add(this._hover.setupDelayedHover(button, { content: label, additionalClasses: ['claude-root'] }));
			store.add(addDisposableListener(button, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				void this._editors.openEditor({ resource: URI.parse(image.uri) }).catch(error => this._notifications.error(error instanceof Error ? error.message : String(error)));
			}));
		}
	}

	/** The chips a message was sent with, after its text and images (issue 759, DL-74). */
	private renderSentChips(user: HTMLElement, chips: readonly SentChip[] | undefined): void {
		if (!chips?.length) {
			return;
		}
		const row = append(user, $('.claude-msg-chips'));
		for (const sentChip of chips) {
			const chip = append(row, $('span.claude-chip'));
			append(chip, $(ThemeIcon.asCSSSelector(sentChipIcon(sentChip.kind))));
			append(chip, $('span.label')).textContent = sentChip.label;
		}
	}

	private renderPromptText(user: HTMLElement, turnId: string, text: string, store: DisposableStore): void {
		const node = append(user, $('span.text'));
		node.textContent = text;
		user.classList.toggle('is-expanded', this._userExpanded.has(turnId));
		let long = false;
		const sync = () => {
			const expanded = user.classList.contains('is-expanded');
			long = node.scrollHeight > parseFloat(getWindow(node).getComputedStyle(node).lineHeight) * PROMPT_CLAMP_LINES + 1;
			user.classList.toggle('is-clamped', long && !expanded);
			if (long) {
				node.tabIndex = 0;
				node.setAttribute('role', 'button');
				node.setAttribute('aria-expanded', expanded ? 'true' : 'false');
			} else {
				node.removeAttribute('tabindex');
				node.removeAttribute('role');
				node.removeAttribute('aria-expanded');
			}
		};
		const toggle = () => {
			const expanded = !user.classList.contains('is-expanded');
			user.classList.toggle('is-expanded', expanded);
			if (expanded) {
				this._userExpanded.add(turnId);
			} else {
				this._userExpanded.delete(turnId);
			}
			sync();
		};
		store.add(addDisposableListener(node, EventType.CLICK, () => {
			// Selecting part of the prompt is not a request to open it.
			if (long && !getWindow(node).getSelection()?.toString()) {
				toggle();
			}
		}));
		store.add(addDisposableListener(node, EventType.KEY_DOWN, event => {
			if (long && (event.key === 'Enter' || event.key === ' ')) {
				event.preventDefault();
				toggle();
			}
		}));
		// Wrapping depends on the pane width, so the clamp is measured again when it changes.
		const observer = store.add(new DisposableResizeObserver('claudePromptClamp', () => sync(), getWindow(node)));
		store.add(observer.observe(node));
	}

	/** "Worked for 5s", its chevron first, over a finished turn's work. Folding hides the blocks; it does not rebuild them. */
	private renderWorkToggle(parent: HTMLElement, entry: TurnEntry, label: string, open: boolean, store: DisposableStore): void {
		const button = append(parent, $<HTMLButtonElement>('button.claude-work-toggle'));
		button.type = 'button';
		button.setAttribute('aria-expanded', open ? 'true' : 'false');
		append(button, $(ThemeIcon.asCSSSelector(open ? Codicon.chevronDown : Codicon.chevronRight) + '.chev'));
		append(button, $('span.text')).textContent = label;
		store.add(addDisposableListener(button, EventType.CLICK, () => {
			this._workOpen.set(entry.turn.id, !open);
			this.paintTurn(entry);
		}));
	}

	/** Copy and Fork from Here under a finished answer, and the time it finished. */
	private renderMeta(parent: HTMLElement, turn: TurnViewModel, text: string, store: DisposableStore): void {
		const row = append(parent, $('.claude-turn-meta'));
		row.setAttribute('role', 'toolbar');
		row.setAttribute('aria-label', localize('claudeAnswerActions', "Answer actions"));
		this.iconAction(row, store, Codicon.copy, localize('claudeCopyAnswer', "Copy Answer"), () => void this._clipboard.writeText(text));
		if (this._callbacks.forkFrom && !this._subagentId) {
			this.iconAction(row, store, Codicon.repoForked, localize('claudeForkFromHere', "Fork from Here"), () => this._callbacks.forkFrom?.(turn.id));
		}
		if (turn.endedAt !== undefined) {
			const date = new Date(turn.endedAt);
			const time = append(row, $('span.time'));
			time.textContent = date.toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' });
			time.title = date.toLocaleString(language);
		}
	}

	private renderActivity(parent: HTMLElement, text: string): void {
		const line = append(parent, $('.claude-activity.is-shimmer'));
		append(line, $(ThemeIcon.asCSSSelector(Codicon.loadingCompact) + '.codicon-modifier-spin'));
		append(line, $('span.text')).textContent = text;
	}

	private renderStopped(parent: HTMLElement, isLast: boolean, store: DisposableStore): void {
		const line = append(parent, $('.claude-activity'));
		append(line, $(ThemeIcon.asCSSSelector(Codicon.debugStop)));
		append(line, $('span.text')).textContent = `${localize('claudeStoppedNote', "Stopped. Partial output is kept.")} ${localize('claudeNextConversation', "The next message starts a new Claude conversation.")}`;
		if (isLast) {
			this.appendRetry(line, store, false);
		}
	}

	/** What a chat does on a limit under the global policy and the default account's options (issue 1182, DL-86). */
	private limitPolicyLine(): string | undefined {
		const accountId = readClaudeDefaultAccountId(this._configuration.getValue(CLAUDE_ACCOUNTS_DEFAULT_ACCOUNT_SETTING));
		const account = accountId ? readClaudeLimitOptions(this._configuration.getValue(CLAUDE_ACCOUNTS_LIMIT_OPTIONS_SETTING))[accountId] : undefined;
		const choice = resolveClaudeLimitPolicy({ chatPolicy: this._callbacks.limitChoices?.chatPolicy(), globalPolicy: readClaudeLimitPolicy(this._configuration.getValue(CLAUDE_ACCOUNTS_ON_LIMIT_SETTING)), account });
		return claudeLimitPolicyLine(choice, account);
	}

	/** A calm failure: what happened, that work is kept, and Retry as the way forward (spec 04). */
	private renderFailure(view: TimelineBlockView, turn: TurnViewModel, isLast: boolean, changed: number): void {
		const store = view.store;
		const presented = describeFailure(turn.failure);
		if (turn.failure?.kind === 'turn-limit') {
			this.renderTurnLimit(view.element, presented.title, isLast, store);
			return;
		}
		// A plan limit is not an error (issue 450, DL-86): it says which limit, when it resets and what the plan offers.
		const limit = turn.failure?.kind === 'usage-limit' ? claudeLimitBanner(turn.failure.limit, undefined, this.limitPolicyLine()) : undefined;
		const banner = append(view.element, $(limit ? '.claude-banner.is-warning.claude-limit-banner' : '.claude-banner.is-error'));
		banner.setAttribute('role', 'alert');
		append(banner, $(ThemeIcon.asCSSSelector(limit ? Codicon.warning : Codicon.error)));
		const body = append(banner, $('.body'));
		append(body, $('.title')).textContent = limit?.title ?? presented.title;
		const description = limit ? limit.detail : presented.description;
		if (description) {
			append(body, $('.desc')).textContent = description;
		}
		if (limit?.note) {
			append(body, $('.desc.claude-limit-note')).textContent = limit.note;
		}
		if (limit?.policyLine) {
			append(body, $('.desc.claude-limit-note')).textContent = limit.policyLine;
		}
		append(body, $('.desc.is-reassure')).textContent = changed === 0
			? localize('claudeFailureKept', "Your files are safe. The partial answer is kept.")
			: changed === 1
				? localize('claudeFailureKeptOne', "Your files are safe. 1 changed file is ready for review.")
				: localize('claudeFailureKeptMany', "Your files are safe. {0} changed files are ready for review.", changed);
		const actions = append(body, $('.actions'));
		for (const [index, action] of (limit?.actions ?? []).entries()) {
			const button = append(actions, $<HTMLButtonElement>(`button.claude-btn.is-small.${index === 0 ? 'is-primary' : 'is-ghost'}.claude-limit-action`));
			button.type = 'button';
			button.textContent = action.label;
			button.dataset.action = action.id;
			store.add(addDisposableListener(button, EventType.CLICK, () => {
				if (action.commandId) {
					void this._commands.executeCommand(action.commandId);
				} else if (action.url) {
					void this._opener.open(URI.parse(action.url), { openExternal: true });
				}
			}));
		}
		if (isLast && limit?.waitUntil !== undefined) {
			this.appendWaitForReset(actions, store, turn.id, limit.waitUntil);
		}
		if (isLast && limit) {
			this.appendLimitRetryOptions(actions, store);
		}
		if (isLast) {
			this.appendRetry(actions, store, !limit);
		}
		if (this._callbacks.openStatus && claudeFailureOffersStatus(turn.failure?.kind) && !limit) {
			const status = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost.claude-open-status'));
			status.type = 'button';
			status.textContent = localize('claudeOpenStatus', "Open Claude Status");
			store.add(addDisposableListener(status, EventType.CLICK, () => this._callbacks.openStatus?.()));
		}
		const close = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
		close.type = 'button';
		close.textContent = localize('claudeCloseFailure', "Close");
		store.add(addDisposableListener(close, EventType.CLICK, () => {
			this._hiddenFailures.add(turn.id);
			banner.remove();
		}));
	}

	/** Retry with another account, Use Extra Usage and Use API Key, once the accounts are known (issue 1385). */
	private appendLimitRetryOptions(parent: HTMLElement, store: DisposableStore): void {
		const choices = this._callbacks.limitChoices;
		if (!choices) {
			return;
		}
		void choices.accounts().then(accounts => {
			if (store.isDisposed) {
				return;
			}
			const current = choices.currentAccountId() ?? accounts.find(account => account.active)?.id;
			const options = readClaudeLimitOptions(this._configuration.getValue(CLAUDE_ACCOUNTS_LIMIT_OPTIONS_SETTING))[current ?? ''];
			let position = 1;
			for (const option of claudeLimitRetryOptions(accounts, current, options)) {
				const button = $<HTMLButtonElement>(`button.claude-btn.is-small.is-ghost.claude-limit-action`);
				button.type = 'button';
				button.textContent = option.label;
				button.dataset.action = option.id;
				store.add(addDisposableListener(button, EventType.CLICK, () => choices.retryWith(option.accountId, option.policy)));
				parent.insertBefore(button, parent.children[position++] ?? null);
			}
		}, () => undefined);
	}

	/**
	 * Wait until Reset: the turn is retried once, when the limit resets (issue 1182). The wait
	 * outlives a re-render, and the same button cancels it.
	 */
	private appendWaitForReset(parent: HTMLElement, store: DisposableStore, turnId: string, waitUntil: number): void {
		const button = append(parent, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost.claude-wait-reset'));
		button.type = 'button';
		const label = () => {
			button.textContent = this._resumeAtReset.has(turnId)
				? localize('claudeCancelWait', "Cancel Wait")
				: localize('claudeWaitForReset', "Wait Until Reset");
		};
		label();
		store.add(addDisposableListener(button, EventType.CLICK, () => {
			if (this._resumeAtReset.has(turnId)) {
				this._resumeAtReset.deleteAndDispose(turnId);
			} else {
				const handle = setTimeout(() => {
					this._resumeAtReset.deleteAndDispose(turnId);
					this._callbacks.retry();
				}, Math.max(0, waitUntil - Date.now()));
				this._resumeAtReset.set(turnId, toDisposable(() => clearTimeout(handle)));
			}
			label();
		}));
	}

	/**
	 * A turn that reached its step cap is not an error (issues 696, 707): a one-line note like
	 * Stopped, with Continue, which goes on in the same Claude conversation.
	 */
	private renderTurnLimit(parent: HTMLElement, title: string, isLast: boolean, store: DisposableStore): void {
		const line = append(parent, $('.claude-activity.is-turn-limit'));
		append(line, $(ThemeIcon.asCSSSelector(Codicon.debugPause)));
		append(line, $('span.text')).textContent = title;
		const continueTurn = this._callbacks.continueTurn;
		if (!isLast || !continueTurn) {
			return;
		}
		const button = append(line, $<HTMLButtonElement>('button.claude-btn.is-small.is-primary.claude-continue'));
		button.type = 'button';
		button.textContent = localize('claudeContinue', "Continue");
		store.add(addDisposableListener(button, EventType.CLICK, () => continueTurn()));
	}

	/**
	 * A pending request is a card; a decided one is a one-line record, and a
	 * write the mode blocked offers Switch to Agent and Retry on the newest turn.
	 * Returns the focus target of a pending card.
	 */
	private renderPermission(parent: HTMLElement, entry: PermissionEntry, turnId: string, isLast: boolean, store: DisposableStore): (() => void) | undefined {
		if (entry.state === 'pending') {
			return this._permissionCards.renderCard(parent, entry, store, (requestId, choice) => this._callbacks.respondPermission(requestId, choice));
		}
		if (entry.source === 'policy' && entry.state === 'denied') {
			const switchAndRetry = this._callbacks.switchToAgentAndRetry;
			const retry = isLast && entry.blockedByMode && switchAndRetry ? () => switchAndRetry(turnId) : undefined;
			this._permissionCards.renderBlocked(parent, entry, store, retry);
		} else {
			this._permissionCards.renderRecord(parent, entry);
		}
		return undefined;
	}

	/**
	 * An MCP form or sign-in, or a question from Claude (issue 477): a card while
	 * it waits, then a record. Returns the focus target of a pending card.
	 */
	private renderElicitation(parent: HTMLElement, entry: ElicitationEntry, store: DisposableStore): (() => void) | undefined {
		const respond = async (id: string, answer: ClaudeElicitationAnswer) => this._callbacks.respondElicitation?.(id, answer);
		if (entry.mode === 'question') {
			this._questionCards ??= this._instantiation.createInstance(ClaudeQuestionCards);
			return this._questionCards.render(parent, entry, store, respond);
		}
		this._elicitationCards ??= this._instantiation.createInstance(ClaudeElicitationCards);
		return this._elicitationCards.render(parent, entry, store, respond);
	}

	/**
	 * A Plan-mode answer while it streams: a plan card skeleton with the steps
	 * read so far, so the answer does not jump from raw Markdown into a card.
	 */
	private renderPlanDraft(parent: HTMLElement, part: TurnTextPart, store: DisposableStore): void {
		const draft = parsePlanArtifact(part.text);
		if (draft?.lead) {
			this.renderMarkdown(append(parent, $('.claude-msg-assistant.claude-plan-lead')), draft.lead, store);
		}
		const card = append(parent, $('.claude-plan.is-draft'));
		card.setAttribute('role', 'group');
		card.setAttribute('aria-busy', 'true');
		card.setAttribute('aria-label', localize('claudePlanDrafting', "Drafting plan"));
		const head = append(card, $('.claude-plan-head'));
		append(head, $(ThemeIcon.asCSSSelector(Codicon.loading) + '.codicon-modifier-spin'));
		append(head, $('span.title')).textContent = draft?.title ?? localize('claudePlanDraftingTitle', "Drafting plan...");
		const list = append(card, $<HTMLOListElement>('ol.claude-todos'));
		draft?.steps.forEach((step, index) => {
			const row = append(list, $('li.claude-todo.is-pending'));
			appendStepNumber(row, index);
			const text = append(row, $('span.text'));
			this.appendInline(append(text, $('span.title')), planStepSource(part.text, step.title) ?? step.title);
		});
		const skeleton = append(list, $('li.claude-todo.is-skeleton'));
		skeleton.setAttribute('aria-hidden', 'true');
		appendStepNumber(skeleton, draft?.steps.length ?? 0);
		append(skeleton, $('span.bar'));
	}

	/**
	 * The plan as a checklist card with notes and Build. Only the newest turn can
	 * build. Edit Plan turns each step into a text field with Move Up and Move
	 * Down (also Alt+Up and Alt+Down). Build and Open Plan use the edited plan.
	 * Open Plan stays on older plan cards, which have nothing else to act on.
	 */
	private renderPlan(parent: HTMLElement, turn: TurnViewModel, original: PlanArtifact, source: string, canBuild: boolean, store: DisposableStore): void {
		const plan = this._planEdits.get(turn.id) ?? original;
		if (!canBuild) {
			this._planEditing.delete(turn.id);
		}
		if (this.planCollapsed(turn.id)) {
			this.renderPlanLink(parent, turn.id, plan, original, store);
			return;
		}
		const editing = this._planEditing.has(turn.id);
		// What the answer said before the plan reads as a message, not as card text.
		if (original.lead) {
			this.renderMarkdown(append(parent, $('.claude-msg-assistant.claude-plan-lead')), original.lead, store);
		}
		const card = append(parent, $('.claude-plan' + (editing ? '.is-editing' : '')));
		card.setAttribute('role', 'group');
		card.setAttribute('aria-label', localize('claudePlanLabelSize', "Plan: {0}, {1}", plan.title, describePlanSize(plan)));
		const head = append(card, $('.claude-plan-head'));
		append(head, $(ThemeIcon.asCSSSelector(Codicon.checklist)));
		const heading = append(head, $('.heading'));
		const steps = plan.steps.length === 1
			? localize('claudePlanEyebrowOne', "Plan · 1 step")
			: localize('claudePlanEyebrow', "Plan · {0} steps", plan.steps.length);
		append(heading, $('span.eyebrow')).textContent = isPlanEdited(original, plan)
			? localize('claudePlanSizeEdited', "{0}, edited", steps)
			: steps;
		append(heading, $('span.title')).textContent = plan.title;
		if (this.planInEditor(turn.id)) {
			this.renderPlanCollapse(head, turn.id, store);
		}
		// The details read first, as Markdown, so the steps below stay short tasks.
		if (plan.details) {
			this.renderMarkdown(append(card, $('.claude-plan-summary.is-details')), plan.details, store);
		} else if (plan.summary) {
			append(card, $('.claude-plan-summary')).textContent = plan.summary;
		}
		const list = append(card, $<HTMLOListElement>('ol.claude-todos'));
		if (editing) {
			this._planControls.clear();
		}
		plan.steps.forEach((step, index) => {
			const row = append(list, $('li.claude-todo.is-' + step.status));
			appendStepNumber(row, index);
			if (editing) {
				this.renderPlanStepEditor(row, turn.id, original, index, plan.steps.length, store);
				return;
			}
			const text = append(row, $('span.text'));
			// Inline code and strong text in a step stay as the answer wrote them.
			this.appendInline(append(text, $('span.title')), planStepSource(source, step.title) ?? step.title);
			const detail = planDetailSource(source, step.title) ?? step.detail;
			if (detail) {
				this.appendInline(append(text, $('span.detail')), detail);
			}
			if (step.files && step.files.length > 0) {
				const files = append(text, $('span.files'));
				for (const file of step.files) {
					const chip = append(files, $('span.claude-chip'));
					append(chip, $(ThemeIcon.asCSSSelector(Codicon.file)));
					append(chip, $('span.label')).textContent = file;
				}
			}
		});
		if (!canBuild) {
			if (this._callbacks.openPlan) {
				this.renderOpenPlan(append(card, $('.claude-plan-actions')), turn.id, original, undefined, store);
			}
			return;
		}
		if (editing) {
			store.add(addDisposableListener(list, EventType.KEY_DOWN, event => {
				if (event.key === 'Escape') {
					event.preventDefault();
					event.stopPropagation();
					this.setPlanEditing(turn.id, false);
				}
			}));
		}
		const notes = append(card, $<HTMLTextAreaElement>('textarea.claude-plan-notes'));
		notes.rows = 2;
		notes.value = this._planNotes.get(turn.id) ?? '';
		notes.placeholder = localize('claudePlanNotesPlaceholder', "Add notes or constraints for the build...");
		notes.setAttribute('aria-label', localize('claudePlanNotes', "Notes for the agent"));
		store.add(addDisposableListener(notes, EventType.INPUT, () => this._planNotes.set(turn.id, notes.value)));
		const actions = append(card, $('.claude-plan-actions'));
		const edit = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.claude-plan-edit'));
		edit.type = 'button';
		edit.setAttribute('aria-pressed', editing ? 'true' : 'false');
		append(edit, $(ThemeIcon.asCSSSelector(editing ? Codicon.check : Codicon.edit)));
		const editLabel = editing ? localize('claudePlanDoneEditing', "Done Editing") : localize('claudePlanEdit', "Edit Plan");
		append(edit, $('span')).textContent = editLabel;
		edit.setAttribute('aria-label', editLabel);
		edit.title = editLabel;
		this._planEditButton = edit;
		store.add(addDisposableListener(edit, EventType.CLICK, () => this.setPlanEditing(turn.id, !this._planEditing.has(turn.id))));
		if (this._callbacks.openPlan) {
			this.renderOpenPlan(actions, turn.id, original, notes, store);
		}
		append(actions, $('span.spacer'));
		const run = (target: ClaudeBuildTarget) => {
			const plan = this._planEdits.get(turn.id);
			const start = target === 'background' && this._callbacks.buildInBackground
				? this._callbacks.buildInBackground(turn.id, notes.value, plan)
				: this._callbacks.build(turn.id, notes.value, plan);
			return start.catch(error => {
				this._notifications.error(redactSecrets(error instanceof Error ? error.message : String(error)));
			});
		};
		// DL-06: Build is the small 20px size, like Edit Plan and Open Plan beside it; it stays the orange primary action (DL-09).
		store.add(this._instantiation.createInstance(ClaudeBuildButton, actions, { run })).element.classList.add('is-plan');
	}

	/** Whether the plan file `turnId` wrote is open in an editor, so its card shrinks to one line. */
	private planInEditor(turnId: string): boolean {
		if (!this._dragSessionId) {
			return false;
		}
		const suffix = `-${planFileKey(this._dragSessionId, turnId)}.plan.md`;
		return this._editors.editors.some(editor => editor.resource?.path.endsWith(suffix) === true);
	}

	private planCollapsed(turnId: string): boolean {
		return !this._planShown.has(turnId) && this.planInEditor(turnId);
	}

	/** Repaints the plan turns when editors open or close. A plan whose file closed collapses again the next time it opens. */
	/** What a pull request card needs for its Tend This PR link: it runs the palette's own commands (issue 1016). */
	private tendContext() {
		return {
			onDidChange: this._tend.onDidChange,
			isTending: (sessionId: string) => this._tend.isTending(sessionId),
			toggle: (sessionId: string) => void this._commands.executeCommand(this._tend.isTending(sessionId) ? CLAUDE_STOP_TENDING_PR_COMMAND_ID : CLAUDE_TEND_PR_COMMAND_ID),
		};
	}

	private repaintPlans(): void {
		for (const entry of this._entries.values()) {
			if (!entry.turn.plan) {
				continue;
			}
			if (!this.planInEditor(entry.turn.id)) {
				this._planShown.delete(entry.turn.id);
			}
			this.paintTurn(entry);
		}
	}

	/**
	 * The plan card while its file is open in an editor: the title and step
	 * count as one line that goes to the plan editor, and Show the Plan in the
	 * Chat, which brings the full card back.
	 */
	private renderPlanLink(parent: HTMLElement, turnId: string, plan: PlanArtifact, original: PlanArtifact, store: DisposableStore): void {
		const card = append(parent, $('.claude-plan.is-collapsed'));
		card.setAttribute('role', 'group');
		card.setAttribute('aria-label', localize('claudePlanLabel', "Plan: {0}", plan.title));
		const go = append(card, $<HTMLButtonElement>('button.claude-plan-goto'));
		go.type = 'button';
		go.title = localize('claudePlanGoTo', "Go to the plan in the plan editor");
		append(go, $(ThemeIcon.asCSSSelector(Codicon.checklist)));
		append(go, $('span.title')).textContent = plan.title;
		append(go, $('span.meta')).textContent = plan.steps.length === 1
			? localize('claudePlanLinkOneStep', "1 step")
			: localize('claudePlanLinkSteps', "{0} steps", plan.steps.length);
		store.add(addDisposableListener(go, EventType.CLICK, () => {
			const openPlan = this._callbacks.openPlan;
			if (!openPlan) {
				return;
			}
			void openPlan(turnId, this._planNotes.get(turnId) ?? '', this._planEdits.get(turnId) ?? original).catch(error => {
				this._notifications.error(redactSecrets(error instanceof Error ? error.message : String(error)));
			});
		}));
		const show = append(card, $<HTMLButtonElement>('button.claude-icon-btn.claude-plan-show'));
		show.type = 'button';
		this._planToggle = show;
		const showLabel = localize('claudePlanShowInChat', "Show the Plan in the Chat");
		show.setAttribute('aria-label', showLabel);
		show.title = showLabel;
		append(show, $(ThemeIcon.asCSSSelector(Codicon.commentDiscussion)));
		store.add(addDisposableListener(show, EventType.CLICK, () => {
			this._planShown.add(turnId);
			const entry = this._entries.get(turnId);
			if (entry) {
				this.paintTurn(entry);
				this._planToggle?.focus();
			}
		}));
	}

	/**
	 * Collapse the Plan: on a card shown with Show the Plan in the Chat, folds
	 * it back to the one line while its file stays open (issue 323). Focus moves
	 * to Show the Plan in the Chat so the keyboard can expand it again.
	 */
	private renderPlanCollapse(head: HTMLElement, turnId: string, store: DisposableStore): void {
		const collapse = append(head, $<HTMLButtonElement>('button.claude-icon-btn.claude-plan-collapse'));
		collapse.type = 'button';
		this._planToggle = collapse;
		const label = localize('claudePlanCollapse', "Collapse the Plan");
		collapse.setAttribute('aria-label', label);
		collapse.title = label;
		append(collapse, $(ThemeIcon.asCSSSelector(Codicon.chevronUp)));
		store.add(addDisposableListener(collapse, EventType.CLICK, () => {
			this._planShown.delete(turnId);
			const entry = this._entries.get(turnId);
			if (entry) {
				this.paintTurn(entry);
				this._planToggle?.focus();
			}
		}));
	}

	/** Open Plan: the plan as a file in the plan editor. `notes` is unset on an older card. */
	private renderOpenPlan(actions: HTMLElement, turnId: string, original: PlanArtifact, notes: HTMLTextAreaElement | undefined, store: DisposableStore): void {
		const open = append(actions, $<HTMLButtonElement>('button.claude-btn.is-ghost.is-small.claude-plan-open'));
		open.type = 'button';
		append(open, $(ThemeIcon.asCSSSelector(Codicon.goToFile)));
		append(open, $('span')).textContent = localize('claudePlanOpen', "Open Plan");
		open.setAttribute('aria-label', localize('claudePlanOpen', "Open Plan"));
		open.title = localize('claudePlanOpenTitle', "Open the plan as a file you can edit, tick off and build later");
		store.add(addDisposableListener(open, EventType.CLICK, () => {
			const openPlan = this._callbacks.openPlan;
			if (!openPlan) {
				return;
			}
			open.disabled = true;
			void openPlan(turnId, notes?.value ?? this._planNotes.get(turnId) ?? '', this._planEdits.get(turnId) ?? original).catch(error => {
				this._notifications.error(redactSecrets(error instanceof Error ? error.message : String(error)));
			}).finally(() => {
				open.disabled = false;
			});
		}));
	}

	/** Inline Markdown as DOM: code spans and strong text, everything else as text. Never HTML. */
	private appendInline(parent: HTMLElement, source: string): void {
		for (const run of inlineMarkdownRuns(source)) {
			if (run.kind === 'code') {
				append(parent, $('code')).textContent = run.text;
			} else if (run.kind === 'strong') {
				append(parent, $('strong')).textContent = run.text;
			} else {
				parent.append(run.text);
			}
		}
	}

	/** Step `index` of a plan card in edit mode: its title field plus Move Up and Move Down. */
	private renderPlanStepEditor(row: HTMLElement, turnId: string, original: PlanArtifact, index: number, count: number, store: DisposableStore): void {
		const current = () => this._planEdits.get(turnId) ?? original;
		const step = current().steps[index];
		const input = append(row, $<HTMLInputElement>('input.claude-field.claude-plan-step-input'));
		input.type = 'text';
		input.value = step.title;
		input.setAttribute('aria-label', localize('claudePlanStepLabel', "Step {0} of {1}", index + 1, count));
		const tools = append(row, $('span.claude-plan-step-tools'));
		const moveButton = (icon: ThemeIcon, label: string, direction: -1 | 1, disabled: boolean): HTMLButtonElement => {
			const button = append(tools, $<HTMLButtonElement>('button.claude-icon-btn'));
			button.type = 'button';
			button.disabled = disabled;
			button.setAttribute('aria-label', label);
			button.title = label;
			append(button, $(ThemeIcon.asCSSSelector(icon)));
			store.add(addDisposableListener(button, EventType.CLICK, () => this.movePlanStep(turnId, original, step.id, direction, direction < 0 ? 'up' : 'down')));
			return button;
		};
		const up = moveButton(Codicon.arrowUp, localize('claudePlanMoveUp', "Move Step Up (Alt+Up)"), -1, index === 0);
		const down = moveButton(Codicon.arrowDown, localize('claudePlanMoveDown', "Move Step Down (Alt+Down)"), 1, index === count - 1);
		this._planControls.set(step.id, { input, up, down });
		store.add(addDisposableListener(input, EventType.INPUT, () => {
			const before = current();
			const renamed = renamePlanStep(before, step.id, input.value);
			if (renamed !== before) {
				this._planEdits.set(turnId, renamed);
			}
		}));
		store.add(addDisposableListener(input, EventType.BLUR, () => {
			// A blank title is never kept, so the field shows the step's title again.
			if (!input.value.trim()) {
				input.value = current().steps.find(candidate => candidate.id === step.id)?.title ?? step.title;
			}
		}));
		store.add(addDisposableListener(row, EventType.KEY_DOWN, event => {
			if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
				event.preventDefault();
				event.stopPropagation();
				this.movePlanStep(turnId, original, step.id, event.key === 'ArrowUp' ? -1 : 1, 'input');
			} else if (event.key === 'Enter' && event.target === input) {
				// Enter moves to the next step's field, and from the last step to Done Editing.
				event.preventDefault();
				const steps = current().steps;
				const next = steps[steps.findIndex(candidate => candidate.id === step.id) + 1];
				(next ? this._planControls.get(next.id)?.input : this._planEditButton)?.focus();
			}
		}));
	}

	private movePlanStep(turnId: string, original: PlanArtifact, stepId: string, direction: -1 | 1, focus: 'input' | 'up' | 'down'): void {
		const current = this._planEdits.get(turnId) ?? original;
		const moved = movePlanStep(current, stepId, direction);
		if (moved === current) {
			return;
		}
		this._planEdits.set(turnId, moved);
		this.repaintTurn(turnId);
		const controls = this._planControls.get(stepId);
		// Focus follows the moved step. A move button that is now disabled hands focus to the field.
		const button = focus === 'up' ? controls?.up : focus === 'down' ? controls?.down : undefined;
		(button && !button.disabled ? button : controls?.input)?.focus();
	}

	private setPlanEditing(turnId: string, editing: boolean): void {
		if (editing) {
			this._planEditing.add(turnId);
		} else {
			this._planEditing.delete(turnId);
		}
		this.repaintTurn(turnId);
		const plan = this._planEdits.get(turnId) ?? this._entries.get(turnId)?.turn.plan;
		const first = plan?.steps[0];
		(editing && first ? this._planControls.get(first.id)?.input : this._planEditButton)?.focus();
	}

	private repaintTurn(turnId: string): void {
		const entry = this._entries.get(turnId);
		if (entry) {
			this.paintTurn(entry);
		}
	}

	/** Remembers which Copy, Insert, Retry, or file link was focused, including which duplicate. */
	private captureFocus(root: HTMLElement): { key: string; index: number } | undefined {
		const active = getActiveElement();
		if (!isHTMLElement(active) || !root.contains(active)) {
			return undefined;
		}
		if (active.tagName !== 'BUTTON' && active.getAttribute('role') !== 'link') {
			return undefined;
		}
		const key = this.focusKey(active);
		const index = this.focusMatches(root, key).indexOf(active);
		return index < 0 ? undefined : { key, index };
	}

	private restoreFocus(root: HTMLElement, captured: { key: string; index: number } | undefined): void {
		if (!captured) {
			return;
		}
		this.focusMatches(root, captured.key)[captured.index]?.focus();
	}

	private focusMatches(root: HTMLElement, key: string): HTMLElement[] {
		const matches: HTMLElement[] = [];
		const pending: HTMLElement[] = [root];
		while (pending.length > 0) {
			const node = pending.shift();
			if (!node) {
				break;
			}
			if (node !== root && this.focusKey(node) === key) {
				matches.push(node);
			}
			for (let i = 0; i < node.children.length; i++) {
				const child = node.children[i];
				if (isHTMLElement(child)) {
					pending.push(child);
				}
			}
		}
		return matches;
	}

	private focusKey(node: HTMLElement): string {
		return `${node.getAttribute('role') ?? node.tagName}|${node.getAttribute('aria-label') ?? ''}|${node.textContent ?? ''}`;
	}

	private renderNewProblems(parent: HTMLElement, turnId: string, count: number, store: DisposableStore): void {
		const row = append(parent, $('.claude-new-problems'));
		row.setAttribute('role', 'status');
		append(row, $(ThemeIcon.asCSSSelector(Codicon.warning)));
		append(row, $('span.title')).textContent = count === 1
			? localize('claudeOneNewProblem', "1 new problem")
			: localize('claudeNewProblems', "{0} new problems", count);
		const fix = append(row, $<HTMLButtonElement>('button.claude-btn.is-small'));
		fix.type = 'button';
		fix.textContent = localize('claudeFixProblems', "Fix Problems with Agent");
		store.add(addDisposableListener(fix, EventType.CLICK, event => {
			event.preventDefault();
			event.stopPropagation();
			this._callbacks.problems?.fix(turnId);
		}));
	}

	private appendRetry(parent: HTMLElement, store: DisposableStore, primary: boolean): void {
		const retry = append(parent, $<HTMLButtonElement>('button.claude-btn.is-small.claude-retry' + (primary ? '.is-primary' : '')));
		retry.type = 'button';
		retry.textContent = localize('claudeRetry', "Retry");
		store.add(addDisposableListener(retry, EventType.CLICK, () => this._callbacks.retry()));
	}

	private renderReadGroup(parent: HTMLElement, id: string, turnId: string, cards: readonly ToolCardModel[], open: boolean, store: DisposableStore): void {
		const row = append(parent, $('.claude-tool.is-success.is-file' + (open ? '.is-open' : '')));
		const summary = this.summaryButton(row, store, () => this.toggleCard(id, turnId));
		summary.setAttribute('aria-expanded', open ? 'true' : 'false');
		append(summary, $(ThemeIcon.asCSSSelector(Codicon.files) + '.status'));
		append(summary, $('span.verb')).textContent = localize('claudeVerbRead', "Read");
		summary.append(' ');
		append(summary, $('span.target')).textContent = localize('claudeReadFiles', "{0} files", cards.length);
		append(summary, $('span.meta')).appendChild($(ThemeIcon.asCSSSelector(Codicon.chevronRightCompact) + '.chev'));
		if (!open) {
			return;
		}
		const body = append(row, $('.claude-tool-body'));
		body.id = `claude-tool-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
		summary.setAttribute('aria-controls', body.id);
		const list = append(body, $('ul.claude-result-list'));
		for (const card of cards) {
			const path = card.file ?? card.target;
			const item = append(list, $('li'));
			const link = append(item, $<HTMLButtonElement>('button.claude-result-link'));
			link.type = 'button';
			// An image the user attached reads by its own name, never its stored id (issue 744).
			const attached = this._sentImages.labelFor(path);
			const { name, folder } = attached ? { name: attached, folder: '' } : splitPath(this.displayPath(path));
			link.setAttribute('aria-label', localize('claudeOpenRead', "Open {0}", attached ?? this.displayPath(path)));
			append(link, $(ThemeIcon.asCSSSelector(attached ? Codicon.fileMedia : Codicon.file)));
			append(link, $('span.file')).textContent = name;
			if (card.meta) {
				append(link, $('span.line')).textContent = card.meta;
			}
			if (folder) {
				append(link, $('span.folder')).textContent = folder;
			}
			store.add(addDisposableListener(link, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				this.openPath(path, firstLine(card.range));
			}));
		}
	}

	private renderSubagents(parent: HTMLElement, subagents: readonly SubagentViewModel[], store: DisposableStore): void {
		const wrap = append(parent, $('.claude-subagent-group'));
		wrap.setAttribute('aria-label', subagents.length > 1 ? localize('claudeParallelSubagents', "{0} subagents", subagents.length) : localize('claudeSubagent', "Subagent"));
		for (const subagent of subagents) {
			this.renderSubagentCard(wrap, subagent, store);
		}
	}

	/** A subagent: its state in the icon, "1 tool · 4s", and its latest step or result on one line. */
	private renderSubagentCard(parent: HTMLElement, subagent: SubagentViewModel, store: DisposableStore): void {
		const run = subagent.run;
		const live = run.state === 'running';
		const card = append(parent, $('.claude-subagent' + (live ? '.is-running' : run.state === 'failed' ? '.is-failed' : run.state === 'stopped' ? '.is-stopped' : '.is-success')));
		card.setAttribute('data-run-id', run.id);
		this._subagentCards.set(run.id, card);
		store.add(toDisposable(() => {
			if (this._subagentCards.get(run.id) === card) {
				this._subagentCards.delete(run.id);
			}
		}));
		card.draggable = true;
		store.add(addDisposableListener(card, 'dragstart', event => {
			const drag = event as DragEvent;
			drag.stopPropagation();
			if (this._dragSessionId) {
				drag.dataTransfer?.setData(CLAUDE_CHAT_DRAG_MIME, encodeChatDrag({
					sessionId: this._dragSessionId,
					subagentId: run.id,
					asOfTurn: this.turnIndex(subagent.parentTurnId),
				}));
			}
		}));
		const open = append(card, $<HTMLButtonElement>('button.claude-subagent-open'));
		open.type = 'button';
		const now = Date.now();
		const elapsedText = formatElapsed(run.startedAt, run.endedAt, now);
		const lastOutputAt = this.noteOutput(run.id, `${run.toolCallCount} ${subagent.latestTool ?? ''}`, run.startedAt, now);
		const metaText = describeSubagentMeta(run.toolCallCount, elapsedText, live ? describeQuiet(lastOutputAt, now) : undefined);
		const stateText = subagentStateLabel(run.state);
		open.setAttribute('aria-label', localize('claudeOpenSubagentNamed', "Open {0}: {1}, {2}, {3}", claudeSubagentKindLabel(run.agentType), run.description, stateText, metaText));
		// A finished command shows a terminal, a finished subagent a chat bubble, so the kinds stay apart (issue 1258).
		const icon = live ? Codicon.loading : run.state === 'failed' ? Codicon.error : run.state === 'stopped' ? Codicon.debugStop : isBackgroundCommand(run.agentType) ? Codicon.terminal : Codicon.commentDiscussion;
		append(open, $(ThemeIcon.asCSSSelector(icon) + (live ? '.codicon-modifier-spin' : '') + '.status'));
		const text = append(open, $('span.body'));
		const head = append(text, $('span.head'));
		append(head, $('span.verb')).textContent = claudeSubagentKindLabel(run.agentType);
		head.append(' ');
		append(head, $('span.target')).textContent = run.description;
		const meta = append(head, $('span.meta.claude-elapsed'));
		meta.textContent = metaText;
		this._elapsedNodes.set(run.id, { node: meta, startedAt: run.startedAt, endedAt: run.endedAt, toolCount: run.toolCallCount });
		store.add({ dispose: () => { if (this._elapsedNodes.get(run.id)?.node === meta) { this._elapsedNodes.delete(run.id); } } });
		if (live) {
			this.ensureElapsedTimer();
		}
		const line = live ? subagent.latestTool : run.resultText;
		if (line) {
			append(text, $('span.latest')).textContent = line;
		}
		store.add(addDisposableListener(open, EventType.CLICK, () => this._callbacks.openSubagent(run.id)));
		const stuck = live && isBackgroundCommand(run.agentType) ? describeStillRunning(now - run.startedAt) : undefined;
		if (stuck) {
			// A command that has run this long may be hung: say so and make Stop the main action (issue 1247).
			append(text, $('span.latest')).textContent = stuck;
			const stopMain = append(card, $<HTMLButtonElement>('button.claude-btn.is-small.is-primary'));
			stopMain.type = 'button';
			stopMain.textContent = localize('claudeStopSubagent', "Stop");
			stopMain.setAttribute('aria-label', localize('claudeStopSubagentNamed', "Stop {0}", claudeSubagentKindLabel(run.agentType)));
			store.add(addDisposableListener(stopMain, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				this._callbacks.stopSubagent(run.id);
			}));
		} else if (live) {
			const stop = append(card, $<HTMLButtonElement>('button.claude-icon-btn'));
			stop.type = 'button';
			stop.title = localize('claudeStopSubagent', "Stop");
			stop.setAttribute('aria-label', localize('claudeStopSubagentNamed', "Stop {0}", claudeSubagentKindLabel(run.agentType)));
			append(stop, $(ThemeIcon.asCSSSelector(Codicon.debugStop)));
			store.add(addDisposableListener(stop, EventType.CLICK, event => {
				event.preventDefault();
				event.stopPropagation();
				this._callbacks.stopSubagent(run.id);
			}));
		}
	}

	/** Records a run's output signature and returns when it last changed. */
	private noteOutput(runId: string, signature: string, startedAt: number, now: number): number {
		const previous = this._lastOutput.get(runId);
		if (previous?.signature === signature) {
			return previous.at;
		}
		// First sight of a run with no output yet: it has been silent since it started.
		const at = previous || signature !== '0 ' ? now : startedAt;
		this._lastOutput.set(runId, { signature, at });
		return at;
	}

	private ensureElapsedTimer(): void {
		if (this._elapsedHandle !== undefined) {
			return;
		}
		const targetWindow = getWindow(this._root);
		this._elapsedHandle = targetWindow.setInterval(() => {
			const now = Date.now();
			let live = false;
			for (const [id, item] of this._elapsedNodes) {
				if (item.endedAt === undefined) {
					live = true;
					const lastOutputAt = this._lastOutput.get(id)?.at ?? item.startedAt;
					item.node.textContent = describeSubagentMeta(item.toolCount, formatElapsed(item.startedAt, undefined, now), describeQuiet(lastOutputAt, now));
				}
			}
			// Every shown subagent has ended: stop ticking until one runs again.
			if (!live) {
				this.stopElapsedTimer();
			}
		}, 1000);
	}

	private stopElapsedTimer(): void {
		if (this._elapsedHandle !== undefined) {
			getWindow(this._root).clearInterval(this._elapsedHandle);
			this._elapsedHandle = undefined;
		}
	}

	/** True while the subagent elapsed timer ticks. For tests. */
	get elapsedTimerRunning(): boolean {
		return this._elapsedHandle !== undefined;
	}

	private cardOpen(id: string, byDefault: boolean): boolean {
		if (!this._toggledCards.has(id)) {
			if (byDefault) {
				this._openCards.add(id);
			} else {
				this._openCards.delete(id);
			}
		}
		return this._openCards.has(id);
	}

	/**
	 * Opens or closes one card. Only the turn that shows it is reconciled, and only that card changes.
	 * `turnId` names that turn for cards whose id is scoped to it; a tool card's id is unique on its own.
	 */
	private toggleCard(id: string, turnId?: string): void {
		this._toggledCards.add(id);
		if (this._openCards.has(id)) {
			this._openCards.delete(id);
		} else {
			this._openCards.add(id);
		}
		const owner = turnId !== undefined ? this._entries.get(turnId) : undefined;
		if (owner) {
			this.paintTurn(owner);
			return;
		}
		for (const entry of this._entries.values()) {
			if (entry.blocks.has(`tool:${id}`) || entry.blocks.has(id)) {
				this.paintTurn(entry);
				return;
			}
		}
	}

	private summaryButton(parent: HTMLElement, store: DisposableStore, toggle: () => void): HTMLButtonElement {
		const summary = append(parent, $<HTMLButtonElement>('button.claude-tool-row'));
		summary.type = 'button';
		store.add(addDisposableListener(summary, EventType.CLICK, event => {
			event.preventDefault();
			toggle();
		}));
		return summary;
	}

	private iconAction(parent: HTMLElement, store: DisposableStore, icon: ThemeIcon, label: string, run: () => void): HTMLButtonElement {
		const button = append(parent, $<HTMLButtonElement>('button.claude-icon-btn'));
		button.type = 'button';
		button.title = label;
		button.setAttribute('aria-label', label);
		append(button, $(ThemeIcon.asCSSSelector(icon)));
		store.add(addDisposableListener(button, EventType.CLICK, event => {
			event.preventDefault();
			event.stopPropagation();
			run();
		}));
		return button;
	}

	/** The review file an edit card changed, when that turn's review is loaded. */
	private reviewFileFor(turnId: string, card: ToolCardModel): ReviewFile | undefined {
		const review: TurnReview | undefined = this._callbacks.review?.get(turnId);
		return review?.files.find(file => matchesCardFile(file.uri.path, card.file) || matchesCardFile(file.uri.fsPath, card.file));
	}

	/** A path relative to the workspace folder that holds it, or the path as given. */
	private displayPath(path: string): string {
		return workspaceRelativePath(path, this.workspaceRoots(), isLinux);
	}

	/** The folder of `uri` relative to the workspace, as the change rows show it. */
	displayFolder(uri: URI): string {
		return workspaceRelativeFolder(dirname(uri).fsPath, this.workspaceRoots(), isLinux);
	}

	private workspaceRoots(): string[] {
		return this._workspace.getWorkspace().folders.map(folder => folder.uri.fsPath);
	}

	private openPath(path: string, line: number | undefined): void {
		const open = isAbsolute(path)
			? this._editors.openEditor({ resource: URI.file(path), options: { selection: { startLineNumber: line ?? 1, startColumn: 1 } } }).then(() => undefined)
			: this.openReference(path.replace(/\\/g, '/'), line ?? 1, undefined);
		void open.catch(error => this._notifications.error(error instanceof Error ? error.message : String(error)));
	}

	/**
	 * @param diagrams Set for replies: finished ```mermaid and chart fences are drawn (issue 492).
	 * @param foldKey Set for replies: names their folded sections, so a repaint keeps the ones the user opened.
	 */
	private renderMarkdown(target: HTMLElement, text: string, store: DisposableStore, diagrams?: { readonly live: boolean }, foldKey?: string): HTMLElement {
		const segments = splitClaudeFoldedMarkdown(text);
		if (segments.length === 1 && segments[0].kind === 'markdown') {
			return this.renderMarkdownRun(target, text, store, diagrams);
		}
		// `<details>` sections draw collapsed under their summary (issue 462, DL-66). The Markdown renderer drops raw HTML.
		const host = append(target, $('.claude-folds'));
		segments.forEach((segment, index) => {
			if (segment.kind === 'markdown') {
				this.renderMarkdownRun(host, segment.text, store, diagrams);
				return;
			}
			const key = foldKey ? `${foldKey}:fold:${index}` : undefined;
			const fold = append(host, $<HTMLDetailsElement>('details.claude-fold'));
			fold.open = (key ? this._folds.get(key) : undefined) ?? segment.open;
			const summary = append(fold, $('summary.claude-fold-summary'));
			append(summary, $(ThemeIcon.asCSSSelector(Codicon.chevronRight) + '.chev'));
			append(summary, $('span.text')).textContent = segment.summary || localize('claudeFoldDetails', "Details");
			this.renderMarkdown(append(fold, $('.claude-fold-body')), segment.body, store, diagrams, key);
			if (key) {
				store.add(addDisposableListener(fold, 'toggle', () => this._folds.set(key, fold.open)));
			}
		});
		return host;
	}

	private renderMarkdownRun(target: HTMLElement, text: string, store: DisposableStore, diagrams?: { readonly live: boolean }): HTMLElement {
		const rendered = this._markdown.render(new MarkdownString(text, { isTrusted: false, supportThemeIcons: false }), {
			codeBlockRendererSync: (languageId, value) => (diagrams && this._diagrams.render(languageId, value, diagrams.live, store)) || this.renderCodeBlock(languageId, value, store),
			transformUri: (href, kind) => kind === 'link' && parseWorkspacePath(safeDecode(href)) ? PATH_LINK + encodeURIComponent(safeDecode(href)) : href,
			actionHandler: link => this.openMarkdownLink(link),
		});
		store.add(rendered);
		this.linkifyFileReferences(rendered.element, store);
		this.linkifyCodePaths(rendered.element, store);
		target.appendChild(rendered.element);
		return rendered.element;
	}

	private renderCodeBlock(languageId: string, value: string, store: DisposableStore): HTMLElement {
		const block = $('.claude-codeblock');
		const header = append(block, $('.claude-codeblock-header.show-file-icons'));
		// The fence names a language by alias (`ts`, `typescript`); the editor knows it by id.
		const language = languageId ? this._languages.getLanguageIdByLanguageName(languageId) : null;
		if (languageId) {
			const label = store.add(new IconLabel(append(header, $('span.path'))));
			label.setLabel(languageId, undefined, { extraClasses: language ? getIconClassesForLanguageId(language) : [] });
		}
		append(header, $('span.spacer'));
		const code = value.replace(/\n$/, '');
		// DL-81: a shell block runs in the integrated terminal on the user's click, through the re-run checks (issue 733).
		const command = shellCommandFromBlock(languageId, code);
		if (command) {
			this.codeAction(header, store, Codicon.terminal, localize('claudeRunInTerminal', "Run in Terminal"), () => this.runInTerminal(command));
		}
		this.codeAction(header, store, Codicon.insert, localize('claudeInsertCode', "Insert at cursor"), () => this.insertIntoEditor(code));
		this.codeAction(header, store, Codicon.copy, localize('claudeCopyCode', "Copy"), () => this._clipboard.writeText(code));
		const pre = append(block, $('pre'));
		const codeElement = append(pre, $('code'));
		codeElement.textContent = code;
		if (language) {
			void this.colorizeCode(codeElement, code, language, store);
		}
		return block;
	}

	/** Swaps the plain code for the editor tokenizer's runs, which the editor theme colors. */
	private async colorizeCode(target: HTMLElement, code: string, language: string, store: DisposableStore): Promise<void> {
		const support = await TokenizationRegistry.getOrCreate(language);
		if (!support || store.isDisposed) {
			return;
		}
		const nodes: Node[] = [];
		tokenizeCodeLines(code, this._languages.languageIdCodec, support).forEach((runs, index) => {
			if (index > 0) {
				nodes.push(target.ownerDocument.createTextNode('\n'));
			}
			for (const run of runs) {
				const span = $('span');
				span.className = run.className;
				span.textContent = run.text;
				nodes.push(span);
			}
		});
		target.replaceChildren(...nodes);
	}

	/** Sends a command from a reply to a new integrated terminal in the session's folder; the re-run checks still apply. */
	private runInTerminal(command: string): void {
		this._callbacks.rerunCommand(command, this._callbacks.workingDirectory?.());
	}

	private codeAction(parent: HTMLElement, store: DisposableStore, icon: ThemeIcon, label: string, run: () => void | Promise<void>): HTMLButtonElement {
		const button = append(parent, $<HTMLButtonElement>('button.claude-icon-btn'));
		button.type = 'button';
		button.title = label;
		button.setAttribute('aria-label', label);
		append(button, $(ThemeIcon.asCSSSelector(icon)));
		store.add(addDisposableListener(button, EventType.CLICK, event => {
			event.preventDefault();
			void Promise.resolve(run()).catch(error => this._notifications.error(error instanceof Error ? error.message : String(error)));
		}));
		return button;
	}

	private insertIntoEditor(code: string): void {
		const editor = this._codeEditors.getFocusedCodeEditor() ?? this._codeEditors.getActiveCodeEditor();
		if (!editor || !editor.hasModel() || editor.getOption(EditorOption.readOnly)) {
			this._notifications.info(localize('claudeInsertNoEditor', "Open an editable file to insert code."));
			return;
		}
		const selection = editor.getSelection();
		if (!selection) {
			return;
		}
		editor.pushUndoStop();
		editor.executeEdits('claude.insertCode', [{ range: selection, text: code, forceMoveMarkers: true }]);
		editor.pushUndoStop();
		editor.focus();
	}

	/** Turns `src/x.ts:42` in text into keyboard-reachable editor links. Code stays plain. */
	private linkifyFileReferences(root: HTMLElement, store: DisposableStore): void {
		const targetWindow = getWindow(root);
		const walker = targetWindow.document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: node => {
				for (let parent = node.parentElement; parent && parent !== root; parent = parent.parentElement) {
					const tag = parent.tagName;
					if (tag === 'PRE' || tag === 'CODE' || tag === 'A' || tag === 'BUTTON' || parent.classList.contains('claude-file-link') || parent.classList.contains('claude-codeblock')) {
						return NodeFilter.FILTER_REJECT;
					}
				}
				return NodeFilter.FILTER_ACCEPT;
			},
		});
		const nodes: Text[] = [];
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			nodes.push(node as Text);
		}
		for (const node of nodes) {
			const text = node.data;
			const matches = findFileReferences(text);
			if (matches.length === 0) {
				continue;
			}
			const fragment = targetWindow.document.createDocumentFragment();
			let cursor = 0;
			for (const match of matches) {
				fragment.append(text.slice(cursor, match.start));
				const link = $('span');
				link.textContent = text.slice(match.start, match.end);
				this.makeLink(link, store, () => this.openReference(match.path, match.line, match.column));
				fragment.append(link);
				cursor = match.end;
			}
			fragment.append(text.slice(cursor));
			node.replaceWith(fragment);
		}
	}

	/**
	 * Turns inline code that names a file or folder in the workspace (`src/words.js`,
	 * `SPEC.md`, `src/`) into a link. Code blocks stay plain, and a path that does not
	 * exist, or a folder outside the workspace, stays a plain chip.
	 */
	private linkifyCodePaths(root: HTMLElement, store: DisposableStore): void {
		const walker = getWindow(root).document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
			acceptNode: node => {
				const element = node as HTMLElement;
				const tag = element.tagName;
				if (tag === 'PRE' || tag === 'A' || element.classList.contains('claude-codeblock') || element.classList.contains('claude-file-link')) {
					return NodeFilter.FILTER_REJECT;
				}
				return tag === 'CODE' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
			},
		});
		const codes: HTMLElement[] = [];
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			codes.push(node as HTMLElement);
		}
		for (const code of codes) {
			const reference = parseWorkspacePath(code.textContent ?? '');
			if (!reference) {
				// DL-81: inline code that reads as a command gets a quiet Run in Terminal button after it (issue 733).
				const command = inlineShellCommand(code.textContent ?? '');
				if (command && code.parentElement) {
					const holder = $('span.claude-inline-command');
					code.replaceWith(holder);
					holder.append(code);
					const run = this.codeAction(holder, store, Codicon.terminal, localize('claudeRunCommandInTerminal', "Run {0} in Terminal", command), () => this.runInTerminal(command));
					run.classList.add('claude-inline-run');
				}
				continue;
			}
			void this.resolvePath(reference).then(resolved => {
				if (resolved && this.canOpen(resolved) && !store.isDisposed && code.isConnected) {
					this.makeLink(code, store, () => this.openResolved(resolved, reference));
				}
			});
		}
	}

	private makeLink(element: HTMLElement, store: DisposableStore, open: () => Promise<void>): void {
		element.classList.add('claude-file-link');
		element.setAttribute('role', 'link');
		element.tabIndex = 0;
		const run = () => {
			void open().catch(error => this._notifications.error(error instanceof Error ? error.message : String(error)));
		};
		store.add(addDisposableListener(element, EventType.CLICK, run));
		store.add(addDisposableListener(element, EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				run();
			}
		}));
	}

	/** Opens a link in a reply: workspace paths in the editor or the Explorer, web links through the opener. */
	private openMarkdownLink(link: string): void {
		const run = async () => {
			if (link.startsWith(PATH_LINK)) {
				const reference = parseWorkspacePath(safeDecode(link.slice(PATH_LINK.length)));
				if (reference) {
					await this.openPathReference(reference);
				}
				return;
			}
			const uri = URI.parse(link);
			if (uri.scheme === Schemas.file) {
				const line = /^L(?<line>\d{1,8})/.exec(uri.fragment)?.groups?.line;
				const resource = uri.with({ fragment: '' });
				const resolved = await this.isInSearchRoots(resource) ? await this.statPath(resource) : undefined;
				if (!resolved) {
					this._notifications.info(localize('claudeFileRefMissing', "{0} is not in the open workspace.", resource.fsPath));
					return;
				}
				await this.openResolved(resolved, { path: resource.fsPath, absolute: true, folder: resolved.isDirectory, line: line ? Number(line) : undefined, column: undefined });
				return;
			}
			await openLinkFromMarkdown(this._opener, link, false);
		};
		void run().catch(error => this._notifications.error(error instanceof Error ? error.message : String(error)));
	}

	private async openPathReference(reference: WorkspacePathReference): Promise<void> {
		const resolved = await this.resolvePath(reference);
		if (!resolved) {
			this._notifications.info(localize('claudeFileRefMissing', "{0} is not in the open workspace.", reference.path));
			return;
		}
		await this.openResolved(resolved, reference);
	}

	/**
	 * Whether a found path can open: a file, or a folder the Explorer can show. A folder
	 * outside the workspace (a background agent's worktree, the plan folder) cannot be
	 * revealed there, so it stays plain.
	 */
	private canOpen(resolved: ResolvedPath): boolean {
		return !resolved.isDirectory || !!this._workspace.getWorkspaceFolder(resolved.resource);
	}

	private async openResolved(resolved: ResolvedPath, reference: WorkspacePathReference): Promise<void> {
		if (!this.canOpen(resolved)) {
			this._notifications.info(localize('claudeFolderRefOutside', "{0} is a folder outside the open workspace.", reference.home ? `~/${reference.path}` : reference.path));
			return;
		}
		if (resolved.isDirectory) {
			await this._commands.executeCommand('revealInExplorer', resolved.resource);
			return;
		}
		const plan = resolved.resource.path.endsWith('.md') && this._uriIdentity.extUri.isEqual(dirname(resolved.resource), await this.plansFolder());
		await this._editors.openEditor({
			resource: resolved.resource,
			options: plan ? { override: CLAUDE_PLAN_EDITOR_ID } : reference.line ? { selection: { startLineNumber: reference.line, startColumn: reference.column ?? 1 } } : undefined,
		});
	}

	/**
	 * Finds a path named in a reply. A relative path is looked up in the folders the
	 * session worked in, then in the workspace folders ({@link searchRoots}); an
	 * absolute path must be inside one of them or in Klawly's plan folder, and a home
	 * path (`~/`) in the plan folder.
	 */
	private resolvePath(reference: WorkspacePathReference): Promise<ResolvedPath | undefined> {
		const key = `${reference.home ? 'home' : reference.absolute ? 'abs' : 'rel'}:${reference.path}`;
		const cached = this._resolvedPaths.get(key);
		if (cached && (cached.found !== false || Date.now() - cached.time < MISSING_PATH_TTL)) {
			return cached.result;
		}
		const lookup = async (): Promise<ResolvedPath | undefined> => {
			if (reference.home) {
				const resource = joinPath(await this._paths.userHome(), ...reference.path.split('/'));
				return this._uriIdentity.extUri.isEqualOrParent(resource, await this.plansFolder()) ? this.statPath(resource) : undefined;
			}
			if (reference.absolute) {
				const resource = URI.file(reference.path);
				return await this.isInSearchRoots(resource) ? this.statPath(resource) : undefined;
			}
			const segments = reference.path.split('/');
			for (const root of await this.searchRoots()) {
				const found = await this.statPath(joinPath(root, ...segments));
				if (found) {
					return found;
				}
			}
			return undefined;
		};
		const entry: PathLookup = { result: lookup(), time: Date.now() };
		void entry.result.then(found => entry.found = !!found);
		this._resolvedPaths.set(key, entry);
		return entry.result;
	}

	/** Keeps {@link _workFolders} in step with the session. When they change, paths are looked up again. */
	private updateWorkFolders(state: AgentViewState): void {
		if (!this._workState || state.turns !== this._workState.turns || state.subagents !== this._workState.subagents) {
			this._workState = state;
			this._workFolders = sessionWorkFolders([...state.turns, ...state.subagents.map(subagent => subagent.chat)]);
		}
		const folders = [...this._workFolders.changed, ...this._workFolders.read];
		const key = [this._callbacks.workingDirectory?.() ?? '', ...folders.map(folder => folder.toString())].join('\n');
		if (key !== this._workKey) {
			this._workKey = key;
			this._resolvedPaths.clear();
		}
	}

	/**
	 * Where reply paths are looked up, in order: the session's working directory; the
	 * repositories of the files it changed; the git worktrees of the files it only read;
	 * the workspace folders; the other repositories of the files it only read. Newer work
	 * comes first, so a session working in a git worktree links the worktree's files even
	 * before it writes one (issue 321), while a look at a file in another checkout does
	 * not take the workspace's own paths over.
	 */
	private async searchRoots(): Promise<URI[]> {
		const workingDirectory = this._callbacks.workingDirectory?.();
		const changed = await Promise.all(this._workFolders.changed.slice(0, MAX_WORK_FOLDERS).map(folder => this.repoRoot(folder)));
		const read = await Promise.all(this._workFolders.read.slice(0, MAX_WORK_FOLDERS).map(folder => this.repoRoot(folder)));
		const roots: URI[] = [];
		for (const root of [
			workingDirectory ? URI.file(workingDirectory) : undefined,
			...changed.map(repo => repo?.resource),
			...read.filter(repo => repo?.worktree).map(repo => repo?.resource),
			...this._workspace.getWorkspace().folders.map(folder => folder.uri),
			...read.filter(repo => !repo?.worktree).map(repo => repo?.resource),
		]) {
			if (root && !roots.some(known => isEqual(known, root))) {
				roots.push(root);
			}
		}
		return roots;
	}

	/**
	 * Whether an absolute path in a reply may link: it is in a {@link searchRoots search root} or in Klawly's plan folder.
	 * Compared as the file system does, so `c:\` from a path Claude was handed matches the home folder's `C:\`.
	 */
	private async isInSearchRoots(resource: URI): Promise<boolean> {
		const extUri = this._uriIdentity.extUri;
		return !!this._workspace.getWorkspaceFolder(resource)
			|| (await this.searchRoots()).some(root => extUri.isEqualOrParent(resource, root))
			|| extUri.isEqualOrParent(resource, await this.plansFolder());
	}

	/** Klawly's plan folder for this user (issue 322). Plans there link from replies and open in the plan editor. */
	private plansFolder(): Promise<URI> {
		return userPlansFolder(this._paths, this._product);
	}

	/**
	 * The nearest folder at or above `folder` that holds `.git` (a repository or a
	 * worktree). The search stops at a workspace folder, which is then the root.
	 */
	private repoRoot(folder: URI): Promise<RepoRoot | undefined> {
		const key = folder.toString();
		let root = this._repoRoots.get(key);
		if (!root) {
			root = this.findRepoRoot(folder);
			this._repoRoots.set(key, root);
		}
		return root;
	}

	private async findRepoRoot(folder: URI): Promise<RepoRoot | undefined> {
		const workspaceFolders = this._workspace.getWorkspace().folders.map(workspaceFolder => workspaceFolder.uri);
		let current = folder;
		for (let depth = 0; depth < MAX_ROOT_DEPTH; depth++) {
			const git = await this.statPath(joinPath(current, '.git'));
			if (git || workspaceFolders.some(workspaceFolder => isEqual(workspaceFolder, current))) {
				return { resource: current, worktree: !!git && !git.isDirectory && await this.isLinkedWorktree(git.resource) };
			}
			const parent = dirname(current);
			if (isEqual(parent, current)) {
				return undefined;
			}
			current = parent;
		}
		return undefined;
	}

	/**
	 * Whether a `.git` file points into the `worktrees` folder of a repository's git directory.
	 * A submodule's `.git` is a file too, but it points into `modules`: its reads rank as another checkout's.
	 */
	private async isLinkedWorktree(gitFile: URI): Promise<boolean> {
		try {
			const content = await this._files.readFile(gitFile, { length: MAX_GIT_FILE_BYTES });
			const gitDir = /^gitdir:\s*(?<path>.+?)\s*$/m.exec(content.value.toString())?.groups?.path;
			return !!gitDir && /\/worktrees\/[^/]+\/?$/.test(gitDir.replace(/\\/g, '/'));
		} catch {
			return false;
		}
	}

	private async statPath(resource: URI): Promise<ResolvedPath | undefined> {
		try {
			const stat = await this._files.stat(resource);
			return { resource: stat.resource, isDirectory: stat.isDirectory };
		} catch {
			return undefined;
		}
	}

	private async openReference(path: string, line: number, column: number | undefined): Promise<void> {
		const resolved = await this.resolvePath({ path, absolute: false, folder: false, line, column });
		if (!resolved || resolved.isDirectory) {
			this._notifications.info(localize('claudeFileRefMissing', "{0} is not in the open workspace.", path));
			return;
		}
		await this._editors.openEditor({
			resource: resolved.resource,
			options: { selection: { startLineNumber: line, startColumn: column ?? 1 } },
		});
	}
}

/** The icon of a chip a message was sent with (issue 759). */
function sentChipIcon(kind: SentChip['kind']): ThemeIcon {
	switch (kind) {
		case 'folder': return Codicon.folder;
		case 'symbol': return Codicon.symbolMethod;
		case 'selection': return Codicon.listSelection;
		case 'git-diff': return Codicon.gitCompare;
		case 'terminal': return Codicon.terminal;
		case 'chat': return Codicon.commentDiscussion;
		default: return Codicon.file;
	}
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Where the streaming caret goes: the end of the last paragraph or list item,
 * so it sits on the text's last line instead of dropping onto its own.
 */
function caretHost(rendered: HTMLElement): HTMLElement {
	let host = rendered;
	for (let last = host.lastElementChild; isHTMLElement(last); last = host.lastElementChild) {
		const tag = last.tagName;
		if (tag === 'P' || tag === 'LI' || /^H[1-6]$/.test(tag)) {
			host = last;
			continue;
		}
		if (tag === 'UL' || tag === 'OL' || tag === 'BLOCKQUOTE' || tag === 'DIV' && !last.classList.contains('claude-codeblock')) {
			host = last;
			continue;
		}
		break;
	}
	return host;
}

function sameList(left: readonly SubagentViewModel[], right: readonly SubagentViewModel[]): boolean {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * What a subagent card shows. A child's streamed text changes its chat but not
 * its card, so the group is not rebuilt on every child delta.
 */
function subagentCardDeps(subagent: SubagentViewModel): readonly unknown[] {
	const run = subagent.run;
	return [run.id, run.state, run.agentType, run.description, run.startedAt, run.endedAt, run.toolCallCount, run.resultText, subagent.latestTool, subagent.parentTurnId, run.endedAt === undefined && isBackgroundCommand(run.agentType) && !!describeStillRunning(Date.now() - run.startedAt)];
}

function sameDeps(left: readonly unknown[], right: readonly unknown[]): boolean {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

function descendantsOfRun(runId: string, subagents: readonly SubagentViewModel[]): SubagentViewModel[] {
	const children = subagents.filter(subagent => subagent.run.parentRunId === runId);
	return [...children, ...children.flatMap(child => descendantsOfRun(child.run.id, subagents))];
}

function firstLine(range: string | undefined): number | undefined {
	const match = range ? /(?<line>\d+)/.exec(range) : null;
	return match?.groups?.line ? Number(match.groups.line) : undefined;
}

function subagentStateLabel(state: SubagentViewModel['run']['state']): string {
	switch (state) {
		case 'running': return localize('claudeSubagentRunning', "running");
		case 'failed': return localize('claudeSubagentFailed', "failed");
		case 'stopped': return localize('claudeSubagentStopped', "stopped");
		case 'success': return localize('claudeSubagentDone', "done");
	}
}

/** The numbered badge in front of plan step `index` (zero based). The list is an `ol`, so it is hidden from screen readers. */
function appendStepNumber(row: HTMLElement, index: number): void {
	const badge = append(row, $('span.state.number'));
	badge.setAttribute('aria-hidden', 'true');
	badge.textContent = String(index + 1);
}

function tendEndIcon(end: ClaudeTendEnd): ThemeIcon {
	switch (end.reason) {
		case 'clean': return Codicon.passFilled;
		case 'merged': return Codicon.gitMerge;
		case 'closed': return Codicon.gitPullRequestClosed;
		case 'ghProblem': return Codicon.warning;
		default: return Codicon.eyeClosed;
	}
}
