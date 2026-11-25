/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { KlawlyProject, parseProjectFile, projectContextFolderName, projectContextReadme, projectCoordinatorPrompt, projectFileName, projectName, writeProjectFile } from '../../common/claudeProject.js';

suite('Klawly projects (issue 496)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const project: KlawlyProject = { version: 1, name: 'Add dark mode to settings pages', goal: 'Add dark mode to settings pages', folder: '/repo', createdAt: '2026-10-13T15:00:00.000Z', sessionId: 's1' };

	test('names, file names, and a project file that reads back', () => {
		assert.deepStrictEqual({
			short: projectName('  Add dark mode\nto settings pages  '),
			long: projectName('Add dark mode to every settings page, the about page and the onboarding screens'),
			file: projectFileName('Add dark mode to settings pages', []),
			taken: projectFileName('Add dark mode!', ['add-dark-mode.json', 'Add-Dark-Mode-2.json']),
			empty: projectFileName('***', []),
			roundTrip: parseProjectFile(writeProjectFile(project)),
			noChat: parseProjectFile(writeProjectFile({ ...project, sessionId: undefined })),
			broken: [parseProjectFile('{'), parseProjectFile('[]'), parseProjectFile(JSON.stringify({ ...project, version: 2 })), parseProjectFile(JSON.stringify({ ...project, goal: 3 }))],
		}, {
			short: 'Add dark mode',
			long: 'Add dark mode to every settings page, the about page and...',
			file: 'add-dark-mode-to-settings-pages.json',
			taken: 'add-dark-mode-3.json',
			empty: 'project.json',
			roundTrip: project,
			noChat: { version: 1, name: project.name, goal: project.goal, folder: '/repo', createdAt: project.createdAt },
			broken: [undefined, undefined, undefined, undefined],
		});
	});

	test('the coordinator plans to-dos with Files and Depends lines and never edits', () => {
		const prompt = projectCoordinatorPrompt(project, '/home/me/.klawly/projects/add-dark-mode-to-settings-pages.json');
		assert.deepStrictEqual({
			first: prompt.split('\n')[0],
			noEdits: prompt.includes(`don't change any files yourself`),
			lines: prompt.includes('`Files:` line') && prompt.includes('`Depends: none`'),
			build: prompt.includes('Build in Parallel'),
			last: prompt.split('\n').at(-1),
		}, {
			first: 'You coordinate a Klawly project. Its goal: Add dark mode to settings pages',
			noEdits: true,
			lines: true,
			build: true,
			last: 'The project file is `/home/me/.klawly/projects/add-dark-mode-to-settings-pages.json`.',
		});
	});

	test('a project has a shared context folder next to its file, and the coordinator is told about it', () => {
		const file = '/home/me/.klawly/projects/add-dark-mode.json';
		const without = projectCoordinatorPrompt(project, file);
		const withContext = projectCoordinatorPrompt(project, file, '/home/me/.klawly/projects/add-dark-mode.context');
		assert.deepStrictEqual({
			folder: projectContextFolderName('add-dark-mode.json'),
			readme: projectContextReadme(project).split('\n')[0],
			mentioned: [without.includes('add-dark-mode.context'), withContext.includes('/home/me/.klawly/projects/add-dark-mode.context')],
		}, {
			folder: 'add-dark-mode.context',
			readme: '# Shared context: Add dark mode to settings pages',
			mentioned: [false, true],
		});
	});
});
