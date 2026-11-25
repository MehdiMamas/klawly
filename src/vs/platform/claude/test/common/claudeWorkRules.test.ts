/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_WORK_RULES_INSTRUCTIONS, claudeWorkRulesInstructions, readClaudeWorkRules } from '../../common/claudeWorkRules.js';

suite('Klawly work rules (issue 1388)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('on by default, off only for an explicit false', () => {
		assert.deepStrictEqual([
			claudeWorkRulesInstructions(undefined),
			claudeWorkRulesInstructions(true),
			claudeWorkRulesInstructions(false),
			readClaudeWorkRules(undefined),
			readClaudeWorkRules('false'),
			readClaudeWorkRules(false),
			readClaudeWorkRules(true),
		], [CLAUDE_WORK_RULES_INSTRUCTIONS, CLAUDE_WORK_RULES_INSTRUCTIONS, undefined, true, true, false, true]);
	});

	test('the rules name the shipped rules and nothing personal', () => {
		assert.ok(/worktree/i.test(CLAUDE_WORK_RULES_INSTRUCTIONS) && /git stash/.test(CLAUDE_WORK_RULES_INSTRUCTIONS) && /Tier 0/.test(CLAUDE_WORK_RULES_INSTRUCTIONS));
		assert.ok(!/gaming|pause-all|@\w+\.\w+|mehdi|claude-sync/i.test(CLAUDE_WORK_RULES_INSTRUCTIONS));
	});
});
