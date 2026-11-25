/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { stringHash } from '../../../base/common/hash.js';
import { Schemas } from '../../../base/common/network.js';
import { isAbsolute } from '../../../base/common/path.js';
import { isEqualOrParent, normalizePath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';

/** Characters of text before the cursor sent to the completion model. */
export const CLAUDE_AUTOCOMPLETE_PREFIX_CHARS = 2000;

/** Characters of text after the cursor sent to the completion model. */
export const CLAUDE_AUTOCOMPLETE_SUFFIX_CHARS = 1000;

export const CLAUDE_AUTOCOMPLETE_MAX_RECENT_EDITS = 8;

/** One no-tools completion turn. The IPC proxy cannot forward a cancellation token. */
export interface ClaudeInlineCompletionRequest {
	readonly id: string;
	readonly prompt: string;
	readonly cwd: string;
	readonly model?: string;
}

export interface SerializedRange {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
}

export interface RecentEdit {
	readonly uri: string;
	readonly before: string;
	readonly after: string;
	readonly range: SerializedRange;
	readonly ageMs: number;
}

export interface CodeSnippet {
	readonly uri: string;
	readonly text: string;
}

export interface CompletionPosition {
	readonly lineNumber: number;
	readonly column: number;
}

/**
 * Document version and cursor captured when a completion request starts.
 * A result is stale when either has moved.
 */
export interface CompletionSnapshot {
	readonly versionId: number;
	readonly lineNumber: number;
	readonly column: number;
}

export interface CompletionInput {
	readonly uri: URI;
	readonly languageId: string;
	readonly prefix: string;
	readonly suffix: string;
	readonly recentEdits: readonly RecentEdit[];
	readonly relatedSnippets: readonly CodeSnippet[];
	readonly versionId: number;
	readonly position: CompletionPosition;
	/** Identity of the file contents. A hash of the whole file, or a bounded stand-in. */
	readonly fileText: string;
	/** Text on the cursor line, used to skip secret assignments. */
	readonly lineText: string;
	/** Path used for the secret-file check. */
	readonly uriPath: string;
}

export interface InlineCompletionResult {
	readonly kind: 'inline';
	readonly insertText: string;
}

export interface NextEditCompletionResult {
	readonly kind: 'next-edit';
	readonly target: URI;
	readonly line: number;
	readonly preview: string;
	readonly fileName: string;
	readonly anchor: CompletionPosition;
}

export type CompletionResult = InlineCompletionResult | NextEditCompletionResult;

/** Text Tab may insert in the current document. A cross-file result has none. */
export function inlineInsertText(result: CompletionResult): string | undefined {
	return result.kind === 'inline' ? result.insertText : undefined;
}

export function isStaleCompletion(request: CompletionSnapshot, current: CompletionSnapshot, cancelled: boolean): boolean {
	if (cancelled) {
		return true;
	}
	if (current.versionId !== request.versionId) {
		return true;
	}
	return current.lineNumber !== request.lineNumber || current.column !== request.column;
}

export function completionCacheKey(fileText: string, position: CompletionPosition, nearby: string): string {
	return `${stringHash(fileText, 0) >>> 0}:${position.lineNumber}:${position.column}:${stringHash(nearby, 0) >>> 0}`;
}

const SECRET_LANGUAGES = new Set(['dotenv', 'env']);
const SECRET_FILE_NAME = /^(?:\.env(?:\.|$)|(?:credentials|secrets?|id_rsa)(?:\.|$))/i;
const SECRET_FILE_EXTENSION = /\.(?:pem|key|p12|pfx)$/i;
const SECRET_LINE = /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key|client[_-]?secret)\b\s*[:=]/i;

export function isSecretCompletionSurface(input: { readonly languageId: string; readonly uriPath: string; readonly lineText: string }): boolean {
	if (SECRET_LANGUAGES.has(input.languageId)) {
		return true;
	}
	const name = input.uriPath.replace(/\\/g, '/').split('/').pop() ?? input.uriPath;
	if (SECRET_FILE_NAME.test(name) || SECRET_FILE_EXTENSION.test(name)) {
		return true;
	}
	return SECRET_LINE.test(input.lineText);
}

export interface ParsedCompletion {
	readonly kind: 'inline' | 'next';
	readonly text: string;
	readonly path?: string;
	readonly line?: number;
}

/**
 * The model must return replacement text only. A `NEXT path:line` header is the
 * only other accepted shape, and it never becomes an edit of the current file.
 */
