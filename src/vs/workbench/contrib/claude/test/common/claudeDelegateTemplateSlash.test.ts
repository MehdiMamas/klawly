/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeReviewLoopPrompt } from '../../../../../platform/claude/common/claudeReviewCli.js';
import { expandClaudeDelegateTemplateSlash } from '../../common/claudeDelegateTemplateSlash.js';

suite('Claude delegate template slash commands', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('expands a template command into a delegate call with its plain name, and leaves other text alone', () => {
		assert.deepStrictEqual([
			expandClaudeDelegateTemplateSlash('/watch-ci  1110 \n', []),
			expandClaudeDelegateTemplateSlash('/merge-pr', []).includes('ask me before you start'),
			expandClaudeDelegateTemplateSlash('/finder x', []),
			expandClaudeDelegateTemplateSlash('please /find x', []),
			expandClaudeDelegateTemplateSlash('/find x', [{ name: 'find' }]),
		], [
			'Use klawly_delegate with template "watch-ci" (Watch CI) and args: 1110',
			true,
			'/finder x',
			'please /find x',
			'/find x',
		]);
	});

	test('issue 1376: /review-loop expands to the bundled loop prompt unless a command already has the name', () => {
		assert.deepStrictEqual([
			expandClaudeDelegateTemplateSlash('/review-loop', []),
			expandClaudeDelegateTemplateSlash('/review-loop', [{ name: 'review-loop' }]),
		], [claudeReviewLoopPrompt(), '/review-loop']);
	});
});
