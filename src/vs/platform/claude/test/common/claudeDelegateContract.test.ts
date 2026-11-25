/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeDelegateArgsProblem } from '../../common/claudeDelegate.js';
import { claudeDelegateBudgetState, claudeDelegateContractProblem, claudeDelegateContractPrompt, claudeDelegateReport } from '../../common/claudeDelegateContract.js';

suite('Claude delegate contract', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('schema parsing: a bad tier, budget or retry count says what is allowed', () => {
		assert.deepStrictEqual([
			claudeDelegateContractProblem({}),
			claudeDelegateContractProblem({ tier: 'medium', budget: { calls: 40, usd: 0.5 }, retries: 2 }),
			claudeDelegateContractProblem({ tier: 'huge' as 'small' }),
			claudeDelegateContractProblem({ budget: { calls: 0 } }),
			claudeDelegateContractProblem({ budget: { usd: -1 } }),
			claudeDelegateContractProblem({ retries: 1.5 }),
			claudeDelegateArgsProblem({ task: 'Do it', retries: -1 }),
		], [
			undefined,
			undefined,
			'tier is small, medium or large.',
			'budget.calls is a whole number above zero.',
			'budget.usd is a number above zero.',
			'retries is a whole number, zero or more.',
			'retries is a whole number, zero or more.',
		]);
	});

	test('the prompt is the task alone without a contract, and sections with one', () => {
		assert.strictEqual(claudeDelegateContractPrompt('Do it', {}), 'Do it');
		const prompt = claudeDelegateContractPrompt('Do it', { objective: 'Fix the bug', files: ['a.ts'], acceptance: 'Tests pass', budget: { calls: 10, usd: 1 }, retries: 1 });
		assert.deepStrictEqual(
			['Objective\nFix the bug', '- a.ts', 'Acceptance (how to check you are done)\nTests pass', 'At most 10 tool calls.', 'At most $1 of spend.', 'at most 1 time,', 'at most 300 words', '[[quiet]]'].map(part => prompt.includes(part)),
			[true, true, true, true, true, true, true, true]);
	});

	test('orchestrates is true or false', () => {
		assert.deepStrictEqual([
			claudeDelegateContractProblem({ orchestrates: true }),
			claudeDelegateContractProblem({ orchestrates: 'yes' as unknown as boolean }),
		], [undefined, 'orchestrates is true or false.']);
	});

	test('budget: notice at 80%, stop at 100%, the larger share counts', () => {
		assert.deepStrictEqual([
			claudeDelegateBudgetState(undefined, 99, 99),
			claudeDelegateBudgetState({ calls: 10 }, 7, 0),
			claudeDelegateBudgetState({ calls: 10 }, 8, 0),
			claudeDelegateBudgetState({ calls: 10, usd: 1 }, 2, 1),
			claudeDelegateBudgetState({ usd: 1 }, 0, 0.79),
		], ['ok', 'ok', 'notice', 'stop', 'ok']);
	});

	test('report: cut at 300 words, the quiet marker is removed and a lone marker is quiet', () => {
		const long = Array.from({ length: 350 }, (_, i) => `w${i}`).join(' ');
		const cut = claudeDelegateReport(long);
		assert.deepStrictEqual([
			cut.text.split(/\s+/).length, cut.text.endsWith('w299…'), cut.cut,
			claudeDelegateReport('Done: fixed.\n[[quiet]]'),
			claudeDelegateReport('  [[quiet]] '),
		], [
			300, true, true,
			{ text: 'Done: fixed.', quiet: false, cut: false },
			{ text: '', quiet: true, cut: false },
		]);
	});
});
