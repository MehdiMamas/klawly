/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BackgroundAgentTask } from '../../../../../platform/claude/common/claudeBackground.js';
import { matchesBaseContiguousSubString, matchesWords, or } from '../../../../../base/common/filters.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { MenuId, MenuRegistry, isIMenuItem } from '../../../../../platform/actions/common/actions.js';
import { CLAUDE_APPLY_WORKTREE_COMMAND_ID, CLAUDE_DELETE_WORKTREE_COMMAND_ID, registerClaudeWorktreeCommands, worktreePickItems } from '../../browser/claudeWorktreeCommands.js';

suite('Claude worktree commands', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function task(id: string, title: string, filesChanged: number): BackgroundAgentTask {
		return { id, sessionId: `s-${id}`, repoRoot: '/r', baseRef: 'abc', worktreePath: `/w/${id}`, branchName: `klawly/${id}`, status: 'complete', title, filesChanged, added: 0, removed: 0, testStatus: 'tests not run', conflicts: [], stopped: false };
	}

	test('one pick per worktree, with its branch and change count', () => {
		const items = worktreePickItems([task('a', 'Fix login', 1), task('b', 'Add tests', 3)]);
		assert.deepStrictEqual(items.map(item => [item.taskId, item.label, item.description, item.detail]), [
			['a', 'Fix login', 'klawly/a', '1 file changed'],
			['b', 'Add tests', 'klawly/b', '3 files changed'],
		]);
	});

	test('no worktrees, no picks', () => {
		assert.deepStrictEqual(worktreePickItems([]), []);
	});

	test('the Command Palette finds Apply and Delete Worktree by git worktree, branch and their other names (issue 904)', () => {
		// The claude commands test may already have registered them in this process.
		if (!CommandsRegistry.getCommand(CLAUDE_APPLY_WORKTREE_COMMAND_ID)) {
			registerClaudeWorktreeCommands();
		}
		const palette = new Map(MenuRegistry.getMenuItems(MenuId.CommandPalette).filter(isIMenuItem).map(item => [item.command.id, item.command]));
		// The palette matches a filter against "Category: Title" and the English alias, as the commands quick access does.
		const filter = or(matchesBaseContiguousSubString, matchesWords);
		const found = (words: string) => [CLAUDE_APPLY_WORKTREE_COMMAND_ID, CLAUDE_DELETE_WORKTREE_COMMAND_ID].filter(id => {
			const title = palette.get(id)?.title;
			const original = typeof title === 'string' ? title : title?.original ?? '';
			return !!filter(words, `Klawly: ${original}`);
		});
		const shown = [CLAUDE_APPLY_WORKTREE_COMMAND_ID, CLAUDE_DELETE_WORKTREE_COMMAND_ID].map(id => { const title = palette.get(id)?.title; return typeof title === 'string' ? title : title?.value; });
		assert.deepStrictEqual({ shown, finds: ['git worktree', 'branch', 'merge branch', 'remove worktree', 'delete branch', 'discard worktree', 'worktree', 'zzz'].map(words => [words, found(words)]) }, {
			shown: ['Apply Worktree', 'Delete Worktree'],
			finds: [
				['git worktree', [CLAUDE_APPLY_WORKTREE_COMMAND_ID, CLAUDE_DELETE_WORKTREE_COMMAND_ID]],
				['branch', [CLAUDE_APPLY_WORKTREE_COMMAND_ID, CLAUDE_DELETE_WORKTREE_COMMAND_ID]],
				['merge branch', [CLAUDE_APPLY_WORKTREE_COMMAND_ID]],
				['remove worktree', [CLAUDE_DELETE_WORKTREE_COMMAND_ID]],
				['delete branch', [CLAUDE_DELETE_WORKTREE_COMMAND_ID]],
				['discard worktree', [CLAUDE_DELETE_WORKTREE_COMMAND_ID]],
				['worktree', [CLAUDE_APPLY_WORKTREE_COMMAND_ID, CLAUDE_DELETE_WORKTREE_COMMAND_ID]],
				['zzz', []],
			],
		});
	});
});
