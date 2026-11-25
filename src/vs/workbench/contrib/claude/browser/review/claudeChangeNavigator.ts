/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICodeEditor, IOverlayWidget, IOverlayWidgetPosition } from '../../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { IEditorContribution, ScrollType } from '../../../../../editor/common/editorCommon.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IClaudeReviewService, lastChangedLine, ReviewConflictError, ReviewHunk, ReviewHunkRef } from '../../../../services/claude/common/claudeReview.js';
import { CLAUDE_OPEN_REVIEW_EDITOR_COMMAND_ID } from '../../common/claudeViews.js';

/** What the change navigator shows and does. */
export interface ClaudeChangeNavigatorState {
	/** 1-based position of the current change. */
	readonly position: number;
	readonly total: number;
	readonly file: { readonly name: string; readonly index: number; readonly count: number } | undefined;
	readonly previous: () => void;
	readonly next: () => void;
	readonly rejectFile: () => void;
	readonly acceptFile: () => void;
	readonly nextFile: () => void;
	readonly openReview: () => void;
	/** Per-change Reject / Accept. Only the "(review)" diff editor has them; a normal editor has Undo / Keep chips. */
	readonly change?: { readonly reject: () => void; readonly accept: () => void };
}

/**
 * Paints the change navigator into `bar`:
 * previous, "Change n of m", next | Reject File, Accept File | "name · i of N", next file, open review.
 */
export function renderClaudeChangeNavigator(bar: HTMLElement, state: ClaudeChangeNavigatorState, store: DisposableStore): void {
	bar.classList.add('claude-review-bar', 'claude-root');
	bar.setAttribute('role', 'toolbar');
	bar.setAttribute('aria-label', localize('claudeReviewToolbar', "Review changes"));
	iconButton(bar, Codicon.arrowUp, localize('claudePreviousChange', "Previous Change"), store, state.previous);
	append(bar, $('span.position')).textContent = localize('claudeChangePosition', "Change {0} of {1}", state.position, state.total);
	iconButton(bar, Codicon.arrowDown, localize('claudeNextChange', "Next Change"), store, state.next);
	append(bar, $('span.sep'));
	if (state.change) {
		textButton(bar, 'button.claude-review-bar-btn', localize('claudeRejectHunk', "Reject"), store, state.change.reject);
		textButton(bar, 'button.claude-review-bar-btn.is-keep', localize('claudeAcceptHunk', "Accept"), store, state.change.accept);
		append(bar, $('span.sep'));
	}
	textButton(bar, 'button.claude-review-bar-btn', localize('claudeRejectFile', "Reject File"), store, state.rejectFile);
	textButton(bar, 'button.claude-review-bar-btn.is-keep', localize('claudeAcceptFile', "Accept File"), store, state.acceptFile);
	append(bar, $('span.sep'));
	if (state.file) {
		append(bar, $('span.claude-faint')).textContent = localize('claudeFilePosition', "{0} · {1} of {2}", state.file.name, state.file.index, state.file.count);
	}
	iconButton(bar, Codicon.chevronRight, localize('claudeNextFile', "Next File"), store, state.nextFile);
	iconButton(bar, Codicon.diffMultiple, localize('claudeOpenReview', "Open Every Change of This Turn in the Review Editor"), store, state.openReview);
}

/**
 * The change navigator of a normal editor: a pill at the bottom center that
 * steps through Claude's pending changes in the file, keeps or reverts the
 * whole file, moves to the turn's next changed file, and opens the review
 * editor. Per-change Undo / Keep stay on the chips under each change.
 */
export class ClaudeChangeNavigatorContribution extends Disposable implements IEditorContribution, IOverlayWidget {
	static readonly ID = 'claude.changeNavigator';

	private readonly _node = $('.claude-change-navigator');
	private readonly _paint = this._register(new MutableDisposable<DisposableStore>());
	private readonly _layout = this._register(new MutableDisposable<DisposableStore>());
	private _position: IOverlayWidgetPosition | null = null;
	private _hunks: ReviewHunkRef[] = [];
	private _painted: ReviewHunkRef | undefined;

	constructor(
		private readonly _editor: ICodeEditor,
		@IClaudeReviewService private readonly _review: IClaudeReviewService,
		@IEditorService private readonly _editors: IEditorService,
		@ICommandService private readonly _commands: ICommandService,
		@INotificationService private readonly _notifications: INotificationService,
	) {
		super();
		this._register(_editor.onDidChangeModel(() => this.update()));
		this._register(_review.onDidChangeReview(() => this.update()));
		this._register(_editor.onDidChangeCursorPosition(() => this.paint()));
		this.update();
	}

	getId(): string {
		return ClaudeChangeNavigatorContribution.ID;
	}

	getDomNode(): HTMLElement {
		return this._node;
	}

	getPosition(): IOverlayWidgetPosition | null {
		return this._position;
	}

	/** Moves the cursor to the next pending change in this file, wrapping at the end. */
	next(): void {
		const line = this._editor.getPosition()?.lineNumber ?? 0;
		this.reveal(this._hunks.find(ref => ref.hunk.currentRange.startLineNumber > line) ?? this._hunks[0]);
	}

	/** Moves the cursor to the previous pending change in this file, wrapping at the start. */
	previous(): void {
		const line = this._editor.getPosition()?.lineNumber ?? 0;
		this.reveal(this._hunks.findLast(ref => endLine(ref.hunk) < line) ?? this._hunks.at(-1));
	}

