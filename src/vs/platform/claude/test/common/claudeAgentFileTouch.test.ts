/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeAgentPetColor, claudeEditedFileOf, claudeFilePets, claudeFileTouchAgentDone, claudeFileTouchEnd, claudeFileTouchReviewed, claudeFileTouchStart, claudeMapWorktreePath, CLAUDE_AGENT_PET_COLOR_COUNT, EMPTY_CLAUDE_FILE_TOUCH_STATE } from '../../common/claudeAgentFileTouch.js';

/** Issue 1176 slice 1: the file-touch tracker. */
suite('Claude agent file touch', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const main = { agentId: 'main', name: 'Main chat' };
	const worker = { agentId: 'w1', name: 'lane-a', task: 'fix it', model: 'sonnet' };

	test('finds the edited file of an edit tool call only', () => {
		assert.deepStrictEqual(
			[
				claudeEditedFileOf('Edit', { file_path: '/a/b.ts' }),
				claudeEditedFileOf('NotebookEdit', { notebook_path: '/a/n.ipynb' }),
				claudeEditedFileOf('Read', { file_path: '/a/b.ts' }),
				claudeEditedFileOf('Write', { file_path: '' }),
				claudeEditedFileOf('Write', undefined),
			],
			['/a/b.ts', '/a/n.ipynb', undefined, undefined, undefined]
		);
	});

	test('pet colour is stable and in range', () => {
		const color = claudeAgentPetColor('w1');
		assert.deepStrictEqual([color === claudeAgentPetColor('w1'), color >= 0 && color < CLAUDE_AGENT_PET_COLOR_COUNT], [true, true]);
	});

	test('maps worktree paths back to the main file', () => {
		assert.deepStrictEqual(
			[
				claudeMapWorktreePath('C:\\repo\\.worktrees\\fix-1\\src\\a.ts'),
				claudeMapWorktreePath('/repo/src/a.ts'),
			],
			[{ path: 'C:/repo/src/a.ts', worktree: 'fix-1' }, { path: '/repo/src/a.ts' }]
		);
	});

	test('pet appears while editing, leaves after, and the file keeps a changed-by mark until reviewed', () => {
		let state = claudeFileTouchStart(EMPTY_CLAUDE_FILE_TOUCH_STATE, main, 'Edit', { file_path: '/r/a.ts' }, 1);
		const during = claudeFilePets(state, '/r/a.ts');
		state = claudeFileTouchEnd(state, main, 'Edit', { file_path: '/r/a.ts' }, true);
		const after = claudeFilePets(state, '/r/a.ts');
		state = claudeFileTouchReviewed(state, '/r/a.ts');
		const reviewed = claudeFilePets(state, '/r/a.ts');
		assert.deepStrictEqual(
			[during.active.map(t => t.agent.agentId), during.changedBy, after.active.length, after.changedBy?.agentId, reviewed.changedBy],
			[['main'], undefined, 0, 'main', undefined]
		);
	});

	test('two agents on one file are a conflict; a worktree edit shows on the main file', () => {
		let state = claudeFileTouchStart(EMPTY_CLAUDE_FILE_TOUCH_STATE, main, 'Write', { file_path: '/r/a.ts' }, 1);
		state = claudeFileTouchStart(state, worker, 'Edit', { file_path: '/r/.worktrees/w/a.ts' }, 2);
		const pets = claudeFilePets(state, '/r/a.ts');
		assert.deepStrictEqual(
			[pets.conflict, pets.active.map(t => [t.agent.agentId, t.inWorktree, t.worktree])],
			[true, [['main', false, undefined], ['w1', true, 'w']]]
		);
	});

	test('a failed edit leaves no mark and a finished agent loses all its pets', () => {
		let state = claudeFileTouchStart(EMPTY_CLAUDE_FILE_TOUCH_STATE, worker, 'Edit', { file_path: '/r/a.ts' }, 1);
		state = claudeFileTouchStart(state, worker, 'Edit', { file_path: '/r/b.ts' }, 2);
		const failed = claudeFileTouchEnd(state, worker, 'Edit', { file_path: '/r/a.ts' }, false);
		const done = claudeFileTouchAgentDone(state, 'w1');
		assert.deepStrictEqual(
			[claudeFilePets(failed, '/r/a.ts').changedBy, claudeFilePets(failed, '/r/b.ts').active.length, claudeFilePets(done, '/r/b.ts').active.length],
			[undefined, 1, 0]
		);
	});
});
