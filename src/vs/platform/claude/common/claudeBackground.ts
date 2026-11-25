/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { StringSHA1 } from '../../../base/common/hash.js';
import { isAbsolute, join, normalize, relative } from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { CLAUDE_GIT_BRANCH_PREFIX_DEFAULT } from './claudeGitSettings.js';
import { ClaudeEffortLevel } from './claudeSessionSettings.js';
import { AgentMode } from './claudeContext.js';
import { ClaudeWorktreeSetup, ClaudeWorktreeSetupResult } from './claudeWorktreeSetup.js';
import { ClaudeBranchReviewScope } from './claudeBranchReview.js';
import { SplitBranchPart, SplitBranchResult } from './claudeSplitPlan.js';

/** How many background agents may run at once. */
export const CLAUDE_MAX_PARALLEL_SESSIONS_SETTING = 'claude.agent.maxParallelSessions';

export const CLAUDE_MAX_PARALLEL_SESSIONS_DEFAULT = 4;

export type BackgroundAgentStatus = 'starting' | 'running' | 'waiting' | 'complete' | 'failed';

/**
 * What a caller may set for one background run. Compare Models (issue 424)
 * sets the model, effort and budget per run; automations (issue 426) reuse
 * the same options. Absent fields keep what Start Background Agent does.
 */
export interface ClaudeBackgroundRunOptions {
	/**
	 * Task id, which names the branch (`<prefix><taskId>`) and the worktree
	 * folder. Letters, digits, `.`, `_` and `-` only. Default: a new UUID.
	 */
	readonly taskId?: string;
	/** Card title. Default: the prompt. */
	readonly title?: string;
	/** Model for the session. Default: the model a new session gets. */
	readonly modelId?: string;
	/** Effort for the session. Default: the model's configured effort. */
	readonly effort?: ClaudeEffortLevel;
	/** Spend cap in US dollars for the run's queries (`maxBudgetUsd`). Default: none. */
	readonly maxBudgetUsd?: number;
	/** False leaves the current chat selected. Default: true. */
	readonly select?: boolean;
	/** Mode the run's session starts in (an automation's `permissionMode`, issue 426). Default: the session's. */
	readonly mode?: AgentMode;
	/** Turn cap for the run's queries (`maxTurns`, issue 426). Default: no cap (issues 696, 707). */
	readonly maxTurns?: number;
	/** What Claude gets instead of the prompt, such as the prompt with its attachments (a multitask's, issue 686). The chat shows the prompt. */
	readonly compiled?: string;
}

/** True when `taskId` is safe as a branch suffix and a folder name. */
export function isBackgroundTaskId(taskId: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(taskId) && !taskId.includes('..') && !taskId.endsWith('.lock');
}

/**
 * One isolated coding agent. `worktreePath` is the only directory its session
 * may use as `cwd`. Two tasks never share that path, and it is never the
 * main workspace.
 */
export interface BackgroundAgentTask {
	id: string;
	sessionId: string;
	repoRoot: string;
	baseRef: string;
	worktreePath: string;
	branchName: string;
	status: BackgroundAgentStatus;
	title: string;
	filesChanged: number;
	added: number;
	removed: number;
	/** Command or test line from a real shell card. "tests not run" until one exists. */
	testStatus: string;
	conflicts: readonly BackgroundConflict[];
	/** True when the user stopped the session. */
	stopped: boolean;
}

export interface BackgroundFileChange {
	readonly relativePath: string;
	readonly originalText: string;
	readonly modifiedText: string;
	readonly existed: boolean;
}

export interface BackgroundConflict {
	readonly relativePath: string;
	readonly base: string;
	readonly ours: string;
	readonly theirs: string;
}

export interface BackgroundApplyResult {
	readonly applied: boolean;
	readonly conflicts: readonly BackgroundConflict[];
}

export const IClaudeWorktreeService = createDecorator<IClaudeWorktreeService>('claudeWorktreeService');

