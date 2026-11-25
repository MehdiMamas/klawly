/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { parseBtwQuestion } from '../../common/claudeSideQuestion.js';

suite('Claude /btw command (issue 965)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the question, or opens the card when bare, or ignores other text', () => {
		assert.deepStrictEqual(
			['/btw what does this do?', '  /btw   why\nso?  ', '/btw', '/btw  ', '/btwx hi', 'hello /btw hi', '/multitask'].map(parseBtwQuestion),
			['what does this do?', 'why\nso?', '', '', undefined, undefined, undefined]);
	});
});
