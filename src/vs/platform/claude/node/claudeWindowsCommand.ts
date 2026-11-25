/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'fs';
import { win32 } from '../../../base/common/path.js';

/** A program to start: the file, its arguments, and whether Node must pass them to Windows untouched. */
export interface ClaudeCommand {
	readonly file: string;
	readonly args: readonly string[];
	readonly verbatim: boolean;
}

const META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument for `cmd.exe`: quoted for the program's own parser, then every
 * cmd metacharacter escaped with `^`, twice for a `.cmd` shim, which passes its
 * arguments on through a second cmd parse (the method of qntm.org/cmd).
 */
export function escapeCmdArgument(argument: string, doubleEscape: boolean): string {
	let escaped = argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
	escaped = `"${escaped}"`.replace(META_CHARACTERS, '^$1');
	return doubleEscape ? escaped.replace(META_CHARACTERS, '^$1') : escaped;
}

function nativeExists(path: string): boolean {
	// eslint-disable-next-line local/code-no-sync-fs -- shortcut: spawning is synchronous and this runs once per process start, on Windows only; upgrade if spawn becomes async
	return existsSync(path);
}

/**
 * How to start `file` on `platform`. A native `claude.exe` starts directly. A
 * `.cmd` or `.bat` shim cannot be started without a shell, so it goes through
 * `cmd.exe` with every argument escaped; a `claude.exe` that sits next to the
 * shim or in the npm package it points to is used instead when there is one.
 */
export function claudeCommand(file: string, args: readonly string[], platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = nativeExists): ClaudeCommand {
	if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) {
		return { file, args, verbatim: false };
	}
	const directory = win32.dirname(file);
	for (const native of [win32.join(directory, 'claude.exe'), win32.join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')]) {
		if (exists(native)) {
			return { file: native, args, verbatim: false };
		}
	}
	const line = [file.replace(META_CHARACTERS, '^$1'), ...args.map(argument => escapeCmdArgument(argument, true))].join(' ');
	return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}
