/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { VSBuffer } from '../../../base/common/buffer.js';
import { isClaudeSshHost } from '../common/claudeExecutionTarget.js';
import { ClaudeRemoteFileStat, IClaudeRemoteFilesService, isClaudeRemoteFilePath } from '../common/claudeRemoteFiles.js';
import { ClaudeTargetHost, claudeShellQuote, claudeSshCommand, defaultClaudeTargetHost } from './claudeExecutionTarget.js';

/** One `ssh` run of the remote helper. `stdin` is the new content of a write. */
export interface ClaudeRemoteCommand {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly stdin?: Uint8Array;
}

export interface ClaudeRemoteResult {
	readonly code: number | null;
	readonly stdout: Uint8Array;
	readonly stderr: string;
}

/** Runs one helper command to completion. Injected so tests never start `ssh`. */
export type ClaudeRemoteRunner = (command: ClaudeRemoteCommand, timeoutMs: number) => Promise<ClaudeRemoteResult>;

const REMOTE_FILE_TIMEOUT_MS = 30_000;

/** The exit code the helper uses for "nothing at that path", so it never reads as a failure. */
const MISSING_EXIT_CODE = 3;

/** `ssh`'s own exit code when it could not connect or authenticate. */
const SSH_FAILED_EXIT_CODE = 255;

/**
 * The remote shell line for each helper operation. `stat` tries GNU `stat`
 * first and BSD `stat` (macOS) second; both print `type|size|mtime`.
 */
export function claudeRemoteFileScript(operation: 'stat' | 'read' | 'write' | 'delete', path: string): string {
	const file = claudeShellQuote(path);
	const exists = `[ -e ${file} ] || exit ${MISSING_EXIT_CODE}`;
	switch (operation) {
		case 'stat':
			return `${exists}; stat -c '%F|%s|%Y' -- ${file} 2>/dev/null || stat -f '%HT|%z|%m' -- ${file}`;
		case 'read':
			return `${exists}; cat -- ${file}`;
		case 'write':
			// `cat >` keeps the file's mode and owner, unlike a rename over it.
			return `mkdir -p -- "$(dirname -- ${file})" && cat > ${file}`;
		case 'delete':
			return `rm -f -- ${file}`;
	}
}

/** The `ssh` command for one helper operation on a host. */
export function buildClaudeRemoteFileCommand(host: ClaudeTargetHost, sshHost: string, operation: 'stat' | 'read' | 'write' | 'delete', path: string, stdin?: Uint8Array): ClaudeRemoteCommand {
	if (!isClaudeSshHost(sshHost) || !isClaudeRemoteFilePath(path)) {
		throw new Error(`Not a remote file Klawly can reach: ${sshHost}:${path}`);
	}
	const command = claudeSshCommand(sshHost, claudeRemoteFileScript(operation, path), host.env);
	return { ...command, stdin };
}

/** `type|size|mtime` from GNU or BSD `stat`. Undefined for anything else. */
export function parseClaudeRemoteStat(stdout: string): ClaudeRemoteFileStat | undefined {
	const match = /^(?<type>[^|]+)\|(?<size>\d+)\|(?<mtime>\d+)\s*$/.exec(stdout.trim());
	if (!match?.groups) {
		return undefined;
	}
	return {
		type: /directory/i.test(match.groups.type) ? 'directory' : 'file',
		size: Number(match.groups.size),
		mtime: Number(match.groups.mtime) * 1000,
	};
}

function failure(host: string, path: string, result: ClaudeRemoteResult): Error {
	const detail = result.stderr.trim().split(/\r?\n/).at(-1)?.trim() || `exit code ${result.code}`;
	return new Error(result.code === SSH_FAILED_EXIT_CODE ? `Klawly could not connect to ${host} over SSH: ${detail}` : `${host}:${path}: ${detail}`);
}

/**
 * The remote helper (issue 425): single-file `stat`, read, write and delete on
 * an SSH host, each one `ssh` run with the user's own config and keys and no
 * Claude credential in its environment. Change capture uses it before and after
 * an approved write; Review uses it through the `claude-remote:` provider.
 */
export class ClaudeRemoteFiles implements IClaudeRemoteFilesService {
	declare readonly _serviceBrand: undefined;

	constructor(
		private readonly _host: ClaudeTargetHost = defaultClaudeTargetHost(),
		private readonly _run: ClaudeRemoteRunner = runClaudeRemoteCommand,
	) { }

	async stat(host: string, path: string): Promise<ClaudeRemoteFileStat | undefined> {
		const result = await this._run(buildClaudeRemoteFileCommand(this._host, host, 'stat', path), REMOTE_FILE_TIMEOUT_MS);
		if (result.code === MISSING_EXIT_CODE) {
			return undefined;
		}
		const stat = result.code === 0 ? parseClaudeRemoteStat(VSBuffer.wrap(result.stdout).toString()) : undefined;
		if (!stat) {
			throw failure(host, path, result);
		}
		return stat;
	}

	async readFile(host: string, path: string): Promise<VSBuffer | undefined> {
		const result = await this._run(buildClaudeRemoteFileCommand(this._host, host, 'read', path), REMOTE_FILE_TIMEOUT_MS);
		if (result.code === MISSING_EXIT_CODE) {
			return undefined;
		}
		if (result.code !== 0) {
			throw failure(host, path, result);
		}
		return VSBuffer.wrap(result.stdout);
	}

	async writeFile(host: string, path: string, content: VSBuffer): Promise<void> {
		const result = await this._run(buildClaudeRemoteFileCommand(this._host, host, 'write', path, content.buffer), REMOTE_FILE_TIMEOUT_MS);
		if (result.code !== 0) {
			throw failure(host, path, result);
		}
	}

	async delete(host: string, path: string): Promise<void> {
		const result = await this._run(buildClaudeRemoteFileCommand(this._host, host, 'delete', path), REMOTE_FILE_TIMEOUT_MS);
		if (result.code !== 0) {
			throw failure(host, path, result);
		}
	}
}

/** Runs one helper command with binary stdout, writing `stdin` first, and kills it after `timeoutMs`. */
export function runClaudeRemoteCommand(command: ClaudeRemoteCommand, timeoutMs: number): Promise<ClaudeRemoteResult> {
	return new Promise(resolve => {
		const child = spawn(command.command, [...command.args], { env: { ...command.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: timeoutMs });
		const stdout: Buffer[] = [];
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk); });
		child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk); });
		// A helper that exits before reading all of stdin must not crash the process with EPIPE.
		child.stdin.on('error', () => undefined);
		child.on('error', error => resolve({ code: 127, stdout: new Uint8Array(), stderr: `${stderr}${error.message}` }));
		child.on('close', code => resolve({ code, stdout: Buffer.concat(stdout), stderr }));
		child.stdin.end(command.stdin ? Buffer.from(command.stdin) : undefined);
	});
}
