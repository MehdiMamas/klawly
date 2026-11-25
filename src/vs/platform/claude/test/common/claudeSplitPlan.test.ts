/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { actionRequestText } from '../../common/claudePrompt.js';
import { addSplitGroup, branchNameProblem, buildGroupPatch, initialSplitPlan, moveSplitFile, moveSplitHunk, parseSplitDiff, removeSplitGroup, renameSplitBranch, renameSplitGroup, splitBranchesPrompt, splitBranchesSummary, splitBranchParts, splitPlanProblems, splitPlanPrompt, suggestBranchName } from '../../common/claudeSplitPlan.js';

const DIFF = [
	'diff --git a/src/a.ts b/src/a.ts',
	'index 111..222 100644',
	'--- a/src/a.ts',
	'+++ b/src/a.ts',
	'@@ -1,3 +1,4 @@ top',
	' one',
	'+one and a half',
	' two',
	' three',
	'@@ -20,2 +21,3 @@ bottom',
	' twenty',
	'-twenty-one',
	'+twenty-one changed',
	'+twenty-two',
	'diff --git a/docs/readme.md b/docs/readme.md',
	'new file mode 100644',
	'index 0000000..333',
	'--- /dev/null',
	'+++ b/docs/readme.md',
	'@@ -0,0 +1,2 @@',
	'+hello',
	'+world',
	'',
].join('\n');

