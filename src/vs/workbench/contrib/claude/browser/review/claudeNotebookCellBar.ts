/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { NotebookCellChange } from '../../../../services/claude/common/claudeNotebookReview.js';
import { appendClaudeKbd } from '../chat/claudeKbd.js';

export interface ClaudeNotebookCellBarActions {
	keepCell(change: NotebookCellChange): void;
	undoCell(change: NotebookCellChange): void;
	keepAll(): void;
	undoAll(): void;
	/** The keybinding labels of Keep All and Undo All, when bound. */
	readonly keepAllKeys: string | undefined;
	readonly undoAllKeys: string | undefined;
	/** The keybinding labels of Keep and Undo on one change, when bound. */
	readonly keepKeys: string | undefined;
	readonly undoKeys: string | undefined;
}

/**
 * Keep and Undo for a notebook the agent changed (DL-90), on the notebook diff
 * editor: Undo All and Keep All at the top, then one row per changed cell with the
 * same Undo and Keep chip as a change in the text editor (ai-16).
 */
export function renderClaudeNotebookCellBar(parent: HTMLElement, changes: readonly NotebookCellChange[], actions: ClaudeNotebookCellBarActions, store: DisposableStore): void {
	const bar = append(parent, $('.claude-notebook-review'));
	bar.setAttribute('role', 'group');
	bar.setAttribute('aria-label', localize('claudeNotebookReview', "Claude notebook changes"));
	const head = append(bar, $('.claude-notebook-review-head'));
	append(head, $('span.title')).textContent = changes.length === 1
		? localize('claudeNotebookOneCell', "1 changed cell")
		: localize('claudeNotebookCells', "{0} changed cells", changes.length);
	const all = append(head, $('.claude-hunk-actions.is-chip'));
	chip(all, localize('claudeNotebookUndoAll', "Undo All"), actions.undoAllKeys, false, actions.undoAll, store);
	chip(all, localize('claudeNotebookKeepAll', "Keep All"), actions.keepAllKeys, true, actions.keepAll, store);
	const list = append(bar, $('.claude-notebook-review-cells'));
	for (const change of changes) {
		const row = append(list, $('.claude-notebook-review-cell'));
		const kind = change.kind === 'added'
			? localize('claudeNotebookCellAdded', "Added")
			: change.kind === 'removed'
				? localize('claudeNotebookCellRemoved', "Removed")
				: localize('claudeNotebookCellChanged', "Changed");
		append(row, $('span.name')).textContent = localize('claudeNotebookCellName', "Cell {0}", change.index + 1);
		append(row, $('span.kind')).textContent = kind;
		const buttons = append(row, $('.claude-hunk-actions.is-chip'));
		buttons.setAttribute('role', 'toolbar');
		buttons.setAttribute('aria-label', localize('claudeNotebookCellActions', "Claude change to cell {0}", change.index + 1));
		chip(buttons, localize('claudeHunkUndo', "Undo"), actions.undoKeys, false, () => actions.undoCell(change), store);
		chip(buttons, localize('claudeHunkKeep', "Keep"), actions.keepKeys, true, () => actions.keepCell(change), store);
	}
}

function chip(parent: HTMLElement, label: string, keys: string | undefined, primary: boolean, run: () => void, store: DisposableStore): void {
	const button = append(parent, $<HTMLButtonElement>(primary ? 'button.accept' : 'button'));
	button.type = 'button';
	append(button, $('span.label')).textContent = label;
	if (keys) {
		appendClaudeKbd(button, keys).classList.add('is-quiet');
		button.setAttribute('aria-keyshortcuts', keys);
	}
	store.add(addDisposableListener(button, EventType.CLICK, event => {
		event.preventDefault();
		event.stopPropagation();
		run();
	}));
}
