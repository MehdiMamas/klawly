/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventType } from '../../../../../base/browser/dom.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { ClaudeSessionTabs } from '../../browser/chat/claudeSessionTabs.js';
import { TestClaudeGitHubDetailsService } from './claudeGitHubTestUtils.js';

suite('Claude session tabs', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a middle click closes the tab without selecting it, and its press does not start autoscroll (issue 701)', () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		store.add(toDisposable(() => host.remove()));
		const calls: string[] = [];
		const tabs = store.add(new ClaudeSessionTabs(host, {
			select: sessionId => calls.push(`select ${sessionId}`),
			openPullRequest: () => undefined,
			close: sessionId => calls.push(`close ${sessionId}`),
			dragStart: () => undefined,
			reorder: () => undefined,
			contextMenu: () => undefined,
		}, NullHoverService, store.add(new TestClaudeGitHubDetailsService())));
		tabs.update([{ id: 'a', title: 'First', running: false }, { id: 'b', title: 'Second', running: false }], 'a');
		const tab = host.querySelector<HTMLElement>('[data-session-id="b"]')!;

		const press = new MouseEvent(EventType.MOUSE_DOWN, { bubbles: true, cancelable: true, button: 1 });
		tab.dispatchEvent(press);
		tab.dispatchEvent(new MouseEvent(EventType.AUXCLICK, { bubbles: true, cancelable: true, button: 1 }));
		// A right click is the context menu's, not a close.
		tab.dispatchEvent(new MouseEvent(EventType.AUXCLICK, { bubbles: true, cancelable: true, button: 2 }));

		assert.deepStrictEqual({ calls, autoscrollPrevented: press.defaultPrevented }, { calls: ['close b'], autoscrollPrevented: true });
	});

	test('a status from the agent shows a dot by kind and joins the hover text, and goes when cleared (issue 1302)', () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		store.add(toDisposable(() => host.remove()));
		const tabs = store.add(new ClaudeSessionTabs(host, {
			select: () => undefined,
			openPullRequest: () => undefined,
			close: () => undefined,
			dragStart: () => undefined,
			reorder: () => undefined,
			contextMenu: () => undefined,
		}, NullHoverService, store.add(new TestClaudeGitHubDetailsService())));
		const dot = () => host.querySelector<HTMLElement>('.claude-tab-status')!;
		const state = () => ({ hidden: dot().hidden, kind: dot().dataset.kind ?? '', label: host.querySelector('.claude-tab')!.getAttribute('aria-label') });
		tabs.update([{ id: 'a', title: 'First', running: false }], 'a');
		const before = state();
		tabs.update([{ id: 'a', title: 'First', running: false, status: { text: 'Waiting on CI', kind: 'attention' } }], 'a');
		const during = state();
		tabs.update([{ id: 'a', title: 'First', running: false }], 'a');
		assert.deepStrictEqual({ before, during, after: state() }, {
			before: { hidden: true, kind: '', label: 'First' },
			during: { hidden: false, kind: 'attention', label: 'First: Waiting on CI' },
			after: { hidden: true, kind: '', label: 'First' },
		});
	});

	function strip(moves: string[]): HTMLElement {
		const host = document.createElement('div');
		document.body.appendChild(host);
		store.add(toDisposable(() => host.remove()));
		const tabs = store.add(new ClaudeSessionTabs(host, {
			select: () => undefined,
			openPullRequest: () => undefined,
			close: () => undefined,
			dragStart: () => undefined,
			reorder: (sessionId, before) => moves.push(`${sessionId} before ${before ?? 'end'}`),
			contextMenu: () => undefined,
		}, NullHoverService, store.add(new TestClaudeGitHubDetailsService())));
		tabs.update([{ id: 'a', title: 'A', running: false }, { id: 'b', title: 'B', running: false }, { id: 'c', title: 'C', running: false }], 'a');
		return host;
	}

	test('Alt+Arrow moves a tab one place and stops at the ends (issue 964)', () => {
		const moves: string[] = [];
		const host = strip(moves);
		const press = (id: string, key: string) => host.querySelector<HTMLElement>(`[data-session-id="${id}"]`)!
			.dispatchEvent(new KeyboardEvent(EventType.KEY_DOWN, { bubbles: true, cancelable: true, key, altKey: true }));

		press('b', 'ArrowLeft');
		press('b', 'ArrowRight');
		press('a', 'ArrowLeft');
		press('c', 'ArrowRight');

		assert.deepStrictEqual(moves, ['b before a', 'b before end']);
	});

	test('dropping a tab on the right half of another places it after, on the left half before (issue 964)', () => {
		const moves: string[] = [];
		const host = strip(moves);
		const target = host.querySelector<HTMLElement>('[data-session-id="b"]')!;
		const rect = target.getBoundingClientRect();
		const dropAt = (dragged: string, clientX: number) => {
			const dataTransfer = new DataTransfer();
			dataTransfer.setData('application/x-claude-tab-reorder', dragged);
			target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX }));
		};

		dropAt('a', rect.right - 1);
		dropAt('c', rect.left + 1);

		assert.deepStrictEqual(moves, ['a before c', 'c before b']);
	});
});
