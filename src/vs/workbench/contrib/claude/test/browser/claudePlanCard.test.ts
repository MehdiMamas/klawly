/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { getActiveElement } from '../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentFailureKind } from '../../../../../platform/claude/common/claudeProtocol.js';
import { PlanArtifact } from '../../../../../platform/claude/common/claudePlan.js';
import { planFileKey } from '../../../../../platform/claude/common/claudePlanDocument.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { AgentViewState, EMPTY_AGENT_VIEW_STATE, reduceAgentState } from '../../../../services/claude/common/claudeAgentState.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { TestEditorService, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ClaudeTimelineCallbacks, ClaudeTimelineRenderer } from '../../browser/chat/claudeTimelineRenderer.js';
import { ClaudePlanInput } from '../../browser/plan/claudePlanEditor.js';
import { silentTendService } from './claudeGitHubTestUtils.js';
import { IClaudeTendPullRequestService } from '../../browser/chat/claudeTendPullRequest.js';

const PLAN_ANSWER = '# Add expiry\n\nReject expired coupons.\n\n1. Check `expiresAt` in `src/coupon.ts`\n2. Return a typed error\n3. Add tests';

function planState(): AgentViewState {
	let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 'turn-1', text: 'Plan expiry', sent: { compiled: 'Plan expiry', mode: 'plan' } });
	state = reduceAgentState(state, { type: 'assistant.completed', sessionId: 's', text: PLAN_ANSWER });
	return reduceAgentState(state, { type: 'session.completed', sessionId: 's' });
}

function failedState(kind: AgentFailureKind): AgentViewState {
	const state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: `turn-${kind}`, text: 'Go' });
	return reduceAgentState(state, { type: 'session.failed', sessionId: 's', message: 'failed', kind });
}

function key(target: Element, init: KeyboardEventInit): KeyboardEvent {
	const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(event);
	return event;
}

