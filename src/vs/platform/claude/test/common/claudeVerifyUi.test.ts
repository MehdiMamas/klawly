/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CLAUDE_VERIFY_UI_ALWAYS_INSTRUCTIONS, CLAUDE_VERIFY_UI_ASK_INSTRUCTIONS, claudeVerifyUiInstructions, readClaudeVerifyUi } from '../../common/claudeVerifyUi.js';

suite('Claude verify UI changes', () => {
	test('reads the setting and picks the instructions', () => {
		assert.deepStrictEqual([
			readClaudeVerifyUi(undefined),
			readClaudeVerifyUi('bogus'),
			readClaudeVerifyUi('ask'),
			readClaudeVerifyUi('always'),
			claudeVerifyUiInstructions('off'),
			claudeVerifyUiInstructions(undefined),
			claudeVerifyUiInstructions('ask'),
			claudeVerifyUiInstructions('always'),
		], ['off', 'off', 'ask', 'always', undefined, undefined, CLAUDE_VERIFY_UI_ASK_INSTRUCTIONS, CLAUDE_VERIFY_UI_ALWAYS_INSTRUCTIONS]);
	});

	test('the instructions cover screenshots, a recording, console errors and a free port', () => {
		for (const text of [CLAUDE_VERIFY_UI_ASK_INSTRUCTIONS, CLAUDE_VERIFY_UI_ALWAYS_INSTRUCTIONS]) {
			assert.ok(/before/.test(text) && /after/.test(text) && /recording/.test(text) && /console/i.test(text) && /free port/.test(text));
		}
	});
});
