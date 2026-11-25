/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeReviewSummary } from '../../../../../platform/claude/common/claudeReviewLoop.js';
import { ClaudeReviewDescriptionState, ClaudeReviewSummaryCard, ClaudeReviewSummaryView, submitClaudeReviewDescription } from '../../browser/review/claudeReviewSummary.js';

suite('Claude review summary header', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const summary: ClaudeReviewSummary = {
		overview: 'Adds a review summary.',
		files: [{ path: 'src/a.ts', risk: 'high', change: 'new parser' }, { path: 'src/b.ts', risk: 'low', change: 'comment' }],
		description: 'New body',
	};
	const open: ClaudeReviewSummaryView = { description: { status: 'open' }, canAccept: true, collapsed: false };

	function create(calls: string[]): { parent: HTMLElement; card: ClaudeReviewSummaryCard } {
		const parent = mainWindow.document.createElement('div');
		const card = store.add(new ClaudeReviewSummaryCard(parent, {
			copy: () => calls.push('copy'),
			copyDescription: () => calls.push('copyDescription'),
			applyDescription: description => calls.push(`apply:${description}`),
			setDescriptionDismissed: dismissed => calls.push(`dismissed:${dismissed}`),
			openChat: () => calls.push('openChat'),
			openFile: path => calls.push(`open:${path}`),
			setCollapsed: collapsed => calls.push(`collapsed:${collapsed}`),
			retry: () => calls.push('retry'),
			drawDiagram: mermaid => {
				calls.push(`draw:${mermaid}`);
				if (mermaid === 'bad') {
					return undefined;
				}
				const drawn = mainWindow.document.createElement('div');
				drawn.className = 'drawn';
				return drawn;
			},
			redrawDiagram: () => calls.push('redraw'),
			writeTest: () => calls.push('writeTest'),
		}));
		return { parent, card };
	}

	function click(parent: HTMLElement, label: string): void {
		[...parent.querySelectorAll('button')].find(button => button.textContent === label)!.click();
	}

	test('shows the overview, one row per file and the proposed description; Copy Summary, Accept, Dismiss and Copy Description reach the host (issues 918, 1087)', () => {
		const calls: string[] = [];
		const { parent, card } = create(calls);
		const hidden = parent.querySelector('.claude-review-summary-card')!.classList.contains('is-empty');
		card.render(summary, true, open);
		const shown = {
			title: parent.querySelector('.title')?.textContent,
			overview: parent.querySelector('.claude-review-summary-overview')?.textContent,
			rows: [...parent.querySelectorAll('.claude-review-summary-files li')].map(row => row.textContent),
			proposal: parent.querySelector('.claude-review-summary-description .body')?.textContent,
		};
		click(parent, 'Copy Summary');
		click(parent, 'Accept');
		click(parent, 'Dismiss');
		click(parent, 'Copy Description');
		card.render(summary, false, open);
		const withoutProposal = parent.querySelector('.claude-review-summary-description') === null;
		card.render(undefined, true, open);
		assert.deepStrictEqual({ hidden, shown, calls, withoutProposal, after: parent.querySelector('.claude-review-summary-card')!.classList.contains('is-empty') }, {
			hidden: true,
			shown: { title: 'Summary (2 files)', overview: 'Adds a review summary.', rows: ['src/a.tsHighnew parser', 'src/b.tsLowcomment'], proposal: 'New body' },
			calls: ['copy', 'apply:New body', 'dismissed:true', 'copyDescription'],
			withoutProposal: true,
			after: true,
		});
	});

	test('file rows open the file and the toggle collapses the card to its head (issue 1088)', () => {
		const calls: string[] = [];
		const { parent, card } = create(calls);
		card.render(summary, true, open);
		click(parent, 'src/b.ts');
		const toggle = parent.querySelector<HTMLButtonElement>('.claude-review-summary-toggle')!;
		const expanded = toggle.getAttribute('aria-expanded');
		toggle.click();
		card.render(summary, true, { ...open, collapsed: true });
		const node = parent.querySelector('.claude-review-summary-card')!;
		assert.deepStrictEqual({
			calls,
			expanded,
			collapsed: node.classList.contains('is-collapsed'),
			collapsedExpanded: parent.querySelector('.claude-review-summary-toggle')!.getAttribute('aria-expanded'),
			body: node.querySelector('.claude-review-summary-files, .claude-review-summary-overview, .claude-review-summary-description') === null,
		}, {
			calls: ['open:src/b.ts', 'collapsed:true'],
			expanded: 'true',
			collapsed: true,
			collapsedExpanded: 'false',
			body: true,
		});
	});

	test('shows a loading line, then the error with Retry, and no Copy Summary without a summary (issue 1078)', () => {
		const calls: string[] = [];
		const { parent, card } = create(calls);
		card.render(undefined, true, { ...open, state: { kind: 'loading' } });
		const loading = { text: parent.textContent, buttons: parent.querySelectorAll('button').length, shown: !parent.firstElementChild!.classList.contains('is-empty') };
		card.render(undefined, true, { ...open, state: { kind: 'failed', message: 'no answer' } });
		const failed = parent.textContent;
		click(parent, 'Retry');
		assert.deepStrictEqual({ loading, failed, calls }, {
			loading: { text: 'Summarizing the changes...', buttons: 0, shown: true },
			failed: 'Could not summarize the changes: no answerRetry',
			calls: ['retry'],
		});
	});

	test('Accept is disabled with a reason without a local folder (issue 1087)', () => {
		const calls: string[] = [];
		const { parent, card } = create(calls);
		card.render(summary, true, { ...open, canAccept: false });
		const accept = [...parent.querySelectorAll('button')].find(button => button.textContent === 'Accept')!;
		accept.click();
		assert.deepStrictEqual({ disabled: accept.disabled, title: accept.title, calls }, {
			disabled: true,
			title: 'Open a local folder to update the pull request',
			calls: [],
		});
	});

	test('shows the error, the sent line and the dismissed line with a way back (issue 1087)', () => {
		const calls: string[] = [];
		const { parent, card } = create(calls);
		card.render(summary, true, { ...open, description: { status: 'open', error: 'offline' } });
		const failed = {
			error: parent.querySelector('.claude-review-summary-description .error')?.textContent,
			accept: [...parent.querySelectorAll('button')].some(button => button.textContent === 'Accept'),
		};
		card.render(summary, true, { ...open, description: { status: 'sent' } });
		const sent = parent.querySelector('.claude-review-summary-description .status')?.textContent;
		click(parent, 'Open Chat');
		card.render(summary, true, { ...open, description: { status: 'dismissed' } });
		const dismissed = parent.querySelector('.claude-review-summary-description .status')?.textContent;
		click(parent, 'Undo');
		click(parent, 'Copy Description');
		assert.deepStrictEqual({ failed, sent, dismissed, calls }, {
			failed: { error: 'Could not send the description to the chat: offline', accept: true },
			sent: 'Sent to the chat. Claude asks before it edits the pull request.',
			dismissed: 'Description dismissed.',
			calls: ['openChat', 'dismissed:false', 'copyDescription'],
		});
	});

	test('a failed send keeps the proposal open with the error; a successful one marks it sent (issue 1087)', async () => {
		const submitted: string[] = [];
		const state: ClaudeReviewDescriptionState = { status: 'open' };
		const failure = await submitClaudeReviewDescription(state, {
			openChat: async () => undefined,
			submit: async () => { throw new Error('no session'); },
		}, 'p');
		const afterFailure = { ...state };
		const noChat = await submitClaudeReviewDescription(state, {
			openChat: async () => { throw new Error('no view'); },
			submit: async prompt => { submitted.push(prompt); },
		}, 'p');
		const afterNoChat = { ...state };
		const success = await submitClaudeReviewDescription(state, {
			openChat: async () => undefined,
			submit: async prompt => { submitted.push(prompt); },
		}, 'body');
		assert.deepStrictEqual({ failure, afterFailure, noChat, afterNoChat, success, state, submitted }, {
			failure: 'no session',
			afterFailure: { status: 'open', error: 'no session' },
			noChat: 'no view',
			afterNoChat: { status: 'open', error: 'no view' },
			success: undefined,
			state: { status: 'sent', error: undefined },
			submitted: ['body'],
		});
	});

	test('the diagram shows with Redraw Diagram, and is hidden when it cannot be drawn (issue 919)', () => {
		const calls: string[] = [];
		const { parent, card } = create(calls);
		card.render({ overview: 'Adds a flow.', files: [], diagram: { kind: 'flow', mermaid: 'flowchart LR\n  A --> B' } }, false, open);
		const shown = parent.querySelectorAll('.claude-review-summary-diagram .drawn').length;
		click(parent, 'Redraw Diagram');
		card.render({ overview: 'Adds a flow.', files: [], diagram: { kind: 'flow', mermaid: 'bad' } }, false, open);
		assert.deepStrictEqual({ shown, calls, hidden: parent.querySelectorAll('.claude-review-summary-diagram').length }, {
			shown: 1,
			calls: ['draw:flowchart LR\n  A --> B', 'redraw', 'draw:bad'],
			hidden: 0,
		});
	});
});
