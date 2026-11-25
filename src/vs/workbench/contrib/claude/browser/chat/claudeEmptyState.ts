/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { appendClaudeKbd } from './claudeKbd.js';

export interface ClaudeEmptyShortcut {
	readonly label: string;
	/** Keybinding label. Rows without a key are left out. */
	readonly keys: string | undefined;
}

export interface ClaudeEmptyRecent {
	readonly id: string;
	readonly title: string;
	readonly detail: string;
	readonly icon: ThemeIcon;
}

export interface ClaudeEmptyStateModel {
	readonly markUri: string;
	readonly shortcuts: readonly ClaudeEmptyShortcut[];
	readonly recent: readonly ClaudeEmptyRecent[];
}

/**
 * The new-agent empty state (spec 01): the mark, the heading, the keys that
 * matter most, and the latest sessions to pick up again (audit 21).
 */
export function renderClaudeEmptyState(container: HTMLElement, model: ClaudeEmptyStateModel, store: DisposableStore, openRecent: (sessionId: string) => void): HTMLElement {
	const empty = append(container, $('.claude-empty'));
	const mark = append(empty, $<HTMLImageElement>('img.mark'));
	mark.src = model.markUri;
	mark.alt = '';
	append(empty, $('h2')).textContent = localize('claudeEmptyTitle', "What should we build?");

	if (model.shortcuts.some(shortcut => !!shortcut.keys)) {
		const list = append(empty, $('dl.claude-shortcuts'));
		list.setAttribute('aria-label', localize('claudeEmptyShortcuts', "Shortcuts"));
		for (const shortcut of model.shortcuts) {
			if (shortcut.keys) {
				append(list, $('dt')).textContent = shortcut.label;
				appendClaudeKbd(append(list, $('dd')), shortcut.keys);
			}
		}
	}

	if (model.recent.length > 0) {
		const recent = append(empty, $('.claude-recent'));
		const label = append(recent, $('.claude-section-label'));
		append(label, $('span')).textContent = localize('claudeEmptyRecent', "Recent");
		const list = append(recent, $('div'));
		list.setAttribute('role', 'list');
		list.setAttribute('aria-label', localize('claudeEmptyRecentLabel', "Recent agent sessions"));
		for (const session of model.recent) {
			const item = append(list, $('div'));
			item.setAttribute('role', 'listitem');
			const row = append(item, $<HTMLButtonElement>('button.claude-session-row'));
			row.type = 'button';
			row.setAttribute('data-session-id', session.id);
			append(row, $('span.icon' + ThemeIcon.asCSSSelector(session.icon)));
			const main = append(row, $('span.main'));
			append(main, $('span.title')).textContent = session.title;
			if (session.detail) {
				append(main, $('span.sub')).textContent = session.detail;
			}
			store.add(addDisposableListener(row, EventType.CLICK, () => openRecent(session.id)));
		}
	}
	return empty;
}
