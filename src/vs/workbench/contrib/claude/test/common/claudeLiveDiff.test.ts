/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeLiveDiffAppend, claudeLiveDiffClear, claudeLiveDiffHunksOf, claudeLiveDiffKey, claudeLiveDiffTexts, EMPTY_CLAUDE_LIVE_DIFF_STATE } from '../../common/claudeLiveDiff.js';

suite('Claude live diff', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the changes of Edit, MultiEdit and Write, and nothing else', () => {
		assert.deepStrictEqual({
			edit: claudeLiveDiffHunksOf('Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }),
			multi: claudeLiveDiffHunksOf('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }, 7] }),
			write: claudeLiveDiffHunksOf('Write', { content: 'new' }),
			read: claudeLiveDiffHunksOf('Read', { file_path: 'a.ts' }),
			junk: claudeLiveDiffHunksOf('Edit', undefined),
		}, {
			edit: [{ old: 'a', new: 'b' }],
			multi: [{ old: 'a', new: 'b' }, { old: 'c', new: 'd' }],
			write: [{ old: '', new: 'new' }],
			read: [],
			junk: [],
		});
	});

	test('the diff grows with each change and goes when the agent stops', () => {
		const key = claudeLiveDiffKey('chat-1', '/p/a.ts');
		let state = claudeLiveDiffAppend(EMPTY_CLAUDE_LIVE_DIFF_STATE, key, [{ old: 'a', new: 'b' }]);
		state = claudeLiveDiffAppend(state, key, [{ old: 'c', new: 'd' }]);
		state = claudeLiveDiffAppend(state, claudeLiveDiffKey('chat-2', '/p/a.ts'), [{ old: 'x', new: 'y' }]);
		const texts = claudeLiveDiffTexts(state.get(key) ?? []);
		const cleared = claudeLiveDiffClear(state, 'chat-1');
		assert.deepStrictEqual({ texts, left: [...cleared.keys()], same: claudeLiveDiffClear(cleared, 'chat-9') === cleared }, {
			texts: { original: 'a\n\nc', modified: 'b\n\nd' },
			left: [claudeLiveDiffKey('chat-2', '/p/a.ts')],
			same: true,
		});
	});
});
