/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { classifyClaudeCommand, claudeCommandFileSegments, claudeCommandsFromNames } from '../../common/claudeCommands.js';

suite('Claude commands (Phase 34)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a skill wins over every other source, then built-ins, MCP prompts, project and user files, then plugin names', () => {
		const facts = { skills: new Set(['review']), project: new Set(['ship', 'review']), user: new Set(['ship', 'standup']) };
		assert.deepStrictEqual([
			classifyClaudeCommand({ name: 'review', builtin: true }, facts),
			classifyClaudeCommand({ name: 'compact', builtin: true }, facts),
			classifyClaudeCommand({ name: 'mcp__github__pr' }, facts),
			classifyClaudeCommand({ name: 'ship' }, facts),
			classifyClaudeCommand({ name: 'standup' }, facts),
			classifyClaudeCommand({ name: 'acme:deploy' }, facts),
			classifyClaudeCommand({ name: 'mystery' }, facts),
		], ['skill', 'builtin', 'mcp', 'project', 'user', 'plugin', 'other']);
	});

	test('a namespaced command maps to a nested file, and unsafe names map to none', () => {
		assert.deepStrictEqual([
			claudeCommandFileSegments('ship'),
			claudeCommandFileSegments('frontend:button'),
			claudeCommandFileSegments('..:etc'),
			claudeCommandFileSegments('a/b'),
			claudeCommandFileSegments('a\\b'),
			claudeCommandFileSegments(''),
			claudeCommandFileSegments('x::y'),
		], [['ship.md'], ['frontend', 'button.md'], undefined, undefined, undefined, undefined, undefined]);
	});

	test('before the full listing, init names give skills and unsorted commands', () => {
		assert.deepStrictEqual(claudeCommandsFromNames(['compact', 'explain'], ['explain', 'fix']), [
			{ name: 'compact', description: '', source: 'other' },
			{ name: 'explain', description: '', source: 'skill' },
			{ name: 'fix', description: '', source: 'skill' },
		]);
	});
});
