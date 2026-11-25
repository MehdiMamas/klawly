/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeElicitationAnswer, ClaudeElicitationRequest } from '../../../../../platform/claude/common/claudeElicitation.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IOpenerService, OpenOptions } from '../../../../../platform/opener/common/opener.js';
import { AgentReducerEvent, AgentViewState, EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../../../services/claude/common/claudeAgentState.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ClaudeTimelineCallbacks, ClaudeTimelineRenderer } from '../../browser/chat/claudeTimelineRenderer.js';
import { silentTendService } from './claudeGitHubTestUtils.js';
import { IClaudeTendPullRequestService } from '../../browser/chat/claudeTendPullRequest.js';

const FORM: ClaudeElicitationRequest = {
	id: 'e1', server: 'deploy-bot', mode: 'form', title: 'Create a release', message: 'Fill in the release details.', expiresAt: 1,
	schema: {
		type: 'object',
		properties: {
			name: { type: 'string', title: 'Release name', minLength: 3 },
			build: { type: 'integer', title: 'Build number', description: 'The CI build to release.' },
			env: { type: 'string', title: 'Environment', enum: ['staging', 'prod'] },
			notify: { type: 'boolean', title: 'Notify the team channel' },
			regions: { type: 'array', title: 'Regions', items: { type: 'string', enum: ['eu', 'us'] } },
		},
		required: ['name', 'env'],
	},
};

const SIGN_IN: ClaudeElicitationRequest = {
	id: 'e2', server: 'tracker', mode: 'url', message: 'Sign in so tracker can search your issues.', expiresAt: 1,
	url: 'https://auth.tracker-login.test/start?state=abc', urlHost: 'auth.tracker-login.test', serverHost: 'mcp.tracker.test', elicitationId: 'srv-1',
};

function stateWith(request: ClaudeElicitationRequest, more: readonly AgentReducerEvent[] = []): AgentViewState {
	let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text: 'Go', sent: { compiled: 'Go', mode: 'agent' } });
	for (const event of [{ type: 'elicitation.requested', sessionId: 's', request } satisfies AgentReducerEvent, ...more]) {
		state = reduceAgentState(state, event);
	}
	return state;
}

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Issue 428, pane level: the MCP form card draws the server's schema as fields,
 * validates on Submit and answers with the content; a schema MCP does not allow
 * falls back to one JSON field; the sign-in card shows the full host, warns when
 * it is not the server's, opens the link outside Klawly and turns into
 * "Signed in to <server>" when the server says so.
 */
