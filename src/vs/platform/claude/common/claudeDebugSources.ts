/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { removeAnsiEscapeCodes } from '../../../base/common/strings.js';
import { ClaudeDebugLogLine } from './claudeDebugMode.js';

/** The window-side places Debug mode reads besides the log sink (issue 881). */
export type ClaudeDebugSourceKind = 'debug' | 'terminal' | 'console';

/** Lines kept per source, so one noisy source cannot push out the others. */
export const CLAUDE_DEBUG_SOURCE_MAX_LINES = 200;

/** Characters kept per line. */
export const CLAUDE_DEBUG_SOURCE_LINE_CHARS = 500;

/** Lines kept in total after the merge with the sink's lines. */
export const CLAUDE_DEBUG_MERGED_MAX_LINES = 1000;

/**
 * Lines collected from the debug adapter, the terminals and the preview
 * console while a capture runs. Each line is tagged with its source so Claude
 * can tell instrumentation output from other output. Capped per source.
 */
export class ClaudeDebugSourceBuffer {
	private readonly _lines: ClaudeDebugLogLine[] = [];
	private readonly _counts = new Map<ClaudeDebugSourceKind, number>();
	private _dropped = 0;
	private _start = 0;
	private _capturing = false;

	constructor(private readonly _now: () => number = Date.now) { }

	get capturing(): boolean {
		return this._capturing;
	}

	start(): void {
		this._lines.length = 0;
		this._counts.clear();
		this._dropped = 0;
		this._start = this._now();
		this._capturing = true;
	}

	/** Adds a chunk of output. A chunk may hold several lines; empty ones are skipped. */
	add(kind: ClaudeDebugSourceKind, chunk: string): void {
		if (!this._capturing) {
			return;
		}
		const at = Math.max(0, this._now() - this._start);
		for (const raw of removeAnsiEscapeCodes(chunk).split(/\r?\n|\r/)) {
			const text = raw.trim();
			if (!text) {
				continue;
			}
			const clipped = text.length > CLAUDE_DEBUG_SOURCE_LINE_CHARS ? `${text.slice(0, CLAUDE_DEBUG_SOURCE_LINE_CHARS - 1)}…` : text;
			this._lines.push({ at, text: `[${kind}] ${clipped}` });
			const count = (this._counts.get(kind) ?? 0) + 1;
			this._counts.set(kind, count);
			if (count > CLAUDE_DEBUG_SOURCE_MAX_LINES) {
				const oldest = this._lines.findIndex(line => line.text.startsWith(`[${kind}] `));
				this._lines.splice(oldest, 1);
				this._counts.set(kind, count - 1);
				this._dropped++;
			}
		}
	}

	/** Ends the capture and returns its lines. */
	take(): { readonly lines: readonly ClaudeDebugLogLine[]; readonly dropped: number } {
		const taken = { lines: this._lines.slice(), dropped: this._dropped };
		this._lines.length = 0;
		this._counts.clear();
		this._dropped = 0;
		this._capturing = false;
		return taken;
	}
}

/** The sink's lines and the other sources' lines in time order, newest kept when over the cap. */
export function claudeMergeDebugLines(
	sink: { readonly lines: readonly ClaudeDebugLogLine[]; readonly dropped: number },
	extra: { readonly lines: readonly ClaudeDebugLogLine[]; readonly dropped: number } | undefined,
	maxLines = CLAUDE_DEBUG_MERGED_MAX_LINES,
): { readonly lines: readonly ClaudeDebugLogLine[]; readonly dropped: number } {
	if (!extra || extra.lines.length === 0) {
		return sink;
	}
	// Array.sort is stable, so lines at the same time keep the sink first.
	const merged = [...sink.lines, ...extra.lines].sort((a, b) => a.at - b.at);
	const over = Math.max(0, merged.length - maxLines);
	return { lines: merged.slice(over), dropped: sink.dropped + extra.dropped + over };
}
