/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_SESSION_TITLE_MAX_LENGTH, claudeSessionTitlePrompt, readClaudeSessionTitle } from '../../common/claudeSessionTitle.js';

/** A chat is named by a short generated title, not its first request cut off. */
suite('Claude session title', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the title prompt quotes the first request and asks for the title only', () => {
		const prompt = claudeSessionTitlePrompt('  Add discount codes to the cart  ');
		assert.deepStrictEqual({
			request: prompt.includes('<request>\nAdd discount codes to the cart\n</request>'),
			titleOnly: prompt.includes('Reply with the title only'),
			long: claudeSessionTitlePrompt('x'.repeat(5000)).length < 2500,
		}, { request: true, titleOnly: true, long: true });
	});

	test('a reply is cleaned up into a title', () => {
		const long = readClaudeSessionTitle('Make the checkout cart accept seasonal discount codes and show the savings in totals');
		assert.deepStrictEqual({
			plain: readClaudeSessionTitle('Discount codes in cart'),
			quoted: readClaudeSessionTitle('"Discount codes in cart."'),
			labeled: readClaudeSessionTitle('Title: **Discount codes in cart**'),
			heading: readClaudeSessionTitle('\n# Discount   codes in cart\nThis title names the work.'),
			empty: readClaudeSessionTitle('  \n "" \n'),
			missing: readClaudeSessionTitle(undefined),
			long,
			longFits: (long?.length ?? 0) <= CLAUDE_SESSION_TITLE_MAX_LENGTH,
		}, {
			plain: 'Discount codes in cart',
			quoted: 'Discount codes in cart',
			labeled: 'Discount codes in cart',
			heading: 'Discount codes in cart',
			empty: undefined,
			missing: undefined,
			long: 'Make the checkout cart accept seasonal discount codes and…',
			longFits: true,
		});
	});
});
