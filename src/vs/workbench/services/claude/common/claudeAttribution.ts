/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../base/common/async.js';
import { LcsDiff } from '../../../../base/common/diff/diff.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { stringHash } from '../../../../base/common/hash.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IClaudeAgentService } from './claudeAgentService.js';
import { IClaudeReviewService, lastChangedLine, ReviewHunk, ReviewHunkState } from './claudeReview.js';

/** Off by default. On, Klawly records the lines each kept Claude change wrote and marks them in the editor (issue 503). */
export const CLAUDE_LINE_ATTRIBUTION_SETTING = 'claude.editor.lineAttribution';

/** A line no recorded turn wrote and nobody changed since. */
export const ATTRIBUTION_UNTOUCHED = -1;
/** A line that changed after Klawly last recorded the file: a person wrote it. */
export const ATTRIBUTION_HUMAN = -2;

/** Where a line came from: a chat turn, a Tab completion or an inline edit (Cmd/Ctrl+K). A record without it is a turn. */
export type ClaudeAttributionOrigin = 'agent' | 'tab' | 'inline';

/** The turn, Tab completion or inline edit that wrote a line. */
export interface ClaudeAttributionSource {
	/** Absent on a record from before Tab and inline edits were attributed: that is a chat turn. */
	readonly origin?: ClaudeAttributionOrigin;
	readonly sessionId: string;
	readonly turnId: string;
	/** 1-based position of the turn in its session, when the session was loaded. */
	readonly turn?: number;
	readonly sessionTitle?: string;
	readonly model?: string;
}

/**
 * What Klawly keeps for one file: a hash of each line as it was when a change
 * was last kept, and who wrote each line. `owners` holds an index into
 * `sources`, {@link ATTRIBUTION_UNTOUCHED} or {@link ATTRIBUTION_HUMAN}.
 */
export interface ClaudeFileAttribution {
	readonly lines: readonly number[];
	readonly owners: readonly number[];
	readonly sources: readonly ClaudeAttributionSource[];
	/** Hunks already recorded, so a reload never records one twice. */
	readonly kept: readonly string[];
	readonly updated: number;
}

/** A kept hunk, read off the review before its range can move. */
export interface ClaudeKeptHunk {
	/** Empty for a hunk that needs no dedupe (a Tab completion or an inline edit). */
	readonly key: string;
	readonly source: ClaudeAttributionSource;
	/** 1-based first and last line of the hunk in the current text. */
	readonly startLine: number;
	readonly endLine: number;
	/**
	 * Hashes of the lines the turn wrote; a line in the span that is not one of them was edited by hand.
	 * Absent when every line of the span was just written (a Tab completion, whose first line also holds the typed prefix).
	 */
	readonly written?: ReadonlySet<number>;
}

/** Lines a Tab completion or an inline edit wrote, as a kept hunk without the key and source the ledger adds. */
export type ClaudeAcceptedSpan = Omit<ClaudeKeptHunk, 'key' | 'source'>;

/**
 * The lines an accepted Tab completion occupies. The completion replaces `range` with `insertText`, so it starts on the
 * range's first line and runs one line per line break. A trailing line break leaves the text after the cursor on the next
 * line, which the completion did not write. Undefined when it wrote nothing.
 */
export function tabAcceptedSpan(startLine: number, insertText: string): ClaudeAcceptedSpan | undefined {
	const written = insertText.split('\n');
	if (written[written.length - 1] === '') {
		written.pop();
	}
	if (written.length === 0 || written.every(line => line.trim() === '')) {
		return undefined;
	}
	return { startLine, endLine: startLine + written.length - 1 };
}

/**
 * The spans an accepted inline edit wrote: one per hunk of `current` that adds lines. `written` are the hunks the edit
 * produced; a line of a span counts only if it is one of their lines, so text typed during the review stays the user's.
 * Without `current`, the buffer still holds what the edit produced.
 */
