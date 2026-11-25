/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { splitClaudeFoldedMarkdown } from '../../common/claudeFoldedMarkdown.js';

/** Issue 462: `<details>` in a reply becomes a folded section the chat draws collapsed. */
suite('Claude folded Markdown (issue 462)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a reply with folded detail splits into runs and sections', () => {
		const reply = [
			'**TL;DR:** Run the tests.',
			'',
			'- Run `npm test`.',
			'',
			'<details>',
			'<summary>Why it <b>failed</b></summary>',
			'',
			'The cache was stale.',
			'',
			'</details>',
			'',
			'<details open><summary>Log</summary>',
			'```text',
			'</details> inside a fence stays code',
			'```',
			'</details>',
			'Done.',
		].join('\n');
		assert.deepStrictEqual(splitClaudeFoldedMarkdown(reply), [
			{ kind: 'markdown', text: '**TL;DR:** Run the tests.\n\n- Run `npm test`.\n\n' },
			{ kind: 'details', summary: 'Why it failed', body: '\nThe cache was stale.\n\n', open: false, closed: true },
			{ kind: 'details', summary: 'Log', body: '```text\n</details> inside a fence stays code\n```\n', open: true, closed: true },
			{ kind: 'markdown', text: 'Done.' },
		]);
	});

	test('nested sections stay in the body, a streaming section is unclosed, and fenced tags are code', () => {
		assert.deepStrictEqual({
			plain: splitClaudeFoldedMarkdown('No folds here.'),
			nested: splitClaudeFoldedMarkdown('<details>\n<summary>Outer</summary>\n<details>\n<summary>Inner</summary>\nDeep\n</details>\nAfter\n</details>\n'),
			streaming: splitClaudeFoldedMarkdown('Lead\n<details>\n<summary>More</summary>\nPartial'),
			fenced: splitClaudeFoldedMarkdown('```html\n<details>\n<summary>x</summary>\n```\n'),
			noSummary: splitClaudeFoldedMarkdown('<details>\nBody\n</details>'),
		}, {
			plain: [{ kind: 'markdown', text: 'No folds here.' }],
			nested: [{ kind: 'details', summary: 'Outer', body: '<details>\n<summary>Inner</summary>\nDeep\n</details>\nAfter\n', open: false, closed: true }],
			streaming: [
				{ kind: 'markdown', text: 'Lead\n' },
				{ kind: 'details', summary: 'More', body: 'Partial', open: false, closed: false },
			],
			fenced: [{ kind: 'markdown', text: '```html\n<details>\n<summary>x</summary>\n```\n' }],
			noSummary: [{ kind: 'details', summary: '', body: 'Body\n', open: false, closed: true }],
		});
	});
});
