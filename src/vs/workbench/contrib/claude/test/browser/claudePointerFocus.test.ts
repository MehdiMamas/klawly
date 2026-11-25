/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CLAUDE_POINTER_FOCUS_CLASS, ClaudePointerFocusContribution } from '../../browser/claudePointerFocus.js';

suite('Klawly pointer focus (DL-28)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a pointer press marks its list, a key or keyboard focus clears the mark, and other lists stay unmarked', () => {
		const document = mainWindow.document;
		const list = document.createElement('div');
		list.className = 'monaco-list';
		const row = list.appendChild(document.createElement('div'));
		const other = document.createElement('div');
		other.className = 'monaco-list';
		document.body.append(list, other);
		store.add({ dispose: () => { list.remove(); other.remove(); } });
		store.add(new ClaudePointerFocusContribution());

		const marked = () => [list, other].map(element => element.classList.contains(CLAUDE_POINTER_FOCUS_CLASS));
		const states: boolean[][] = [];

		row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		list.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
		row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		states.push(marked());

		row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		states.push(marked());

		row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		list.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
		states.push(marked());

		assert.deepStrictEqual(states, [[true, false], [false, false], [false, false]]);
	});
});