export function parseCompletionText(raw: string): ParsedCompletion | undefined {
	let text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
	if (text.endsWith('\n')) {
		text = text.slice(0, -1);
	}
	const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text.trim());
	if (fenced) {
		text = fenced[1];
	}
	if (text.trim().length === 0) {
		return undefined;
	}
	const next = /^NEXT\s+(\S+):(\d+)\s*\n([\s\S]+)$/.exec(text);
	if (text.startsWith('NEXT ') && !next) {
		return undefined;
	}
	if (next) {
		const body = next[3];
		if (body.trim().length === 0) {
			return undefined;
		}
		const line = Number(next[2]);
		if (!Number.isInteger(line) || line < 1) {
			return undefined;
		}
		return { kind: 'next', text: body, path: next[1], line };
	}
	return { kind: 'inline', text };
}

/**
 * Resolves a next-edit path only when it stays inside a workspace folder.
 * `..`, an absolute path outside those folders, and any scheme other than
 * `file` or the folder's own scheme are rejected.
 */
export function resolveNextEditTarget(target: string, folders: readonly URI[], current?: URI): URI | undefined {
	const trimmed = target.trim();
	if (!trimmed || hasParentSegment(trimmed)) {
		return undefined;
	}
	let resolved: URI;
	if (looksLikeUri(trimmed)) {
		resolved = URI.parse(trimmed);
	} else if (isAbsolute(trimmed)) {
		resolved = URI.file(trimmed);
	} else {
		const base = folderFor(folders, current);
		if (!base) {
			return undefined;
		}
		resolved = URI.joinPath(base, trimmed);
	}
	if (hasParentSegment(resolved.path)) {
		return undefined;
	}
	resolved = normalizePath(resolved);
	if (!isNextEditInsideWorkspace(resolved, folders)) {
		return undefined;
	}
	return resolved;
}

/** True when `target` uses `file` or a workspace scheme and sits inside a folder. */
export function isNextEditInsideWorkspace(target: URI, folders: readonly URI[]): boolean {
	const normalized = normalizePath(target);
	if (normalized.scheme !== Schemas.file && !folders.some(folder => folder.scheme === normalized.scheme)) {
		return false;
	}
	return folders.some(folder => isEqualOrParent(normalized, normalizePath(folder)));
}

function folderFor(folders: readonly URI[], current: URI | undefined): URI | undefined {
	if (current) {
		const owner = folders.find(folder => isEqualOrParent(current, folder));
		if (owner) {
			return owner;
		}
	}
	return folders[0];
}

/** A drive letter is a path, not a URI scheme. */
function looksLikeUri(target: string): boolean {
	if (/^[a-zA-Z]:[\\/]/.test(target)) {
		return false;
	}
	return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target);
}

function hasParentSegment(target: string): boolean {
	return target.replace(/\\/g, '/').split('/').some(segment => segment === '..');
}

/** Ghost text for a cross-file preview replaces the whole target line. */
export function nextEditPreviewRange(lineNumber: number, lineMaxColumn: number): SerializedRange {
	return {
		startLineNumber: lineNumber,
		startColumn: 1,
		endLineNumber: lineNumber,
		endColumn: lineMaxColumn,
	};
}

