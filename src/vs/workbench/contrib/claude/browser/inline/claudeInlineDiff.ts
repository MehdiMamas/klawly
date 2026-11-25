/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICodeEditor, IViewZone, IViewZoneChangeAccessor } from '../../../../../editor/browser/editorBrowser.js';
import { LineSource, renderLines, RenderOptions } from '../../../../../editor/browser/widget/diffEditor/components/diffEditorViewZones/renderLines.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IEditorDecorationsCollection } from '../../../../../editor/common/editorCommon.js';
import { EndOfLinePreference, IModelDeltaDecoration, ITextModel } from '../../../../../editor/common/model.js';
import { LineTokens } from '../../../../../editor/common/tokens/lineTokens.js';
import { localize } from '../../../../../nls.js';
import { acceptInlineEdit, rejectInlineEditAndSave } from '../../../../services/claude/common/claudeInlineEdit.js';
import { lastChangedLine, ReviewConflictError, ReviewHunk } from '../../../../services/claude/common/claudeReview.js';

/**
 * In-editor diff for one local edit. Removed lines are view zones. Inserted
 * lines stay in the model so the editor keeps their highlighting.
 */
export class ClaudeInlineDiff extends Disposable {
	private readonly _zones: string[] = [];
	private readonly _decorations: IEditorDecorationsCollection;
	private readonly _ui = this._register(new DisposableStore());
	private _hunks: readonly ReviewHunk[] = [];
	private _cursor = 0;
	private _original = '';
	private _modified = '';
	private _onAccept: (() => void) | undefined;
	private _onReject: (() => void) | undefined;
	private _onConflict: ((message: string) => void) | undefined;
	private _onSaveError: ((message: string) => void) | undefined;
	private _save: ((uri: URI, text: string) => Promise<void>) | undefined;
	private _actions = true;

	constructor(private readonly _editor: ICodeEditor) {
		super();
		this._decorations = _editor.createDecorationsCollection();
	}

	get hunkCount(): number {
		return this._hunks.length;
	}

	get cursor(): number {
		return this._cursor;
	}

	/** The text from before the edit, which Reject restores. */
	get original(): string {
		return this._original;
	}

	/** The text the edit produced, which the hunks describe. */
	get modified(): string {
		return this._modified;
	}

	get hunks(): readonly ReviewHunk[] {
		return this._hunks;
	}

	show(original: string, modified: string, hunks: readonly ReviewHunk[], handlers: { onAccept: () => void; onReject: () => void; onConflict: (message: string) => void; onSaveError?: (message: string) => void; save?: (uri: URI, text: string) => Promise<void>; actions?: boolean }): void {
		this.clear();
		this._original = original;
		this._modified = modified;
		this._hunks = hunks;
		this._cursor = 0;
		this._onAccept = handlers.onAccept;
		this._onReject = handlers.onReject;
		this._onConflict = handlers.onConflict;
		this._onSaveError = handlers.onSaveError;
		this._save = handlers.save;
		this._actions = handlers.actions ?? true;
		this.paint();
		this.reveal();
	}

	showHandoff(warning: string, detail: string, onOpen: () => void): void {
		this.clear();
		const banner = this.banner(warning, detail, onOpen);
		const line = this._editor.getPosition()?.lineNumber ?? 1;
		this.addZone({
			afterLineNumber: Math.max(0, line - 1),
			heightInLines: 4,
			suppressMouseDown: true,
			domNode: banner,
		});
	}

	next(): number {
		if (this._hunks.length === 0) {
			return 0;
		}
		this._cursor = (this._cursor + 1) % this._hunks.length;
		this.reveal();
		return this._cursor;
	}

	previous(): number {
		if (this._hunks.length === 0) {
			return 0;
		}
		this._cursor = (this._cursor - 1 + this._hunks.length) % this._hunks.length;
		this.reveal();
		return this._cursor;
	}

	accept(): void {
		const model = this._editor.getModel();
		if (!model || this._hunks.length === 0) {
			return;
		}
		acceptInlineEdit(model);
		this._onAccept?.();
		this.clear();
	}

