/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Moves focus to `target` and fires the focus events a focused window fires.
 *
 * The test window is hidden and has no OS focus, so `focus()` moves
 * `document.activeElement` but Chromium fires no blur, focusout, focus or focusin
 * event. Code that closes a menu or a hover on focusout would never see the move.
 * When the window has focus, the browser fires them itself and this only calls `focus()`.
 */
export function moveClaudeTestFocus(target: HTMLElement): void {
	const document = target.ownerDocument;
	const previous = document.activeElement;
	target.focus();
	if (document.hasFocus() || document.activeElement !== target || previous === target) {
		return;
	}
	const related = previous instanceof HTMLElement && previous !== document.body ? previous : null;
	if (related) {
		related.dispatchEvent(new FocusEvent('blur', { relatedTarget: target }));
		related.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: target }));
	}
	target.dispatchEvent(new FocusEvent('focus', { relatedTarget: related }));
	target.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: related }));
}
