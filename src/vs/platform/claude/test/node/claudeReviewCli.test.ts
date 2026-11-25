/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeReviewCliHost, runClaudeReviewCli } from '../../node/claudeReviewCli.js';
import { ClaudeQueryFactory } from '../../node/claudeQuery.js';

suite('Claude review CLI runner', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function host(out: string[], err: string[], overrides: Partial<ClaudeReviewCliHost> = {}): ClaudeReviewCliHost {
		const queryFactory: ClaudeQueryFactory = () => { throw new Error('no model in tests'); };
		return { cwd: '.', env: {}, stdoutIsTerminal: false, queryFactory, readStored: async () => undefined, write: text => out.push(text), writeError: text => err.push(text), ...overrides };
	}

	test('wrong usage exits 2 and prints the usage line', async () => {
		const out: string[] = [];
		const err: string[] = [];
		const code = await runClaudeReviewCli(['--nope'], host(out, err));
		assert.deepStrictEqual({ code, out, first: err[0].split('\n')[0] }, { code: 2, out: [], first: 'Unknown argument --nope' });
	});

	test('an empty diff is clean without calling the model', async () => {
		const out: string[] = [];
		const code = await runClaudeReviewCli(['--text'], host(out, []), async () => '  \n');
		assert.deepStrictEqual({ code, out }, { code: 0, out: ['No findings.'] });
	});

	test('status lists the stored open findings and exits 1 at the fail-on level', async () => {
		const out: string[] = [];
		const stored = { reviewedSha: 'abc1234', findings: [{ finding: { file: 'a.ts', startLine: 1, endLine: 1, severity: 'high' as const, category: 'bug' as const, title: 'Bad', body: 'x' }, status: 'open' as const }] };
		const code = await runClaudeReviewCli(['status', '--text'], host(out, [], { readStored: async () => stored }));
		assert.deepStrictEqual({ code, out }, { code: 1, out: ['HIGH a.ts:1 Bad\n  x'] });
	});

	test('a failing review exits 3', async () => {
		const err: string[] = [];
		const code = await runClaudeReviewCli([], host([], err), async () => 'diff --git a/a b/a\n+x\n');
		assert.strictEqual(code, 3);
	});
});
