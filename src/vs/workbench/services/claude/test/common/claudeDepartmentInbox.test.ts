/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { addClaudeHandoff, claudeHandoffTimeline, claudeUnreadByFolder, ClaudeHandoffRecord, markClaudeHandoffRead, parseClaudeHandoffs } from '../../common/claudeDepartmentInbox.js';

/** Issue 1459: the hand-off timeline and the unread counts behind the badges. */
suite('Claude department inbox', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const record = (chatId: string, at: number, folder = '/work/relay', read = false): ClaudeHandoffRecord => ({ chatId, from: 'chat-a', folder, project: 'relay', at, read });

	test('adds a hand-off once per chat and keeps the newest hundred', () => {
		assert.deepStrictEqual(addClaudeHandoff([record('a', 1)], record('a', 2)).map(r => [r.chatId, r.at]), [['a', 2]]);
		let records: ClaudeHandoffRecord[] = [];
		for (let i = 0; i < 120; i++) {
			records = addClaudeHandoff(records, record(`c${i}`, i));
		}
		assert.deepStrictEqual([records.length, records[0].chatId, records[99].chatId], [100, 'c20', 'c119']);
	});

	test('the timeline is newest first', () => {
		assert.deepStrictEqual(claudeHandoffTimeline([record('a', 1), record('c', 3), record('b', 2)]).map(r => r.chatId), ['c', 'b', 'a']);
	});

	test('marking read clears the unread count, and changes nothing twice', () => {
		const records = [record('a', 1), record('b', 2, '/work/other')];
		const after = markClaudeHandoffRead(records, 'a');
		assert.deepStrictEqual([...claudeUnreadByFolder(records)], [['/work/relay', 1], ['/work/other', 1]]);
		assert.deepStrictEqual([...claudeUnreadByFolder(after)], [['/work/other', 1]]);
		assert.strictEqual(markClaudeHandoffRead(after, 'a'), after);
	});

	test('parsing drops malformed entries', () => {
		const good = record('a', 1);
		assert.deepStrictEqual(parseClaudeHandoffs(JSON.stringify([good, { chatId: 5 }, null, 'x'])), [good]);
		assert.deepStrictEqual(parseClaudeHandoffs('not json'), []);
		assert.deepStrictEqual(parseClaudeHandoffs(undefined), []);
	});
});
