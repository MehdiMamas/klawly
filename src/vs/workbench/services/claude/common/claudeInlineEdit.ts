/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { EndOfLinePreference, ITextModel } from '../../../../editor/common/model.js';
import { localize } from '../../../../nls.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { escapeAttr, escapeBody, clipText } from '../../../../platform/claude/common/claudePrompt.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IClaudeAgentService } from './claudeAgentService.js';
import { IClaudeCheckpointService } from './claudeCheckpointService.js';
import { IClaudeKlawlyHooksService } from './claudeKlawlyHooksService.js';
import { collectReviewHunks, IClaudeReviewService, isReviewBaseline, ReviewConflictError, ReviewFileText, ReviewHunk } from './claudeReview.js';

/** Lines of the file kept around the selection. The rest is not sent. */
export const INLINE_NEARBY_LINES = 40;

/**
 * Ctrl/Cmd+K starts Code - OSS chords. The default inline binding adds Alt so
 * those chords still run. The Klawly Keys setting binds Ctrl/Cmd+K itself.
 */
export const INLINE_EDIT_DEFAULT_KEY = KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyK;
export const INLINE_EDIT_KLAWLY_KEY = KeyMod.CtrlCmd | KeyCode.KeyK;

export const IClaudeInlineEditService = createDecorator<IClaudeInlineEditService>('claudeInlineEditService');

export interface InlineSelection {
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
	readonly text: string;
}

export interface InlineEditRunRequest {
	readonly uri: URI;
	readonly languageId: string;
	readonly relativePath: string;
	readonly text: string;
	readonly selection: InlineSelection;
	readonly instruction: string;
	readonly cwd: string;
	/** Absolute path of a file-scheme document. Absent for untitled editors. */
	readonly checkpointPath?: string;
	/**
	 * On a follow-up, the target file's text from before the first edit. A
	 * follow-up that goes to the full review then shows both edits there.
	 */
	readonly baseline?: string;
	readonly readLive: () => string;
	/**
	 * Called when the buffer still matches the pre-edit text after the turn.
	 * The editor waits for the file model to pick up the disk edit.
	 */
	readonly waitForText?: () => Promise<void>;
	/**
	 * The editor's text model. A notebook cell has no file of its own, so its
	 * edit is applied to this model, in one undo step, instead of on disk.
	 */
	readonly model?: ITextModel;
}

export interface InlineFileSnapshot {
	readonly uri: URI;
	readonly originalText: string;
	readonly modifiedText: string;
	readonly existed: boolean;
	readonly hunks: readonly ReviewHunk[];
}

export type InlineEditOutcome =
	| { readonly kind: 'inline'; readonly sessionId: string; readonly turnId: string; readonly original: string; readonly modified: string; readonly hunks: readonly ReviewHunk[] }
	| { readonly kind: 'review'; readonly sessionId: string; readonly turnId: string; readonly warning: string; readonly detail: string; readonly otherFiles: number }
	| { readonly kind: 'warning'; readonly message: string }
	| { readonly kind: 'unchanged' }
	| { readonly kind: 'cancelled' }
	| { readonly kind: 'failed'; readonly message: string };

export interface IClaudeInlineEditService {
	readonly _serviceBrand: undefined;
	run(request: InlineEditRunRequest): Promise<InlineEditOutcome>;
	cancel(): Promise<void>;
}

/** A cursor with no selection targets the whole line. */
export function resolveInlineSelection(text: string, startLine: number, startColumn: number, endLine: number, endColumn: number): InlineSelection {
	const lines = normalizeNewlines(text).split('\n');
	let startL = clampLine(startLine, lines.length);
	let endL = clampLine(endLine, lines.length);
	let startC = startColumn;
	let endC = endColumn;
	if (startL > endL || (startL === endL && startC > endC)) {
		const swapL = startL;
		const swapC = startC;
		startL = endL;
		startC = endC;
		endL = swapL;
		endC = swapC;
	}
	if (startL === endL && startC === endC) {
		const line = lines[startL - 1] ?? '';
		return { startLine: startL, startColumn: 1, endLine: startL, endColumn: line.length + 1, text: line };
	}
	return {
		startLine: startL,
		startColumn: startC,
		endLine: endL,
		endColumn: endC,
		text: sliceSelection(lines, startL, startC, endL, endC),
	};
}

