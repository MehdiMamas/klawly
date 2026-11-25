/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/claude.css';
import { $, addDisposableListener, append, clearNode, DisposableResizeObserver, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { decodeKeybinding } from '../../../../../base/common/keybindings.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { OS } from '../../../../../base/common/platform.js';
import { basename, dirname, relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ICodeEditor, IViewZone } from '../../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../../editor/browser/editorExtensions.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import { IEditorContribution } from '../../../../../editor/common/editorCommon.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { EndOfLinePreference, ITextModel } from '../../../../../editor/common/model.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ClaudeModelInfo, IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { CLAUDE_INLINE_EDIT_MODEL_SETTING, CLAUDE_INLINE_REJECT_ON_ESCAPE_SETTING, CLAUDE_MODELS_CUSTOM_SETTING, CLAUDE_MODELS_ENABLED_SETTING, readClaudeModelId } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { ContextAttachment } from '../../../../../platform/claude/common/claudeContext.js';
import { ClaudeSideQuestionResult } from '../../../../../platform/claude/common/claudeSideQuestion.js';
import { CLAUDE_DEFAULT_MODEL_ALIAS, claudeModelDisplayName, pickableClaudeModels, readClaudeModelIdList, resolveClaudeModel } from '../../../../../platform/claude/common/claudeModels.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight, KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { ATTRIBUTION_INLINE_SOURCE, ClaudeAcceptedSpan, IClaudeAttributionService, inlineAcceptedSpans } from '../../../../services/claude/common/claudeAttribution.js';
import { appendAgentDraft, followUpInstruction, followUpLines, IClaudeInlineEditService, inlineAgentDraft, INLINE_EDIT_KLAWLY_KEY, INLINE_EDIT_DEFAULT_KEY, resolveInlineSelection } from '../../../../services/claude/common/claudeInlineEdit.js';
import { collectReviewHunks, IClaudeReviewService, ReviewConflictError, ReviewHunk } from '../../../../services/claude/common/claudeReview.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { CLAUDE_AGENT_ENABLED, CLAUDE_KLAWLY_KEYMAP, CLAUDE_KLAWLY_KEY_WEIGHT, CLAUDE_DEFAULT_KEY_LABEL_WEIGHT, CLAUDE_DEFAULT_KEY_LABEL_WHEN } from '../../common/claudeContextKeys.js';
import { CLAUDE_AGENT_VIEW_ID, CLAUDE_INLINE_EDIT_COMMAND_ID, CLAUDE_MANAGE_MODELS_COMMAND_ID, KLAWLY_CATEGORY } from '../../common/claudeViews.js';
import { CellUri } from '../../../notebook/common/notebookCommon.js';
import { revealClaudeChat } from '../chat/claudeAgentEditorActions.js';
import { appendClaudeKbd } from '../chat/claudeKbd.js';
import { ClaudeModelMenu } from '../chat/claudeModelMenu.js';
import { CLAUDE_EDITOR_CONTEXT_GROUP } from '../claudeMenus.js';
import { CLAUDE_INLINE_ASK_KEY, ClaudeInlineAnswer, claudeInlineAnswerDraft, claudeInlineQuestionRequest } from './claudeInlineAsk.js';
import { ClaudeInlineDiff } from './claudeInlineDiff.js';

/** How long to wait for the editor model to pick up a disk edit. */
const INLINE_MODEL_WAIT_MS = 250;

export const CLAUDE_INLINE_REVIEWING = new RawContextKey<boolean>('klawly.inlineEdit.reviewing', false, localize('claudeInlineReviewing', "Whether an inline edit diff is waiting for accept or reject"));

const START_ID = CLAUDE_INLINE_EDIT_COMMAND_ID;
const ACCEPT_ID = 'klawly.inlineEdit.accept';
const REJECT_ID = 'klawly.inlineEdit.reject';
const NEXT_ID = 'klawly.inlineEdit.nextHunk';
const PREVIOUS_ID = 'klawly.inlineEdit.previousHunk';

/**
 * Editor contribution for a local edit. The prompt is a view zone above the
 * selection. A single hunk stays in the editor; anything wider opens review.
 */
export class ClaudeInlineController extends Disposable implements IEditorContribution {
	static readonly ID = 'editor.contrib.claudeInline';

	private static _current: ClaudeInlineController | undefined;

	static current(): ClaudeInlineController | undefined {
		return ClaudeInlineController._current;
	}

	private readonly _reviewing: IContextKey<boolean>;
	private readonly _diff: ClaudeInlineDiff;
	private _widget: ClaudeInlineWidget | undefined;
	/** The card kept above the diff while the edit waits for Reject or Accept. */
	private _card: ClaudeInlineWidget | undefined;
	private _busy = false;
	/** What was asked so far in this card, oldest first. A follow-up sends them as context. */
	private _asked: string[] = [];

	constructor(
		private readonly _editor: ICodeEditor,
		@IInstantiationService private readonly _instantiation: IInstantiationService,
		@IClaudeInlineEditService private readonly _inline: IClaudeInlineEditService,
		@IClaudeReviewService private readonly _review: IClaudeReviewService,
		@IViewsService private readonly _views: IViewsService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@INotificationService private readonly _notifications: INotificationService,
		@ITextFileService private readonly _textFiles: ITextFileService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IClaudeAttributionService private readonly _attribution: IClaudeAttributionService,
	) {
		super();
		this._reviewing = CLAUDE_INLINE_REVIEWING.bindTo(contextKeyService);
		this._diff = this._register(new ClaudeInlineDiff(this._editor));
		this._register(this._editor.onDidChangeModel(() => this.dismiss()));
	}

	/** Whether an edit is being asked for, running or waiting for review in this editor. */
	get active(): boolean {
		return this._busy || !!this._widget || !!this._card || !!this._reviewing.get();
	}

	async start(): Promise<void> {
		if (this._busy || this._widget || this._card) {
			return;
		}
		const model = this._editor.getModel();
		const position = this._editor.getPosition();
		if (!model || model.isDisposed() || !position) {
			return;
		}
		const selection = this._editor.getSelection();
		this._busy = true;
		ClaudeInlineController._current = this;
		this._asked = [];
		const widget = this._instantiation.createInstance(ClaudeInlineWidget, this._editor, selection);
		this._widget = widget;
		try {
			const instruction = await widget.prompt();
			if (!instruction || model.isDisposed()) {
				return;
			}
			const picked = selection ?? { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column };
			await this.runEdit(widget, model, picked, instruction, undefined);
		} finally {
			this.endRun(widget);
		}
	}

	/**
	 * Asks for a change on top of the edit under review. The new edit runs on
	 * the changed lines, and Reject still restores the text from before the first edit.
	 */
	async followUp(instruction: string): Promise<void> {
		const widget = this._card;
		const model = this._editor.getModel();
		const text = instruction.trim();
		if (this._busy || !widget || !model || model.isDisposed() || !text) {
			return;
		}
		const lines = followUpLines(this._diff.hunks, model.getLineCount());
		if (!lines) {
			return;
		}
		const baseline = this._diff.original;
		this._diff.clear();
		this._card = undefined;
		this._reviewing.set(false);
		this._busy = true;
		this._widget = widget;
		ClaudeInlineController._current = this;
		try {
			const picked = { startLineNumber: lines.startLine, startColumn: 1, endLineNumber: lines.endLine, endColumn: model.getLineMaxColumn(lines.endLine) };
			await this.runEdit(widget, model, picked, text, baseline);
		} finally {
			this.endRun(widget);
		}
	}

	/**
	 * Runs one edit and shows its diff under the card. A follow-up passes the
	 * text from before the first edit, so its diff and Reject go back that far.
	 */
	private async runEdit(widget: ClaudeInlineWidget, model: ITextModel, picked: IRange, instruction: string, baseline: string | undefined): Promise<void> {
		const startedClean = !this._textFiles.isDirty(model.uri);
		if (!startedClean && !await this.saveDirtyModel(model)) {
			this.restoreReview(widget, model, baseline);
			return;
		}
		if (model.isDisposed() || ClaudeInlineController._current !== this) {
			return;
		}
		const text = model.getValue(EndOfLinePreference.LF);
		const resolved = resolveInlineSelection(text, picked.startLineNumber, picked.startColumn, picked.endLineNumber, picked.endColumn);
		const { path: relative, cwd } = inlineFileContext(this._workspace, model.uri);
		widget.showProgress(basename(model.uri), () => {
			void this._inline.cancel();
		}, baseline === undefined ? undefined : instruction);
		const outcome = await this._inline.run({
			uri: model.uri,
			languageId: model.getLanguageId(),
			relativePath: relative,
			text,
			selection: resolved,
			instruction: followUpInstruction(this._asked, instruction),
			cwd: cwd ?? '',
			checkpointPath: model.uri.scheme === Schemas.file ? model.uri.fsPath : undefined,
			baseline,
			readLive: () => model.isDisposed() ? text : model.getValue(EndOfLinePreference.LF),
			waitForText: () => waitForModelText(model),
			model,
		});
		if (model.isDisposed() || ClaudeInlineController._current !== this) {
			return;
		}
		if (outcome.kind === 'inline') {
			const live = model.getValue(EndOfLinePreference.LF);
			if (startedClean || sameText(live, text)) {
				syncModel(model, outcome.modified);
			}
			this._asked.push(instruction);
			const original = baseline ?? outcome.original;
			const hunks = baseline === undefined ? outcome.hunks : collectReviewHunks(model.uri, baseline, outcome.modified);
			this.showReview(widget, original, outcome.modified, hunks, basename(model.uri));
			return;
		}
		if (outcome.kind === 'review') {
			this._diff.showHandoff(outcome.warning, outcome.detail, () => {
				void this.openReview(outcome.sessionId, outcome.turnId);
			});
			await this.openReview(outcome.sessionId, outcome.turnId);
			return;
		}
		if (outcome.kind === 'failed') {
			this._notifications.error(outcome.message);
		} else if (outcome.kind === 'warning') {
			this._notifications.warn(outcome.message);
		} else if (outcome.kind === 'unchanged') {
			this._notifications.info(localize('claudeInlineUnchanged', "The edit did not change this file."));
		}
		this.restoreReview(widget, model, baseline);
	}

	/** Puts the diff and the card's Reject and Accept back after a follow-up that changed nothing. */
	private restoreReview(widget: ClaudeInlineWidget, model: ITextModel, baseline: string | undefined): void {
		if (baseline === undefined || model.isDisposed()) {
			return;
		}
		const live = model.getValue(EndOfLinePreference.LF);
		const hunks = collectReviewHunks(model.uri, baseline, live);
		if (hunks.length === 0) {
			return;
		}
		this.showReview(widget, baseline, live, hunks, basename(model.uri));
	}

	private showReview(widget: ClaudeInlineWidget, original: string, modified: string, hunks: readonly ReviewHunk[], fileName: string): void {
		this._diff.show(original, modified, hunks, {
			onAccept: () => this.finishReview(),
			onReject: () => this.finishReview(),
			onConflict: message => {
				this._reviewing.set(false);
				this._notifications.warn(message);
			},
			onSaveError: message => {
				this._notifications.error(message);
			},
			save: (uri, value) => this.saveRestored(uri, value),
			// The card above the change holds Reject and Accept.
			actions: false,
		});
		widget.showResult(fileName, {
			accept: () => this.accept(),
			reject: () => void this.reject(),
			followUp: text => void this.followUp(text),
			handoff: () => this.handoff(),
		});
		this._card = widget;
		this._reviewing.set(true);
		this._editor.focus();
	}

	/** The file's path in its workspace folder, else its name. */
	private relativeName(model: ITextModel): string {
		return inlineFileContext(this._workspace, model.uri).path;
	}

	/** What Send to Agent hands over from the result card: the changed lines as a chip and a draft naming the edit. */
	private handoff(): ClaudeInlineHandoff | undefined {
		const model = this._editor.getModel();
		if (!model || model.isDisposed()) {
			return undefined;
		}
		const lines = followUpLines(this._diff.hunks, model.getLineCount());
		if (!lines) {
			return undefined;
		}
		const range = { startLineNumber: lines.startLine, startColumn: 1, endLineNumber: lines.endLine, endColumn: model.getLineMaxColumn(lines.endLine) };
		return {
			attachment: inlineAttachment(model, range),
			draft: inlineAgentDraft(this.relativeName(model), lines, this._asked),
		};
	}

	private endRun(widget: ClaudeInlineWidget): void {
		if (this._card !== widget) {
			widget.dispose();
		}
		if (this._widget === widget) {
			this._widget = undefined;
		}
		this._busy = false;
		if (ClaudeInlineController._current === this && !this._reviewing.get()) {
			ClaudeInlineController._current = undefined;
		}
	}

	accept(): void {
		const model = this._editor.getModel();
		const spans = model ? this.acceptedSpans(model) : [];
		this._diff.accept();
		if (model && spans.length > 0) {
			this._attribution.recordAccepted(model.uri, ATTRIBUTION_INLINE_SOURCE, model.getLinesContent(), spans);
		}
		this.finishReview();
	}

	/**
	 * The lines the edit wrote, read before the diff clears its hunks. When the buffer moved on since the diff was shown,
	 * the spans come from the text now, and a line counts only if it is one the edit wrote, so typing in the review stays yours.
	 */
	private acceptedSpans(model: ITextModel): ClaudeAcceptedSpan[] {
		const hunks = this._diff.hunks;
		if (hunks.length === 0) {
			return [];
		}
		const text = model.getValue(EndOfLinePreference.LF);
		const current = text === this._diff.modified ? hunks : collectReviewHunks(model.uri, this._diff.original, text);
		return inlineAcceptedSpans(hunks, current);
	}

	async reject(): Promise<void> {
		let status: 'done' | 'conflict' | 'saveFailed';
		try {
			status = await this._diff.reject();
		} catch (error) {
			if (error instanceof ReviewConflictError) {
				this._reviewing.set(false);
				this._notifications.warn(error.message);
				return;
			}
			const message = error instanceof Error && error.message
				? error.message
				: localize('claudeInlineRejectSaveFailed', "Could not save the restored file. Reject again to retry.");
			this._notifications.error(message);
			return;
		}
		if (status === 'saveFailed') {
			// The snapshot is back in the buffer. Keep the diff and Escape so Reject retries the save.
			return;
		}
		if (status === 'conflict' || this._diff.hunkCount > 0) {
			// The buffer drifted. Leave the diff up, and stop taking Escape.
			this._reviewing.set(false);
			return;
		}
		this.finishReview();
	}

	nextHunk(): void {
		this._diff.next();
	}

	previousHunk(): void {
		this._diff.previous();
	}

	private async openReview(sessionId: string, turnId: string): Promise<void> {
		await this._views.openView(CLAUDE_AGENT_VIEW_ID, true);
		this._review.focus(sessionId, turnId);
		this._review.next(sessionId, turnId);
	}

	private finishReview(): void {
		this._card?.dispose();
		this._card = undefined;
		this._reviewing.set(false);
		if (ClaudeInlineController._current === this) {
			ClaudeInlineController._current = undefined;
		}
	}

	/**
	 * Writes a dirty model before the edit. A cancelled or failed save refuses
	 * the edit so the unsaved buffer is not replaced by a disk write.
	 */
	private async saveDirtyModel(model: ITextModel): Promise<boolean> {
		let saved: URI | undefined;
		try {
			saved = await this._textFiles.save(model.uri);
		} catch (error) {
			if (!model.isDisposed()) {
				const message = error instanceof Error && error.message
					? error.message
					: localize('claudeInlineDirtySaveFailed', "Could not save this file, so the inline edit did not run.");
				this._notifications.error(message);
			}
			return false;
		}
		if (model.isDisposed()) {
			return false;
		}
		if (!saved || this._textFiles.isDirty(model.uri)) {
			this._notifications.warn(localize('claudeInlineDirty', "Save this file before running an inline edit."));
			return false;
		}
		return true;
	}

	private saveRestored(uri: URI, _text: string): Promise<void> {
		if (uri.scheme !== Schemas.file) {
			return Promise.resolve();
		}
		return this._textFiles.save(uri, { skipSaveParticipants: true, ignoreModifiedSince: true }).then(() => undefined);
	}

	private dismiss(): void {
		const cancelRun = this._busy;
		this._widget?.dispose();
		this._widget = undefined;
		this._card?.dispose();
		this._card = undefined;
		this._diff.clear();
		this._reviewing.reset();
		this._busy = false;
		if (ClaudeInlineController._current === this) {
			ClaudeInlineController._current = undefined;
		}
		if (cancelRun) {
			void this._inline.cancel();
		}
	}

	override dispose(): void {
		this.dismiss();
		super.dispose();
	}
}

/** The prompt card's height in px: borders, 8px inset, 22px field, 4px gap, 20px footer and 6px inset. */
const INLINE_CARD_HEIGHT = 1 + 8 + 22 + 4 + 20 + 6 + 1;
/** Zone heights in px: the card with a 4px band above it and a 6px band below, as in the prototype. */
const INLINE_PROMPT_HEIGHT = 4 + INLINE_CARD_HEIGHT + 6;
/** The result adds the line with the instruction, Reject and Accept over the follow-up input. */
const INLINE_RESULT_HEIGHT = INLINE_PROMPT_HEIGHT + 24;

/** What Send to Agent puts in the Agent's composer: a context chip and the start of the draft. */
interface ClaudeInlineHandoff {
	readonly attachment: ContextAttachment;
	readonly draft: string;
}

/** What the card runs once the edit is in the editor: Reject, Accept, a follow-up and the hand-off to the Agent. */
export interface ClaudeInlineResultActions {
	accept(): void;
	reject(): void;
	followUp(instruction: string): void;
	handoff(): ClaudeInlineHandoff | undefined;
}

/**
 * Where an inline run works: the file's path in its workspace folder (else its name),
 * and the folder Claude runs in (the workspace folder, else the file's own folder).
 * A notebook cell works from its notebook file.
 */
function inlineFileContext(workspace: IWorkspaceContextService, cellOrFile: URI): { readonly path: string; readonly cwd: string | undefined } {
	const uri = cellOrFile.scheme === Schemas.vscodeNotebookCell ? (CellUri.parse(cellOrFile)?.notebook ?? cellOrFile) : cellOrFile;
	const folder = workspace.getWorkspaceFolder(uri);
	return {
		path: folder ? (relativePath(folder.uri, uri) ?? basename(uri)) : basename(uri),
		cwd: folder?.uri.scheme === Schemas.file ? folder.uri.fsPath : (uri.scheme === Schemas.file ? dirname(uri).fsPath : undefined),
	};
}

/** The range as a selection chip, or the whole file when it is empty (a Ctrl/Cmd+K at the cursor). */
function inlineAttachment(model: ITextModel, range: IRange): ContextAttachment {
	if (range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn) {
		return { kind: 'file', uri: model.uri.toString() };
	}
	return {
		kind: 'selection',
		uri: model.uri.toString(),
		range: { startLine: range.startLineNumber, startColumn: range.startColumn, endLine: range.endLineNumber, endColumn: range.endColumn },
		versionId: model.getVersionId(),
	};
}

/**
 * The inline edit card: a view zone above the selection, starting at the text column.
 * It asks for the instruction, shows progress while Claude edits, then stays
 * above the diff with Reject, Accept and a follow-up input until the edit is settled.
 */
export class ClaudeInlineWidget extends Disposable {
	private _zone: string | undefined;
	private readonly _zoneSpec: IViewZone;
	private _resolve: ((value: string | undefined) => void) | undefined;
	private _mode: 'prompt' | 'running' | 'result' = 'prompt';
	private _onStop: (() => void) | undefined;
	private _onFollowUp: ((instruction: string) => void) | undefined;
	private _onHandoff: (() => ClaudeInlineHandoff | undefined) | undefined;
	/** Set while the field waits for the zone to be laid out before it can take focus. */
	private _focusOnLayout = false;
	private readonly _root: HTMLElement;
	private _head: HTMLElement | undefined;
	private readonly _resultListeners = this._register(new DisposableStore());
	private readonly _input: HTMLElement;
	private readonly _field: HTMLTextAreaElement;
	private readonly _close: HTMLButtonElement;
	private readonly _submit: HTMLButtonElement;
	private readonly _submitIcon: HTMLElement;
	private readonly _toolbar: HTMLElement;
	private readonly _toolbarListeners = this._register(new DisposableStore());
	private readonly _modelButton: HTMLButtonElement;
	private readonly _modelMenu: ClaudeModelMenu;
	/** The last model list Claude Code reported; empty until it answers. */
	private _models: readonly ClaudeModelInfo[] = [];
	/** The answer to a question about the selection (issue 491), under the field. */
	private readonly _answer: ClaudeInlineAnswer;
	/** The Ask button's word, while the prompt card shows it. */
	private _askLabel: HTMLElement | undefined;
	/** The id of the question Claude is answering, until it answers or stops. */
	private _asking: string | undefined;
	/** The question the answer under the field is for. */
	private _question = '';

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _selection: IRange | null,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IViewsService private readonly _views: IViewsService,
		@IKeybindingService private readonly _keybindings: IKeybindingService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@ICommandService private readonly _commands: ICommandService,
		@INotificationService private readonly _notifications: INotificationService,
		@IInstantiationService private readonly _instantiation: IInstantiationService,
		@IEditorService private readonly _editors: IEditorService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
	) {
		super();
		const line = _selection?.startLineNumber ?? _editor.getPosition()?.lineNumber ?? 1;
		const host = $('div.claude-inline-zone');
		// The editor lays a zone out at the width of the scrollable content, which runs past the visible text column; keep it at the column.
		const fitHost = () => { host.style.width = `${_editor.getLayoutInfo().contentWidth}px`; };
		fitHost();
		this._register(_editor.onDidLayoutChange(fitHost));
		this._root = append(host, $('div.claude-inline'));
		this._root.setAttribute('role', 'dialog');
		this._root.setAttribute('aria-label', localize('claudeInlineDialog', "Edit selection"));
		this._input = append(this._root, $('div.claude-inline-input'));
		this._field = append(this._input, $<HTMLTextAreaElement>('textarea.field'));
		this._field.rows = 1;
		this._field.setAttribute('aria-label', localize('claudeInlineInstruction', "Edit instruction"));
		this._field.placeholder = localize('claudeInlinePlaceholder', "Describe the change");
		const close = this._close = append(this._input, $<HTMLButtonElement>('button.claude-inline-icon'));
		close.type = 'button';
		close.setAttribute('aria-label', localize('claudeInlineClose', "Close (Escape)"));
		append(close, $(ThemeIcon.asCSSSelector(Codicon.close)));
		this._register(addDisposableListener(close, EventType.CLICK, event => {
			event.preventDefault();
			this.close();
		}));
		this._toolbar = append(this._root, $('div.claude-inline-toolbar'));
		this._modelButton = $<HTMLButtonElement>('button.claude-inline-model');
		this._modelButton.type = 'button';
		this._modelMenu = this._register(this._instantiation.createInstance(ClaudeModelMenu));
		this._register(addDisposableListener(this._modelButton, EventType.CLICK, event => {
			event.preventDefault();
			void this.showModelMenu();
		}));
		this.paintModel();
		// The raw id, or no label, stays until the list names the model.
		this.loadModels().catch(() => undefined);
		this._submit = $<HTMLButtonElement>('button.claude-inline-submit');
		this._submit.type = 'button';
		this._submitIcon = append(this._submit, $('span'));
		this._register(addDisposableListener(this._submit, EventType.CLICK, event => {
			event.preventDefault();
			if (this._mode === 'running') {
				this._onStop?.();
				return;
			}
			this.submit();
		}));
		this._answer = this._register(this._instantiation.createInstance(ClaudeInlineAnswer, {
			sendToAgent: answer => void this.sendToAgent(claudeInlineAnswerDraft(this._question, answer)),
			editInstead: () => this.editInstead(),
		}));
		this._root.insertBefore(this._answer.element, this._toolbar);
		// A code block in the answer is colored after it renders, so the zone follows the answer's size.
		const answerSize = this._register(new DisposableResizeObserver('claudeInlineAnswer', () => this.layoutAnswer(), getWindow(_editor.getDomNode())));
		this._register(answerSize.observe(this._answer.element));
		this._register(addDisposableListener(this._answer.element, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this.close();
			}
		}));
		this.paintToolbar();
		this._register(addDisposableListener(this._field, EventType.KEY_DOWN, event => this.onKey(event)));
		this._zoneSpec = {
			afterLineNumber: Math.max(0, line - 1),
			heightInPx: INLINE_PROMPT_HEIGHT,
			// Above any removed lines that the diff later puts after the same line.
			ordinal: 0,
			// The editor must leave a click alone here, or it takes focus from the field.
			suppressMouseDown: false,
			domNode: host,
			// The editor shows the zone after this call in the same render, so the field takes focus right after it.
			onDomNodeTop: () => {
				if (this._focusOnLayout) {
					queueMicrotask(() => this.focusField());
				}
			},
		};
		this._editor.changeViewZones(accessor => {
			this._zone = accessor.addZone(this._zoneSpec);
		});
		fitHost();
		this._editor.revealLine(line);
	}

	prompt(): Promise<string | undefined> {
		return new Promise(resolve => {
			this._resolve = resolve;
			this._focusOnLayout = true;
			this.focusField();
		});
	}

	/** Shows that Claude is editing. A follow-up passes its text, which the field then holds. */
	showProgress(fileName: string, onStop: () => void, followUp?: string): void {
		this._mode = 'running';
		this._onStop = onStop;
		this.cancelAsk();
		this._answer.clear();
		this._onFollowUp = undefined;
		this._onHandoff = undefined;
		this._resultListeners.clear();
		this._head?.remove();
		this._head = undefined;
		this._root.classList.remove('is-result');
		this._root.setAttribute('aria-label', localize('claudeInlineDialog', "Edit selection"));
		this._root.setAttribute('aria-busy', 'true');
		this._close.hidden = false;
		if (followUp !== undefined) {
			this._field.value = followUp;
		}
		this._field.readOnly = true;
		this.resize(INLINE_PROMPT_HEIGHT);
		this._toolbarListeners.clear();
		clearNode(this._toolbar);
		const activity = append(this._toolbar, $('span.claude-activity.is-shimmer'));
		const text = append(activity, $('span.text'));
		text.textContent = localize('claudeInlineEditing', "Editing {0}", fileName);
		append(this._toolbar, $('span.spacer'));
		this.paintSubmit(true);
	}

	/**
	 * Puts a header line over the field: "Editing <file>", then Reject and Accept with their keys.
	 * The field below then takes a follow-up on top of the edit, or sends it to the Agent.
	 */
	showResult(fileName: string, actions: ClaudeInlineResultActions): void {
		this._mode = 'result';
		this._onStop = undefined;
		this._onFollowUp = text => actions.followUp(text);
		this._onHandoff = () => actions.handoff();
		this._root.removeAttribute('aria-busy');
		this._root.classList.add('is-result');
		this._root.setAttribute('aria-label', localize('claudeInlineResultDialog', "Review inline edit"));
		this._resultListeners.clear();
		this._head?.remove();
		const head = this._head = $('div.claude-inline-head');
		this._root.insertBefore(head, this._input);
		append(head, $('span.claude-inline-title')).textContent = localize('claudeInlineEditing', "Editing {0}", fileName);
		// Escape rejects only while the setting is on, so the key shows only then.
		const rejectKeys = this._configuration.getValue<boolean>(CLAUDE_INLINE_REJECT_ON_ESCAPE_SETTING) !== false ? this._keybindings.lookupKeybinding(REJECT_ID)?.getLabel() ?? undefined : undefined;
		this.resultButton(head, localize('claudeInlineReject', "Reject"), rejectKeys, () => actions.reject());
		const acceptKeys = this._keybindings.lookupKeybinding(ACCEPT_ID)?.getLabel() ?? undefined;
		this.resultButton(head, localize('claudeInlineAccept', "Accept"), acceptKeys, () => actions.accept()).classList.add('is-keep');
		// Reject is the way out here, so the field's Close goes.
		this._close.hidden = true;
		this._field.readOnly = false;
		this._field.value = '';
		this._field.placeholder = localize('claudeInlineFollowUpPlaceholder', "Ask for a change on top of this edit");
		this._field.setAttribute('aria-label', localize('claudeInlineFollowUp', "Follow-up instruction"));
		this.paintToolbar();
		this.resize(INLINE_RESULT_HEIGHT);
	}

	/** Focuses the field; until the zone is shown that fails, and the next layout tries again. */
	private focusField(): void {
		if (!this._focusOnLayout) {
			return;
		}
		this._field.focus();
		if (this._field.ownerDocument.activeElement === this._field) {
			this._focusOnLayout = false;
		}
	}

	override dispose(): void {
		this._focusOnLayout = false;
		this.cancelAsk();
		this.settle(undefined);
		if (this._zone) {
			const id = this._zone;
			this._zone = undefined;
			this._editor.changeViewZones(accessor => accessor.removeZone(id));
		}
		super.dispose();
	}

	/** The model on the left, then Send to Agent, then the round submit. */
	private paintToolbar(): void {
		this._toolbarListeners.clear();
		clearNode(this._toolbar);
		this._toolbar.appendChild(this._modelButton);
		append(this._toolbar, $('span.spacer'));
		this._askLabel = this._mode === 'prompt' ? this.askButton() : undefined;
		const send = append(this._toolbar, $<HTMLButtonElement>('button.claude-inline-text'));
		send.type = 'button';
		send.textContent = localize('claudeInlineSendToAgent', "Send to Agent");
		this._toolbarListeners.add(addDisposableListener(send, EventType.CLICK, event => {
			event.preventDefault();
			void this.sendToAgent();
		}));
		this.paintSubmit(false);
	}

	/** Ask, with its key, before an edit: it answers about the selection and changes nothing (issue 491). Returns its word. */
	private askButton(): HTMLElement {
		const button = append(this._toolbar, $<HTMLButtonElement>('button.claude-inline-text.claude-inline-ask'));
		button.type = 'button';
		const label = append(button, $('span.label'));
		const keybinding = decodeKeybinding(CLAUDE_INLINE_ASK_KEY, OS);
		const keys = keybinding ? this._keybindings.resolveKeybinding(keybinding)[0]?.getLabel() ?? undefined : undefined;
		if (keys) {
			appendClaudeKbd(button, keys).classList.add('is-quiet');
			button.setAttribute('aria-keyshortcuts', keys);
		}
		this._toolbarListeners.add(addDisposableListener(button, EventType.CLICK, event => {
			event.preventDefault();
			if (this._asking) {
				this.stopAsk();
			} else {
				void this.ask();
			}
			this._field.focus();
		}));
		this.paintAsk(label);
		return label;
	}

	private paintAsk(label = this._askLabel): void {
		if (label) {
			label.textContent = this._asking ? localize('claudeInlineAskStop', "Stop") : localize('claudeInlineAsk', "Ask");
		}
	}

	/**
	 * Asks about the selection (or the cursor's line) without editing (issue 491):
	 * the side question's read-only query in plan mode, answered under the field.
	 */
	private async ask(): Promise<void> {
		const model = this._editor.getModel();
		const question = this._field.value.trim();
		if (this._mode !== 'prompt' || !question || !model || model.isDisposed() || !this._runtime.askSideQuestion) {
			return;
		}
		this.cancelAsk();
		const id = generateUuid();
		const { path, cwd } = inlineFileContext(this._workspace, model.uri);
		const range = this.promptRange();
		const request = range ? claudeInlineQuestionRequest(id, {
			question,
			path,
			languageId: model.getLanguageId(),
			text: model.getValue(EndOfLinePreference.LF),
			range,
			cwd,
			workspaceFolders: this._workspace.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.file).map(folder => folder.uri.fsPath),
			model: this.modelId(),
		}) : undefined;
		if (!request) {
			this._answer.showError(localize('claudeInlineAskNoFolder', "Save the file or open a folder: Claude answers from a folder on disk."));
			this.layoutAnswer();
			return;
		}
		this._asking = id;
		this._question = question;
		this._answer.showBusy();
		this.paintAsk();
		this.layoutAnswer();
		let result: ClaudeSideQuestionResult;
		try {
			result = await this._runtime.askSideQuestion(request);
		} catch (error) {
			result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
		}
		if (this._asking !== id || this._store.isDisposed) {
			return;
		}
		this._asking = undefined;
		if (result.kind === 'answer') {
			this._answer.showAnswer(result.text);
		} else if (result.kind === 'failed') {
			this._answer.showError(localize('claudeInlineAskFailed', "Claude could not answer: {0}", result.message));
		} else {
			this._answer.clear();
		}
		this.paintAsk();
		this.layoutAnswer();
	}

	/** Stops the question Claude is answering, if any. */
	private cancelAsk(): void {
		const id = this._asking;
		this._asking = undefined;
		if (id) {
			void this._runtime.cancelSideQuestion?.(id);
		}
	}

	/** Stops the question and takes its answer, or its progress, out of the card. */
	private stopAsk(): void {
		this.cancelAsk();
		this._answer.clear();
		this.paintAsk();
		this.layoutAnswer();
	}

	/** Runs the question's text as an edit: the answer goes and the card edits as on Enter. */
	private editInstead(): void {
		this.stopAsk();
		this.submit();
	}

	/** Grows the prompt zone by the answer's height, or back when it is gone. */
	private layoutAnswer(): void {
		if (this._mode === 'prompt') {
			this.resize(INLINE_PROMPT_HEIGHT + this._answer.height());
		}
	}

	/** The model the edit runs: `claude.inlineEdit.model`, else the chat's pick. Undefined runs Claude Code's default. */
	private modelId(): string | undefined {
		return readClaudeModelId(this._configuration.getValue(CLAUDE_INLINE_EDIT_MODEL_SETTING)) ?? this._agent.getCurrentSession()?.modelId;
	}

	/** Names the model as the composer's pill does: by the model Claude Code's default resolves to, never "Default". */
	private paintModel(): void {
		const id = this.modelId();
		const model = resolveClaudeModel(this._models, id);
		const name = model ? claudeModelDisplayName(model) : id;
		clearNode(this._modelButton);
		this._modelButton.style.display = name ? '' : 'none';
		if (!name) {
			return;
		}
		append(this._modelButton, $('span.label')).textContent = name;
		append(this._modelButton, $(ThemeIcon.asCSSSelector(Codicon.chevronDown)));
		this._modelButton.setAttribute('aria-label', localize('claudeInlineModel', "Model: {0}", name));
	}

	private async loadModels(): Promise<readonly ClaudeModelInfo[]> {
		const models = await this._runtime.listModels();
		if (!this._store.isDisposed) {
			this._models = models;
			this.paintModel();
		}
		return models;
	}

	private async showModelMenu(): Promise<void> {
		if (this._modelMenu.isOpen) {
			this._modelMenu.close();
			return;
		}
		let reported: readonly ClaudeModelInfo[];
		try {
			reported = await this.loadModels();
		} catch (error) {
			this._notifications.error(error);
			return;
		}
		if (this._store.isDisposed) {
			return;
		}
		const id = this.modelId();
		const model = resolveClaudeModel(reported, id);
		const session = this._agent.getCurrentSession();
		this._modelMenu.show(this._modelButton, {
			// Only enabled models and custom ids (spec 34b), as the composer's menu shows.
			models: pickableClaudeModels(
				reported,
				readClaudeModelIdList(this._configuration.getValue(CLAUDE_MODELS_ENABLED_SETTING)),
				readClaudeModelIdList(this._configuration.getValue(CLAUDE_MODELS_CUSTOM_SETTING)),
			),
			// An edit on Claude Code's default runs the model that alias resolves to.
			currentId: id ?? (model?.id === CLAUDE_DEFAULT_MODEL_ALIAS ? model.resolvedModel : model?.id),
			// Effort and the other rows are the chat session's, which an edit runs in while the chat is idle.
			model: session ? model : undefined,
			settings: session ? this._agent.getSessionSettings(session.id) : {},
			pickModel: modelId => void this.pickModel(modelId),
			setSettings: settings => {
				if (session) {
					this._agent.setNextSettings(session.id, settings).catch(error => this._notifications.error(error));
				}
			},
			manage: () => void this._commands.executeCommand(CLAUDE_MANAGE_MODELS_COMMAND_ID),
		}, () => {
			if (this._mode === 'prompt') {
				this.focusField();
			}
		});
	}

	/** A pick here is `claude.inlineEdit.model`, the model Ctrl+K uses, so the chat keeps its own. */
	private async pickModel(modelId: string): Promise<void> {
		try {
			await this._configuration.updateValue(CLAUDE_INLINE_EDIT_MODEL_SETTING, modelId, ConfigurationTarget.USER);
		} catch (error) {
			this._notifications.error(error);
			return;
		}
		if (!this._store.isDisposed) {
			this.paintModel();
		}
	}

	private paintSubmit(running: boolean): void {
		this._submit.classList.toggle('is-stop', running);
		this._submit.setAttribute('aria-label', running ? localize('claudeInlineStop', "Stop") : localize('claudeInlineSubmit', "Submit"));
		this._submitIcon.className = ThemeIcon.asClassName(running ? Codicon.debugStop : Codicon.arrowUp);
		this._toolbar.appendChild(this._submit);
	}

	private resultButton(container: HTMLElement, label: string, keys: string | undefined, run: () => void): HTMLButtonElement {
		const button = append(container, $<HTMLButtonElement>('button.claude-inline-text'));
		button.type = 'button';
		append(button, $('span.label')).textContent = label;
		if (keys) {
			appendClaudeKbd(button, keys).classList.add('is-quiet');
			button.setAttribute('aria-keyshortcuts', keys);
		}
		// The editor keeps focus, so the keys keep working after a press.
		this._resultListeners.add(addDisposableListener(button, EventType.MOUSE_DOWN, event => event.preventDefault()));
		this._resultListeners.add(addDisposableListener(button, EventType.CLICK, event => {
			event.preventDefault();
			run();
		}));
		return button;
	}

	private resize(height: number): void {
		const id = this._zone;
		if (!id || this._zoneSpec.heightInPx === height) {
			return;
		}
		this._zoneSpec.heightInPx = height;
		this._editor.changeViewZones(accessor => accessor.layoutZone(id));
	}

	private close(): void {
		if (this._mode === 'running') {
			this._onStop?.();
			return;
		}
		if (this._asking) {
			// Escape stops the answer first; the next one closes the card.
			this.stopAsk();
			return;
		}
		if (this._mode === 'result') {
			// Escape leaves the follow-up; the edit stays under review.
			this._editor.focus();
			return;
		}
		this.settle(undefined);
	}

	private onKey(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			this.close();
			return;
		}
		// Alt+Enter asks about the selection instead of editing it (issue 491). The field takes it, so no workbench binding sees it.
		if (event.key === 'Enter' && event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && this._mode === 'prompt') {
			event.preventDefault();
			event.stopPropagation();
			void this.ask();
			return;
		}
		// Ctrl/Cmd+Enter is Accept, not a follow-up.
		if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && this._mode !== 'running') {
			event.preventDefault();
			this.submit();
		}
	}

	private submit(): void {
		const text = this._field.value.trim();
		if (!text) {
			return;
		}
		if (this._mode === 'result') {
			this._onFollowUp?.(text);
			return;
		}
		this.settle(text);
	}

	/**
	 * Moves the edit to the Agent: the changed lines (or the selection, before an edit)
	 * as a chip, a draft naming the edit and its instructions, then any typed text.
	 * An empty field still hands the edit over. After an answer, `text` is the question and its answer.
	 */
	private async sendToAgent(text = this._field.value.trim()): Promise<void> {
		const handoff = this._mode === 'result' ? this._onHandoff?.() : this.promptHandoff();
		if (!text && !handoff) {
			return;
		}
		const session = this._agent.getCurrentSession() ?? this._agent.createSession();
		const draft = handoff?.draft ? `${handoff.draft}${text}` : text;
		if (handoff) {
			const key = JSON.stringify(handoff.attachment);
			const existing = session.attachments;
			if (!existing.some(attachment => JSON.stringify(attachment) === key)) {
				this._agent.setAttachments(session.id, [...existing, handoff.attachment]);
			}
		}
		if (this._mode === 'result') {
			// The edit stays under review; the Agent gets a copy of it to work on.
			this._field.value = '';
		}
		this.settle(undefined);
		const chat = await revealClaudeChat(this._views, this._editors, this._instantiation, true);
		// An open composer shows the text at once, after anything typed there (issue 341).
		// Without one, the session's draft keeps it until a composer shows that session.
		if (draft && !chat?.appendDraft(session.id, draft)) {
			const saved = this._agent.getSessions().find(candidate => candidate.id === session.id)?.draft ?? '';
			this._agent.setDraft(session.id, appendAgentDraft(saved, draft));
		}
	}

	/** The card's selection, else the bare cursor. */
	private promptRange(): IRange | undefined {
		const position = this._editor.getPosition();
		return this._selection ?? (position ? { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column } : undefined);
	}

	/** Before an edit, the selection (or the file, at a bare cursor) goes along with the typed instruction. */
	private promptHandoff(): ClaudeInlineHandoff | undefined {
		const model = this._editor.getModel();
		if (!model || model.isDisposed()) {
			return undefined;
		}
		const range = this.promptRange();
		return range ? { attachment: inlineAttachment(model, range), draft: '' } : undefined;
	}

	private settle(value: string | undefined): void {
		const resolve = this._resolve;
		this._resolve = undefined;
		resolve?.(value);
	}
}

