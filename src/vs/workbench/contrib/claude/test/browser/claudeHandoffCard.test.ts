/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeHandoffCard } from '../../browser/chat/claudeHandoffCard.js';

suite('Claude handoff card', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('lists the note, hides without one, and Dismiss reports the session', () => {
		const card = store.add(new ClaudeHandoffCard(document.createElement('div')));
		const dismissed: string[] = [];
		const dismiss = (id: string) => dismissed.push(id);
		const note = { version: 1 as const, summary: 'Fixing login', goals: ['Ship it'], open: [], waitingOnUser: ['Pick a name'], decisions: [] };

		const none = card.sync('s1', undefined, dismiss);
		const shown = card.sync('s1', note, dismiss);
		const read = {
			title: card.element.querySelector('.title')?.textContent,
			items: [...card.element.querySelectorAll('li')].map(li => li.textContent),
			hidden: card.element.hidden,
		};
		const same = card.sync('s1', note, dismiss);
		card.element.querySelector('button')!.click();
		const gone = card.sync('s1', undefined, dismiss);

		assert.deepStrictEqual({ none, shown, read, same, dismissed, gone, hiddenAfter: card.element.hidden }, {
			none: false,
			shown: true,
			read: { title: 'From the Terminal', items: ['Ship it', 'Pick a name'], hidden: false },
			same: false,
			dismissed: ['s1'],
			gone: true,
			hiddenAfter: true,
		});
	});
});
