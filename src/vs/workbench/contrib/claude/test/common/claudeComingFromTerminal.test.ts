/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeShouldOfferComingFromTerminal } from '../../common/claudeComingFromTerminal.js';

suite('Klawly coming from Claude Code step (issue 1186)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('it is offered once, and only when ~/.claude exists', () => {
		assert.deepStrictEqual([
			claudeShouldOfferComingFromTerminal(true, false),
			claudeShouldOfferComingFromTerminal(false, false),
			claudeShouldOfferComingFromTerminal(true, true),
		], [true, false, false]);
	});
});
