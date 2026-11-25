/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeDelegateContractProblem } from '../../common/claudeDelegateContract.js';
import { CLAUDE_LEAN_WORKER_BUILTIN_TOOLS, claudeTaskNeedsFullProfile, claudeWorkerProfileShape, claudeWorkerSettingSources, estimateClaudeStartTokens, readClaudeWorkerProfile } from '../../common/claudeWorkerProfile.js';

suite('Claude worker profile', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads lean and full, anything else falls back to lean', () => {
		assert.strictEqual(readClaudeWorkerProfile('full'), 'full');
		assert.strictEqual(readClaudeWorkerProfile('lean'), 'lean');
		assert.strictEqual(readClaudeWorkerProfile('wide'), 'lean');
		assert.strictEqual(readClaudeWorkerProfile(undefined, 'full'), 'full');
	});

	test('lean keeps the file and shell tools and drops plugins, MCP servers and skills', () => {
		const lean = claudeWorkerProfileShape('lean');
		assert.deepStrictEqual(lean.builtinTools, CLAUDE_LEAN_WORKER_BUILTIN_TOOLS);
		assert.ok(lean.builtinTools?.includes('Bash') && lean.builtinTools.includes('Edit') && lean.builtinTools.includes('Read'));
		assert.deepStrictEqual([lean.plugins, lean.mcpServers, lean.skills, lean.userSettings], [false, false, false, false]);
	});

	test('full keeps everything', () => {
		const full = claudeWorkerProfileShape('full');
		assert.strictEqual(full.builtinTools, undefined);
		assert.deepStrictEqual([full.plugins, full.mcpServers, full.skills, full.userSettings], [true, true, true, true]);
	});

	test('lean loads project settings only', () => {
		assert.deepStrictEqual(claudeWorkerSettingSources('lean', ['user', 'project']), ['project']);
		assert.deepStrictEqual(claudeWorkerSettingSources('full', ['user', 'project']), ['user', 'project']);
	});

	test('a browser or MCP task is flagged as needing full', () => {
		assert.strictEqual(claudeTaskNeedsFullProfile('Open the browser and take a screenshot'), true);
		assert.strictEqual(claudeTaskNeedsFullProfile('Rename the helper in util.ts'), false);
	});

	test('lean starts smaller than full', () => {
		const parts = { baseChars: 40_000, droppableBuiltinChars: 30_000, mcpChars: 60_000, listingChars: 20_000 };
		assert.ok(estimateClaudeStartTokens('lean', parts) < estimateClaudeStartTokens('full', parts));
		assert.strictEqual(estimateClaudeStartTokens('lean', parts), 10_000);
		assert.strictEqual(estimateClaudeStartTokens('full', parts), 37_500);
	});

	test('the delegate contract accepts lean and full and refuses other profiles', () => {
		const base = { name: 'w', task: 'do it', objective: 'o', acceptance: 'a' };
		assert.notStrictEqual(claudeDelegateContractProblem({ ...base, profile: 'wide' as never }), undefined);
		assert.strictEqual(claudeDelegateContractProblem({ ...base, profile: 'full' }) === 'profile is lean or full.', false);
		assert.strictEqual(claudeDelegateContractProblem({ ...base, profile: 'lean' }) === 'profile is lean or full.', false);
	});
});
