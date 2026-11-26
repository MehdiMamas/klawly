/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { lstat, mkdtemp, readdir, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { localize } from '../../../nls.js';
import { IClaudeCleanupResult, IClaudeWorktree, IClaudeWorktreeDiff } from '../common/claudeRuntime.js';
import { claudeWorktreeName, isCleanupDue, parseNumstat, parseWorktreeList, sameWorktreeName } from '../common/claudeWorktrees.js';
import { runGit } from './claudeGit.js';

/** Total size of the files under a folder; symbolic links count as themselves, never followed. */
async function folderSize(path: string): Promise<number> {
	let total = 0;
	let entries;
	try {
		entries = await readdir(path, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const child = join(path, entry.name);
		try {
			total += entry.isDirectory() ? await folderSize(child) : (await lstat(child)).size;
		} catch {
			// gone while counting
		}
	}
	return total;
}

/**
 * The worktrees under `<cwd>/.claude/worktrees/`. `isRunning` says whether a live session works in a path:
 * the CLI keeps the process in the main folder, so the runtime knows by the session's reported folder or its `--worktree` name.
 */
export async function listClaudeWorktrees(cwd: string, env: NodeJS.ProcessEnv, isRunning: (path: string, name: string) => boolean): Promise<IClaudeWorktree[]> {
	const listed = await runGit(cwd, ['worktree', 'list', '--porcelain'], env);
	if (!listed.ok) {
		return [];
	}
	const worktrees: IClaudeWorktree[] = [];
	for (const entry of parseWorktreeList(listed.stdout)) {
		const name = claudeWorktreeName(entry.path);
		if (!name) {
			continue;
		}
		const [status, size, info, merged] = await Promise.all([
			runGit(entry.path, ['status', '--porcelain'], env),
			folderSize(entry.path),
			stat(entry.path).catch(() => undefined),
			entry.branch ? runGit(cwd, ['merge-base', '--is-ancestor', entry.branch, 'HEAD'], env) : undefined,
		]);
		worktrees.push({
			name,
			path: entry.path,
			branch: entry.branch,
			sizeBytes: size,
			modified: info?.mtimeMs ?? 0,
			// a Git that cannot answer counts as dirty: nothing is removed on a guess
			dirty: !status.ok || status.stdout.trim().length > 0,
			running: isRunning(entry.path, name),
			merged: merged?.ok === true,
		});
	}
	return worktrees.sort((a, b) => b.modified - a.modified);
}

async function findWorktree(cwd: string, name: string, env: NodeJS.ProcessEnv, isRunning: (path: string, name: string) => boolean): Promise<IClaudeWorktree> {
	const found = (await listClaudeWorktrees(cwd, env, isRunning)).find(w => sameWorktreeName(w.name, name));
	if (!found) {
		throw new Error(localize('claudeWorktreeMissing', "The worktree {0} was not found.", name));
	}
	return found;
}

/** `git worktree remove` without `--force`, then `git branch -d`, which Git itself refuses unless the branch is merged. */
export async function removeClaudeWorktree(cwd: string, name: string, env: NodeJS.ProcessEnv, isRunning: (path: string, name: string) => boolean): Promise<void> {
	const worktree = await findWorktree(cwd, name, env, isRunning);
	if (worktree.running) {
		throw new Error(localize('claudeWorktreeRunning', "A session is still running in {0}.", worktree.name));
	}
	const removed = await runGit(cwd, ['worktree', 'remove', worktree.path], env);
	if (!removed.ok) {
		throw new Error(removed.output.trim());
	}
	if (worktree.branch && worktree.merged) {
		await runGit(cwd, ['branch', '-d', worktree.branch], env);
	}
}

/** The automatic cleanup: only worktrees `isCleanupDue` picks, one by one, each through the same non-forced removal. */
export async function cleanupClaudeWorktrees(cwd: string, days: number, env: NodeJS.ProcessEnv, isRunning: (path: string, name: string) => boolean, now: number = Date.now()): Promise<IClaudeCleanupResult> {
	const removed: string[] = [];
	const kept: string[] = [];
	if (days <= 0) {
		return { removed, kept };
	}
	for (const worktree of await listClaudeWorktrees(cwd, env, isRunning)) {
		if (!isCleanupDue(worktree, days, now)) {
			kept.push(worktree.name);
			continue;
		}
		try {
			await removeClaudeWorktree(cwd, worktree.name, env, isRunning);
			removed.push(worktree.name);
		} catch {
			kept.push(worktree.name);
		}
	}
	return { removed, kept };
}

/** The patch of a worktree against the commit it branched from, and that commit. New files are added with intent-to-add so they show up. */
async function worktreePatch(cwd: string, worktree: IClaudeWorktree, env: NodeJS.ProcessEnv): Promise<{ patch: string; numstat: string }> {
	const head = await runGit(worktree.path, ['rev-parse', 'HEAD'], env);
	const base = await runGit(cwd, ['merge-base', 'HEAD', head.stdout.trim()], env);
	if (!head.ok || !base.ok) {
		throw new Error((base.ok ? head : base).output.trim());
	}
	await runGit(worktree.path, ['add', '-N', '.'], env);
	const [patch, numstat] = await Promise.all([
		runGit(worktree.path, ['diff', '--binary', base.stdout.trim()], env),
		runGit(worktree.path, ['diff', '--numstat', base.stdout.trim()], env),
	]);
	if (!patch.ok) {
		throw new Error(patch.output.trim());
	}
	return { patch: patch.stdout, numstat: numstat.stdout };
}

export async function claudeWorktreeDiff(cwd: string, name: string, env: NodeJS.ProcessEnv, isRunning: (path: string, name: string) => boolean): Promise<IClaudeWorktreeDiff> {
	const { patch, numstat } = await worktreePatch(cwd, await findWorktree(cwd, name, env, isRunning), env);
	return parseNumstat(numstat, patch);
}

/**
 * Applies the worktree's patch to the folder. A patch that fits as is goes in with `git apply`, which is all or nothing.
 * Otherwise `--3way` is tried against a scratch index first; a conflict there ends with Git's message and the folder untouched.
 */
export async function applyClaudeWorktree(cwd: string, name: string, env: NodeJS.ProcessEnv, isRunning: (path: string, name: string) => boolean): Promise<void> {
	const { patch } = await worktreePatch(cwd, await findWorktree(cwd, name, env, isRunning), env);
	if (!patch.trim()) {
		throw new Error(localize('claudeApplyEmpty', "{0} changed nothing, so there is nothing to apply.", name));
	}
	if ((await runGit(cwd, ['apply', '--check'], env, patch)).ok) {
		const applied = await runGit(cwd, ['apply'], env, patch);
		if (!applied.ok) {
			throw new Error(applied.output.trim());
		}
		return;
	}
	const scratch = await mkdtemp(join(tmpdir(), 'klawly-apply-'));
	try {
		const scratchEnv = { ...env, GIT_INDEX_FILE: join(scratch, 'index') };
		await runGit(cwd, ['read-tree', 'HEAD'], scratchEnv);
		const trial = await runGit(cwd, ['apply', '--cached', '--3way'], scratchEnv, patch);
		if (!trial.ok) {
			throw new Error(trial.output.trim());
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
	if ((await runGit(cwd, ['status', '--porcelain', '--untracked-files=no'], env)).stdout.trim()) {
		throw new Error(localize('claudeApplyDirty', "The patch only fits with a merge, and the folder has uncommitted changes. Commit or stash them, then apply again."));
	}
	const applied = await runGit(cwd, ['apply', '--3way'], env, patch);
	if (!applied.ok) {
		throw new Error(applied.output.trim());
	}
}