export function inlineAcceptedSpans(written: readonly ReviewHunk[], current: readonly ReviewHunk[] = written): ClaudeAcceptedSpan[] {
	const lines = new Set<number>();
	for (const hunk of written) {
		for (const line of keptHunkFromReview(hunk, '', ATTRIBUTION_INLINE_SOURCE)?.written ?? []) {
			lines.add(line);
		}
	}
	const spans: ClaudeAcceptedSpan[] = [];
	for (const hunk of current) {
		const read = keptHunkFromReview(hunk, '', ATTRIBUTION_INLINE_SOURCE);
		if (read) {
			spans.push({ startLine: read.startLine, endLine: read.endLine, written: lines });
		}
	}
	return spans;
}

/** Who wrote one line of the current text. */
export type ClaudeLineOwner =
	| { readonly kind: 'agent'; readonly source: ClaudeAttributionSource }
	| { readonly kind: 'pending'; readonly source: ClaudeAttributionSource }
	| { readonly kind: 'human' };

/** The one source every Tab completion of a workspace shares: no turn wrote it, so there is nothing to open. */
export const ATTRIBUTION_TAB_SOURCE: ClaudeAttributionSource = { origin: 'tab', sessionId: 'klawly.tab', turnId: 'tab' };
/** The one source every accepted inline edit shares. */
export const ATTRIBUTION_INLINE_SOURCE: ClaudeAttributionSource = { origin: 'inline', sessionId: 'klawly.inline', turnId: 'inline' };

const MAX_FILES = 100;
const MAX_LINES = 20_000;
const MAX_KEPT = 500;

export function hashAttributionLine(text: string): number {
	return stringHash(text.endsWith('\r') ? text.slice(0, -1) : text, 0);
}

export function hashAttributionLines(lines: readonly string[]): number[] {
	return lines.map(hashAttributionLine);
}

/**
 * For each line of `to`, the index of the same unchanged line in `from`, or -1
 * when the line is new or changed. Lines are compared by hash, like `git blame`.
 */
export function mapAttributionLines(from: readonly number[], to: readonly number[]): number[] {
	const result = new Array<number>(to.length).fill(-1);
	if (from.length === to.length && from.every((hash, index) => hash === to[index])) {
		return result.map((_, index) => index);
	}
	const changes = new LcsDiff({ getElements: () => from.slice() }, { getElements: () => to.slice() }).ComputeDiff(false).changes;
	let original = 0;
	let modified = 0;
	for (const change of changes) {
		while (original < change.originalStart && modified < change.modifiedStart) {
			result[modified++] = original++;
		}
		original = change.originalStart + change.originalLength;
		modified = change.modifiedStart + change.modifiedLength;
	}
	while (original < from.length && modified < to.length) {
		result[modified++] = original++;
	}
	return result;
}

/** Carries the recorded owners onto `current`. Lines changed since the record are human. */
export function carryAttributionOwners(record: ClaudeFileAttribution | undefined, current: readonly number[]): number[] {
	if (!record) {
		return new Array<number>(current.length).fill(ATTRIBUTION_UNTOUCHED);
	}
	return mapAttributionLines(record.lines, current).map(index => index === -1 ? ATTRIBUTION_HUMAN : record.owners[index] ?? ATTRIBUTION_UNTOUCHED);
}

/** The record after `hunks` were kept, against the current text of the file. */
export function recordKeptHunks(record: ClaudeFileAttribution | undefined, current: readonly number[], hunks: readonly ClaudeKeptHunk[], now: number): ClaudeFileAttribution {
	const owners = carryAttributionOwners(record, current);
	const sources = [...(record?.sources ?? [])];
	const kept = [...(record?.kept ?? [])];
	for (const hunk of hunks) {
		let index = sources.findIndex(source => source.sessionId === hunk.source.sessionId && source.turnId === hunk.source.turnId);
		if (index === -1) {
			index = sources.push(hunk.source) - 1;
		}
		for (let line = hunk.startLine; line <= hunk.endLine && line <= current.length; line++) {
			owners[line - 1] = !hunk.written || hunk.written.has(current[line - 1]) ? index : ATTRIBUTION_HUMAN;
		}
		if (hunk.key) {
			kept.push(hunk.key);
		}
	}
	// Drop the turns no line points at any more, and renumber the owners.
	const used = [...new Set(owners.filter(owner => owner >= 0))].sort((a, b) => a - b);
	const renumber = new Map(used.map((owner, index) => [owner, index]));
	return {
		lines: [...current],
		owners: owners.map(owner => owner >= 0 ? renumber.get(owner)! : owner),
		sources: used.map(owner => sources[owner]),
		kept: kept.slice(-MAX_KEPT),
		updated: now,
	};
}

