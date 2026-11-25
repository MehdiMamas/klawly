/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getTotalHeight } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { claudeLineReference, ClaudeReviewFeedback, compareClaudeReviewFeedback } from '../../../../../platform/claude/common/claudeReviewLoop.js';

export interface ClaudeReviewFeedbackTrayHost {
	send(): void;
	clear(): void;
	remove(id: string): void;
	reveal(item: ClaudeReviewFeedback): void;
}

/**
 * The tray at the top of the Review editor that holds line comments before they
 * go to the agent (issue 431). Hidden while it is empty. One row per comment,
 * headed by its `path:line` reference; Send to Agent sends them as one message.
 * A raised card on the editor surface (DL-07), at the control radius (DL-03).
 */
export class ClaudeReviewFeedbackTray extends Disposable {
	private readonly _node: HTMLElement;
	private readonly _title: HTMLElement;
	private readonly _list: HTMLElement;
	private readonly _send: HTMLButtonElement;
	private readonly _rows = this._register(new DisposableStore());

	constructor(container: HTMLElement, private readonly _host: ClaudeReviewFeedbackTrayHost) {
		super();
		this._node = append(container, $('.claude-review-feedback'));
		this._node.setAttribute('role', 'region');
		this._node.setAttribute('aria-label', localize('claudeReviewFeedbackTray', "Comments for Claude"));
		const head = append(this._node, $('.claude-review-feedback-head'));
		append(head, $(ThemeIcon.asCSSSelector(Codicon.comment)));
		this._title = append(head, $('span.title'));
		this._title.setAttribute('aria-live', 'polite');
		append(head, $('span.spacer'));
		const clear = append(head, $<HTMLButtonElement>('button.claude-btn.is-small.is-ghost'));
		clear.type = 'button';
		clear.textContent = localize('claudeReviewFeedbackClear', "Discard All");
		this._register(addDisposableListener(clear, EventType.CLICK, () => this._host.clear()));
		this._send = append(head, $<HTMLButtonElement>('button.claude-btn.is-small.is-primary'));
		this._send.type = 'button';
		this._send.textContent = localize('claudeReviewFeedbackSend', "Send to Agent");
		this._send.title = localize('claudeReviewFeedbackSendHint', "Send every comment to the agent as one message. A running turn gets it as the composer would.");
		this._register(addDisposableListener(this._send, EventType.CLICK, () => this._host.send()));
		this._list = append(this._node, $('ul.claude-review-feedback-list'));
		this.render([]);
	}

	/** Height the tray takes above the diff; 0 while it is empty. */
	get height(): number {
		return this._node.classList.contains('is-empty') ? 0 : getTotalHeight(this._node);
	}

	render(items: readonly ClaudeReviewFeedback[], sending = false): void {
		this._rows.clear();
		clearNode(this._list);
		this._node.classList.toggle('is-empty', items.length === 0);
		this._title.textContent = items.length === 1
			? localize('claudeReviewFeedbackOne', "1 comment for Claude")
			: localize('claudeReviewFeedbackMany', "{0} comments for Claude", items.length);
		this._send.disabled = sending || items.length === 0;
		for (const item of [...items].sort(compareClaudeReviewFeedback)) {
			const row = append(this._list, $('li.claude-review-feedback-item'));
			const reference = append(row, $<HTMLButtonElement>('button.reference'));
			reference.type = 'button';
			reference.textContent = claudeLineReference(item.path, item.startLine, item.endLine);
			reference.title = localize('claudeReviewFeedbackReveal', "Show the line");
			this._rows.add(addDisposableListener(reference, EventType.CLICK, () => this._host.reveal(item)));
			const text = append(row, $('span.text'));
			text.textContent = item.text;
			text.title = item.text;
			const remove = append(row, $<HTMLButtonElement>('button.claude-icon-btn'));
			remove.type = 'button';
			remove.setAttribute('aria-label', localize('claudeReviewFeedbackRemove', "Remove Comment"));
			remove.title = localize('claudeReviewFeedbackRemove', "Remove Comment");
			append(remove, $(ThemeIcon.asCSSSelector(Codicon.close)));
			this._rows.add(addDisposableListener(remove, EventType.CLICK, () => this._host.remove(item.id)));
		}
	}
}
