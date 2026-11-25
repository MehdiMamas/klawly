/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode, getWindow } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../../editor/browser/editorExtensions.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { IEditorContribution } from '../../../../../editor/common/editorCommon.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { IModelDeltaDecoration, ITextModel } from '../../../../../editor/common/model.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IEditorPane, isDiffEditorInput } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import type { EditorInput } from '../../../../common/editor/editorInput.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { ClaudeNotebookSnapshotFileSystem } from '../../../../services/claude/common/claudeNotebookSnapshotFileSystem.js';
import { CLAUDE_NOTEBOOK_SNAPSHOT_SCHEME, CLAUDE_SNAPSHOT_SCHEME, claudeReviewOriginalUri, flatHunks, IClaudeReviewService, isNotebookReviewFile, lastChangedLine, ReviewConflictError, ReviewFile, ReviewHunk, ReviewHunkRef } from '../../../../services/claude/common/claudeReview.js';
import { CLAUDE_AGENT_ENABLED } from '../../common/claudeContextKeys.js';
import { groupHunksByCell, NotebookCellChange } from '../../../../services/claude/common/claudeNotebookReview.js';
import { CLAUDE_ACCEPT_ALL_CHANGES_COMMAND_ID, CLAUDE_REJECT_ALL_CHANGES_COMMAND_ID, CLAUDE_OPEN_REVIEW_EDITOR_COMMAND_ID, KLAWLY_CATEGORY } from '../../common/claudeViews.js';
import { ClaudeChangeNavigatorContribution, renderClaudeChangeNavigator } from './claudeChangeNavigator.js';
import { renderClaudeNotebookCellBar } from './claudeNotebookCellBar.js';
import { ClaudeHunkWidget } from './claudeHunkWidget.js';
import { CLAUDE_REVIEW_EDITOR } from './claudeReviewSource.js';
import { registerClaudeKeepAllCommands } from './claudeKeepAll.js';

export class ClaudeReviewPane extends Disposable {
	private readonly _listeners = this._register(new MutableDisposable<DisposableStore>());
	private readonly _inputListener = this._register(new MutableDisposable());
	private _overlay: HTMLElement | undefined;
	private _mountedInput: EditorInput | undefined;
	private _mountedGroup: IEditorGroup | undefined;
	private _snapshot: URI | undefined;
	private _conflict = false;

	constructor(
		@IEditorService private readonly _editors: IEditorService,
		@IModelService private readonly _models: IModelService,
		@IClaudeReviewService private readonly _review: IClaudeReviewService,
		@INotificationService private readonly _notifications: INotificationService,
		@ICommandService private readonly _commands: ICommandService,
		@IFileService private readonly _files: IFileService,
		@IKeybindingService private readonly _keybindings: IKeybindingService,
	) {
		super();
		this._register(this._review.onDidChangeReview(() => this.refreshBar()));
		this._register(this._review.onDidNavigate(target => {
			void this.openFile(target.sessionId, target.turnId, target.uri, false);
		}));
		this._register(this._editors.onDidCloseEditor(event => {
			if (this._mountedInput && event.editor === this._mountedInput) {
				this.releaseSnapshot(event.editor);
				this.clearBar();
			}
		}));
		this._register(this._editors.onDidActiveEditorChange(() => this.dropStaleOverlay()));
	}

