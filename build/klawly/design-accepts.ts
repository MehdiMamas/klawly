/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The per-page accept files of design-sync: design/.accepts/<page>.json holds what one page was
// last redrawn against ({ sources, clicks }). One file per page means two branches that accept
// different pages touch different files and merge with no conflict.

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';

export interface PageAccepts {
	/** Per page: hash of every app file it names in `data-source`, when it was last redrawn. */
	pages: Record<string, Record<string, string>>;
	/** Per page: every checked click and its verdict ('app', 'idea' or 'differs'). */
	clicks: Record<string, Record<string, string>>;
}

const pageOf = (dir: string, path: string): string => relative(dir, path).split(sep).join('/').replace(/\.json$/, '');

/** Writes only real changes, in the line endings the file already has, so a CRLF checkout stays clean. */
function writeIfChanged(path: string, text: string): void {
	const old = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
	if (old?.replace(/\r\n/g, '\n') === text) {
		return;
	}
	writeFileSync(path, old?.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text);
}

export function readAccepts(dir: string): PageAccepts | undefined {
	if (!existsSync(dir)) {
		return undefined;
	}
	const state: PageAccepts = { pages: {}, clicks: {} };
	const walk = (folder: string): void => {
		for (const entry of readdirSync(folder, { withFileTypes: true })) {
			const path = join(folder, entry.name);
			if (entry.isDirectory()) {
				walk(path);
			} else if (entry.isFile() && entry.name.endsWith('.json')) {
				const page = pageOf(dir, path);
				const file = JSON.parse(readFileSync(path, 'utf8')) as { sources?: Record<string, string>; clicks?: Record<string, string> };
				state.pages[page] = file.sources ?? {};
				state.clicks[page] = file.clicks ?? {};
			}
		}
	};
	walk(dir);
	return state;
}

/** Writes one accept file per page and removes the files of pages that no longer exist. */
export function writeAccepts(state: Partial<PageAccepts> & Pick<PageAccepts, 'pages'>, dir: string): void {
	for (const page of Object.keys(state.pages)) {
		const path = join(dir, `${page}.json`);
		mkdirSync(dirname(path), { recursive: true });
		writeIfChanged(path, JSON.stringify({ sources: state.pages[page], clicks: state.clicks?.[page] ?? {} }, undefined, '\t') + '\n');
	}
	const walk = (folder: string): void => {
		for (const entry of existsSync(folder) ? readdirSync(folder, { withFileTypes: true }) : []) {
			const path = join(folder, entry.name);
			if (entry.isDirectory()) {
				walk(path);
			} else if (entry.name.endsWith('.json') && !(pageOf(dir, path) in state.pages)) {
				rmSync(path);
			}
		}
	};
	walk(dir);
}

/** True while git is in the middle of a rebase or merge, in this checkout or worktree. */
export function gitBusy(root: string): boolean {
	try {
		const out = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
		const gitDir = isAbsolute(out) ? out : resolve(root, out);
		return ['rebase-merge', 'rebase-apply', 'MERGE_HEAD'].some(name => existsSync(join(gitDir, name)));
	} catch {
		return false;
	}
}
