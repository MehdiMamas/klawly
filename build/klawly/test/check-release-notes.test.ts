/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Run: node --test build/klawly/test/check-release-notes.test.ts

import assert from 'assert';
import { suite, test } from 'node:test';
import { hasWhatsNew, unlinkedBullets } from '../check-release-notes.ts';

const notes = (...bullets: string[]) => `**Link for testers:** https://x/beta/abc\n\n## What's new\n\n${bullets.map(b => `- ${b}`).join('\n')}\n\n## Thanks\n\n- [@a](https://github.com/a)\n`;

suite('check-release-notes', () => {
	test('bullets ending with one or several issues pass (issue 1209)', () => {
		assert.deepStrictEqual(unlinkedBullets(notes('Drop screenshots on the form. (#1190)', 'Inline edit works. (#1190, #1201)', 'Bold **x** (#5).')), []);
	});

	test('an unlinked bullet is named, linked ones are not (issue 1209)', () => {
		assert.deepStrictEqual(unlinkedBullets(notes('Linked. (#1)', 'Inline edit works in notebook cells.', 'See #12 for more')), ['Inline edit works in notebook cells.', 'See #12 for more']);
	});

	test('only the What\'s new section is checked, and a wrapped bullet counts as one (issue 1209)', () => {
		const text = '## Thanks\n\n- no issues here\n\n## What\'s new\n\n- A long bullet\n  that wraps. (#7)\n\n## Other\n\n- unchecked\n';
		assert.deepStrictEqual(unlinkedBullets(text), []);
		assert.strictEqual(hasWhatsNew(text), true);
		assert.strictEqual(hasWhatsNew('## Thanks'), false);
	});
});
