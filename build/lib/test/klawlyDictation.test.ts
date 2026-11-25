/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { suite, test } from 'node:test';
import { bundledDictationTarget, foundryLocalFilter, runtimeFileNames } from '../../klawly/bundled-dictation.ts';

// gulp-filter matches with multimatch, so the patterns are checked with it too.
const multimatch = createRequire(import.meta.url)('multimatch') as (paths: string[], patterns: string[]) => string[];

suite('Klawly bundled dictation runtime (issue 547)', () => {
	test('ships the target when its runtime is complete, on Windows and macOS only', () => {
		const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'klawly-dictation-'));
		try {
			for (const target of ['win32-x64', 'darwin-arm64', 'linux-x64']) {
				for (const name of runtimeFileNames(target)) {
					fs.mkdirSync(path.join(sdk, 'prebuilds', target), { recursive: true });
					fs.writeFileSync(path.join(sdk, 'prebuilds', target, name), '');
				}
			}
			// What npm ci leaves for a target it did not run on: the addons without ONNX Runtime.
			fs.mkdirSync(path.join(sdk, 'prebuilds', 'win32-arm64'), { recursive: true });
			fs.writeFileSync(path.join(sdk, 'prebuilds', 'win32-arm64', 'foundry_local_node.node'), '');
			assert.deepStrictEqual({
				windows: bundledDictationTarget(sdk, 'win32', 'x64'),
				mac: bundledDictationTarget(sdk, 'darwin', 'arm64'),
				windowsArmIncomplete: bundledDictationTarget(sdk, 'win32', 'arm64'),
				macIntelMissing: bundledDictationTarget(sdk, 'darwin', 'x64'),
				linux: bundledDictationTarget(sdk, 'linux', 'x64'),
			}, {
				windows: 'win32-x64',
				mac: 'darwin-arm64',
				windowsArmIncomplete: undefined,
				macIntelMissing: undefined,
				linux: undefined,
			});
		} finally {
			fs.rmSync(sdk, { recursive: true, force: true });
		}
	});

	test('the filter keeps every file of the target and drops other targets and the signing summary', () => {
		const sdk = 'node_modules/foundry-local-sdk';
		const files = [
			`${sdk}/dist/index.js`,
			`${sdk}/prebuilds/win32-x64/foundry_local_node.node`,
			`${sdk}/prebuilds/win32-x64/onnxruntime.dll`,
			`${sdk}/prebuilds/win32-x64/onnxruntime_providers_shared.dll`,
			`${sdk}/prebuilds/win32-arm64/foundry_local.dll`,
			`${sdk}/prebuilds/darwin-arm64/libfoundry_local.dylib`,
			`${sdk}/prebuilds/darwin-arm64/CodeSignSummary-1.md`,
			'node_modules/other/index.js',
		];
		assert.deepStrictEqual({
			windows: multimatch(files, foundryLocalFilter('win32-x64')),
			mac: multimatch(files, foundryLocalFilter('darwin-arm64')),
			none: multimatch(files, foundryLocalFilter(undefined)),
		}, {
			windows: [`${sdk}/dist/index.js`, 'node_modules/other/index.js', `${sdk}/prebuilds/win32-x64/foundry_local_node.node`, `${sdk}/prebuilds/win32-x64/onnxruntime.dll`, `${sdk}/prebuilds/win32-x64/onnxruntime_providers_shared.dll`],
			mac: [`${sdk}/dist/index.js`, 'node_modules/other/index.js', `${sdk}/prebuilds/darwin-arm64/libfoundry_local.dylib`],
			none: [`${sdk}/dist/index.js`, 'node_modules/other/index.js'],
		});
	});
});
