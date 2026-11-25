/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { backgroundBranchName, backgroundWorktreePath, isPathInside, worktreeAddArguments, worktreeApplyArguments, worktreeDiffArguments } from '../../common/claudeBackground.js';
import { directorySize } from '../../node/claudeWorktreeDisk.js';
import { endGitInput } from '../../node/claudeWorktreeGit.js';
import { ClaudeWorktreeService } from '../../node/claudeWorktreeService.js';
import { removeDirWithRetries } from './claudeTestFiles.js';

const exec = promisify(execFile);

/** A directory link. Windows uses a junction because a file symlink needs extra privileges. */
function linkDirectory(target: string, link: string): void {
	symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

function text(path: string): string {
	return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await exec('git', args, { cwd, windowsHide: true, timeout: 20000 });
	return result.stdout;
}

async function commitPaths(cwd: string, paths: string[], message: string): Promise<void> {
	await git(cwd, ['add', ...paths]);
	await git(cwd, ['-c', 'user.email=klawly@example.com', '-c', 'user.name=Klawly', 'commit', '-m', message]);
}

suite('Claude worktree git', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('add arguments match git worktree add -b agent/<id>', () => {
		assert.deepStrictEqual(
			worktreeAddArguments('agent/task', '/user/worktrees/hash/task', 'abc'),
			['worktree', 'add', '-b', 'agent/task', '/user/worktrees/hash/task', 'abc'],
		);
		assert.deepStrictEqual(worktreeApplyArguments(), ['apply', '--3way']);
		assert.deepStrictEqual(worktreeDiffArguments('abc'), ['diff', '--binary', 'abc']);
	});

	test('git stdin EPIPE does not escape the process', () => {
		const stdin = new EventEmitter();
		(stdin as EventEmitter & { end(chunk: string): void }).end = () => {
			stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
		};
		assert.doesNotThrow(() => endGitInput(stdin as EventEmitter & { end(chunk: string): void; on(event: 'error', listener: (error: Error) => void): void }, 'patch'));
	});

	test('two agents work at once without writing the main tree', async function () {
		this.timeout(30000);
		const root = mkdtempSync(join(tmpdir(), 'klawly-bg-'));
		store.add({ dispose: () => removeDirWithRetries(root, 20, 200) });
		const repo = join(root, 'repo');
		const userData = join(root, 'user');
		const service = store.add(new ClaudeWorktreeService());
		await git(root, ['init', '-b', 'main', repo]);
		await git(repo, ['config', 'core.autocrlf', 'false']);
		writeFileSync(join(repo, 'README.md'), 'base\n');
		await commitPaths(repo, ['README.md'], 'base');
		const base = await service.head(repo);
		const firstPath = backgroundWorktreePath(userData, repo, 'one');
		const secondPath = backgroundWorktreePath(userData, repo, 'two');
		await Promise.all([
			service.add(repo, firstPath, backgroundBranchName('one'), base),
			service.add(repo, secondPath, backgroundBranchName('two'), base),
		]);
		writeFileSync(join(firstPath, 'from-a.txt'), 'agent-a\n');
		writeFileSync(join(secondPath, 'from-b.txt'), 'agent-b\n');
		assert.notStrictEqual(firstPath, secondPath);
		assert.strictEqual(isPathInside(repo, firstPath), false);
		assert.strictEqual(isPathInside(repo, secondPath), false);
		assert.strictEqual(existsSync(join(repo, 'from-a.txt')), false);
		assert.strictEqual(existsSync(join(repo, 'from-b.txt')), false);
		assert.strictEqual(text(join(firstPath, 'from-a.txt')), 'agent-a\n');
		assert.strictEqual(text(join(secondPath, 'from-b.txt')), 'agent-b\n');
		const listed = await git(repo, ['worktree', 'list', '--porcelain']);
		assert.ok(listed.includes('one'), listed);
		assert.ok(listed.includes('two'), listed);
		const branches = await git(repo, ['branch', '--list', 'agent/*']);
		assert.ok(branches.includes('agent/one'), branches);
		assert.ok(branches.includes('agent/two'), branches);

		writeFileSync(join(firstPath, 'README.md'), 'from-agent\n');
		await commitPaths(firstPath, ['README.md'], 'agent edit');
		writeFileSync(join(firstPath, 'untracked.txt'), 'new-file\n');
		const patch = await service.diff(firstPath, base);
		assert.ok(patch.includes('from-agent'), patch);
		assert.ok(patch.includes('untracked.txt'), patch);
		assert.ok(patch.includes('from-a.txt'), patch);
		const tip = (await git(firstPath, ['log', '-1', '--format=%s'])).trim();
		assert.strictEqual(tip, 'agent edit');
		const applied = await service.applyThreeWay(repo, patch);
		assert.deepStrictEqual(applied.conflicts, []);
		assert.strictEqual(text(join(repo, 'README.md')), 'from-agent\n');
		assert.strictEqual(text(join(repo, 'untracked.txt')), 'new-file\n');
		assert.strictEqual(text(join(repo, 'from-a.txt')), 'agent-a\n');
		assert.strictEqual(existsSync(join(repo, 'from-b.txt')), false);
		assert.strictEqual(text(join(secondPath, 'from-b.txt')), 'agent-b\n');
	});

	test('a three-way apply reports conflicts instead of copying the worktree', async function () {
		this.timeout(30000);
		const root = mkdtempSync(join(tmpdir(), 'klawly-bg-conflict-'));
		store.add({ dispose: () => removeDirWithRetries(root, 20, 200) });
		const repo = join(root, 'repo');
		const userData = join(root, 'user');
		const service = store.add(new ClaudeWorktreeService());
		await git(root, ['init', '-b', 'main', repo]);
		await git(repo, ['config', 'core.autocrlf', 'false']);
		writeFileSync(join(repo, 'file.txt'), 'base\n');
		await commitPaths(repo, ['file.txt'], 'base');
		const base = await service.head(repo);
		const worktree = backgroundWorktreePath(userData, repo, 'conflict');
		await service.add(repo, worktree, backgroundBranchName('conflict'), base);
		writeFileSync(join(worktree, 'file.txt'), 'agent\n');
		await commitPaths(worktree, ['file.txt'], 'agent');
		writeFileSync(join(worktree, 'only-worktree.txt'), 'secret\n');
		writeFileSync(join(repo, 'file.txt'), 'main\n');
		await commitPaths(repo, ['file.txt'], 'main moved');
		const patch = await service.diff(worktree, base);
		const applied = await service.applyThreeWay(repo, patch);
		assert.strictEqual(applied.conflicts.length, 1);
		assert.strictEqual(applied.conflicts[0].relativePath, 'file.txt');
		assert.ok(applied.conflicts[0].base.includes('base'), applied.conflicts[0].base);
		assert.ok(applied.conflicts[0].ours.includes('main'), applied.conflicts[0].ours);
		assert.ok(applied.conflicts[0].theirs.includes('agent'), applied.conflicts[0].theirs);
		assert.strictEqual(text(join(repo, 'only-worktree.txt')), 'secret\n');
		const merged = text(join(repo, 'file.txt'));
		assert.ok(merged.includes('<<<<<<<'), merged);
		assert.ok(merged.includes('main'), merged);
		assert.ok(merged.includes('agent'), merged);
	});

	test('a new-file-only agent is diffed and applied without a commit', async function () {
		this.timeout(30000);
		const root = mkdtempSync(join(tmpdir(), 'klawly-bg-new-'));
		store.add({ dispose: () => removeDirWithRetries(root, 20, 200) });
		const repo = join(root, 'repo');
		const userData = join(root, 'user');
		const service = store.add(new ClaudeWorktreeService());
		await git(root, ['init', '-b', 'main', repo]);
		await git(repo, ['config', 'core.autocrlf', 'false']);
		writeFileSync(join(repo, 'README.md'), 'base\n');
		await commitPaths(repo, ['README.md'], 'base');
		const base = await service.head(repo);
		const worktree = backgroundWorktreePath(userData, repo, 'new-file');
		await service.add(repo, worktree, backgroundBranchName('new-file'), base);
		assert.strictEqual(await service.hasChanges(worktree, base), false);
		writeFileSync(join(worktree, 'created.txt'), 'hello from agent\n');
		assert.strictEqual(await service.hasChanges(worktree, base), true);
		const patch = await service.diff(worktree, base);
		const stats = await service.summarize(worktree, base);
		assert.ok(patch.includes('created.txt'), patch);
		assert.ok(patch.includes('hello from agent'), patch);
		assert.strictEqual(stats.filesChanged, 1);
		assert.ok(stats.added > 0);
		assert.strictEqual((await git(worktree, ['log', '-1', '--format=%s'])).trim(), 'base');
		const applied = await service.applyThreeWay(repo, patch);
		assert.deepStrictEqual(applied.conflicts, []);
		assert.strictEqual(text(join(repo, 'created.txt')), 'hello from agent\n');
		assert.strictEqual((await git(repo, ['log', '-1', '--format=%s'])).trim(), 'base');
	});

	test('commitDiff shows one commit and refuses a value that is not a sha', async function () {
		this.timeout(30000);
		const root = mkdtempSync(join(tmpdir(), 'klawly-bg-show-'));
		store.add({ dispose: () => removeDirWithRetries(root, 20, 200) });
		const repo = join(root, 'repo');
		const service = store.add(new ClaudeWorktreeService());
		await git(root, ['init', '-b', 'main', repo]);
		await git(repo, ['config', 'core.autocrlf', 'false']);
		writeFileSync(join(repo, 'README.md'), 'base\n');
		await commitPaths(repo, ['README.md'], 'base');
		writeFileSync(join(repo, 'README.md'), 'base\nsecond line\n');
		await commitPaths(repo, ['README.md'], 'second');
		const patch = await service.commitDiff(repo, await service.head(repo));
		await assert.rejects(service.commitDiff(repo, '--output=/tmp/x'));
		assert.deepStrictEqual({ added: patch.includes('+second line'), header: patch.startsWith('diff --git a/README.md b/README.md') }, { added: true, header: true });
	});

	test('rangeDiff shows only what changed since a reviewed commit, and refuses a value that is not a sha (issue 927)', async function () {
		this.timeout(30000);
		const root = mkdtempSync(join(tmpdir(), 'klawly-bg-range-'));
		store.add({ dispose: () => removeDirWithRetries(root, 20, 200) });
		const repo = join(root, 'repo');
		const service = store.add(new ClaudeWorktreeService());
		await git(root, ['init', '-b', 'main', repo]);
		await git(repo, ['config', 'core.autocrlf', 'false']);
		writeFileSync(join(repo, 'README.md'), 'base\n');
		await commitPaths(repo, ['README.md'], 'base');
		const reviewed = await service.head(repo);
		writeFileSync(join(repo, 'README.md'), 'base\nsecond line\n');
		await commitPaths(repo, ['README.md'], 'second');
		writeFileSync(join(repo, 'README.md'), 'base\nsecond line\nthird line\n');
		await commitPaths(repo, ['README.md'], 'third');
		const patch = await service.rangeDiff(repo, reviewed, await service.head(repo));
		await assert.rejects(service.rangeDiff(repo, '--output=/tmp/x', reviewed));
		assert.deepStrictEqual({ second: patch.includes('+second line'), third: patch.includes('+third line'), base: patch.includes('+base') }, { second: true, third: true, base: false });
	});

	test('removing a worktree that is already gone still deletes the agent branch', async function () {
		this.timeout(30000);
		const root = mkdtempSync(join(tmpdir(), 'klawly-bg-gone-'));
		store.add({ dispose: () => removeDirWithRetries(root, 20, 200) });
		const repo = join(root, 'repo');
		const userData = join(root, 'user');
		const service = store.add(new ClaudeWorktreeService());
		await git(root, ['init', '-b', 'main', repo]);
		await git(repo, ['config', 'core.autocrlf', 'false']);
		writeFileSync(join(repo, 'README.md'), 'base\n');
		await commitPaths(repo, ['README.md'], 'base');
		const base = await service.head(repo);
		const worktree = backgroundWorktreePath(userData, repo, 'gone');
		const branch = backgroundBranchName('gone');
		await service.add(repo, worktree, branch, base);
		await git(repo, ['worktree', 'remove', '--force', worktree]);
		const before = await git(repo, ['branch', '--list', branch]);
		assert.ok(before.includes(branch), before);
		await service.remove(repo, worktree, branch, true);
		const after = await git(repo, ['branch', '--list', branch]);
		assert.strictEqual(after.includes(branch), false, after);
		await service.remove(repo, worktree, branch, true);
	});

	test('readFilePair does not follow a symlink out of the worktree', async function () {
		this.timeout(30000);
		const root = mkdtempSync(join(tmpdir(), 'klawly-bg-link-'));
		store.add({ dispose: () => removeDirWithRetries(root, 20, 200) });
		const repo = join(root, 'repo');
		const userData = join(root, 'user');
		const outside = join(root, 'secret.txt');
		writeFileSync(outside, 'outside-secret\n');
		const service = store.add(new ClaudeWorktreeService());
		await git(root, ['init', '-b', 'main', repo]);
		await git(repo, ['config', 'core.autocrlf', 'false']);
		writeFileSync(join(repo, 'README.md'), 'base\n');
		await commitPaths(repo, ['README.md'], 'base');
		const base = await service.head(repo);
		const worktree = backgroundWorktreePath(userData, repo, 'link');
		await service.add(repo, worktree, backgroundBranchName('link'), base);
		const nested = join(worktree, 'nested');
		mkdirSync(nested);
		writeFileSync(join(nested, 'inside.txt'), 'inside\n');
		linkDirectory(nested, join(worktree, 'alias'));
		linkDirectory(root, join(worktree, 'escape'));
		const inside = await service.readFilePair(worktree, base, 'alias/inside.txt');
		assert.strictEqual(inside.modifiedText, 'inside\n');
		await assert.rejects(() => service.readFilePair(worktree, base, 'escape/secret.txt'), /outside the worktree/);
	});

	test('cleanup guard: unpushed commits and edits count as changes, and a plain remove refuses a dirty worktree', async function () {
		this.timeout(40000);
		const root = mkdtempSync(join(tmpdir(), 'klawly-bg-guard-'));
		store.add({ dispose: () => removeDirWithRetries(root, 20, 200) });
		const repo = join(root, 'repo');
		const userData = join(root, 'user');
		const service = store.add(new ClaudeWorktreeService());
		await git(root, ['init', '-b', 'main', repo]);
		await git(repo, ['config', 'core.autocrlf', 'false']);
		writeFileSync(join(repo, 'README.md'), 'base\n');
		await commitPaths(repo, ['README.md'], 'base');
		const base = await service.head(repo);
		const worktree = backgroundWorktreePath(userData, repo, 'guard');
		const branch = backgroundBranchName('guard');
		await service.add(repo, worktree, branch, base);
		assert.strictEqual(await service.hasChanges(worktree, base), false);
		assert.strictEqual(await service.diskUsage(worktree) !== undefined && (await service.diskUsage(worktree))! > 0, true);

		writeFileSync(join(worktree, 'new.txt'), 'x\n');
		assert.strictEqual(await service.hasChanges(worktree, base), true, 'untracked file');
		await assert.rejects(() => service.remove(repo, worktree, branch, false));
		assert.ok(existsSync(join(worktree, 'new.txt')));

		await commitPaths(worktree, ['new.txt'], 'work');
		assert.strictEqual(await service.hasChanges(worktree, base), true, 'commit beyond the base');

		await git(worktree, ['-c', 'user.email=klawly@example.com', '-c', 'user.name=Klawly', 'reset', '--hard', base]);
		assert.strictEqual(await service.hasChanges(worktree, base), false);
		await service.remove(repo, worktree, branch, false);
		assert.strictEqual(existsSync(worktree), false);
		assert.strictEqual(await service.diskUsage(worktree), undefined);
	});

	test('disk use counts files and does not follow a link out of the folder', async function () {
		const root = mkdtempSync(join(tmpdir(), 'klawly-bg-size-'));
		store.add({ dispose: () => removeDirWithRetries(root, 20, 200) });
		const dir = join(root, 'dir');
		const outside = join(root, 'outside');
		mkdirSync(join(dir, 'sub'), { recursive: true });
		mkdirSync(outside);
		writeFileSync(join(dir, 'a.txt'), '12345');
		writeFileSync(join(dir, 'sub', 'b.txt'), '123');
		writeFileSync(join(outside, 'big.txt'), 'x'.repeat(100000));
		const plain = await directorySize(dir);
		assert.strictEqual(plain, 8);
		linkDirectory(outside, join(dir, 'link'));
		const linked = await directorySize(dir);
		assert.ok(linked !== undefined && linked < 50000, `followed the link: ${linked}`);
		assert.strictEqual(await directorySize(join(root, 'missing')), undefined);
	});
});
