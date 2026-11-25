/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { claudeSideQuestionQuote, ClaudeSideQuestionRequest, ClaudeSideQuestionResult } from '../../../../../platform/claude/common/claudeSideQuestion.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ClaudeAgentSession, IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';

/** What the side question needs from the composer it is attached to. */
export interface ClaudeSideQuestionHost {
	/** Puts the quoted answer into the composer's draft. */
	insert(text: string): void;
	requestLayout(): void;
}

/** Why Ask a Side Question is unavailable: the chat has no Claude Code conversation yet. */
export function claudeSideQuestionUnavailable(): string {
	return localize('claudeSideQuestionUnavailable', "Send a message first: a side question asks about this chat's Claude Code conversation.");
}

/**
 * Builds the runtime request for a side question about `session`, or undefined
 * while the chat has no Claude Code conversation to fork yet.
 */
export function claudeSideQuestionRequest(session: ClaudeAgentSession | undefined, question: string, workspaceFolders: readonly string[], id: string): ClaudeSideQuestionRequest | undefined {
	const cwd = session?.worktreePath ?? workspaceFolders[0];
	if (!session?.claudeSessionId || !cwd || !question.trim()) {
		return undefined;
	}
	return {
		id,
		claudeSessionId: session.claudeSessionId,
		question: question.trim(),
		cwd,
		workspaceFolders: session.worktreePath ? [session.worktreePath] : workspaceFolders,
		additionalDirectories: session.additionalDirectories,
		model: session.modelId,
	};
}

/**
 * A quick question about the current chat that does not become part of it
 * (issue 433). A raised card (DL-07) above the composer: the question, the
 * answer, and Insert as Quote or Discard. It works while a turn is running.
 */
export class ClaudeSideQuestion extends Disposable {
	readonly element: HTMLElement;
	private readonly _input: HTMLTextAreaElement;
	private readonly _answer: HTMLElement;
	private readonly _ask: HTMLButtonElement;
	private readonly _insert: HTMLButtonElement;
	private readonly _discard: HTMLButtonElement;
	/** The request in flight, so Stop, Close and a session switch can cancel it. */
	private _pending: string | undefined;
	private _text: string | undefined;

	constructor(
		container: HTMLElement,
		private readonly _host: ClaudeSideQuestionHost,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IHoverService private readonly _hovers: IHoverService,
	) {
		super();
		this.element = append(container, $('.claude-side-question'));
		this.element.setAttribute('role', 'region');
		this.element.setAttribute('aria-label', localize('claudeSideQuestion', "Side Question"));
		this.element.hidden = true;

		const head = append(this.element, $('.claude-side-question-head'));
		append(head, $(ThemeIcon.asCSSSelector(Codicon.commentDiscussion)));
		append(head, $('span.label')).textContent = localize('claudeSideQuestion', "Side Question");
		append(head, $('span.hint')).textContent = localize('claudeSideQuestionHint', "Not added to the chat");
		const close = append(head, $<HTMLButtonElement>('button.claude-icon-btn'));
		close.type = 'button';
		const closeLabel = localize('claudeSideQuestionClose', "Close Side Question");
		close.setAttribute('aria-label', closeLabel);
		append(close, $(ThemeIcon.asCSSSelector(Codicon.close)));
		this._register(this._hovers.setupDelayedHover(close, () => ({ content: closeLabel, additionalClasses: ['claude-root'] })));
		this._register(addDisposableListener(close, EventType.CLICK, () => this.close()));

		this._input = append(this.element, $<HTMLTextAreaElement>('textarea.claude-field.claude-side-question-input'));
		this._input.rows = 1;
		this._input.placeholder = localize('claudeSideQuestionPlaceholder', "Ask about this chat without changing it");
		this._input.setAttribute('aria-label', localize('claudeSideQuestionInput', "Side question"));
		this._register(addDisposableListener(this._input, EventType.KEY_DOWN, event => this.onKeyDown(new StandardKeyboardEvent(event))));
		this._register(addDisposableListener(this._input, EventType.INPUT, () => this.paint()));

		this._answer = append(this.element, $('.claude-side-question-answer'));
		this._answer.setAttribute('aria-live', 'polite');
		this._answer.hidden = true;

		const actions = append(this.element, $('.claude-side-question-actions'));
		this._discard = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
		this._discard.type = 'button';
		this._discard.textContent = localize('claudeSideQuestionDiscard', "Discard");
		this._register(addDisposableListener(this._discard, EventType.CLICK, () => this.close()));
		this._insert = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small'));
		this._insert.type = 'button';
		this._insert.textContent = localize('claudeSideQuestionInsert', "Insert as Quote");
		this._register(addDisposableListener(this._insert, EventType.CLICK, () => this.insert()));
		this._ask = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small.is-primary'));
		this._ask.type = 'button';
		this._register(addDisposableListener(this._ask, EventType.CLICK, () => this._pending ? this.stop() : void this.ask()));
		this.paint();
	}

