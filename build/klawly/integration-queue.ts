/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds `integration/queue`: origin/main plus every open PR labeled `ready-batch` (issue 1530), so follow-on
// work can start before the merge train drains (docs/rules/55-tiered-testing.md).
// PRs are merged in number order; a PR that conflicts is aborted, skipped and reported. A stacked PR (its base
// is another queued PR's branch) is included too, since its head carries its base's commits.
// Only the `integration/queue` branch is force-pushed, never main or a PR branch.
//
// Usage: node build/klawly/integration-queue.ts [--label <name>] [--no-push] [--repo <owner/name>]
//   --no-push   build and report only, push nothing
// The merge happens in a throwaway detached worktree under .worktrees/, removed at the end.

import { execFileSync, spawnSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import path from 'path';

export interface QueuedPr {
	readonly number: number;
	readonly headRefName: string;
	readonly baseRefName: string;
	readonly isCrossRepository: boolean;
}

/** The PRs to merge, in number order: base is main or another queued PR's branch; forks are left out. */
export function selectPrs(prs: readonly QueuedPr[], mainBranch = 'main'): QueuedPr[] {
	const sorted = [...prs].sort((a, b) => a.number - b.number);
	const heads = new Set(sorted.map(pr => pr.headRefName));
	return sorted.filter(pr => !pr.isCrossRepository && (pr.baseRefName === mainBranch || heads.has(pr.baseRefName)));
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function main(): void {
	const args = process.argv.slice(2);
	const arg = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
	const label = arg('--label', 'ready-batch');
	const repo = arg('--repo', 'MehdiMamas/klawly-ide');
	const push = !args.includes('--no-push');
	const root = git(process.cwd(), 'rev-parse', '--show-toplevel');
	const dir = path.join(root, '.worktrees', 'integration-queue-tmp');

	const json = execFileSync('gh', ['pr', 'list', '-R', repo, '--label', label, '--state', 'open', '--limit', '200', '--json', 'number,headRefName,baseRefName,isCrossRepository'], { encoding: 'utf8' });
	const all = JSON.parse(json) as QueuedPr[];
	const prs = selectPrs(all);
	const left = all.filter(pr => !prs.includes(pr)).map(pr => pr.number);

	git(root, 'fetch', 'origin', 'main');
	if (existsSync(dir)) {
		spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root });
		rmSync(dir, { recursive: true, force: true });
	}
	git(root, 'worktree', 'add', '--detach', dir, 'origin/main');
	const merged: number[] = [];
	const conflicted: Array<{ n: number; files: string }> = [];
	const failed: number[] = [];
	try {
		for (const pr of prs) {
			try {
				git(dir, 'fetch', 'origin', `pull/${pr.number}/head`);
			} catch {
				failed.push(pr.number);
				continue;
			}
			const res = spawnSync('git', ['-c', 'user.name=Klawly integration', '-c', 'user.email=noreply@klawly.invalid', 'merge', '--no-ff', '-m', `Merge PR #${pr.number} into integration/queue`, 'FETCH_HEAD'], { cwd: dir, encoding: 'utf8' });
			if (res.status === 0) {
				merged.push(pr.number);
			} else {
				const files = spawnSync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: dir, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).join(', ');
				spawnSync('git', ['merge', '--abort'], { cwd: dir });
				conflicted.push({ n: pr.number, files });
			}
		}
		const head = git(dir, 'rev-parse', '--short', 'HEAD');
		if (push) {
			git(dir, 'push', '--force', 'origin', 'HEAD:refs/heads/integration/queue');
		}
		console.log(`integration/queue at ${head} (${push ? 'pushed' : 'not pushed'}), base origin/main ${git(root, 'rev-parse', '--short', 'origin/main')}`);
		console.log(`merged (${merged.length}): ${merged.map(n => '#' + n).join(' ') || 'none'}`);
		console.log(`conflicted (${conflicted.length}): ${conflicted.map(c => `#${c.n} [${c.files}]`).join('; ') || 'none'}`);
		if (failed.length) {
			console.log(`fetch failed: ${failed.map(n => '#' + n).join(' ')}`);
		}
		if (left.length) {
			console.log(`skipped (fork or base not queued): ${left.map(n => '#' + n).join(' ')}`);
		}
	} finally {
		spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))) {
	main();
}
