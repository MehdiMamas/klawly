/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ResourceMap, ResourceSet } from '../../../../base/common/map.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IRange, Range } from '../../../../editor/common/core/range.js';
import { linesDiffComputers } from '../../../../editor/common/diff/linesDiffComputers.js';
import { EndOfLinePreference, ITextModel } from '../../../../editor/common/model.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IModelContentChangedEvent } from '../../../../editor/common/textModelEvents.js';
import { ClaudeReviewFinding } from '../../../../platform/claude/common/claudeReviewLoop.js';
import { ClaudeReviewSignalCounter, recordClaudeReviewSignal, resetClaudeReviewSignal, suggestLearnedRules } from '../../../../platform/claude/common/claudeReviewLearning.js';
import { CLAUDE_ATTACHMENT_CHAR_LIMIT, clipText } from '../../../../platform/claude/common/claudePrompt.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { CLAUDE_REVIEW_AUTO_KEEP_SETTING, readClaudeAutoKeep } from '../../../../platform/claude/common/claudeConfiguration.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ITextFileService } from '../../textfile/common/textfiles.js';
import { redactSecrets } from './claudeAgentLog.js';
import { IClaudeCheckpointService } from './claudeCheckpointService.js';

export const IClaudeReviewService = createDecorator<IClaudeReviewService>('claudeReviewService');

/** Left side of a review diff. The editor resolves this scheme through a content provider. */
export const CLAUDE_SNAPSHOT_SCHEME = 'claude-snapshot';

/**
 * Left side of a notebook's review diff (issue 526). A read-only file system serves
 * it, because the notebook diff editor reads both sides as files, not text models.
 */
export const CLAUDE_NOTEBOOK_SNAPSHOT_SCHEME = 'claude-notebook-snapshot';

export type ReviewHunkState = 'pending' | 'accepted' | 'rejected' | 'conflicted';

export type ReviewFileState = ReviewHunkState | 'mixed';

/**
 * One diff hunk against the turn snapshot. `originalStart` and `modifiedStart`
 * are 1-based line numbers from the diff. `currentRange` is the live span of
 * `modifiedText` and moves when an earlier hunk in the file is rejected.
 */
export interface ReviewHunk {
	id: string;
	uri: URI;
	originalStart: number;
	originalLength: number;
	modifiedStart: number;
	modifiedLength: number;
	originalText: string;
	modifiedText: string;
	state: ReviewHunkState;
	currentRange: Range;
}

export interface ReviewFile {
	readonly uri: URI;
	readonly name: string;
	readonly directory: string;
	/** True when the file did not exist before the turn. Empty original text is not enough. */
	readonly isNew: boolean;
	/** Pre-turn snapshot. The diff editor's left side. */
	readonly originalText: string;
	readonly hunks: ReviewHunk[];
	readonly added: number;
	readonly removed: number;
	state: ReviewFileState;
}

export interface TurnReview {
	readonly sessionId: string;
	readonly turnId: string;
	readonly files: ReviewFile[];
	cursor: number;
	/** Auto-Keep kept this turn as it landed (issue 706). Its card says "Kept automatically". */
	autoKept?: boolean;
}

/**
 * What Keep All and Undo All cover (issue 706): one turn, every turn of one chat,
 * or every chat and background or delegated agent in this window.
 */
export type ReviewScope =
	| { readonly kind: 'turn'; readonly sessionId: string; readonly turnId: string }
	| { readonly kind: 'chat'; readonly sessionId: string }
	| { readonly kind: 'all' };

/** Counts of what is still pending in a scope, for the scope labels (DL-69). */
export interface ReviewPendingSummary {
	readonly hunks: number;
	readonly files: number;
	readonly turns: number;
	/** Chats (sessions) with pending changes. */
	readonly chats: number;
	/** Those chats, in the order the reviews hold them. */
	readonly sessionIds: readonly string[];
	/** Each file once, in the order the reviews hold them. */
	readonly uris: readonly URI[];
}

/** A hunk with the turn it belongs to, so an editor can act on it. */
export interface ReviewHunkRef {
	readonly sessionId: string;
	readonly turnId: string;
	readonly hunk: ReviewHunk;
}

export interface ReviewFileText {
	readonly uri: URI;
	readonly originalText: string;
	readonly modifiedText: string;
	/** False when the checkpoint hash was null. An existing empty file is true. */
	readonly existed: boolean;
}

