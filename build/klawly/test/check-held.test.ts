/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findHeld, hasHeldMarker, isHeldPath } from '../check-held.ts';

test('held paths', () => {
	assert.deepStrictEqual(
		['a/accountChain.held.ts', 'a/held/x.ts', 'held/x.ts', 'a/held', 'a/holder.ts', 'a/heldx/y.ts', 'a/x.ts'].map(isHeldPath),
		[true, true, true, true, false, false, false]);
});

test('held marker', () => {
	assert.deepStrictEqual([hasHeldMarker('// @klawly-held'), hasHeldMarker('// held')], [true, false]);
});

test('findHeld walks a tree', () => {
	const root = mkdtempSync(join(tmpdir(), 'held-'));
	try {
		mkdirSync(join(root, 'a', 'held'), { recursive: true });
		mkdirSync(join(root, 'b'));
		writeFileSync(join(root, 'a', 'held', 'x.ts'), '');
		writeFileSync(join(root, 'b', 'ok.ts'), 'export {}');
		writeFileSync(join(root, 'b', 'marked.ts'), '/* @klawly-held */');
		assert.deepStrictEqual(findHeld(root).sort(), [join('a', 'held'), join('b', 'marked.ts')]);
		assert.deepStrictEqual(findHeld(join(root, 'b')).sort(), ['marked.ts']);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
