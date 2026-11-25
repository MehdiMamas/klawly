/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout, timeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { dirname } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { buildCompletionPrompt, ClaudeInlineCompletionRequest, completionCacheKey, completionLatencyPercentiles, CompletionInput, CompletionPosition, CompletionResult, CompletionSnapshot, formatClaudeTabLatency, inlineInsertText, isNextEditInsideWorkspace, isSecretCompletionSurface, isStaleCompletion, nextEditFileName, parseCompletionText, RecentEdit, resolveNextEditTarget } from '../../../../platform/claude/common/claudeAutocomplete.js';
import { formatTabContextBudget, TabContextBudgetController } from '../../../../platform/claude/common/claudeAutocompleteBudget.js';
import { CLAUDE_AUTOCOMPLETE_DEBOUNCE_SETTING, CLAUDE_AUTOCOMPLETE_ENABLED_SETTING, CLAUDE_AUTOCOMPLETE_MODEL_SETTING, readClaudeAutocompleteDebounceMs, readClaudeAutocompleteEnabled, readClaudeAutocompleteModel } from '../../../../platform/claude/common/claudeConfiguration.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IOutputService } from '../../output/common/output.js';
import { CLAUDE_AGENT_OUTPUT_CHANNEL_ID } from './claudeAgentLog.js';
import { IClaudeKlawlyHooksService } from './claudeKlawlyHooksService.js';

export const IClaudeAutocompleteService = createDecorator<IClaudeAutocompleteService>('claudeAutocompleteService');

export interface IClaudeAutocompleteService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeNextEdit: Event<void>;

	provideCompletion(input: CompletionInput, token: CancellationToken): Promise<CompletionResult | undefined>;
	/**
	 * Speculative completion after an accepted edit. It does not start while a
	 * request for this file is already running, and it does not start when the
	 * live cursor snapshot disagrees with `input`.
	 */
	prefetchCompletion(input: CompletionInput, token: CancellationToken): Promise<CompletionResult | undefined>;
	/**
	 * Records one editor's cursor. Returns true when the focused snapshot moved.
	 * Only a focused editor updates that snapshot, so a split of the same model
	 * does not flap it. The stale-result guard compares a request against it.
	 */
	noteDocument(uri: URI, versionId: number, position: CompletionPosition | null, editor?: { readonly id: string; readonly focused: boolean }): boolean;
	/** Drops per-URI completion state when the text model is disposed. */
	forgetDocument(uri: URI): void;
	/** Drops one editor's cursor. Returns true when no editor still tracks that model. */
	releaseEditor(editorId: string): boolean;
	notedPosition(uri: URI): CompletionPosition | undefined;
	cancelActive(uri: URI): void;
	recordRecentEdit(edit: RecentEdit): void;
	snapshotRecentEdits(): readonly RecentEdit[];
	peekNextEdit(uri: URI): CompletionResult & { kind: 'next-edit' } | undefined;
	dismissNextEdit(uri: URI): void;
	acceptNextEdit(uri: URI): { readonly target: URI; readonly line: number; readonly preview: string } | undefined;
	/** Arms a cross-file preview that replaces `lineNumber` in full. */
	armPreview(uri: URI, versionId: number, lineNumber: number, text: string): void;
	/** Returns the preview only when the document version and line still match. */
	consumePreview(uri: URI, versionId: number, lineNumber: number): { readonly text: string; readonly lineNumber: number } | undefined;
	latency(): { readonly p50: number; readonly p95: number; readonly count: number } | undefined;
	/** Writes the current P50/P95 to the Claude Agent output channel. */
	logLatency(): string;
	/** False while the setting is off or Tab is snoozed. */
	enabled(): boolean;
	/** Fires when the setting or a snooze turns Tab on or off. */
	readonly onDidChangeEnablement: Event<void>;
	/** Pauses Tab in this window for the given minutes. Not persisted. */
	snooze(minutes: number): void;
	/** Ends a snooze early. */
	resume(): void;
	/** When the snooze ends, in milliseconds since the epoch, or undefined when Tab is not snoozed. */
	snoozedUntil(): number | undefined;
}

interface LiveDocument {
	readonly versionId: number;
	readonly lineNumber: number;
	readonly column: number;
}

interface EditorSlot extends LiveDocument {
	readonly uri: string;
}

