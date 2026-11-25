/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../../base/browser/dom.js';
import { isMacintosh } from '../../../../../base/common/platform.js';

/**
 * Appends a `.claude-kbd` with one key cap per key of a keybinding label,
 * such as "Ctrl+Alt+A" or "⌥⌘A".
 */
export function appendClaudeKbd(container: HTMLElement, label: string): HTMLElement {
	const kbd = append(container, $('span.claude-kbd'));
	// allow-any-unicode-next-line
	const keys = isMacintosh ? [...label.matchAll(/[⌃⌥⇧⌘]|[^⌃⌥⇧⌘\s]+/g)].map(match => match[0]) : label.split(/[+\s]/);
	for (const key of keys.filter(Boolean)) {
		append(kbd, $('kbd')).textContent = key;
	}
	return kbd;
}

/** Shift+Tab, which cycles the mode inside the composer. */
export function claudeShiftTabLabel(): string {
	// allow-any-unicode-next-line
	return isMacintosh ? '⇧Tab' : 'Shift+Tab';
}

/** Shift+Tab with the ⇧ glyph on every platform, for compact hints such as a menu footer. */
export function claudeShiftTabGlyphLabel(): string {
	// allow-any-unicode-next-line
	return isMacintosh ? '⇧Tab' : '⇧+Tab';
}

/** Enter alone. */
export function claudeEnterKeyLabel(): string {
	// allow-any-unicode-next-line
	return '↵';
}

/** The steer key: Ctrl+Enter, or Cmd+Enter on macOS. */
export function claudeSteerKeyLabel(): string {
	// allow-any-unicode-next-line
	return isMacintosh ? '⌘↵' : 'Ctrl+Enter';
}
