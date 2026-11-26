/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IClaudeWorktree, IClaudeWorktreeDiff } from './claudeRuntime.js';

/** One entry of `git worktree list --porcelain`. */
export interface IGitWorktreeEntry {
	readonly path: string;
	readonly head?: string;
	/** The branch name without `refs/heads/`. */
	readonly branch?: string;
	readonly bare: boolean;
}

/** Parses `git worktree list --porcelain`: blocks separated by a blank line, one `key value` per line. */
export function parseWorktreeList(porcelain: string): IGitWorktreeEntry[] {
	const entries: IGitWorktreeEntry[] = [];
	for (const block of porcelain.split(/\r?\n\r?\n/)) {
		let path: string | undefined;
		let head: string | undefined;
		let branch: string | undefined;
		let bare = false;
		for (const line of block.split(/\r?\n/)) {
			if (line.startsWith('worktree ')) {
				path = line.slice('worktree '.length);
			} else if (line.startsWith('HEAD ')) {
				head = line.slice('HEAD '.length);
			} else if (line.startsWith('branch ')) {
				branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
			} else if (line === 'bare') {
				bare = true;
			}
		}
		if (path) {
			entries.push({ path, head, branch, bare });
		}
	}
	return entries;
}

const WORKTREES_MARKER = /[\\/]\.claude[\\/]worktrees[\\/]/;

/** The folder name under `.claude/worktrees/`, or `undefined` for any other path (the main checkout, other tools' worktrees). */
export function claudeWorktreeName(path: string): string | undefined {
	const match = WORKTREES_MARKER.exec(path);
	const name = match ? path.slice(match.index + match[0].length).replace(/[\\/]+$/, '') : '';
	return name || undefined;
}

/** `--worktree try/fix-1` may be stored as `try+fix-1` or `try-fix-1`; compare names without the separators. */
export function sameWorktreeName(a: string, b: string): boolean {
	const normalize = (name: string) => name.replace(/[\\/+_-]+/g, '-');
	return normalize(a) === normalize(b);
}

/** `+120 -88 · 3 files` pieces from `git diff --numstat`: binary files count as files with no lines. */
export function parseNumstat(numstat: string, patch?: string): IClaudeWorktreeDiff {
	let added = 0;
	let removed = 0;
	let files = 0;
	for (const line of numstat.split(/\r?\n/)) {
		const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
		if (match) {
			files++;
			added += match[1] === '-' ? 0 : Number(match[1]);
			removed += match[2] === '-' ? 0 : Number(match[2]);
		}
	}
	const firstLine = patch?.split(/\r?\n/).find(line => line.startsWith('+') && !line.startsWith('+++') && line.slice(1).trim())?.slice(1).trim();
	return { added, removed, files, firstLine };
}

/** The reason a worktree cannot be cleaned up, or `undefined` when it can (the Clean up button of v5-S27 shows it on hover). */
export function worktreeKeepReason(worktree: Pick<IClaudeWorktree, 'dirty' | 'running'>): 'running' | 'dirty' | undefined {
	return worktree.running ? 'running' : worktree.dirty ? 'dirty' : undefined;
}

/** The automatic cleanup rule: finished, clean, and not changed for `days` days. `days` of 0 turns it off. */
export function isCleanupDue(worktree: Pick<IClaudeWorktree, 'dirty' | 'running' | 'modified'>, days: number, now: number): boolean {
	return days > 0 && !worktreeKeepReason(worktree) && now - worktree.modified >= days * 86400000;
}

/** `1.2 GB`, `340 MB`, `12 KB`. */
export function formatBytes(bytes: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit++;
	}
	return `${unit >= 3 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A branch-safe slug of the prompt for `try/<slug>-<n>`. */
export function worktreeSlug(prompt: string): string {
	return prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '') || 'task';
}