/**
 * Git worktree operations. The shared process is the only caller that spawns
 * Git. There is no method that copies a worktree directory.
 */
export interface IClaudeWorktreeService {
	readonly _serviceBrand: undefined;
	head(repoRoot: string): Promise<string>;
	add(repoRoot: string, worktreePath: string, branchName: string, baseRef: string): Promise<void>;
	/**
	 * Removes the worktree and its branch. `force` is set only after the user
	 * confirms a worktree that still has changes.
	 */
	remove(repoRoot: string, worktreePath: string, branchName: string, force?: boolean): Promise<void>;
	/**
	 * True when the worktree has uncommitted edits, untracked files, or commits
	 * that are not in `baseRef`.
	 */
	hasChanges(worktreePath: string, baseRef: string): Promise<boolean>;
	/**
	 * Patch of the worktree against `baseRef`, including commits on the agent
	 * branch, unstaged edits, and untracked files. This does not create a commit.
	 */
	diff(worktreePath: string, baseRef: string): Promise<string>;
	summarize(worktreePath: string, baseRef: string): Promise<{ filesChanged: number; added: number; removed: number }>;
	/**
	 * Reads the base and worktree versions of one path. A symlink whose target
	 * is outside the worktree is refused.
	 */
	readFilePair(worktreePath: string, baseRef: string, relativePath: string): Promise<BackgroundFileChange>;
	/** `git apply --3way` in the main workspace. Conflicts stay in the merge editor. */
	applyThreeWay(workspaceRoot: string, patch: string): Promise<{ conflicts: readonly BackgroundConflict[] }>;
	/** Copies the setup file's files into a new worktree and runs its commands there (issue 511). */
	setup?(repoRoot: string, worktreePath: string, setup: ClaudeWorktreeSetup): Promise<ClaudeWorktreeSetupResult>;
	/** The patch one commit made, `git show` without its header (issue 502). */
	commitDiff?(repoRoot: string, sha: string): Promise<string>;
	/** What changed from one commit to another, `git diff from to` (issue 927): the part a review has not seen yet. */
	rangeDiff?(repoRoot: string, from: string, to: string): Promise<string>;
	/** The branches a branch review can use as its base, the default branch first (issue 932). */
	branchReviewBases?(repoRoot: string): Promise<string[]>;
	/** The raw `git log --format=%H%x09%s head..HEAD`: the commits made since a turn began (issue 1054). */
	commitsSince?(repoRoot: string, head: string): Promise<string>;
	/** The raw log of revert commits, for the review knowledge file (issue 933). */
	recentReverts?(repoRoot: string): Promise<string>;
	/** How many different files commits changed since a time, in milliseconds since the epoch (issue 933). */
	changedFileCountSince?(repoRoot: string, sinceMs: number): Promise<number>;
	/** The diff a branch review sends: `base...HEAD`, or the staged changes when the scope is staged (issue 932). */
	branchReviewDiff?(repoRoot: string, scope: ClaudeBranchReviewScope, base: string | undefined): Promise<string>;
	/** The refs/notes/klawly note of a commit, or undefined (issue 961). Writing one never pushes it. */
	readAttributionNote?(repoRoot: string, sha: string): Promise<string | undefined>;
	writeAttributionNote?(repoRoot: string, sha: string, text: string): Promise<void>;
	/** The paths a commit changed. */
	commitFiles?(repoRoot: string, sha: string): Promise<string[]>;
	/** A file as a commit has it, or undefined when it is missing or not text. */
	showCommitFile?(repoRoot: string, sha: string, relativePath: string): Promise<string | undefined>;
	/** The object id of a file in a commit; equal ids mean equal content. */
	commitFileId?(repoRoot: string, sha: string, relativePath: string): Promise<string | undefined>;
	/** The newest commit that touched a file. */
	lastCommitTouching?(repoRoot: string, relativePath: string): Promise<string | undefined>;
	/** The noted commit a rewritten commit (amend, rebase, cherry-pick) came from. */
	notedOriginal?(repoRoot: string, sha: string): Promise<string | undefined>;
	/** Commits every uncommitted change as one WIP commit; false when there was nothing. Never pushes (issue 1240). */
	wipCommit?(worktreePath: string, message: string): Promise<boolean>;
	/** Bytes the worktree folder takes on disk, or undefined when it is gone (issue 865). */
	diskUsage?(worktreePath: string): Promise<number | undefined>;
	/** The whole uncommitted change as one patch, untracked and binary files included; the index is not touched (issue 971). */
	splitDiff?(repoRoot: string): Promise<string>;
	/** One branch and worktree per part under `<repo>/.worktrees/<branch>`, each with one commit. Never pushes (issue 971). */
	createSplitBranches?(repoRoot: string, parts: readonly SplitBranchPart[], stacked?: boolean): Promise<SplitBranchResult[]>;
}

