/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { parsePlanDocument } from '../../../../../platform/claude/common/claudePlanDocument.js';
import { IClaudeMultitaskService, MultitaskGroup, MultitaskRunStatus } from '../../../../services/claude/common/claudeMultitask.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { ClaudePlanParallelBuilds } from '../../browser/plan/claudePlanParallel.js';

const PLAN = [
	'# Dark mode',
	'',
	'## To-dos',
	'1. Add the theme tokens',
	'2. Style the about page',
	'3. Screenshot both pages',
	'   Depends: 1, 2',
].join('\n');

suite('Claude plan built in parallel (issue 495)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const resource = URI.file('/repo/.klawly/plans/dark-mode-a1b2c3.plan.md');

	function setup(text = PLAN) {
		const changed = store.add(new Emitter<void>());
		const groups: MultitaskGroup[] = [];
		const opened: string[] = [];
		const started: { sessionId: string; prompts: readonly string[]; cwd: string }[] = [];
		const saved: string[] = [];
		const multitask = {
			onDidChange: changed.event,
			getGroups: () => groups,
			getTask: (run: { prompt: string }) => ({ branchName: `klawly/${run.prompt.split('\n').find(line => line.startsWith('To-do '))?.replace(/\W+/g, '-')}` }),
			canOpen: () => true,
			open: (run: { prompt: string }) => { opened.push(run.prompt.split('\n').find(line => line.startsWith('To-do ')) ?? ''); },
			start: (sessionId: string, prompts: readonly string[], cwd: string) => {
				started.push({ sessionId, prompts, cwd });
				const group: MultitaskGroup = { id: `g${started.length}`, sessionId, startedAt: 0, runs: prompts.map(prompt => ({ prompt, status: 'running' })) };
				groups.push(group);
				return group;
			},
		} as unknown as IClaudeMultitaskService;
		const model = store.add(createTextModel(text, null, undefined, resource));
		const textModels = {
			createModelReference: async () => ({ object: { textEditorModel: model }, dispose: () => undefined }),
		} as unknown as ITextModelService;
		const textFiles = {
			isDirty: () => false,
			save: async (uri: URI) => { saved.push(uri.path); return uri; },
		} as unknown as ITextFileService;
		const builds = store.add(new ClaudePlanParallelBuilds(multitask, textModels, textFiles, new NullLogService()));
		const setStatuses = (id: string, ...statuses: MultitaskRunStatus[]) => {
			const index = groups.findIndex(group => group.id === id);
			groups[index] = { ...groups[index], runs: groups[index].runs.map((run, i) => ({ ...run, status: statuses[i] })) };
			changed.fire();
		};
		const dismiss = () => {
			groups.length = 0;
			changed.fire();
		};
		const settle = () => new Promise(resolve => setTimeout(resolve, 0));
		return { builds, model, started, saved, setStatuses, dismiss, settle, opened };
	}

	test('starts the ready to-dos, shows them building, and ticks each one its agent finished', async () => {
		const { builds, model, started, saved, setStatuses, dismiss } = setup();
		builds.start(resource, parsePlanDocument(model.getValue()), '.klawly/plans/dark.plan.md', 's1', '/repo');
		const building = [...builds.getStates(resource)];
		setStatuses('g1', 'complete', 'failed');
		await new Promise(resolve => setTimeout(resolve, 0));
		const afterRun = [...builds.getStates(resource)];
		const text = model.getValue().split('\n').slice(3);
		dismiss();
		assert.deepStrictEqual({
			started: started.map(start => [start.sessionId, start.cwd, start.prompts.map(prompt => prompt.split('\n').find(line => line.startsWith('To-do ')))]),
			building,
			afterRun,
			text,
			saved,
			afterDismiss: [...builds.getStates(resource)],
		}, {
			started: [['s1', '/repo', ['To-do 1: Add the theme tokens', 'To-do 2: Style the about page']]],
			building: [['Add the theme tokens', 'building'], ['Style the about page', 'building']],
			afterRun: [['Style the about page', 'failed']],
			text: ['1. [x] Add the theme tokens', '2. Style the about page', '3. Screenshot both pages', '   Depends: 1, 2'],
			saved: [resource.path],
			afterDismiss: [],
		});
	});

	test('one ready to-do is not a parallel build', () => {
		const { builds, model, started } = setup('# T\n\n1. One\n2. Two\n   Depends: 1\n');
		assert.throws(() => builds.start(resource, parsePlanDocument(model.getValue()), 'p', 's1', '/repo'));
		assert.deepStrictEqual(started, []);
	});

	test('a later wave starts by itself once its dependencies are ticked, on their branches', async () => {
		const { builds, model, started, setStatuses, settle } = setup();
		builds.start(resource, parsePlanDocument(model.getValue()), 'p.plan.md', 's1', '/repo');
		setStatuses('g1', 'complete', 'running');
		await settle();
		const afterOne = started.length;
		setStatuses('g1', 'complete', 'complete');
		await settle();
		await settle();
		const wave = started[1];
		assert.deepStrictEqual({
			afterOne,
			started: started.map(start => start.prompts.length),
			sameChat: [wave.sessionId, wave.cwd],
			prompt: wave.prompts[0].split('\n').slice(-5),
			states: [...builds.getStates(resource)],
			text: model.getValue().split('\n').slice(3, 5),
		}, {
			afterOne: 1,
			started: [2, 1],
			sameChat: ['s1', '/repo'],
			prompt: [
				'To-do 3: Screenshot both pages',
				'',
				'This to-do builds on to-dos other agents already finished. Their changes are on these branches of this repository and not in your checkout yet. Before you start, merge each one with `git merge --no-edit <branch>`; if a merge fails, say so and stop instead of guessing.',
				'- To-do 1: `klawly/To-do-1-Add-the-theme-tokens`',
				'- To-do 2: `klawly/To-do-2-Style-the-about-page`',
			],
			states: [['Screenshot both pages', 'building']],
			text: ['1. [x] Add the theme tokens', '2. [x] Style the about page'],
		});
	});

	test('a failed to-do keeps the ones waiting on it from starting, and is not started again', async () => {
		const { builds, model, started, setStatuses, settle } = setup();
		builds.start(resource, parsePlanDocument(model.getValue()), 'p.plan.md', 's1', '/repo');
		setStatuses('g1', 'complete', 'failed');
		await settle();
		await settle();
		setStatuses('g1', 'complete', 'failed');
		await settle();
		assert.deepStrictEqual({ groups: started.length, states: [...builds.getStates(resource)] }, {
			groups: 1,
			states: [['Style the about page', 'failed']],
		});
	});

	test('a to-do links to the chat of its agent', () => {
		const { builds, model, opened } = setup();
		builds.start(resource, parsePlanDocument(model.getValue()), 'p.plan.md', 's1', '/repo');
		builds.open(resource, 'Style the about page');
		builds.open(resource, 'Screenshot both pages');
		assert.deepStrictEqual({
			canOpen: [builds.canOpen(resource, 'Add the theme tokens'), builds.canOpen(resource, 'Screenshot both pages')],
			opened,
		}, { canOpen: [true, false], opened: ['To-do 2: Style the about page'] });
	});
});
