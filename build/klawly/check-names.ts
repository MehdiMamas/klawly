/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Klawly's own files never name another AI editor. Upstream Code - OSS files are not scanned:
// only the files Klawly wrote. "cursor" meaning the text cursor is fine, so only the product forms are banned.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const banned: readonly RegExp[] = [
	/\bwindsurf\b/i,
	/\bcodeium\b/i,
	/\banysphere\b/i,
	/\bcursor\.(com|sh)\b/i,
	/\bcursor\s+(ide|editor|ai|agent|composer)\b/i,
	/\b(like|from|vs\.?|versus|than|unlike)\s+cursor\b/i,
];

// The files Klawly wrote itself.
const scanned: readonly string[] = [
	'README.md',
	'CONTRIBUTING.md',
	'LICENSE.txt',
	'product.json',
	'.github/workflows',
	'build/klawly',
	'resources/klawly',
	'extensions/theme-klawly',
];

const self = 'build/klawly/check-names.ts';
const files = execFileSync('git', ['ls-files', '-z', '--', ...scanned], { encoding: 'utf8' }).split('\0').filter(f => f && f !== self && !/\.(png|ico|icns|bmp)$/.test(f));

let failures = 0;
for (const file of files) {
	const lines = readFileSync(file, 'utf8').split('\n');
	lines.forEach((line, index) => {
		for (const pattern of banned) {
			if (pattern.test(line)) {
				console.error(`${file}:${index + 1}: names another AI editor (${pattern})`);
				failures++;
			}
		}
	});
}

if (failures > 0) {
	process.exit(1);
}
console.log(`check-names: ${files.length} files clean`);
