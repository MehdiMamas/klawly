/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ClaudeModelSwitchNotice, IClaudeModelSwitchService } from '../claudeModelSwitch.js';

/**
 * Issue 703 (DL-83): the notice above the composer after the user picked
 * another model mid-chat. It never blocks: the next message goes either way.
 * Polite live region, so a screen reader hears it once; its buttons are in
 * the tab order.
 */
export class ClaudeModelSwitchNoticeView extends Disposable {
	readonly element: HTMLElement;
	private readonly _content = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		container: HTMLElement,
		private readonly _onDidResize: () => void,
		private readonly _onError: (error: unknown) => void,
		@IClaudeModelSwitchService private readonly _switches: IClaudeModelSwitchService,
	) {
		super();
		this.element = append(container, $('.claude-banner.is-warning.claude-model-switch-notice'));
		this.element.setAttribute('role', 'status');
		this.element.setAttribute('aria-live', 'polite');
		this.element.hidden = true;
	}

	/** Shows the notice of `sessionId`, or hides it. */
	update(sessionId: string | undefined): void {
		const notice = sessionId ? this._switches.getNotice(sessionId) : undefined;
		const key = notice ? `${notice.sessionId}\n${notice.from}\n${notice.to}\n${notice.tokens ?? ''}` : '';
		if (this.element.dataset.key === key) {
			return;
		}
		this.element.dataset.key = key;
		clearNode(this.element);
		this.element.hidden = !notice;
		if (!notice) {
			this._content.clear();
			this._onDidResize();
			return;
		}
		this._content.value = this.render(notice);
		this._onDidResize();
	}

	private render(notice: ClaudeModelSwitchNotice): DisposableStore {
		const store = new DisposableStore();
		append(this.element, $(ThemeIcon.asCSSSelector(Codicon.warning))).setAttribute('aria-hidden', 'true');
		const body = append(this.element, $('.body'));
		append(body, $('.title')).textContent = localize('claudeModelSwitchTitle', "Switching models mid-chat uses more of your usage");
		append(body, $('.desc')).textContent = localize('claudeModelSwitchBody', "{0} hasn't seen this chat yet, so your next message sends the whole conversation to it again without the cache. Start a new chat to keep costs down.", notice.toName);
		if (notice.tokens !== undefined) {
			append(body, $('.desc.claude-model-switch-size')).textContent = localize('claudeModelSwitchSize', "About {0} tokens will be read again.", notice.tokens.toLocaleString());
		}
		const actions = append(body, $('.actions'));
		const button = (label: string, className: string, run: () => unknown) => {
			const element = append(actions, $<HTMLButtonElement>(`button.claude-btn.is-small${className}`));
			element.type = 'button';
			element.textContent = label;
			store.add(addDisposableListener(element, EventType.CLICK, async () => {
				try {
					await run();
				} catch (error) {
					this._onError(error);
				}
			}));
			return element;
		};
		button(localize('claudeModelSwitchKeep', "Keep {0}", notice.toName), '.is-primary', () => this._switches.dismiss(notice.sessionId));
		button(localize('claudeModelSwitchBack', "Switch Back"), '', () => this._switches.switchBack(notice.sessionId));
		button(localize('claudeModelSwitchNewChat', "New Chat with {0}", notice.toName), '', () => this._switches.newChat(notice.sessionId));
		button(localize('claudeModelSwitchNever', "Don't Show Again"), '.is-ghost', () => this._switches.turnOff(notice.sessionId));
		return store;
	}
}
