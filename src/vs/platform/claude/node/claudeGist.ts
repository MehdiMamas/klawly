/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { claudeGistArgs, claudeGistReadArgs, ClaudeGistReadResult, ClaudeGistRequest, ClaudeGistResult, parseClaudeGistId, readClaudeGistUrl } from '../common/claudeShare.js';

const GH_TIMEOUT_MS = 60_000;

/** Runs `gh` with `args` and `input` on stdin. Injected so tests never start `gh`. */
export type ClaudeGistRunner = (args: readonly string[], input: string) => Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly missing?: boolean }>;

/**
 * Publishes a shared chat as a secret gist with the user's own GitHub CLI and
 * sign-in (issue 490). No shell; the Markdown goes on stdin. Never rejects.
 */
export async function createClaudeGist(request: ClaudeGistRequest, run: ClaudeGistRunner = runGh): Promise<ClaudeGistResult> {
	const result = await run(claudeGistArgs(request), request.content);
	if (result.missing) {
		return { kind: 'failed', problem: 'ghMissing', message: 'The GitHub CLI (gh) is not installed.' };
	}
	const url = result.code === 0 ? readClaudeGistUrl(result.stdout) : undefined;
	if (url) {
		return { kind: 'created', url };
	}
	const message = result.stderr.trim().split(/\r?\n/).at(-1)?.trim() || `gh exited with ${result.code}`;
	return { kind: 'failed', problem: /gh auth login|not logged in|authentication|HTTP 401|scope/i.test(result.stderr) ? 'signedOut' : 'failed', message };
}

/** Reads a shared chat's Markdown from a gist link with the user's GitHub CLI (issue 684). Never rejects. */
export async function readClaudeGist(link: string, run: ClaudeGistRunner = runGh): Promise<ClaudeGistReadResult> {
	const id = parseClaudeGistId(link);
	if (!id) {
		return { kind: 'failed', problem: 'failed', message: 'That is not a gist link.' };
	}
	const result = await run(claudeGistReadArgs(id), '');
	if (result.missing) {
		return { kind: 'failed', problem: 'ghMissing', message: 'The GitHub CLI (gh) is not installed.' };
	}
	if (result.code === 0 && result.stdout.trim()) {
		return { kind: 'read', content: result.stdout };
	}
	const message = result.stderr.trim().split(/\r?\n/).at(-1)?.trim() || `gh exited with ${result.code}`;
	return { kind: 'failed', problem: /gh auth login|not logged in|authentication|HTTP 401|scope/i.test(result.stderr) ? 'signedOut' : 'failed', message };
}

function runGh(args: readonly string[], input: string): ReturnType<ClaudeGistRunner> {
	return new Promise(resolve => {
		let stdout = '';
		let stderr = '';
		let settled = false;
		const finish = (result: Awaited<ReturnType<ClaudeGistRunner>>) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(result);
			}
		};
		const child = spawn('gh', [...args], { env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_PAGER: '' }, stdio: 'pipe', windowsHide: true });
		const timer = setTimeout(() => {
			child.kill();
			finish({ code: null, stdout, stderr: 'The GitHub CLI took too long.' });
		}, GH_TIMEOUT_MS);
		child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
		child.on('error', error => finish({ code: null, stdout, stderr: error.message, missing: (error as NodeJS.ErrnoException).code === 'ENOENT' }));
		child.on('close', code => finish({ code, stdout, stderr }));
		child.stdin.on('error', () => { });
		child.stdin.end(input);
	});
}
