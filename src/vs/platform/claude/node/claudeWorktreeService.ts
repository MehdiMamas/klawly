/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { BackgroundConflict, BackgroundFileChange, IClaudeWorktreeService } from '../common/claudeBackground.js';
import { ClaudeWorktreeSetup, ClaudeWorktreeSetupResult } from '../common/claudeWorktreeSetup.js';
import { ClaudeBranchReviewScope } from '../common/claudeBranchReview.js';
import { SplitBranchPart, SplitBranchResult } from '../common/claudeSplitPlan.js';
import { runClaudeWorktreeSetup } from './claudeWorktreeSetupRunner.js';
import { directorySize } from './claudeWorktreeDisk.js';
import { gitAddWorktree, gitApplyThreeWay, gitCreateSplitBranches, gitSplitDiff, gitBranchReviewBases, gitBranchReviewDiff, gitChangedFileCountSince,
	gitCommitsSince, gitRecentReverts, gitCommitDiff, gitCommitFileId, gitCommitFiles, gitLastCommitTouching, gitRangeDiff, gitNotedOriginal, gitReadAttributionNote, gitShowCommitFile, gitWriteAttributionNote, gitDiff, gitHasChanges, gitHead, gitReadFilePair, gitRemoveWorktree, gitSummarize, gitWipCommit } from './claudeWorktreeGit.js';

/** Shared-process Git worktrees. Spawn stays in this layer. */
export class ClaudeWorktreeService extends Disposable implements IClaudeWorktreeService {
	declare readonly _serviceBrand: undefined;

	head(repoRoot: string): Promise<string> {
		return gitHead(repoRoot);
	}

	add(repoRoot: string, worktreePath: string, branchName: string, baseRef: string): Promise<void> {
		return gitAddWorktree(repoRoot, worktreePath, branchName, baseRef);
	}

	remove(repoRoot: string, worktreePath: string, branchName: string, force?: boolean): Promise<void> {
		return gitRemoveWorktree(repoRoot, worktreePath, branchName, force);
	}

	hasChanges(worktreePath: string, baseRef: string): Promise<boolean> {
		return gitHasChanges(worktreePath, baseRef);
	}

	diff(worktreePath: string, baseRef: string): Promise<string> {
		return gitDiff(worktreePath, baseRef);
	}

	summarize(worktreePath: string, baseRef: string): Promise<{ filesChanged: number; added: number; removed: number }> {
		return gitSummarize(worktreePath, baseRef);
	}

	readFilePair(worktreePath: string, baseRef: string, relativePath: string): Promise<BackgroundFileChange> {
		return gitReadFilePair(worktreePath, baseRef, relativePath);
	}

	applyThreeWay(workspaceRoot: string, patch: string): Promise<{ conflicts: readonly BackgroundConflict[] }> {
		return gitApplyThreeWay(workspaceRoot, patch);
	}

	setup(repoRoot: string, worktreePath: string, setup: ClaudeWorktreeSetup): Promise<ClaudeWorktreeSetupResult> {
		return runClaudeWorktreeSetup(repoRoot, worktreePath, setup);
	}

	commitDiff(repoRoot: string, sha: string): Promise<string> {
		return gitCommitDiff(repoRoot, sha);
	}

	rangeDiff(repoRoot: string, from: string, to: string): Promise<string> {
		return gitRangeDiff(repoRoot, from, to);
	}

	branchReviewBases(repoRoot: string): Promise<string[]> {
		return gitBranchReviewBases(repoRoot);
	}

	commitsSince(repoRoot: string, head: string): Promise<string> {
		return gitCommitsSince(repoRoot, head);
	}

	recentReverts(repoRoot: string): Promise<string> {
		return gitRecentReverts(repoRoot);
	}

	changedFileCountSince(repoRoot: string, sinceMs: number): Promise<number> {
		return gitChangedFileCountSince(repoRoot, sinceMs);
	}

	branchReviewDiff(repoRoot: string, scope: ClaudeBranchReviewScope, base: string | undefined): Promise<string> {
		return gitBranchReviewDiff(repoRoot, scope, base);
	}

	readAttributionNote(repoRoot: string, sha: string): Promise<string | undefined> {
		return gitReadAttributionNote(repoRoot, sha);
	}

	writeAttributionNote(repoRoot: string, sha: string, text: string): Promise<void> {
		return gitWriteAttributionNote(repoRoot, sha, text);
	}

	commitFiles(repoRoot: string, sha: string): Promise<string[]> {
		return gitCommitFiles(repoRoot, sha);
	}

	showCommitFile(repoRoot: string, sha: string, relativePath: string): Promise<string | undefined> {
		return gitShowCommitFile(repoRoot, sha, relativePath);
	}

	commitFileId(repoRoot: string, sha: string, relativePath: string): Promise<string | undefined> {
		return gitCommitFileId(repoRoot, sha, relativePath);
	}

	lastCommitTouching(repoRoot: string, relativePath: string): Promise<string | undefined> {
		return gitLastCommitTouching(repoRoot, relativePath);
	}

	notedOriginal(repoRoot: string, sha: string): Promise<string | undefined> {
		return gitNotedOriginal(repoRoot, sha);
	}

	splitDiff(repoRoot: string): Promise<string> {
		return gitSplitDiff(repoRoot);
	}

	createSplitBranches(repoRoot: string, parts: readonly SplitBranchPart[], stacked?: boolean): Promise<SplitBranchResult[]> {
		return gitCreateSplitBranches(repoRoot, parts, stacked);
	}

	wipCommit(worktreePath: string, message: string): Promise<boolean> {
		return gitWipCommit(worktreePath, message);
	}

	diskUsage(worktreePath: string): Promise<number | undefined> {
		return directorySize(worktreePath);
	}
}