/** The owners of each line of `current`, or undefined when the file has no record. */
export function attributionOwners(record: ClaudeFileAttribution | undefined, current: readonly number[]): (ClaudeLineOwner | undefined)[] | undefined {
	if (!record) {
		return undefined;
	}
	return carryAttributionOwners(record, current).map(owner => {
		if (owner >= 0) {
			return { kind: 'agent', source: record.sources[owner] };
		}
		return owner === ATTRIBUTION_HUMAN ? { kind: 'human' } : undefined;
	});
}

/** A hunk's key, unique across sessions and turns. */
export function keptHunkKey(sessionId: string, turnId: string, hunkId: string): string {
	return `${sessionId}\n${turnId}\n${hunkId}`;
}

/** The lines a hunk wrote, read off the review while its range is current. */
export function keptHunkFromReview(hunk: ReviewHunk, key: string, source: ClaudeAttributionSource): ClaudeKeptHunk | undefined {
	if (hunk.modifiedLength === 0 || hunk.modifiedText.length === 0) {
		return undefined;
	}
	const written = hunk.modifiedText.split('\n');
	let startLine = hunk.currentRange.startLineNumber;
	// A hunk at the end of a file starts after the last character of the line above it; that line is not part of it.
	if (hunk.currentRange.startColumn > 1) {
		startLine++;
		written.shift();
	}
	if (hunk.modifiedText.endsWith('\n')) {
		written.pop();
	}
	return {
		key,
		source,
		startLine,
		endLine: lastChangedLine(hunk.currentRange),
		written: new Set(hashAttributionLines(written)),
	};
}

/** Owners stored as runs: [owner, count, owner, count, ...]. */
function encodeOwners(owners: readonly number[]): number[] {
	const runs: number[] = [];
	for (const owner of owners) {
		if (runs.length > 0 && runs[runs.length - 2] === owner) {
			runs[runs.length - 1]++;
		} else {
			runs.push(owner, 1);
		}
	}
	return runs;
}

function decodeOwners(runs: readonly number[]): number[] {
	const owners: number[] = [];
	for (let index = 0; index + 1 < runs.length; index += 2) {
		for (let count = 0; count < runs[index + 1]; count++) {
			owners.push(runs[index]);
		}
	}
	return owners;
}

interface StoredAttribution {
	readonly lines: number[];
	readonly owners: number[];
	readonly sources: ClaudeAttributionSource[];
	readonly kept: string[];
	readonly updated: number;
}

/** Serializes the ledger, keeping the {@link MAX_FILES} most recently updated files. */
export function encodeAttributionLedger(files: ReadonlyMap<string, ClaudeFileAttribution>): string {
	const entries = [...files].sort((a, b) => b[1].updated - a[1].updated).slice(0, MAX_FILES);
	const stored: Record<string, StoredAttribution> = {};
	for (const [uri, record] of entries) {
		stored[uri] = { lines: [...record.lines], owners: encodeOwners(record.owners), sources: [...record.sources], kept: [...record.kept], updated: record.updated };
	}
	return JSON.stringify({ version: 1, files: stored });
}

