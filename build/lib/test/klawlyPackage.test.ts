/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { suite, test } from 'node:test';
import { SourceMapGenerator } from 'source-map';
import { checkPackage } from '../../klawly/check-package.ts';
import { decodeTrace } from '../../klawly/sourcemaps.ts';

/** Writes a minimal asar archive whose header lists `files` (contents are not needed). */
function writeAsar(file: string, files: readonly string[]): void {
	const root: { files: Record<string, { files?: Record<string, unknown>; size?: number; offset?: string }> } = { files: {} };
	for (const entry of files) {
		let node = root as { files: Record<string, { files?: Record<string, unknown>; size?: number; offset?: string }> };
		const parts = entry.split('/');
		parts.forEach((part, index) => {
			if (index === parts.length - 1) {
				node.files[part] = { size: 0, offset: '0' };
			} else {
				node.files[part] ??= { files: {} };
				node = node.files[part] as typeof node;
			}
		});
	}
	const json = Buffer.from(JSON.stringify(root), 'utf8');
	const padded = Math.ceil(json.length / 4) * 4;
	const header = Buffer.alloc(16 + padded);
	header.writeUInt32LE(4, 0);
	header.writeUInt32LE(8 + padded, 4);
	header.writeUInt32LE(4 + padded, 8);
	header.writeUInt32LE(json.length, 12);
	json.copy(header, 16);
	fs.writeFileSync(file, header);
}

function write(root: string, file: string, contents = ''): void {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), contents);
}

suite('Klawly package check (issue 548)', () => {
	test('reports maps, CDN map URLs, Copilot, its SDK runtime, mxc-sdk binaries and any Anthropic package, and counts files', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klawly-package-'));
		try {
			const app = 'resources/app';
			write(root, `${app}/out/main.js`, 'console.log(1);\n//# sourceMappingURL=main.js.map');
			write(root, `${app}/out/vs/workbench/workbench.desktop.main.js`, 'x();\n//# sourceMappingURL=https://main.vscode-cdn.net/sourcemaps/abc/core/vs/workbench/workbench.desktop.main.js.map');
			write(root, `${app}/out/vs/workbench/workbench.desktop.main.js.map`, '{}');
			write(root, `${app}/extensions/copilot/package.json`, '{}');
			write(root, `${app}/extensions/copilot/node_modules/a/index.js`);
			write(root, `${app}/extensions/git/package.json`, '{}');
			write(root, `${app}/node_modules.asar.unpacked/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`);
			write(root, `${app}/node_modules.asar.unpacked/@github/copilot-sdk-win32-x64/prebuilds/win32-x64/copilot-runtime.exe`);
			write(root, `${app}/node_modules.asar.unpacked/@microsoft/mxc-sdk/bin/x64/wxc-exec.exe`);
			write(root, `${app}/node_modules/@github/copilot/index.js`);
			writeAsar(path.join(root, `${app}/node_modules.asar`), [
				'@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
				'@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json',
				'@github/copilot-sdk/index.js',
				'@github/copilot-sdk-darwin-arm64/copilot-sdk/index.js',
				'@github/copilot-linux-x64/copilot',
				'@microsoft/mxc-sdk/dist/index.js',
				'@microsoft/mxc-sdk/bin/arm64/lxc-exec',
			]);
			const report = checkPackage(root);
			assert.deepStrictEqual({ files: report.files, violations: [...report.violations].sort() }, {
				files: 11,
				violations: [
					`${app}/extensions/copilot: the Copilot extension`,
					`${app}/node_modules.asar.unpacked/@anthropic-ai/claude-agent-sdk-win32-x64: an Anthropic package`,
					`${app}/node_modules.asar.unpacked/@github/copilot-sdk-win32-x64: the Copilot SDK (runtime and JS)`,
					`${app}/node_modules.asar.unpacked/@microsoft/mxc-sdk: the mxc-sdk sandbox package`,
					`${app}/node_modules.asar/@anthropic-ai/claude-agent-sdk-darwin-arm64: an Anthropic package`,
					`${app}/node_modules.asar/@github/copilot-linux-x64: the Copilot CLI`,
					`${app}/node_modules.asar/@github/copilot-sdk-darwin-arm64: the Copilot SDK (runtime and JS)`,
					`${app}/node_modules.asar/@github/copilot-sdk: the Copilot SDK (runtime and JS)`,
					`${app}/node_modules.asar/@microsoft/mxc-sdk: the mxc-sdk sandbox package`,
					`${app}/node_modules/@github/copilot: the Copilot CLI`,
					`${app}/out/vs/workbench/workbench.desktop.main.js.map: a source map`,
					`${app}/out/vs/workbench/workbench.desktop.main.js: a sourceMappingURL to main.vscode-cdn.net`,
				].sort(),
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('a clean package passes', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klawly-package-'));
		try {
			write(root, 'resources/app/out/main.js', 'console.log(1);');
			writeAsar(path.join(root, 'resources/app/node_modules.asar'), ['zod/index.js']);
			assert.deepStrictEqual(checkPackage(root).violations, []);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

suite('Klawly source map decoding (issue 548)', () => {
	test('maps packaged stack frames back to source lines, on Windows and POSIX paths', () => {
		const generator = new SourceMapGenerator({ file: 'workbench.desktop.main.js' });
		generator.addMapping({ generated: { line: 1, column: 120 }, original: { line: 42, column: 4 }, source: '../../../src/vs/workbench/contrib/claude/browser/claudeView.ts', name: 'render' });
		const maps = new Map([['vs/workbench/workbench.desktop.main.js.map', generator.toString()]]);
		const trace = [
			'Error: boom',
			'    at a (vscode-file://vscode-app/c:/Users/me/AppData/Local/Programs/Klawly/resources/app/out/vs/workbench/workbench.desktop.main.js:1:121)',
			'    at b (C:\\Users\\me\\AppData\\Local\\Programs\\Klawly\\resources\\app\\out\\vs\\workbench\\workbench.desktop.main.js:1:121)',
			'    at c (/Applications/Klawly.app/Contents/Resources/app/out/vs/code/electron-main/main.js:3:9)',
		].join('\n');
		assert.deepStrictEqual(decodeTrace(trace, maps).split('\n'), [
			'Error: boom',
			'    at a (src/vs/workbench/contrib/claude/browser/claudeView.ts:42:5 (render))',
			'    at b (src/vs/workbench/contrib/claude/browser/claudeView.ts:42:5 (render))',
			'    at c (/Applications/Klawly.app/Contents/Resources/app/out/vs/code/electron-main/main.js:3:9)',
		]);
	});
});
