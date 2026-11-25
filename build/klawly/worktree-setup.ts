/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Makes a fresh git worktree runnable (issue 1390): every folder with a package-lock.json gets the main
// checkout's node_modules, and .build/electron and .build/typings come from the main checkout too.
// A folder whose lock file equals main's is linked (a junction on Windows, a symlink elsewhere, so nothing
// needs admin rights); a folder whose lock file differs gets `npm ci` (rule 55: reinstall only on a lock change).
// Git ignores the links (`node_modules`, `.build/`), and `git worktree remove` deletes a link, not its target.

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, symlinkSync, mkdirSync } from 'fs';
import path from 'path';

export type DependencyAction = 'present' | 'link' | 'install' | 'unavailable';

/**
 * What a worktree folder needs for its node_modules.
 * `mainLock` and `worktreeLock` are the lock files' text (undefined when missing).
 */
export function decideDependencies(state: { readonly worktreeHasModules: boolean; readonly mainHasModules: boolean; readonly mainLock: string | undefined; readonly worktreeLock: string | undefined }): DependencyAction {
	if (state.worktreeHasModules) {
		return 'present';
	}
	if (state.worktreeLock === undefined) {
		return 'unavailable';
	}
	if (state.mainHasModules && state.mainLock === state.worktreeLock) {
		return 'link';
	}
	return 'install';
}

/** Links `link` to `target`: a junction on Windows, a directory symlink elsewhere. */
export function linkDirectory(target: string, link: string): void {
	mkdirSync(path.dirname(link), { recursive: true });
	symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

function readIfExists(file: string): string | undefined {
	return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

/** The main checkout's root, found through the shared git dir; the worktree root itself when it is the main one. */
export function mainCheckoutRoot(worktreeRoot: string): string {
	const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: worktreeRoot, encoding: 'utf8', windowsHide: true }).trim();
	return path.dirname(path.resolve(common));
}

/** Folders (relative, '' for the root) holding a tracked package-lock.json. */
function lockFolders(root: string): string[] {
	const out = execFileSync('git', ['ls-files', '-z', '--', 'package-lock.json', '**/package-lock.json'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
	return out.split('\0').filter(Boolean).map(file => path.dirname(file)).map(dir => dir === '.' ? '' : dir);
}

/**
 * Makes `worktreeRoot` ready to compile, typecheck and run Electron. Does nothing in the main checkout.
 * Returns one line per thing it did, for the log.
 */
export function prepareWorktree(worktreeRoot: string, log: (line: string) => void = console.log): void {
	const mainRoot = mainCheckoutRoot(worktreeRoot);
	if (path.resolve(mainRoot) === path.resolve(worktreeRoot)) {
		return;
	}
	for (const folder of lockFolders(worktreeRoot)) {
		const modules = path.join(worktreeRoot, folder, 'node_modules');
		const action = decideDependencies({
			worktreeHasModules: existsSync(modules),
			mainHasModules: existsSync(path.join(mainRoot, folder, 'node_modules')),
			mainLock: readIfExists(path.join(mainRoot, folder, 'package-lock.json')),
			worktreeLock: readIfExists(path.join(worktreeRoot, folder, 'package-lock.json')),
		});
		if (action === 'link') {
			linkDirectory(path.join(mainRoot, folder, 'node_modules'), modules);
			log(`linked ${path.join(folder, 'node_modules')} to the main checkout`);
		} else if (action === 'install' && (folder === '' || existsSync(path.join(mainRoot, folder, 'node_modules')))) {
			// A folder the main checkout never installed (optional sub-projects) is not needed; the others differ from main.
			log(`npm ci in ${folder || '.'}: lock file differs from the main checkout`);
			execFileSync('npm', ['ci'], { cwd: path.join(worktreeRoot, folder), stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
		}
	}
	// .build/electron is the app build; .build/typings holds electron.d.ts, which the typecheck reads.
	const builds: { name: string; fetch: string[] }[] = [
		{ name: 'electron', fetch: ['run', 'electron'] },
		{ name: 'typings', fetch: ['build/npm/electronTypes.ts'] },
	];
	for (const { name, fetch } of builds) {
		const here = path.join(worktreeRoot, '.build', name);
		const there = path.join(mainRoot, '.build', name);
		if (existsSync(here)) {
			continue;
		}
		if (existsSync(there)) {
			linkDirectory(there, here);
			log(`linked .build/${name} to the main checkout`);
		} else {
			log(`no .build/${name} in the main checkout: fetching it`);
			execFileSync(name === 'electron' ? 'npm' : 'node', fetch, { cwd: worktreeRoot, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
		}
	}
}
