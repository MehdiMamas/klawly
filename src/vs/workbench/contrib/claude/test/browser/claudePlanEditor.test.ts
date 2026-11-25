/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudeContextService } from '../../../../services/claude/common/claudeContextService.js';
import { ClaudePlanLinks, IClaudePlanLinks } from '../../../../services/claude/common/claudePlanLinks.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { TestEditorGroupView, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ClaudePlanEditor, ClaudePlanInput } from '../../browser/plan/claudePlanEditor.js';
import { IClaudePlanParallelBuilds } from '../../browser/plan/claudePlanParallel.js';

const PLAN = [
	'# Add TodoList.remove',
	'',
	'Drop one item by id.',
	'',
	'1. [x] Read `todo.ts`',
	'2. Add `remove(id)`',
	'   Filter by id',
	'',
	'## Notes',
	'',
	'Keep the API stable.',
].join('\n');

interface Submitted {
	readonly sessionId: string;
	readonly text: string;
	readonly label?: string;
}

suite('Claude plan editor', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const resource = URI.file('/repo/.klawly/plans/add-todolist-remove-a1b2c3.plan.md');
	let instantiation: TestInstantiationService;
	let saved: string[];
	let submitted: Submitted[];
	let selected: string[];
	let running: Set<string>;

	setup(() => {
		instantiation = workbenchInstantiationService(undefined, store);
		saved = [];
		submitted = [];
		selected = [];
		running = new Set();
		const sessions = [
			{ id: 'author', title: 'Plan the remove method' },
			{ id: 'current', title: 'Something else' },
		];
		instantiation.stub(IClaudePlanLinks, store.add(new ClaudePlanLinks(instantiation.get(IStorageService))));
		instantiation.stub(ITextFileService, {
			isDirty: () => false,
			save: async (uri: URI) => { saved.push(uri.path); return uri; },
		} as unknown as ITextFileService);
		instantiation.stub(IClaudeAgentService, {
			getSessions: () => sessions,
			getCurrentSession: () => sessions[1],
			createSession: () => ({ id: 'new', title: 'New Chat' }),
			selectSession: (id: string) => { selected.push(id); },
			setMode: () => undefined,
			getViewState: (id: string) => ({ turns: running.has(id) ? [{ status: 'running' }] : [] }),
			submit: async (sessionId: string, text: string, _cwd: string, options?: { label?: string }) => { submitted.push({ sessionId, text, label: options?.label }); },
		} as unknown as IClaudeAgentService);
		instantiation.stub(IClaudeContextService, {
			resolve: async (userText: string) => ({ userText, mode: 'agent', workspaceRoot: '/repo', attachments: [], diagnostics: [], instructionFiles: [] }),
		} as unknown as IClaudeContextService);
		instantiation.stub(IViewsService, { openView: async () => undefined } as unknown as IViewsService);
		instantiation.stub(IClaudePlanParallelBuilds, {
			onDidChange: Event.None,
			getStates: () => new Map(),
			canOpen: () => false,
			open: () => undefined,
			start: () => undefined,
		} as unknown as IClaudePlanParallelBuilds);
	});

	async function open(text = PLAN) {
		const model = store.add(createTextModel(text, null, undefined, resource));
		instantiation.stub(ITextModelService, {
			createModelReference: async () => ({ object: { textEditorModel: model }, dispose: () => undefined }),
		} as unknown as ITextModelService);
		const editor = store.add(instantiation.createInstance(ClaudePlanEditor, new TestEditorGroupView(0)));
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		store.add({ dispose: () => parent.remove() });
		editor.create(parent);
		const input = store.add(new ClaudePlanInput(resource));
		await editor.setInput(input, undefined, {}, CancellationToken.None);
		const texts = (selector: string) => [...parent.querySelectorAll(selector)].map(element => element.textContent);
		return { editor, model, parent, input, texts };
	}

	test('shows the title, prose, to-dos and the chats that reference the plan', async () => {
		instantiation.get(IClaudePlanLinks).link(resource, { sessionId: 'gone', title: 'Old chat', role: 'build' });
		instantiation.get(IClaudePlanLinks).link(resource, { sessionId: 'author', title: 'Plan the remove method', role: 'author' });
		const { parent, input, texts } = await open();
		assert.deepStrictEqual({
			name: input.getName(),
			progress: texts('.claude-plan-progress .label'),
			bar: parent.querySelector('.claude-plan-progress .bar')?.getAttribute('aria-valuenow'),
			title: texts('.claude-plan-title'),
			sections: texts('.claude-plan-section-head .label'),
			todos: texts('.claude-plan-todo .title'),
			details: texts('.claude-plan-todo .detail'),
			checked: [...parent.querySelectorAll('.claude-plan-check')].map(check => check.getAttribute('aria-checked')),
			links: texts('.claude-plan-link .title'),
			disabled: [...parent.querySelectorAll<HTMLButtonElement>('.claude-plan-link')].map(link => link.disabled),
		}, {
			name: 'add-todolist-remove-a1b2c3.plan.md',
			progress: ['1 of 2 done'],
			bar: '1',
			title: ['Add TodoList.remove'],
			sections: ['2 To-dos', 'Referenced by 2 Chats'],
			todos: ['Read todo.ts', 'Add remove(id)'],
			details: ['Filter by id'],
			checked: ['true', 'false'],
			links: ['Plan the remove method', 'Old chat'],
			disabled: [false, true],
		});
	});

	test('a to-do built by a background agent links to that agent (issue 898)', async () => {
		const opened: string[] = [];
		instantiation.stub(IClaudePlanParallelBuilds, {
			onDidChange: Event.None,
			getStates: () => new Map(),
			canOpen: (_resource: URI, todo: string) => todo === 'Add `remove(id)`',
			open: (_resource: URI, todo: string) => { opened.push(todo); },
		} as unknown as IClaudePlanParallelBuilds);
		const { parent } = await open();
		const links = parent.querySelectorAll<HTMLButtonElement>('.claude-plan-agent');
		links[0]?.click();
		assert.deepStrictEqual({
			rows: [...parent.querySelectorAll('.claude-plan-todo')].map(row => !!row.querySelector('.claude-plan-agent')),
			opened,
		}, {
			rows: [false, true],
			opened: ['Add `remove(id)`'],
		});
	});

	test('ticking and adding to-dos edit the file and save it', async () => {
		const { model, parent } = await open();
		parent.querySelectorAll<HTMLButtonElement>('.claude-plan-check')[1].click();
		parent.querySelector<HTMLButtonElement>('.claude-plan-add')!.click();
		const input = parent.querySelector<HTMLInputElement>('.claude-plan-new-input')!;
		input.value = 'Add tests';
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await Promise.resolve();
		assert.deepStrictEqual({
			lines: model.getLinesContent().slice(4, 9),
			saved: saved.length,
			stillAdding: !!parent.querySelector('.claude-plan-new-input'),
		}, {
			lines: ['1. [x] Read `todo.ts`', '2. [x] Add `remove(id)`', '   Filter by id', '3. [ ] Add tests', ''],
			saved: 2,
			stillAdding: true,
		});
	});

	test('Build sends the open to-dos to the author chat, or to the current chat when the author is busy', async () => {
		const { editor } = await open();
		instantiation.get(IClaudePlanLinks).link(resource, { sessionId: 'author', title: 'Plan the remove method', role: 'author' });
		await editor.runBuild();
		running.add('author');
		await editor.runBuild();
		assert.deepStrictEqual({
			sessions: submitted.map(submission => submission.sessionId),
			selected,
			label: submitted[0].label,
			prompt: submitted[0].text.split('\n').slice(2),
			builders: instantiation.get(IClaudePlanLinks).links(resource).map(link => `${link.sessionId}:${link.role}`),
		}, {
			sessions: ['author', 'current'],
			selected: ['author', 'current'],
			label: 'Build: Add TodoList.remove',
			prompt: [
				'',
				'Plan: Add TodoList.remove',
				'Drop one item by id.',
				'',
				'Open to-dos:',
				'1. Add `remove(id)`',
				'   Filter by id',
				'',
				'## Notes\n\nKeep the API stable.',
			].join('\n').split('\n'),
			builders: ['current:build', 'author:build', 'author:author'],
		});
	});
});
