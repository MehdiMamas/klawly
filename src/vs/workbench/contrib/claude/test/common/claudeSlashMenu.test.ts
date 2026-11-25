/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeCommandInfo } from '../../../../../platform/claude/common/claudeCommands.js';
import { CLAUDE_SLASH_GROUP_CAP, ClaudeSlashCatalog, claudeSlashCatalogForFolder, claudeSlashGroups } from '../../common/claudeSlashMenu.js';

function command(name: string, source: ClaudeCommandInfo['source'], extra: Partial<ClaudeCommandInfo> = {}): ClaudeCommandInfo {
	return { name, description: `${name} description`, source, ...extra };
}

const catalog: ClaudeSlashCatalog = {
	commands: [
		command('compact', 'builtin', { argumentHint: '[instructions]' }),
		command('clear', 'builtin', { aliases: ['reset', 'new'] }),
		command('review', 'skill'),
		command('deploy', 'project'),
		command('mine', 'user'),
		command('github:issues', 'mcp'),
		command('a1', 'skill'),
		command('a2', 'skill'),
		command('a3', 'skill'),
		command('a4', 'skill'),
		command('compact', 'other'),
	],
	agents: [{ name: 'code-reviewer', description: 'Reviews code', model: 'sonnet' }],
	actions: [{ id: 'reviewChanges', name: 'review-changes', description: 'Review the uncommitted changes' }],
};

suite('Claude slash menu', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('rows are grouped by source in a fixed order, and a name listed twice shows once', () => {
		const groups = claudeSlashGroups(catalog, '');
		assert.deepStrictEqual(groups.map(group => group.id), ['builtin', 'skill', 'project', 'user', 'plugin', 'subagent', 'ide']);
		assert.deepStrictEqual(groups[0].rows.map(row => row.label), ['/compact', '/clear']);
		assert.strictEqual(groups[0].rows[0].hint, '[instructions]');
		assert.strictEqual(groups[0].rows[0].insert, '/compact ');
		assert.strictEqual(groups[0].rows[1].description, 'clear description · Also /reset, /new');
		assert.deepStrictEqual(groups.find(group => group.id === 'plugin')?.rows.map(row => row.label), ['/github:issues']);
	});

	test('subagents insert @agent-name and show their model as the hint; IDE actions run instead of inserting', () => {
		const groups = claudeSlashGroups(catalog, '');
		const agent = groups.find(group => group.id === 'subagent')!.rows[0];
		assert.deepStrictEqual([agent.label, agent.hint, agent.insert], ['@agent-code-reviewer', 'sonnet', '@agent-code-reviewer ']);
		const action = groups.find(group => group.id === 'ide')!.rows[0];
		assert.deepStrictEqual([action.label, action.insert, action.action], ['/review-changes', undefined, 'reviewChanges']);
	});

	test('a group shows its cap and counts the rest until it is expanded', () => {
		const skills = claudeSlashGroups(catalog, '').find(group => group.id === 'skill')!;
		assert.strictEqual(skills.rows.length, CLAUDE_SLASH_GROUP_CAP);
		assert.strictEqual(skills.hidden, 1);
		const expanded = claudeSlashGroups(catalog, '', new Set(['skill'])).find(group => group.id === 'skill')!;
		assert.deepStrictEqual([expanded.rows.length, expanded.hidden], [5, 0]);
	});

	test('the query matches names and aliases, best match first', () => {
		assert.deepStrictEqual(claudeSlashGroups(catalog, 'reset').map(group => group.rows.map(row => row.label)), [['/clear']]);
		assert.deepStrictEqual(claudeSlashGroups(catalog, 'code-rev').map(group => group.id), ['subagent']);
		const review = claudeSlashGroups(catalog, 'review');
		assert.ok(review.some(group => group.rows.some(row => row.label === '/review')));
		assert.strictEqual(claudeSlashGroups(catalog, 'zzzz').length, 0);
	});

	test('a Klawly prompt is an IDE row that inserts its name, unless Claude Code has a command of that name', () => {
		const prompts = [{ name: 'visualize', hint: '[what to show]', description: 'Ask Claude for a diagram or chart' }, { name: 'deploy', description: 'Shadowed' }];
		const ide = claudeSlashGroups({ ...catalog, prompts }, '').find(group => group.id === 'ide')!;
		assert.deepStrictEqual(ide.rows.map(row => [row.id, row.label, row.hint, row.insert, row.action]), [
			['ide:reviewChanges', '/review-changes', undefined, undefined, 'reviewChanges'],
			['prompt:visualize', '/visualize', '[what to show]', '/visualize ', undefined],
		]);
	});
	test('issue 680: a /create row opens its Customize add form and yields to a Claude Code command of the same name', () => {
		const forms = [{ name: 'create-skill', form: 'skills' as const, description: 'Add a skill' }, { name: 'deploy', form: 'hooks' as const, description: 'Shadowed' }];
		const ide = claudeSlashGroups({ ...catalog, forms }, '', new Set(['ide'])).find(group => group.id === 'ide')!;
		assert.deepStrictEqual(ide.rows.map(row => [row.id, row.label, row.insert, row.form]), [
			['ide:reviewChanges', '/review-changes', undefined, undefined],
			['form:create-skill', '/create-skill', undefined, 'skills'],
		]);
	});
	test('issue 1057: /review-branch runs the workbench command', () => {
		const workbenchCommands = [{ name: 'review-branch', command: 'claude.review.branchAgainstBase', description: 'Review the branch' }];
		const ide = claudeSlashGroups({ ...catalog, workbenchCommands }, 'review-b', new Set(['ide'])).find(group => group.id === 'ide')!;
		assert.deepStrictEqual(ide.rows.map(row => [row.id, row.label, row.command]), [['command:review-branch', '/review-branch', 'claude.review.branchAgainstBase']]);
	});
	test('issue 997: with no folder open the editor and repository actions are left out', () => {
		const workbenchCommands = [{ name: 'review-branch', command: 'claude.review.branchAgainstBase', description: 'Review the branch' }];
		const full = { ...catalog, workbenchCommands };
		const ids = (c: ClaudeSlashCatalog) => claudeSlashGroups(c, '', new Set(['ide'])).find(group => group.id === 'ide')?.rows.map(row => row.id) ?? [];
		assert.deepStrictEqual(ids(claudeSlashCatalogForFolder(full, false)), []);
		assert.deepStrictEqual(ids(claudeSlashCatalogForFolder(full, true)), ids(full));
	});
});
