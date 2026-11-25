/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Run: node --test build/klawly/test/windows-hide.test.ts
//
// Every child process a build/klawly script starts passes `windowsHide: true`. Git runs some of
// these scripts in the background (the design/sync.json merge driver and its detached --finish
// poller); a process without a console that starts an unhidden child opens a new terminal window
// on Windows, once per call.

import assert from 'assert';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { test } from 'node:test';

const DIR = resolve(import.meta.dirname, '..');
// These only run on macOS (codesign, notarytool, tiffutil).
const MAC_ONLY = new Set(['sign-darwin.ts', 'generate-icons.ts']);
const CALL = /(?<![.\w])(?<name>execFileSync|execSync|spawnSync|spawn|execFile)\(/g;

/** Returns the source of the call that opens at `start`, up to its closing parenthesis. */
function callAt(source: string, start: number): string {
	let depth = 0;
	for (let i = source.indexOf('(', start); i < source.length; i++) {
		if (source[i] === '(') {
			depth++;
		} else if (source[i] === ')' && --depth === 0) {
			return source.slice(start, i + 1);
		}
	}
	return source.slice(start);
}

test('every child_process call in build/klawly passes windowsHide', () => {
	const missing: string[] = [];
	for (const file of readdirSync(DIR).filter(name => name.endsWith('.ts') && !MAC_ONLY.has(name))) {
		const source = readFileSync(join(DIR, file), 'utf8');
		for (const match of source.matchAll(CALL)) {
			if (!callAt(source, match.index).includes('windowsHide')) {
				missing.push(`${file}:${source.slice(0, match.index).split('\n').length} ${match.groups?.name}`);
			}
		}
	}
	assert.deepStrictEqual(missing, []);
});