export function decodeAttributionLedger(raw: string | undefined): Map<string, ClaudeFileAttribution> {
	const files = new Map<string, ClaudeFileAttribution>();
	if (!raw) {
		return files;
	}
	try {
		const parsed = JSON.parse(raw) as { version?: number; files?: Record<string, StoredAttribution> };
		if (parsed.version !== 1 || !parsed.files) {
			return files;
		}
		for (const [uri, stored] of Object.entries(parsed.files)) {
			const owners = decodeOwners(stored.owners ?? []);
			if (!Array.isArray(stored.lines) || owners.length !== stored.lines.length) {
				continue;
			}
			files.set(uri, { lines: stored.lines, owners, sources: stored.sources ?? [], kept: stored.kept ?? [], updated: stored.updated ?? 0 });
		}
	} catch {
		// A broken ledger starts over; attribution is a convenience, never the source of truth.
	}
	return files;
}

export const IClaudeAttributionService = createDecorator<IClaudeAttributionService>('claudeAttributionService');

export interface IClaudeAttributionService {
	readonly _serviceBrand: undefined;
	/** Fires with the file whose record changed. */
	readonly onDidChange: Event<URI>;
	isEnabled(): boolean;
	/** Who wrote each line of `lines`, the current text of `uri`. Undefined when the file has no record and no pending change. */
	ownersFor(uri: URI, lines: readonly string[]): (ClaudeLineOwner | undefined)[] | undefined;
	/**
	 * Marks lines a Tab completion or an inline edit just wrote. `lines` is the text of the file right now and the
	 * spans are 1-based and inclusive, so nothing can move between the accept and the record.
	 */
	recordAccepted(uri: URI, source: ClaudeAttributionSource, lines: readonly string[], spans: readonly ClaudeAcceptedSpan[]): void;
	/** The record of a file, if it has one. */
	recordFor(uri: URI): ClaudeFileAttribution | undefined;
	/** Keeps a record read from elsewhere (a git note) for a file that has none; an existing record always wins. */
	adoptRecord(uri: URI, record: ClaudeFileAttribution): void;
	/** Forgets every record. */
	clear(): void;
}

const STORAGE_KEY = 'claude.attribution.ledger';

/**
 * Records, per file, which lines each kept Claude change wrote. Nothing leaves
 * the machine: the ledger is workspace storage, keyed by file, and capped.
 */