	private update(): void {
		const model = this._editor.getModel();
		this._hunks = model && !this._editor.getOption(EditorOption.inDiffEditor)
			? [...this._review.hunksFor(model.uri)].sort((a, b) => a.hunk.currentRange.startLineNumber - b.hunk.currentRange.startLineNumber)
			: [];
		if (this._hunks.length === 0) {
			this.detach();
			return;
		}
		this.attach();
		this._painted = undefined;
		this.paint();
	}

	private attach(): void {
		if (this._layout.value) {
			return;
		}
		const store = new DisposableStore();
		this._layout.value = store;
		this._editor.addOverlayWidget(this);
		store.add({ dispose: () => this._editor.removeOverlayWidget(this) });
		store.add(this._editor.onDidLayoutChange(() => this.layout()));
		this.layout();
	}

	private detach(): void {
		this._layout.clear();
		this._paint.clear();
		this._painted = undefined;
		clearNode(this._node);
	}

	/** The change at the cursor, or the first one after it; the last one past the end. */
	private current(): ReviewHunkRef | undefined {
		const line = this._editor.getPosition()?.lineNumber ?? 1;
		return this._hunks.find(ref => endLine(ref.hunk) >= line) ?? this._hunks.at(-1);
	}

	private paint(): void {
		const current = this.current();
		if (!current || current === this._painted || !this._layout.value) {
			return;
		}
		this._painted = current;
		const { sessionId, turnId, hunk } = current;
		const review = this._review.get(sessionId, turnId);
		const files = review?.files ?? [];
		const fileIndex = files.findIndex(file => file.uri.toString() === hunk.uri.toString());
		const store = new DisposableStore();
		clearNode(this._node);
		renderClaudeChangeNavigator(this._node, {
			position: this._hunks.indexOf(current) + 1,
			total: this._hunks.length,
			file: fileIndex >= 0 ? { name: files[fileIndex].name, index: fileIndex + 1, count: files.length } : undefined,
			previous: () => this.previous(),
			next: () => this.next(),
			rejectFile: () => void this.rejectFile(sessionId, turnId, hunk.uri, fileIndex),
			acceptFile: () => {
				this._review.acceptFile(sessionId, turnId, hunk.uri);
				void this.nextFile(sessionId, turnId, fileIndex);
			},
			nextFile: () => void this.nextFile(sessionId, turnId, fileIndex),
			openReview: () => void this._commands.executeCommand(CLAUDE_OPEN_REVIEW_EDITOR_COMMAND_ID, sessionId, turnId),
		}, store);
		// The editor keeps focus and its selection; the click alone runs the action.
		store.add(addDisposableListener(this._node, EventType.MOUSE_DOWN, event => event.preventDefault()));
		this._paint.value = store;
	}

	private reveal(ref: ReviewHunkRef | undefined): void {
		if (!ref) {
			return;
		}
		const line = ref.hunk.currentRange.startLineNumber;
		this._editor.setPosition({ lineNumber: line, column: 1 });
		this._editor.revealLineInCenterIfOutsideViewport(line, ScrollType.Smooth);
	}

	/** Undoes the whole file, then moves on to the turn's next file with changes waiting (issue 350). */
	private async rejectFile(sessionId: string, turnId: string, uri: URI, fileIndex: number): Promise<void> {
		try {
			await this._review.rejectFile(sessionId, turnId, uri);
		} catch (error) {
			const message = error instanceof ReviewConflictError
				? localize('claudeFileConflict', "This file was edited after Claude changed it. Open the review to resolve it.")
				: error instanceof Error ? error.message : String(error);
			this._notifications.warn(message);
			return;
		}
		await this.nextFile(sessionId, turnId, fileIndex);
	}

	/** Opens the turn's next file that still has changes waiting, at its first change. */
	private async nextFile(sessionId: string, turnId: string, fileIndex: number): Promise<void> {
		const files = this._review.get(sessionId, turnId)?.files ?? [];
		for (let step = 1; step < files.length; step++) {
			const file = files[(fileIndex + step) % files.length];
			const first = file.hunks.find(hunk => hunk.state === 'pending' || hunk.state === 'conflicted');
			if (first) {
				const line = first.currentRange.startLineNumber;
				await this._editors.openEditor({ resource: file.uri, options: { selection: { startLineNumber: line, startColumn: 1 }, revealIfOpened: true } });
				return;
			}
		}
	}

	private layout(): void {
		const { width, height, horizontalScrollbarHeight } = this._editor.getLayoutInfo();
		// 30px pill, 16px above the bottom edge, centered by the CSS transform.
		this._position = { preference: { top: Math.max(0, height - horizontalScrollbarHeight - 46), left: width / 2 }, stackOrdinal: 2 };
		this._editor.layoutOverlayWidget(this);
	}
}

/** The last line of a change; a deletion ends where it starts. */
function endLine(hunk: ReviewHunk): number {
	return Math.max(hunk.currentRange.startLineNumber, lastChangedLine(hunk.currentRange));
}

function iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, store: DisposableStore, run: () => void): void {
	const button = append(parent, $<HTMLButtonElement>('button.claude-icon-btn'));
	button.type = 'button';
	button.setAttribute('aria-label', label);
	append(button, $(ThemeIcon.asCSSSelector(icon)));
	store.add(addDisposableListener(button, EventType.CLICK, event => {
		event.preventDefault();
		run();
	}));
}

function textButton(parent: HTMLElement, className: string, label: string, store: DisposableStore, run: () => void): void {
	const button = append(parent, $<HTMLButtonElement>(className));
	button.type = 'button';
	button.textContent = label;
	store.add(addDisposableListener(button, EventType.CLICK, event => {
		event.preventDefault();
		run();
	}));
}