	/**
	 * Opens `uri` of this turn in a review diff and mounts the bar on it. With
	 * `replacing`, the diff takes the place of that editor in its group instead.
	 */
	async openFile(sessionId: string, turnId: string, uri: URI, conflict: boolean, replacing?: { input: EditorInput; group: IEditorGroup }): Promise<void> {
		const review = this._review.get(sessionId, turnId);
		const file = review?.files.find(candidate => candidate.uri.toString() === uri.toString());
		if (!review || !file) {
			return;
		}
		this._conflict = conflict || file.state === 'conflicted';
		this._review.focus(sessionId, turnId);
		if (review.cursor < 0 || flatHunks(review)[review.cursor]?.uri.toString() !== uri.toString()) {
			const hunks = flatHunks(review);
			const match = hunks.findIndex(hunk => hunk.uri.toString() === uri.toString() && (hunk.state === 'pending' || hunk.state === 'conflicted'));
			review.cursor = match >= 0 ? match : hunks.findIndex(hunk => hunk.uri.toString() === uri.toString());
		}
		// A notebook opens in the notebook diff editor, which reads its left side from a file system (issue 526).
		const snapshot = claudeReviewOriginalUri(uri, sessionId, turnId);
		this._snapshot = snapshot;
		const diff = {
			original: { resource: snapshot },
			modified: { resource: uri },
			label: localize('claudeReviewLabel', "{0} (review)", file.name),
			options: { pinned: true },
		};
		let pane: IEditorPane | undefined;
		try {
			if (replacing) {
				await this._editors.replaceEditors([{ editor: replacing.input, replacement: diff }], replacing.group);
				// Closing the replaced diff released its snapshot and cleared the bar; opening the
				// replacement again only reveals it and hands back its pane.
				this._snapshot = snapshot;
				pane = await this._editors.openEditor(diff, replacing.group);
			} else {
				pane = await this._editors.openEditor(diff);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this._notifications.error(message);
			return;
		}
		if (!pane) {
			return;
		}
		const control = pane.getControl() as { getContainerDomNode?: () => HTMLElement; getDomNode?: () => HTMLElement } | undefined;
		// The notebook diff editor has no container node of its own; its root node is where the bar goes (DL-90).
		const container = typeof control?.getContainerDomNode === 'function' ? control.getContainerDomNode() : isNotebookReviewFile(uri) && typeof control?.getDomNode === 'function' ? control.getDomNode() : undefined;
		if (!container) {
			return;
		}
		this.mountBar(container, sessionId, turnId);
		this.watchInput(pane);
	}

	private mountBar(container: HTMLElement, sessionId: string, turnId: string): void {
		this.clearBar();
		const window = getWindow(container);
		if (window.getComputedStyle(container).position === 'static') {
			container.style.position = 'relative';
		}
		const overlay = append(container, $('.claude-review-overlay'));
		this._overlay = overlay;
		const store = new DisposableStore();
		this._listeners.value = store;
		this.paintBar(overlay, sessionId, turnId, store);
	}

	private refreshBar(): void {
		const focused = this._review.focused();
		if (!this._overlay || !focused || !this._overlay.isConnected) {
			return;
		}
		const store = new DisposableStore();
		clearNode(this._overlay);
		this.paintBar(this._overlay, focused.sessionId, focused.turnId, store);
		this._listeners.value = store;
	}

	private paintBar(overlay: HTMLElement, sessionId: string, turnId: string, store: DisposableStore): void {
		const review = this._review.get(sessionId, turnId);
		if (!review) {
			return;
		}
		const hunks = flatHunks(review);
		const current = review.cursor >= 0 ? hunks[review.cursor] : undefined;
		const file = current ? review.files.find(candidate => candidate.uri.toString() === current.uri.toString()) : undefined;
		if (this._conflict || file?.state === 'conflicted') {
			const banner = append(overlay, $('.claude-banner.is-warning'));
			banner.setAttribute('role', 'alert');
			append(banner, $(ThemeIcon.asCSSSelector(Codicon.warning)));
			const body = append(banner, $('.body'));
			append(body, $('.title')).textContent = localize('claudeConflictTitle', "Conflict review");
			append(body, $('.desc')).textContent = new ReviewConflictError().message;
		}
		const fileIndex = file ? review.files.findIndex(candidate => candidate.uri.toString() === file.uri.toString()) : -1;
		renderClaudeChangeNavigator(append(overlay, $('div')), {
			position: review.cursor >= 0 ? review.cursor + 1 : 1,
			total: hunks.length,
			file: file ? { name: file.name, index: fileIndex + 1, count: review.files.length } : undefined,
			previous: () => this._review.previous(sessionId, turnId),
			next: () => this._review.next(sessionId, turnId),
			change: {
				reject: () => this.runHunk(sessionId, turnId, 'reject'),
				accept: () => this.runHunk(sessionId, turnId, 'accept'),
			},
			rejectFile: () => {
				if (file) {
					void this.rejectFile(sessionId, turnId, file.uri);
				}
			},
			acceptFile: () => {
				if (file) {
					const settled = this.mountedReview(sessionId, turnId, file.uri);
					this._review.acceptFile(sessionId, turnId, file.uri);
					void this.leaveSettledFile(sessionId, turnId, file.uri, settled);
				}
			},
			nextFile: () => this.nextFile(sessionId, turnId),
			openReview: () => void this._commands.executeCommand(CLAUDE_OPEN_REVIEW_EDITOR_COMMAND_ID, sessionId, turnId),
		}, store);
		if (file && isNotebookReviewFile(file.uri)) {
			void this.paintNotebookCells(overlay, sessionId, turnId, file, store);
		}
	}

	/** Keep and Undo per changed cell, with Keep All and Undo All, on the notebook diff editor (DL-90). */
	private async paintNotebookCells(overlay: HTMLElement, sessionId: string, turnId: string, file: ReviewFile, store: DisposableStore): Promise<void> {
		let changes: NotebookCellChange[];
		try {
			changes = groupHunksByCell(file, (await this._files.readFile(file.uri)).value.toString());
		} catch {
			return;
		}
		if (store.isDisposed || !overlay.isConnected || changes.length === 0) {
			return;
		}
		const keys = (id: string) => this._keybindings.lookupKeybinding(id)?.getLabel() ?? undefined;
		renderClaudeNotebookCellBar(append(overlay, $('div')), changes, {
			keepCell: change => {
				for (const hunk of change.hunks) {
					this._review.acceptHunk(sessionId, turnId, hunk.id);
				}
			},
			undoCell: change => {
				void (async () => {
					for (const hunk of change.hunks) {
						await this.rejectHunk(sessionId, turnId, hunk);
					}
				})();
			},
			keepAll: () => {
				const settled = this.mountedReview(sessionId, turnId, file.uri);
				this._review.acceptFile(sessionId, turnId, file.uri);
				void this.leaveSettledFile(sessionId, turnId, file.uri, settled);
			},
			undoAll: () => void this.rejectFile(sessionId, turnId, file.uri),
			keepAllKeys: keys(CLAUDE_ACCEPT_ALL_CHANGES_COMMAND_ID),
			undoAllKeys: keys(CLAUDE_REJECT_ALL_CHANGES_COMMAND_ID),
			keepKeys: undefined,
			undoKeys: undefined,
		}, store);
	}

	private runHunk(sessionId: string, turnId: string, kind: 'accept' | 'reject'): void {
		const review = this._review.get(sessionId, turnId);
		const hunk = review && review.cursor >= 0 ? flatHunks(review)[review.cursor] : undefined;
		if (!hunk) {
			return;
		}
		if (kind === 'accept') {
			this._review.acceptHunk(sessionId, turnId, hunk.id);
			return;
		}
		void this.rejectHunk(sessionId, turnId, hunk);
	}

	private async rejectHunk(sessionId: string, turnId: string, hunk: ReviewHunk): Promise<void> {
		try {
			await this._review.rejectHunk(sessionId, turnId, hunk.id);
			this._conflict = false;
		} catch (error) {
			if (error instanceof ReviewConflictError) {
				this._conflict = true;
				await this.openFile(sessionId, turnId, hunk.uri, true);
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			this._notifications.error(message);
		}
	}

	private async rejectFile(sessionId: string, turnId: string, uri: URI): Promise<void> {
		// Undoing a file the turn created deletes it, which closes its review diff before the undo returns.
		const settled = this.mountedReview(sessionId, turnId, uri);
		try {
			await this._review.rejectFile(sessionId, turnId, uri);
			this._conflict = false;
		} catch (error) {
			if (error instanceof ReviewConflictError) {
				this._conflict = true;
				await this.openFile(sessionId, turnId, uri, true);
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			this._notifications.error(message);
			return;
		}
		await this.leaveSettledFile(sessionId, turnId, uri, settled);
	}

	/**
	 * Moves on from a file whose changes are all kept or undone (issue 350): the
	 * turn's next file with changes waiting takes the place of its review diff,
	 * or, when none is left, the plain file does (unless undoing removed it).
	 * A file with unsaved edits stays open as the plain file.
	 */
	private async leaveSettledFile(sessionId: string, turnId: string, uri: URI, settled: { input: EditorInput; group: IEditorGroup } | undefined): Promise<void> {
		const files = this._review.get(sessionId, turnId)?.files ?? [];
		const index = files.findIndex(candidate => isEqual(candidate.uri, uri));
		if (index < 0 || isWaiting(files[index]) || !settled) {
			return;
		}
		const next = [...files.slice(index + 1), ...files.slice(0, index)].find(isWaiting);
		const { input, group } = settled;
		if (!input.isDisposed()) {
			if (input.isDirty() || (!next && await this._files.exists(uri))) {
				// The diff's changed side is the live file. Swapping the diff for the plain file in
				// place keeps unsaved edits without the save prompt a close brings up (issue 349
				// never saves them), and keeps the group, which closing its only editor removes.
				await this._editors.replaceEditors([{ editor: input, replacement: { resource: uri, options: { pinned: true } }, forceReplaceDirty: true }], group);
			} else if (next) {
				// In place, so the next diff stays in this group: closing the group's only editor
				// would remove the group and open the diff over whichever group turns active.
				await this.openFile(sessionId, turnId, next.uri, next.state === 'conflicted', settled);
				return;
			} else {
				await group.closeEditor(input);
			}
		}
		if (next) {
			await this.openFile(sessionId, turnId, next.uri, next.state === 'conflicted');
		}
	}

	/** The review diff the bar is mounted on, when it shows `uri` of this turn. */
	private mountedReview(sessionId: string, turnId: string, uri: URI): { input: EditorInput; group: IEditorGroup } | undefined {
		const input = this._mountedInput;
		const group = this._mountedGroup;
		return input && group && isEqual(this._snapshot, claudeReviewOriginalUri(uri, sessionId, turnId)) ? { input, group } : undefined;
	}

	private nextFile(sessionId: string, turnId: string): void {
		const review = this._review.get(sessionId, turnId);
		if (!review || review.files.length === 0) {
			return;
		}
		const current = review.cursor >= 0 ? flatHunks(review)[review.cursor] : undefined;
		const index = current ? review.files.findIndex(file => file.uri.toString() === current.uri.toString()) : -1;
		const next = review.files[(index + 1) % review.files.length];
		void this.openFile(sessionId, turnId, next.uri, next.state === 'conflicted');
	}

	private watchInput(pane: IEditorPane): void {
		this._mountedInput = pane.input;
		this._mountedGroup = pane.group;
		this._inputListener.value = pane.input?.onWillDispose(() => {
			this.releaseSnapshot(pane.input);
			this.clearBar();
		});
	}

	private dropStaleOverlay(): void {
		if (!this._mountedInput || !this._overlay) {
			return;
		}
		const panes = this._editors.visibleEditorPanes;
		if (!panes.some(pane => pane.input === this._mountedInput)) {
			this.clearBar();
		}
	}

	private releaseSnapshot(editor: EditorInput | undefined): void {
		const fromDiff = editor && isDiffEditorInput(editor) ? editor.original.resource : undefined;
		const resource = fromDiff?.scheme === CLAUDE_SNAPSHOT_SCHEME ? fromDiff : this._snapshot;
		this._snapshot = undefined;
		if (resource?.scheme !== CLAUDE_SNAPSHOT_SCHEME) {
			return;
		}
		const model = this._models.getModel(resource);
		if (model && !model.isDisposed()) {
			model.dispose();
		}
	}

	private clearBar(): void {
		this._listeners.clear();
		this._inputListener.clear();
		this._mountedInput = undefined;
		this._mountedGroup = undefined;
		this._overlay?.remove();
		this._overlay = undefined;
	}

	override dispose(): void {
		this.clearBar();
		super.dispose();
	}
}

/** True when a file still has a change that is neither kept nor undone. */
function isWaiting(file: ReviewFile): boolean {
	return file.hunks.some(hunk => hunk.state === 'pending' || hunk.state === 'conflicted');
}

/** True when the cursor of a normal editor is in a pending Claude change, or on the line with its chips. */
export const CLAUDE_REVIEW_HUNK_AT_CURSOR = new RawContextKey<boolean>('klawly.reviewHunkAtCursor', false, localize('claudeReviewHunkAtCursor', "Whether the cursor is in a Claude change waiting for review"));

const CLAUDE_KEEP_HUNK_COMMAND_ID = 'klawly.review.keepHunkAtCursor';
const CLAUDE_UNDO_HUNK_COMMAND_ID = 'klawly.review.undoHunkAtCursor';

/**
 * Marks Claude's pending changes in an editor: a gutter bar everywhere, and in
 * a normal editor also a tint on the added lines and an Undo / Keep chip at the
 * top-right of each change (ai-16). The diff editor has its own review bar, so it gets no chips,
 * except in the review editor, which settles change by change (issue 355).
 */
export class ClaudeReviewDecorationContribution extends Disposable implements IEditorContribution {
	static readonly ID = 'claude.reviewDecorations';

	static get(editor: ICodeEditor): ClaudeReviewDecorationContribution | null {
		return editor.getContribution<ClaudeReviewDecorationContribution>(ClaudeReviewDecorationContribution.ID);
	}

	private readonly _decorations;
	private readonly _widgets = this._register(new DisposableMap<string, ClaudeHunkWidget>());
	private readonly _hunkAtCursor: IContextKey<boolean>;
	private _hunks: readonly ReviewHunkRef[] = [];

	constructor(
		private readonly _editor: ICodeEditor,
		@IClaudeReviewService private readonly _review: IClaudeReviewService,
		@IContextKeyService private readonly _contextKeys: IContextKeyService,
		@IKeybindingService private readonly _keybindings: IKeybindingService,
		@INotificationService private readonly _notifications: INotificationService,
	) {
		super();
		this._decorations = _editor.createDecorationsCollection();
		this._hunkAtCursor = CLAUDE_REVIEW_HUNK_AT_CURSOR.bindTo(_contextKeys);
		const update = () => this.apply();
		this._register(_editor.onDidChangeModel(update));
		this._register(_review.onDidChangeReview(update));
		this._register(_editor.onDidChangeCursorPosition(() => this.syncCursor()));
		this._register({ dispose: () => this._hunkAtCursor.reset() });
		update();
	}

	/** Keeps the change at the cursor. Returns false when there is none. */
	keepAtCursor(): boolean {
		const ref = this.hunkAtCursor();
		if (ref) {
			this.keep(ref);
		}
		return !!ref;
	}

	/** Undoes the change at the cursor. Returns false when there is none. */
	undoAtCursor(): boolean {
		const ref = this.hunkAtCursor();
		if (ref) {
			this.undo(ref);
		}
		return !!ref;
	}

	private apply(): void {
		const model = this._editor.getModel();
		if (!model) {
			this._hunks = [];
			this._decorations.clear();
			this._widgets.clearAndDisposeAll();
			this.syncCursor();
			return;
		}
		// The diff already colors the added lines, so only a normal editor gets the tint.
		const tint = !this._editor.getOption(EditorOption.inDiffEditor);
		const chips = this.hasChips();
		const decorations: IModelDeltaDecoration[] = [];
		const live = new Set<string>();
		this._hunks = this._review.hunksFor(model.uri);
		for (const ref of this._hunks) {
			const { hunk } = ref;
			const line = clamp(hunk.currentRange.startLineNumber, 1, model.getLineCount());
			const endLine = clamp(lastChangedLine(hunk.currentRange), line, model.getLineCount());
			const conflicted = hunk.state === 'conflicted';
			decorations.push({
				range: new Range(line, 1, endLine, 1),
				options: {
					description: 'claude-review-hunk',
					linesDecorationsClassName: conflicted ? 'claude-review-gutter is-conflict' : 'claude-review-gutter',
					className: tint && !conflicted && hunk.modifiedLength > 0 ? 'claude-review-added' : undefined,
					isWholeLine: true,
				},
			});
			if (!chips || conflicted) {
				continue;
			}
			const key = `${ref.sessionId}/${ref.turnId}/${hunk.id}`;
			live.add(key);
			const widget = this._widgets.get(key);
			if (widget) {
				widget.setLine(hunk.currentRange.startLineNumber);
			} else {
				this._widgets.set(key, new ClaudeHunkWidget(this._editor, hunk.currentRange.startLineNumber, {
					keep: () => this.keep(ref),
					undo: () => this.undo(ref),
					keepKeys: this._keybindings.lookupKeybinding(CLAUDE_KEEP_HUNK_COMMAND_ID)?.getLabel() ?? undefined,
					undoKeys: this._keybindings.lookupKeybinding(CLAUDE_UNDO_HUNK_COMMAND_ID)?.getLabel() ?? undefined,
				}));
			}
		}
		for (const key of [...this._widgets.keys()]) {
			if (!live.has(key)) {
				this._widgets.deleteAndDispose(key);
			}
		}
		this._decorations.set(decorations);
		this.syncCursor();
	}

	/** The pending change under the cursor, or the one that ends on the line above it. */
	private hunkAtCursor(): ReviewHunkRef | undefined {
		const position = this._editor.getPosition();
		if (!position || !this.hasChips()) {
			return undefined;
		}
		const line = position.lineNumber;
		return this._hunks.find(ref => ref.hunk.state === 'pending'
			&& line >= Math.min(ref.hunk.currentRange.startLineNumber, keyEndLine(ref.hunk.currentRange))
			&& line <= keyEndLine(ref.hunk.currentRange) + 1);
	}

	/** A normal editor, or the changed side of a diff in the review editor (issue 355). */
	private hasChips(): boolean {
		return !this._editor.getOption(EditorOption.inDiffEditor) || !!this._contextKeys.getContextKeyValue<boolean>(CLAUDE_REVIEW_EDITOR.key);
	}

	private syncCursor(): void {
		this._hunkAtCursor.set(!!this.hunkAtCursor());
	}

	private keep(ref: ReviewHunkRef): void {
		this._review.acceptHunk(ref.sessionId, ref.turnId, ref.hunk.id);
	}

	private undo(ref: ReviewHunkRef): void {
		void this._review.rejectHunk(ref.sessionId, ref.turnId, ref.hunk.id).catch(error => {
			const message = error instanceof ReviewConflictError
				? localize('claudeHunkConflict', "This change was edited after Claude made it. Open the review to resolve it.")
				: error instanceof Error ? error.message : String(error);
			this._notifications.warn(message);
		});
	}
}

/** The last line the change keys count as the change: its last line, or for a deletion the line before it. */
function keyEndLine(range: Range): number {
	return range.isEmpty() ? Math.max(1, range.startLineNumber - 1) : lastChangedLine(range);
}

/** Resolves `claude-snapshot` so the diff editor can open the pre-turn text. */
export class ClaudeSnapshotContentProvider extends Disposable implements ITextModelContentProvider {
	static readonly ID = 'workbench.contrib.claudeSnapshotContentProvider';

	constructor(
		@ITextModelService textModels: ITextModelService,
		@IModelService private readonly _models: IModelService,
		@IClaudeReviewService private readonly _review: IClaudeReviewService,
	) {
		super();
		this._register(textModels.registerTextModelContentProvider(CLAUDE_SNAPSHOT_SCHEME, this));
	}

	provideTextContent(resource: URI): Promise<ITextModel | null> | null {
		const text = this._review.snapshotText(resource);
		if (text === undefined) {
			return null;
		}
		const existing = this._models.getModel(resource);
		if (existing && !existing.isDisposed()) {
			return Promise.resolve(existing);
		}
		return Promise.resolve(this._models.createModel(text, null, resource));
	}
}

/** Serves `claude-notebook-snapshot` so the notebook diff editor can open the pre-turn notebook (issue 526). */
export class ClaudeNotebookSnapshotContribution extends Disposable {
	static readonly ID = 'workbench.contrib.claudeNotebookSnapshot';

	constructor(
		@IFileService fileService: IFileService,
		@IClaudeReviewService review: IClaudeReviewService,
	) {
		super();
		this._register(fileService.registerProvider(CLAUDE_NOTEBOOK_SNAPSHOT_SCHEME, new ClaudeNotebookSnapshotFileSystem(review)));
	}
}

/** Adds the review decorations and change navigator to every code editor. Separate from the commands, so a test that registers the commands does not add them to other tests' editors. */
export function registerClaudeReviewEditorContributions(): void {
	registerEditorContribution(ClaudeReviewDecorationContribution.ID, ClaudeReviewDecorationContribution, EditorContributionInstantiation.AfterFirstRender);
	registerEditorContribution(ClaudeChangeNavigatorContribution.ID, ClaudeChangeNavigatorContribution, EditorContributionInstantiation.AfterFirstRender);
}

export function registerClaudeReviewContributions(): void {
	registerWorkbenchContribution2(ClaudeSnapshotContentProvider.ID, ClaudeSnapshotContentProvider, WorkbenchPhase.BlockRestore);
	registerWorkbenchContribution2(ClaudeNotebookSnapshotContribution.ID, ClaudeNotebookSnapshotContribution, WorkbenchPhase.BlockRestore);
	registerClaudeKeepAllCommands();

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'klawly.review.acceptHunk',
				title: localize2('claudeAcceptHunkAction', "Accept Hunk"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		run(accessor: ServicesAccessor): void {
			const review = accessor.get(IClaudeReviewService);
			const hunk = review.currentHunk();
			const focused = review.focused();
			if (!hunk || !focused) {
				return;
			}
			review.acceptHunk(focused.sessionId, focused.turnId, hunk.id);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'klawly.review.rejectHunk',
				title: localize2('claudeRejectHunkAction', "Reject Hunk"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const review = accessor.get(IClaudeReviewService);
			const hunk = review.currentHunk();
			const focused = review.focused();
			if (!hunk || !focused) {
				return;
			}
			try {
				await review.rejectHunk(focused.sessionId, focused.turnId, hunk.id);
			} catch (error) {
				if (!(error instanceof ReviewConflictError)) {
					throw error;
				}
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_KEEP_HUNK_COMMAND_ID,
				title: localize2('claudeKeepHunkAtCursor', "Keep Change at Cursor"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_REVIEW_HUNK_AT_CURSOR),
				keybinding: {
					when: ContextKeyExpr.and(EditorContextKeys.editorTextFocus, CLAUDE_REVIEW_HUNK_AT_CURSOR),
					primary: KeyMod.Alt | KeyCode.KeyY,
					mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyY },
					weight: KeybindingWeight.EditorContrib,
				},
			});
		}
		run(accessor: ServicesAccessor): void {
			const editor = accessor.get(ICodeEditorService).getFocusedCodeEditor();
			if (editor) {
				ClaudeReviewDecorationContribution.get(editor)?.keepAtCursor();
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_UNDO_HUNK_COMMAND_ID,
				title: localize2('claudeUndoHunkAtCursor', "Undo Change at Cursor"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_REVIEW_HUNK_AT_CURSOR),
				keybinding: {
					when: ContextKeyExpr.and(EditorContextKeys.editorTextFocus, CLAUDE_REVIEW_HUNK_AT_CURSOR),
					primary: KeyMod.Alt | KeyCode.KeyN,
					mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyN },
					weight: KeybindingWeight.EditorContrib,
				},
			});
		}
		run(accessor: ServicesAccessor): void {
			const editor = accessor.get(ICodeEditorService).getFocusedCodeEditor();
			if (editor) {
				ClaudeReviewDecorationContribution.get(editor)?.undoAtCursor();
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'klawly.review.nextChange',
				title: localize2('claudeNextChangeAction', "Review Next Change"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		run(accessor: ServicesAccessor): void {
			const review = accessor.get(IClaudeReviewService);
			const focused = review.focused();
			if (focused) {
				review.next(focused.sessionId, focused.turnId);
			}
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'klawly.review.previousChange',
				title: localize2('claudePreviousChangeAction', "Review Previous Change"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}
		run(accessor: ServicesAccessor): void {
			const review = accessor.get(IClaudeReviewService);
			const focused = review.focused();
			if (focused) {
				review.previous(focused.sessionId, focused.turnId);
			}
		}
	});
}

function clamp(value: number, min: number, max: number): number {
	if (value < min) {
		return min;
	}
	if (value > max) {
		return max;
	}
	return value;
}
