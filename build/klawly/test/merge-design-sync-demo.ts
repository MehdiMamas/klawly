/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Demo of the klawly-design-sync merge driver in a temp repo: two branches change different
// surfaces, both rewrite design/sync.json, and merge back to back with no conflict.
// Run: node build/klawly/test/merge-design-sync-demo.ts   (exits 1 if a merge needed manual work)
// The temp repo holds a stand-in design-sync that rewrites sync.json from the pages present.

import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '../../..');
const dir = mkdtempSync(join(tmpdir(), 'klawly-merge-demo-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const node = (...args: string[]) => execFileSync(process.execPath, args, { cwd: dir });
const pagesIn = () => JSON.parse(readFileSync(join(dir, 'design/sync.json'), 'utf8')).pages as string[];

/** The driver's detached finisher amends the merge commit a moment after git returns: wait for it. */
async function settled(): Promise<void> {
	const synced = () => pagesIn().join() === readdirSync(join(dir, 'design/pages')).sort().join() && !git('status', '--porcelain', '--untracked-files=no');
	for (let i = 0; i < 100 && !synced(); i++) {
		await new Promise(done => setTimeout(done, 100));
	}
}

try {
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'demo@example.com');
	git('config', 'user.name', 'demo');
	mkdirSync(join(dir, 'design/pages'), { recursive: true });
	mkdirSync(join(dir, 'build/klawly'), { recursive: true });
	// Stand-in for design-sync.ts: same flags, baseline = sorted list of pages present.
	writeFileSync(join(dir, 'build/klawly/design-sync.ts'), [
		`import { readdirSync, writeFileSync } from 'fs';`,
		`import { join, resolve } from 'path';`,
		`const root = resolve(import.meta.dirname, '../..');`,
		`const i = process.argv.indexOf('--sync-file');`,
		`const out = i >= 0 ? process.argv[i + 1] : join(root, 'design/sync.json');`,
		`writeFileSync(out, JSON.stringify({ pages: readdirSync(join(root, 'design/pages')).sort() }, undefined, 2) + String.fromCharCode(10));`,
		'',
	].join('\n'));
	writeFileSync(join(dir, 'build/klawly/merge-design-sync.ts'), readFileSync(join(ROOT, 'build/klawly/merge-design-sync.ts'), 'utf8'));
	writeFileSync(join(dir, '.gitattributes'), 'design/sync.json merge=klawly-design-sync\n');
	writeFileSync(join(dir, 'design/pages/home.html'), 'home\n');
	node('build/klawly/design-sync.ts');
	git('add', '-A');
	git('commit', '-qm', 'base');
	// The same install step as npm install; the second run proves it is idempotent.
	node('build/klawly/merge-design-sync.ts', '--install');
	node('build/klawly/merge-design-sync.ts', '--install');
	console.log('driver:', git('config', '--get', 'merge.klawly-design-sync.driver'));

	for (const surface of ['review', 'goals']) {
		git('checkout', '-q', '-b', surface, 'main');
		writeFileSync(join(dir, `design/pages/${surface}.html`), `${surface}\n`);
		node('build/klawly/design-sync.ts');
		git('add', '-A');
		git('commit', '-qm', surface);
	}
	git('checkout', '-q', 'main');
	for (const surface of ['review', 'goals']) {
		git('merge', '--no-edit', surface); // throws on a conflict
		await settled();
		console.log(`merged ${surface}; sync.json pages: ${pagesIn().join(', ')}`);
	}
	if (pagesIn().join() !== readdirSync(join(dir, 'design/pages')).sort().join()) {
		throw new Error('sync.json does not match the merged pages');
	}
	console.log('OK: two back-to-back merges, no manual conflict on design/sync.json');
} catch (error) {
	console.error('FAILED:', error instanceof Error ? error.message : error);
	process.exitCode = 1;
} finally {
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { // a lingering handle on Windows: the OS temp cleaner takes it
	}
}
