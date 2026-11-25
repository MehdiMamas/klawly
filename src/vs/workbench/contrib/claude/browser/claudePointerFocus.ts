/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventType, isHTMLElement, onDidRegisterWindow } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

/** The class a list carries while its focus came from the pointer; `claudeChrome.css` hides the focus ring then (DL-28). */
export const CLAUDE_POINTER_FOCUS_CLASS = 'claude-pointer-focus';

/**
 * Marks a list focused by a pointer press, so a mouse click shows the selection fill without the
 * keyboard focus ring (DL-28). Any key pressed in the list, or keyboard focus arriving at it,
 * clears the mark and the ring comes back. `:focus-visible` can't do this: lists take focus from
 * script on mousedown, and Chromium keeps the ring when the previous element (an editor) had it.
 */
export class ClaudePointerFocusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudePointerFocus';

	constructor() {
		super();

		this._register(Event.runAndSubscribe(onDidRegisterWindow, ({ window, disposables }) => {
			let pointerDown = false;
			disposables.add(addDisposableListener(window.document, EventType.POINTER_DOWN, e => {
				pointerDown = true;
				markList(e.target, true);
			}, true));
			disposables.add(addDisposableListener(window.document, EventType.POINTER_UP, () => pointerDown = false, true));
			disposables.add(addDisposableListener(window.document, 'pointercancel', () => pointerDown = false, true));
			disposables.add(addDisposableListener(window.document, EventType.FOCUS_IN, e => markList(e.target, pointerDown), true));
			disposables.add(addDisposableListener(window.document, EventType.KEY_DOWN, e => markList(e.target, false), true));
		}, { window: mainWindow, disposables: this._store }));
	}
}

function markList(target: EventTarget | null, pointer: boolean): void {
	const list = isHTMLElement(target) ? target.closest('.monaco-list') : null;
	list?.classList.toggle(CLAUDE_POINTER_FOCUS_CLASS, pointer);
}
