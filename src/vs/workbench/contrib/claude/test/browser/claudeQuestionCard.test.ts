/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeElicitationAnswer, ClaudeElicitationRequest } from '../../../../../platform/claude/common/claudeElicitation.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { AgentReducerEvent, AgentViewState, EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../../../services/claude/common/claudeAgentState.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ClaudeTimelineCallbacks, ClaudeTimelineRenderer } from '../../browser/chat/claudeTimelineRenderer.js';
import { timelineBlocks } from '../../common/claudeTimelineModel.js';
import { silentTendService } from './claudeGitHubTestUtils.js';
import { IClaudeTendPullRequestService } from '../../browser/chat/claudeTendPullRequest.js';

const LAYOUT = 'Which layout should the settings page use?';
const CHECKS = 'Which checks should run before a commit?';

const ONE: ClaudeElicitationRequest = {
	id: 'tool-1', server: 'Claude', mode: 'question', message: LAYOUT, expiresAt: 1,
	questions: [{
		question: LAYOUT, header: 'Layout', multiSelect: false,
		options: [{ label: 'Tabs', description: 'One tab per section.' }, { label: 'One page', description: 'Every section on one scrolling page.' }],
	}],
};

const TWO: ClaudeElicitationRequest = {
	id: 'tool-2', server: 'Claude', mode: 'question', message: LAYOUT, expiresAt: 1,
	questions: [
		{
			question: LAYOUT, header: 'Layout', multiSelect: false,
			options: [{ label: 'Tabs', description: 'One tab per section.', preview: '[General] [Editor]' }, { label: 'One page', description: 'Every section on one scrolling page.', preview: 'General\nEditor' }],
		},
		{
			question: CHECKS, header: 'Checks', multiSelect: true,
			options: [{ label: 'Lint', description: 'ESLint on changed files.' }, { label: 'Unit tests', description: 'Node unit tests.' }, { label: 'Types', description: 'A type check.' }],
		},
	],
};

function stateWith(request: ClaudeElicitationRequest, more: readonly AgentReducerEvent[] = []): AgentViewState {
	let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text: 'Go', sent: { compiled: 'Go', mode: 'agent' } });
	const events: AgentReducerEvent[] = [
		{ type: 'tool.started', sessionId: 's', call: { id: request.id, name: 'AskUserQuestion', category: 'other', input: {}, display: { label: 'AskUserQuestion' } } },
		{ type: 'elicitation.requested', sessionId: 's', request },
		...more,
	];
	for (const event of events) {
		state = reduceAgentState(state, event);
	}
	return state;
}

function key(target: HTMLElement, name: string, init: KeyboardEventInit = {}): void {
	target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
}

/**
 * Issue 477, pane level: a question from Claude is a card in the timeline in
 * place of the tool row. One single-choice question answers on the pick;
 * several questions, a multi-select or Other answer together with Submit;
 * Escape declines; an answered card collapses to one line per choice.
 */
