/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeNoFolderStrip } from '../../browser/chat/claudeNoFolderStrip.js';

suite('Klawly composer without a folder (issue 996)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('shows why and Open Project... only while no folder is open, and leaves the typed text alone', () => {
		const host = append(mainWindow.document.body, $('.claude-composer'));
		store.add({ dispose: () => host.remove() });
		const input = append(host, $<HTMLTextAreaElement>('textarea'));
		input.value = 'hi';
		let opened = 0;
		const strip = new ClaudeNoFolderStrip(host, () => opened++);
		const snapshot = () => ({ hidden: strip.element.hidden, text: strip.element.textContent, value: input.value });
		const initial = snapshot();
		strip.paint(false);
		const withoutFolder = snapshot();
		strip.element.querySelector<HTMLButtonElement>('button')!.click();
		strip.paint(true);
		assert.deepStrictEqual({ initial: initial.hidden, withoutFolder, opened, withFolder: snapshot().hidden, value: input.value }, {
			initial: true,
			withoutFolder: { hidden: false, text: 'No Project OpenOpen a folder to send this message. Your text stays here.Open Project...', value: 'hi' },
			opened: 1,
			withFolder: true,
			value: 'hi',
		});
	});
});
