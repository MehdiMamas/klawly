/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { appendFile, copyFile, mkdir, readFile, realpath, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { generateUuid } from '../../../base/common/uuid.js';
import { dirname, isAbsolute, join } from '../../../base/common/path.js';
import { ClaudeBranchReviewScope, claudeBranchReviewBases, claudeBranchReviewDiffArguments } from '../common/claudeBranchReview.js';
import { SplitBranchPart, SplitBranchResult, branchNameProblem } from '../common/claudeSplitPlan.js';
import { BackgroundConflict, BackgroundFileChange, isPathInside, isSafeRelativePath, parseNumstat, resolveSafeChild, worktreeAddArguments, worktreeApplyArguments, worktreeDiffArguments } from '../common/claudeBackground.js';
import { CLAUDE_REVIEW_REVERTS_LOG_ARGS } from '../common/claudeReviewKnowledge.js';

interface GitResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

const GIT_TIMEOUT_MS = 60_000;

async function runGit(cwd: string, args: readonly string[], input?: string, env?: Record<string, string>): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', args.slice(), {
			cwd,
			env: env ? { ...process.env, ...env } : undefined,
			windowsHide: true,
			stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let settled = false;
		const timer = setTimeout(() => {
			child.kill();
			finish(new Error('Git took too long.'));
		}, GIT_TIMEOUT_MS);
		const finish = (error?: Error, result?: GitResult) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			if (error) {
				reject(error);
			} else if (result) {
				resolve(result);
			}
		};
		child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
		child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
		child.on('error', error => {
			const code = (error as NodeJS.ErrnoException).code;
			finish(new Error(code === 'ENOENT'
				? 'Git is not available, so the background worktree was not created.'
				: error.message));
		});
		child.on('close', code => {
			finish(undefined, {
				code,
				stdout: Buffer.concat(stdout).toString('utf8'),
				stderr: Buffer.concat(stderr).toString('utf8'),
			});
		});
		if (input !== undefined && child.stdin) {
			endGitInput(child.stdin, input);
		}
	});
}

const OUTSIDE_WORKTREE = 'That file links outside the worktree.';

/**
 * Writes a patch to Git's stdin. An EPIPE listener is required: Git can exit
 * before it reads the patch, and an unhandled stdin error would crash the
 * shared process.
 */
export function endGitInput(stdin: { end(chunk: string): void; on(event: 'error', listener: (error: Error) => void): void }, input: string): void {
	stdin.on('error', () => { /* EPIPE: the child closed stdin before the write finished. */ });
	stdin.end(input);
}

function gitError(result: GitResult, fallback: string): Error {
	const detail = (result.stderr || result.stdout).trim();
	return new Error(detail || fallback);
}

function isLockError(result: GitResult): boolean {
	const text = `${result.stderr}\n${result.stdout}`;
	return text.includes('index.lock') || text.includes('could not lock') || text.includes('File exists');
}

async function runGitOk(cwd: string, args: readonly string[], input?: string, env?: Record<string, string>): Promise<GitResult> {
	let last: GitResult | undefined;
	for (let attempt = 0; attempt < 5; attempt++) {
		const result = await runGit(cwd, args, input, env);
		if (result.code === 0) {
			return result;
		}
		last = result;
		if (!isLockError(result) || attempt === 4) {
			break;
		}
		await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
	}
	throw gitError(last ?? { code: 1, stdout: '', stderr: '' }, 'Git failed.');
}

export async function gitHead(repoRoot: string): Promise<string> {
	const result = await runGitOk(repoRoot, ['rev-parse', 'HEAD']);
	const head = result.stdout.trim();
	if (!head) {
		throw new Error('The repository has no commits to branch a background agent from.');
	}
	return head;
}

export async function gitAddWorktree(repoRoot: string, worktreePath: string, branchName: string, baseRef: string): Promise<void> {
	await mkdir(dirname(worktreePath), { recursive: true });
	await runGitOk(repoRoot, worktreeAddArguments(branchName, worktreePath, baseRef));
}

function isAbsentWorktree(result: GitResult): boolean {
	const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
	return text.includes('not a working tree') || text.includes('not a git repository');
}

