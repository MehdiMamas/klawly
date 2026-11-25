/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Worktree setup and cleanup (issue 511). A trusted project's
 * `.klawly/worktree-setup.json` lists files to copy from the main checkout into a
 * background agent's new worktree (`.env*`, which git leaves out) and commands to
 * run there before the agent's first turn (`npm ci`). A cap keeps the number of
 * worktrees in check, and Clean Up Worktrees removes the ones with nothing left.
 */
export const CLAUDE_WORKTREE_SETUP_FILE = '.klawly/worktree-setup.json';

/** At most this many background agent worktrees per repository. */
export const CLAUDE_WORKTREES_MAX_SETTING = 'claude.worktrees.max';
export const CLAUDE_WORKTREES_MAX_DEFAULT = 20;

/** How long one setup command may run. */
export const CLAUDE_WORKTREE_SETUP_TIMEOUT_MS = 10 * 60 * 1000;

export interface ClaudeWorktreeSetup {
	/** Paths relative to the repository; `*` and `?` match within one path segment. */
	readonly copy: readonly string[];
	/** Shell commands run in order in the new worktree; the first failure stops the rest. */
	readonly commands: readonly string[];
}

export interface ClaudeWorktreeSetupResult {
	/** Files copied, relative to the repository. */
	readonly copied: readonly string[];
	readonly commands: readonly { readonly command: string; readonly exitCode: number | undefined; readonly output: string }[];
	/** The command that failed, when one did. */
	readonly failed?: string;
}

/** A missing or bad value uses the default; the cap is at least 1. */
export function readClaudeWorktreesMax(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : CLAUDE_WORKTREES_MAX_DEFAULT;
}

/**
 * Reads the setup file. `setup` is a list of commands, or one list per OS
 * (`darwin`, `linux`, `win32`) with `default` for the rest. A copy path that is
 * absolute or climbs out of the repository is dropped. Undefined when the file
 * asks for nothing or is not JSON.
 */
export function readClaudeWorktreeSetup(text: string, platform: string): ClaudeWorktreeSetup | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return undefined;
	}
	const record = parsed as { copy?: unknown; setup?: unknown };
	const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()) : [];
	const copy = strings(record.copy).map(path => path.replace(/\\/g, '/')).filter(path => !path.startsWith('/') && !/^[a-zA-Z]:/.test(path) && !path.split('/').includes('..'));
	const setup = record.setup;
	const commands = Array.isArray(setup)
		? strings(setup)
		: typeof setup === 'object' && setup !== null
			? strings((setup as Record<string, unknown>)[platform] ?? (setup as Record<string, unknown>).default)
			: [];
	return copy.length || commands.length ? { copy, commands } : undefined;
}

/** True when `name` matches one path segment of a copy pattern, where `*` is any run and `?` one character. */
export function matchesClaudeCopySegment(name: string, pattern: string): boolean {
	const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
	return new RegExp(`^${source}$`).test(name);
}
