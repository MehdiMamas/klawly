/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { expandClaudeCanvas } from '../../common/claudeCanvasSlash.js';

suite('Claude /canvas', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('expands the prompt to use klawly_canvas, and leaves other text and a user command of that name alone', () => {
		const expanded = expandClaudeCanvas('/canvas  a pricing table \n', []);
		const bare = expandClaudeCanvas('/canvas', []);
		assert.deepStrictEqual([
			expanded.split('\n')[0],
			expanded.includes('klawly_canvas'),
			bare.split('\n')[0],
			expandClaudeCanvas('/canvases data', []),
			expandClaudeCanvas('please /canvas this', []),
			expandClaudeCanvas('/canvas data', [{ name: 'canvas' }]),
		], [
			'Build this as a canvas: a pricing table',
			true,
			'Build this as a canvas: the code or topic we are discussing',
			'/canvases data',
			'please /canvas this',
			'/canvas data',
		]);
	});
});
