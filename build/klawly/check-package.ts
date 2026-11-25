/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Fails a packaged build that ships what Klawly must never ship (issue 548), and prints its file
// count and size so each alpha can be compared with Alpha 8 (24,208 files, 1.7 GB on Windows).
// Runs as the last step of every `klawly-<platform>-<arch>[-min]` gulp task, locally and in CI.
// Usage: node build/klawly/check-package.ts <built folder, e.g. ../Klawly-win32-x64>
// Never allowed in the package:
//   - a source map (`*.map`), or a `sourceMappingURL=` pointing at Microsoft's CDN;
//   - the built-in Copilot extension (`extensions/copilot`);
//   - any Anthropic package (`@anthropic-ai/*`; Klawly drives the user's own Claude Code CLI, issue 1654),
//     the Copilot SDK (`@github/copilot-sdk`, `@github/copilot-sdk-<platform>-<arch>`), the Copilot CLI
//     (`@github/copilot`, `@github/copilot-<platform>-<arch>`) or the mxc-sdk package
//     (`@microsoft/mxc-sdk`, issues 659 and 697), loose, in `node_modules.asar` or in
//     `node_modules.asar.unpacked`.

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

/** What the check found in one packaged build. */
export interface PackageReport {
	readonly files: number;
	readonly bytes: number;
	readonly violations: readonly string[];
}

/** Package folders that must never ship, wherever they sit, with what each one is. */
const forbiddenModules: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
	{ pattern: /(^|\/)@anthropic-ai\/[^/]+(\/|$)/, label: 'an Anthropic package' },
	{ pattern: /(^|\/)@github\/copilot-sdk(-[^/]+)?(\/|$)/, label: 'the Copilot SDK (runtime and JS)' },
	{ pattern: /(^|\/)@github\/copilot(-(darwin|linux|linuxmusl|win32)-[^/]+)?(\/|$)/, label: 'the Copilot CLI' },
	{ pattern: /(^|\/)@microsoft\/mxc-sdk(\/|$)/, label: 'the mxc-sdk sandbox package' },
];
const copilotExtension = /(^|\/)extensions\/copilot(\/|$)/;
const cdnSourceMap = /sourceMappingURL=https:\/\/main\.vscode-cdn\.net\//;

/** Reads the file list from an asar archive's JSON header, without any dependency. */
export function listAsar(archive: string): string[] {
	const fd = openSync(archive, 'r');
	try {
		const sizes = Buffer.alloc(16);
		readSync(fd, sizes, 0, 16, 0);
		const header = Buffer.alloc(sizes.readUInt32LE(12));
		readSync(fd, header, 0, header.length, 16);
		const paths: string[] = [];
		const walk = (node: { files?: Record<string, unknown> }, prefix: string) => {
			for (const [name, child] of Object.entries(node.files ?? {})) {
				const path = prefix ? `${prefix}/${name}` : name;
				paths.push(path);
				walk(child as { files?: Record<string, unknown> }, path);
			}
		};
		walk(JSON.parse(header.toString('utf8')), '');
		return paths;
	} finally {
		closeSync(fd);
	}
}

/** Walks a packaged build and reports its size and every forbidden file. */
export function checkPackage(folder: string): PackageReport {
	const violations: string[] = [];
	let files = 0;
	let bytes = 0;
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			const path = relative(folder, full).replace(/\\/g, '/');
			if (entry.isDirectory()) {
				if (copilotExtension.test(path) && !copilotExtension.test(relative(folder, dir).replace(/\\/g, '/'))) {
					violations.push(`${path}: the Copilot extension`);
				}
				for (const { pattern, label } of forbiddenModules) {
					if (pattern.test(`${path}/`) && !pattern.test(relative(folder, dir).replace(/\\/g, '/'))) {
						violations.push(`${path}: ${label}`);
					}
				}
				visit(full);
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			files++;
			bytes += statSync(full).size;
			if (entry.name.endsWith('.map')) {
				violations.push(`${path}: a source map`);
			} else if (entry.name.endsWith('.js') && cdnSourceMap.test(readFileSync(full, 'latin1'))) {
				violations.push(`${path}: a sourceMappingURL to main.vscode-cdn.net`);
			} else if (entry.name === 'node_modules.asar') {
				const inner = listAsar(full);
				for (const { pattern, label } of forbiddenModules) {
					const roots = new Set(inner.map(item => pattern.exec(`${item}/`)?.[0].replace(/^\/|\/$/g, '')).filter(match => !!match));
					for (const match of roots) {
						violations.push(`${path}/${match}: ${label}`);
					}
				}
			}
		}
	};
	visit(folder);
	return { files, bytes, violations };
}

/** Prints the report; throws when the package holds anything forbidden. */
export function assertPackage(folder: string): void {
	const report = checkPackage(folder);
	console.log(`[check-package] ${folder}: ${report.files} files, ${Math.round(report.bytes / 2 ** 20)} MB`);
	if (report.violations.length) {
		const shown = report.violations.slice(0, 50);
		throw new Error(`[check-package] ${report.violations.length} forbidden item(s) in ${folder} (issues 548, 659):\n${shown.join('\n')}${report.violations.length > shown.length ? '\n…' : ''}`);
	}
}

if (import.meta.main) {
	const folder = process.argv[2];
	if (!folder) {
		console.error('Usage: node build/klawly/check-package.ts <built folder>');
		process.exit(2);
	}
	try {
		assertPackage(resolve(folder));
	} catch (error) {
		console.error((error as Error).message);
		process.exit(1);
	}
}
