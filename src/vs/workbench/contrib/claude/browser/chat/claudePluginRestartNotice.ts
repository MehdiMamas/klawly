/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ClaudePluginChange } from '../../../../services/claude/common/claudeAgentService.js';

/**
 * The quiet notice a chat shows when a plugin was installed, updated or removed
 * while its Claude Code query runs. Claude Code reads plugins when it starts, so
 * the session keeps what it had until it restarts (DL-12: nothing for a chat
 * that has not started).
 */
export class ClaudePluginRestartNotice extends Disposable {
	readonly element: HTMLElement;
	private readonly _content = this._register(new MutableDisposable<DisposableStore>());

	constructor(container: HTMLElement) {
		super();
		this.element = append(container, $('.claude-banner.is-info.claude-plugin-restart'));
		this.element.hidden = true;
	}

	/** Shows the changes for one session. Returns true when the notice appeared or went away. */
	sync(sessionId: string | undefined, changes: readonly ClaudePluginChange[], restart: (sessionId: string) => void): boolean {
		const show = !!sessionId && changes.length > 0;
		const toggled = this.element.hidden === show;
		this.element.hidden = !show;
		const key = show ? `${sessionId}\n${changes.map(change => `${change.plugin}:${change.removed ? 1 : 0}`).join('\n')}` : '';
		if (this.element.dataset.key === key) {
			return toggled;
		}
		this.element.dataset.key = key;
		clearNode(this.element);
		if (!show || !sessionId) {
			this._content.clear();
			return toggled;
		}
		const store = new DisposableStore();
		this._content.value = store;
		append(this.element, $(ThemeIcon.asCSSSelector(Codicon.extensions)));
		const body = append(this.element, $('.body'));
		const names = changes.map(change => change.plugin).join(', ');
		append(body, $('.title')).textContent = changes.some(change => change.removed)
			? localize('claudePluginRestartApply', "Restart this session to apply changes to {0}", names)
			: localize('claudePluginRestartLoad', "Restart this session to load {0}", names);
		append(body, $('.desc')).textContent = localize('claudePluginRestartDetail', "Claude Code reads plugins when it starts. The next message resumes this conversation in a new Claude Code session.");
		const actions = append(body, $('.actions'));
		const button = append(actions, $<HTMLButtonElement>('button.claude-btn.is-small'));
		button.type = 'button';
		button.textContent = localize('claudePluginRestartButton', "Restart Session");
		store.add(addDisposableListener(button, EventType.CLICK, () => restart(sessionId)));
		return toggled;
	}
}
