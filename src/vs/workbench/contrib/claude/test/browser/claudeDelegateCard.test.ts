/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeDelegateCard } from '../../../../services/claude/common/claudeDelegationModel.js';
import { ClaudeDelegateCardActions, renderClaudeDelegateCard } from '../../browser/chat/claudeDelegateCard.js';

/**
 * The delegate card (issue 693, DL-71): the task, "Model · effort · time", the
 * state in one word, the start of the answer, and Stop, Rerun and Open Chat.
 */
suite('Claude delegate card', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function card(extra: Partial<ClaudeDelegateCard> = {}): ClaudeDelegateCard {
		return { id: 'd1', parentSessionId: 's', parentTurnId: 't', childSessionId: 'c1', task: 'Fix the off-by-one', title: 'Fix the off-by-one', modelLabel: 'Sonnet', effort: 'high', auto: true, state: 'running', children: [], startedAt: 0, ...extra };
	}

	function paint(model: ClaudeDelegateCard, parentRunning = true): { element: HTMLElement; clicks: string[] } {
		const clicks: string[] = [];
		const actions: ClaudeDelegateCardActions = {
			open: id => clicks.push(`open:${id}`),
			stop: id => clicks.push(`stop:${id}`),
			rerun: id => clicks.push(`rerun:${id}`),
			retry: id => clicks.push(`retry:${id}`),
			retryOnOpus: id => clicks.push(`retryOnOpus:${id}`),
			openLog: id => clicks.push(`log:${id}`),
			hover: (_target, content) => {
				clicks.push(`hover:${content}`);
				return { dispose() { } };
			},
		};
		const disposables = store.add(new DisposableStore());
		const element = renderClaudeDelegateCard(document.createElement('div'), model, parentRunning, actions, disposables, 12_000);
		for (const button of element.querySelectorAll<HTMLButtonElement>(':scope > .claude-delegate-actions > button')) {
			button.click();
		}
		return { element, clicks };
	}

	test('the routing reason is one line under the title, with the router why in its hover (issue 987)', () => {
		const routed = paint(card({ routeReason: ' writes code from a stated cause ', routeWhy: 'tier and reason given' }));
		const plain = paint(card());
		assert.deepStrictEqual([
			routed.element.querySelector('.claude-delegate-head .body > .reason')?.textContent,
			routed.clicks.filter(click => click.startsWith('hover:')),
			plain.element.querySelector('.claude-delegate-head .reason'),
			plain.clicks.filter(click => click.startsWith('hover:')),
		], [
			'Sonnet: writes code from a stated cause',
			['hover:Sonnet: writes code from a stated cause (tier and reason given)'],
			null,
			[],
		]);
	});

	function describe(element: HTMLElement): unknown {
		return {
			className: element.className,
			title: element.querySelector(':scope > .claude-delegate-head .title')?.textContent,
			meta: element.querySelector(':scope > .claude-delegate-head .meta')?.textContent,
			state: element.querySelector(':scope > .claude-delegate-head > .state')?.textContent,
			result: element.querySelector(':scope > .claude-delegate-result')?.textContent,
			buttons: [...element.querySelectorAll(':scope > .claude-delegate-actions > button')].map(button => button.textContent),
			children: [...element.querySelectorAll(':scope > .claude-delegate-children > .claude-delegate')].map(child => describe(child as HTMLElement)),
		};
	}

	test('working, done, stopped with Rerun, and nested cards under a stopped parent', () => {
		const working = paint(card({ children: [card({ id: 'd2', childSessionId: 'c2', title: 'Look up readToken', modelLabel: 'Haiku', effort: undefined })] }));
		const done = paint(card({ state: 'done', endedAt: 4_000, costUsd: 0.04, result: '**Fixed** `readToken`.\n- Added a test.\nRan it.\nAll green.' }));
		const stopped = paint(card({ state: 'stopped', stoppedByUser: true, rerun: true, endedAt: 2_000 }));
		const orphan = paint(card(), false);
		assert.deepStrictEqual({
			working: [describe(working.element), working.clicks],
			done: [describe(done.element), done.clicks],
			stopped: [describe(stopped.element), stopped.clicks],
			orphan: describe(orphan.element),
		}, {
			working: [{
				className: 'claude-delegate is-running',
				title: 'Worker Fix the off-by-one',
				meta: 'Sonnet · High · 12s',
				state: 'Working',
				result: undefined,
				buttons: ['Open Chat', 'Stop'],
				children: [{ className: 'claude-delegate is-running', title: 'Worker Look up readToken', meta: 'Haiku · 12s', state: 'Working', result: undefined, buttons: ['Open Chat', 'Stop'], children: [] }],
			}, ['open:c1', 'stop:d1']],
			done: [{
				className: 'claude-delegate is-done',
				title: 'Worker Fix the off-by-one',
				meta: 'Sonnet · High · 4s · $0.04',
				state: 'Done',
				result: 'Fixed readToken.\nAdded a test.\nRan it.…',
				buttons: ['Open Chat'],
				children: [],
			}, ['open:c1']],
			stopped: [{
				className: 'claude-delegate is-stopped',
				title: 'Worker Fix the off-by-one',
				meta: 'Sonnet · High · 2s',
				state: 'Stopped by you',
				result: undefined,
				buttons: ['Open Chat', 'Rerun'],
				children: [],
			}, ['open:c1', 'rerun:d1']],
			orphan: { className: 'claude-delegate is-stopped', title: 'Worker Fix the off-by-one', meta: 'Sonnet · High · 12s', state: 'Stopped', result: undefined, buttons: ['Open Chat'], children: [] },
		});
	});
	test('a contract shows the objective, tier, budget and the report; a quiet worker says so', () => {
		const lines = (element: HTMLElement) => [...element.querySelectorAll(':scope > .claude-delegate-contract > .claude-delegate-contract-line')].map(line => line.textContent);
		const running = paint(card({ objective: 'Fix readToken', acceptance: 'The test passes', tier: 'small', budget: { usd: 0.5, calls: 40 }, costUsd: 0.04, callsUsed: 12, budgetState: 'notice' }));
		const done = paint(card({ state: 'done', endedAt: 4_000, tier: 'small', result: 'Done.', report: 'Status: done.\nAdded a test.' }));
		const quiet = paint(card({ state: 'done', endedAt: 4_000, quiet: true, report: '' }));
		assert.deepStrictEqual({
			running: [(describe(running.element) as { meta: string }).meta, lines(running.element), running.element.querySelector('.is-notice') !== null],
			report: [element(done.element, '.is-report'), (describe(done.element) as { meta: string }).meta],
			quiet: element(quiet.element, '.is-quiet'),
		}, {
			running: ['Sonnet · Small tier · High · 12s · $0.04', ['ObjectiveFix readToken', 'Done whenThe test passes', 'Budget$0.04 of $0.50 · 12 of 40 calls'], true],
			report: ['Status: done.\nAdded a test.', 'Sonnet · Small tier · High · 4s'],
			quiet: 'Nothing to report.',
		});
	});

	test('a finished worker folds its contract behind a toggle and ends on its outcome (#1260)', () => {
		const shape = (root: HTMLElement) => ({
			folded: root.querySelector(':scope > .claude-delegate-contract')?.classList.contains('is-folded'),
			toggle: root.querySelector(':scope > .claude-delegate-head > .claude-delegate-toggle') !== null,
			end: root.querySelector(':scope > .claude-delegate-end')?.textContent,
		});
		const running = paint(card({ objective: 'Fix readToken' }));
		const done = paint(card({ state: 'done', endedAt: 4_000, objective: 'Fix readToken', report: 'Status: done.' }));
		assert.deepStrictEqual({ running: shape(running.element), done: shape(done.element) }, {
			running: { folded: false, toggle: false, end: undefined },
			done: { folded: true, toggle: true, end: 'Done' },
			});
		});

	test('issue 1220: a failed card gives its reason with Retry on Opus, Retry and Open Log, and a plain aria label', () => {
		const failed = paint(card({ state: 'failed', endedAt: 3_000, message: 'Tests failed twice' }));
		assert.deepStrictEqual({
			result: element(failed.element, '.is-error'),
			buttons: (describe(failed.element) as { buttons: unknown }).buttons,
			clicks: failed.clicks,
			aria: failed.element.getAttribute('aria-label'),
		}, {
			result: 'Tests failed twice',
			buttons: ['Open Chat', 'Retry on Opus', 'Retry', 'Open Log'],
			clicks: ['open:c1', 'retryOnOpus:d1', 'retry:d1', 'log:c1'],
			aria: 'Delegated to Sonnet: Fix the off-by-one. Auto: Failed, Tests failed twice, Sonnet',
		});
	});

	test('issue 1501: a helper waiting on the user or stopped at its limit shows Waiting for you or Limit reached', () => {
		const waiting = paint(card({ waiting: true, waitingQuestion: 'Use the new API?' }));
		const guard = paint(card({ state: 'failed', endedAt: 3_000, budgetState: 'stop', message: 'Stopped at its budget.', costUsd: 2 }));
		const view = (p: { element: HTMLElement }) => ({
			className: p.element.className,
			state: p.element.querySelector(':scope > .claude-delegate-head > .state')?.textContent,
			aria: p.element.getAttribute('aria-label'),
			result: p.element.querySelector(':scope > .claude-delegate-result')?.textContent,
		});
		assert.deepStrictEqual({ waiting: view(waiting), guard: view(guard) }, {
			waiting: { className: 'claude-delegate is-running is-waiting', state: 'Waiting for you', aria: 'Delegated to Sonnet: Fix the off-by-one. Auto: Waiting for you, Use the new API?, Sonnet', result: undefined },
			guard: { className: 'claude-delegate is-failed is-guard', state: 'Limit reached', aria: 'Delegated to Sonnet: Fix the off-by-one. Auto: Limit reached, $2.00 used, $2.00', result: 'Stopped at its budget.' },
		});
	});

	function element(root: HTMLElement, selector: string): string | null | undefined {
		return root.querySelector(`:scope > .claude-delegate-result${selector}`)?.textContent;
	}
});
