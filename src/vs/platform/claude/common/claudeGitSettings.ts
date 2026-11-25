/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** When false, commits Claude makes carry no attribution trailer. */
export const CLAUDE_GIT_COMMIT_ATTRIBUTION_SETTING = 'claude.git.commitAttribution';

/** When false, pull requests Claude opens carry no attribution line. */
export const CLAUDE_GIT_PR_ATTRIBUTION_SETTING = 'claude.git.prAttribution';

/** When false, Claude Code leaves its built-in commit and pull request steps out of the system prompt. */
export const CLAUDE_GIT_INSTRUCTIONS_SETTING = 'claude.git.workflowInstructions';

/** Which ref the worktrees Claude Code makes for itself branch from. */
export const CLAUDE_GIT_WORKTREE_BASE_SETTING = 'claude.git.worktreeBase';

/** The prefix of the branch each background agent works on. */
export const CLAUDE_GIT_BRANCH_PREFIX_SETTING = 'claude.git.branchPrefix';

export const CLAUDE_GIT_BRANCH_PREFIX_DEFAULT = 'agent/';

/** `fresh` branches from the remote's default branch, `head` from the current commit. */
export type ClaudeWorktreeBase = 'fresh' | 'head';

export function readClaudeWorktreeBase(value: unknown): ClaudeWorktreeBase {
	return value === 'head' ? 'head' : 'fresh';
}

/** The git settings a session opens with. Each field is Claude Code's default unless the user changed it. */
export interface ClaudeGitSettings {
	readonly commitAttribution: boolean;
	readonly prAttribution: boolean;
	readonly workflowInstructions: boolean;
	readonly worktreeBase: ClaudeWorktreeBase;
}

export const DEFAULT_CLAUDE_GIT_SETTINGS: ClaudeGitSettings = Object.freeze({
	commitAttribution: true,
	prAttribution: true,
	workflowInstructions: true,
	worktreeBase: 'fresh',
});

export function readClaudeGitSettings(getValue: (key: string) => unknown): ClaudeGitSettings {
	return {
		commitAttribution: getValue(CLAUDE_GIT_COMMIT_ATTRIBUTION_SETTING) !== false,
		prAttribution: getValue(CLAUDE_GIT_PR_ATTRIBUTION_SETTING) !== false,
		workflowInstructions: getValue(CLAUDE_GIT_INSTRUCTIONS_SETTING) !== false,
		worktreeBase: readClaudeWorktreeBase(getValue(CLAUDE_GIT_WORKTREE_BASE_SETTING)),
	};
}

/** Claude Code settings keys for git. An empty attribution string hides it. */
export interface ClaudeGitFlagSettings {
	readonly attribution?: { readonly commit?: ''; readonly pr?: '' };
	readonly includeGitInstructions?: false;
	readonly worktree?: { readonly baseRef: 'head' };
}

/**
 * The flag settings that apply `git`, or undefined when every choice is Claude
 * Code's default, so the user's own Claude settings still decide.
 */
export function claudeGitFlagSettings(git: ClaudeGitSettings | undefined): ClaudeGitFlagSettings | undefined {
	if (!git) {
		return undefined;
	}
	const attribution: { commit?: ''; pr?: '' } = {};
	if (!git.commitAttribution) {
		attribution.commit = '';
	}
	if (!git.prAttribution) {
		attribution.pr = '';
	}
	const settings: { attribution?: { commit?: ''; pr?: '' }; includeGitInstructions?: false; worktree?: { baseRef: 'head' } } = {};
	if (Object.keys(attribution).length > 0) {
		settings.attribution = attribution;
	}
	if (!git.workflowInstructions) {
		settings.includeGitInstructions = false;
	}
	if (git.worktreeBase === 'head') {
		settings.worktree = { baseRef: 'head' };
	}
	return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * A branch prefix that git accepts and that cannot read as an option. Empty or
 * anything git would refuse takes the default. A prefix that does not end in
 * `/`, `-` or `_` gets a `/`.
 */
export function readClaudeBranchPrefix(value: unknown): string {
	if (typeof value !== 'string') {
		return CLAUDE_GIT_BRANCH_PREFIX_DEFAULT;
	}
	const prefix = value.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(prefix) || /\.\.|\/\/|\/\.|\.\/|\.lock(\/|$)|\.$/.test(prefix)) {
		return CLAUDE_GIT_BRANCH_PREFIX_DEFAULT;
	}
	return /[\/_-]$/.test(prefix) ? prefix : `${prefix}/`;
}