	/**
	 * Restores the snapshot and saves it. A failed save leaves the diff up.
	 * The buffer then matches the snapshot, so the next Reject retries the save
	 * and clears the diff only after that save succeeds.
	 */
	async reject(): Promise<'done' | 'conflict' | 'saveFailed'> {
		const model = this._editor.getModel();
		if (!model || this._hunks.length === 0) {
			return 'done';
		}
		const save = this._save ?? (async () => undefined);
		try {
			if (sameText(model.getValue(EndOfLinePreference.LF), this._original)) {
				await save(model.uri, model.getValue(EndOfLinePreference.LF));
			} else {
				await rejectInlineEditAndSave(model, this._original, this._modified, save);
			}
		} catch (error) {
			if (error instanceof ReviewConflictError) {
				this._onConflict?.(error.message);
				return 'conflict';
			}
			this._onSaveError?.(rejectSaveFailedMessage(error));
			return 'saveFailed';
		}
		this._onReject?.();
		this.clear();
		return 'done';
	}

	clear(): void {
		this._ui.clear();
		this._editor.changeViewZones(accessor => {
			for (const id of this._zones) {
				accessor.removeZone(id);
			}
		});
		this._zones.length = 0;
		this._decorations.clear();
		this._hunks = [];
		this._cursor = 0;
		this._onAccept = undefined;
		this._onReject = undefined;
		this._onConflict = undefined;
		this._onSaveError = undefined;
		this._save = undefined;
		this._actions = true;
	}

	override dispose(): void {
		this.clear();
		super.dispose();
	}

	private paint(): void {
		this._ui.clear();
		const model = this._editor.getModel();
		this._editor.changeViewZones(accessor => {
			for (const id of this._zones) {
				accessor.removeZone(id);
			}
			this._zones.length = 0;
			if (!model) {
				return;
			}
			for (const hunk of this._hunks) {
				const removed = removedLines(hunk.originalText);
				if (removed.length === 0) {
					continue;
				}
				this.addZone({
					afterLineNumber: Math.max(0, hunk.currentRange.startLineNumber - 1),
					suppressMouseDown: true,
					...deletedZone(this._editor, model, hunk.currentRange.startLineNumber, removed),
				}, accessor);
			}
			if (this._actions && this._hunks.length > 0) {
				const last = this._hunks[this._hunks.length - 1];
				const after = lastChangedLine(last.currentRange);
				this.addZone({
					afterLineNumber: Math.min(after, model.getLineCount()),
					heightInLines: 2,
					suppressMouseDown: true,
					domNode: this.toolbar(),
				}, accessor);
			}
		});
		this._decorations.set(model ? insertedDecorations(model, this._hunks) : []);
	}

	private addZone(zone: IViewZone, accessor?: IViewZoneChangeAccessor): void {
		const place = (target: IViewZoneChangeAccessor) => {
			this._zones.push(target.addZone(zone));
		};
		if (accessor) {
			place(accessor);
			return;
		}
		this._editor.changeViewZones(place);
	}

	private reveal(): void {
		const hunk = this._hunks[this._cursor];
		if (!hunk) {
			return;
		}
		this._editor.revealLine(hunk.currentRange.startLineNumber);
	}

	private toolbar(): HTMLElement {
		const bar = $('div.claude-hunk-actions');
		bar.setAttribute('role', 'toolbar');
		bar.setAttribute('aria-label', localize('claudeInlineReviewToolbar', "Review inline edit"));
		const reject = append(bar, $<HTMLButtonElement>('button'));
		reject.type = 'button';
		append(reject, $(ThemeIcon.asCSSSelector(Codicon.discard)));
		reject.append(localize('claudeInlineReject', "Reject"));
		this._ui.add(addDisposableListener(reject, EventType.CLICK, event => {
			event.preventDefault();
			void this.reject().catch(error => {
				this._onSaveError?.(rejectSaveFailedMessage(error));
			});
		}));
		const accept = append(bar, $<HTMLButtonElement>('button.accept'));
		accept.type = 'button';
		append(accept, $(ThemeIcon.asCSSSelector(Codicon.check)));
		accept.append(localize('claudeInlineAccept', "Accept"));
		this._ui.add(addDisposableListener(accept, EventType.CLICK, event => {
			event.preventDefault();
			this.accept();
		}));
		return bar;
	}

