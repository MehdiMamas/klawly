/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeDepartmentArgsProblem, claudeDepartmentMessage, claudeDepartmentToolText, ClaudeDepartmentProject, matchClaudeDepartmentProject } from '../../common/claudeDepartment.js';

const projects: ClaudeDepartmentProject[] = [
	{ folder: '/p/klawly', name: 'klawly', repo: 'MehdiMamas/klawly-ide' },
	{ folder: '/p/klawly-hooks-relay', name: 'klawly-hooks-relay', repo: 'MehdiMamas/klawly-hooks-relay' },
	{ folder: '/p/claude-sync', name: 'claude-config-sync-plan', repo: 'MehdiMamas/claude-sync' },
];

suite('Claude departments (issue 1177)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('matches a project by folder name, repository name or part of either', () => {
		const names = ['klawly', 'Claude Sync', 'config-sync', 'relay', 'MehdiMamas/klawly-hooks-relay', 'nothing', ''].map(query => {
			const match = matchClaudeDepartmentProject(query, projects);
			return `${query}: ${match.kind === 'match' ? match.project.name : match.kind === 'ambiguous' ? match.candidates.map(c => c.name).join('+') : 'none'}`;
		});
		assert.deepStrictEqual(names, [
			'klawly: klawly',
			'Claude Sync: claude-config-sync-plan',
			'config-sync: claude-config-sync-plan',
			'relay: klawly-hooks-relay',
			'MehdiMamas/klawly-hooks-relay: klawly-hooks-relay',
			'nothing: none',
			': none',
		]);
	});

	test('a tie at the best score is ambiguous, so the user picks', () => {
		const match = matchClaudeDepartmentProject('mehdimamas', projects);
		assert.deepStrictEqual(match.kind === 'ambiguous' ? match.candidates.map(c => c.name) : match.kind, ['klawly', 'klawly-hooks-relay', 'claude-config-sync-plan']);
	});

	test('arguments need a project, a brief and the user\'s words', () => {
		const ok = { project: 'klawly', brief: 'Fix X', userWords: 'fix X there' };
		assert.deepStrictEqual([
			claudeDepartmentArgsProblem(ok),
			claudeDepartmentArgsProblem({ ...ok, project: ' ' }),
			claudeDepartmentArgsProblem({ ...ok, brief: '' }),
			claudeDepartmentArgsProblem({ ...ok, userWords: '' }),
		], [undefined, 'Name the project this request belongs to.', 'Write the request for the other chat in brief.', 'Pass what the user said, word for word, in userWords.']);
	});

	test('the receiving chat starts with a From banner, the exact words, the brief and the facts', () => {
		const text = claudeDepartmentMessage('relay', { project: 'klawly', brief: 'Add the field.', facts: 'It is optional.', userWords: 'add the field' });
		assert.deepStrictEqual(text.split('\n\n'), [
			'From relay chat. This is a hand-off from another project\'s chat, not a worker: nobody waits for a reply.',
			'The user said: add the field',
			'Add the field.',
			'Known so far: It is optional.',
		]);
	});

	test('what Claude reads back after a hand-off', () => {
		assert.deepStrictEqual([
			claudeDepartmentToolText({ kind: 'delivered', project: 'klawly', opened: true }).isError,
			claudeDepartmentToolText({ kind: 'needsPick', candidates: ['a', 'b'] }).text.includes('a, b'),
			claudeDepartmentToolText({ kind: 'failed', message: 'no folder' }).isError,
		], [false, true, true]);
	});
});
