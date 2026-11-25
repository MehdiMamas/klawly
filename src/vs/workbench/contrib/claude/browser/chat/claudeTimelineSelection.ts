/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventType, getWindow, isHTMLElement, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { toAction } from '../../../../../base/common/actions.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { quoteForReply, selectionScrollStep } from '../../common/claudeTimelineSelection.js';

/** What the selection menu needs from the chat that shows the timeline. */
export interface IClaudeTimelineSelectionHost {
	/** Adds `quote` after the composer's draft for the shown chat and focuses it. */
	quote(quote: string): void;
}

/** Where a press starts a drag or a click rather than a selection (DL-72). */
const CHROME = 'button, [role="button"]:not(.claude-msg-user .text), [role="toolbar"], input, select, textarea, [draggable="true"]';

/**
 * Text selection in the chat timeline (issue 468). The timeline scrolls inside a
 * `DomScrollableElement` with `overflow: hidden`, so the browser never scrolls it while a
 * selection is dragged past its top or bottom edge: this does, a step per frame, and carries
 * the selection along. A right-click on a selection offers Copy and Quote in Reply (DL-88).
 */
export class ClaudeTimelineSelection extends Disposable {

	/** Listeners for the drag in progress; cleared when the button comes up. */
	private readonly _drag = this._register(new DisposableStore());
	private readonly _frame = this._register(new MutableDisposable());
	private _pointer: { readonly x: number; readonly y: number } | undefined;

	constructor(
		private readonly _content: HTMLElement,
		private readonly _scrollable: DomScrollableElement,
		private readonly _host: IClaudeTimelineSelectionHost,
		@IContextMenuService private readonly _contextMenu: IContextMenuService,
		@IClipboardService private readonly _clipboard: IClipboardService,
	) {
		super();
		this._register(addDisposableListener(_content, EventType.POINTER_DOWN, event => this.onPointerDown(event)));
		this._register(addDisposableListener(_content, EventType.CONTEXT_MENU, event => this.onContextMenu(event)));
	}

	/** The text selected in the timeline, or '' when the selection is empty or elsewhere. */
	selectedText(): string {
		const selection = getWindow(this._content).getSelection();
		if (!selection || selection.isCollapsed || !selection.anchorNode || !this._content.contains(selection.anchorNode)) {
			return '';
		}
		return selection.toString();
	}

	private onPointerDown(event: PointerEvent): void {
		if (event.button !== 0 || event.pointerType === 'touch' || !isHTMLElement(event.target) || event.target.closest(CHROME)) {
			return;
		}
		const targetWindow = getWindow(this._content);
		this._drag.clear();
		this._pointer = { x: event.clientX, y: event.clientY };
		const end = () => this._drag.clear();
		this._drag.add(addDisposableListener(targetWindow, EventType.POINTER_MOVE, move => {
			this._pointer = { x: move.clientX, y: move.clientY };
			this.schedule(targetWindow);
		}));
		this._drag.add(addDisposableListener(targetWindow, EventType.POINTER_UP, end));
		this._drag.add(addDisposableListener(targetWindow, 'pointercancel', end));
		this._drag.add(addDisposableListener(targetWindow, EventType.BLUR, end));
		this._drag.add(toDisposable(() => {
			this._frame.clear();
			this._pointer = undefined;
		}));
	}

	private schedule(targetWindow: Window): void {
		if (!this._frame.value) {
			this._frame.value = scheduleAtNextAnimationFrame(targetWindow, () => {
				this._frame.clear();
				this.step(targetWindow);
			});
		}
	}

	/** One frame of a selecting drag: scroll when the pointer is at or past an edge, and keep scrolling while it stays there. */
	private step(targetWindow: Window): void {
		const pointer = this._pointer;
		const selection = targetWindow.getSelection();
		// A press that has not selected anything yet (a click near the edge) never scrolls.
		if (!pointer || !selection || selection.isCollapsed || !selection.anchorNode || !this._content.contains(selection.anchorNode)) {
			return;
		}
		const box = this._scrollable.getDomNode().getBoundingClientRect();
		const delta = selectionScrollStep(pointer.y, box.top, box.bottom);
		if (!delta) {
			return;
		}
		const before = this._scrollable.getScrollPosition().scrollTop;
		this._scrollable.setScrollPosition({ scrollTop: before + delta });
		if (this._scrollable.getScrollPosition().scrollTop === before) {
			return;
		}
		// The text that moved under the pointer joins the selection, as in the editor.
		const x = Math.min(Math.max(pointer.x, box.left + 1), box.right - 1);
		const y = Math.min(Math.max(pointer.y, box.top + 1), box.bottom - 1);
		const caret = this._content.ownerDocument.caretPositionFromPoint(x, y);
		if (caret && this._content.contains(caret.offsetNode)) {
			selection.extend(caret.offsetNode, caret.offset);
		}
		this.schedule(targetWindow);
	}

	private onContextMenu(event: MouseEvent): void {
		const text = this.selectedText();
		if (!text.trim()) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const quote = quoteForReply(text);
		this._contextMenu.showContextMenu({
			getAnchor: () => ({ x: event.clientX, y: event.clientY }),
			getActions: () => [
				toAction({
					id: 'claude.timeline.copySelection',
					label: localize('claudeCopySelection', "Copy"),
					run: () => this._clipboard.writeText(text),
				}),
				toAction({
					id: 'claude.timeline.quoteSelection',
					label: localize('claudeQuoteSelection', "Quote in Reply"),
					run: () => this._host.quote(quote),
				}),
			],
		});
	}
}
