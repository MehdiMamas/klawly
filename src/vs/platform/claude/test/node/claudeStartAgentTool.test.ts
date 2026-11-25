/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeStartAgentArgsProblem, ClaudeStartAgentToolArgs, claudeStartAgentToolText } from '../../common/claudeStartAgent.js';
import { runClaudeStartAgentTool } from '../../node/claudeTerminalTool.js';

/** Issue 991: `klawly_start_agent` starts a new local chat with a first message. */
suite('Claude klawly_start_agent tool', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const args: ClaudeStartAgentToolArgs = { prompt: 'Fix the flaky test', project: 'relay', title: 'Flaky test' };

	test('passes the call to the host and reports the start', async () => {
		const seen: string[] = [];
		const result = await runClaudeStartAgentTool({ start: async call => { seen.push(call.prompt); return { kind: 'started', title: 'Flaky test', project: 'relay' }; } }, args, undefined);
		assert.deepStrictEqual({ seen, isError: result.isError ?? false, text: result.content[0].text.includes('Flaky test') }, { seen: ['Fix the flaky test'], isError: false, text: true });
	});

	test('refuses an empty prompt without reaching the host', async () => {
		let called = false;
		const result = await runClaudeStartAgentTool({ start: async () => { called = true; return { kind: 'failed', message: '' }; } }, { prompt: '  ' }, undefined);
		assert.deepStrictEqual({ called, isError: result.isError }, { called: false, isError: true });
	});

	test('a host that throws becomes an error result', async () => {
		const result = await runClaudeStartAgentTool({ start: async () => { throw new Error('boom'); } }, args, undefined);
		assert.deepStrictEqual({ isError: result.isError, text: result.content[0].text.includes('boom') }, { isError: true, text: true });
	});

	test('words each outcome for Claude', () => {
		assert.deepStrictEqual({
			problem: claudeStartAgentArgsProblem({ prompt: 'x' }),
			pick: claudeStartAgentToolText({ kind: 'needsPick', candidates: ['a', 'b'] }),
			failed: claudeStartAgentToolText({ kind: 'failed', message: 'no' }).isError,
		}, {
			problem: undefined,
			pick: { text: 'More than one project fits (a, b). Ask the user which one, then call this tool again with a more exact project.', isError: false },
			failed: true,
		});
	});
});
