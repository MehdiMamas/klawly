/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ClaudeTerminalHandoff } from '../../common/claudeTerminalHandoff.js';

/**
 * The quiet card a chat shows when it continues a terminal session with a handoff note (issue 1186):
 * what the terminal session was working on, what is open and what waits on the user. It is read-only
 * and stays until dismissed (DL-07 info tone; DL-12: nothing for a chat without a note).
 */
export class ClaudeHandoffCard extends Disposable {
	readonly element: HTMLElement;
	private readonly _content = this._register(new MutableDisposable<DisposableStore>());

	constructor(container: HTMLElement) {
		super();
		this.element = append(container, $('.claude-banner.is-info.claude-handoff-card'));
		this.element.hidden = true;
	}

	/** Shows the card for one session. Returns true when the card appeared or went away. */
	sync(sessionId: string | undefined, card: ClaudeTerminalHandoff | undefined, dismiss: (sessionId: string) => void): boolean {
		const show = !!sessionId && !!card;
		const toggled = this.element.hidden === show;
		this.element.hidden = !show;
		const key = show ? `${sessionId}\n${JSON.stringify(card)}` : '';
		if (this.element.dataset.key === key) {
			return toggled;
		}
		this.element.dataset.key = key;
		clearNode(this.element);
		if (!show || !sessionId || !card) {
			this._content.clear();
			return toggled;
		}
		const store = new DisposableStore();
		this._content.value = store;
		append(this.element, $(ThemeIcon.asCSSSelector(Codicon.terminal)));
		const body = append(this.element, $('.body'));
		append(body, $('.title')).textContent = localize('claudeHandoffCardTitle', "From the Terminal");
		if (card.summary) {
			append(body, $('.desc')).textContent = card.summary;
		}
		const sections: [string, readonly string[]][] = [
			[localize('claudeHandoffCardGoals', "Goals"), card.goals],
			[localize('claudeHandoffCardOpen', "Open"), card.open],
			[localize('claudeHandoffCardWaiting', "Waiting on you"), card.waitingOnUser],
			[localize('claudeHandoffCardDecisions', "Decisions"), card.decisions],
		];
		for (const [label, items] of sections) {
			if (items.length === 0) {
				continue;
			}
			const section = append(body, $('.handoff-section'));
			append(section, $('.desc')).textContent = label;
			const list = append(section, $('ul'));
			for (const item of items) {
				append(list, $('li')).textContent = item;
			}
		}
		const actions = append(body, $('.actions'));
		const button = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small'));
		button.type = 'button';
		button.textContent = localize('claudeHandoffCardDismiss', "Dismiss");
		store.add(addDisposableListener(button, EventType.CLICK, () => dismiss(sessionId)));
		return toggled;
	}
}
