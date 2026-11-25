/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_PLAN_DEPENDS_INSTRUCTIONS, claudePlanDependsInstructions } from '../../common/claudePlanDependsPrompt.js';
import { parsePlanDependsLine } from '../../common/claudePlan.js';

suite('Claude plan Depends instruction (issue 682)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only plan mode gets it', () => {
		assert.deepStrictEqual(
			['plan', 'agent', 'ask', undefined].map(mode => claudePlanDependsInstructions(mode) === CLAUDE_PLAN_DEPENDS_INSTRUCTIONS),
			[true, false, false, false]);
	});

	test('the line it asks for is one the plan parser reads', () => {
		assert.deepStrictEqual(parsePlanDependsLine('Depends: 1, 3', 4), [1, 3]);
	});
});
