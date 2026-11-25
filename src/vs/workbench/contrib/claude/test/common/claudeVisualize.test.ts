/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { expandClaudeVisualize } from '../../common/claudeVisualize.js';

suite('Claude /visualize', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('expands the prompt with its subject, and leaves other text and a user command of that name alone', () => {
		const expanded = expandClaudeVisualize('/visualize  the auth flow \n', []);
		const bare = expandClaudeVisualize('/visualize', []);
		assert.deepStrictEqual([
			expanded.split('\n')[0],
			expanded.includes('```mermaid') && expanded.includes('```chart'),
			bare.split('\n')[0],
			expandClaudeVisualize('/visualizer data', []),
			expandClaudeVisualize('please /visualize this', []),
			expandClaudeVisualize('/visualize data', [{ name: 'visualize' }]),
		], [
			'Visualize this: the auth flow',
			true,
			'Visualize this: the code or topic we are discussing',
			'/visualizer data',
			'please /visualize this',
			'/visualize data',
		]);
	});
});