/** File text around the selection, capped. Far lines stay out of the prompt. */
export function nearbyContext(text: string, startLine: number, endLine: number): string {
	const lines = normalizeNewlines(text).split('\n');
	const from = Math.max(1, startLine - INLINE_NEARBY_LINES);
	const to = Math.min(lines.length, endLine + INLINE_NEARBY_LINES);
	return lines.slice(from - 1, to).join('\n');
}

/**
 * Bounded inline prompt. File text is context. The instruction is the only
 * user request, and Claude is told to edit with its tools.
 */
export function compileInlineEditPrompt(input: { readonly relativePath: string; readonly languageId: string; readonly text: string; readonly selection: InlineSelection; readonly instruction: string }): string {
	const nearby = clipText(nearbyContext(input.text, input.selection.startLine, input.selection.endLine));
	const selected = clipText(input.selection.text);
	return [
		'<task>Modify only the target selection unless required for correctness. Apply the change with your editing tools. Do not return the replacement as prose.</task>',
		`<file path="${escapeAttr(input.relativePath)}" language="${escapeAttr(input.languageId)}">`,
		escapeBody(nearby.text),
		'</file>',
		`<selection start="${input.selection.startLine}:${input.selection.startColumn}" end="${input.selection.endLine}:${input.selection.endColumn}">`,
		escapeBody(selected.text),
		'</selection>',
		'<instruction>',
		escapeBody(input.instruction.trim()),
		'</instruction>',
	].join('\n');
}

export type InlineDecision =
	| { readonly kind: 'unchanged' }
	| { readonly kind: 'inline'; readonly file: InlineFileSnapshot }
	| { readonly kind: 'review'; readonly warning: string; readonly detail: string; readonly otherFiles: number; readonly files: readonly InlineFileSnapshot[] }
	| { readonly kind: 'warning'; readonly message: string };

/**
 * One hunk in the target file stays in the editor. Another file, a write we
 * could not read, or more than one hunk goes to the full review.
 */
export function decideInlineEdit(target: URI, files: readonly InlineFileSnapshot[], unread: readonly URI[]): InlineDecision {
	const changed = files.filter(file => file.hunks.length > 0);
	const targetFile = changed.find(file => extUriBiasedIgnorePathCase.isEqual(file.uri, target));
	const others = changed.filter(file => !extUriBiasedIgnorePathCase.isEqual(file.uri, target));
	const otherFiles = others.length + unread.length;
	if (changed.length === 0 && unread.length === 0) {
		return { kind: 'unchanged' };
	}
	if (otherFiles === 0 && targetFile && targetFile.hunks.length === 1) {
		return { kind: 'inline', file: targetFile };
	}
	if (changed.length === 0) {
		const listed = unread.map(fileLabel).join(', ');
		return {
			kind: 'warning',
			message: localize('claudeInlineUnreadOnly', "Could not read the changed file to review it: {0}", listed),
		};
	}
	const unreadNote = unread.length > 0
		? localize('claudeInlineUnreadPaths', "Could not read: {0}", unread.map(fileLabel).join(', '))
		: undefined;
	const detail = unreadNote ?? localize('claudeInlineReviewMove', "Moved to the full review so nothing changes without you seeing it.");
	if (otherFiles > 0) {
		const warning = otherFiles === 1
			? localize('claudeInlineOtherFile', "This edit also changed 1 other file")
			: localize('claudeInlineOtherFiles', "This edit also changed {0} other files", otherFiles);
		return { kind: 'review', warning, detail, otherFiles, files: changed };
	}
	return {
		kind: 'review',
		warning: localize('claudeInlineRegions', "This edit spans multiple regions"),
		detail,
		otherFiles: 0,
		files: changed,
	};
}

