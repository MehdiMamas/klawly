/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, mkdtempSync, utimesSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { pruneClaudeCanvases, saveClaudeCanvas } from '../../node/claudeCanvasFiles.js';

suite('Claude canvas files (issue 493)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'klawly-canvas-'));
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('saves under the session folder, updates by name, and never leaves the canvases folder', async () => {
		const first = await saveClaudeCanvas(root, 'session/../1', { name: 'Slow Tests', title: 'Slowest tests', html: '<p>one</p>' });
		const second = await saveClaudeCanvas(root, 'session/../1', { name: 'slow-tests', html: '<p>two</p>' });
		const escape = await saveClaudeCanvas(root, '../..', { name: '../../x', html: '<p>x</p>' });
		const empty = await saveClaudeCanvas(root, 's', { name: 'x', html: '' });
		const file = join(root, 'session-1', 'slow-tests.html');
		assert.deepStrictEqual({
			first,
			second,
			escape: escape.kind,
			empty,
			content: readFileSync(file, 'utf8'),
			folders: readdirSync(root).sort(),
			outside: existsSync(join(root, '..', 'x.html')),
		}, {
			first: { kind: 'saved', path: file, name: 'slow-tests', title: 'Slowest tests', updated: false },
			second: { kind: 'saved', path: file, name: 'slow-tests', title: 'slow-tests', updated: true },
			escape: 'failed',
			empty: { kind: 'failed', message: 'Give the HTML of the page.' },
			content: '<p>two</p>',
			folders: ['session-1'],
			outside: false,
		});
	});
	test('prunes pages older than the limit and the session folder they leave empty', async () => {
		const old = await saveClaudeCanvas(root, 'old', { name: 'a', html: '<p>a</p>' });
		const fresh = await saveClaudeCanvas(root, 'new', { name: 'b', html: '<p>b</p>' });
		const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		if (old.kind === 'saved') {
			utimesSync(old.path, longAgo, longAgo);
		}
		const removed = await pruneClaudeCanvases(root, Date.now());
		assert.deepStrictEqual({ removed, folders: readdirSync(root), freshKept: fresh.kind === 'saved' && existsSync(fresh.path), missingRoot: await pruneClaudeCanvases(join(root, 'none'), Date.now()) }, { removed: 1, folders: ['new'], freshKept: true, missingRoot: 0 });
	});
});
