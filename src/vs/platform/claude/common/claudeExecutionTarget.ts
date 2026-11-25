/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';

/** Where a session's Claude Code process runs (issue 425). */
export type ClaudeExecutionTargetKind = 'local' | 'worktree' | 'devcontainer' | 'ssh';

/**
 * The target the user picked in "Run in". `local` and `worktree` run Claude Code
 * on this machine as before; `devcontainer` runs it inside the workspace's dev
 * container; `ssh` runs it on a host from the user's own SSH config.
 */
export type ClaudeExecutionTarget =
	| { readonly kind: 'local' }
	| { readonly kind: 'worktree' }
	| { readonly kind: 'devcontainer' }
	| {
		readonly kind: 'ssh';
		/** A host alias or `user@host` the user's SSH config resolves. */
		readonly host: string;
		/** The project folder on the host: absolute, or under `~`. Absent starts in the home folder. */
		readonly remotePath?: string;
	};

/** What `session.started` says about the target, for the Agents column and the session header. */
export interface ClaudeExecutionTargetInfo {
	readonly kind: ClaudeExecutionTargetKind;
	readonly label: string;
	/** Set once, when a resumed session's host or container was gone and the turn ran on this machine instead. */
	readonly notice?: string;
}

/**
 * The official Claude Code installer, run on a target in a visible terminal
 * after the user agrees. `session.failed` carries it when the target's
 * `claude --version` probe found no Claude Code.
 */
export interface ClaudeTargetInstall {
	/** The dev container or the SSH host, as the offer names it. */
	readonly where: string;
	readonly executable: string;
	readonly args: readonly string[];
	/** Variables the terminal adds to the user's own environment. */
	readonly env?: Readonly<Record<string, string>>;
	/** The installer line the user is shown before it runs. */
	readonly display: string;
}

export const LOCAL_CLAUDE_EXECUTION_TARGET: ClaudeExecutionTarget = { kind: 'local' };

/** True when Claude Code runs somewhere other than this machine's own process. */
export function isRemoteClaudeExecutionTarget(target: ClaudeExecutionTarget | undefined): boolean {
	return target?.kind === 'devcontainer' || target?.kind === 'ssh';
}

/** The target's name as the picker and the session header show it. */
export function claudeExecutionTargetInfo(target: ClaudeExecutionTarget): ClaudeExecutionTargetInfo {
	switch (target.kind) {
		case 'local':
			return { kind: 'local', label: localize('claudeTargetLocal', "Local") };
		case 'worktree':
			return { kind: 'worktree', label: localize('claudeTargetWorktree', "New Worktree") };
		case 'devcontainer':
			return { kind: 'devcontainer', label: localize('claudeTargetDevContainer', "Dev Container") };
		case 'ssh':
			return { kind: 'ssh', label: target.host };
	}
}

/**
 * The words the Agents column adds to a row's status line ("in dev container",
 * "on build-box"). Undefined for a local session, which says nothing.
 */
export function claudeExecutionTargetPhrase(info: ClaudeExecutionTargetInfo | undefined): string | undefined {
	switch (info?.kind) {
		case 'devcontainer':
			return localize('claudeTargetPhraseDevContainer', "in dev container");
		case 'ssh':
			return localize('claudeTargetPhraseSsh', "on {0}", info.label);
		case 'worktree':
			return localize('claudeTargetPhraseWorktree', "in worktree");
		default:
			return undefined;
	}
}

/**
 * An SSH destination Klawly passes to `ssh` as is. It may not start with `-`
 * (it would read as an option) or hold whitespace or shell characters.
 */
export function isClaudeSshHost(value: string): boolean {
	return /^[A-Za-z0-9_][A-Za-z0-9_.@:%\[\]-]*$/.test(value) && value.length <= 255;
}

/** A project folder on an SSH host: absolute or under `~`, one line, no NUL. */
export function isClaudeRemotePath(value: string): boolean {
	return (value.startsWith('/') || value === '~' || value.startsWith('~/')) && !/[\0\r\n]/.test(value) && value.length <= 4096;
}

/** Reads a target from IPC or storage. Anything malformed is undefined, so the session runs locally. */
export function readClaudeExecutionTarget(value: unknown): ClaudeExecutionTarget | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	switch (record.kind) {
		case 'local':
		case 'worktree':
		case 'devcontainer':
			return { kind: record.kind };
		case 'ssh': {
			if (typeof record.host !== 'string' || !isClaudeSshHost(record.host)) {
				return undefined;
			}
			if (record.remotePath === undefined || record.remotePath === '') {
				return { kind: 'ssh', host: record.host };
			}
			return typeof record.remotePath === 'string' && isClaudeRemotePath(record.remotePath) ? { kind: 'ssh', host: record.host, remotePath: record.remotePath } : undefined;
		}
		default:
			return undefined;
	}
}
