/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { join } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { acceptedChangeConflict, branchFromHead, commitMessageFromAssistant, encodeGitIndex, locateGitRepository, parseGitIndex, planCommitAccepted, relativeGitPath, replaceCommitMessage, resolveGitDirPointer, stagedIndexConflicts, summarizeGitContext, summarizeGitHistory, textAfterAcceptedHunks } from '../../common/claudeGit.js';

suite('Claude git context', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a branch or commit attachment keeps its header and changed paths and truncates the patch', () => {
		const summary = summarizeGitHistory({ header: 'branch feature vs main @ abc1234', paths: ['src/a.ts', 'src/b.ts'], patch: 'x'.repeat(30) }, 10);
		assert.strictEqual(summary.stat, 'branch feature vs main @ abc1234\nchanged: 2\nsrc/a.ts\nsrc/b.ts');
		assert.strictEqual(summary.patch, `${'x'.repeat(10)}\n…`);
		assert.strictEqual(summary.truncated, true);

		const small = summarizeGitHistory({ header: 'commit abc1234 Fix the parser', paths: ['a.ts'], patch: '+fix' });
		assert.deepStrictEqual(small, { stat: 'commit abc1234 Fix the parser\nchanged: 1\na.ts', patch: '+fix', truncated: false });

		const many = summarizeGitHistory({ header: 'commit abc', paths: Array.from({ length: 41 }, (_, i) => `f${i}.ts`), patch: '' });
		assert.strictEqual(many.truncated, true, 'more paths than the stat names');
		assert.strictEqual(many.stat.split('\n').length, 42, 'the header, the count and 40 names');
	});

	test('a git changes attachment keeps a stat and truncates the patch', () => {
		const working = `--- src/a.ts\n+++ src/a.ts\n${'x'.repeat(50)}`;
		const summary = summarizeGitContext({
			branch: 'main',
			head: 'abcdef1234567890',
			stagedPatch: '--- src/b.ts\n+++ src/b.ts\n+staged',
			workingPatch: working,
			stagedPaths: ['src/b.ts'],
			workingPaths: ['src/a.ts'],
			untrackedPaths: ['notes/new.txt'],
		}, 40);
		assert.ok(summary.stat.includes('branch main @ abcdef123456'));
		assert.ok(summary.stat.includes('staged: 1'));
		assert.ok(summary.stat.includes('src/b.ts'));
		assert.ok(summary.stat.includes('working: 1'));
		assert.ok(summary.stat.includes('src/a.ts'));
		assert.ok(summary.stat.includes('untracked: 1'));
		assert.ok(summary.stat.includes('notes/new.txt'));
		assert.strictEqual(summary.truncated, true);
		assert.ok(summary.patch.endsWith('…'));
		assert.ok(summary.patch.length < working.length);
		assert.ok(summary.stat.includes('src/a.ts'));
	});

	test('the index round-trips and a changed staged blob is a conflict', () => {
		const blob = 'ab'.repeat(20);
		const bytes = encodeGitIndex([{ path: 'src/note.ts', blob }]);
		const parsed = parseGitIndex(bytes);
		assert.strictEqual(parsed?.get('src/note.ts'), blob);
		const root = isWindows ? 'C:\\repo' : '/repo';
		assert.strictEqual(relativeGitPath(root, join(root, 'src', 'note.ts')), 'src/note.ts');
		assert.strictEqual(branchFromHead('ref: refs/heads/main\n'), 'main');
		const conflicts = stagedIndexConflicts(
			[{ uri: 'file:///repo/src/note.ts', indexBlob: blob }],
			new Map([['file:///repo/src/note.ts', 'cd'.repeat(20)]]),
		);
		assert.strictEqual(conflicts.length, 1);
		assert.ok(conflicts[0].label.includes('(staged)'));
		assert.deepStrictEqual(stagedIndexConflicts(
			[{ uri: 'file:///repo/src/note.ts', indexBlob: blob }],
			new Map([['file:///repo/src/note.ts', blob]]),
		), []);
	});

	test('commit accepted changes refuses other staged files and never commits unless asked', () => {
		const asked = planCommitAccepted({
			files: [
				{ path: 'src/a.ts', accepted: true },
				{ path: 'src/b.ts', accepted: false },
			],
			stagedPaths: ['src/kept.ts'],
			userInitiated: true,
		});
		assert.strictEqual(asked.commit, false);
		assert.strictEqual(asked.reason, 'staged-user-changes');
		assert.deepStrictEqual(asked.paths, ['src/a.ts']);
		assert.deepStrictEqual(asked.leaveStaged, ['src/kept.ts']);

		const idle = planCommitAccepted({
			files: [{ path: 'src/a.ts', accepted: true }],
			stagedPaths: [],
			userInitiated: false,
		});
		assert.strictEqual(idle.commit, false);
		assert.strictEqual(idle.reason, 'not-requested');

		const ready = planCommitAccepted({
			files: [{ path: 'src/a.ts', accepted: true }],
			stagedPaths: [],
			userInitiated: true,
		});
		assert.strictEqual(ready.commit, true);
		assert.deepStrictEqual(ready.paths, ['src/a.ts']);
		assert.strictEqual(commitMessageFromAssistant('```\nfeat: add git\n```'), 'feat: add git');
		assert.strictEqual(commitMessageFromAssistant('Here you go:\n```\nfeat: add git\n```\nThanks'), 'feat: add git');
	});

	test('a non-empty commit box stays until replace is confirmed', async () => {
		assert.strictEqual(await replaceCommitMessage('', 'feat: add git', async () => false), 'feat: add git');
		assert.strictEqual(await replaceCommitMessage('draft', 'feat: add git', async () => false), undefined);
		assert.strictEqual(await replaceCommitMessage('draft', 'feat: add git', async () => true), 'feat: add git');
	});

	test('an accepted file that is partly staged or edited further is not committed', () => {
		const hunks = [{ state: 'accepted', originalStart: 1, originalText: 'base', modifiedText: 'accepted' }];
		assert.strictEqual(textAfterAcceptedHunks('base', hunks), 'accepted');
		assert.strictEqual(acceptedChangeConflict({
			inIndex: true,
			inWorking: true,
			originalText: 'base',
			hunks,
			workingText: 'accepted',
		}), 'partly-staged');
		assert.strictEqual(acceptedChangeConflict({
			inIndex: false,
			inWorking: true,
			originalText: 'base',
			hunks,
			workingText: 'accepted\nextra',
		}), 'beyond-accepted');
		assert.strictEqual(acceptedChangeConflict({
			inIndex: false,
			inWorking: true,
			originalText: 'base',
			hunks,
			workingText: 'accepted',
		}), undefined);
	});

	test('accepted hunks cover a new file, a deletion, an insert, several hunks, and CRLF', () => {
		const accepted = (originalStart: number, originalText: string, modifiedText: string) => ({ state: 'accepted', originalStart, originalText, modifiedText });
		assert.strictEqual(textAfterAcceptedHunks('', [accepted(1, '', 'hello')]), 'hello');
		assert.strictEqual(textAfterAcceptedHunks('', [accepted(1, '', 'hello\nworld')]), 'hello\nworld');
		assert.strictEqual(textAfterAcceptedHunks('gone\r\n', [accepted(1, 'gone', '')]), '');
		assert.strictEqual(acceptedChangeConflict({
			inIndex: false,
			inWorking: true,
			originalText: 'gone\r\n',
			hunks: [accepted(1, 'gone', '')],
			workingText: undefined,
		}), undefined);
		assert.strictEqual(acceptedChangeConflict({
			inIndex: false,
			inWorking: true,
			originalText: 'gone\r\n',
			hunks: [accepted(1, 'gone', '')],
			workingText: '',
		}), 'beyond-accepted');
		assert.strictEqual(textAfterAcceptedHunks('a\nb', [accepted(2, '', 'X\n')]), 'a\nX\nb');
		assert.strictEqual(textAfterAcceptedHunks('a\nb\nc', [
			accepted(1, 'a', 'A'),
			{ state: 'rejected', originalStart: 2, originalText: 'b', modifiedText: 'B' },
			accepted(3, 'c', 'C'),
		]), 'A\nb\nC');
		assert.strictEqual(textAfterAcceptedHunks('base\r\nnext', [accepted(1, 'base', 'accepted')]), 'accepted\nnext');
		assert.strictEqual(acceptedChangeConflict({
			inIndex: false,
			inWorking: true,
			originalText: 'base\r\n',
			hunks: [accepted(1, 'base\r\n', 'accepted\r\n')],
			workingText: 'accepted\r\n',
		}), undefined);
		assert.strictEqual(acceptedChangeConflict({
			inIndex: false,
			inWorking: true,
			originalText: '',
			hunks: [accepted(1, '', 'hello')],
			workingText: 'hello',
		}), undefined);
	});

	test('locateGit walks to the work tree and follows a worktree gitdir', async () => {
		const root = isWindows ? 'C:\\repo' : '/repo';
		const work = join(root, 'wt');
		const gitDir = join(root, '.git', 'worktrees', 'wt');
		const files = new Map<string, string>([
			[join(work, '.git'), `gitdir: ../.git/worktrees/wt\n`],
			[join(gitDir, 'HEAD'), `${'a'.repeat(40)}\n`],
		]);
		const located = await locateGitRepository(join(work, 'src', 'a.ts'), async path => files.get(path));
		assert.strictEqual(located?.workTree, work);
		assert.strictEqual(located?.gitDir, resolveGitDirPointer(work, 'gitdir: ../.git/worktrees/wt\n'));
		assert.ok(located?.headText.startsWith('a'));
	});

	test('a gitdir pointer outside worktrees or modules is rejected', () => {
		const root = isWindows ? 'C:\\repo' : '/repo';
		const work = join(root, 'wt');
		assert.ok(resolveGitDirPointer(work, 'gitdir: ../.git/worktrees/wt\n')?.replace(/\\/g, '/').includes('/.git/worktrees/wt'));
		assert.ok(resolveGitDirPointer(join(root, 'sub'), 'gitdir: ../.git/modules/sub\n')?.replace(/\\/g, '/').includes('/.git/modules/sub'));
		assert.strictEqual(resolveGitDirPointer(work, 'gitdir: ../../outside\n'), undefined);
		const outside = isWindows ? 'D:\\secrets\\id_rsa' : '/etc/passwd';
		assert.strictEqual(resolveGitDirPointer(work, `gitdir: ${outside}\n`), undefined);
		const custom = join(root, '.git', 'custom');
		assert.strictEqual(resolveGitDirPointer(work, `gitdir: ${custom}\n`), undefined);
		assert.ok(resolveGitDirPointer(work, `gitdir: ${custom}\n`, '..')?.replace(/\\/g, '/').endsWith('/.git/custom'));
		assert.strictEqual(resolveGitDirPointer(work, `gitdir: ${join(root, 'evil')}\n`, '..'), undefined);
	});
});
