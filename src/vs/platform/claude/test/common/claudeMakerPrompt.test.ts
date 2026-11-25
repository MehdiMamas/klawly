/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_MAKER_INSTRUCTIONS, claudeMakerInstructions, readClaudeMakerActive } from '../../common/claudeMakerPrompt.js';

suite('Klawly maker prompt (issue 1184)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only a maker gets the section, and only a real true turns it on', () => {
		assert.deepStrictEqual([
			claudeMakerInstructions(true),
			claudeMakerInstructions(false),
			claudeMakerInstructions(undefined),
			readClaudeMakerActive(true),
			readClaudeMakerActive('true'),
			readClaudeMakerActive(1),
			readClaudeMakerActive(undefined),
		], [CLAUDE_MAKER_INSTRUCTIONS, undefined, undefined, true, false, false, false]);
	});

	test('the section holds no secret or address', () => {
		assert.ok(!/token|password|secret|@\w+\.\w+/i.test(CLAUDE_MAKER_INSTRUCTIONS));
	});
});