suite('Claude MCP elicitation card (issue 428)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiationService: TestInstantiationService;
	let root: HTMLElement;
	let answers: [string, ClaudeElicitationAnswer][];
	let opened: [string, OpenOptions | undefined][];

	setup(() => {
		instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IClaudeTendPullRequestService, silentTendService());
		opened = [];
		instantiationService.stub(IOpenerService, {
			open: async (target: URI | string, options?: OpenOptions) => {
				opened.push([target.toString(), options]);
				return true;
			},
		} as unknown as IOpenerService);
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
		const element = root.querySelector<HTMLElement>('.claude-elicitation');
		assert.ok(element);
		return element;
	}

	function button(choice: string): HTMLButtonElement {
		const element = card().querySelector<HTMLButtonElement>(`button[data-choice="${choice}"]`);
		assert.ok(element);
		return element;
	}

	function fields(): string[] {
		return [...card().querySelectorAll<HTMLElement>('.claude-elicitation-field')].map(field => {
			const widget = field.querySelector('.monaco-select-box') ? 'select' : field.querySelector('.claude-elicitation-options') ? 'options' : field.querySelector('.monaco-checkbox') ? 'checkbox' : 'input';
			const label = field.querySelector('.claude-elicitation-label, .claude-elicitation-check-label')?.textContent ?? '';
			const problem = field.querySelector('.claude-elicitation-problem')?.textContent ?? '';
			return `${label} | ${widget}${field.classList.contains('is-invalid') ? ' | invalid' : ''}${problem ? ` | ${problem}` : ''}`;
		});
	}

	test('a form draws its schema as fields, shows problems on Submit and sends the content', async () => {
		render(stateWith(FORM));
		const drawn = { head: card().querySelector('.claude-permission-head')?.textContent, fields: fields(), primary: card().querySelectorAll('.claude-btn.is-primary').length };
		button('accept').click();
		await timeout(0);
		const invalid = { fields: fields(), answers: [...answers] };

		const inputs = card().querySelectorAll<HTMLInputElement>('.claude-elicitation-input input');
		type(inputs[0], 'v2.1');
		type(inputs[1], '418');
		const select = card().querySelector<HTMLSelectElement>('select');
		assert.ok(select);
		select.selectedIndex = 2;
		select.dispatchEvent(new Event('change', { bubbles: true }));
		button('accept').click();
		await timeout(0);
		await timeout(0);

		assert.deepStrictEqual({ drawn, invalid, answers }, {
			drawn: {
				head: 'Create a releasedeploy-bot',
				fields: ['Release name* | input', 'Build number | input', 'Environment* | select', 'Notify the team channel | checkbox', 'Regions | options'],
				primary: 1,
			},
			invalid: {
				fields: [
					'Release name* | input | invalid | This field is required.',
					'Build number | input',
					'Environment* | select | invalid | This field is required.',
					'Notify the team channel | checkbox',
					'Regions | options',
				],
				answers: [],
			},
			answers: [['e1', { action: 'accept', content: { name: 'v2.1', build: 418, env: 'prod', notify: false } }]],
		});
	});

	test('a schema MCP does not allow is one JSON field; Escape declines', async () => {
		const timeline = render(stateWith({ ...FORM, schema: { type: 'object', properties: { nested: { type: 'object' } } } }));
		const textarea = card().querySelector<HTMLTextAreaElement>('.claude-elicitation-json textarea');
		assert.ok(textarea);
		type(textarea, '{ nope');
		button('accept').click();
		await timeout(0);
		const problem = card().querySelector('.claude-elicitation-problem')?.textContent;
		type(textarea, '{"nested": "flat now"}');
		button('accept').click();
		await timeout(0);
		await timeout(0);

		timeline.render(stateWith({ ...FORM, id: 'e3' }));
		card().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await timeout(0);

		assert.deepStrictEqual({ problem, answers }, {
			problem: 'This is not valid JSON.',
			answers: [['e1', { action: 'accept', content: { nested: 'flat now' } }], ['e3', { action: 'decline' }]],
		});
	});

	test('a sign-in shows the full host, warns off the server host, opens outside Klawly and becomes Signed in', async () => {
		const timeline = render(stateWith(SIGN_IN));
		const drawn = {
			meta: [...card().querySelectorAll('.claude-permission-meta dt, .claude-permission-meta dd')].map(cell => cell.textContent),
			warning: card().querySelector('.claude-elicitation-warning')?.textContent,
			buttons: [...card().querySelectorAll('button')].map(element => element.textContent),
		};
		button('accept').click();
		await timeout(0);
		await timeout(0);

		timeline.render(stateWith(SIGN_IN, [
			{ type: 'elicitation.resolved', sessionId: 's', outcome: { id: 'e2', server: 'tracker', mode: 'url', action: 'accept', source: 'user' } },
			{ type: 'elicitation.completed', sessionId: 's', server: 'tracker', elicitationId: 'srv-1' },
		]));
		const record = root.querySelector('.claude-elicitation-record')?.textContent;

		assert.deepStrictEqual({ drawn, opened, answers, record }, {
			drawn: {
				meta: ['Opens', 'auth.tracker-login.test', 'Server', 'mcp.tracker.test'],
				warning: 'This link is not on the server\'s host. Open it only if you expect tracker to sign you in there.',
				buttons: ['Open in Browser', 'Decline'],
			},
			opened: [['https://auth.tracker-login.test/start?state=abc', { openExternal: true, fromUserGesture: true }]],
			answers: [['e2', { action: 'accept' }]],
			record: 'Signed in to tracker',
		});
	});
});
