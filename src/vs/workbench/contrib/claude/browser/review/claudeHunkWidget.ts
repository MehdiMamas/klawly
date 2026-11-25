/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getTotalWidth } from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ICodeEditor, IOverlayWidget, IOverlayWidgetPosition } from '../../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { localize } from '../../../../../nls.js';
import { appendClaudeKbd } from '../chat/claudeKbd.js';

export interface ClaudeHunkWidgetActions {
	keep(): void;
	undo(): void;
	/** The keybinding label of Keep, when bound. */
	readonly keepKeys: string | undefined;
	/** The keybinding label of Undo, when bound. */
	readonly undoKeys: string | undefined;
}

/**
 * Undo and Keep for one pending Claude change in a normal editor (ai-16): a
 * bordered chip with quiet key hints at the top-right of the change, on its
 * first line, clear of the scrollbar. Hidden while that line is scrolled out.
 */
export class ClaudeHunkWidget extends Disposable implements IOverlayWidget {
	private static _ids = 0;

	private readonly _id = `claude.hunk.${ClaudeHunkWidget._ids++}`;
	private readonly _node: HTMLElement;
	private _position: IOverlayWidgetPosition | null = null;

	constructor(
		private readonly _editor: ICodeEditor,
		private _line: number,
		actions: ClaudeHunkWidgetActions,
	) {
		super();
		this._node = $('.claude-hunk-actions.is-chip');
		this._node.setAttribute('role', 'toolbar');
		this._node.setAttribute('aria-label', localize('claudeHunkActions', "Claude change"));
		this.button(localize('claudeHunkUndo', "Undo"), actions.undoKeys, false, () => actions.undo());
		this.button(localize('claudeHunkKeep', "Keep"), actions.keepKeys, true, () => actions.keep());
		this._editor.addOverlayWidget(this);
		this._register({ dispose: () => this._editor.removeOverlayWidget(this) });
		this._register(this._editor.onDidScrollChange(() => this.layout()));
		this._register(this._editor.onDidLayoutChange(() => this.layout()));
		this.layout();
	}

	getId(): string {
		return this._id;
	}

	getDomNode(): HTMLElement {
		return this._node;
	}

	getPosition(): IOverlayWidgetPosition | null {
		return this._position;
	}

	/**
	 * Moves the chip to the top of `line`, the first line of the change. For a
	 * deletion it is the line after the removed text; past the last line, the
	 * chip sits at the bottom of the last line.
	 */
	setLine(line: number): void {
		if (line !== this._line) {
			this._line = line;
			this.layout();
		}
	}

	private button(label: string, keys: string | undefined, primary: boolean, run: () => void): void {
		const button = append(this._node, $<HTMLButtonElement>(primary ? 'button.accept' : 'button'));
		button.type = 'button';
		append(button, $('span.label')).textContent = label;
		if (keys) {
			appendClaudeKbd(button, keys).classList.add('is-quiet');
			button.setAttribute('aria-keyshortcuts', keys);
		}
		// The editor keeps focus and its selection; the click alone runs the action.
		this._register(addDisposableListener(button, EventType.MOUSE_DOWN, event => event.preventDefault()));
		this._register(addDisposableListener(button, EventType.CLICK, event => {
			event.preventDefault();
			event.stopPropagation();
			run();
		}));
	}

	private layout(): void {
		const model = this._editor.getModel();
		if (!model) {
			return;
		}
		const lineHeight = this._editor.getOption(EditorOption.lineHeight);
		const { height, contentLeft, contentWidth, verticalScrollbarWidth } = this._editor.getLayoutInfo();
		const lineCount = model.getLineCount();
		const lineTop = this._line > lineCount ? this._editor.getBottomForLineNumber(lineCount) : this._editor.getTopForLineNumber(this._line);
		// 2px into the line and 6px clear of the scrollbar, like the prototype.
		const top = lineTop - this._editor.getScrollTop() + 2;
		this._node.hidden = top < 0 || top + lineHeight > height;
		const left = contentLeft + contentWidth - verticalScrollbarWidth - getTotalWidth(this._node) - 6;
		this._position = { preference: { top, left: Math.max(contentLeft, left) }, stackOrdinal: 1 };
		this._editor.layoutOverlayWidget(this);
	}
}
