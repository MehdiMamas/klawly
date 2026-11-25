/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyClaudeSaveBeforeCommand, ClaudeSaveBeforeCommandHost } from '../../common/claudeSaveBeforeCommands.js';

suite('Claude save before commands (workbench)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function host(dirty: number, answer: boolean) {
		const log: string[] = [];
		const value: ClaudeSaveBeforeCommandHost = {
			dirtyCount: () => dirty,
			saveAll: async () => { log.push('save'); },
			confirm: async (count, command) => {
				log.push(`ask ${count} ${command}`);
				return answer;
			},
		};
		return { value, log };
	}

	test('always saves without asking, prompt asks first, and nothing unsaved means no question', async () => {
		const cases = [
			{ mode: 'always', dirty: 2, answer: false },
			{ mode: 'prompt', dirty: 2, answer: true },
			{ mode: 'prompt', dirty: 1, answer: false },
			{ mode: 'prompt', dirty: 0, answer: true },
			{ mode: 'always', dirty: 0, answer: true },
		] as const;
		const results = [];
		for (const { mode, dirty, answer } of cases) {
			const fake = host(dirty, answer);
			const result = await applyClaudeSaveBeforeCommand({ mode, command: 'npm test' }, fake.value);
			results.push({ result, log: fake.log });
		}
		assert.deepStrictEqual(results, [
			{ result: 'saved', log: ['save'] },
			{ result: 'saved', log: ['ask 2 npm test', 'save'] },
			{ result: 'declined', log: ['ask 1 npm test'] },
			{ result: 'clean', log: [] },
			{ result: 'clean', log: [] },
		]);
	});
});