/** Adds the inline edit controller to every code editor. Separate from the commands, so a test that registers the commands does not add it to other tests' editors. */
export function registerClaudeInlineEditorContribution(): void {
	registerEditorContribution(ClaudeInlineController.ID, ClaudeInlineController, EditorContributionInstantiation.AfterFirstRender);
}

export function registerClaudeInlineContributions(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: START_ID,
				title: { ...localize2('claudeInlineEdit', "Inline Edit"), original: 'Inline Edit (Inline Edit)' }, // the bracketed word ranks it above Accept Inline Edit (issue 1504)
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				keybinding: {
					primary: INLINE_EDIT_DEFAULT_KEY,
					// Below the Klawly Keys Ctrl/Cmd+K rule, so labels show Ctrl/Cmd+K while the preset is on.
					weight: KeybindingWeight.WorkbenchContrib + 2,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, EditorContextKeys.editorTextFocus),
				},
				menu: [{
					id: MenuId.EditorContext,
					group: CLAUDE_EDITOR_CONTEXT_GROUP,
					order: 0,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, EditorContextKeys.editorTextFocus),
				}],
			});
		}
		run(accessor: ServicesAccessor): Promise<void> {
			return controller(accessor)?.start() ?? Promise.resolve();
		}
	});

	KeybindingsRegistry.registerKeybindingRule({
		id: START_ID,
		weight: CLAUDE_KLAWLY_KEY_WEIGHT,
		// With the agent off, Ctrl/Cmd+K goes back to the Code - OSS chords.
		when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, EditorContextKeys.editorTextFocus, CLAUDE_KLAWLY_KEYMAP),
		primary: INLINE_EDIT_KLAWLY_KEY,
	});

	// With the preset off, labels outside the editor show Ctrl/Cmd+Alt+K, not Ctrl/Cmd+K.
	KeybindingsRegistry.registerKeybindingRule({
		id: START_ID,
		weight: CLAUDE_DEFAULT_KEY_LABEL_WEIGHT,
		when: CLAUDE_DEFAULT_KEY_LABEL_WHEN,
		primary: INLINE_EDIT_DEFAULT_KEY,
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: ACCEPT_ID,
				title: localize2('claudeAcceptAiEdit', "Accept Inline Edit"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyCode.Enter,
					weight: KeybindingWeight.WorkbenchContrib,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_INLINE_REVIEWING),
				},
			});
		}
		run(accessor: ServicesAccessor): void {
			controller(accessor)?.accept();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: REJECT_ID,
				title: localize2('claudeRejectAiEdit', "Reject AI Edit"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				keybinding: {
					primary: KeyCode.Escape,
					weight: KeybindingWeight.WorkbenchContrib + 50,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_INLINE_REVIEWING, ContextKeyExpr.equals(`config.${CLAUDE_INLINE_REJECT_ON_ESCAPE_SETTING}`, true)),
				},
			});
		}
		run(accessor: ServicesAccessor): Promise<void> {
			return controller(accessor)?.reject() ?? Promise.resolve();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: NEXT_ID,
				title: localize2('claudeNextInlineHunk', "Next Inline Hunk"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				keybinding: {
					primary: KeyMod.Alt | KeyCode.BracketRight,
					weight: KeybindingWeight.WorkbenchContrib + 1,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_INLINE_REVIEWING),
				},
			});
		}
		run(accessor: ServicesAccessor): void {
			controller(accessor)?.nextHunk();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: PREVIOUS_ID,
				title: localize2('claudePreviousInlineHunk', "Previous Inline Hunk"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
				keybinding: {
					primary: KeyMod.Alt | KeyCode.BracketLeft,
					weight: KeybindingWeight.WorkbenchContrib + 1,
					when: ContextKeyExpr.and(CLAUDE_AGENT_ENABLED, CLAUDE_INLINE_REVIEWING),
				},
			});
		}
		run(accessor: ServicesAccessor): void {
			controller(accessor)?.previousHunk();
		}
	});
}

