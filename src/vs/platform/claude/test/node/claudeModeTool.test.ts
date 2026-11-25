/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_MODE_TOOL_ID, claudeModeState } from '../../common/claudeModeTool.js';
import { NON_MUTATING_TOOLS } from '../../common/claudeModePolicy.js';

suite('klawly_mode (issue 1169)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the chat mode, permission level and reply style', () => {
		assert.deepStrictEqual(claudeModeState('plan', undefined, true, 'adhd'), {
			chatMode: 'plan',
			permissionLevel: 'ask-each-time',
			runsUnasked: false,
			allowCredentials: false,
			workspaceTrusted: true,
			replyStyle: 'adhd',
		});
		const all = claudeModeState('agent', { allowAllCommands: true, allowEverything: true }, true, undefined);
		assert.strictEqual(all.permissionLevel, 'allow-everything');
		assert.strictEqual(all.replyStyle, 'default');
	});

	test('runs without a permission card', () => {
		assert.ok(NON_MUTATING_TOOLS.has(CLAUDE_MODE_TOOL_ID));
	});
});
