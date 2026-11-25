/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ToolCardModel } from '../../../../services/claude/common/claudeToolCards.js';
import { ClaudeToolCardActions, ClaudeToolCardView } from '../../browser/chat/claudeToolCardView.js';

suite('Claude SVG image cards (issue 494)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a written SVG shows as an image with Save To and Open once it landed; other files and running writes do not', async () => {
		const asked: string[] = [];
		const saved: string[] = [];
		const opened: string[] = [];
		const actions = {
			toggle: () => undefined,
			displayPath: (path: string) => path.replace('/work/', ''),
			openFile: (path: string) => opened.push(path),
			copyCommand: () => undefined,
			rerunCommand: () => undefined,
			openCommandLog: () => undefined,
			openInTerminal: () => undefined,
			commandScroll: new Map(),
			previewImage: async (path: string) => { asked.push(path); return 'data:image/svg+xml;base64,PHN2Zy8+'; },
			saveImageAs: (path: string) => saved.push(path),
		} as unknown as ClaudeToolCardActions;
		const card = (file: string, state: ToolCardModel['state']) => ({ id: file, name: 'Write', category: 'write', kind: 'edit', label: 'Write', verb: 'Wrote', target: file, file, lines: [], droppedLines: 0, streamedChars: 0, state } as ToolCardModel);
		const parent = document.createElement('div');
		const view = (file: string, state: ToolCardModel['state']) => {
			const tool = store.add(new ClaudeToolCardView(parent, 't1', actions));
			tool.update(card(file, state), false, undefined);
			return tool;
		};
		const running = view('/work/logo.svg', 'running');
		const code = view('/work/app.ts', 'success');
		const logo = view('/work/logo.svg', 'success');
		await new Promise(resolve => setTimeout(resolve, 0));
		const frame = logo.element.querySelector<HTMLElement>('.claude-tool-image')!;
		const buttons = [...frame.querySelectorAll<HTMLButtonElement>('button')];
		buttons.forEach(button => button.click());
		assert.deepStrictEqual({
			running: !!running.element.querySelector('.claude-tool-image'),
			code: !!code.element.querySelector('.claude-tool-image'),
			shown: !frame.hidden,
			image: [frame.querySelector('img')?.getAttribute('src'), frame.querySelector('img')?.alt],
			buttons: buttons.map(button => button.textContent),
			asked, saved, opened,
		}, {
			running: false,
			code: false,
			shown: true,
			image: ['data:image/svg+xml;base64,PHN2Zy8+', 'Image Claude wrote: logo.svg'],
			buttons: ['Save To...', 'Open'],
			asked: ['/work/logo.svg'],
			saved: ['/work/logo.svg'],
			opened: ['/work/logo.svg'],
		});
	});
});