export class ClaudeAttributionService extends Disposable implements IClaudeAttributionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<URI>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _files: Map<string, ClaudeFileAttribution>;
	private readonly _kept = new Set<string>();
	/** The last state seen per hunk, so only a change from pending to accepted counts as kept. */
	private readonly _seen = new Map<string, ReviewHunkState>();
	private readonly _writes = new Sequencer();

	constructor(
		@IClaudeReviewService private readonly _review: IClaudeReviewService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@ITextModelService private readonly _textModels: ITextModelService,
		@IStorageService private readonly _storage: IStorageService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
	) {
		super();
		this._files = decodeAttributionLedger(this._storage.get(STORAGE_KEY, StorageScope.WORKSPACE));
		for (const record of this._files.values()) {
			for (const key of record.kept) {
				this._kept.add(key);
			}
		}
		this._register(this._review.onDidChangeReview(({ sessionId }) => this.onReviewChanged(sessionId)));
	}

	isEnabled(): boolean {
		return this._configuration.getValue<boolean>(CLAUDE_LINE_ATTRIBUTION_SETTING) === true;
	}

	ownersFor(uri: URI, lines: readonly string[]): (ClaudeLineOwner | undefined)[] | undefined {
		const owners = attributionOwners(this._files.get(uri.toString()), hashAttributionLines(lines));
		const pending = this._review.hunksFor(uri);
		if (pending.length === 0) {
			return owners;
		}
		const result = owners ?? new Array<ClaudeLineOwner | undefined>(lines.length).fill(undefined);
		for (const { sessionId, turnId, hunk } of pending) {
			if (hunk.modifiedLength === 0) {
				continue;
			}
			const source = this.sourceFor(sessionId, turnId);
			const start = hunk.currentRange.startLineNumber + (hunk.currentRange.startColumn > 1 ? 1 : 0);
			for (let line = start; line <= lastChangedLine(hunk.currentRange) && line <= lines.length; line++) {
				result[line - 1] = { kind: 'pending', source };
			}
		}
		return result;
	}

	recordAccepted(uri: URI, source: ClaudeAttributionSource, lines: readonly string[], spans: readonly ClaudeAcceptedSpan[]): void {
		if (!this.isEnabled() || lines.length > MAX_LINES || spans.length === 0) {
			return;
		}
		const key = uri.toString();
		const now = Date.now();
		// No key: an accept happens once, so there is nothing to dedupe on reload and no reason to crowd out the turns' keys.
		const hunks = spans.map(span => ({ ...span, key: '', source }));
		this._files.set(key, recordKeptHunks(this._files.get(key), hashAttributionLines(lines), hunks, now));
		this.persist();
		this._onDidChange.fire(uri);
	}

	recordFor(uri: URI): ClaudeFileAttribution | undefined {
		return this._files.get(uri.toString());
	}

	adoptRecord(uri: URI, record: ClaudeFileAttribution): void {
		const key = uri.toString();
		if (!this.isEnabled() || this._files.has(key) || record.lines.length > MAX_LINES) {
			return;
		}
		this._files.set(key, record);
		this.persist();
		this._onDidChange.fire(uri);
	}

	private persist(): void {
		this._storage.store(STORAGE_KEY, encodeAttributionLedger(this._files), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	clear(): void {
		const uris = [...this._files.keys()];
		this._files.clear();
		this._storage.remove(STORAGE_KEY, StorageScope.WORKSPACE);
		for (const uri of uris) {
			this._onDidChange.fire(URI.parse(uri));
		}
	}

	private onReviewChanged(sessionId: string): void {
		const kept = new Map<string, { uri: URI; hunks: ClaudeKeptHunk[] }>();
		for (const review of this._review.reviewsFor(sessionId)) {
			for (const file of review.files) {
				for (const hunk of file.hunks) {
					const key = keptHunkKey(review.sessionId, review.turnId, hunk.id);
					const before = this._seen.get(key);
					this._seen.set(key, hunk.state);
					const nowKept = hunk.state === 'accepted' && (before === 'pending' || before === 'conflicted');
					if (!nowKept || this._kept.has(key) || !this.isEnabled()) {
						continue;
					}
					const read = keptHunkFromReview(hunk, key, this.sourceFor(review.sessionId, review.turnId));
					if (!read) {
						continue;
					}
					this._kept.add(key);
					const entry = kept.get(file.uri.toString()) ?? { uri: file.uri, hunks: [] };
					entry.hunks.push(read);
					kept.set(file.uri.toString(), entry);
				}
			}
		}
		for (const { uri, hunks } of kept.values()) {
			void this._writes.queue(() => this.record(uri, hunks));
		}
	}

	private async record(uri: URI, hunks: readonly ClaudeKeptHunk[]): Promise<void> {
		let lines: string[];
		try {
			const reference = await this._textModels.createModelReference(uri);
			try {
				lines = reference.object.textEditorModel.getLinesContent();
			} finally {
				reference.dispose();
			}
		} catch {
			return;
		}
		if (lines.length > MAX_LINES) {
			return;
		}
		const key = uri.toString();
		this._files.set(key, recordKeptHunks(this._files.get(key), hashAttributionLines(lines), hunks, Date.now()));
		this.persist();
		this._onDidChange.fire(uri);
	}

	private sourceFor(sessionId: string, turnId: string): ClaudeAttributionSource {
		const session = this._agent.getSessions().find(candidate => candidate.id === sessionId);
		const index = session ? this._agent.getViewState(sessionId).turns.findIndex(turn => turn.id === turnId) : -1;
		return {
			sessionId,
			turnId,
			turn: index === -1 ? undefined : index + 1,
			sessionTitle: session?.title,
			model: session?.modelName ?? session?.modelId,
		};
	}
}
