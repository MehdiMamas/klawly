/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { withChatAttachment } from '../../common/claudeChatReference.js';
import { ContextAttachment } from '../../common/claudeContext.js';

function chat(sessionId: string, asOfTurn: number, turnRange: [number, number] = [1, asOfTurn], scope: 'summary' | 'full' = 'summary'): ContextAttachment {
	return { kind: 'chat', sessionId, scope, asOfTurn, turnRange };
}

suite('Claude chat references', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the same chat is referenced once; the newer reference replaces the old one and keeps its scope', () => {
		const file: ContextAttachment = { kind: 'file', uri: 'file:///a.ts' };
		let list = withChatAttachment([file], chat('a', 2, [1, 2], 'full'));
		list = withChatAttachment(list, chat('a', 4));
		list = withChatAttachment(list, chat('b', 1));
		assert.deepStrictEqual(list, [file, chat('a', 4, [1, 4], 'full'), chat('b', 1)]);
	});

	test('a single turn of a chat is its own reference; non-chat attachments are appended as they are', () => {
		const file: ContextAttachment = { kind: 'file', uri: 'file:///a.ts' };
		let list = withChatAttachment([], chat('a', 3));
		list = withChatAttachment(list, chat('a', 2, [2, 2]));
		list = withChatAttachment(list, chat('a', 2, [2, 2]));
		list = withChatAttachment(list, file);
		list = withChatAttachment(list, file);
		assert.deepStrictEqual(list, [chat('a', 3), chat('a', 2, [2, 2]), file, file]);
	});
});