suite('Split into pull requests plan', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses files and hunks with their line counts', () => {
		const files = parseSplitDiff(DIFF);
		assert.deepStrictEqual(files.map(file => ({ path: file.path, hunks: file.hunks.map(hunk => [hunk.id, hunk.added, hunk.removed]) })), [
			{ path: 'src/a.ts', hunks: [['0:0', 1, 0], ['0:1', 2, 1]] },
			{ path: 'docs/readme.md', hunks: [['1:0', 2, 0]] },
		]);
		assert.deepStrictEqual(files[1].hunks[0].body, ['+hello', '+world']);
	});

	test('a file without a text hunk is one hunk with no header', () => {
		const files = parseSplitDiff('diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n');
		assert.deepStrictEqual(files.map(file => [file.path, file.hunks.length, file.hunks[0].header]), [['new.txt', 1, '']]);
	});

	test('the first plan has one group per top-level folder', () => {
		const plan = initialSplitPlan(parseSplitDiff(DIFF));
		assert.deepStrictEqual(plan.groups.map(group => [group.title, group.branch, group.hunkIds]), [
			['src', 'split/src', ['0:0', '0:1']],
			['docs', 'split/docs', ['1:0']],
		]);
	});

	test('moving a hunk takes it out of its old group and respects the index', () => {
		let plan = initialSplitPlan(parseSplitDiff(DIFF));
		plan = moveSplitHunk(plan, '0:1', 'group-2', 0);
		assert.deepStrictEqual(plan.groups.map(group => group.hunkIds), [['0:0'], ['0:1', '1:0']]);
		assert.strictEqual(moveSplitHunk(plan, '0:1', 'missing'), plan);
		plan = moveSplitFile(plan, 'src/a.ts', 'group-2');
		assert.deepStrictEqual(plan.groups.map(group => group.hunkIds), [[], ['1:0', '0:0', '0:1']]);
	});

	test('groups can be added, renamed, rebranched and removed', () => {
		let plan = initialSplitPlan(parseSplitDiff(DIFF));
		plan = addSplitGroup(plan);
		assert.deepStrictEqual(plan.groups[2], { id: 'group-3', title: 'Group 3', branch: 'split/group-3', hunkIds: [] });
		plan = renameSplitGroup(plan, 'group-3', 'Docs fix');
		plan = renameSplitBranch(plan, 'group-3', '  fix/docs-fix ');
		assert.deepStrictEqual([plan.groups[2].title, plan.groups[2].branch], ['Docs fix', 'fix/docs-fix']);
		plan = removeSplitGroup(plan, 'group-1');
		assert.deepStrictEqual(plan.groups.map(group => [group.id, group.hunkIds]), [['group-2', ['1:0', '0:0', '0:1']], ['group-3', []]]);
		const single = removeSplitGroup(plan, 'group-3');
		assert.strictEqual(removeSplitGroup(single, 'group-2'), single);
	});

	test('branch names follow git ref rules', () => {
		assert.deepStrictEqual(['feature/x', 'a b', 'a..b', '/a', 'a/', 'a.lock', 'x/.y', '-a', 'a~1', 'a@{1}', ''].map(branchNameProblem),
			[undefined, 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'empty']);
		assert.strictEqual(suggestBranchName('Fix: the Login page!'), 'split/fix-the-login-page');
		assert.strictEqual(suggestBranchName('???'), 'split/changes');
	});

	test('problems list empty groups, bad, duplicate and taken branches, and unassigned hunks', () => {
		let plan = initialSplitPlan(parseSplitDiff(DIFF));
		assert.deepStrictEqual(splitPlanProblems(plan), []);
		plan = moveSplitHunk(plan, '1:0', 'group-1');
		plan = renameSplitBranch(plan, 'group-2', 'split/src');
		assert.deepStrictEqual(splitPlanProblems(plan, []), [{ kind: 'empty-group', groupId: 'group-2' }, { kind: 'duplicate-branch', groupId: 'group-2' }]);
		plan = renameSplitBranch(plan, 'group-2', 'bad name');
		assert.deepStrictEqual(splitPlanProblems(plan, ['split/src']), [{ kind: 'branch-exists', groupId: 'group-1' }, { kind: 'empty-group', groupId: 'group-2' }, { kind: 'bad-branch', groupId: 'group-2', reason: 'invalid' }]);
		const lost = { ...plan, groups: plan.groups.map(group => ({ ...group, hunkIds: group.hunkIds.filter(id => id !== '0:0') })) };
		assert.ok(splitPlanProblems(lost).some(problem => problem.kind === 'unassigned' && problem.hunkId === '0:0'));
		assert.deepStrictEqual(splitPlanProblems({ files: plan.files, groups: [] }), [{ kind: 'no-groups' }]);
	});

	test('a group patch recounts the new side when a sibling hunk goes to another group', () => {
		let plan = initialSplitPlan(parseSplitDiff(DIFF));
		plan = moveSplitHunk(plan, '0:0', 'group-2');
		// Without the first hunk (+1 line), the second hunk starts at 20 on the new side, not 21.
		assert.strictEqual(buildGroupPatch(plan, 'group-1'), [
			'diff --git a/src/a.ts b/src/a.ts',
			'index 111..222 100644',
			'--- a/src/a.ts',
			'+++ b/src/a.ts',
			'@@ -20,2 +20,3 @@ bottom',
			' twenty',
			'-twenty-one',
			'+twenty-one changed',
			'+twenty-two',
			'',
		].join('\n'));
		// Both hunks together keep their original numbers.
		plan = moveSplitHunk(plan, '0:1', 'group-2');
		assert.ok(buildGroupPatch(plan, 'group-2').includes('@@ -1,3 +1,4 @@ top'));
		assert.ok(buildGroupPatch(plan, 'group-2').includes('@@ -20,2 +21,3 @@ bottom'));
		assert.ok(buildGroupPatch(plan, 'group-2').includes('+++ b/docs/readme.md\n@@ -0,0 +1,2 @@'));
		assert.strictEqual(buildGroupPatch(plan, 'group-1'), '');
		assert.strictEqual(buildGroupPatch(plan, 'nope'), '');
	});

	test('the prompt for Claude lists each group once with its branch and hunks', () => {
		const plan = initialSplitPlan(parseSplitDiff(DIFF));
		assert.deepStrictEqual(splitPlanPrompt(plan).split('\n'), [
			'The groups are confirmed. Do not regroup them or ask about them again; use exactly these:',
			'- "src": branch split/src, 2 hunks in src/a.ts (+3 -1). Hunks: src/a.ts @@ -1,3 +1,4 @@; src/a.ts @@ -20,2 +21,3 @@',
			'- "docs": branch split/docs, 1 hunk in docs/readme.md (+2 -0). Hunks: docs/readme.md @@ -0,0 +1,2 @@',
		]);
	});

	test('the confirmed groups are appended to the Split into pull requests request', () => {
		const plan = splitPlanPrompt(initialSplitPlan(parseSplitDiff(DIFF)));
		const resolution = { kind: 'prompt', templateId: 'split-pull-requests' } as const;
		const without = actionRequestText('splitPullRequests', resolution);
		assert.deepStrictEqual(actionRequestText('splitPullRequests', resolution, { plan }), `${without}

${plan}`);
	});

	test('issue 971: branch parts, the confirmation summary and the push prompt', () => {
		const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n';
		let plan = addSplitGroup(initialSplitPlan(parseSplitDiff(patch)));
		const [first, second] = plan.groups;
		plan = renameSplitBranch(plan, first.id, '  split/a  ');
		plan = renameSplitGroup(plan, first.id, '');
		plan = moveSplitFile(plan, 'a.txt', first.id);
		const parts = splitBranchParts(plan);
		assert.deepStrictEqual(parts.map(part => [part.branch, part.title]), [['split/a', 'split/a']]);
		assert.ok(parts[0].patch.includes('+two'));
		assert.ok(!parts.some(part => part.branch === second.branch));
		assert.strictEqual(splitBranchesSummary(plan), 'split/a (split/a)\n    a.txt');
		const prompt = splitBranchesPrompt([
			{ branch: 'split/a', title: 'A', worktreePath: '/r/.worktrees/split/a', commit: 'abc1234' },
			{ branch: 'split/b', title: 'B', worktreePath: '/r/.worktrees/split/b', error: 'taken' },
		]);
		assert.ok(prompt.includes('branch split/a, worktree /r/.worktrees/split/a, commit abc1234'));
		assert.ok(!prompt.includes('split/b'));
		assert.ok(prompt.includes('gh pr create --draft'));
		const stackedPrompt = splitBranchesPrompt([
			{ branch: 'split/a', title: 'A', worktreePath: '/r/.worktrees/split/a', commit: 'abc1234' },
			{ branch: 'split/b', title: 'B', worktreePath: '/r/.worktrees/split/b', commit: 'def5678', stackedOn: 'split/a' },
		]);
		assert.ok(stackedPrompt.includes('commit def5678, stacked on split/a'));
		assert.ok(stackedPrompt.includes('--base'));
	});
});
