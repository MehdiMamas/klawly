/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContentWidgetPositionPreference } from '../../../../../editor/browser/editorBrowser.js';
import { createTestCodeEditor } from '../../../../../editor/test/browser/testCodeEditor.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { NextEditWidget } from '../../browser/claudeAutocompleteContribution.js';

suite('Claude next-edit hint', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('the chip sits after the text of the cursor line, Tab first', () => {
		const model = disposables.add(createTextModel(['function add(a, b) {', '	return a + b;', '}'].join('\n')));
		const editor = disposables.add(createTestCodeEditor(model));
		const widget = new NextEditWidget(editor);
		editor.addContentWidget(widget);
		disposables.add({ dispose: () => editor.removeContentWidget(widget) });

		widget.show({ fileName: 'cart.ts', line: 12, anchor: { lineNumber: 2, column: 3 } });
		const dom = widget.getDomNode();
		const shown = {
			position: widget.getPosition(),
			text: [...dom.children].map(child => child.textContent),
			label: dom.getAttribute('aria-label'),
		};

		widget.show(undefined);

		assert.deepStrictEqual({ shown, hidden: widget.getPosition() }, {
			shown: {
				position: {
					position: { lineNumber: 2, column: 15 },
					preference: [ContentWidgetPositionPreference.EXACT, ContentWidgetPositionPreference.BELOW],
				},
				text: ['Tab', 'Next edit in cart.ts:12'],
				label: 'Next edit in cart.ts:12, press Tab to go there',
			},
			hidden: null,
		});
	});
});
