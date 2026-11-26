/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { IClaudeGitStatus } from '../common/claudeRuntime.js';

/** Runs Git. `input` goes to its standard input; `stdout` is the output alone, `output` adds the error text for messages. */
export function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<{ ok: boolean; stdout: string; output: string }> {
	return new Promise(resolve => {
		const child = execFile('git', args, { cwd, env, timeout: 30000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ ok: !error, stdout, output: `${stdout}${stderr}${error?.message ?? ''}` }));
		if (input !== undefined) {
			child.stdin?.end(input);
		}
	});
}

const git = runGit;

/** Tells a normal repo from a folder without Git and from one Git refuses because another user owns it. */
export async function checkGitFolder(cwd: string, env: NodeJS.ProcessEnv): Promise<IClaudeGitStatus> {
	const { ok, output } = await git(cwd, ['rev-parse', '--is-inside-work-tree'], env);
	if (ok) {
		return { state: 'ok' };
	}
	if (/dubious ownership|safe\.directory/i.test(output)) {
		return { state: 'unsafe' };
	}
	return { state: /not a git repository/i.test(output) ? 'notRepo' : 'unknown' };
}

export async function initGitFolder(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
	const { ok, output } = await git(cwd, ['init'], env);
	if (!ok) {
		throw new Error(output.trim());
	}
}

export async function trustGitFolder(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
	const { ok, output } = await git(cwd, ['config', '--global', '--add', 'safe.directory', cwd], env);
	if (!ok) {
		throw new Error(output.trim());
	}
}
