/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { collectReviewHunks } from '../../../../services/claude/common/claudeReview.js';
import { groupHunksByCell } from '../../../../services/claude/common/claudeNotebookReview.js';
import { renderClaudeNotebookCellBar } from '../../browser/review/claudeNotebookCellBar.js';

function notebook(sources: string[]): string {
	const cells = sources.map(source => `    {\n     "cell_type": "code",\n     "source": [\n      ${JSON.stringify(source)}\n     ]\n    }`);
	return `{\n "cells": [\n${cells.join(',\n')}\n ],\n "nbformat": 4\n}\n`;
}

suite('Claude notebook cell bar', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('lists each changed cell with Undo and Keep, and the buttons settle that cell or the whole notebook', () => {
		const uri = URI.file('C:/repo/a.ipynb');
		const before = notebook(['a = 1', 'b = 2', 'c = 3']);
		const after = notebook(['a = 1', 'b = 20', 'c = 30']);
		const changes = groupHunksByCell({ hunks: collectReviewHunks(uri, before, after), originalText: before }, after);
		const store = disposables.add(new DisposableStore());
		const parent = mainWindow.document.createElement('div');
		const calls: string[] = [];
		renderClaudeNotebookCellBar(parent, changes, {
			keepCell: change => calls.push(`keep ${change.index}`),
			undoCell: change => calls.push(`undo ${change.index}`),
			keepAll: () => calls.push('keep all'),
			undoAll: () => calls.push('undo all'),
			keepAllKeys: undefined, undoAllKeys: undefined, keepKeys: undefined, undoKeys: undefined,
		}, store);
		const rows = [...parent.querySelectorAll('.claude-notebook-review-cell')].map(row => (row.querySelector('.name') as HTMLElement).textContent + ' ' + (row.querySelector('.kind') as HTMLElement).textContent);
		assert.deepStrictEqual({ title: parent.querySelector('.title')?.textContent, rows }, { title: '2 changed cells', rows: ['Cell 2 Changed', 'Cell 3 Changed'] });

		const buttons = (selector: string) => [...parent.querySelectorAll(selector + ' button')] as HTMLButtonElement[];
		buttons('.claude-notebook-review-head').forEach(button => button.click());
		const second = buttons('.claude-notebook-review-cell:nth-child(2)');
		second.forEach(button => button.click());
		assert.deepStrictEqual(calls, ['undo all', 'keep all', 'undo 2', 'keep 2']);
		assert.deepStrictEqual(second.map(button => button.textContent), ['Undo', 'Keep']);
	});
});
