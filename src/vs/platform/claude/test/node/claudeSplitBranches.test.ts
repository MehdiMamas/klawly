/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFile } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { SplitPlan, addSplitGroup, initialSplitPlan, moveSplitFile, parseSplitDiff, renameSplitBranch, renameSplitGroup, splitBranchParts } from '../../common/claudeSplitPlan.js';
import { ClaudeWorktreeService } from '../../node/claudeWorktreeService.js';
import { removeDirWithRetries } from './claudeTestFiles.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await exec('git', args, { cwd, windowsHide: true, timeout: 20000 });
	return result.stdout;
}

function text(path: string): string {
	return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

/** A repository with two committed files, then an edit, a staged edit and a new file left uncommitted. */
async function dirtyRepo(): Promise<string> {
	const repo = mkdtempSync(join(tmpdir(), 'klawly-split-branches-'));
	await git(repo, ['init', '-q', '-b', 'main']);
	await git(repo, ['config', 'user.email', 'klawly@example.com']);
	await git(repo, ['config', 'user.name', 'Klawly']);
	await git(repo, ['config', 'core.autocrlf', 'false']);
	writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
	writeFileSync(join(repo, 'b.txt'), 'red\n');
	await git(repo, ['add', '.']);
	await git(repo, ['commit', '-q', '-m', 'base']);
	writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
	writeFileSync(join(repo, 'b.txt'), 'blue\n');
	await git(repo, ['add', 'b.txt']);
	writeFileSync(join(repo, 'new.txt'), 'fresh\n');
	return repo;
}

/** Group 1 gets a.txt and new.txt, group 2 gets b.txt. */
function twoGroups(patch: string): SplitPlan {
	let plan = addSplitGroup(initialSplitPlan(parseSplitDiff(patch)));
	const [first, second] = plan.groups;
	plan = renameSplitGroup(plan, first.id, 'Count to three');
	plan = renameSplitBranch(plan, first.id, 'split/count');
	plan = renameSplitGroup(plan, second.id, 'Paint it blue');
	plan = renameSplitBranch(plan, second.id, 'split/blue');
	plan = moveSplitFile(plan, 'a.txt', first.id);
	plan = moveSplitFile(plan, 'new.txt', first.id);
	return moveSplitFile(plan, 'b.txt', second.id);
}

suite('Claude split branches (issue 971)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('stacked branches start from the one before and name it', async function () {
		this.timeout(60000);
		const repo = await dirtyRepo();
		const service = store.add(new ClaudeWorktreeService());
		try {
			const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
			const plan = twoGroups(await service.splitDiff(repo));
			const results = await service.createSplitBranches(repo, splitBranchParts(plan), true);

			assert.deepStrictEqual(results.map(result => [result.branch, result.stackedOn, result.error]), [['split/count', undefined, undefined], ['split/blue', 'split/count', undefined]]);
			assert.strictEqual((await git(repo, ['rev-parse', 'split/count~1'])).trim(), head);
			assert.strictEqual((await git(repo, ['rev-parse', 'split/blue~1'])).trim(), results[0].commit);
			assert.deepStrictEqual((await git(repo, ['show', '--name-only', '--format=%s', 'split/blue'])).trim().split('\n'), ['Paint it blue', '', 'b.txt']);
		} finally {
			removeDirWithRetries(repo, 20, 200);
		}
	});

	test('the split diff has every change, untracked included, and leaves the index alone', async function () {
		this.timeout(60000);
		const repo = await dirtyRepo();
		const service = store.add(new ClaudeWorktreeService());
		try {
			const before = await git(repo, ['status', '--porcelain']);
			const patch = await service.splitDiff(repo);
			assert.deepStrictEqual(parseSplitDiff(patch).map(file => file.path).sort(), ['a.txt', 'b.txt', 'new.txt']);
			assert.strictEqual(await git(repo, ['status', '--porcelain']), before);
		} finally {
			removeDirWithRetries(repo, 20, 200);
		}
	});

	test('each group becomes a branch and worktree with one commit of its files', async function () {
		this.timeout(60000);
		const repo = await dirtyRepo();
		const service = store.add(new ClaudeWorktreeService());
		try {
			const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
			const status = await git(repo, ['status', '--porcelain']);
			const plan = twoGroups(await service.splitDiff(repo));
			const results = await service.createSplitBranches(repo, splitBranchParts(plan));

			assert.deepStrictEqual(results.map(result => [result.branch, result.error]), [['split/count', undefined], ['split/blue', undefined]]);
			const count = join(repo, '.worktrees', 'split', 'count');
			const blue = join(repo, '.worktrees', 'split', 'blue');
			assert.strictEqual(text(join(count, 'a.txt')), 'one\ntwo\nthree\n');
			assert.strictEqual(text(join(count, 'new.txt')), 'fresh\n');
			assert.strictEqual(text(join(count, 'b.txt')), 'red\n');
			assert.strictEqual(text(join(blue, 'b.txt')), 'blue\n');
			assert.strictEqual(text(join(blue, 'a.txt')), 'one\ntwo\n');
			assert.ok(!existsSync(join(blue, 'new.txt')));

			assert.deepStrictEqual((await git(repo, ['show', '--name-only', '--format=%s', 'split/count'])).trim().split('\n'), ['Count to three', '', 'a.txt', 'new.txt']);
			assert.deepStrictEqual((await git(repo, ['show', '--name-only', '--format=%s', 'split/blue'])).trim().split('\n'), ['Paint it blue', '', 'b.txt']);
			assert.strictEqual((await git(repo, ['rev-parse', 'split/count~1'])).trim(), head);
			assert.strictEqual((await git(count, ['status', '--porcelain'])).trim(), '');

			// The main checkout keeps its branch, HEAD and uncommitted changes; .worktrees stays out of its status.
			assert.strictEqual((await git(repo, ['branch', '--show-current'])).trim(), 'main');
			assert.strictEqual((await git(repo, ['rev-parse', 'HEAD'])).trim(), head);
			assert.strictEqual(await git(repo, ['status', '--porcelain']), status);
		} finally {
			removeDirWithRetries(repo, 20, 200);
		}
	});

	test('a part that fails is rolled back and an existing branch is left alone', async function () {
		this.timeout(60000);
		const repo = await dirtyRepo();
		const service = store.add(new ClaudeWorktreeService());
		try {
			await git(repo, ['branch', 'taken']);
			const results = await service.createSplitBranches(repo, [
				{ branch: 'broken', title: 'Broken', patch: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-nothing\n+like this\n' },
				{ branch: 'taken', title: 'Taken', patch: 'diff --git a/a.txt b/a.txt\n' },
				{ branch: '../out', title: 'Out', patch: 'x' },
			]);
			assert.ok(results.every(result => result.error && !result.commit));
			assert.strictEqual((await git(repo, ['branch', '--list', 'broken'])).trim(), '');
			assert.ok(!existsSync(join(repo, '.worktrees', 'broken')));
			assert.strictEqual((await git(repo, ['branch', '--list', 'taken'])).trim(), 'taken');
			assert.strictEqual((await git(repo, ['branch', '--show-current'])).trim(), 'main');
		} finally {
			removeDirWithRetries(repo, 20, 200);
		}
	});
});
