/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeDepartmentToolArgs } from '../../common/claudeDepartment.js';
import { runClaudeDepartmentTool } from '../../node/claudeTerminalTool.js';

/** Issue 1177: `klawly_department` hands a request to another project's chat. */
suite('Claude klawly_department tool', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const args: ClaudeDepartmentToolArgs = { project: 'relay', brief: 'Why is the feed stuck?', userWords: 'ask the relay chat why the feed is stuck' };

	test('passes the call to the host and reports the delivery', async () => {
		const seen: string[] = [];
		const result = await runClaudeDepartmentTool({ handOff: async call => { seen.push(call.project); return { kind: 'delivered', project: 'klawly-hooks-relay', opened: true }; } }, args, undefined);
		assert.deepStrictEqual({ seen, isError: result.isError ?? false, text: result.content[0].text.includes('klawly-hooks-relay') }, { seen: ['relay'], isError: false, text: true });
	});

	test('refuses a call with no user words without reaching the host', async () => {
		let called = false;
		const result = await runClaudeDepartmentTool({ handOff: async () => { called = true; return { kind: 'failed', message: '' }; } }, { ...args, userWords: ' ' }, undefined);
		assert.deepStrictEqual({ called, isError: result.isError }, { called: false, isError: true });
	});

	test('a host that throws becomes an error result', async () => {
		const result = await runClaudeDepartmentTool({ handOff: async () => { throw new Error('boom'); } }, args, undefined);
		assert.deepStrictEqual({ isError: result.isError, text: result.content[0].text.includes('boom') }, { isError: true, text: true });
	});
});
