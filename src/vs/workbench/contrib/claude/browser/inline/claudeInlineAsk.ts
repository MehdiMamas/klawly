/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import { localize } from '../../../../../nls.js';
import { claudeSideQuestionQuote, ClaudeSideQuestionRequest } from '../../../../../platform/claude/common/claudeSideQuestion.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { resolveInlineSelection } from '../../../../services/claude/common/claudeInlineEdit.js';

/** Alt+Enter in the inline card asks instead of editing (issue 491). The field takes it before any workbench binding. */
export const CLAUDE_INLINE_ASK_KEY = KeyMod.Alt | KeyCode.Enter;

/** The most selected text a question sends; Claude reads the file for the rest. */
const CLAUDE_INLINE_QUESTION_MAX_CHARS = 40_000;

/** What a question about the card's selection is built from. */
export interface ClaudeInlineQuestionInput {
	readonly question: string;
	/** The file's path in its workspace folder, else its name. */
	readonly path: string;
	readonly languageId: string;
	/** The file's text, LF line ends. */
	readonly text: string;
	readonly range: IRange;
	/** Where the question runs: the file's workspace folder, else its folder. Unset for an untitled file outside a workspace. */
	readonly cwd: string | undefined;
	readonly workspaceFolders: readonly string[];
	readonly model?: string;
}

/**
 * The side question request for the selection (issue 491): no chat to fork,
 * the selected code in the prompt, read-only tools in plan mode. A bare cursor
 * asks about its line, as an edit there would change it. Undefined without a
 * question or a folder to run in.
 */
export function claudeInlineQuestionRequest(id: string, input: ClaudeInlineQuestionInput): ClaudeSideQuestionRequest | undefined {
	const question = input.question.trim();
	if (!question || !input.cwd) {
		return undefined;
	}
	const resolved = resolveInlineSelection(input.text, input.range.startLineNumber, input.range.startColumn, input.range.endLineNumber, input.range.endColumn);
	const text = resolved.text.length > CLAUDE_INLINE_QUESTION_MAX_CHARS ? `${resolved.text.slice(0, CLAUDE_INLINE_QUESTION_MAX_CHARS)}\n…` : resolved.text;
	return {
		id,
		question,
		cwd: input.cwd,
		workspaceFolders: input.workspaceFolders.length > 0 ? input.workspaceFolders : [input.cwd],
		model: input.model,
		selection: { path: input.path, languageId: input.languageId, startLine: resolved.startLine, endLine: resolved.endLine, text },
	};
}

/** What Send to Agent puts in the composer after an answer: the question, then the answer as a quote. */
export function claudeInlineAnswerDraft(question: string, answer: string): string {
	return `${question.trim()}\n\n${claudeSideQuestionQuote(answer)}`;
}

/** What the answer's buttons run in the card. */
export interface ClaudeInlineAnswerActions {
	/** Moves the question and the answer to the Agent's composer. */
	sendToAgent(answer: string): void;
	/** Runs the question's text as an edit instead. */
	editInstead(): void;
}

/**
 * The answer under the inline card's field (issue 491): a status while Claude
 * answers, then the Markdown answer in a scroll area with Copy, Send to Agent
 * and Edit Instead. It sits inside the card, above its footer (DL-07: no new
 * surface, a hairline sets it apart).
 */
export class ClaudeInlineAnswer extends Disposable {
	readonly element: HTMLElement;
	private readonly _body: HTMLElement;
	private readonly _actions: HTMLElement;
	private readonly _copy: HTMLButtonElement;
	private readonly _send: HTMLButtonElement;
	private readonly _rendered = this._register(new MutableDisposable<DisposableStore>());
	private _text: string | undefined;

	constructor(
		private readonly _run: ClaudeInlineAnswerActions,
		@IMarkdownRendererService private readonly _markdown: IMarkdownRendererService,
		@IClipboardService private readonly _clipboard: IClipboardService,
	) {
		super();
		this.element = $('div.claude-inline-answer');
		this.element.hidden = true;
		this._body = append(this.element, $('div.claude-inline-answer-body'));
		this._body.setAttribute('role', 'status');
		this._body.tabIndex = 0;
		this._actions = append(this.element, $('div.claude-inline-answer-actions'));
		this._copy = this.button(localize('claudeInlineAnswerCopy', "Copy"), () => {
			if (this._text !== undefined) {
				void this._clipboard.writeText(this._text);
			}
		});
		this._send = this.button(localize('claudeInlineAnswerSendToAgent', "Send to Agent"), () => {
			if (this._text !== undefined) {
				this._run.sendToAgent(this._text);
			}
		});
		this.button(localize('claudeInlineAnswerEditInstead', "Edit Instead"), () => this._run.editInstead());
	}

	/** The answer's text, once Claude answered. */
	get text(): string | undefined {
		return this._text;
	}

	get visible(): boolean {
		return !this.element.hidden;
	}

	showBusy(): void {
		this.showStatus(localize('claudeInlineAnswerBusy', "Claude is answering..."), 'is-busy');
	}

	showError(message: string): void {
		this.showStatus(message, 'is-error');
	}

	showAnswer(text: string): void {
		this._text = text;
		this.reset();
		const store = new DisposableStore();
		this._rendered.value = store;
		const rendered = store.add(this._markdown.render(new MarkdownString(text, { isTrusted: false, supportThemeIcons: false })));
		this._body.appendChild(rendered.element);
		this._actions.hidden = false;
		this.element.hidden = false;
	}

	clear(): void {
		this._text = undefined;
		this.reset();
		this.element.hidden = true;
	}

	/** The px the answer adds to the card, its top margin included, measured once it is in the zone. */
	height(): number {
		if (this.element.hidden) {
			return 0;
		}
		const margin = parseFloat(getWindow(this.element).getComputedStyle(this.element).marginTop);
		return this.element.offsetHeight + (Number.isFinite(margin) ? margin : 0);
	}

	private showStatus(text: string, state: 'is-busy' | 'is-error'): void {
		this._text = undefined;
		this.reset();
		this._body.textContent = text;
		this._body.classList.add(state);
		this._actions.hidden = state === 'is-busy';
		// An error keeps Edit Instead only: there is nothing to copy or send.
		this._copy.hidden = this._send.hidden = state === 'is-error';
		this.element.hidden = false;
	}

	private reset(): void {
		this._rendered.clear();
		clearNode(this._body);
		this._body.classList.remove('is-busy', 'is-error');
		this._copy.hidden = this._send.hidden = false;
		this._body.scrollTop = 0;
	}

	private button(label: string, run: () => void): HTMLButtonElement {
		const button = append(this._actions, $<HTMLButtonElement>('button.claude-inline-text'));
		button.type = 'button';
		button.textContent = label;
		this._register(addDisposableListener(button, EventType.CLICK, event => {
			event.preventDefault();
			run();
		}));
		return button;
	}
}