export interface IClaudeReviewService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeReview: Event<{ readonly sessionId: string }>;
	readonly onDidNavigate: Event<{ readonly sessionId: string; readonly turnId: string; readonly uri: URI }>;
	/** Fires when the dismissal counters change, so the owner can save them (issue 923). */
	readonly onDidChangeSignals: Event<void>;
	/** The dismissal counters per repository, category and title. */
	signals(): readonly ClaudeReviewSignalCounter[];
	/** Loads saved counters. */
	setSignals(counters: readonly ClaudeReviewSignalCounter[]): void;
	/** Counts a dismissal, Mark as Intended or thumbs down of `finding`. Returns the counter once it reaches `threshold`, the offer to stop flagging it. */
	recordFindingSignal(repo: string, finding: Pick<ClaudeReviewFinding, 'category' | 'title' | 'body'>, threshold: number): ClaudeReviewSignalCounter | undefined;
	/** Forgets one counter once its rule is written or the person declined. */
	resolveFindingSignal(repo: string, counter: Pick<ClaudeReviewSignalCounter, 'category' | 'title'>): void;
	get(sessionId: string, turnId: string): TurnReview | undefined;
	ensureTurn(sessionId: string, turnId: string): Promise<TurnReview | undefined>;
	/** Pre-turn text for a `claude-snapshot` resource, when that turn is loaded. */
	snapshotText(resource: URI): string | undefined;
	replaceTurn(sessionId: string, turnId: string, files: readonly ReviewFileText[]): TurnReview;
	decorationsFor(uri: URI): readonly ReviewHunk[];
	/** The pending and conflicted hunks in `uri`, with their turns. */
	hunksFor(uri: URI): readonly ReviewHunkRef[];
	focus(sessionId: string, turnId: string): void;
	focused(): { readonly sessionId: string; readonly turnId: string } | undefined;
	currentHunk(): ReviewHunk | undefined;
	acceptHunk(sessionId: string, turnId: string, hunkId: string): void;
	rejectHunk(sessionId: string, turnId: string, hunkId: string): Promise<void>;
	acceptFile(sessionId: string, turnId: string, uri: URI): void;
	rejectFile(sessionId: string, turnId: string, uri: URI): Promise<void>;
	acceptAll(sessionId: string, turnId: string): void;
	rejectAll(sessionId: string, turnId: string): Promise<void>;
	/** Pending and conflicted hunks, files, turns and chats in `scope`. */
	pendingSummary(scope: ReviewScope): ReviewPendingSummary;
	/**
	 * Keeps every pending change in `scope` and returns how many hunks it kept.
	 * Keep only clears the review: checkpoints stay, so Restore Checkpoint still works.
	 */
	keepAllPending(scope: ReviewScope): number;
	/** Undoes every pending change in `scope`. Callers confirm first; this does not ask. */
	undoAllPending(scope: ReviewScope): Promise<void>;
	/** Whether Auto-Keep is on for this chat: the `claude.review.autoKeep` setting and the chat's own toggle. */
	isAutoKeep(sessionId: string): boolean;
	/** The chat's own Auto-Keep toggle from the mode menu. `undefined` follows the setting. */
	setAutoKeep(sessionId: string, on: boolean | undefined): void;
	/** Fires for a chat's toggle, and with an empty `sessionId` when the setting changes. */
	readonly onDidChangeAutoKeep: Event<{ readonly sessionId: string }>;
	/**
	 * Undoes what Auto-Keep kept in a turn, or in one file of it, back to the
	 * turn's checkpoint text. A file edited since raises {@link ReviewConflictError}.
	 */
	undoKept(sessionId: string, turnId: string, uri?: URI): Promise<void>;
	/** Puts a review loaded from disk back in memory. It does not edit files. */
	importSaved(review: TurnReview): void;
	reviewsFor(sessionId: string): readonly TurnReview[];
	next(sessionId: string, turnId: string): ReviewHunk | undefined;
	previous(sessionId: string, turnId: string): ReviewHunk | undefined;
}

/** The file changed after Claude created this hunk. Do not overwrite that edit. */
export class ReviewConflictError extends Error {
	constructor() {
		super('The file changed after Claude created this hunk. Open conflict review.');
		this.name = 'ReviewConflictError';
	}
}

/** A review file could not be read. Nothing is published, so accepted state stays put. */
export class ReviewReadError extends Error {
	constructor(readonly uris: readonly URI[]) {
		super(`Could not read ${uris.map(uri => uri.fsPath).join(', ')} for review.`);
		this.name = 'ReviewReadError';
	}
}

export function claudeSnapshotUri(file: URI, sessionId: string, turnId: string): URI {
	return URI.from({
		scheme: CLAUDE_SNAPSHOT_SCHEME,
		path: file.path,
		query: `session=${encodeURIComponent(sessionId)}&turn=${encodeURIComponent(turnId)}`,
	});
}

/** A Jupyter notebook, which review opens in the notebook diff editor. */
export function isNotebookReviewFile(file: URI): boolean {
	return /\.ipynb$/i.test(file.path);
}

/** The left side of a review diff: the notebook snapshot for a notebook, the text snapshot otherwise. */
export function claudeReviewOriginalUri(file: URI, sessionId: string, turnId: string): URI {
	const snapshot = claudeSnapshotUri(file, sessionId, turnId);
	return isNotebookReviewFile(file) ? snapshot.with({ scheme: CLAUDE_NOTEBOOK_SNAPSHOT_SCHEME }) : snapshot;
}

export function parseClaudeSnapshotUri(resource: URI): { sessionId: string; turnId: string } | undefined {
	if (resource.scheme !== CLAUDE_SNAPSHOT_SCHEME && resource.scheme !== CLAUDE_NOTEBOOK_SNAPSHOT_SCHEME) {
		return undefined;
	}
	const params = new URLSearchParams(resource.query);
	const sessionId = params.get('session');
	const turnId = params.get('turn');
	if (!sessionId || !turnId) {
		return undefined;
	}
	return { sessionId, turnId };
}

/** A turn write, not a dirty buffer captured only because the editor was unsaved. */
export function isReviewBaseline(file: { readonly capturedAs?: 'buffer' | 'write'; readonly afterHash?: string | null }): boolean {
	return file.capturedAs === 'write' || file.afterHash !== undefined;
}

