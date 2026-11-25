/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { appendFindingReply, buildFindingReplyContext } from '../../common/claudeReviewReply.js';
import { readClaudeReviewFindings } from '../../common/claudeReviewLoop.js';

suite('Claude review reply', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const finding = { file: 'a.ts', startLine: 2, endLine: 3, severity: 'high' as const, category: 'bug' as const, title: 'Null deref', body: 'x may be null' };

	test('buildFindingReplyContext: finding, code, summary, thread and the new message', () => {
		assert.deepStrictEqual(buildFindingReplyContext(finding, ['const x = f();', 'x.y();'], ' Two issues. ', [{ role: 'user', text: 'why?' }, { role: 'assistant', text: 'because' }], ' it is intended ').split('\n'), [
			'You are answering in the thread of a code review finding. Answer briefly. Read files if you need to; do not edit anything.',
			'The reviewer reported this finding.',
			'',
			'<finding file="a.ts" lines="2-3" severity="high">',
			'Null deref',
			'x may be null',
			'</finding>',
			'<code>',
			'const x = f();',
			'x.y();',
			'</code>',
			'<review_summary>',
			'Two issues.',
			'</review_summary>',
			'<thread>',
			'Author: why?',
			'Reviewer: because',
			'</thread>',
			'',
			'Author: it is intended',
		]);
		assert.ok(buildFindingReplyContext({ ...finding, kind: 'question' }, [], undefined, [], 'm').includes('intent was unclear'));
	});

	test('appendFindingReply ignores empty text', () => {
		const empty = { findingId: 'f', replies: [] };
		assert.deepStrictEqual([appendFindingReply(empty, { role: 'user', text: '  ' }), appendFindingReply(empty, { role: 'user', text: ' hi ' })], [empty, { findingId: 'f', replies: [{ role: 'user', text: 'hi' }] }]);
	});

	test('question kind parser: only "question" is kept', () => {
		const raw = (kind?: string) => ({ findings: [{ file: 'a.ts', startLine: 1, endLine: 1, severity: 'low', title: 't', body: '', kind }] });
		assert.deepStrictEqual(
			[readClaudeReviewFindings(raw('question'))![0].kind, readClaudeReviewFindings(raw('finding'))![0].kind, readClaudeReviewFindings(raw('bogus'))![0].kind, readClaudeReviewFindings(raw())![0].kind],
			['question', undefined, undefined, undefined]);
	});
});