function controller(accessor: ServicesAccessor): ClaudeInlineController | undefined {
	const current = ClaudeInlineController.current();
	if (current) {
		return current;
	}
	const editors = accessor.get(ICodeEditorService);
	const editor = editors.getFocusedCodeEditor() ?? editors.getActiveCodeEditor();
	return editor?.getContribution<ClaudeInlineController>(ClaudeInlineController.ID) ?? undefined;
}

function waitForModelText(model: ITextModel): Promise<void> {
	if (model.isDisposed()) {
		return Promise.resolve();
	}
	return new Promise(resolve => {
		let settled = false;
		const listener = model.onDidChangeContent(() => done());
		const timer = setTimeout(done, INLINE_MODEL_WAIT_MS);
		function done(): void {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			listener.dispose();
			resolve();
		}
	});
}

function sameText(left: string, right: string): boolean {
	const normalize = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	return normalize(left) === normalize(right);
}

function syncModel(model: ITextModel, modified: string): void {
	const live = model.getValue(EndOfLinePreference.LF).replace(/\r\n/g, '\n');
	const next = modified.replace(/\r\n/g, '\n');
	if (live === next) {
		return;
	}
	const text = next.replace(/\n/g, model.getEOL());
	model.pushStackElement();
	model.pushEditOperations(null, [{ range: model.getFullModelRange(), text }], () => null);
	model.pushStackElement();
}
