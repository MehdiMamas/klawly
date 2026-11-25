/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Klawly ships the on-device dictation runtime in the package (issue 547). Upstream downloads it
// instead from VS Code's CDN (`product.dictationRuntime`, stamped by Microsoft's build), which a
// Klawly build has no access to, so voice input never worked in a release.
// `npm ci` installs foundry-local-sdk's addons for every target, and its install script fetches the
// ONNX Runtime libraries from nuget.org for the host only, so the runtime is complete for the target
// the runner builds natively. Other targets keep the OS dictation. Linux keeps upstream's rule of no
// native dictation files in the package: they can need a newer glibc than the package supports.

import { existsSync } from 'fs';
import { join } from 'path';

const bundledPlatforms: ReadonlySet<string> = new Set(['win32', 'darwin']);

/** The native files of a complete runtime; mirrors `requiredRuntimeFileNames` in `foundryLocalRuntime.ts`. */
export function runtimeFileNames(target: string): string[] {
	const isWin = target.startsWith('win32-');
	const isDarwin = target.startsWith('darwin-');
	const ext = isWin ? '.dll' : isDarwin ? '.dylib' : '.so';
	const prefix = isWin ? '' : 'lib';
	return [
		'foundry_local_node.node',
		'foundry_local_preload.node',
		`${prefix}foundry_local${ext}`,
		...(isWin ? ['Microsoft.Windows.AI.MachineLearning.dll'] : []),
		isWin ? 'onnxruntime.dll' : isDarwin ? 'libonnxruntime.1.dylib' : 'libonnxruntime.so.1',
		`${prefix}onnxruntime-genai${ext}`,
	];
}

/**
 * The target (`<platform>-<arch>`) whose runtime the package ships, or `undefined` when the
 * platform never ships it or `<sdkRoot>/prebuilds/<target>` lacks a file of a complete runtime.
 */
export function bundledDictationTarget(sdkRoot: string, platform: string, arch: string): string | undefined {
	const target = `${platform}-${arch}`;
	if (!bundledPlatforms.has(platform)) {
		return undefined;
	}
	const dir = join(sdkRoot, 'prebuilds', target);
	return runtimeFileNames(target).every(name => existsSync(join(dir, name))) ? target : undefined;
}

/**
 * gulp-filter patterns for the dependencies: every prebuild goes, except the files of `target`
 * (all of them, such as `onnxruntime_providers_shared.dll`, not only the required ones), without
 * the signing summary that comes with them.
 */
export function foundryLocalFilter(target: string | undefined): string[] {
	return [
		'**',
		'!**/foundry-local-sdk/prebuilds/**',
		...(target ? [`**/foundry-local-sdk/prebuilds/${target}/**`, `!**/foundry-local-sdk/prebuilds/${target}/*.md`] : []),
	];
}
