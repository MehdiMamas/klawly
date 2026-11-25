/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { CLAUDE_FIND_BAR_OPEN_CLASS, ClaudeChatFindWidget } from '../../browser/chat/claudeChatFindWidget.js';

suite('Claude chat find bar top inset (issue 915)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createWidget() {
		const disposables = store.add(new DisposableStore());
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		const parent = document.createElement('div');
		const timeline = parent.appendChild(document.createElement('div'));
		const calls: string[] = [];
		const widget = disposables.add(instantiationService.createInstance(ClaudeChatFindWidget, {
			timeline,
			parent,
			reveal: () => { },
			insetChanged: () => calls.push(`measured:${parent.classList.contains(CLAUDE_FIND_BAR_OPEN_CLASS)}`),
			restoreFocus: () => calls.push('focus'),
		}));
		return { parent, widget, calls };
	}

	test('the parent carries the inset class only while the bar is open, and the timeline is measured at each change', async () => {
		const { parent, widget, calls } = createWidget();
		const steps: Array<[string, boolean]> = [['closed at first', parent.classList.contains(CLAUDE_FIND_BAR_OPEN_CLASS)]];

		widget.open('needle');
		steps.push(['opened', parent.classList.contains(CLAUDE_FIND_BAR_OPEN_CLASS)]);
		widget.open('needle');
		steps.push(['opened again', parent.classList.contains(CLAUDE_FIND_BAR_OPEN_CLASS)]);
		widget.hide();
		steps.push(['closed', parent.classList.contains(CLAUDE_FIND_BAR_OPEN_CLASS)]);
		await timeout(250);

		assert.deepStrictEqual({ steps, calls }, {
			steps: [['closed at first', false], ['opened', true], ['opened again', true], ['closed', false]],
			calls: ['measured:true', 'measured:false', 'focus'],
		});
	});

	test('disposing the open bar takes the inset away', async () => {
		const { parent, widget } = createWidget();
		widget.open('needle');
		const open = parent.classList.contains(CLAUDE_FIND_BAR_OPEN_CLASS);

		widget.dispose();

		assert.deepStrictEqual({ open, afterDispose: parent.classList.contains(CLAUDE_FIND_BAR_OPEN_CLASS) }, { open: true, afterDispose: false });
	});
});