export function buildTurnReview(sessionId: string, turnId: string, files: readonly ReviewFileText[]): TurnReview {
	const built: ReviewFile[] = [];
	for (const file of files) {
		const hunks = collectReviewHunks(file.uri, file.originalText, file.modifiedText);
		if (hunks.length === 0) {
			continue;
		}
		let added = 0;
		let removed = 0;
		for (const hunk of hunks) {
			added += hunk.modifiedLength;
			removed += hunk.originalLength;
		}
		// An empty side is one empty line to the diff, so a created or emptied file counts its own lines.
		if (normalizeEol(file.originalText).length === 0) {
			added = countLines(file.modifiedText);
			removed = 0;
		}
		if (normalizeEol(file.modifiedText).length === 0) {
			added = 0;
			removed = countLines(file.originalText);
		}
		built.push({
			uri: file.uri,
			name: basename(file.uri),
			directory: parentDirectory(file.uri),
			isNew: !file.existed,
			originalText: normalizeEol(file.originalText),
			hunks,
			added,
			removed,
			state: 'pending',
		});
	}
	return { sessionId, turnId, files: built, cursor: -1 };
}

export function collectReviewHunks(uri: URI, originalText: string, modifiedText: string): ReviewHunk[] {
	const original = normalizeEol(originalText);
	const modified = normalizeEol(modifiedText);
	if (original === modified) {
		return [];
	}
	const originalLines = original.split('\n');
	const modifiedLines = modified.split('\n');
	const diff = linesDiffComputers.getDefault().computeDiff(originalLines, modifiedLines, {
		ignoreTrimWhitespace: false,
		maxComputationTimeMs: 1000,
		computeMoves: false,
	});
	const hunks: ReviewHunk[] = [];
	for (let index = 0; index < diff.changes.length; index++) {
		const change = diff.changes[index];
		let mapping;
		try {
			mapping = change.toRangeMapping2(originalLines, modifiedLines);
		} catch {
			continue;
		}
		const originalSlice = textInRange(original, mapping.originalRange);
		const modifiedSlice = textInRange(modified, mapping.modifiedRange);
		hunks.push({
			id: `${uri.toString()}#${index}`,
			uri,
			originalStart: change.original.startLineNumber,
			originalLength: change.original.length,
			modifiedStart: change.modified.startLineNumber,
			modifiedLength: change.modified.length,
			originalText: originalSlice,
			modifiedText: modifiedSlice,
			state: 'pending',
			currentRange: mapping.modifiedRange,
		});
	}
	return hunks;
}

/**
 * The last line a hunk's text covers. A hunk that ends with a line break ends
 * at column 1 of the next line, and that next line is not part of the change.
 */
export function lastChangedLine(range: IRange): number {
	return range.endColumn === 1 && range.endLineNumber > range.startLineNumber ? range.endLineNumber - 1 : range.endLineNumber;
}

/** Stat plus a capped patch. Secrets are redacted the same way as other bulk attachments. */
export function formatTurnDiff(review: TurnReview): string {
	const stats: string[] = [`${review.files.length} files`];
	const patch: string[] = [];
	for (const file of review.files) {
		const path = file.directory ? `${file.directory}/${file.name}` : file.name;
		stats.push(`${path} +${file.added} -${file.removed}`);
		patch.push(`--- ${path}`);
		patch.push(`+++ ${path}`);
		for (const hunk of file.hunks) {
			patch.push(`@@ -${hunk.originalStart},${hunk.originalLength} +${hunk.modifiedStart},${hunk.modifiedLength} @@`);
			if (hunk.originalText.length > 0) {
				for (const line of hunk.originalText.split('\n')) {
					patch.push(`-${line}`);
				}
			}
			if (hunk.modifiedText.length > 0) {
				for (const line of hunk.modifiedText.split('\n')) {
					patch.push(`+${line}`);
				}
			}
		}
	}
	const clippedPatch = clipText(patch.join('\n'));
	const combined = `${stats.join('\n')}\n${clippedPatch.text}${clippedPatch.truncated ? '\n…' : ''}`;
	const clipped = clipText(combined, CLAUDE_ATTACHMENT_CHAR_LIMIT);
	const body = clipped.truncated ? `${clipped.text}\n…` : clipped.text;
	return redactSecrets(body);
}

/**
 * A failed or empty load does not replace a review already stored for the turn
 * and does not publish. Publishing would wipe accepted and rejected hunks and
 * schedule another paint.
 */
export function reviewFromLoad(existing: TurnReview | undefined, loaded: TurnReview, failed: boolean): { readonly review: TurnReview | undefined; readonly publish: boolean } {
	if (failed || loaded.files.length === 0 || existing) {
		return { review: existing, publish: false };
	}
	return { review: loaded, publish: true };
}

/** Finished turns that still need one load at this status. A recorded status is skipped until it changes. */
export function reviewTurnsPendingLoad<T extends { readonly id: string; readonly status: string }>(turns: readonly T[], attempted: ReadonlyMap<string, string>): T[] {
	const pending: T[] = [];
	for (const turn of turns) {
		if (turn.status === 'running') {
			continue;
		}
		if (attempted.get(turn.id) === turn.status) {
			continue;
		}
		pending.push(turn);
	}
	return pending;
}

export function flatHunks(review: TurnReview): ReviewHunk[] {
	const hunks: ReviewHunk[] = [];
	for (const file of review.files) {
		hunks.push(...file.hunks);
	}
	return hunks;
}

/**
 * Rejects one hunk against the live model. A mismatch raises
 * {@link ReviewConflictError} and leaves the model untouched.
 */
export function rejectHunkOnModel(hunk: ReviewHunk, model: ITextModel): void {
	if (hunk.state === 'accepted' || hunk.state === 'rejected') {
		return;
	}
	const current = model.getValueInRange(hunk.currentRange, EndOfLinePreference.LF);
	if (current !== hunk.modifiedText) {
		hunk.state = 'conflicted';
		throw new ReviewConflictError();
	}
	const text = hunk.originalText.replace(/\n/g, model.getEOL());
	model.pushStackElement();
	model.pushEditOperations(null, [{ range: hunk.currentRange, text }], () => null);
	model.pushStackElement();
	hunk.state = 'rejected';
}