	get isOpen(): boolean {
		return !this.element.hidden;
	}

	/** True when the current chat has a Claude Code conversation a side question can fork. */
	canAsk(): boolean {
		return !!this._agent.getCurrentSession()?.claudeSessionId && !!this._runtime.askSideQuestion;
	}

	open(question?: string): void {
		this.element.hidden = false;
		this._host.requestLayout();
		if (question) {
			this._input.value = question;
			this.paint();
			if (!this._pending) {
				void this.ask();
			}
		} else {
			this._input.focus();
		}
	}

	/** Cancels a question in flight and clears the card. A session switch calls it too. */
	close(): void {
		this.stop();
		const wasOpen = this.isOpen;
		this.element.hidden = true;
		this._input.value = '';
		this._text = undefined;
		this.showAnswer(undefined);
		if (wasOpen) {
			this._host.requestLayout();
		}
	}

	private async ask(): Promise<void> {
		const id = generateUuid();
		const folders = this._workspace.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.file).map(folder => folder.uri.fsPath);
		const request = claudeSideQuestionRequest(this._agent.getCurrentSession(), this._input.value, folders, id);
		if (!request || !this._runtime.askSideQuestion) {
			return;
		}
		this._pending = id;
		this._text = undefined;
		this.showAnswer(localize('claudeSideQuestionThinking', "Claude is answering from the chat so far..."), 'is-busy');
		let result: ClaudeSideQuestionResult;
		try {
			result = await this._runtime.askSideQuestion(request);
		} catch (error) {
			result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
		}
		if (this._pending !== id || this._store.isDisposed) {
			return;
		}
		this._pending = undefined;
		if (result.kind === 'answer') {
			this._text = result.text;
			this.showAnswer(result.text);
		} else if (result.kind === 'failed') {
			this.showAnswer(localize('claudeSideQuestionFailed', "Claude could not answer: {0}", result.message), 'is-error');
		} else {
			this.showAnswer(undefined);
		}
	}

	private stop(): void {
		const id = this._pending;
		this._pending = undefined;
		if (id) {
			void this._runtime.cancelSideQuestion?.(id);
			this.showAnswer(undefined);
		}
	}

	private insert(): void {
		if (this._text === undefined) {
			return;
		}
		const quote = claudeSideQuestionQuote(this._text);
		this.close();
		this._host.insert(quote);
	}

	private onKeyDown(event: StandardKeyboardEvent): void {
		if (event.keyCode === KeyCode.Escape) {
			event.preventDefault();
			event.stopPropagation();
			this.close();
		} else if (event.keyCode === KeyCode.Enter && !event.shiftKey) {
			event.preventDefault();
			if (!this._pending) {
				void this.ask();
			}
		}
	}

	private showAnswer(text: string | undefined, state?: 'is-busy' | 'is-error'): void {
		this._answer.hidden = text === undefined;
		this._answer.textContent = text ?? '';
		this._answer.classList.toggle('is-busy', state === 'is-busy');
		this._answer.classList.toggle('is-error', state === 'is-error');
		this.paint();
		this._host.requestLayout();
	}

	private paint(): void {
		const busy = this._pending !== undefined;
		this._ask.textContent = busy ? localize('claudeSideQuestionStop', "Stop") : localize('claudeSideQuestionAsk', "Ask");
		this._ask.disabled = !busy && !this._input.value.trim();
		this._insert.hidden = this._text === undefined;
		this._discard.hidden = this._text === undefined;
	}
}
