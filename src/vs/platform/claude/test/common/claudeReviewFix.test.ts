/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { applyClaudeSuggestion, claudeGithubSuggestionBlock, claudeLinesHash } from '../../common/claudeReviewFix.js';

suite('Claude review fix', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('applyClaudeSuggestion: single line, multi-line, file edges, stale, none', () => {
		const text = 'a\nb\nc\nd';
		const hash = (from: number, to: number) => claudeLinesHash(text.split('\n').slice(from - 1, to));
		assert.deepStrictEqual({
			single: applyClaudeSuggestion(text, { startLine: 2, endLine: 2, replacement: 'B' }, hash(2, 2)),
			multi: applyClaudeSuggestion(text, { startLine: 2, endLine: 3, replacement: 'x\ny\nz\n' }, hash(2, 3)),
			shrink: applyClaudeSuggestion(text, { startLine: 1, endLine: 4, replacement: 'only' }, hash(1, 4)),
			first: applyClaudeSuggestion(text, { startLine: 1, endLine: 1, replacement: '0' }),
			last: applyClaudeSuggestion(text, { startLine: 4, endLine: 4, replacement: 'D' }),
			crlf: applyClaudeSuggestion('a\r\nb\r\nc', { startLine: 2, endLine: 2, replacement: 'B1\nB2' }),
			changedSinceReview: applyClaudeSuggestion('a\nB\nc\nd', { startLine: 2, endLine: 2, replacement: 'x' }, hash(2, 2)),
			pastEnd: applyClaudeSuggestion(text, { startLine: 4, endLine: 6, replacement: 'x' }),
			noSuggestion: applyClaudeSuggestion(text, { startLine: 1, endLine: 1, replacement: '' }),
		}, {
			single: { kind: 'applied', text: 'a\nB\nc\nd' },
			multi: { kind: 'applied', text: 'a\nx\ny\nz\nd' },
			shrink: { kind: 'applied', text: 'only' },
			first: { kind: 'applied', text: '0\nb\nc\nd' },
			last: { kind: 'applied', text: 'a\nb\nc\nD' },
			crlf: { kind: 'applied', text: 'a\r\nB1\r\nB2\r\nc' },
			changedSinceReview: { kind: 'stale' },
			pastEnd: { kind: 'stale' },
			noSuggestion: { kind: 'none' },
		});
	});

	test('claudeGithubSuggestionBlock: fence grows around backticks, no suggestion gives nothing', () => {
		assert.deepStrictEqual([
			claudeGithubSuggestionBlock('x = 1\n'),
			claudeGithubSuggestionBlock('s = ```md```'),
			claudeGithubSuggestionBlock(undefined),
		], [
			'```suggestion\nx = 1\n```',
			'````suggestion\ns = ```md```\n````',
			undefined,
		]);
	});
});