export class ClaudeReviewService extends Disposable implements IClaudeReviewService {
	declare readonly _serviceBrand: undefined;

	private readonly _reviews = new Map<string, TurnReview>();
	private readonly _loaded = new Set<string>();
	private readonly _loading = new Map<string, Promise<TurnReview | undefined>>();
	private readonly _modelListeners = this._register(new DisposableStore());
	private readonly _watched = new Set<string>();
	private _applyingEdit = false;
	private _focus: { sessionId: string; turnId: string } | undefined;
	private readonly _onDidChangeReview = this._register(new Emitter<{ readonly sessionId: string }>());
	readonly onDidChangeReview = this._onDidChangeReview.event;
	private readonly _onDidNavigate = this._register(new Emitter<{ sessionId: string; turnId: string; uri: URI }>());
	readonly onDidNavigate = this._onDidNavigate.event;
	private readonly _onDidChangeAutoKeep = this._register(new Emitter<{ readonly sessionId: string }>());
	readonly onDidChangeAutoKeep = this._onDidChangeAutoKeep.event;
	private readonly _onDidChangeSignals = this._register(new Emitter<void>());
	readonly onDidChangeSignals = this._onDidChangeSignals.event;
	private _signals: readonly ClaudeReviewSignalCounter[] = [];
	/** Per-chat Auto-Keep toggles from the mode menu. They last for this window. */
	private readonly _autoKeepChats = new Map<string, boolean>();

