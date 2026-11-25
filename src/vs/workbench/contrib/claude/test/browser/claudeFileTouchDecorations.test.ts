/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeFilePets, ClaudeFileTouch } from '../../../../../platform/claude/common/claudeAgentFileTouch.js';
import { claudeFilePetDecoration } from '../../browser/claudeFileTouchDecorations.js';

suite('Claude file pet decorations', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function touch(agentId: string, name: string): ClaudeFileTouch {
		return { agent: { agentId, name }, color: 1, tool: 'Edit', inWorktree: false, startedAt: 0 };
	}
	const none: ClaudeFilePets = { path: '/a', active: [], conflict: false, changedBy: undefined };

	test('no mark for an untouched file', () => {
		assert.strictEqual(claudeFilePetDecoration(none, () => 0), undefined);
	});

	test('active, conflict and changed-by marks', () => {
		const active = claudeFilePetDecoration({ ...none, active: [touch('a', 'Claude')] }, () => 0);
		const conflict = claudeFilePetDecoration({ ...none, active: [touch('a', 'Claude'), touch('b', 'Fix tests')], conflict: true }, () => 0);
		const changed = claudeFilePetDecoration({ ...none, changedBy: { agentId: 'a', name: 'Claude' } }, () => 2);
		assert.deepStrictEqual([active?.letter, active?.tooltip, conflict?.letter, conflict?.tooltip, changed?.letter, changed?.tooltip], [
			'●', 'Claude is editing this file', '!', 'Being edited by several agents at once: Claude, Fix tests', '○', 'Changed by Claude, not reviewed yet',
		]);
	});
});