export async function gitRemoveWorktree(repoRoot: string, worktreePath: string, branchName: string, force = false): Promise<void> {
	const args = ['worktree', 'remove'];
	if (force) {
		args.push('--force');
	}
	args.push(worktreePath);
	let removed: GitResult | undefined;
	for (let attempt = 0; attempt < 5; attempt++) {
		removed = await runGit(repoRoot, args);
		if (removed.code === 0 || isAbsentWorktree(removed)) {
			break;
		}
		if (!isLockError(removed) || attempt === 4) {
			throw gitError(removed, 'Git could not remove the worktree.');
		}
		await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
	}
	const branch = await runGit(repoRoot, ['branch', '-D', branchName]);
	if (branch.code !== 0 && !branch.stderr.includes('not found')) {
		throw gitError(branch, 'Git could not delete the agent branch.');
	}
}

/** True when the worktree is dirty or has commits that `baseRef` does not. */
export async function gitHasChanges(worktreePath: string, baseRef: string): Promise<boolean> {
	const status = await runGitOk(worktreePath, ['status', '--porcelain']);
	if (status.stdout.trim()) {
		return true;
	}
	const ahead = await runGit(worktreePath, ['rev-list', '--count', `${baseRef}..HEAD`]);
	return ahead.code === 0 && ahead.stdout.trim() !== '0';
}

/**
 * Commits everything uncommitted in a worktree as one WIP commit so a stopped
 * helper's work survives. Returns false when there was nothing to commit.
 * Never pushes.
 */
export async function gitWipCommit(worktreePath: string, message: string): Promise<boolean> {
	const status = await runGitOk(worktreePath, ['status', '--porcelain']);
	if (!status.stdout.trim()) {
		return false;
	}
	await runGitOk(worktreePath, ['add', '-A']);
	await runGitOk(worktreePath, ['commit', '-m', message]);
	return true;
}

/**
 * Records untracked files in the index without staging their contents or
 * committing, so a later diff includes them.
 */
