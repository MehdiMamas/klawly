/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Run: node --test build/klawly/test/design-accepts.test.ts
//
// The per-page accept files in design/.accepts: one file per page, so two branches that accept
// different pages merge with no conflict.

import assert from 'assert';
import { execFileSync, spawnSync } from 'child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { suite, test } from 'node:test';
import { gitBusy, readAccepts, writeAccepts } from '../design-accepts.ts';

function temp(): string {
	return mkdtempSync(join(tmpdir(), 'klawly-accepts-'));
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

suite('design accepts', () => {
	test('writes one file per page, nested by folder, and reads them back', () => {
		const dir = temp();
		try {
			const state = {
				pages: { 'chat/a.html': { 'x.ts': '111' }, 'home.html': { 'y.ts': '222' } },
				clicks: { 'chat/a.html': { 'link|Open': 'app' }, 'home.html': {} },
			};
			writeAccepts(state, dir);
			assert.deepStrictEqual(JSON.parse(readFileSync(join(dir, 'chat', 'a.html.json'), 'utf8')), { sources: { 'x.ts': '111' }, clicks: { 'link|Open': 'app' } });
			assert.deepStrictEqual(readAccepts(dir), state);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a missing folder reads as undefined, so a legacy sync.json can seed the first run', () => {
		assert.strictEqual(readAccepts(join(tmpdir(), 'klawly-accepts-missing')), undefined);
	});

	test('removes the file of a page that no longer exists and leaves the others untouched', () => {
		const dir = temp();
		try {
			writeAccepts({ pages: { 'a.html': {}, 'b.html': {} }, clicks: {} }, dir);
			writeAccepts({ pages: { 'a.html': {} }, clicks: {} }, dir);
			assert.deepStrictEqual([existsSync(join(dir, 'a.html.json')), existsSync(join(dir, 'b.html.json'))], [true, false]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('two branches that accept different pages merge one after the other with no conflict', () => {
		const repo = temp();
		try {
			const accepts = join(repo, 'design', '.accepts');
			mkdirSync(accepts, { recursive: true });
			git(repo, 'init', '-q', '-b', 'main');
			writeAccepts({ pages: { 'a.html': { 's.ts': '1' }, 'b.html': { 's.ts': '1' } }, clicks: {} }, accepts);
			git(repo, 'add', '-A');
			git(repo, 'commit', '-q', '-m', 'base');
			for (const [branch, page] of [['one', 'a.html'], ['two', 'b.html']]) {
				git(repo, 'checkout', '-q', '-b', branch, 'main');
				writeAccepts({ pages: { 'a.html': { 's.ts': '1' }, 'b.html': { 's.ts': '1' }, [page]: { 's.ts': '2' } }, clicks: {} }, accepts);
				git(repo, 'commit', '-q', '-am', `accept ${page}`);
			}
			git(repo, 'checkout', '-q', 'main');
			git(repo, 'merge', '-q', '--no-edit', 'one');
			git(repo, 'merge', '-q', '--no-edit', 'two');
			assert.deepStrictEqual(readAccepts(accepts)?.pages, { 'a.html': { 's.ts': '2' }, 'b.html': { 's.ts': '2' } });
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	test('git is busy while a merge or rebase is in progress, and not otherwise', () => {
		const repo = temp();
		try {
			git(repo, 'init', '-q', '-b', 'main');
			assert.strictEqual(gitBusy(repo), false);
			const gitDir = join(repo, '.git');
			writeFileSync(join(gitDir, 'MERGE_HEAD'), '0'.repeat(40) + '\n');
			assert.strictEqual(gitBusy(repo), true);
			rmSync(join(gitDir, 'MERGE_HEAD'));
			mkdirSync(join(gitDir, 'rebase-merge'));
			assert.strictEqual(gitBusy(repo), true);
			rmSync(join(gitDir, 'rebase-merge'), { recursive: true });
			mkdirSync(join(gitDir, 'rebase-apply'));
			assert.strictEqual(gitBusy(repo), true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

/** A scratch repo with the two scripts, one page (chat/a.html) that names src/x.ts, and that page's accept file. */
function scratchRoot(accepted: string | undefined): string {
	const root = temp();
	mkdirSync(join(root, 'build', 'klawly'), { recursive: true });
	for (const name of ['design-sync.ts', 'design-accepts.ts']) {
		copyFileSync(resolve(import.meta.dirname, '..', name), join(root, 'build', 'klawly', name));
	}
	mkdirSync(join(root, 'design', 'assets'), { recursive: true });
	mkdirSync(join(root, 'src'), { recursive: true });
	// The token and asset steps read these real app files.
	for (const file of ['extensions/theme-klawly/themes', 'extensions/theme-defaults/themes', 'src/vs/workbench/contrib/claude/browser/media/claude.css', 'src/vs/workbench/contrib/claude/browser/media/klawly-mark.svg', 'resources/klawly/klawly-mark-mono.svg']) {
				mkdirSync(dirname(join(root, file)), { recursive: true });
		cpSync(resolve(import.meta.dirname, '../../..', file), join(root, file), { recursive: true });
	}
	writeFileSync(join(root, 'design', 'assets', 'global.css'), '');
	mkdirSync(join(root, 'design', 'chat'), { recursive: true });
	writeFileSync(join(root, 'design', 'chat', 'a.html'), '<div data-source="src/x.ts" data-label="x"></div>');
	writeFileSync(join(root, 'src', 'x.ts'), 'now');
	if (accepted !== undefined) {
		mkdirSync(join(root, 'design', '.accepts', 'chat'), { recursive: true });
		writeFileSync(join(root, 'design', '.accepts', 'chat', 'a.html.json'), JSON.stringify({ sources: { 'src/x.ts': accepted }, clicks: {} }));
	}
	return root;
}

function designSync(root: string): string {
	const r = spawnSync(process.execPath, [join(root, 'build', 'klawly', 'design-sync.ts')], { cwd: root, encoding: 'utf8', windowsHide: true });
	return r.stdout + r.stderr;
}

suite('design-sync without accept files (#1466)', () => {
	test('a missing design/.accepts does not crash and does not read a stale legacy sync.json', () => {
		const root = scratchRoot(undefined);
		try {
			writeFileSync(join(root, 'design', 'sync.json'), JSON.stringify({ tokens: {}, pages: { 'chat/a.html': { 'src/x.ts': 'oldoldoldold' } } }));
			const out = designSync(root);
			assert.match(out, /0 page\(s\) to redraw/);
			assert.deepStrictEqual(Object.keys(JSON.parse(readFileSync(join(root, 'design', 'sync.json'), 'utf8'))), ['tokens', 'assets']);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('a sync.json with no pages at all does not crash either', () => {
		const root = scratchRoot(undefined);
		try {
			writeFileSync(join(root, 'design', 'sync.json'), JSON.stringify({ tokens: {}, assets: {} }));
			assert.match(designSync(root), /0 page\(s\) to redraw/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('a changed source with an accept file still reports the page', () => {
		const root = scratchRoot('oldoldoldold');
		try {
			assert.match(designSync(root), /1 page\(s\) to redraw/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