	constructor(
		@IClaudeCheckpointService private readonly _checkpoints: IClaudeCheckpointService,
		@ITextModelService private readonly _textModels: ITextModelService,
		@IFileService private readonly _files: IFileService,
		@ITextFileService private readonly _textFiles: ITextFileService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
	) {
		super();
		this._register(_configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_REVIEW_AUTO_KEEP_SETTING)) {
				this._onDidChangeAutoKeep.fire({ sessionId: '' });
			}
		}));
	}

	signals(): readonly ClaudeReviewSignalCounter[] {
		return this._signals;
	}

	setSignals(counters: readonly ClaudeReviewSignalCounter[]): void {
		this._signals = counters;
	}

	recordFindingSignal(repo: string, finding: Pick<ClaudeReviewFinding, 'category' | 'title' | 'body'>, threshold: number): ClaudeReviewSignalCounter | undefined {
		const next = recordClaudeReviewSignal(this._signals, repo, finding);
		if (next === this._signals) {
			return undefined;
		}
		this._signals = next;
		this._onDidChangeSignals.fire();
		return suggestLearnedRules(next, repo, threshold).find(counter => counter.category === finding.category && counter.sample === finding.title.trim());
	}

	resolveFindingSignal(repo: string, counter: Pick<ClaudeReviewSignalCounter, 'category' | 'title'>): void {
		this._signals = resetClaudeReviewSignal(this._signals, repo, counter.category, counter.title);
		this._onDidChangeSignals.fire();
	}

	isAutoKeep(sessionId: string): boolean {
		const mode = readClaudeAutoKeep(this._configuration.getValue(CLAUDE_REVIEW_AUTO_KEEP_SETTING));
		const chat = this._autoKeepChats.get(sessionId);
		if (mode === 'always') {
			return chat !== false;
		}
		return mode === 'thisChat' && chat === true;
	}

	setAutoKeep(sessionId: string, on: boolean | undefined): void {
		if (on === undefined) {
			this._autoKeepChats.delete(sessionId);
		} else {
			this._autoKeepChats.set(sessionId, on);
		}
		this._onDidChangeAutoKeep.fire({ sessionId });
	}

	pendingSummary(scope: ReviewScope): ReviewPendingSummary {
		const seen = new ResourceSet();
		const uris: URI[] = [];
		const chats = new Set<string>();
		let hunks = 0;
		let turns = 0;
		for (const review of this.reviewsIn(scope)) {
			let turnHunks = 0;
			for (const file of review.files) {
				const open = file.hunks.filter(isOpenHunk).length;
				if (open === 0) {
					continue;
				}
				turnHunks += open;
				if (!seen.has(file.uri)) {
					seen.add(file.uri);
					uris.push(file.uri);
				}
			}
			if (turnHunks > 0) {
				hunks += turnHunks;
				turns++;
				chats.add(review.sessionId);
			}
		}
		return { hunks, files: uris.length, turns, chats: chats.size, sessionIds: [...chats], uris };
	}

	keepAllPending(scope: ReviewScope): number {
		let kept = 0;
		const sessions = new Set<string>();
		for (const review of this.reviewsIn(scope)) {
			const count = keepReview(review);
			if (count > 0) {
				kept += count;
				sessions.add(review.sessionId);
			}
		}
		for (const sessionId of sessions) {
			this.notify(sessionId);
		}
		return kept;
	}

	async undoAllPending(scope: ReviewScope): Promise<void> {
		const bySession = new Map<string, ReviewHunk[]>();
		for (const review of this.reviewsIn(scope)) {
			const open = flatHunks(review).filter(isOpenHunk);
			if (open.length > 0) {
				bySession.set(review.sessionId, [...(bySession.get(review.sessionId) ?? []), ...open]);
			}
		}
		let conflict: ReviewConflictError | undefined;
		for (const [sessionId, hunks] of bySession) {
			try {
				await this.rejectMany(sessionId, hunks);
			} catch (error) {
				if (!(error instanceof ReviewConflictError)) {
					throw error;
				}
				conflict = error;
			}
		}
		if (conflict) {
			throw conflict;
		}
	}

	async undoKept(sessionId: string, turnId: string, uri?: URI): Promise<void> {
		const review = this.get(sessionId, turnId);
		if (!review) {
			return;
		}
		const hunks: ReviewHunk[] = [];
		for (const file of review.files) {
			if (uri && file.uri.toString() !== uri.toString()) {
				continue;
			}
			for (const hunk of file.hunks) {
				if (hunk.state === 'accepted') {
					// Back to pending, so the reject compares the live text with the agent's text first.
					hunk.state = 'pending';
					hunks.push(hunk);
				}
			}
		}
		await this.rejectMany(sessionId, hunks);
	}

	private reviewsIn(scope: ReviewScope): TurnReview[] {
		const reviews = [...this._reviews.values()];
		switch (scope.kind) {
			case 'turn': return reviews.filter(review => review.sessionId === scope.sessionId && review.turnId === scope.turnId);
			case 'chat': return reviews.filter(review => review.sessionId === scope.sessionId);
			case 'all': return reviews;
		}
	}

	/** Auto-Keep: a turn of a chat that keeps automatically is kept as it lands. */
	private autoKeep(review: TurnReview): void {
		if (this.isAutoKeep(review.sessionId) && keepReview(review) > 0) {
			review.autoKept = true;
		}
	}

	get(sessionId: string, turnId: string): TurnReview | undefined {
		return this._reviews.get(reviewKey(sessionId, turnId));
	}

	importSaved(review: TurnReview): void {
		const key = reviewKey(review.sessionId, review.turnId);
		this._reviews.set(key, review);
		this._loaded.add(key);
		this.notify(review.sessionId);
	}

	reviewsFor(sessionId: string): readonly TurnReview[] {
		return [...this._reviews.values()].filter(review => review.sessionId === sessionId);
	}

	async ensureTurn(sessionId: string, turnId: string): Promise<TurnReview | undefined> {
		const key = reviewKey(sessionId, turnId);
		if (this._loaded.has(key)) {
			return this._reviews.get(key);
		}
		const pending = this._loading.get(key);
		if (pending) {
			return pending;
		}
		const load = this.loadTurn(sessionId, turnId, key);
		this._loading.set(key, load);
		try {
			return await load;
		} finally {
			if (this._loading.get(key) === load) {
				this._loading.delete(key);
			}
		}
	}

	snapshotText(resource: URI): string | undefined {
		const parsed = parseClaudeSnapshotUri(resource);
		if (!parsed) {
			return undefined;
		}
		const review = this.get(parsed.sessionId, parsed.turnId);
		return review?.files.find(file => file.uri.path === resource.path)?.originalText;
	}

	replaceTurn(sessionId: string, turnId: string, files: readonly ReviewFileText[]): TurnReview {
		const review = buildTurnReview(sessionId, turnId, files);
		const key = reviewKey(sessionId, turnId);
		this.autoKeep(review);
		this._reviews.set(key, review);
		this._loaded.add(key);
		void this.watchModels(review.files.map(file => file.uri));
		this.notify(sessionId);
		return review;
	}

	decorationsFor(uri: URI): readonly ReviewHunk[] {
		return this.hunksFor(uri).map(ref => ref.hunk);
	}

	hunksFor(uri: URI): readonly ReviewHunkRef[] {
		const key = uri.toString();
		const hunks: ReviewHunkRef[] = [];
		for (const review of this._reviews.values()) {
			for (const file of review.files) {
				if (file.uri.toString() !== key) {
					continue;
				}
				for (const hunk of file.hunks) {
					if (hunk.state === 'pending' || hunk.state === 'conflicted') {
						hunks.push({ sessionId: review.sessionId, turnId: review.turnId, hunk });
					}
				}
			}
		}
		return hunks;
	}

	focus(sessionId: string, turnId: string): void {
		this._focus = { sessionId, turnId };
	}

	focused(): { readonly sessionId: string; readonly turnId: string } | undefined {
		return this._focus;
	}

	currentHunk(): ReviewHunk | undefined {
		if (!this._focus) {
			return undefined;
		}
		const review = this.get(this._focus.sessionId, this._focus.turnId);
		if (!review || review.cursor < 0) {
			return undefined;
		}
		return flatHunks(review)[review.cursor];
	}

	acceptHunk(sessionId: string, turnId: string, hunkId: string): void {
		const located = this.locate(sessionId, turnId, hunkId);
		if (!located || located.hunk.state === 'accepted' || located.hunk.state === 'rejected') {
			return;
		}
		located.hunk.state = 'accepted';
		refreshFileState(located.file);
		this.notify(sessionId);
	}

	async rejectHunk(sessionId: string, turnId: string, hunkId: string): Promise<void> {
		const located = this.locate(sessionId, turnId, hunkId);
		if (!located) {
			return;
		}
		const clean = this.cleanFiles([located.hunk]);
		try {
			await this.rejectOne(located.file, located.hunk);
		} finally {
			await this.saveReverted(clean);
			this.notify(sessionId);
		}
	}

	acceptFile(sessionId: string, turnId: string, uri: URI): void {
		const review = this.get(sessionId, turnId);
		const file = review?.files.find(candidate => candidate.uri.toString() === uri.toString());
		if (!file) {
			return;
		}
		for (const hunk of file.hunks) {
			if (hunk.state === 'pending' || hunk.state === 'conflicted') {
				hunk.state = 'accepted';
			}
		}
		refreshFileState(file);
		this.notify(sessionId);
	}

	async rejectFile(sessionId: string, turnId: string, uri: URI): Promise<void> {
		const review = this.get(sessionId, turnId);
		const file = review?.files.find(candidate => candidate.uri.toString() === uri.toString());
		if (!file) {
			return;
		}
		await this.rejectMany(sessionId, file.hunks);
	}

	acceptAll(sessionId: string, turnId: string): void {
		const review = this.get(sessionId, turnId);
		if (!review) {
			return;
		}
		keepReview(review);
		this.notify(sessionId);
	}

	async rejectAll(sessionId: string, turnId: string): Promise<void> {
		const review = this.get(sessionId, turnId);
		if (!review) {
			return;
		}
		const hunks: ReviewHunk[] = [];
		for (const file of review.files) {
			hunks.push(...file.hunks);
		}
		await this.rejectMany(sessionId, hunks);
	}

	next(sessionId: string, turnId: string): ReviewHunk | undefined {
		return this.move(sessionId, turnId, 1);
	}

	previous(sessionId: string, turnId: string): ReviewHunk | undefined {
		return this.move(sessionId, turnId, -1);
	}

	private move(sessionId: string, turnId: string, direction: 1 | -1): ReviewHunk | undefined {
		const review = this.get(sessionId, turnId);
		if (!review) {
			return undefined;
		}
		const hunks = flatHunks(review);
		const open = hunks
			.map((hunk, index) => hunk.state === 'pending' || hunk.state === 'conflicted' ? index : -1)
			.filter(index => index >= 0);
		if (open.length === 0) {
			return undefined;
		}
		const after = open.filter(index => direction > 0 ? index > review.cursor : index < review.cursor);
		const pick = direction > 0 ? (after[0] ?? open[0]) : (after[after.length - 1] ?? open[open.length - 1]);
		review.cursor = pick;
		const hunk = hunks[pick];
		this._focus = { sessionId, turnId };
		this._onDidNavigate.fire({ sessionId, turnId, uri: hunk.uri });
		return hunk;
	}

	private async rejectMany(sessionId: string, hunks: readonly ReviewHunk[]): Promise<void> {
		const clean = this.cleanFiles(hunks);
		const byFile = new ResourceMap<ReviewHunk[]>();
		for (const hunk of hunks) {
			const list = byFile.get(hunk.uri) ?? [];
			list.push(hunk);
			byFile.set(hunk.uri, list);
		}
		let conflict: ReviewConflictError | undefined;
		try {
			for (const [uri, fileHunks] of byFile) {
				const ordered = fileHunks.sort((left, right) => right.currentRange.startLineNumber - left.currentRange.startLineNumber || right.currentRange.startColumn - left.currentRange.startColumn);
				for (const hunk of ordered) {
					const file = this.fileOf(hunk);
					if (!file) {
						continue;
					}
					try {
						await this.rejectOne(file, hunk);
					} catch (error) {
						if (error instanceof ReviewConflictError) {
							conflict = error;
							continue;
						}
						throw error;
					}
				}
				// Each file is saved as soon as it is reverted: saving them all at the end of a big
				// Undo All left them dirty long enough for the workbench to open them as tabs (issue 349).
				if (clean.has(uri)) {
					await this.saveReverted([uri]);
				}
			}
		} finally {
			await this.saveReverted(clean);
		}
		this.notify(sessionId);
		if (conflict) {
			throw conflict;
		}
	}

	private async rejectOne(file: ReviewFile, hunk: ReviewHunk): Promise<void> {
		if (hunk.state === 'accepted' || hunk.state === 'rejected') {
			return;
		}
		const reference = await this._textModels.createModelReference(hunk.uri);
		this._applyingEdit = true;
		try {
			const before = hunk.currentRange;
			rejectHunkOnModel(hunk, reference.object.textEditorModel);
			const delta = newlineCount(hunk.originalText) - newlineCount(hunk.modifiedText);
			if (delta !== 0) {
				for (const other of file.hunks) {
					if (other !== hunk && other.state !== 'rejected' && startsAtOrAfterEnd(other.currentRange, before)) {
						other.currentRange = shiftRange(other.currentRange, delta);
					}
				}
			}
			if (file.isNew && file.hunks.every(candidate => candidate.state === 'rejected' || candidate.state === 'accepted')) {
				const value = reference.object.textEditorModel.getValue(EndOfLinePreference.LF);
				if (value.length === 0) {
					// Drop the emptied buffer first, so the deleted file leaves no dirty tab behind.
					await this._textFiles.revert(file.uri, { soft: true });
					try {
						await this._files.del(file.uri);
					} catch (error) {
						// Already gone (deleted outside Klawly) means the undo is done: saving would write an
						// empty file back. Otherwise the file stays (Windows holds busy files): write the emptied
						// buffer, so the disk does not keep the agent's text behind a clean editor.
						if (!(error instanceof Error) || toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) {
							await this._textFiles.save(file.uri, { force: true, skipSaveParticipants: true });
							throw error;
						}
					}
				}
			}
		} catch (error) {
			refreshFileState(file);
			throw error;
		} finally {
			this._applyingEdit = false;
			reference.dispose();
		}
		refreshFileState(file);
	}

	/** Files a reject will edit that have no unsaved edits of their own; only those are saved afterwards. */
	private cleanFiles(hunks: readonly ReviewHunk[]): ResourceSet {
		const clean = new ResourceSet();
		for (const hunk of hunks) {
			if ((hunk.state === 'pending' || hunk.state === 'conflicted') && !this._textFiles.isDirty(hunk.uri)) {
				clean.add(hunk.uri);
			}
		}
		return clean;
	}

	/**
	 * Writes reverted files back to disk, so Undo leaves no unsaved buffers and the
	 * workbench does not open a tab for a dirty file nobody had open. Save
	 * participants are skipped: the original text goes back exactly as it was.
	 */
	private async saveReverted(uris: Iterable<URI>): Promise<void> {
		for (const uri of uris) {
			if (this._textFiles.isDirty(uri)) {
				await this._textFiles.save(uri, { skipSaveParticipants: true });
			}
		}
	}

	private fileOf(hunk: ReviewHunk): ReviewFile | undefined {
		for (const review of this._reviews.values()) {
			for (const file of review.files) {
				if (file.hunks.includes(hunk)) {
					return file;
				}
			}
		}
		return undefined;
	}

	private locate(sessionId: string, turnId: string, hunkId: string): { file: ReviewFile; hunk: ReviewHunk } | undefined {
		const review = this.get(sessionId, turnId);
		if (!review) {
			return undefined;
		}
		for (const file of review.files) {
			const hunk = file.hunks.find(candidate => candidate.id === hunkId);
			if (hunk) {
				return { file, hunk };
			}
		}
		return undefined;
	}

	private async loadTurn(sessionId: string, turnId: string, key: string): Promise<TurnReview | undefined> {
		const originals = await this._checkpoints.readCheckpointOriginals(sessionId, turnId);
		const files: ReviewFileText[] = [];
		const failed: URI[] = [];
		for (const original of originals) {
			if (!isReviewBaseline(original)) {
				continue;
			}
			const uri = URI.parse(original.uri);
			const modifiedText = await this.modifiedText(original, uri);
			if (modifiedText === undefined) {
				failed.push(uri);
				continue;
			}
			files.push({ uri, originalText: original.text, modifiedText, existed: original.existed !== false });
		}
		const existing = this._reviews.get(key);
		const loaded = buildTurnReview(sessionId, turnId, files);
		const decision = reviewFromLoad(existing, loaded, failed.length > 0);
		if (!decision.publish || !decision.review) {
			if (failed.length > 0) {
				throw new ReviewReadError(failed);
			}
			if (decision.review) {
				this._loaded.add(key);
			}
			return decision.review;
		}
		this._reviews.set(key, decision.review);
		this._loaded.add(key);
		await this.watchModels(decision.review.files.map(file => file.uri));
		await this.markDrift(decision.review, files);
		this.autoKeep(decision.review);
		this.notify(sessionId);
		return decision.review;
	}

	/**
	 * Modified text is the post-write snapshot when the checkpoint stored it.
	 * A missing file after the write is `''`. A failed read is skipped, not treated as empty.
	 */
	private async modifiedText(original: { readonly afterText?: string; readonly afterHash?: string | null }, uri: URI): Promise<string | undefined> {
		if (original.afterText !== undefined) {
			return original.afterText;
		}
		if (original.afterHash === null) {
			return '';
		}
		return this.readCurrent(uri);
	}

	private async markDrift(review: TurnReview, files: readonly ReviewFileText[]): Promise<void> {
		for (const file of review.files) {
			const expected = files.find(candidate => candidate.uri.toString() === file.uri.toString())?.modifiedText;
			if (expected === undefined) {
				continue;
			}
			const live = await this.readCurrent(file.uri);
			if (live === undefined || normalizeEol(live) === normalizeEol(expected)) {
				continue;
			}
			let reference;
			try {
				reference = await this._textModels.createModelReference(file.uri);
			} catch {
				continue;
			}
			try {
				const model = reference.object.textEditorModel;
				for (const hunk of file.hunks) {
					if (hunk.state !== 'pending' && hunk.state !== 'conflicted') {
						continue;
					}
					if (!rangeFits(model, hunk.currentRange) || model.getValueInRange(hunk.currentRange, EndOfLinePreference.LF) !== hunk.modifiedText) {
						hunk.state = 'conflicted';
					}
				}
			} finally {
				reference.dispose();
			}
			refreshFileState(file);
		}
	}

	private async watchModels(uris: readonly URI[]): Promise<void> {
		for (const uri of uris) {
			const key = uri.toString();
			if (this._watched.has(key)) {
				continue;
			}
			let reference;
			try {
				reference = await this._textModels.createModelReference(uri);
			} catch {
				continue;
			}
			this._watched.add(key);
			this._modelListeners.add(reference);
			const model = reference.object.textEditorModel;
			this._modelListeners.add(model.onDidChangeContent(event => this.onModelEdited(uri, event)));
		}
	}

	private onModelEdited(uri: URI, event: IModelContentChangedEvent): void {
		if (this._applyingEdit) {
			return;
		}
		const key = uri.toString();
		let changed = false;
		const sessions = new Set<string>();
		for (const review of this._reviews.values()) {
			for (const file of review.files) {
				if (file.uri.toString() !== key) {
					continue;
				}
				let fileChanged = false;
				for (const hunk of file.hunks) {
					if (hunk.state === 'accepted' && review.autoKept) {
						// Auto-kept hunks keep their place, so Undo on the card finds them (issue 706).
						// An edit inside one is caught when Undo compares the text.
						for (const change of event.changes) {
							if (rangeStrictlyBefore(change.range, hunk.currentRange)) {
								hunk.currentRange = shiftRange(hunk.currentRange, newlineCount(change.text) - (change.range.endLineNumber - change.range.startLineNumber));
							}
						}
						continue;
					}
					if (hunk.state === 'accepted' || hunk.state === 'rejected') {
						continue;
					}
					if (event.isFlush) {
						hunk.state = 'conflicted';
						fileChanged = true;
						continue;
					}
					for (const change of event.changes) {
						if (rangeStrictlyBefore(change.range, hunk.currentRange)) {
							hunk.currentRange = shiftRange(hunk.currentRange, newlineCount(change.text) - (change.range.endLineNumber - change.range.startLineNumber));
							fileChanged = true;
						} else if (!rangeStrictlyAfter(change.range, hunk.currentRange)) {
							hunk.state = 'conflicted';
							fileChanged = true;
						}
					}
				}
				if (fileChanged) {
					refreshFileState(file);
					changed = true;
					sessions.add(review.sessionId);
				}
			}
		}
		if (changed) {
			for (const sessionId of sessions) {
				this.notify(sessionId);
			}
		}
	}

	private notify(sessionId: string): void {
		if (!this._store.isDisposed) {
			this._onDidChangeReview.fire({ sessionId });
		}
	}

	private async readCurrent(uri: URI): Promise<string | undefined> {
		try {
			const reference = await this._textModels.createModelReference(uri);
			try {
				return reference.object.textEditorModel.getValue(EndOfLinePreference.LF);
			} finally {
				reference.dispose();
			}
		} catch {
			return undefined;
		}
	}
}

