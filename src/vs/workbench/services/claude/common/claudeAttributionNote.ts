/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ATTRIBUTION_HUMAN, carryAttributionOwners, ClaudeAttributionOrigin, ClaudeAttributionSource, ClaudeFileAttribution, hashAttributionLines } from './claudeAttribution.js';

/** Off by default, and inert unless `claude.editor.lineAttribution` is on too (issue 961). */
export const CLAUDE_ATTRIBUTION_GIT_NOTES_SETTING = 'claude.editor.lineAttribution.gitNotes';

const MAX_FILES = 200;
const MAX_RANGES = 2_000;

/** What a note says about one file: which kind of writer each source was, and the 1-based inclusive line ranges each wrote. */
export interface ClaudeNoteFile {
	/** Origin and turn number only: no session id, title, model name or path leaves the workspace. */
	readonly sources: readonly { readonly origin: ClaudeAttributionOrigin; readonly turn?: number }[];
	/** `[start, end, source]`. */
	readonly ranges: readonly (readonly [number, number, number])[];
}

export interface ClaudeAttributionNote {
	readonly v: 1;
	/** Keyed by repository-relative path. */
	readonly files: { readonly [path: string]: ClaudeNoteFile };
}

/** The note entry of one file as committed: the lines Claude wrote, taken from the ledger record. Undefined when Claude wrote none. */
export function noteFileFromRecord(record: ClaudeFileAttribution | undefined, committedLines: readonly string[]): ClaudeNoteFile | undefined {
	if (!record) {
		return undefined;
	}
	const owners = carryAttributionOwners(record, hashAttributionLines(committedLines));
	const sources = record.sources.map(source => ({ origin: source.origin ?? 'agent', ...(source.turn !== undefined ? { turn: source.turn } : {}) }));
	const ranges: [number, number, number][] = [];
	for (let line = 0; line < owners.length; line++) {
		const owner = owners[line];
		if (owner < 0 || owner >= sources.length) {
			continue;
		}
		const last = ranges[ranges.length - 1];
		if (last && last[2] === owner && last[1] === line) {
			last[1] = line + 1;
		} else {
			ranges.push([line + 1, line + 1, owner]);
		}
	}
	return ranges.length > 0 ? { sources, ranges } : undefined;
}

export function encodeAttributionNote(note: ClaudeAttributionNote): string {
	return JSON.stringify(note) + '\n';
}

/** Reads a note back. Anything malformed, from a newer version, or too large is dropped, never trusted. */
export function decodeAttributionNote(raw: string | undefined): ClaudeAttributionNote | undefined {
	if (!raw) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const input = parsed as { v?: unknown; files?: unknown } | null;
	if (!input || input.v !== 1 || !input.files || typeof input.files !== 'object' || Array.isArray(input.files)) {
		return undefined;
	}
	const files: { [path: string]: ClaudeNoteFile } = Object.create(null);
	for (const [path, value] of Object.entries(input.files as Record<string, unknown>).slice(0, MAX_FILES)) {
		const file = value as { sources?: unknown; ranges?: unknown } | null;
		if (!file || !Array.isArray(file.sources) || !Array.isArray(file.ranges)) {
			continue;
		}
		const sources: { origin: ClaudeAttributionOrigin; turn?: number }[] = [];
		for (const source of file.sources as ({ origin?: unknown; turn?: unknown } | null)[]) {
			const origin = source?.origin;
			if (origin !== 'agent' && origin !== 'tab' && origin !== 'inline') {
				sources.push({ origin: 'agent' });
				continue;
			}
			const turn = source?.turn;
			sources.push(typeof turn === 'number' && Number.isInteger(turn) && turn > 0 ? { origin, turn } : { origin });
		}
		const ranges: [number, number, number][] = [];
		for (const range of (file.ranges as unknown[]).slice(0, MAX_RANGES)) {
			if (Array.isArray(range) && range.length === 3 && range.every(n => Number.isInteger(n))) {
				const [start, end, source] = range as [number, number, number];
				if (start >= 1 && end >= start && source >= 0 && source < sources.length) {
					ranges.push([start, end, source]);
				}
			}
		}
		if (ranges.length > 0) {
			files[path] = { sources, ranges };
		}
	}
	return { v: 1, files };
}

/** A ledger record built from a note and the text of the file as committed, so the blame view can show it after a clone. */
export function recordFromNoteFile(file: ClaudeNoteFile, committedLines: readonly string[], now: number): ClaudeFileAttribution {
	const owners = new Array<number>(committedLines.length).fill(ATTRIBUTION_HUMAN);
	for (const [start, end, source] of file.ranges) {
		for (let line = start; line <= end && line <= committedLines.length; line++) {
			owners[line - 1] = source;
		}
	}
	const sources: ClaudeAttributionSource[] = file.sources.map((source, index) => ({
		origin: source.origin,
		sessionId: 'klawly.note',
		turnId: `note-${index}`,
		...(source.turn !== undefined ? { turn: source.turn } : {}),
	}));
	return { lines: hashAttributionLines(committedLines), owners, sources, kept: [], updated: now };
}

/**
 * The note of a rewritten commit (amend, rebase, cherry-pick) from the note of the commit it came from: a file is
 * copied only when `isIdentical(path)` says its content did not change, otherwise it is dropped.
 */
export function carryAttributionNote(note: ClaudeAttributionNote, isIdentical: (path: string) => boolean): ClaudeAttributionNote | undefined {
	const files: { [path: string]: ClaudeNoteFile } = Object.create(null);
	for (const [path, file] of Object.entries(note.files)) {
		if (isIdentical(path)) {
			files[path] = file;
		}
	}
	return Object.keys(files).length > 0 ? { v: 1, files } : undefined;
}
