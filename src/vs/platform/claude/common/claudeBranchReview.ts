/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The most diff text a branch review sends; the rest is cut with a note (issue 932). */
export const CLAUDE_BRANCH_REVIEW_MAX_DIFF = 200_000;

/** What the branch review compares: everything since the base, or only what is staged. */
export type ClaudeBranchReviewScope = 'branch' | 'staged';

/** The refs a repository has, as far as picking a base needs them. */
export interface ClaudeBranchReviewRefs {
	/** What `origin/HEAD` points at, such as `origin/main`, when the remote tells. */
	readonly originHead?: string;
	/** Local and remote branch names, such as `main` and `origin/main`. */
	readonly branches: readonly string[];
	/** The branch checked out now, never offered as its own base. */
	readonly current?: string;
}

const FALLBACK_BASES: readonly string[] = ['origin/main', 'origin/master', 'main', 'master'];

/**
 * The branches to offer as a base, the repository's default branch first
 * (`origin/HEAD`, else main or master), then the other branches by name.
 */
export function claudeBranchReviewBases(refs: ClaudeBranchReviewRefs): string[] {
	const known = new Set(refs.branches.filter(name => name !== refs.current && !name.endsWith('/HEAD') && name !== 'HEAD'));
	const first: string[] = [];
	if (refs.originHead && known.has(refs.originHead)) {
		first.push(refs.originHead);
	}
	for (const name of FALLBACK_BASES) {
		if (known.has(name) && !first.includes(name)) {
			first.push(name);
		}
	}
	return [...first, ...[...known].filter(name => !first.includes(name)).sort()];
}

/** The base to use when the user picked none, or undefined when the repository has no candidate. */
export function chooseClaudeBranchReviewBase(refs: ClaudeBranchReviewRefs): string | undefined {
	return claudeBranchReviewBases(refs)[0];
}

/** Git arguments for the diff: `base...HEAD` is the work since the branches split; staged-only ignores the base. */
export function claudeBranchReviewDiffArguments(scope: ClaudeBranchReviewScope, base: string | undefined): string[] | undefined {
	const common = ['diff', '--no-color', '--patch', '-M'];
	if (scope === 'staged') {
		return [...common, '--cached'];
	}
	if (!base || base.startsWith('-')) {
		return undefined;
	}
	return [...common, `${base}...HEAD`, '--'];
}

/** The diff a branch review sends, cut to the limit; `truncated` drives the notice. */
export function claudeBranchReviewDiff(diff: string): { readonly diff: string; readonly truncated: boolean } {
	if (diff.length <= CLAUDE_BRANCH_REVIEW_MAX_DIFF) {
		return { diff, truncated: false };
	}
	return { diff: `${diff.slice(0, CLAUDE_BRANCH_REVIEW_MAX_DIFF)}\n[The diff is cut here; read the rest with git diff.]`, truncated: true };
}

/** The short word the status bar and Problems show in place of a commit id (they keep seven characters). */
export function claudeBranchReviewKey(scope: ClaudeBranchReviewScope): string {
	return scope === 'staged' ? 'staged' : 'branch';
}
