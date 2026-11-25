/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import type { ClaudeNoModelGitHub, ClaudeNoModelGitHubResponse } from './claudeNoModelTools.js';
import { ClaudeGitHubApiResponse, IClaudeGitHubApiService, isClaudeGitHubEndpoint } from '../common/claudeAutomationGitHub.js';

export interface ClaudeGhResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** Runs `gh` with `args` to completion. Injected so tests never start `gh`. */
export type ClaudeGhRunner = (args: readonly string[], timeoutMs: number) => Promise<ClaudeGhResult>;

const GH_TIMEOUT_MS = 30_000;

/** `gh api` arguments for a GET with headers in the output (`-i`), conditional on `etag`. */
export function claudeGhApiArgs(endpoint: string, etag?: string): string[] {
	if (!isClaudeGitHubEndpoint(endpoint)) {
		throw new Error(`Not a GitHub API path Klawly polls: ${endpoint}`);
	}
	const args = ['api', '-i', '--method', 'GET'];
	if (etag && !/[\r\n]/.test(etag)) {
		args.push('-H', `If-None-Match: ${etag}`);
	}
	args.push(endpoint);
	return args;
}

/**
 * Reads what `gh api -i` printed: the status line, the headers, a blank line
 * and the body. `gh` exits with 1 for a `304` and for an error status, so the
 * status line decides, not the exit code.
 */
export function parseClaudeGhApiOutput(result: ClaudeGhResult): ClaudeGitHubApiResponse {
	const status = /^HTTP\/[\d.]+ (?<status>\d{3})/.exec(result.stdout)?.groups?.status;
	if (!status) {
		const detail = result.stderr.trim().split(/\r?\n/).at(-1)?.trim() || `gh exited with ${result.code}`;
		return { status: 0, error: detail };
	}
	const split = /\r?\n\r?\n/.exec(result.stdout);
	const head = split ? result.stdout.slice(0, split.index) : result.stdout;
	const rest = split ? result.stdout.slice(split.index + split[0].length) : '';
	const etag = /^etag:\s*(?<etag>.+?)\s*$/im.exec(head)?.groups?.etag;
	const code = Number(status);
	if (code === 304) {
		return { status: code, etag };
	}
	let body: unknown;
	try {
		body = rest.trim() ? JSON.parse(rest) : undefined;
	} catch {
		return { status: code, error: 'GitHub sent an answer that is not JSON.' };
	}
	if (code !== 200) {
		const message = body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : `HTTP ${code}`;
		return { status: code, error: message };
	}
	return { status: code, etag, body };
}

/**
 * Polls GitHub for automation triggers (issue 518) through the user's own
 * GitHub CLI and its sign-in, read-only GETs only. Runs in the shared process
 * so the workbench never starts a process.
 */
export class ClaudeGitHubApi implements IClaudeGitHubApiService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly _run: ClaudeGhRunner = runClaudeGh) { }

	async get(endpoint: string, etag?: string): Promise<ClaudeGitHubApiResponse> {
		return parseClaudeGhApiOutput(await this._run(claudeGhApiArgs(endpoint, etag), GH_TIMEOUT_MS));
	}
}

/** Runs `gh` without a shell and kills it after `timeoutMs`. A missing `gh` is a result, not a throw. */
export function runClaudeGh(args: readonly string[], timeoutMs: number): Promise<ClaudeGhResult> {
	return new Promise(resolve => {
		const child = spawn('gh', [...args], { env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: timeoutMs });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk); });
		child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); });
		// Decoded at the end, so a character split across chunks stays whole.
		child.on('error', error => resolve({ code: 127, stdout: '', stderr: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'The GitHub CLI (gh) is not installed or not on PATH.' : error.message }));
		child.on('close', code => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
	});
}

/**
 * The GitHub calls of the no-model tools (issue 844): reads, the merge, the
 * branch update and the branch delete, through the same `gh` sign-in. The
 * endpoints are built by the tools from a checked `owner/name`, not by Claude.
 */
export function claudeNoModelGitHub(run: ClaudeGhRunner = runClaudeGh): ClaudeNoModelGitHub {
	return {
		json: async (method, endpoint, fields): Promise<ClaudeNoModelGitHubResponse> => {
			const args = ['api', '-i', '--method', method];
			for (const [key, value] of Object.entries(fields ?? {})) {
				args.push('-f', `${key}=${value}`);
			}
			args.push(endpoint);
			const parsed = parseClaudeGhApiOutput(await run(args, GH_TIMEOUT_MS));
			// 201, 202 and 204 are successes the read parser reports as errors.
			if (parsed.status >= 200 && parsed.status < 300) {
				return { status: parsed.status, body: parsed.body };
			}
			return { status: parsed.status, error: parsed.error };
		},
		text: async endpoint => {
			const result = await run(['api', '--method', 'GET', endpoint], GH_TIMEOUT_MS);
			return result.code === 0 ? result.stdout : undefined;
		},
	};
}