/**
 * The files a hand-off review shows. On a follow-up the target file is
 * reviewed against the text from before the first edit, so the review can
 * undo that edit too, even when the follow-up itself only changed other files.
 */
function reviewFiles(request: InlineEditRunRequest, files: readonly InlineFileSnapshot[], modified: string): ReviewFileText[] {
	const texts: ReviewFileText[] = files.map(file => ({ uri: file.uri, originalText: file.originalText, modifiedText: file.modifiedText, existed: file.existed }));
	const baseline = request.baseline;
	if (baseline === undefined) {
		return texts;
	}
	const index = texts.findIndex(file => extUriBiasedIgnorePathCase.isEqual(file.uri, request.uri));
	if (index >= 0) {
		texts[index] = { ...texts[index], originalText: baseline };
	} else if (normalizeNewlines(modified) !== normalizeNewlines(baseline)) {
		texts.unshift({ uri: request.uri, originalText: baseline, modifiedText: modified, existed: true });
	}
	return texts;
}

/**
 * The instruction for a follow-up on an edit already in the file. Earlier
 * requests are context; the newest one is the change to make now.
 */
export function followUpInstruction(previous: readonly string[], next: string): string {
	const asked = previous.map(text => text.trim()).filter(text => text.length > 0);
	if (asked.length === 0) {
		return next.trim();
	}
	return [...asked.map(text => `Already applied: ${text}`), `Now: ${next.trim()}`].join('\n');
}

/**
 * The Agent draft for an inline edit sent from its card: the file and lines,
 * that the edit waits for review, and each instruction asked so far. A typed
 * follow-up goes after it; the changed lines go along as a selection chip.
 */
export function inlineAgentDraft(file: string, lines: { readonly startLine: number; readonly endLine: number }, asked: readonly string[]): string {
	const where = lines.startLine === lines.endLine
		? localize('claudeInlineAgentLine', "{0}, line {1}", file, lines.startLine)
		: localize('claudeInlineAgentLines', "{0}, lines {1}-{2}", file, lines.startLine, lines.endLine);
	const parts = [localize('claudeInlineAgentIntro', "Inline edit in {0}, not accepted yet.", where)];
	for (const text of asked.map(item => item.trim()).filter(item => item.length > 0)) {
		parts.push(localize('claudeInlineAgentAsked', "Asked: {0}", text));
	}
	// The blank line leaves the cursor ready for the follow-up.
	return `${parts.join('\n')}\n\n`;
}

/** A hand-off added to a composer draft: after what is already there, one blank line apart, so typed text is never lost. */
export function appendAgentDraft(draft: string, text: string): string {
	const kept = draft.trimEnd();
	return kept ? `${kept}\n\n${text}` : text;
}

/** The lines a follow-up targets in the edited text: the first changed line to the last one. */
export function followUpLines(hunks: readonly ReviewHunk[], lineCount: number): { readonly startLine: number; readonly endLine: number } | undefined {
	if (hunks.length === 0) {
		return undefined;
	}
	let start = Number.MAX_SAFE_INTEGER;
	let end = 0;
	for (const hunk of hunks) {
		start = Math.min(start, hunk.modifiedStart);
		end = Math.max(end, hunk.modifiedStart + Math.max(hunk.modifiedLength, 1) - 1);
	}
	const last = Math.max(lineCount, 1);
	const startLine = Math.min(Math.max(start, 1), last);
	return { startLine, endLine: Math.min(Math.max(end, startLine), last) };
}

/** Closes the undo group so the accepted edit is one Ctrl/Cmd+Z. */
export function acceptInlineEdit(model: ITextModel): void {
	model.pushStackElement();
}