/** A missing or non-positive value uses the default. The cap is at least 1. */
export function readMaxParallelSessions(value: unknown): number {
	const parsed = typeof value === 'number' ? value : CLAUDE_MAX_PARALLEL_SESSIONS_DEFAULT;
	if (!Number.isFinite(parsed) || parsed < 1) {
		return CLAUDE_MAX_PARALLEL_SESSIONS_DEFAULT;
	}
	return Math.floor(parsed);
}

export function normalizeRepoRoot(repoRoot: string): string {
	const trimmed = normalize(repoRoot).replace(/[\\/]+$/g, '');
	return isWindows ? trimmed.toLowerCase() : trimmed;
}

/** Stable directory name for one repository under `<userData>/worktrees`. */
export function repoHash(repoRoot: string): string {
	const sha = new StringSHA1();
	sha.update(normalizeRepoRoot(repoRoot));
	return sha.digest().slice(0, 12);
}

/** `<prefix><task-id>`. The prefix comes from `readClaudeBranchPrefix`, so git accepts it. */
export function backgroundBranchName(taskId: string, prefix = CLAUDE_GIT_BRANCH_PREFIX_DEFAULT): string {
	return `${prefix}${taskId}`;
}

/** `<userData>/worktrees/<repo-hash>/<task-id>`. */
export function backgroundWorktreePath(userDataPath: string, repoRoot: string, taskId: string): string {
	return join(userDataPath, 'worktrees', repoHash(repoRoot), taskId);
}

/**
 * `git worktree add -b <prefix><id> <userData>/worktrees/<repo-hash>/<id> <base>`.
 * The branch argument is `<prefix><id>` and is passed separately from `-b`.
 */
export function worktreeAddArguments(branchName: string, worktreePath: string, baseRef: string): readonly string[] {
	return ['worktree', 'add', '-b', branchName, worktreePath, baseRef];
}

export function worktreeDiffArguments(baseRef: string): readonly string[] {
	return ['diff', '--binary', baseRef];
}

export function worktreeApplyArguments(): readonly string[] {
	return ['apply', '--3way'];
}

