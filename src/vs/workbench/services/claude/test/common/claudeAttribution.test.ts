/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ATTRIBUTION_INLINE_SOURCE, ATTRIBUTION_TAB_SOURCE, attributionOwners, ClaudeAttributionSource, ClaudeFileAttribution, ClaudeLineOwner, decodeAttributionLedger, encodeAttributionLedger, hashAttributionLines, inlineAcceptedSpans, keptHunkFromReview, keptHunkKey, mapAttributionLines, recordKeptHunks, tabAcceptedSpan } from '../../common/claudeAttribution.js';
import { collectReviewHunks } from '../../common/claudeReview.js';

const uri = URI.file('/repo/src/parser.ts');

function source(turnId: string, turn: number): ClaudeAttributionSource {
	return { sessionId: 's1', turnId, turn, sessionTitle: 'Fix the parser', model: 'Sonnet' };
}

/** Keeps every hunk of one turn, as the review's Keep All does. */
function keepTurn(record: ClaudeFileAttribution | undefined, before: string, after: string, turnId: string, turn: number): ClaudeFileAttribution {
	const hunks = collectReviewHunks(uri, before, after).map(hunk => keptHunkFromReview(hunk, keptHunkKey('s1', turnId, hunk.id), source(turnId, turn))!);
	return recordKeptHunks(record, hashAttributionLines(after.split('\n')), hunks, turn);
}

function describe(owners: readonly (ClaudeLineOwner | undefined)[] | undefined, lines: readonly string[]): string[] {
	return (owners ?? []).map((owner, index) => `${lines[index]} <- ${!owner ? '-' : owner.kind === 'human' ? 'human' : `${owner.kind} turn ${owner.source.turn}`}`);
}

suite('Claude line attribution', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('two kept turns and a hand edit: agent lines keep their turn, the edited line is human', () => {
		const original = 'function parse(text) {\n\treturn text;\n}';
		const turn1 = 'function parse(text) {\n\tconst trimmed = text.trim();\n\treturn trimmed;\n}';
		const turn2 = 'function parse(text) {\n\tconst trimmed = text.trim();\n\treturn trimmed;\n}\n\nexport { parse };';
		let record = keepTurn(undefined, original, turn1, 't1', 1);
		record = keepTurn(record, turn1, turn2, 't2', 2);
		// A person renames the variable on one line and adds a comment above the function.
		const edited = '// Parses input.\nfunction parse(text) {\n\tconst value = text.trim();\n\treturn trimmed;\n}\n\nexport { parse };';
		const lines = edited.split('\n');
		assert.deepStrictEqual(describe(attributionOwners(record, hashAttributionLines(lines)), lines), [
			'// Parses input. <- human',
			'function parse(text) { <- -',
			'\tconst value = text.trim(); <- human',
			'\treturn trimmed; <- agent turn 1',
			'} <- -',
			' <- agent turn 2',
			'export { parse }; <- agent turn 2',
		]);
	});

	test('a line edited by hand before Keep is human, and turns no line points at are dropped', () => {
		const before = 'a\nb\nc';
		const after = 'a\nB1\nB2\nc';
		const [hunk] = collectReviewHunks(uri, before, after);
		const kept = keptHunkFromReview(hunk, 'k', source('t1', 1))!;
		// The person changed B2 before pressing Keep.
		const current = hashAttributionLines(['a', 'B1', 'mine', 'c']);
		const record = recordKeptHunks(undefined, current, [kept], 0);
		const replaced = recordKeptHunks(record, hashAttributionLines(['a', 'x', 'mine', 'c']), [], 1);
		assert.deepStrictEqual({ first: record.owners, second: replaced.owners, sources: replaced.sources.length, kept: replaced.kept }, { first: [-1, 0, -2, -1], second: [-1, -2, -2, -1], sources: 0, kept: ['k'] });
	});

	test('maps unchanged lines across inserts and deletes', () => {
		assert.deepStrictEqual(mapAttributionLines([1, 2, 3, 4], [1, 9, 2, 4, 5]), [0, -1, 1, 3, -1]);
	});

	test('the ledger survives a round trip and drops a broken one', () => {
		const record = keepTurn(undefined, 'a\nb', 'a\nx\ny\nb', 't1', 1);
		const files = new Map([[uri.toString(), record]]);
		assert.deepStrictEqual({ trip: decodeAttributionLedger(encodeAttributionLedger(files)).get(uri.toString()), broken: decodeAttributionLedger('{').size }, { trip: record, broken: 0 });
	});

	test('a Tab completion spans one line per line break, not the line after a trailing break, and nothing when blank', () => {
		assert.deepStrictEqual([
			tabAcceptedSpan(4, 'total;'),
			tabAcceptedSpan(4, 'if (a) {\n\treturn b;\n}'),
			tabAcceptedSpan(4, 'return b;\n'),
			tabAcceptedSpan(4, '\n\n'),
		], [
			{ startLine: 4, endLine: 4 },
			{ startLine: 4, endLine: 6 },
			{ startLine: 4, endLine: 4 },
			undefined,
		]);
	});

	test('an inline edit owns only its own lines when the buffer drifted during the review', () => {
		const original = 'a\nb\nc';
		const produced = 'a\nB1\nB2\nc';
		// The person typed a line inside the edit before pressing Accept.
		const typed = 'a\nB1\nmine\nB2\nc';
		const spans = inlineAcceptedSpans(collectReviewHunks(uri, original, produced), collectReviewHunks(uri, original, typed));
		const record = recordKeptHunks(undefined, hashAttributionLines(typed.split('\n')), spans.map(span => ({ ...span, key: '', source: ATTRIBUTION_INLINE_SOURCE })), 0);
		assert.deepStrictEqual(record.owners, [-1, 0, -2, 0, -1]);
	});

	test('a Tab completion after a kept turn: both sources stay, and the accept adds no dedupe key', () => {
		const record = keepTurn(undefined, 'a\nb', 'a\nx\nb', 't1', 1);
		const lines = ['a', 'x', 'const y = 2;', 'b'];
		const span = tabAcceptedSpan(3, 'const y = 2;')!;
		const next = recordKeptHunks(record, hashAttributionLines(lines), [{ ...span, key: '', source: ATTRIBUTION_TAB_SOURCE }], 2);
		assert.deepStrictEqual({ owners: next.owners, origins: next.sources.map(entry => entry.origin ?? 'agent'), kept: next.kept }, {
			owners: [-1, 0, 1, -1],
			origins: ['agent', 'tab'],
			kept: record.kept,
		});
	});
});
