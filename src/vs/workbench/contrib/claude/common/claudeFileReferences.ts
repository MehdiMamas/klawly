/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';

export interface FileReferenceMatch {
	/** Offsets of the whole `path:line[:column]` text in the input. */
	readonly start: number;
	readonly end: number;
	/** Workspace-relative path using `/`. */
	readonly path: string;
	readonly line: number;
	readonly column: number | undefined;
}

const MAX_LINE = 10_000_000;

/**
 * Finds `src/foo.ts:42` and `src/foo.ts:42:7` in plain text. Only relative
 * paths are accepted: absolute paths, drive letters and `..` segments are
 * skipped, so model output cannot point the editor outside the workspace.
 */
export function findFileReferences(text: string): FileReferenceMatch[] {
	const pattern = /(?<![\w./\\:@-])(?<path>(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]\w{0,9}):(?<line>\d{1,8})(?::(?<column>\d{1,8}))?(?![\w:])/g;
	const matches: FileReferenceMatch[] = [];
	let found: RegExpExecArray | null;
	while ((found = pattern.exec(text)) !== null) {
		const path = found.groups?.path;
		const lineText = found.groups?.line;
		const columnText = found.groups?.column;
		if (!path || !lineText) {
			continue;
		}
		const line = Number(lineText);
		const column = columnText === undefined ? undefined : Number(columnText);
		if (!isSafeRelativePath(path) || line < 1 || line > MAX_LINE || (column !== undefined && (column < 1 || column > MAX_LINE))) {
			continue;
		}
		matches.push({ start: found.index, end: found.index + found[0].length, path, line, column });
	}
	return matches;
}

export function isSafeRelativePath(path: string): boolean {
	if (!path || path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) {
		return false;
	}
	return path.split('/').every(segment => segment !== '' && segment !== '..' && segment !== '.');
}

export interface WorkspacePathReference {
	/** A relative path using `/` (relative to the home folder when {@link home}), or an absolute path as written. */
	readonly path: string;
	readonly absolute: boolean;
	/** The text started with `~/`. Set only then. */
	readonly home?: true;
	/** The text named a folder (`src/`). */
	readonly folder: boolean;
	readonly line: number | undefined;
	readonly column: number | undefined;
}

const PATH_CHARS = /^[\w.@+$~-]+(?:\/[\w.@+$~-]+)*$/;

/**
 * Reads a path out of an inline code span or a Markdown link target: `src/a.ts`,
 * `./src/a.ts:12`, `src/a.ts#L12`, `src/`, an absolute path or a home path
 * (`~/.klawly/plans/a.md`). Plain words, URLs, other users' homes (`~user/`) and `..`
 * segments are not paths. Whether the path exists, and whether an absolute or home path
 * is somewhere a reply may link (the workspace, Klawly's plan folder), is for the caller
 * to check.
 */
export function parseWorkspacePath(text: string): WorkspacePathReference | undefined {
	let value = text.trim();
	if (!value || value.length > 400 || /\s/.test(value)) {
		return undefined;
	}
	let line: number | undefined;
	let column: number | undefined;
	const position = /#L(?<line>\d{1,8})(?:C(?<column>\d{1,8}))?(?:-L?\d{1,8}(?:C\d{1,8})?)?$/.exec(value)
		?? /:(?<line>\d{1,8})(?::(?<column>\d{1,8}))?(?:-\d{1,8})?$/.exec(value);
	if (position?.groups) {
		line = Number(position.groups.line);
		column = position.groups.column === undefined ? undefined : Number(position.groups.column);
		if (line < 1 || line > MAX_LINE || (column !== undefined && (column < 1 || column > MAX_LINE))) {
			return undefined;
		}
		value = value.slice(0, position.index);
	}
	const drive = /^[A-Za-z]:[\\/]/.test(value);
	if (!drive && /^[A-Za-z][\w+.-]*:/.test(value)) {
		return undefined;
	}
	const absolute = drive || value.startsWith('/');
	const home = /^~[\\/]/.test(value);
	const normalized = value.replace(/\\/g, '/');
	const folder = normalized.endsWith('/');
	const body = normalized.replace(/^~\//, '').replace(/^\.\//, '').replace(/\/+$/, '').replace(/^[A-Za-z]:\//, '').replace(/^\//, '');
	if (!body || body.startsWith('~') || !PATH_CHARS.test(body) || !isSafeRelativePath(body)) {
		return undefined;
	}
	if (!absolute && !folder && !body.includes('/') && !/\.[A-Za-z]\w{0,9}$/.test(body)) {
		return undefined;
	}
	if (absolute && !body.includes('/')) {
		return undefined;
	}
	return {
		path: absolute ? value.replace(/[\\/]+$/, '') : body,
		absolute,
		...(home ? { home } : {}),
		folder,
		line: folder ? undefined : line,
		column: folder ? undefined : column,
	};
}

/** What {@link sessionWorkFolders} reads from a turn: its changed files and its tool cards. */
export interface WorkFileSource {
	/** `file:` URIs the session wrote. */
	readonly changedFiles: readonly string[];
	readonly cards: readonly { readonly kind: string; readonly file?: string }[];
}

export interface SessionWorkFolders {
	/** Folders of the files the session changed, newest first. */
	readonly changed: readonly URI[];
	/** Folders of the files it only read, newest first. */
	readonly read: readonly URI[];
}

/**
 * The folders a session worked in, from its tool cards and changed files. Turns come
 * oldest first, as the timeline holds them. A reply's paths are looked up in the
 * repositories of these folders, so a session that works in a git worktree links the
 * worktree's files rather than the main checkout's (issue 321).
 */
export function sessionWorkFolders(turns: readonly WorkFileSource[]): SessionWorkFolders {
	const changed: URI[] = [];
	const read: URI[] = [];
	for (let index = turns.length - 1; index >= 0; index--) {
		const turn = turns[index];
		for (let cardIndex = turn.cards.length - 1; cardIndex >= 0; cardIndex--) {
			const card = turn.cards[cardIndex];
			if (card.file && (card.kind === 'edit' || card.kind === 'file') && isAbsoluteFilePath(card.file)) {
				(card.kind === 'edit' ? changed : read).push(dirname(URI.file(card.file)));
			}
		}
		for (let fileIndex = turn.changedFiles.length - 1; fileIndex >= 0; fileIndex--) {
			const uri = URI.parse(turn.changedFiles[fileIndex]);
			if (uri.scheme === Schemas.file) {
				changed.push(dirname(uri));
			}
		}
	}
	const seen = new Set<string>();
	const unique = (folder: URI) => {
		const key = folder.toString();
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	};
	return { changed: changed.filter(unique), read: read.filter(unique) };
}

function isAbsoluteFilePath(path: string): boolean {
	return /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(path);
}