suite('Claude plan card and failure banner', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiationService: TestInstantiationService;
	let root: HTMLElement;
	let builds: { notes: string; plan?: PlanArtifact }[];
	let opens: { notes: string; plan: PlanArtifact }[];
	let statusOpened: number;

	setup(() => {
		instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IClaudeTendPullRequestService, silentTendService());
		root = document.createElement('div');
		document.body.appendChild(root);
		store.add({ dispose: () => root.remove() });
		builds = [];
		opens = [];
		statusOpened = 0;
	});

	function renderer(withStatus = true): ClaudeTimelineRenderer {
		const callbacks: ClaudeTimelineCallbacks = {
			retry: () => undefined,
			build: async (_turnId, notes, plan) => { builds.push({ notes, plan }); },
			openPlan: async (_turnId, notes, plan) => { opens.push({ notes, plan }); },
			openStatus: withStatus ? () => { statusOpened++; } : undefined,
			respondPermission: async () => undefined,
			openSubagent: () => undefined,
			stopSubagent: () => undefined,
			copyCommand: () => undefined,
			openInTerminal: () => undefined,
			rerunCommand: () => undefined,
			openCommandLog: () => undefined,
		};
		return store.add(instantiationService.createInstance(ClaudeTimelineRenderer, root, callbacks));
	}

	function button(selector: string): HTMLButtonElement {
		const element = root.querySelector(selector);
		assert.ok(element instanceof HTMLButtonElement, selector);
		return element;
	}

	function inputs(): HTMLInputElement[] {
		return [...root.querySelectorAll('input.claude-plan-step-input')].filter((element): element is HTMLInputElement => element instanceof HTMLInputElement);
	}

	function titles(): string[] {
		return [...root.querySelectorAll('.claude-plan li.claude-todo .text .title')].map(title => title.textContent ?? '');
	}

	test('plan edits, notes and an open sent prompt survive a repaint, and go once their turn is gone', () => {
		const timeline = renderer();
		const state = planState();
		timeline.render(state);
		button('button.claude-plan-edit').click();
		key(inputs()[0], { key: 'ArrowDown', altKey: true });
		key(inputs()[1], { key: 'Escape' });
		const notes = () => root.querySelector('textarea.claude-plan-notes') as HTMLTextAreaElement;
		notes().value = 'keep the API';
		notes().dispatchEvent(new Event('input', { bubbles: true }));
		timeline.revealSentPrompt('turn-1');
		const repaint = () => {
			timeline.reset();
			timeline.render(state);
			return { titles: titles(), notes: notes().value, sentOpen: root.querySelector('pre.claude-sent-prompt')?.hasAttribute('hidden') === false };
		};
		timeline.retainTurns(new Set(['turn-1']));
		const kept = repaint();
		timeline.retainTurns(new Set());
		const forgotten = repaint();
		assert.deepStrictEqual({ kept, forgotten }, {
			kept: { titles: ['Return a typed error', 'Check expiresAt in src/coupon.ts', 'Add tests'], notes: 'keep the API', sentOpen: true },
			forgotten: { titles: ['Check expiresAt in src/coupon.ts', 'Return a typed error', 'Add tests'], notes: '', sentOpen: false },
		});
	});

	test('Edit Plan renames and reorders steps with buttons and keys, and Build and Open Plan get that plan', async () => {
		renderer().render(planState());
		assert.deepStrictEqual(titles(), ['Check expiresAt in src/coupon.ts', 'Return a typed error', 'Add tests']);

		const edit = button('button.claude-plan-edit');
		assert.strictEqual(edit.getAttribute('aria-pressed'), 'false');
		edit.click();
		assert.deepStrictEqual(inputs().map(input => input.value), ['Check expiresAt in src/coupon.ts', 'Return a typed error', 'Add tests']);
		assert.strictEqual(getActiveElement(), inputs()[0]);
		assert.strictEqual(button('button.claude-plan-edit').getAttribute('aria-pressed'), 'true');

		// Alt+Down moves the focused step and focus follows it.
		assert.strictEqual(key(inputs()[0], { key: 'ArrowDown', altKey: true }).defaultPrevented, true);
		assert.deepStrictEqual(inputs().map(input => input.value), ['Return a typed error', 'Check expiresAt in src/coupon.ts', 'Add tests']);
		assert.strictEqual(getActiveElement(), inputs()[1]);

		// Move Up on the last step; the first step's Move Up is disabled.
		const upButtons = [...root.querySelectorAll('.claude-plan-step-tools button')].filter((_element, index) => index % 2 === 0) as HTMLButtonElement[];
		assert.deepStrictEqual(upButtons.map(element => element.disabled), [true, false, false]);
		upButtons[2].click();
		assert.deepStrictEqual(inputs().map(input => input.value), ['Return a typed error', 'Add tests', 'Check expiresAt in src/coupon.ts']);

		// Typing renames; a blank title is not kept.
		const second = inputs()[1];
		second.value = 'Add unit tests';
		second.dispatchEvent(new Event('input', { bubbles: true }));
		const third = inputs()[2];
		third.value = '   ';
		third.dispatchEvent(new Event('input', { bubbles: true }));
		third.dispatchEvent(new FocusEvent('blur'));
		assert.strictEqual(third.value, 'Check expiresAt in src/coupon.ts');

		// Enter goes to the next field; Escape leaves edit mode and focuses Edit Plan.
		key(inputs()[0], { key: 'Enter' });
		assert.strictEqual(getActiveElement(), inputs()[1]);
		key(inputs()[1], { key: 'Escape' });
		assert.strictEqual(inputs().length, 0);
		assert.strictEqual(getActiveElement(), button('button.claude-plan-edit'));
		assert.deepStrictEqual(titles(), ['Return a typed error', 'Add unit tests', 'Check expiresAt in src/coupon.ts']);
		assert.strictEqual(root.querySelector('.claude-plan-head .eyebrow')?.textContent, 'Plan · 3 steps, edited');

		const notes = root.querySelector('textarea.claude-plan-notes');
		assert.ok(notes instanceof HTMLTextAreaElement);
		notes.value = 'keep the API';
		notes.dispatchEvent(new Event('input', { bubbles: true }));
		button('button.claude-plan-open').click();
		button('button.claude-build').click();
		await Promise.resolve();
		const expected = ['step-2', 'step-3', 'step-1'];
		assert.deepStrictEqual(opens.map(open => [open.notes, open.plan.steps.map(step => step.id)]), [['keep the API', expected]]);
		assert.deepStrictEqual(builds.map(build => [build.notes, build.plan?.steps.map(step => `${step.id}:${step.title}`)]), [['keep the API', ['step-2:Return a typed error', 'step-3:Add unit tests', 'step-1:Check expiresAt in src/coupon.ts']]]);
	});

	test('an unedited plan builds without an edited plan', async () => {
		renderer().render(planState());
		button('button.claude-build').click();
		await Promise.resolve();
		assert.deepStrictEqual(builds, [{ notes: '', plan: undefined }]);
	});

	test('while its file is open in an editor the plan is one line that goes to it, until Show the Plan in the Chat', async () => {
		const editorsChanged = store.add(new Emitter<void>());
		instantiationService.stub(IEditorService, 'onDidEditorsChange', editorsChanged.event);
		const editors = instantiationService.get(IEditorService) as TestEditorService;
		const planFile = store.add(new ClaudePlanInput(URI.file(`/w/.klawly/plans/add-expiry-${planFileKey('session-1', 'turn-1')}.plan.md`)));
		const timeline = renderer();
		timeline.setDragSession('session-1');
		editors.editors = [planFile];
		timeline.render(planState());
		const card = () => ({
			link: root.querySelector('.claude-plan.is-collapsed .claude-plan-goto')?.textContent ?? undefined,
			full: !!root.querySelector('button.claude-build'),
		});
		const collapsed = card();
		button('button.claude-plan-goto').click();
		await Promise.resolve();
		button('button.claude-plan-show').click();
		const shown = card();
		editors.editors = [];
		editorsChanged.fire();
		const closed = card();
		editors.editors = [planFile];
		editorsChanged.fire();
		assert.deepStrictEqual({ collapsed, opened: opens.length, shown, closed, reopened: card() }, {
			collapsed: { link: 'Add expiry3 steps', full: false },
			opened: 1,
			shown: { link: undefined, full: true },
			closed: { link: undefined, full: true },
			reopened: { link: 'Add expiry3 steps', full: false },
		});
	});

	test('a plan shown from the plan editor collapses back to one line with Collapse the Plan', () => {
		const planFile = store.add(new ClaudePlanInput(URI.file(`/w/.klawly/plans/add-expiry-${planFileKey('session-1', 'turn-1')}.plan.md`)));
		const timeline = renderer();
		timeline.setDragSession('session-1');
		const card = () => ({
			link: !!root.querySelector('.claude-plan.is-collapsed'),
			collapse: root.querySelector('.claude-plan-head button.claude-plan-collapse')?.getAttribute('aria-label') ?? undefined,
		});
		timeline.render(planState());
		const notInEditor = card();
		(instantiationService.get(IEditorService) as TestEditorService).editors = [planFile];
		timeline.render(planState());
		button('button.claude-plan-show').click();
		const shown = { ...card(), focused: getActiveElement() === root.querySelector('button.claude-plan-collapse') };
		button('button.claude-plan-collapse').click();
		const collapsed = { ...card(), focused: getActiveElement() === root.querySelector('button.claude-plan-show') };
		assert.deepStrictEqual({ notInEditor, shown, collapsed }, {
			notInEditor: { link: false, collapse: undefined },
			shown: { link: false, collapse: 'Collapse the Plan', focused: true },
			collapsed: { link: true, collapse: undefined, focused: true },
		});
	});

	test('the failure banner offers Open Claude Status only for failures the status menu explains', () => {
		const timeline = renderer();
		timeline.render(failedState('network'));
		const status = button('.claude-banner.is-error button.claude-open-status');
		assert.strictEqual(status.textContent, 'Open Claude Status');
		status.click();
		assert.strictEqual(statusOpened, 1);

		timeline.render(failedState('tool-failure'));
		assert.ok(root.querySelector('.claude-banner.is-error'));
		assert.strictEqual(root.querySelector('button.claude-open-status'), null);

		timeline.render(failedState('auth'));
		assert.ok(root.querySelector('button.claude-open-status'));

		// A plan limit is a warning with its own next steps, not a status question (issue 450, DL-86).
		timeline.render(failedState('usage-limit'));
		assert.ok(root.querySelector('.claude-banner.is-warning.claude-limit-banner'));
		assert.strictEqual(root.querySelector('button.claude-open-status'), null);
	});

	test('without a status callback the banner has no status button', () => {
		renderer(false).render(failedState('network'));
		assert.ok(root.querySelector('.claude-banner.is-error button.claude-retry'));
		assert.strictEqual(root.querySelector('button.claude-open-status'), null);
	});
});
