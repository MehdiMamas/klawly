/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeReviewFinding } from '../../common/claudeReviewLoop.js';
import { ClaudeQueryFactory } from '../../node/claudeQuery.js';
import { CLAUDE_REVIEW_STORE_FILE, createClaudeReviewToolHost } from '../../node/claudeReviewHost.js';

suite('Claude review tool host (issue 1376)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const folders: string[] = [];

	teardown(() => {
		for (const folder of folders.splice(0)) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	function checkout() {
		const cwd = mkdtempSync(join(tmpdir(), 'klawly-review-'));
		folders.push(cwd);
		const gitDir = join(cwd, '.git');
		mkdirSync(gitDir);
		const queryFactory: ClaudeQueryFactory = () => { throw new Error('no model in tests'); };
		const tools = createClaudeReviewToolHost({ cwd, env: {}, queryFactory, gitDirectory: async () => gitDir, readHead: async () => 'abc1234', readDiff: async () => '' });
		return { cwd, gitDir, tools };
	}

	const finding: ClaudeReviewFinding = { file: 'a.ts', startLine: 1, endLine: 1, severity: 'high', category: 'bug', title: 'Bad', body: 'x' };

	test('the review is stored in the git directory and read back', async () => {
		const { gitDir, tools } = checkout();
		const before = await tools.read();
		const stored = await tools.store([finding], 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n');
		const after = await tools.read();
		assert.deepStrictEqual({ before, open: stored.open, sha: stored.sha, file: readFileSync(join(gitDir, CLAUDE_REVIEW_STORE_FILE), 'utf8').includes('"Bad"'), reviewedSha: after?.reviewedSha }, { before: undefined, open: [finding], sha: 'abc1234', file: true, reviewedSha: 'abc1234' });
	});

	test('files are read and written only inside the checkout', async () => {
		const { cwd, tools } = checkout();
		writeFileSync(join(cwd, 'a.ts'), 'one');
		const inside = await tools.readFile('a.ts');
		const outside = await tools.readFile('../a.ts');
		const written = await tools.writeFile('a.ts', 'two');
		const refused = await tools.writeFile('../escape.ts', 'x');
		assert.deepStrictEqual({ inside, outside, written, refused, content: readFileSync(join(cwd, 'a.ts'), 'utf8') }, { inside: 'one', outside: undefined, written: true, refused: false, content: 'two' });
	});

	test('a review with no changes says so without calling the model', async () => {
		const { tools } = checkout();
		const result = await tools.run({ base: 'main', depth: 'quick' });
		assert.deepStrictEqual(result, { text: 'No changes against main, so there is nothing to review.' });
	});
});
