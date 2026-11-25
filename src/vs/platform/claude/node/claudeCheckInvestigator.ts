/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { ClaudeTendSnapshotResult, ClaudeCheckLogResult, ClaudeFailingCheck, ClaudeFailingChecksResult, ClaudeGhProblem, ClaudePullRequestTarget, failingChecksFromGh, IClaudeCheckInvestigator, isReadOnlyGhCall, prChecksArguments, runLogArguments, trimCheckLog } from '../common/claudeCheckInvestigation.js';
import { isReviewCommentsCall, prViewArguments, readCheckBuckets, readPrView, readReviewComments, reviewCommentsArguments } from '../common/claudeTendPullRequest.js';

/** What one `gh` call printed. */
export interface GhResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** Runs `gh <args>`; rejects with an `ENOENT` error code when `gh` is not installed. */
export type GhRunner = (args: readonly string[]) => Promise<GhResult>;

const GH_TIMEOUT_MS = 60_000;
/** A failed log is cut down anyway; this only bounds what is read. */
const GH_MAX_OUTPUT = 32 * 1024 * 1024;

function runGh(args: readonly string[]): Promise<GhResult> {
	return new Promise((resolve, reject) => {
		const child = spawn('gh', args.slice(), {
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe'],
			// No pager and no prompts: the output is read, never shown in a terminal.
			env: { ...process.env, GH_PAGER: '', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let size = 0;
		let settled = false;
		const finish = (error?: Error, result?: GhResult) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			if (error) {
				reject(error);
			} else if (result) {
				resolve(result);
			}
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(new Error('The GitHub CLI took too long.'));
		}, GH_TIMEOUT_MS);
		child.stdout?.on('data', chunk => {
			size += chunk.length;
			if (size > GH_MAX_OUTPUT) {
				child.kill();
				finish(new Error('The GitHub CLI printed too much.'));
				return;
			}
			stdout.push(Buffer.from(chunk));
		});
		child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
		child.on('error', finish);
		child.on('close', code => finish(undefined, {
			code,
			stdout: Buffer.concat(stdout).toString('utf8'),
			stderr: Buffer.concat(stderr).toString('utf8'),
		}));
	});
}

/** Sorts a failed `gh` call into what the workbench tells the user. */
function problemOf(error: unknown, stderr = ''): { readonly ok: false; readonly problem: ClaudeGhProblem; readonly message: string } {
	if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
		return { ok: false, problem: 'ghMissing', message: 'The GitHub CLI (gh) is not installed.' };
	}
	const message = (stderr || (error instanceof Error ? error.message : '')).trim().split('\n')[0] ?? '';
	// `gh` asks for `gh auth login` when signed out, and GitHub answers 404 for a repository the account can't see.
	if (/gh auth login|authentication|not logged in|HTTP 40[134]|Could not resolve to a/i.test(stderr)) {
		return { ok: false, problem: 'signedOut', message };
	}
	return { ok: false, problem: 'failed', message };
}

/**
 * Reads failed checks and their logs through the user's own GitHub CLI and
 * sign-in (issue 505). Runs only `gh pr checks` and `gh run view`.
 */
export class ClaudeCheckInvestigator implements IClaudeCheckInvestigator {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly _gh: GhRunner = runGh) { }

	async failingChecks(target: ClaudePullRequestTarget): Promise<ClaudeFailingChecksResult> {
		let result: GhResult;
		try {
			result = await this.gh(prChecksArguments(target));
		} catch (error) {
			return problemOf(error);
		}
		// `gh pr checks` exits non-zero when a check failed (1) or is pending (8), and still prints the JSON.
		const checks = failingChecksFromGh(result.stdout);
		if (checks) {
			return { ok: true, checks };
		}
		// A pull request without checks prints no JSON at all.
		if (/no checks reported/i.test(result.stderr)) {
			return { ok: true, checks: [] };
		}
		return problemOf(undefined, result.stderr);
	}

	async failedLog(repository: { readonly owner: string; readonly repo: string }, check: ClaudeFailingCheck): Promise<ClaudeCheckLogResult> {
		if (!check.runId) {
			return { ok: false, problem: 'notActions', message: check.url };
		}
		let result: GhResult;
		try {
			result = await this.gh(runLogArguments(repository, check.runId, check.jobId));
		} catch (error) {
			return problemOf(error);
		}
		if (result.code !== 0) {
			return problemOf(undefined, result.stderr);
		}
		const log = trimCheckLog(result.stdout);
		return log.text.trim() ? { ok: true, log } : { ok: false, problem: 'noLog', message: result.stderr.trim() };
	}

	async tendSnapshot(target: ClaudePullRequestTarget): Promise<ClaudeTendSnapshotResult> {
		try {
			const view = await this.gh(prViewArguments(target));
			const pull = view.code === 0 ? readPrView(view.stdout) : undefined;
			if (!pull) {
				return problemOf(undefined, view.stderr);
			}
			// Like failingChecks: a failed or pending check exits non-zero and still prints the JSON.
			const checksResult = await this.gh(prChecksArguments(target));
			const checks = readCheckBuckets(checksResult.stdout) ?? (/no checks reported/i.test(checksResult.stderr) ? { failing: [], pending: 0, passing: 0 } : undefined);
			if (!checks) {
				return problemOf(undefined, checksResult.stderr);
			}
			const commentsResult = await this.gh(reviewCommentsArguments(target));
			const comments = commentsResult.code === 0 ? readReviewComments(commentsResult.stdout) : undefined;
			if (!comments) {
				return problemOf(undefined, commentsResult.stderr);
			}
			return { ok: true, snapshot: { ...pull, ...checks, comments } };
		} catch (error) {
			return problemOf(error);
		}
	}

	private gh(args: string[]): Promise<GhResult> {
		if (!isReadOnlyGhCall(args) && !isReviewCommentsCall(args)) {
			return Promise.reject(new Error(`Refusing to run gh ${args[0]} ${args[1]}: the check investigator only reads.`));
		}
		return this._gh(args);
	}
}