	private banner(warning: string, detail: string, onOpen: () => void): HTMLElement {
		const banner = $('div.claude-banner.is-warning.claude-inline-banner');
		append(banner, $(ThemeIcon.asCSSSelector(Codicon.warning)));
		const body = append(banner, $('div.body'));
		const title = append(body, $('div.title'));
		title.textContent = warning;
		const desc = append(body, $('div.desc'));
		desc.textContent = detail;
		const actions = append(body, $('div.actions'));
		const open = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.is-primary'));
		open.type = 'button';
		open.textContent = localize('claudeInlineOpenReview', "Open review");
		this._ui.add(addDisposableListener(open, EventType.CLICK, event => {
			event.preventDefault();
			onOpen();
		}));
		return banner;
	}
}

/**
 * Removed lines as the editor draws its own: full size, with syntax colors (tokenized as if they
 * still stood at `lineNumber`), on a red row, and a minus for each row in the gutter.
 */
function deletedZone(editor: ICodeEditor, model: ITextModel, lineNumber: number, lines: string[]): Pick<IViewZone, 'domNode' | 'marginDomNode' | 'heightInLines'> {
	const options = RenderOptions.fromEditor(editor);
	const at = clamp(lineNumber, 1, model.getLineCount());
	const tokens = model.tokenization.tokenizeLinesAt(at, lines) ?? lines.map(line => LineTokens.createEmpty(line, model.tokenization.getLineTokens(at).languageIdCodec));
	const domNode = $('div.claude-inline-deleted.view-lines');
	domNode.setAttribute('aria-label', localize('claudeInlineRemoved', "Removed lines"));
	const result = renderLines(new LineSource(tokens), options, [], domNode, true);
	const marginDomNode = $('div.claude-inline-deleted-margin');
	marginDomNode.setAttribute('aria-hidden', 'true');
	for (const count of result.viewLineCounts) {
		const row = append(marginDomNode, $('div.claude-inline-deleted-sign'));
		row.textContent = '\u2212';
		row.style.height = `${count * options.lineHeight}px`;
		row.style.lineHeight = `${options.lineHeight}px`;
	}
	return { domNode, marginDomNode, heightInLines: result.heightInLines };
}

function rejectSaveFailedMessage(error: unknown): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	return localize('claudeInlineRejectSaveFailed', "Could not save the restored file. Reject again to retry.");
}

function sameText(left: string, right: string): boolean {
	const normalize = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	return normalize(left) === normalize(right);
}

function removedLines(text: string): string[] {
	if (!text) {
		return [];
	}
	const parts = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
	if (parts.length > 1 && parts[parts.length - 1] === '') {
		parts.pop();
	}
	return parts;
}

function insertedDecorations(model: ITextModel, hunks: readonly ReviewHunk[]): IModelDeltaDecoration[] {
	const decorations: IModelDeltaDecoration[] = [];
	for (const hunk of hunks) {
		if (hunk.modifiedLength === 0) {
			continue;
		}
		const start = clamp(hunk.currentRange.startLineNumber, 1, model.getLineCount());
		const end = clamp(lastChangedLine(hunk.currentRange), start, model.getLineCount());
		decorations.push({
			range: new Range(start, 1, end, 1),
			options: {
				description: 'claude-inline-inserted',
				isWholeLine: true,
				className: 'claude-inline-inserted',
				marginClassName: 'claude-inline-inserted-margin',
			},
		});
	}
	return decorations;
}

function clamp(value: number, min: number, max: number): number {
	if (value < min) {
		return min;
	}
	if (value > max) {
		return max;
	}
	return value;
}