function isOpenHunk(hunk: ReviewHunk): boolean {
	return hunk.state === 'pending' || hunk.state === 'conflicted';
}

/** Marks every pending and conflicted hunk of a turn kept. Returns how many it kept. */
function keepReview(review: TurnReview): number {
	let kept = 0;
	for (const file of review.files) {
		for (const hunk of file.hunks) {
			if (isOpenHunk(hunk)) {
				hunk.state = 'accepted';
				kept++;
			}
		}
		refreshFileState(file);
	}
	return kept;
}

function reviewKey(sessionId: string, turnId: string): string {
	return `${sessionId}\n${turnId}`;
}

function parentDirectory(uri: URI): string {
	const parts = uri.path.split('/').filter(part => part.length > 0);
	parts.pop();
	const parent = parts[parts.length - 1] ?? '';
	if (/^[A-Za-z]:$/.test(parent)) {
		return '';
	}
	return parent;
}

function refreshFileState(file: ReviewFile): void {
	const states = new Set(file.hunks.map(hunk => hunk.state));
	if (states.size === 1) {
		file.state = file.hunks[0]?.state ?? 'pending';
		return;
	}
	if (states.has('conflicted')) {
		file.state = 'conflicted';
		return;
	}
	file.state = 'mixed';
}

function newlineCount(text: string): number {
	let count = 0;
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 10) {
			count++;
		}
	}
	return count;
}