/**
 * Restores the pre-edit text inside undo stops. A later undo brings the edit
 * back. A mismatch leaves the model alone.
 */
export function rejectInlineEdit(model: ITextModel, original: string, modified: string): void {
	const current = model.getValue(EndOfLinePreference.LF);
	if (normalizeNewlines(current) !== normalizeNewlines(modified)) {
		throw new ReviewConflictError();
	}
	const text = toModelEol(normalizeNewlines(original), model);
	model.pushStackElement();
	model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
	model.pushStackElement();
}

/**
 * Restores the buffer, then asks `save` to write that text. `save` runs only
 * after the buffer matches the snapshot, so a conflict never touches disk.
 */
export async function rejectInlineEditAndSave(model: ITextModel, original: string, modified: string, save: (uri: URI, text: string) => Promise<void>): Promise<void> {
	rejectInlineEdit(model, original, modified);
	await save(model.uri, model.getValue(EndOfLinePreference.LF));
}

export function uriFromRecord(value: string): URI {
	return value.includes('://') ? URI.parse(value) : URI.file(value);
}

type TurnEnd = 'running' | 'complete' | 'failed' | 'stopped';

/** What a cell edit asks: the replacement for the selected code, in one fenced block. */
export function cellEditQuestion(instruction: string): string {
	return [
		'Rewrite the code above as the request below asks. Do not edit any file: the editor puts your reply in place of that code.',
		'Reply with only the new code in one fenced code block, with no explanation. Keep the indentation of the code it replaces.',
		'',
		instruction.trim(),
	].join('\n');
}