/** True when `child` is `parent` or a path inside it. */
export function isPathInside(parent: string, child: string): boolean {
	const rel = relative(normalizeRepoRoot(parent), normalizeRepoRoot(child));
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * A background worktree has to live outside the workspace. Two agents that
 * resolve the same path are rejected before Git runs.
 */
export function assertIsolatedWorktree(repoRoot: string, worktreePath: string, existing: readonly string[]): void {
	if (!isAbsolute(worktreePath)) {
		throw new Error('The background worktree path is not absolute.');
	}
	if (isPathInside(repoRoot, worktreePath)) {
		throw new Error('A background agent cannot use the main workspace as its working tree.');
	}
	const next = normalizeRepoRoot(worktreePath);
	if (existing.some(path => normalizeRepoRoot(path) === next)) {
		throw new Error('Another background agent is already using that worktree.');
	}
}

const ACTIVE_STATUS: readonly BackgroundAgentStatus[] = ['starting', 'running', 'waiting'];

export function isActiveBackgroundStatus(status: BackgroundAgentStatus): boolean {
	return ACTIVE_STATUS.includes(status);
}

/** Paths from `diff --git` lines. Absolute paths and `..` are dropped. */
export function pathsInDiff(patch: string): string[] {
	const paths: string[] = [];
	for (const line of patch.split(/\r?\n/)) {
		const relativePath = pathFromDiffGitLine(line);
		if (!relativePath || !isSafeRelativePath(relativePath)) {
			continue;
		}
		paths.push(relativePath);
	}
	return paths;
}

/** The `b/` path from one `diff --git` line, including a quoted path that contains spaces. */
function pathFromDiffGitLine(line: string): string | undefined {
	const quoted = /^diff --git "a\/((?:[^"\\]|\\.)*)" "b\/((?:[^"\\]|\\.)*)"$/.exec(line);
	if (quoted) {
		return quoted[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
	}
	const plain = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
	return plain?.[2];
}

export function isSafeRelativePath(relativePath: string): boolean {
	if (!relativePath || relativePath.startsWith('/') || relativePath.startsWith('\\')) {
		return false;
	}
	if (/^[A-Za-z]:/.test(relativePath)) {
		return false;
	}
	const parts = relativePath.split(/[\\/]/);
	return parts.every(part => part.length > 0 && part !== '..');
}

export function parseNumstat(stdout: string): { filesChanged: number; added: number; removed: number } {
	let filesChanged = 0;
	let added = 0;
	let removed = 0;
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) {
			continue;
		}
		const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
		if (!match || !isSafeRelativePath(match[3].replace(/[{}]/g, ''))) {
			continue;
		}
		filesChanged++;
		added += match[1] === '-' ? 0 : Number(match[1]);
		removed += match[2] === '-' ? 0 : Number(match[2]);
	}
	return { filesChanged, added, removed };
}

export interface ShellStatusCard {
	readonly command?: string;
	readonly exitCode?: number;
	readonly state: string;
	readonly category?: string;
}

/** Uses a real shell card when one exists. Otherwise the tests have not been run. */
export function commandStatus(cards: readonly ShellStatusCard[]): string {
	const shells = cards.filter(card => card.category === 'shell' || card.command !== undefined);
	if (shells.length === 0) {
		return 'tests not run';
	}
	const last = shells[shells.length - 1];
	const name = last.command?.trim() || 'command';
	if (last.state === 'running') {
		return `${name} running`;
	}
	if (last.exitCode === undefined) {
		return 'tests not run';
	}
	return `${name} exited ${last.exitCode}`;
}

export interface BackgroundApplyPorts {
	diff(): Promise<string>;
	openExternalPatch(patch: string): Promise<{ accepted: boolean }>;
	applyPatch(patch: string): Promise<{ conflicts: readonly BackgroundConflict[] }>;
	openConflicts(conflicts: readonly BackgroundConflict[]): Promise<void>;
}

/**
 * Diff, then the review preview, then a three-way apply. A declined preview
 * does not touch the workspace. This function never copies a directory.
 */
export async function applyBackgroundAgent(ports: BackgroundApplyPorts): Promise<BackgroundApplyResult> {
	const patch = await ports.diff();
	if (!patch.trim()) {
		return { applied: false, conflicts: [] };
	}
	const preview = await ports.openExternalPatch(patch);
	if (!preview.accepted) {
		return { applied: false, conflicts: [] };
	}
	const result = await ports.applyPatch(patch);
	if (result.conflicts.length) {
		await ports.openConflicts(result.conflicts);
	}
	return { applied: true, conflicts: result.conflicts };
}

/** Join a relative git path onto a root without letting `..` escape. */
export function resolveSafeChild(root: string, relativePath: string): string {
	if (!isSafeRelativePath(relativePath)) {
		throw new Error('That patch path is outside the repository.');
	}
	const child = join(root, ...relativePath.split(/[\\/]/));
	if (!isPathInside(root, child)) {
		throw new Error('That patch path is outside the repository.');
	}
	return child;
}
