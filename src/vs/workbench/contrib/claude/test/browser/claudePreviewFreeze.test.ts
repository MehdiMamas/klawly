/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudePreviewFreezeFrame } from '../../browser/claudePreviewFreeze.js';

suite('ClaudePreviewFreezeFrame', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function mount(onAdd: (png: Uint8Array) => Promise<void> = async () => { }) {
		const viewport = document.createElement('div');
		document.body.appendChild(viewport);
		const notices: string[] = [];
		const freeze = store.add(new ClaudePreviewFreezeFrame(viewport, new Uint8Array(), onAdd, () => { }, { undoHint: 'Cmd+Z', notify: (message, severity) => notices.push(`${severity}: ${message}`) }));
		const buttons = [...viewport.querySelectorAll<HTMLButtonElement>('button')];
		return { viewport, freeze, buttons, notices, status: () => viewport.querySelector('.claude-preview-freeze-status')!.textContent };
	}

	test('toolbar keeps visible names, hints come from the options, colours form a group', () => {
		const { viewport, freeze, buttons } = mount();
		const pressed = (label: string) => buttons.find(b => b.getAttribute('aria-label') === label)?.getAttribute('aria-pressed');
		buttons.find(b => b.getAttribute('aria-label') === 'Blue')!.click();
		assert.deepStrictEqual({
			names: buttons.map(b => b.getAttribute('aria-label')),
			hints: buttons.filter(b => b.title).map(b => b.getAttribute('aria-description')),
			group: viewport.querySelector('[role=group]')?.getAttribute('aria-label'),
			red: pressed('Red'),
			blue: pressed('Blue'),
		}, {
			names: ['Pen', 'Box', 'Red', 'Blue', 'Green', 'Yellow', 'Undo', 'Clear', 'Add to Chat', 'Cancel'],
			hints: ['Pen: draw freehand', 'Box: drag a rectangle', 'Undo the last mark (Cmd+Z)', 'Remove every mark', 'Attach the drawing to the current chat', 'Close without adding (Esc). With marks, press it twice to discard.'],
			group: 'Colour',
			red: 'false',
			blue: 'true',
		});
		freeze.close();
		viewport.remove();
	});

	test('Add to Chat with no canvas context says so and keeps the drawing open', async () => {
		const original = HTMLCanvasElement.prototype.getContext;
		HTMLCanvasElement.prototype.getContext = (() => null) as typeof original;
		try {
			let added = 0;
			const { viewport, freeze, buttons, notices, status } = mount(async () => { added++; });
			buttons.find(b => b.textContent === 'Add to Chat')!.click();
			await new Promise(resolve => setTimeout(resolve, 0));
			assert.deepStrictEqual({ added, notices, status: status(), open: !!viewport.querySelector('.claude-preview-freeze') }, {
				added: 0,
				notices: ['error: Could not make the image. Your drawing is kept; try again.'],
				status: 'Could not make the image. Your drawing is kept; try again.',
				open: true,
			});
			freeze.close();
			viewport.remove();
		} finally {
			HTMLCanvasElement.prototype.getContext = original;
		}
	});

	test('a failed add shows a notice and keeps the drawing open', async () => {
		const { viewport, freeze, buttons, notices } = mount(async () => { throw new Error('disk full'); });
		const flatten = HTMLCanvasElement.prototype.toBlob;
		HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) { callback(new Blob([new Uint8Array([1])], { type: 'image/png' })); };
		try {
			buttons.find(b => b.textContent === 'Add to Chat')!.click();
			await new Promise(resolve => setTimeout(resolve, 10));
			assert.deepStrictEqual({ notices, open: !!viewport.querySelector('.claude-preview-freeze') }, {
				notices: ['error: Could not add the drawing to the chat. Try again.'],
				open: true,
			});
		} finally {
			HTMLCanvasElement.prototype.toBlob = flatten;
			freeze.close();
			viewport.remove();
		}
	});
});
