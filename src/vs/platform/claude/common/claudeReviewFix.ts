/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A finding's concrete fix: `replacement` takes the place of lines `startLine`..`endLine` (1-based, inclusive). */
export interface ClaudeSuggestionRange {
	readonly startLine: number;
	readonly endLine: number;
	readonly replacement: string;
}

/** The result of applying a suggestion to a file's text. */
export type ClaudeSuggestionResult =
	| { readonly kind: 'applied'; readonly text: string }
	/** The lines are not what the review saw (or are gone): Apply stays disabled, "Re-run" is offered. */
	| { readonly kind: 'stale' }
	/** No replacement, or lines outside the file. */
	| { readonly kind: 'none' };

/** A small stable hash (FNV-1a) of the lines a suggestion replaces, stored when the finding is shown. */
export function claudeLinesHash(lines: readonly string[]): string {
	let hash = 0x811c9dc5;
	for (const char of lines.join('\n')) {
		hash ^= char.codePointAt(0)!;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `${lines.length}:${hash.toString(16)}`;
}

function splitLines(text: string): string[] {
	return text.split(/\r\n|\r|\n/);
}

/** The lines `startLine`..`endLine` of `text`, or `undefined` when they are outside it. */
export function claudeSuggestionOriginal(text: string, startLine: number, endLine: number): string[] | undefined {
	const lines = splitLines(text);
	if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) {
		return undefined;
	}
	return lines.slice(startLine - 1, endLine);
}

/**
 * Applies a suggestion to `text`. `expectedHash` is `claudeLinesHash` of the lines
 * when the finding was shown: when the lines differ now, the file changed since the
 * review and nothing is applied. The file's line ending is kept.
 */
export function applyClaudeSuggestion(text: string, suggestion: ClaudeSuggestionRange, expectedHash?: string): ClaudeSuggestionResult {
	if (suggestion.replacement.length === 0) {
		return { kind: 'none' };
	}
	const original = claudeSuggestionOriginal(text, suggestion.startLine, suggestion.endLine);
	if (!original) {
		return { kind: 'stale' };
	}
	if (expectedHash !== undefined && claudeLinesHash(original) !== expectedHash) {
		return { kind: 'stale' };
	}
	const eol = /\r\n/.test(text) ? '\r\n' : /\r/.test(text) ? '\r' : '\n';
	const lines = splitLines(text);
	const replacement = splitLines(suggestion.replacement.replace(/(\r\n|\r|\n)$/, ''));
	lines.splice(suggestion.startLine - 1, original.length, ...replacement);
	return { kind: 'applied', text: lines.join(eol) };
}

/** The suggestion as a GitHub suggestion block for a posted PR comment (issue 872), or `undefined` when there is no replacement. */
export function claudeGithubSuggestionBlock(replacement: string | undefined): string | undefined {
	if (!replacement) {
		return undefined;
	}
	const body = replacement.replace(/(\r\n|\r|\n)$/, '');
	const fence = '`'.repeat(Math.max(3, ...Array.from(body.matchAll(/`+/g), match => match[0].length + 1)));
	return `${fence}suggestion\n${body}\n${fence}`;
}