interface StoredEdit extends RecentEdit {
	readonly at: number;
}

const CACHE_LIMIT = 32;
const SAMPLE_LIMIT = 200;

/**
 * Debounced, cached completions. A result is dropped when the cursor or the
 * document version moved, when the request was cancelled, or when Tab is disabled.
 * Cross-file predictions are stored as a next-edit affordance and are not inserted.
 */
export class ClaudeAutocompleteService extends Disposable implements IClaudeAutocompleteService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeNextEdit = this._register(new Emitter<void>());
	readonly onDidChangeNextEdit = this._onDidChangeNextEdit.event;
	private readonly _onDidChangeEnablement = this._register(new Emitter<void>());
	readonly onDidChangeEnablement = this._onDidChangeEnablement.event;
	private readonly _snoozeTimer = this._register(new MutableDisposable());
	private _snoozedUntil: number | undefined;

	private readonly _live = new Map<string, LiveDocument>();
	private readonly _editors = new Map<string, EditorSlot>();
	private readonly _generation = new Map<string, number>();
	/** Never restarts, so a deleted per-URI entry cannot hand its number to a new request. */
	private _generationClock = 0;
	private readonly _inflight = new Map<string, string>();
	private readonly _cache = new Map<string, CompletionResult>();
	private readonly _next = new Map<string, CompletionResult & { kind: 'next-edit' }>();
	private readonly _armed = new Map<string, { readonly versionId: number; readonly lineNumber: number; readonly text: string }>();
	private readonly _edits: StoredEdit[] = [];
	private readonly _samples: number[] = [];
	/** Shrinks the prefix and suffix sent while measured P95 latency is above target. */
	private readonly _budget = new TabContextBudgetController();
	/** URIs with a provideCompletion call that has not returned. */
	private readonly _busy = new Set<string>();

	constructor(
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IOutputService private readonly _output: IOutputService,
		@IClaudeKlawlyHooksService private readonly _hooks: IClaudeKlawlyHooksService,
	) {
		super();
		this._register(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_AUTOCOMPLETE_ENABLED_SETTING)) {
				if (!this.enabled()) {
					this._disable();
				}
				this._onDidChangeEnablement.fire();
			}
		}));
	}

	enabled(): boolean {
		return this._snoozedUntil === undefined && readClaudeAutocompleteEnabled(this._configuration.getValue(CLAUDE_AUTOCOMPLETE_ENABLED_SETTING));
	}

	snooze(minutes: number): void {
		if (!(minutes > 0)) {
			return;
		}
		const ms = minutes * 60_000;
		this._snoozedUntil = Date.now() + ms;
		this._snoozeTimer.value = disposableTimeout(() => this.resume(), ms);
		this._disable();
		this._onDidChangeEnablement.fire();
	}

	resume(): void {
		if (this._snoozedUntil === undefined) {
			return;
		}
		this._snoozedUntil = undefined;
		this._snoozeTimer.clear();
		this._onDidChangeEnablement.fire();
	}

	snoozedUntil(): number | undefined {
		return this._snoozedUntil;
	}

	latency(): { readonly p50: number; readonly p95: number; readonly count: number } | undefined {
		const stats = completionLatencyPercentiles(this._samples);
		if (!stats) {
			return undefined;
		}
		return { p50: stats.p50, p95: stats.p95, count: this._samples.length };
	}

	noteDocument(uri: URI, versionId: number, position: CompletionPosition | null, editor?: { readonly id: string; readonly focused: boolean }): boolean {
		const key = uri.toString();
		const editorId = editor?.id ?? `uri:${key}`;
		const focused = editor?.focused ?? true;
		const previousSlot = this._editors.get(editorId);
		const previousLive = this._live.get(key);
		const next: LiveDocument = {
			versionId,
			lineNumber: position?.lineNumber ?? previousSlot?.lineNumber ?? previousLive?.lineNumber ?? 1,
			column: position?.column ?? previousSlot?.column ?? previousLive?.column ?? 1,
		};
		this._editors.set(editorId, { uri: key, ...next });
		const versionChanged = !previousLive || previousLive.versionId !== versionId;
		if (!focused) {
			if (!previousLive || !versionChanged) {
				return false;
			}
			this._live.set(key, { versionId, lineNumber: previousLive.lineNumber, column: previousLive.column });
			this.cancelActive(uri);
			this.dismissNextEdit(uri);
			return true;
		}
		this._live.set(key, next);
		if (!previousLive) {
			return true;
		}
		if (versionChanged) {
			this.cancelActive(uri);
			this.dismissNextEdit(uri);
		}
		return isStaleCompletion(previousLive, next, false);
	}

	forgetDocument(uri: URI): void {
		const key = uri.toString();
		const requestId = this._inflight.get(key);
		if (requestId) {
			this._inflight.delete(key);
			void this._runtime.cancelInline?.(requestId);
		}
		this._live.delete(key);
		this._bumpGeneration(key);
		this._armed.delete(key);
		if (this._next.delete(key)) {
			this._onDidChangeNextEdit.fire();
		}
		for (const [editorId, slot] of this._editors) {
			if (slot.uri === key) {
				this._editors.delete(editorId);
			}
		}
	}

	releaseEditor(editorId: string): boolean {
		const slot = this._editors.get(editorId);
		if (!slot) {
			return false;
		}
		this._editors.delete(editorId);
		const others = [...this._editors.values()].filter(other => other.uri === slot.uri);
		if (others.length === 0) {
			this._live.delete(slot.uri);
			return true;
		}
		const fallback = others[others.length - 1];
		this._live.set(slot.uri, { versionId: fallback.versionId, lineNumber: fallback.lineNumber, column: fallback.column });
		return false;
	}

	notedPosition(uri: URI): CompletionPosition | undefined {
		const live = this._live.get(uri.toString());
		return live ? { lineNumber: live.lineNumber, column: live.column } : undefined;
	}

	cancelActive(uri: URI): void {
		const key = uri.toString();
		this._bumpGeneration(key);
		const requestId = this._inflight.get(key);
		if (requestId) {
			this._inflight.delete(key);
			void this._runtime.cancelInline?.(requestId);
		}
	}

	recordRecentEdit(edit: RecentEdit): void {
		if (isSecretCompletionSurface({ languageId: '', uriPath: edit.uri, lineText: `${edit.before}\n${edit.after}` })) {
			return;
		}
		if (edit.before.length === 0 && edit.after.length === 0) {
			return;
		}
		const last = this._edits[this._edits.length - 1];
		if (last && last.uri === edit.uri && last.after === edit.after && last.range.startLineNumber === edit.range.startLineNumber && last.range.startColumn === edit.range.startColumn) {
			if (edit.before.length > last.before.length) {
				this._edits[this._edits.length - 1] = { ...edit, at: last.at };
			}
			return;
		}
		this._edits.push({ ...edit, at: Date.now() });
		if (this._edits.length > 8) {
			this._edits.shift();
		}
	}

	snapshotRecentEdits(): readonly RecentEdit[] {
		const now = Date.now();
		return this._edits.map(edit => ({
			uri: edit.uri,
			before: edit.before,
			after: edit.after,
			range: edit.range,
			ageMs: Math.max(0, now - edit.at),
		}));
	}

	peekNextEdit(uri: URI): CompletionResult & { kind: 'next-edit' } | undefined {
		if (!this.enabled()) {
			return undefined;
		}
		return this._next.get(uri.toString());
	}

	dismissNextEdit(uri: URI): void {
		if (this._next.delete(uri.toString())) {
			this._onDidChangeNextEdit.fire();
		}
	}

	acceptNextEdit(uri: URI): { readonly target: URI; readonly line: number; readonly preview: string } | undefined {
		const next = this._next.get(uri.toString());
		if (!next || !this.enabled()) {
			return undefined;
		}
		this._next.delete(uri.toString());
		this._onDidChangeNextEdit.fire();
		if (!isNextEditInsideWorkspace(next.target, this._folders())) {
			return undefined;
		}
		return { target: next.target, line: next.line, preview: next.preview };
	}

	armPreview(uri: URI, versionId: number, lineNumber: number, text: string): void {
		if (!this.enabled() || text.length === 0 || lineNumber < 1) {
			return;
		}
		this._armed.set(uri.toString(), { versionId, lineNumber, text });
	}

	consumePreview(uri: URI, versionId: number, lineNumber: number): { readonly text: string; readonly lineNumber: number } | undefined {
		const key = uri.toString();
		const armed = this._armed.get(key);
		if (!armed) {
			return undefined;
		}
		this._armed.delete(key);
		if (!this.enabled() || versionId !== armed.versionId || lineNumber !== armed.lineNumber) {
			return undefined;
		}
		return { text: armed.text, lineNumber: armed.lineNumber };
	}

	logLatency(): string {
		const line = formatClaudeTabLatency(this.latency());
		this._output.getChannel(CLAUDE_AGENT_OUTPUT_CHANNEL_ID)?.append(line);
		return line;
	}

	prefetchCompletion(input: CompletionInput, token: CancellationToken): Promise<CompletionResult | undefined> {
		const key = input.uri.toString();
		if (this._busy.has(key)) {
			return Promise.resolve(undefined);
		}
		const live = this._live.get(key);
		if (!live || live.versionId !== input.versionId || live.lineNumber !== input.position.lineNumber || live.column !== input.position.column) {
			return Promise.resolve(undefined);
		}
		return this.provideCompletion(input, token);
	}

	async provideCompletion(input: CompletionInput, token: CancellationToken): Promise<CompletionResult | undefined> {
		if (!this.enabled() || isSecretCompletionSurface(input)) {
			return undefined;
		}
		const key = input.uri.toString();
		this._busy.add(key);
		try {
			return await this._provide(input, token, key);
		} finally {
			this._busy.delete(key);
		}
	}

	private async _provide(input: CompletionInput, token: CancellationToken, key: string): Promise<CompletionResult | undefined> {
		this._remember(input);
		const generation = this._bumpGeneration(key);
		const previous = this._inflight.get(key);
		if (previous) {
			this._inflight.delete(key);
			void this._runtime.cancelInline?.(previous);
		}
		try {
			await timeout(readClaudeAutocompleteDebounceMs(this._configuration.getValue(CLAUDE_AUTOCOMPLETE_DEBOUNCE_SETTING)), token);
		} catch {
			return undefined;
		}
		if (!this._current(input, token, generation)) {
			return undefined;
		}
		const cacheKey = completionCacheKey(input.fileText, input.position, `${input.prefix}\n${input.suffix}`);
		const cached = this._cache.get(cacheKey);
		if (cached) {
			return this._publish(input, cached);
		}
		const cwd = this._cwd(input.uri);
		if (!cwd || !this._runtime.completeInline) {
			return undefined;
		}
		const sent = await this._readableByHooks(input);
		if (!sent || !this._current(input, token, generation)) {
			return undefined;
		}
		const requestId = generateUuid();
		this._inflight.set(key, requestId);
		const onCancel = token.onCancellationRequested(() => {
			void this._runtime.cancelInline?.(requestId);
		});
		const started = Date.now();
		let raw: string | undefined;
		let completed = false;
		try {
			const request: ClaudeInlineCompletionRequest = {
				id: requestId,
				prompt: buildCompletionPrompt(sent, this._budget.current()),
				cwd,
				model: readClaudeAutocompleteModel(this._configuration.getValue(CLAUDE_AUTOCOMPLETE_MODEL_SETTING)),
			};
			raw = await this._runtime.completeInline(request);
			completed = true;
		} catch {
			raw = undefined;
		} finally {
			onCancel.dispose();
			if (this._inflight.get(key) === requestId) {
				this._inflight.delete(key);
			}
		}
		const superseded = this._generation.get(key) !== generation;
		if (completed && this.enabled() && !token.isCancellationRequested && !superseded) {
			this._recordSample(Date.now() - started);
		}
		if (!this._current(input, token, generation)) {
			return undefined;
		}
		const parsed = raw ? parseCompletionText(raw) : undefined;
		if (!parsed) {
			return undefined;
		}
		const result = this._toResult(input, parsed);
		if (!result) {
			return undefined;
		}
		this._cache.set(cacheKey, result);
		this._trimCache();
		return this._publish(input, result);
	}

	private _publish(input: CompletionInput, result: CompletionResult): CompletionResult | undefined {
		if (!this._current(input, CancellationToken.None, this._generation.get(input.uri.toString()) ?? 0)) {
			return undefined;
		}
		if (inlineInsertText(result) === undefined) {
			if (result.kind === 'next-edit') {
				this._next.set(input.uri.toString(), result);
				this._onDidChangeNextEdit.fire();
			}
			return result;
		}
		if (this._next.delete(input.uri.toString())) {
			this._onDidChangeNextEdit.fire();
		}
		return result;
	}

	private _toResult(input: CompletionInput, parsed: { readonly kind: 'inline' | 'next'; readonly text: string; readonly path?: string; readonly line?: number }): CompletionResult | undefined {
		if (parsed.kind === 'inline') {
			return { kind: 'inline', insertText: parsed.text };
		}
		if (!parsed.path || !parsed.line) {
			return undefined;
		}
		const target = resolveNextEditTarget(parsed.path, this._folders(), input.uri);
		if (!target) {
			return undefined;
		}
		return {
			kind: 'next-edit',
			target,
			line: parsed.line,
			preview: parsed.text,
			fileName: nextEditFileName(parsed.path),
			anchor: { lineNumber: input.position.lineNumber, column: input.position.column },
		};
	}

	private _current(input: CompletionInput, token: CancellationToken, generation: number): boolean {
		if (!this.enabled() || token.isCancellationRequested || this._generation.get(input.uri.toString()) !== generation) {
			return false;
		}
		const live = this._live.get(input.uri.toString());
		if (!live) {
			return true;
		}
		const request: CompletionSnapshot = {
			versionId: input.versionId,
			lineNumber: input.position.lineNumber,
			column: input.position.column,
		};
		return !isStaleCompletion(request, live, false);
	}

	/**
	 * The input without the files a `KlawlyTabRead` hook denies (issue 514).
	 * Undefined when it denies the file being completed.
	 */
	private async _readableByHooks(input: CompletionInput): Promise<CompletionInput | undefined> {
		const others = [...new Set([...input.recentEdits, ...input.relatedSnippets].map(item => item.uri))].filter(uri => uri !== input.uri.toString());
		const [own, ...verdicts] = await Promise.all([input.uri, ...others.map(uri => URI.parse(uri))].map(uri => this._hooks.checkTabRead(uri)));
		if (!own.allowed) {
			return undefined;
		}
		const denied = new Set(others.filter((_, index) => !verdicts[index].allowed));
		if (denied.size === 0) {
			return input;
		}
		return { ...input, recentEdits: input.recentEdits.filter(edit => !denied.has(edit.uri)), relatedSnippets: input.relatedSnippets.filter(snippet => !denied.has(snippet.uri)) };
	}

	private _remember(input: CompletionInput): void {
		const key = input.uri.toString();
		if (!this._live.has(key)) {
			this._live.set(key, {
				versionId: input.versionId,
				lineNumber: input.position.lineNumber,
				column: input.position.column,
			});
		}
	}

	private _bumpGeneration(key: string): number {
		this._generationClock++;
		this._generation.set(key, this._generationClock);
		return this._generationClock;
	}

	private _folders(): URI[] {
		return this._workspace.getWorkspace().folders.map(folder => folder.uri);
	}

	private _cwd(uri: URI): string | undefined {
		const folder = this._workspace.getWorkspace().folders[0];
		if (folder) {
			return folder.uri.fsPath;
		}
		if (uri.scheme === 'file') {
			return dirname(uri.fsPath);
		}
		return undefined;
	}

	private _recordSample(elapsed: number): void {
		this._samples.push(elapsed);
		if (this._samples.length > SAMPLE_LIMIT) {
			this._samples.shift();
		}
		const changed = this._budget.record(elapsed);
		if (changed) {
			this._output.getChannel(CLAUDE_AGENT_OUTPUT_CHANNEL_ID)?.append(formatTabContextBudget(changed.budget, changed.p95));
		}
	}

	private _trimCache(): void {
		while (this._cache.size > CACHE_LIMIT) {
			const oldest = this._cache.keys().next().value;
			if (oldest === undefined) {
				return;
			}
			this._cache.delete(oldest);
		}
	}

	private _disable(): void {
		for (const requestId of this._inflight.values()) {
			void this._runtime.cancelInline?.(requestId);
		}
		this._inflight.clear();
		for (const key of [...this._generation.keys()]) {
			this._bumpGeneration(key);
		}
		this._armed.clear();
		this._cache.clear();
		// Tab starts again at the full context size when it is turned back on.
		this._budget.reset();
		this._live.clear();
		this._editors.clear();
		this._edits.length = 0;
		if (this._next.size > 0) {
			this._next.clear();
			this._onDidChangeNextEdit.fire();
		}
	}
}