export function nextEditFileName(target: string): string {
	const normalized = target.replace(/\\/g, '/');
	const slash = normalized.lastIndexOf('/');
	return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/**
 * The no-tools completion prompt. `budget` caps the text sent around the
 * cursor; Tab lowers it when measured latency is above its target.
 */
export function buildCompletionPrompt(input: Pick<CompletionInput, 'languageId' | 'prefix' | 'suffix' | 'recentEdits' | 'relatedSnippets'>, budget: { readonly prefixChars: number; readonly suffixChars: number } = { prefixChars: CLAUDE_AUTOCOMPLETE_PREFIX_CHARS, suffixChars: CLAUDE_AUTOCOMPLETE_SUFFIX_CHARS }): string {
	const prefixChars = Math.max(0, Math.min(budget.prefixChars, CLAUDE_AUTOCOMPLETE_PREFIX_CHARS));
	const prefix = prefixChars > 0 ? input.prefix.slice(-prefixChars) : '';
	const suffix = input.suffix.slice(0, Math.max(0, Math.min(budget.suffixChars, CLAUDE_AUTOCOMPLETE_SUFFIX_CHARS)));
	const edits = input.recentEdits.slice(-CLAUDE_AUTOCOMPLETE_MAX_RECENT_EDITS).map(formatRecentEdit).join('\n');
	const snippets = input.relatedSnippets.slice(0, 4).map(snippet => `${snippet.uri}\n${snippet.text.slice(0, 400)}`).join('\n');
	return [
		'You are an IDE inline completion engine.',
		'Return only the exact text that should be inserted/replaced.',
		'Predict the user\'s likely next edit from the cursor context and recent edits.',
		'Do not explain.',
		'Do not wrap in Markdown.',
		'If the next edit is in another file, reply with exactly:',
		'NEXT <relative-path>:<line>',
		'<replacement text>',
		'Otherwise reply with only the replacement text.',
		`Language: ${input.languageId}`,
		'<prefix>',
		prefix,
		'</prefix>',
		'<suffix>',
		suffix,
		'</suffix>',
		'<recent_edits>',
		edits,
		'</recent_edits>',
		'<related_snippets>',
		snippets,
		'</related_snippets>',
	].join('\n');
}

function formatRecentEdit(edit: RecentEdit): string {
	const before = edit.before.length > 200 ? edit.before.slice(0, 200) : edit.before;
	const after = edit.after.length > 200 ? edit.after.slice(0, 200) : edit.after;
	return `${edit.uri} ${edit.range.startLineNumber}:${edit.range.startColumn}-${edit.range.endLineNumber}:${edit.range.endColumn} age=${edit.ageMs}ms\nbefore: ${before}\nafter: ${after}`;
}

export interface ContentChangeSlice {
	readonly range: SerializedRange;
	readonly rangeOffset: number;
	readonly rangeLength: number;
	readonly text: string;
}

/** Recent edits from a document change. Offsets refer to `previousText`. */
export function contentChangeRecentEdits(uri: string, previousText: string, changes: readonly ContentChangeSlice[]): RecentEdit[] {
	const edits: RecentEdit[] = [];
	for (const change of changes) {
		const before = previousText.substring(change.rangeOffset, change.rangeOffset + change.rangeLength);
		if (before.length === 0 && change.text.length === 0) {
			continue;
		}
		edits.push({
			uri,
			before,
			after: change.text,
			range: change.range,
			ageMs: 0,
		});
	}
	return edits;
}

/**
 * The document text after `changes`, without reading the model again.
 * Changes are applied from the highest offset so earlier offsets stay valid.
 */
export function nextTextAfterContentChanges(previousText: string, changes: readonly ContentChangeSlice[]): string {
	const ordered = [...changes].sort((left, right) => right.rangeOffset - left.rangeOffset);
	let text = previousText;
	for (const change of ordered) {
		const start = change.rangeOffset;
		const end = change.rangeOffset + change.rangeLength;
		text = text.slice(0, start) + change.text + text.slice(end);
	}
	return text;
}

const SKIP_COMPLETION_SCHEMES = new Set<string>([
	Schemas.vscode,
	Schemas.outputChannel,
	Schemas.walkThrough,
	Schemas.walkThroughSnippet,
	'comments',
	Schemas.commentsInput,
	Schemas.vscodeNotebookCellOutput,
	Schemas.vscodeNotebookCellMetadata,
	Schemas.vscodeNotebookCellOutputDiff,
	Schemas.vscodeSourceControl,
	Schemas.vscodeChatEditor,
	Schemas.vscodeChatInput,
	Schemas.sessionsChatInput,
	Schemas.vscodeInteractiveInput,
	Schemas.vscodeSettings,
	Schemas.accessibleView,
]);

/** Password-like and input surfaces never ask for a completion. */
export function isSkippedCompletionScheme(scheme: string): boolean {
	return SKIP_COMPLETION_SCHEMES.has(scheme);
}

/** One line for the Claude Agent output channel. Numbers only. */
export function formatClaudeTabLatency(stats: { readonly p50: number; readonly p95: number; readonly count: number } | undefined): string {
	if (!stats) {
		return '[claude] tab latency samples=0\n';
	}
	return `[claude] tab latency samples=${stats.count} p50=${stats.p50}ms p95=${stats.p95}ms\n`;
}

/** Nearest-rank percentile. `samples` is not mutated. */
export function completionLatencyPercentiles(samples: readonly number[]): { readonly p50: number; readonly p95: number } | undefined {
	if (samples.length === 0) {
		return undefined;
	}
	const sorted = [...samples].sort((left, right) => left - right);
	return {
		p50: sorted[percentileIndex(sorted.length, 0.5)],
		p95: sorted[percentileIndex(sorted.length, 0.95)],
	};
}

function percentileIndex(count: number, percentile: number): number {
	return Math.min(count - 1, Math.max(0, Math.ceil(percentile * count) - 1));
}
