/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { TodoItem } from '../../../../../platform/claude/common/claudeProtocol.js';
import { claudeTodoProgress } from '../../common/claudeComposerState.js';

/**
 * The agent's to-do list, pinned above the composer as one compact row
 * ("To-dos 2/3" and the current step) that expands to the full list.
 */
export class ClaudeComposerTodos extends Disposable {
	readonly element: HTMLElement;
	private readonly _head: HTMLButtonElement;
	private readonly _chevron: HTMLElement;
	private readonly _count: HTMLElement;
	private readonly _current: HTMLElement;
	private readonly _list: HTMLElement;
	private _expanded = false;
	private _key = '';

	constructor(container: HTMLElement, private readonly _onDidResize: () => void) {
		super();
		this.element = append(container, $('.claude-todo-strip'));
		this.element.hidden = true;
		this._list = append(this.element, $('ol.claude-todo-strip-list'));
		this._list.setAttribute('aria-label', localize('claudeTodos', "To-dos"));
		this._list.hidden = true;
		this._head = append(this.element, $<HTMLButtonElement>('button.claude-todo-strip-head'));
		this._head.type = 'button';
		this._head.setAttribute('aria-expanded', 'false');
		append(this._head, $(ThemeIcon.asCSSSelector(Codicon.checklist)));
		append(this._head, $('span.label')).textContent = localize('claudeTodosLabel', "To-dos");
		this._count = append(this._head, $('span.count'));
		this._current = append(this._head, $('span.current'));
		this._chevron = append(this._head, $(ThemeIcon.asCSSSelector(Codicon.chevronUp)));
		this._register(addDisposableListener(this._head, EventType.CLICK, () => this.toggle()));
	}

	get expanded(): boolean {
		return this._expanded;
	}

	/** Shows the list, or hides the strip when `items` is undefined. */
	update(items: readonly TodoItem[] | undefined): void {
		const key = items ? JSON.stringify(items) : '';
		if (key === this._key) {
			return;
		}
		this._key = key;
		this.element.hidden = !items;
		if (!items) {
			this._onDidResize();
			return;
		}
		const progress = claudeTodoProgress(items);
		this._count.textContent = `${progress.done}/${progress.total}`;
		this._current.textContent = progress.current?.content ?? '';
		this._head.setAttribute('aria-label', localize('claudeTodosProgress', "To-dos, {0} of {1} done", progress.done, progress.total));
		clearNode(this._list);
		for (const item of items) {
			const row = append(this._list, $('li.claude-todo'));
			row.classList.add(item.status === 'completed' ? 'is-done' : item.status === 'in_progress' ? 'is-active' : 'is-pending');
			const icon = item.status === 'completed' ? Codicon.passFilled : item.status === 'in_progress' ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.circleLargeOutline;
			append(row, $('span.state' + ThemeIcon.asCSSSelector(icon))).setAttribute('aria-hidden', 'true');
			append(row, $('span.text')).textContent = item.content;
			append(row, $('span.claude-sr-only')).textContent = item.status === 'completed'
				? localize('claudeTodoDone', "done")
				: item.status === 'in_progress' ? localize('claudeTodoActive', "in progress") : localize('claudeTodoPending', "to do");
		}
		this._onDidResize();
	}

	/** Folds the list away. The composer calls it when another session takes the pane. */
	collapse(): void {
		if (this._expanded) {
			this.toggle();
		}
	}

	private toggle(): void {
		this._expanded = !this._expanded;
		this._list.hidden = !this._expanded;
		this._head.setAttribute('aria-expanded', String(this._expanded));
		this._chevron.className = ThemeIcon.asClassName(this._expanded ? Codicon.chevronDown : Codicon.chevronUp);
		this._onDidResize();
	}
}
