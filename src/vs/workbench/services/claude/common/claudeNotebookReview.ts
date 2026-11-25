/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ReviewFile, ReviewHunk } from './claudeReview.js';

/** The 1-based, inclusive line span of one cell object in the text of an `.ipynb` file. */
export interface NotebookCellLines {
	readonly index: number;
	readonly startLine: number;
	readonly endLine: number;
}

/**
 * Finds each cell object of the top-level `cells` array in notebook JSON and the
 * lines it spans (DL-90). Review hunks are line based, so this is what maps a
 * hunk to the cell it changes. Text that is not notebook JSON gives no cells.
 */
export function notebookCellLines(text: string): NotebookCellLines[] {
	const cells: NotebookCellLines[] = [];
	let line = 1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	let key = '';
	let readingKey = false;
	let lastKey = '';
	let cellsDepth = -1;
	let cellStart = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '\n') {
			line++;
		}
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
				if (readingKey) {
					lastKey = key;
					readingKey = false;
				}
			} else if (readingKey) {
				key += ch;
			}
			continue;
		}
		switch (ch) {
			case '"':
				inString = true;
				// A string right after `{` or `,` at object level is a key; one after `:` is a value.
				readingKey = isKeyPosition(text, i);
				key = '';
				break;
			case '[':
				depth++;
				if (depth === 2 && lastKey === 'cells') {
					cellsDepth = depth;
				}
				break;
			case '{':
				depth++;
				if (cellsDepth > 0 && depth === cellsDepth + 1) {
					cellStart = line;
				}
				break;
			case '}':
				if (cellsDepth > 0 && depth === cellsDepth + 1) {
					cells.push({ index: cells.length, startLine: cellStart, endLine: line });
				}
				depth--;
				break;
			case ']':
				if (depth === cellsDepth) {
					cellsDepth = -1;
				}
				depth--;
				break;
		}
	}
	return cells;
}

function isKeyPosition(text: string, quote: number): boolean {
	for (let i = quote - 1; i >= 0; i--) {
		const ch = text[i];
		if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
			continue;
		}
		return ch === '{' || ch === ',';
	}
	return true;
}

/** What a cell's review row shows: its place, how Claude changed it, and the hunks behind it. */
export interface NotebookCellChange {
	/** Position in the notebook now, or in the pre-turn notebook for a removed cell. */
	readonly index: number;
	readonly kind: 'added' | 'removed' | 'changed';
	readonly hunks: readonly ReviewHunk[];
}

/**
 * Groups the hunks of a notebook file by the cell they touch, in notebook order.
 * A hunk that adds or changes lines belongs to the cell of its new lines; one
 * that only removes lines belongs to the cell of its old lines. A hunk outside
 * every cell (notebook metadata) is left out of the groups, so Keep All and
 * Undo All still settle it.
 */
export function groupHunksByCell(file: Pick<ReviewFile, 'hunks' | 'originalText'>, modifiedText: string): NotebookCellChange[] {
	const modifiedCells = notebookCellLines(modifiedText);
	const originalCells = notebookCellLines(file.originalText);
	const groups = new Map<string, { index: number; kind: NotebookCellChange['kind']; hunks: ReviewHunk[] }>();
	for (const hunk of file.hunks) {
		if (hunk.state === 'accepted' || hunk.state === 'rejected') {
			continue;
		}
		const placed = placeHunk(hunk, modifiedCells, originalCells);
		if (!placed) {
			continue;
		}
		const key = `${placed.side}:${placed.index}`;
		const group = groups.get(key);
		if (group) {
			group.hunks.push(hunk);
			group.kind = 'changed';
		} else {
			groups.set(key, { index: placed.index, kind: placed.kind, hunks: [hunk] });
		}
	}
	return [...groups.values()].sort((a, b) => a.index - b.index);
}

function placeHunk(hunk: ReviewHunk, modifiedCells: readonly NotebookCellLines[], originalCells: readonly NotebookCellLines[]): { side: 'new' | 'old'; index: number; kind: NotebookCellChange['kind'] } | undefined {
	if (hunk.modifiedLength > 0) {
		const first = hunk.modifiedStart;
		const cell = modifiedCells.find(candidate => first >= candidate.startLine && first <= candidate.endLine);
		if (!cell) {
			return undefined;
		}
		const wholeCell = hunk.originalLength === 0 && hunk.modifiedStart <= cell.startLine && hunk.modifiedStart + hunk.modifiedLength - 1 >= cell.endLine;
		return { side: 'new', index: cell.index, kind: wholeCell ? 'added' : 'changed' };
	}
	const first = hunk.originalStart;
	const cell = originalCells.find(candidate => first >= candidate.startLine && first <= candidate.endLine);
	if (!cell) {
		return undefined;
	}
	const wholeCell = hunk.originalStart <= cell.startLine && hunk.originalStart + hunk.originalLength - 1 >= cell.endLine;
	return { side: 'old', index: cell.index, kind: wholeCell ? 'removed' : 'changed' };
}
