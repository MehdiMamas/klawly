/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ATTRIBUTION_HUMAN, ClaudeFileAttribution, hashAttributionLines } from '../../common/claudeAttribution.js';
import { carryAttributionNote, decodeAttributionNote, encodeAttributionNote, noteFileFromRecord, recordFromNoteFile } from '../../common/claudeAttributionNote.js';

suite('Claude attribution notes', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const lines = ['a', 'b', 'c', 'd', 'e'];
	const record: ClaudeFileAttribution = {
		lines: hashAttributionLines(lines),
		owners: [-1, 0, 0, ATTRIBUTION_HUMAN, 1],
		sources: [
			{ sessionId: 's1', turnId: 't1', turn: 2, sessionTitle: 'Secret title', model: 'Sonnet' },
			{ origin: 'tab', sessionId: 'klawly.tab', turnId: 'tab' },
		],
		kept: ['k'],
		updated: 1,
	};

	test('a note holds ranges and origins, never session, title or model', () => {
		const file = noteFileFromRecord(record, lines)!;
		assert.deepStrictEqual(file, { sources: [{ origin: 'agent', turn: 2 }, { origin: 'tab' }], ranges: [[2, 3, 0], [5, 5, 1]] });
		const text = JSON.stringify(file);
		assert.ok(!text.includes('Secret') && !text.includes('Sonnet') && !text.includes('s1'));
	});

	test('lines changed since the record are not claimed', () => {
		const file = noteFileFromRecord(record, ['a', 'b', 'X', 'd', 'e'])!;
		assert.deepStrictEqual(file.ranges, [[2, 2, 0], [5, 5, 1]]);
		assert.strictEqual(noteFileFromRecord(record, ['x', 'y']), undefined);
		assert.strictEqual(noteFileFromRecord(undefined, lines), undefined);
	});

	test('encode and decode round-trip, and bad input is dropped', () => {
		const note = { v: 1 as const, files: { 'src/a.ts': noteFileFromRecord(record, lines)! } };
		assert.deepStrictEqual(JSON.parse(JSON.stringify(decodeAttributionNote(encodeAttributionNote(note)))), note);
		assert.strictEqual(decodeAttributionNote(undefined), undefined);
		assert.strictEqual(decodeAttributionNote('not json'), undefined);
		assert.strictEqual(decodeAttributionNote('{"v":2,"files":{}}'), undefined);
		assert.deepStrictEqual(JSON.parse(JSON.stringify(decodeAttributionNote('{"v":1,"files":{"a":{"sources":[{"origin":"agent"}],"ranges":[[0,1,0],[3,2,0],[1,1,5],[2,3,0]]}}}'))), { v: 1, files: { a: { sources: [{ origin: 'agent' }], ranges: [[2, 3, 0]] } } });
	});

	test('a record rebuilt from a note marks the noted lines and calls the rest human', () => {
		const rebuilt = recordFromNoteFile(noteFileFromRecord(record, lines)!, lines, 7);
		assert.deepStrictEqual(rebuilt.owners, [ATTRIBUTION_HUMAN, 0, 0, ATTRIBUTION_HUMAN, 1]);
		assert.deepStrictEqual(rebuilt.sources.map(s => s.origin), ['agent', 'tab']);
	});

	test('a rewritten commit keeps notes only for files whose content is identical', () => {
		const file = noteFileFromRecord(record, lines)!;
		const note = { v: 1 as const, files: { 'same.ts': file, 'changed.ts': file } };
		assert.deepStrictEqual(Object.keys(carryAttributionNote(note, path => path === 'same.ts')!.files), ['same.ts']);
		assert.strictEqual(carryAttributionNote(note, () => false), undefined);
	});
});
