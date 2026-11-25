/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { dirname, join, relative, resolve, sep } from '../../../base/common/path.js';
import { CLAUDE_WORKTREE_SETUP_TIMEOUT_MS, ClaudeWorktreeSetup, ClaudeWorktreeSetupResult, matchesClaudeCopySegment } from '../common/claudeWorktreeSetup.js';

const OUTPUT_LIMIT = 64 * 1024;

/**
 * Copies the setup file's files into the worktree, then runs its commands there
 * in order (issue 511). Only regular files inside the repository are copied, and
 * one that already exists in the worktree is left as it is. Never rejects.
 */
export async function runClaudeWorktreeSetup(repoRoot: string, worktreePath: string, setup: ClaudeWorktreeSetup, timeoutMs = CLAUDE_WORKTREE_SETUP_TIMEOUT_MS): Promise<ClaudeWorktreeSetupResult> {
	const copied: string[] = [];
	for (const pattern of setup.copy) {
		for (const file of await expand(repoRoot, pattern)) {
			const target = join(worktreePath, file);
			if (await fs.lstat(target).then(() => true, () => false)) {
				continue;
			}
			try {
				await fs.mkdir(dirname(target), { recursive: true });
				await fs.copyFile(join(repoRoot, file), target);
				copied.push(file.split(sep).join('/'));
			} catch {
				// A file that cannot be copied is left out; the commands may still work.
			}
		}
	}
	const commands: { command: string; exitCode: number | undefined; output: string }[] = [];
	for (const command of setup.commands) {
		const run = await runCommand(command, worktreePath, timeoutMs);
		commands.push({ command, ...run });
		if (run.exitCode !== 0) {
			return { copied, commands, failed: command };
		}
	}
	return { copied, commands };
}

/** The regular files under `root` a pattern names, one wildcard segment at a time, never outside `root`. */
async function expand(root: string, pattern: string): Promise<string[]> {
	let paths = [''];
	for (const segment of pattern.split('/').filter(part => part && part !== '.')) {
		const next: string[] = [];
		for (const base of paths) {
			if (!/[*?]/.test(segment)) {
				next.push(join(base, segment));
				continue;
			}
			for (const name of await fs.readdir(join(root, base)).catch((): string[] => [])) {
				if (matchesClaudeCopySegment(name, segment)) {
					next.push(join(base, name));
				}
			}
		}
		paths = next;
	}
	const files: string[] = [];
	for (const path of paths) {
		const full = resolve(root, path);
		const rel = relative(resolve(root), full);
		if (!rel || rel.startsWith('..')) {
			continue;
		}
		const stat = await fs.lstat(full).catch(() => undefined);
		if (stat?.isFile()) {
			files.push(rel);
		}
	}
	return files;
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ readonly exitCode: number | undefined; readonly output: string }> {
	return new Promise(resolvePromise => {
		let output = '';
		let settled = false;
		const finish = (exitCode: number | undefined, note?: string) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolvePromise({ exitCode, output: note ? `${output}${output.endsWith('\n') || !output ? '' : '\n'}${note}` : output });
			}
		};
		const child = spawn(command, { cwd, shell: process.platform === 'win32' ? true : process.env.SHELL || '/bin/sh', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		const take = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-OUTPUT_LIMIT); };
		child.stdout.on('data', take);
		child.stderr.on('data', take);
		const timer = setTimeout(() => {
			child.kill();
			finish(undefined, `Stopped after ${Math.round(timeoutMs / 1000)} seconds.`);
		}, timeoutMs);
		child.on('error', error => finish(undefined, error.message));
		child.on('close', code => finish(code ?? undefined));
	});
}