suite('Claude question card (issue 477)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiationService: TestInstantiationService;
	let root: HTMLElement;
	let answers: [string, ClaudeElicitationAnswer][];

	setup(() => {
		instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IClaudeTendPullRequestService, silentTendService());
		root = document.createElement('div');
		root.classList.add('claude-pane');
		document.body.appendChild(root);
		store.add({ dispose: () => root.remove() });
		answers = [];
	});

	function render(state: AgentViewState): ClaudeTimelineRenderer {
		const callbacks: ClaudeTimelineCallbacks = {
			retry: () => undefined,
			build: async () => undefined,
			respondPermission: async () => undefined,
			respondElicitation: async (id, answer) => { answers.push([id, answer]); },
			openSubagent: () => undefined,
			stopSubagent: () => undefined,
			copyCommand: () => undefined,
			openInTerminal: () => undefined,
			rerunCommand: () => undefined,
			openCommandLog: () => undefined,
		};
		const timeline = store.add(instantiationService.createInstance(ClaudeTimelineRenderer, root, callbacks));
		timeline.render(state);
		return timeline;
	}

	function card(): HTMLElement {
		const element = root.querySelector<HTMLElement>('.claude-question');
		assert.ok(element);
		return element;
	}

	function options(question = 0): HTMLButtonElement[] {
		return [...card().querySelectorAll<HTMLElement>('.claude-question-item')[question].querySelectorAll<HTMLButtonElement>('.claude-question-option')];
	}

	test('one single-choice question replaces the tool row, shows each option and answers on its number key', async () => {
		const state = stateWith(ONE);
		render(state);
		const drawn = {
			blocks: timelineBlocks(state.turns[0], [], undefined).map(block => block.kind),
			head: card().querySelector('.claude-permission-head')?.textContent,
			ask: card().querySelector('.claude-question-ask')?.textContent,
			options: options().map(option => `${option.getAttribute('role')} | ${option.textContent}`),
			submit: card().querySelector<HTMLButtonElement>('button[data-choice="accept"]')?.disabled,
		};
		key(options()[0], '2');
		await timeout(0);

		assert.deepStrictEqual({ drawn, answers }, {
			drawn: {
				blocks: ['elicitation'],
				head: 'Claude Has a Question',
				ask: `Layout${LAYOUT}`,
				options: [
					'radio | TabsOne tab per section.1',
					'radio | One pageEvery section on one scrolling page.2',
					'radio | OtherType your own answer.3',
				],
				submit: true,
			},
			answers: [['tool-1', { action: 'accept', content: { [LAYOUT]: 'One page' } }]],
		});
	});

	test('several questions answer together: previews beside the options, checkboxes, Other text and Enter to send', async () => {
		render(stateWith(TWO));
		const preview = () => card().querySelector('.claude-question-preview')?.textContent;
		const resting = preview();
		options(0)[1].dispatchEvent(new MouseEvent('mouseenter'));
		const hovered = preview();
		options(0)[0].click();
		const submit = card().querySelector<HTMLButtonElement>('button[data-choice="accept"]')!;
		const afterFirst = { submit: submit.disabled, focusedSecond: options(1).includes(document.activeElement as HTMLButtonElement) };
		key(options(1)[0], '1');
		key(options(1)[0], '3');
		key(options(1)[0], '4');
		const other = card().querySelectorAll<HTMLInputElement>('.claude-question-other input')[1];
		const otherShown = { focused: document.activeElement === other, submit: submit.disabled };
		other.value = 'Spell check';
		other.dispatchEvent(new Event('input', { bubbles: true }));
		key(other, 'Enter');
		await timeout(0);

		assert.deepStrictEqual({
			resting, hovered, afterFirst, otherShown,
			checked: options(1).map(option => option.getAttribute('aria-checked')),
			answers,
		}, {
			resting: 'Tabs[General] [Editor]',
			hovered: 'One pageGeneral\nEditor',
			afterFirst: { submit: true, focusedSecond: true },
			otherShown: { focused: true, submit: true },
			checked: ['true', 'false', 'true', 'true'],
			answers: [['tool-2', { action: 'accept', content: { [LAYOUT]: 'Tabs', [CHECKS]: ['Lint', 'Types', 'Spell check'] } }]],
		});
	});

	test('Escape declines, and a settled card collapses to its answers or to how it ended', async () => {
		const timeline = render(stateWith(TWO));
		key(card(), 'Escape');
		await timeout(0);

		const records = (request: ClaudeElicitationRequest, outcome: AgentReducerEvent) => {
			timeline.render(stateWith(request, [outcome]));
			return [...root.querySelectorAll('.claude-question-record .claude-permission-record')].map(line => line.textContent);
		};
		assert.deepStrictEqual({
			answers,
			answered: records(TWO, { type: 'elicitation.resolved', sessionId: 's', outcome: { id: 'tool-2', server: 'Claude', mode: 'question', action: 'accept', source: 'user', answers: { [LAYOUT]: 'Tabs', [CHECKS]: 'Lint, Types' } } }),
			declined: records(ONE, { type: 'elicitation.resolved', sessionId: 's', outcome: { id: 'tool-1', server: 'Claude', mode: 'question', action: 'decline', source: 'user' } }),
			timedOut: records(TWO, { type: 'elicitation.resolved', sessionId: 's', outcome: { id: 'tool-2', server: 'Claude', mode: 'question', action: 'cancel', source: 'timeout' } }),
		}, {
			answers: [['tool-2', { action: 'decline' }]],
			answered: ['LayoutTabs', 'ChecksLint, Types'],
			declined: [`${LAYOUT}declined`],
			timedOut: ['2 questions from Claudetimed out'],
		});
	});

	test('Reply Instead opens a focused field, Escape closes it before it declines, and Enter sends the reply in place of answers', async () => {
		const timeline = render(stateWith(ONE));
		const open = card().querySelector<HTMLButtonElement>('.claude-question-reply-open')!;
		const row = card().querySelector<HTMLElement>('.claude-question-reply')!;
		const field = row.querySelector<HTMLTextAreaElement>('textarea')!;
		const send = row.querySelector<HTMLButtonElement>('.claude-question-reply-send')!;
		const seen = () => ({ field: row.style.display !== 'none', focused: document.activeElement === field, send: !send.disabled });
		const before = seen();
		open.click();
		const opened = seen();
		key(field, 'Escape');
		const closed = { ...seen(), focusedOpen: document.activeElement === open, answers: answers.length };
		key(open, 'Enter');
		field.value = 'Neither, we already run MongoDB';
		field.dispatchEvent(new Event('input', { bubbles: true }));
		const typed = seen();
		key(field, 'Enter');
		await timeout(0);

		timeline.render(stateWith(ONE, [{ type: 'elicitation.resolved', sessionId: 's', outcome: { id: 'tool-1', server: 'Claude', mode: 'question', action: 'accept', source: 'user', reply: 'Neither, we already run MongoDB' } }]));
		assert.deepStrictEqual({
			before, opened, closed, typed, answers,
			record: [...root.querySelectorAll('.claude-question-record .claude-permission-record')].map(line => line.textContent),
		}, {
			before: { field: false, focused: false, send: false },
			opened: { field: true, focused: true, send: false },
			closed: { field: false, focused: false, send: false, focusedOpen: true, answers: 0 },
			typed: { field: true, focused: true, send: true },
			answers: [['tool-1', { action: 'accept', reply: 'Neither, we already run MongoDB' }]],
			record: ['Replied: Neither, we already run MongoDB'],
		});
	});

	test('Add a Note opens a field under the options, and the note goes with the answer', async () => {
		const timeline = render(stateWith(ONE));
		const link = card().querySelector<HTMLButtonElement>('.claude-question-note-link')!;
		const row = card().querySelector<HTMLElement>('.claude-question-note')!;
		const field = row.querySelector<HTMLInputElement>('input')!;
		const seen = () => ({ link: link.style.display !== 'none', field: row.style.display !== 'none', focused: document.activeElement === field });
		const before = seen();
		link.click();
		const opened = seen();
		key(field, 'Escape');
		const closedEmpty = { ...seen(), focusedLink: document.activeElement === link, answers: answers.length };
		key(link, 'Enter');
		field.value = 'Only for the API service';
		field.dispatchEvent(new Event('input', { bubbles: true }));
		key(field, '1');
		const typedDigit = answers.length;
		options()[0].click();
		await timeout(0);

		timeline.render(stateWith(ONE, [{ type: 'elicitation.resolved', sessionId: 's', outcome: { id: 'tool-1', server: 'Claude', mode: 'question', action: 'accept', source: 'user', answers: { [LAYOUT]: 'Tabs' }, notes: { [LAYOUT]: 'Only for the API service' } } }]));
		assert.deepStrictEqual({
			before, opened, closedEmpty, typedDigit, answers,
			record: [...root.querySelectorAll('.claude-question-record .claude-permission-record')].map(line => line.textContent),
		}, {
			before: { link: true, field: false, focused: false },
			opened: { link: false, field: true, focused: true },
			closedEmpty: { link: true, field: false, focused: false, focusedLink: true, answers: 0 },
			typedDigit: 0,
			answers: [['tool-1', { action: 'accept', content: { [LAYOUT]: 'Tabs' }, notes: { [LAYOUT]: 'Only for the API service' } }]],
			record: ['LayoutTabsNote: Only for the API service'],
		});
	});
});