function startsAtOrAfterEnd(range: Range, boundary: Range): boolean {
	if (range.startLineNumber > boundary.endLineNumber) {
		return true;
	}
	if (range.startLineNumber < boundary.endLineNumber) {
		return false;
	}
	return range.startColumn >= boundary.endColumn;
}

function shiftRange(range: Range, delta: number): Range {
	return new Range(range.startLineNumber + delta, range.startColumn, range.endLineNumber + delta, range.endColumn);
}

function rangeStrictlyBefore(change: IRange, range: Range): boolean {
	if (change.endLineNumber < range.startLineNumber) {
		return true;
	}
	return change.endLineNumber === range.startLineNumber && change.endColumn < range.startColumn;
}

function rangeStrictlyAfter(change: IRange, range: Range): boolean {
	if (change.startLineNumber > range.endLineNumber) {
		return true;
	}
	return change.startLineNumber === range.endLineNumber && change.startColumn >= range.endColumn;
}

function rangeFits(model: ITextModel, range: Range): boolean {
	return range.startLineNumber >= 1 && range.endLineNumber <= model.getLineCount();
}

function normalizeEol(text: string): string {
	return text.replace(/\r\n/g, '\n');
}

/** Lines in a file's text; a final line break does not start another line. */
function countLines(text: string): number {
	const normalized = normalizeEol(text);
	if (normalized.length === 0) {
		return 0;
	}
	return normalized.split('\n').length - (normalized.endsWith('\n') ? 1 : 0);
}

