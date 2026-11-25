/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Fails when code of a held feature (#1183, label `hold`) is in the tree of a release build, so
// held features are excluded at build time and not only flagged off. Held code lives in a file
// named `*.held.ts`, in a folder named `held`, or carries a `@klawly-held` marker comment.
//
// Usage: node build/klawly/check-held.ts [root]   (default: src)
// The Package workflow runs it for every release tag before it packages.

import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const HELD_PATH = /(?:\.held\.[cm]?[jt]sx?$)|(?:(?:^|[/\\])held(?:[/\\]|$))/;
const HELD_MARKER = /@klawly-held\b/;

/** Whether a path (relative to the scanned root) belongs to a held feature. */
export function isHeldPath(path: string): boolean {
	return HELD_PATH.test(path);
}

/** Whether a source text carries the held marker. */
export function hasHeldMarker(text: string): boolean {
	return HELD_MARKER.test(text);
}

/** Held files under `root`, as paths relative to it. */
export function findHeld(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			const rel = relative(root, full);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name === '.git') {
					continue;
				}
				if (isHeldPath(rel)) {
					found.push(rel);
				} else {
					walk(full);
				}
			} else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
				if (isHeldPath(rel) || hasHeldMarker(readFileSync(full, 'utf8'))) {
					found.push(rel);
				}
			}
		}
	};
	walk(root);
	return found;
}

if (import.meta.filename === process.argv[1]) {
	const held = findHeld(process.argv[2] ?? 'src');
	if (held.length) {
		console.error(`Held feature code is in a release build (#1183):\n${held.map(f => `  ${f}`).join('\n')}`);
		process.exit(1);
	}
	console.log('No held feature code in the tree.');
}