/** The code in the first fenced block of a reply. Undefined when the reply has none. */
export function cellEditReplacement(answer: string): string | undefined {
	const match = /^(?<fence>`{3,}|~{3,})[^\n]*\n(?<code>[\s\S]*?)\n?^\k<fence>[ \t]*$/m.exec(normalizeNewlines(answer));
	return match?.groups?.code;
}

/** The text with the selection replaced. Lines and columns are 1-based. */
export function replaceInlineSelection(text: string, selection: InlineSelection, replacement: string): string {
	const lines = normalizeNewlines(text).split('\n');
	const before = [...lines.slice(0, selection.startLine - 1), (lines[selection.startLine - 1] ?? '').slice(0, selection.startColumn - 1)].join('\n');
	const after = [(lines[selection.endLine - 1] ?? '').slice(selection.endColumn - 1), ...lines.slice(selection.endLine)].join('\n');
	return before + normalizeNewlines(replacement) + after;
}

export class ClaudeInlineEditService extends Disposable implements IClaudeInlineEditService {
	declare readonly _serviceBrand: undefined;

	private readonly _waits = this._register(new DisposableStore());
	private readonly _waiters = new Map<string, (status: TurnEnd) => void>();
	private _activeSession: string | undefined;
	private _activeCellQuestion: string | undefined;

	constructor(
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeCheckpointService private readonly _checkpoints: IClaudeCheckpointService,
		@IClaudeReviewService private readonly _review: IClaudeReviewService,
		@IClaudeKlawlyHooksService private readonly _hooks: IClaudeKlawlyHooksService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
	) {
		super();
		this._register(this._agent.onDidChangeSession(event => {
			if (event.reason === 'closed') {
				this.finishClosedWaits();
			}
		}));
	}

	override dispose(): void {
		this.finishAllWaits('stopped');
		super.dispose();
	}

	async cancel(): Promise<void> {
		const question = this._activeCellQuestion;
		if (question) {
			await this._runtime.cancelSideQuestion?.(question);
			return;
		}
		const sessionId = this._activeSession;
		if (!sessionId) {
			return;
		}
		await this._agent.stop(sessionId);
	}

	async run(request: InlineEditRunRequest): Promise<InlineEditOutcome> {
		const instruction = request.instruction.trim();
		if (!instruction) {
			return { kind: 'failed', message: localize('claudeInlineEmpty', "Write an edit instruction first.") };
		}
		const hook = await this._hooks.checkInlineEdit(request.uri, 'before', instruction);
		if (!hook.allowed) {
			return {
				kind: 'failed',
				message: hook.reason
					? localize('claudeInlineHookDeniedReason', "A KlawlyInlineEdit hook blocked this edit: {0}", hook.reason)
					: localize('claudeInlineHookDenied', "A KlawlyInlineEdit hook blocked this edit."),
			};
		}
		if (request.uri.scheme === Schemas.vscodeNotebookCell && request.model) {
			return this.runInCell(request, request.model, instruction);
		}
		const session = this.editSession();
		this._activeSession = session.id;
		try {
			const prompt = compileInlineEditPrompt({
				relativePath: request.relativePath,
				languageId: request.languageId,
				text: request.text,
				selection: request.selection,
				instruction,
			});
			const known = new Set(this._agent.getViewState(session.id).turns.map(turn => turn.id));
			await this._agent.submit(session.id, instruction, request.cwd, {
				compiled: prompt,
				label: instruction,
				keepDraft: true,
				checkpointBuffers: request.checkpointPath ? [{ path: request.checkpointPath, text: request.text }] : undefined,
				// The agent service applies `claude.inlineEdit.model` to this turn.
				origin: 'inline-edit',
			});
			const turn = this._agent.getViewState(session.id).turns.find(item => !known.has(item.id));
			if (!turn) {
				return { kind: 'failed', message: localize('claudeInlineNoTurn', "The edit did not start.") };
			}
			const status = await this.waitForTurn(session.id, turn.id);
			const modified = await this.resolveModified(request, session.id, turn.id);
			const same = normalizeNewlines(modified) === normalizeNewlines(request.text);
			if (status === 'stopped' && same) {
				return { kind: 'cancelled' };
			}
			if (status === 'failed' && same) {
				const failed = this._agent.getViewState(session.id).turns.find(item => item.id === turn.id);
				return { kind: 'failed', message: failed?.failure?.message || localize('claudeInlineFailed', "The edit failed before it changed the file.") };
			}
			const collected = await this.collect(request, session.id, turn.id, modified);
			const decision = decideInlineEdit(request.uri, collected.files, collected.unread);
			if (decision.kind === 'unchanged') {
				return { kind: 'unchanged' };
			}
			if (decision.kind === 'warning') {
				return { kind: 'warning', message: decision.message };
			}
			// The edit is in the file now. Like PostToolUse, the after hook reports on it and cannot undo it.
			void this._hooks.checkInlineEdit(request.uri, 'after', instruction);
			if (decision.kind === 'review') {
				this._review.replaceTurn(session.id, turn.id, reviewFiles(request, decision.files, modified));
				this._review.focus(session.id, turn.id);
				return { kind: 'review', sessionId: session.id, turnId: turn.id, warning: decision.warning, detail: decision.detail, otherFiles: decision.otherFiles };
			}
			return {
				kind: 'inline',
				sessionId: session.id,
				turnId: turn.id,
				original: decision.file.originalText,
				modified: decision.file.modifiedText,
				hunks: decision.file.hunks,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { kind: 'failed', message };
		} finally {
			if (this._activeSession === session.id) {
				this._activeSession = undefined;
			}
		}
	}

	/**
	 * A notebook cell lives inside the notebook file, so Claude's file tools
	 * cannot edit it. Claude answers with the new code from read-only tools,
	 * and the edit goes into the cell's model, where Reject and undo work as
	 * for a file.
	 */
	private async runInCell(request: InlineEditRunRequest, model: ITextModel, instruction: string): Promise<InlineEditOutcome> {
		if (!this._runtime.askSideQuestion) {
			return { kind: 'failed', message: localize('claudeInlineCellUnsupported', "This Claude runtime cannot edit notebook cells.") };
		}
		if (!request.cwd) {
			return { kind: 'failed', message: localize('claudeInlineCellNoFolder', "Open the notebook's folder to edit its cells with Claude.") };
		}
		const id = generateUuid();
		this._activeCellQuestion = id;
		let result;
		try {
			result = await this._runtime.askSideQuestion({
				id,
				question: cellEditQuestion(instruction),
				cwd: request.cwd,
				selection: {
					path: request.relativePath,
					languageId: request.languageId,
					startLine: request.selection.startLine,
					endLine: request.selection.endLine,
					text: request.selection.text,
				},
			});
		} catch (error) {
			return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
		} finally {
			if (this._activeCellQuestion === id) {
				this._activeCellQuestion = undefined;
			}
		}
		if (result.kind === 'cancelled') {
			return { kind: 'cancelled' };
		}
		if (result.kind === 'failed') {
			return { kind: 'failed', message: result.message };
		}
		const replacement = cellEditReplacement(result.text);
		if (replacement === undefined) {
			return { kind: 'failed', message: localize('claudeInlineCellNoCode', "Claude did not reply with code for this cell.") };
		}
		if (model.isDisposed() || normalizeNewlines(model.getValue(EndOfLinePreference.LF)) !== normalizeNewlines(request.text)) {
			return { kind: 'warning', message: localize('claudeInlineCellChanged', "The cell changed while Claude worked, so the edit was not applied.") };
		}
		const modified = replaceInlineSelection(request.text, request.selection, replacement);
		const hunks = collectReviewHunks(request.uri, request.text, modified);
		if (hunks.length === 0) {
			return { kind: 'unchanged' };
		}
		model.pushStackElement();
		model.pushEditOperations([], [{ range: model.getFullModelRange(), text: toModelEol(modified, model) }], () => null);
		model.pushStackElement();
		void this._hooks.checkInlineEdit(request.uri, 'after', instruction);
		return { kind: 'inline', sessionId: '', turnId: id, original: request.text, modified, hunks };
	}

	/**
	 * A running chat turn stays the chat's. The edit gets its own session and
	 * the chat stays selected. An idle chat session can host the edit.
	 */
	private editSession() {
		const current = this._agent.getCurrentSession();
		const busy = current ? this._agent.getViewState(current.id).turns.some(turn => turn.status === 'running') : false;
		if (!current || busy) {
			const dedicated = this._agent.createSession();
			if (current) {
				this._agent.selectSession(current.id);
			}
			return dedicated;
		}
		return current;
	}

	private async resolveModified(request: InlineEditRunRequest, sessionId: string, turnId: string): Promise<string> {
		const original = normalizeNewlines(request.text);
		if (normalizeNewlines(request.readLive()) !== original) {
			return request.readLive();
		}
		if (request.waitForText) {
			await request.waitForText();
			if (normalizeNewlines(request.readLive()) !== original) {
				return request.readLive();
			}
		}
		const after = await this.targetAfterText(request, sessionId, turnId);
		if (after !== undefined && normalizeNewlines(after) !== original) {
			return after;
		}
		return request.readLive();
	}

	private async targetAfterText(request: InlineEditRunRequest, sessionId: string, turnId: string): Promise<string | undefined> {
		const originals = await this._checkpoints.readCheckpointOriginals(sessionId, turnId);
		for (const original of originals) {
			if (!isReviewBaseline(original) || original.afterText === undefined) {
				continue;
			}
			if (extUriBiasedIgnorePathCase.isEqual(uriFromRecord(original.uri), request.uri)) {
				return original.afterText;
			}
		}
		return undefined;
	}

	private waitForTurn(sessionId: string, turnId: string): Promise<TurnEnd> {
		const read = () => this._agent.getViewState(sessionId).turns.find(turn => turn.id === turnId)?.status;
		const current = read();
		if (current && current !== 'running') {
			return Promise.resolve(current);
		}
		if (this._store.isDisposed || !this.sessionOpen(sessionId)) {
			return Promise.resolve('stopped');
		}
		return new Promise(resolve => {
			let settled = false;
			let listener: IDisposable = Disposable.None;
			const finish = (status: TurnEnd) => {
				if (settled) {
					return;
				}
				settled = true;
				this._waiters.delete(sessionId);
				listener.dispose();
				resolve(status);
			};
			listener = this._agent.onDidChangeViewState(event => {
				if (event.sessionId !== sessionId) {
					return;
				}
				const status = read();
				if (status && status !== 'running') {
					finish(status);
				}
			});
			this._waits.add(listener);
			this._waiters.set(sessionId, finish);
			const status = read();
			if (status && status !== 'running') {
				finish(status);
			} else if (this._store.isDisposed || !this.sessionOpen(sessionId)) {
				finish('stopped');
			}
		});
	}

	private sessionOpen(sessionId: string): boolean {
		return this._agent.getSessions().some(session => session.id === sessionId);
	}

	private finishClosedWaits(): void {
		const open = new Set(this._agent.getSessions().map(session => session.id));
		for (const sessionId of [...this._waiters.keys()]) {
			if (!open.has(sessionId)) {
				this._waiters.get(sessionId)?.('stopped');
			}
		}
	}

	private finishAllWaits(status: TurnEnd): void {
		for (const sessionId of [...this._waiters.keys()]) {
			this._waiters.get(sessionId)?.(status);
		}
	}

	private async collect(request: InlineEditRunRequest, sessionId: string, turnId: string, modified: string): Promise<{ files: InlineFileSnapshot[]; unread: URI[] }> {
		const files: InlineFileSnapshot[] = [{
			uri: request.uri,
			originalText: request.text,
			modifiedText: modified,
			existed: true,
			hunks: collectReviewHunks(request.uri, request.text, modified),
		}];
		const seen: URI[] = [request.uri];
		const known = (uri: URI) => seen.some(item => extUriBiasedIgnorePathCase.isEqual(item, uri));
		const originals = await this._checkpoints.readCheckpointOriginals(sessionId, turnId);
		for (const original of originals) {
			if (!isReviewBaseline(original)) {
				continue;
			}
			const uri = uriFromRecord(original.uri);
			if (known(uri)) {
				continue;
			}
			if (original.afterText === undefined) {
				continue;
			}
			seen.push(uri);
			files.push({
				uri,
				originalText: original.text,
				modifiedText: original.afterText,
				existed: original.existed,
				hunks: collectReviewHunks(uri, original.text, original.afterText),
			});
		}
		const unread: URI[] = [];
		const turn = this._agent.getViewState(sessionId).turns.find(item => item.id === turnId);
		for (const raw of turn?.changedFiles ?? []) {
			const uri = uriFromRecord(raw);
			if (known(uri)) {
				continue;
			}
			seen.push(uri);
			unread.push(uri);
		}
		return { files, unread };
	}
}

function fileLabel(uri: URI): string {
	return uri.fsPath || uri.path;
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

function sliceSelection(lines: readonly string[], startLine: number, startColumn: number, endLine: number, endColumn: number): string {
	if (startLine === endLine) {
		return (lines[startLine - 1] ?? '').slice(startColumn - 1, endColumn - 1);
	}
	const parts = [(lines[startLine - 1] ?? '').slice(startColumn - 1)];
	for (let line = startLine + 1; line < endLine; line++) {
		parts.push(lines[line - 1] ?? '');
	}
	parts.push((lines[endLine - 1] ?? '').slice(0, endColumn - 1));
	return parts.join('\n');
}

function normalizeNewlines(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function toModelEol(text: string, model: ITextModel): string {
	const eol = model.getEOL();
	return eol === '\n' ? text : text.replace(/\n/g, eol);
}
