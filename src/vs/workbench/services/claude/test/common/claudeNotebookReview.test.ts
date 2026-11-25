/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { collectReviewHunks } from '../../common/claudeReview.js';
import { groupHunksByCell, notebookCellLines } from '../../common/claudeNotebookReview.js';

function notebook(sources: string[]): string {
	const cells = sources.map(source => ({ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: source.split('\n').map((line, i, all) => i < all.length - 1 ? line + '\n' : line) }));
	return JSON.stringify({ cells, metadata: { cells: [1, 2] }, nbformat: 4, nbformat_minor: 5 }, undefined, 1) + '\n';
}

suite('Claude notebook review', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const uri = URI.file('C:/repo/a.ipynb');

	test('finds the lines of each cell, ignoring braces in strings and a metadata key named cells', () => {
		const text = notebook(['x = "{"', 'y = "]"\nz = 1']);
		const cells = notebookCellLines(text);
		assert.deepStrictEqual(cells.map(c => c.index), [0, 1]);
		const lines = text.split('\n');
		for (const cell of cells) {
			assert.strictEqual(lines[cell.startLine - 1].trim(), '{');
			assert.ok(lines[cell.endLine - 1].trim().startsWith('}'));
		}
		assert.ok(cells[0].endLine < cells[1].startLine);
		assert.deepStrictEqual(notebookCellLines('not json'), []);
	});

	test('maps a changed cell, an added cell and a removed cell to their cell index', () => {
		const before = notebook(['a = 1', 'b = 2', 'c = 3']);
		const changed = notebook(['a = 1', 'b = 20', 'c = 3']);
		let file = { originalText: before, hunks: collectReviewHunks(uri, before, changed) };
		let groups = groupHunksByCell(file, changed);
		assert.deepStrictEqual(groups.map(g => [g.index, g.kind]), [[1, 'changed']]);

		const added = notebook(['a = 1', 'b = 2', 'new = 0', 'c = 3']);
		file = { originalText: before, hunks: collectReviewHunks(uri, before, added) };
		groups = groupHunksByCell(file, added);
		assert.strictEqual(groups.length, 1);
		assert.strictEqual(groups[0].kind, 'added');

		const removed = notebook(['a = 1', 'c = 3']);
		file = { originalText: before, hunks: collectReviewHunks(uri, before, removed) };
		groups = groupHunksByCell(file, removed);
		assert.ok(groups.length >= 1);
		assert.ok(groups.every(g => g.kind !== 'added'));
	});

	test('skips settled hunks and sorts cells in notebook order', () => {
		const before = notebook(['a = 1', 'b = 2', 'c = 3']);
		const after = notebook(['a = 10', 'b = 2', 'c = 30']);
		const hunks = collectReviewHunks(uri, before, after);
		assert.strictEqual(groupHunksByCell({ originalText: before, hunks }, after).map(g => g.index).join(), '0,2');
		hunks[0].state = 'accepted';
		assert.strictEqual(groupHunksByCell({ originalText: before, hunks }, after).map(g => g.index).join(), '2');
	});
});
