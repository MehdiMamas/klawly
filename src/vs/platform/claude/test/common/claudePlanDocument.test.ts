/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { buildPlanFilePrompt, buildPlanTodoPrompt, newPlanTodoLine, parsePlanDocument, planFileName, readyPlanTodos, setPlanTodoDone } from '../../common/claudePlanDocument.js';
import { planToMarkdown } from '../../common/claudePlanEdit.js';

suite('Claude plan documents', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a saved plan reads back as title, prose, to-dos with their lines, and the notes after them', () => {
		const text = planToMarkdown({
			title: 'Add coupon expiry',
			summary: 'Reject expired coupons.',
			steps: [
				{ id: 'step-1', title: 'Check expiresAt', files: ['src/coupon.ts'], status: 'pending' },
				{ id: 'step-2', title: 'Add tests', status: 'done' },
			],
		}, 'Keep the API stable.');
		assert.deepStrictEqual(parsePlanDocument(text), {
			title: 'Add coupon expiry',
			before: 'Reject expired coupons.',
			after: '## Notes\n\nKeep the API stable.',
			todos: [
				{ line: 7, text: 'Check expiresAt', files: ['src/coupon.ts'], done: false },
				{ line: 9, text: 'Add tests', done: true },
			],
			insertLine: 10,
			numbered: true,
		});
	});

	test('code fences, nested items and a plan without a list', () => {
		const fenced = parsePlanDocument('# T\n\n```\n- not a todo\n# not a title\n```\n\n- [ ] one\n  - nested detail\n- [X] two\n');
		const bare = parsePlanDocument('# Only prose\n\nNothing to do yet.\n\n');
		assert.deepStrictEqual({ fenced, bare }, {
			fenced: {
				title: 'T',
				before: '```\n- not a todo\n# not a title\n```',
				after: '',
				todos: [{ line: 8, text: 'one', detail: 'nested detail', done: false }, { line: 10, text: 'two', done: true }],
				insertLine: 11,
				numbered: false,
			},
			bare: { title: 'Only prose', before: 'Nothing to do yet.', after: '', todos: [], insertLine: 4, numbered: true },
		});
	});

	test('lists in the details are prose: the to-dos are the list under a to-do heading, else the last numbered list (issue 317)', () => {
		const details = parsePlanDocument('# Restructure\n\nWorth doing only where:\n\n- `report.js` reaches into both counters\n- tests import `src/index.js`\n\n1. Start on a branch\n2. Add `src/stats.js`\n');
		const headed = parsePlanDocument('# T\n\n1. a detail\n\n## To-dos\n\n- [ ] one\n\n## Notes\n\n1. not a to-do\n');
		assert.deepStrictEqual({ details, headed }, {
			details: {
				title: 'Restructure',
				before: 'Worth doing only where:\n\n- `report.js` reaches into both counters\n- tests import `src/index.js`',
				after: '',
				todos: [{ line: 8, text: 'Start on a branch', done: false }, { line: 9, text: 'Add `src/stats.js`', done: false }],
				insertLine: 10,
				numbered: true,
			},
			headed: {
				title: 'T',
				before: '1. a detail',
				after: '## Notes\n\n1. not a to-do',
				todos: [{ line: 7, text: 'one', done: false }],
				insertLine: 8,
				numbered: false,
			},
		});
	});

	test('a plan with details saves them above a To-dos heading and reads back the same', () => {
		const text = planToMarkdown({
			title: 'Restructure',
			summary: 'Worth doing only where: report.js reaches into both counters',
			details: 'Worth doing only where:\n\n- `report.js` reaches into both counters',
			steps: [{ id: 'step-1', title: 'Start on a branch', status: 'pending' }],
		}, '1. keep the CLI');
		const document = parsePlanDocument(text);
		assert.deepStrictEqual({ text: text.split('\n'), before: document.before, todos: document.todos.map(todo => todo.text), after: document.after }, {
			text: ['# Restructure', '', 'Worth doing only where:', '', '- `report.js` reaches into both counters', '', '## To-dos', '', '1. Start on a branch', '', '## Notes', '', '1. keep the CLI', ''],
			before: 'Worth doing only where:\n\n- `report.js` reaches into both counters',
			todos: ['Start on a branch'],
			after: '## Notes\n\n1. keep the CLI',
		});
	});

	test('an indented sub-bullet stays in its to-do, an exact To-dos heading beats "Test steps", and a Notes list is never the to-dos', () => {
		const nested = (indent: string) => parsePlanDocument(`## To-dos\n1. Do A\n${indent}- detail a\n2. Do B\n3. Do C`).todos;
		const headed = parsePlanDocument('# Add caching\n\nWe cache.\n\n### Test steps\n- Open the cart\n- Apply a code\n\n## To-dos\n1. Add the cache\n2. Wire it up');
		const saved = parsePlanDocument(planToMarkdown({
			title: 'Add caching',
			summary: 'We cache.',
			details: 'We cache.\n\n### Test steps\n\n- Open the cart\n\n## Steps\n\n1. not the to-dos',
			steps: [{ id: 'step-1', title: 'Add the cache', status: 'pending' }],
		}, '1. use redis'));
		const mainEra = parsePlanDocument('# Plan\n\nSummary here.\n\n1. Step one\n2. Step two\n\n## Notes\n\n1. use redis\n2. keep it small');
		const doA = { line: 2, text: 'Do A', detail: 'detail a', done: false };
		const rest = [{ line: 4, text: 'Do B', done: false }, { line: 5, text: 'Do C', done: false }];
		assert.deepStrictEqual({
			tab: nested('\t'),
			space: nested(' '),
			headed: [headed.before, headed.todos.map(todo => todo.text)],
			saved: [saved.todos.map(todo => todo.text), saved.after],
			mainEra: [mainEra.before, mainEra.todos.map(todo => todo.text), mainEra.after],
		}, {
			tab: [doA, ...rest],
			space: [doA, ...rest],
			headed: ['We cache.\n\n### Test steps\n- Open the cart\n- Apply a code', ['Add the cache', 'Wire it up']],
			saved: [['Add the cache'], '## Notes\n\n1. use redis'],
			mainEra: ['Summary here.', ['Step one', 'Step two'], '## Notes\n\n1. use redis\n2. keep it small'],
		});
	});

	test('ticking a to-do keeps its marker, and a new to-do follows the list style', () => {
		assert.deepStrictEqual({
			plainDone: setPlanTodoDone('2. Add tests', true),
			plainOpen: setPlanTodoDone('2. [x] Add tests', false),
			boxedOpen: setPlanTodoDone('  - [X] Add tests', false),
			notItem: setPlanTodoDone('Add tests', true),
			numbered: newPlanTodoLine(parsePlanDocument('1. a\n2. b\n'), '  Ship\nit '),
			bulleted: newPlanTodoLine(parsePlanDocument('- a\n'), 'Ship it'),
		}, {
			plainDone: '2. [x] Add tests',
			plainOpen: '2. [ ] Add tests',
			boxedOpen: '  - [ ] Add tests',
			notItem: 'Add tests',
			numbered: '3. [ ] Ship it',
			bulleted: '- [ ] Ship it',
		});
	});

	test('file names and the Build prompt', () => {
		const document = parsePlanDocument('# Add TodoList.remove\n\nDrop one item.\n\n1. [x] Read todo.ts\n2. Add `remove(id)`\n   Filter by id\n   Files: `src/todo.ts`, src/todo.test.ts\n');
		assert.deepStrictEqual({
			name: planFileName('Add TodoList.remove (v2)!', 'a1b2c3'),
			empty: planFileName('***', 'a1b2c3'),
			prompt: buildPlanFilePrompt(document, '.klawly/plans/add.plan.md').split('\n'),
		}, {
			name: 'add-todolist-remove-v2-a1b2c3.plan.md',
			empty: 'plan-a1b2c3.plan.md',
			prompt: [
				'Build the plan in `.klawly/plans/add.plan.md`. Work through its open to-dos in order, make the changes, and say what you did.',
				'When you finish a to-do, mark it done in that file by putting `[x]` after its list marker.',
				'',
				'Plan: Add TodoList.remove',
				'Drop one item.',
				'',
				'Open to-dos:',
				'1. Add `remove(id)`',
				'   Filter by id',
				'   Files: `src/todo.ts`, `src/todo.test.ts`',
			],
		});
	});

	test('Depends lines, the to-dos ready to build in parallel, and one to-do\'s prompt (issue 495)', () => {
		const document = parsePlanDocument([
			'# Dark mode',
			'',
			'## To-dos',
			'1. [x] Add the theme tokens',
			'2. Style the settings page',
			'   Depends: 1',
			'3. Style the about page',
			'   Files: `src/about.css`',
			'   Depends on: none',
			'4. Screenshot both pages',
			'   Depends on 2, 3 and 4, 9',
			'   Depends on the theme tokens landing first',
			'   Use the light theme too',
		].join('\n'));
		const { ready, waiting } = readyPlanTodos(document);
		assert.deepStrictEqual({
			depends: document.todos.map(todo => todo.depends ?? []),
			detail: document.todos[3].detail,
			ready: ready.map(todo => todo.text),
			waiting,
			prompt: buildPlanTodoPrompt(document, '.klawly/plans/dark.plan.md', ready[1]).split('\n'),
		}, {
			depends: [[], [1], [], [2, 3]],
			detail: 'Depends on the theme tokens landing first Use the light theme too',
			ready: ['Style the settings page', 'Style the about page'],
			waiting: 1,
			prompt: [
				'Build to-do 3 of the plan in `.klawly/plans/dark.plan.md`, and only that to-do: other agents build the other to-dos at the same time, each on its own worktree. Make the changes and say what you did. Do not edit the plan file.',
				'',
				'Plan: Dark mode',
				'',
				'To-do 3: Style the about page',
				'Files: `src/about.css`',
			],
		});
	});

	test('a later wave prompt names the branches of the to-dos it builds on', () => {
		const document = parsePlanDocument(['# T', '', '1. One', '2. Two', '3. Three', '   Depends: 1, 2'].join('\n'));
		const built = [{ number: 1, branch: 'klawly/a' }, { number: 2, branch: 'klawly/b' }];
		assert.deepStrictEqual(buildPlanTodoPrompt(document, 'p.plan.md', document.todos[2], built).split('\n').slice(4), [
			'To-do 3: Three',
			'',
			'This to-do builds on to-dos other agents already finished. Their changes are on these branches of this repository and not in your checkout yet. Before you start, merge each one with `git merge --no-edit <branch>`; if a merge fails, say so and stop instead of guessing.',
			'- To-do 1: `klawly/a`',
			'- To-do 2: `klawly/b`',
		]);
	});
});
