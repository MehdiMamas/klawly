/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ASK_POLICY, AGENT_POLICY, PLAN_POLICY } from '../../common/claudePermissions.js';
import { CLAUDE_PROTOCOL_VERSION, classifyTool } from '../../common/claudeProtocol.js';
import { AGENT_DATABASE_SCHEMA_VERSION } from '../../common/claudeStorage.js';

suite('Claude contracts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('protocol stays at version 1 and the session index is versioned', () => {
		assert.strictEqual(CLAUDE_PROTOCOL_VERSION, 1);
		assert.strictEqual(AGENT_DATABASE_SCHEMA_VERSION, 2);
	});

	test('classifyTool maps Claude tool names to stable categories', () => {
		assert.strictEqual(classifyTool('Read'), 'read');
		assert.strictEqual(classifyTool('Write'), 'write');
		assert.strictEqual(classifyTool('Edit'), 'write');
		assert.strictEqual(classifyTool('MultiEdit'), 'write');
		assert.strictEqual(classifyTool('NotebookEdit'), 'write');
		assert.strictEqual(classifyTool('Grep'), 'search');
		assert.strictEqual(classifyTool('Glob'), 'search');
		assert.strictEqual(classifyTool('Bash'), 'shell');
		assert.strictEqual(classifyTool('WebFetch'), 'web');
		assert.strictEqual(classifyTool('WebSearch'), 'web');
		assert.strictEqual(classifyTool('Skill'), 'skill');
		assert.strictEqual(classifyTool('mcp__server__tool'), 'mcp');
		assert.strictEqual(classifyTool('Agent'), 'other');
		assert.strictEqual(classifyTool(''), 'other');
	});

	test('Ask never writes, Plan writes plan files only, Agent writes; commands ask in every mode', () => {
		assert.deepStrictEqual([AGENT_POLICY, PLAN_POLICY, ASK_POLICY].map(policy => [policy.allowWorkspaceWrites, policy.allowShell, policy.allowNetwork, policy.captureFileSnapshots]), [
			['prompt-or-auto', 'prompt', 'prompt', true],
			['plan-files', 'prompt', 'allow', true],
			[false, 'prompt', 'allow', false],
		]);
	});
});