async function intendUntracked(worktreePath: string): Promise<void> {
	const listed = await runGitOk(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']);
	const paths = listed.stdout.split('\0').filter(path => path.length > 0 && isSafeRelativePath(path));
	if (paths.length === 0) {
		return;
	}
	await runGitOk(worktreePath, ['add', '-N', '--', ...paths]);
}

export async function gitDiff(worktreePath: string, baseRef: string): Promise<string> {
	await intendUntracked(worktreePath);
	const result = await runGitOk(worktreePath, worktreeDiffArguments(baseRef));
	return result.stdout;
}

export async function gitSummarize(worktreePath: string, baseRef: string): Promise<{ filesChanged: number; added: number; removed: number }> {
	await intendUntracked(worktreePath);
	const result = await runGitOk(worktreePath, ['diff', '--numstat', baseRef]);
	return parseNumstat(result.stdout);
}

export async function gitReadFilePair(worktreePath: string, baseRef: string, relativePath: string): Promise<BackgroundFileChange> {
	if (!isSafeRelativePath(relativePath)) {
		throw new Error('That patch path is outside the repository.');
	}
	const original = await runGit(worktreePath, ['show', `${baseRef}:${relativePath}`]);
	const existed = original.code === 0;
	const modified = await readWorktreeFile(worktreePath, relativePath);
	return {
		relativePath,
		originalText: existed ? original.stdout : '',
		modifiedText: modified,
		existed,
	};
}

async function readWorktreeFile(worktreePath: string, relativePath: string): Promise<string> {
	const child = resolveSafeChild(worktreePath, relativePath);
	let rootReal: string;
	try {
		rootReal = await realpath(worktreePath);
	} catch {
		return '';
	}
	try {
		const real = await realpath(child);
		if (!isPathInside(rootReal, real)) {
			throw new Error(OUTSIDE_WORKTREE);
		}
		return await readFile(real, 'utf8');
	} catch (error) {
		if (error instanceof Error && error.message === OUTSIDE_WORKTREE) {
			throw error;
		}
		return '';
	}
}

function parseUnmerged(stdout: string): string[] {
	const paths = new Set<string>();
	for (const line of stdout.split(/\r?\n/)) {
		const match = /^\d+ [0-9a-f]+ ([123])\t(.+)$/.exec(line);
		if (match && isSafeRelativePath(match[2])) {
			paths.add(match[2]);
		}
	}
	return [...paths];
}

async function showStage(workspaceRoot: string, stage: 1 | 2 | 3, relativePath: string): Promise<string> {
	const result = await runGit(workspaceRoot, ['show', `:${stage}:${relativePath}`]);
	return result.code === 0 ? result.stdout : '';
}

/**
 * Applies `patch` with `git apply --3way` in the main workspace.
 * Unmerged paths are returned as merge-editor sides. The worktree directory
 * is not copied.
 */
export async function gitApplyThreeWay(workspaceRoot: string, patch: string): Promise<{ conflicts: readonly BackgroundConflict[] }> {
	if (!patch.trim()) {
		return { conflicts: [] };
	}
	const applied = await runGit(workspaceRoot, worktreeApplyArguments(), patch);
	const unmerged = await runGit(workspaceRoot, ['ls-files', '-u']);
	const paths = unmerged.code === 0 ? parseUnmerged(unmerged.stdout) : [];
	if (applied.code !== 0 && paths.length === 0) {
		throw gitError(applied, 'The patch could not be applied.');
	}
	const conflicts: BackgroundConflict[] = [];
	for (const relativePath of paths) {
		conflicts.push({
			relativePath,
			base: await showStage(workspaceRoot, 1, relativePath),
			ours: await showStage(workspaceRoot, 2, relativePath),
			theirs: await showStage(workspaceRoot, 3, relativePath),
		});
	}
	return { conflicts };
}

/** The patch one commit made, without the header (issue 502). Only a full object name is accepted. */
export async function gitCommitDiff(repoRoot: string, sha: string): Promise<string> {
	if (!/^[0-9a-f]{40,64}$/.test(sha)) {
		throw new Error('Not a commit id.');
	}
	const result = await runGitOk(repoRoot, ['show', '--no-color', '--format=', '--patch', '-M', sha]);
	return result.stdout;
}

/** What changed from one commit to another (issue 927). Only full object names are accepted. */
export async function gitRangeDiff(repoRoot: string, from: string, to: string): Promise<string> {
	if (!/^[0-9a-f]{40,64}$/.test(from) || !/^[0-9a-f]{40,64}$/.test(to)) {
		throw new Error('Not a commit id.');
	}
	const result = await runGitOk(repoRoot, ['diff', '--no-color', '-M', from, to]);
	return result.stdout;
}

/** Branches to offer as the base of a branch review, the repository's default first (issue 932). */
export async function gitBranchReviewBases(repoRoot: string): Promise<string[]> {
	const [list, head, current] = await Promise.all([
		runGit(repoRoot, ['branch', '-a', '--format=%(refname:short)']),
		runGit(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
		runGit(repoRoot, ['branch', '--show-current']),
	]);
	const lines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	return claudeBranchReviewBases({
		originHead: head.code === 0 ? lines(head.stdout)[0] : undefined,
		branches: list.code === 0 ? lines(list.stdout) : [],
		current: current.code === 0 ? lines(current.stdout)[0] : undefined,
	});
}

/** The diff a branch review sends: the work since the merge base, or the staged changes. */
export async function gitBranchReviewDiff(repoRoot: string, scope: ClaudeBranchReviewScope, base: string | undefined): Promise<string> {
	const args = claudeBranchReviewDiffArguments(scope, base);
	if (!args) {
		throw new Error('Pick a base branch to review against.');
	}
	return (await runGitOk(repoRoot, args)).stdout;
}

/** The raw `git log` of the commits made after `head`, newest first; empty when `head` is unknown. */
export async function gitCommitsSince(repoRoot: string, head: string): Promise<string> {
	if (!/^[0-9a-f]{7,64}$/i.test(head)) {
		return '';
	}
	const result = await runGit(repoRoot, ['log', '--format=%H%x09%s', `${head}..HEAD`]);
	return result.code === 0 ? result.stdout : '';
}

/** The raw `git log` of revert and rollback commits, for the review knowledge file (issue 933). */
export async function gitRecentReverts(repoRoot: string): Promise<string> {
	const result = await runGit(repoRoot, [...CLAUDE_REVIEW_REVERTS_LOG_ARGS]);
	return result.code === 0 ? result.stdout : '';
}

/** How many different files commits changed since a time (milliseconds since the epoch). */
export async function gitChangedFileCountSince(repoRoot: string, sinceMs: number): Promise<number> {
	if (!Number.isFinite(sinceMs)) {
		return 0;
	}
	const result = await runGit(repoRoot, ['log', '--no-color', `--since=${Math.floor(sinceMs / 1000)}`, '--name-only', '--format=']);
	return result.code === 0 ? new Set(result.stdout.split(/\r?\n/).filter(line => line.trim())).size : 0;
}

const FULL_OBJECT_NAME = /^[0-9a-f]{40,64}$/;

function checkObjectName(sha: string): void {
	if (!FULL_OBJECT_NAME.test(sha)) {
		throw new Error('Not a commit id.');
	}
}

/** Line-attribution notes live in their own ref, so they never mix with the user's notes (issue 961). */
const ATTRIBUTION_NOTES_REF = 'klawly';

/** Writes (or replaces) the line-attribution note of one commit. Local only: nothing here pushes the ref. */
export async function gitWriteAttributionNote(repoRoot: string, sha: string, text: string): Promise<void> {
	checkObjectName(sha);
	await runGitOk(repoRoot, ['notes', `--ref=${ATTRIBUTION_NOTES_REF}`, 'add', '-f', '-F', '-', sha], text);
}

/** The line-attribution note of one commit, or undefined when it has none. */
export async function gitReadAttributionNote(repoRoot: string, sha: string): Promise<string | undefined> {
	checkObjectName(sha);
	const result = await runGit(repoRoot, ['notes', `--ref=${ATTRIBUTION_NOTES_REF}`, 'show', sha]);
	return result.code === 0 ? result.stdout : undefined;
}

/** The files a commit changed, as repository-relative paths. A root commit counts. */
export async function gitCommitFiles(repoRoot: string, sha: string): Promise<string[]> {
	checkObjectName(sha);
	const result = await runGitOk(repoRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', '--no-renames', sha]);
	return result.stdout.split('\0').filter(path => path.length > 0 && isSafeRelativePath(path));
}

/** A file as one commit has it, or undefined when the commit has no such file or it is not text. */
export async function gitShowCommitFile(repoRoot: string, sha: string, relativePath: string): Promise<string | undefined> {
	checkObjectName(sha);
	if (!isSafeRelativePath(relativePath)) {
		return undefined;
	}
	const result = await runGit(repoRoot, ['show', `${sha}:${relativePath}`]);
	return result.code === 0 && !result.stdout.includes('\0') ? result.stdout : undefined;
}

/** The object id of a file in a commit, so two commits can be compared without reading the text. */
export async function gitCommitFileId(repoRoot: string, sha: string, relativePath: string): Promise<string | undefined> {
	checkObjectName(sha);
	if (!isSafeRelativePath(relativePath)) {
		return undefined;
	}
	const result = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}:${relativePath}`]);
	return result.code === 0 ? result.stdout.trim() : undefined;
}

/** The newest commit on HEAD's history that touched a file, or undefined. */
export async function gitLastCommitTouching(repoRoot: string, relativePath: string): Promise<string | undefined> {
	if (!isSafeRelativePath(relativePath)) {
		return undefined;
	}
	const result = await runGit(repoRoot, ['log', '-1', '--format=%H', '--', relativePath]);
	const sha = result.stdout.trim();
	return result.code === 0 && FULL_OBJECT_NAME.test(sha) ? sha : undefined;
}

/**
 * The commit a rewritten commit (amend, rebase, cherry-pick) came from, if one of the newest 200 commits with a
 * note has the same author time and subject. Both survive all three rewrites.
 */
export async function gitNotedOriginal(repoRoot: string, sha: string): Promise<string | undefined> {
	checkObjectName(sha);
	const own = await runGit(repoRoot, ['log', '-1', '--format=%at %s', sha]);
	if (own.code !== 0) {
		return undefined;
	}
	const listed = await runGit(repoRoot, ['notes', `--ref=${ATTRIBUTION_NOTES_REF}`, 'list']);
	const noted = listed.code === 0
		? listed.stdout.split(/\r?\n/).map(line => line.split(' ')[1]).filter(name => FULL_OBJECT_NAME.test(name ?? '') && name !== sha).slice(-200)
		: [];
	if (noted.length === 0) {
		return undefined;
	}
	const found = await runGit(repoRoot, ['log', '--no-walk=unsorted', '--format=%H %at %s', ...noted]);
	const wanted = own.stdout.trim();
	for (const line of found.stdout.split(/\r?\n/)) {
		const space = line.indexOf(' ');
		if (space > 0 && line.slice(space + 1) === wanted) {
			return line.slice(0, space);
		}
	}
	return undefined;
}

/**
 * The whole uncommitted change of the repository as one patch, untracked and binary
 * files included, for Split into Pull Requests (issue 971). It stages into a copy of
 * the index, so the user's own index and files are never touched.
 */
export async function gitSplitDiff(repoRoot: string): Promise<string> {
	const indexPath = (await runGitOk(repoRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).stdout.trim();
	const scratch = join(tmpdir(), `klawly-split-${generateUuid()}.index`);
	const env = { GIT_INDEX_FILE: scratch };
	try {
		try {
			// A copy keeps the stat cache, so `add -A` does not hash every file again.
			await copyFile(indexPath, scratch);
		} catch {
			await runGitOk(repoRoot, ['read-tree', 'HEAD'], undefined, env);
		}
		await runGitOk(repoRoot, ['add', '-A'], undefined, env);
		const result = await runGitOk(repoRoot, ['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', 'HEAD'], undefined, env);
		return result.stdout;
	} finally {
		await rm(scratch, { force: true });
	}
}

/** Keeps `.worktrees/` out of the main checkout's status without editing its `.gitignore`. */
async function excludeWorktreesFolder(repoRoot: string): Promise<void> {
	const ignored = await runGit(repoRoot, ['check-ignore', '-q', '.worktrees/']);
	if (ignored.code === 0) {
		return;
	}
	const common = (await runGitOk(repoRoot, ['rev-parse', '--git-common-dir'])).stdout.trim();
	const info = join(isAbsolute(common) ? common : join(repoRoot, common), 'info');
	await mkdir(info, { recursive: true });
	const exclude = join(info, 'exclude');
	const current = await readFile(exclude, 'utf8').catch(() => '');
	await appendFile(exclude, `${current.length > 0 && !current.endsWith('\n') ? '\n' : ''}.worktrees/\n`);
}

/**
 * Makes one branch and worktree per part under `<repo>/.worktrees/<branch>`, from HEAD,
 * applies the part's patch there and commits it (issue 971). The main checkout keeps its
 * branch and its uncommitted changes. A part that fails is removed again and reported;
 * the parts made before it stay. Nothing is pushed. When `stacked`, each branch starts from the
 * last one made instead of HEAD, so its pull request shows only its own group (issue 972).
 */
export async function gitCreateSplitBranches(repoRoot: string, parts: readonly SplitBranchPart[], stacked = false): Promise<SplitBranchResult[]> {
	const top = (await runGitOk(repoRoot, ['rev-parse', '--show-toplevel'])).stdout.trim();
	const head = await gitHead(top);
	await excludeWorktreesFolder(top);
	const results: SplitBranchResult[] = [];
	let previous: SplitBranchResult | undefined;
	for (const part of parts) {
		const worktreePath = join(top, '.worktrees', ...part.branch.split('/'));
		const stackedOn = stacked && previous ? previous.branch : undefined;
		const base = { branch: part.branch, title: part.title, worktreePath, ...(stackedOn ? { stackedOn } : {}) };
		if (branchNameProblem(part.branch)) {
			results.push({ ...base, error: 'That branch name is not valid.' });
			continue;
		}
		if (!part.patch) {
			results.push({ ...base, error: 'That group has no changes.' });
			continue;
		}
		try {
			await gitAddWorktree(top, worktreePath, part.branch, previous && stacked ? previous.commit! : head);
		} catch (error) {
			// The branch or folder may be someone else's: leave it alone.
			results.push({ ...base, error: error instanceof Error ? error.message : String(error) });
			continue;
		}
		try {
			await runGitOk(worktreePath, ['apply', '--index', '--whitespace=nowarn'], part.patch);
			await runGitOk(worktreePath, ['commit', '-q', '-m', part.title]);
			const commit = (await runGitOk(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
			previous = { ...base, commit };
			results.push(previous);
		} catch (error) {
			await gitRemoveWorktree(top, worktreePath, part.branch, true).catch(() => undefined);
			results.push({ ...base, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return results;
}
