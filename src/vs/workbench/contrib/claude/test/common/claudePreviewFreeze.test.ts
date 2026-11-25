/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FREEZE_MAX_POINTS, FREEZE_MAX_STROKES, FreezeDrawing, freezeBoxRect, freezeClampPoint, freezeFlattenScale, freezeFlattenSize } from '../../common/claudePreviewFreeze.js';

suite('Claude preview Freeze Frame', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('undo removes the last stroke and clear removes all', () => {
		const drawing = new FreezeDrawing();
		assert.strictEqual(drawing.undo(), false);
		drawing.add({ tool: 'pen', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] });
		drawing.add({ tool: 'box', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] });
		assert.strictEqual(drawing.strokes.length, 2);
		assert.strictEqual(drawing.undo(), true);
		assert.deepStrictEqual(drawing.strokes.map(s => s.tool), ['pen']);
		drawing.clear();
		assert.strictEqual(drawing.isEmpty, true);
	});

	test('an empty stroke or a zero-size box is refused', () => {
		const drawing = new FreezeDrawing();
		assert.strictEqual(drawing.add({ tool: 'pen', points: [] }), false);
		assert.strictEqual(drawing.add({ tool: 'box', points: [{ x: 3, y: 3 }, { x: 3, y: 3 }] }), false);
		assert.strictEqual(drawing.add({ tool: 'box', points: [{ x: 3, y: 3 }] }), false);
		assert.strictEqual(drawing.isEmpty, true);
	});

	test('a box keeps only its two corners and a pen stroke is capped', () => {
		const drawing = new FreezeDrawing();
		drawing.add({ tool: 'box', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 9, y: 9 }] });
		assert.deepStrictEqual(drawing.strokes[0].points, [{ x: 1, y: 1 }, { x: 9, y: 9 }]);
		const many = Array.from({ length: FREEZE_MAX_POINTS + 50 }, (_, i) => ({ x: i, y: i }));
		drawing.add({ tool: 'pen', points: many });
		assert.strictEqual(drawing.strokes[1].points.length, FREEZE_MAX_POINTS);
	});

	test('the frame refuses strokes past the cap', () => {
		const drawing = new FreezeDrawing();
		for (let i = 0; i < FREEZE_MAX_STROKES; i++) {
			assert.strictEqual(drawing.add({ tool: 'pen', points: [{ x: i, y: 0 }] }), true);
		}
		assert.strictEqual(drawing.add({ tool: 'pen', points: [{ x: 0, y: 0 }] }), false);
	});

	test('a box drags in any direction', () => {
		assert.deepStrictEqual(freezeBoxRect({ x: 10, y: 20 }, { x: 4, y: 5 }), { x: 4, y: 5, width: 6, height: 15 });
	});

	test('flatten size and scale follow the captured image', () => {
		assert.deepStrictEqual(freezeFlattenSize({ width: 0, height: 799.6 }), { width: 1, height: 800 });
		assert.deepStrictEqual(freezeFlattenScale({ width: 400, height: 300 }, { width: 800, height: 600 }), { x: 2, y: 2 });
		assert.deepStrictEqual(freezeFlattenScale({ width: 0, height: 0 }, { width: 800, height: 600 }), { x: 1, y: 1 });
	});

	test('a point outside the frame clamps to its edge', () => {
		assert.deepStrictEqual(freezeClampPoint({ x: -5, y: 900 }, { width: 400, height: 300 }), { x: 0, y: 300 });
	});
});