/** Same slice as `ITextModel.getValueInRange` with LF endings. Columns past the line clamp. */
function textInRange(text: string, range: Range): string {
	const lines = text.split('\n');
	const startLine = clampLine(range.startLineNumber, lines.length);
	const endLine = clampLine(range.endLineNumber, lines.length);
	const startColumn = clampColumn(lines[startLine - 1] ?? '', range.startColumn);
	const endColumn = clampColumn(lines[endLine - 1] ?? '', range.endColumn);
	if (startLine === endLine) {
		return (lines[startLine - 1] ?? '').slice(startColumn - 1, endColumn - 1);
	}
	const parts: string[] = [];
	parts.push((lines[startLine - 1] ?? '').slice(startColumn - 1));
	for (let line = startLine + 1; line < endLine; line++) {
		parts.push(lines[line - 1] ?? '');
	}
	parts.push((lines[endLine - 1] ?? '').slice(0, endColumn - 1));
	return parts.join('\n');
}

function clampLine(line: number, count: number): number {
	if (count < 1) {
		return 1;
	}
	if (line < 1) {
		return 1;
	}
	if (line > count) {
		return count;
	}
	return line;
}

function clampColumn(line: string, column: number): number {
	const max = line.length + 1;
	if (column < 1) {
		return 1;
	}
	if (column > max) {
		return max;
	}
	return column;
}
