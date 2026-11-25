/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { hasKey } from '../../../base/common/types.js';
import { CLAUDE_REVIEW_CLI_USAGE, ClaudeReviewCliArgs, ClaudeReviewCliExit, claudeOpenFindings, claudeReviewCliExitCode, formatClaudeReviewCliOutput, parseClaudeReviewCliArgs } from '../common/claudeReviewCli.js';
import { planClaudeReviewRun } from '../common/claudeReviewDepth.js';
import { ClaudeReviewFinding } from '../common/claudeReviewLoop.js';
import { ClaudePersistedReview } from '../common/claudeReviewPersist.js';
import { ClaudeQueryFactory } from './claudeQuery.js';
import { runClaudeReviewQuery } from './claudeReviewQuery.js';

/** What the runner needs from its surroundings; the terminal entry point passes the real ones. */
export interface ClaudeReviewCliHost {
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly stdoutIsTerminal: boolean;
	readonly queryFactory: ClaudeQueryFactory;
	/** The review the app last stored for this checkout, for `klawly review status`. */
	readonly readStored: () => Promise<ClaudePersistedReview | undefined>;
	/** Stores a finished review so `status` and the review tools see it. Failures to store never fail the run. */
	readonly persist?: (findings: readonly ClaudeReviewFinding[], diff: string) => Promise<unknown>;
	readonly write: (text: string) => void;
	readonly writeError: (text: string) => void;
}

/** `git diff <base>...HEAD` plus uncommitted changes, so a review sees what a pull request would. */
export function readClaudeReviewCliDiff(cwd: string, base: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', ['diff', '--no-color', `${base}...HEAD`], { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
	});
}

/** Runs `klawly review` and returns the process exit code. Never throws. */
export async function runClaudeReviewCli(argv: readonly string[], host: ClaudeReviewCliHost, readDiff: (cwd: string, base: string) => Promise<string> = readClaudeReviewCliDiff): Promise<ClaudeReviewCliExit> {
	const parsed = parseClaudeReviewCliArgs(argv, host.stdoutIsTerminal);
	if (hasKey(parsed, { error: true })) {
		host.writeError(`${parsed.error}\n${CLAUDE_REVIEW_CLI_USAGE}`);
		return ClaudeReviewCliExit.Usage;
	}
	const args: ClaudeReviewCliArgs = parsed;
	try {
		if (args.command === 'status') {
			const stored = await host.readStored();
			const findings = claudeOpenFindings(stored).map(entry => entry.finding);
			host.write(formatClaudeReviewCliOutput(findings, args.format, stored?.reviewedSha));
			return claudeReviewCliExitCode(findings, args.failOn);
		}
		const diff = await readDiff(host.cwd, args.base);
		if (!diff.trim()) {
			host.write(formatClaudeReviewCliOutput([], args.format));
			return ClaudeReviewCliExit.Clean;
		}
		const plan = planClaudeReviewRun(diff, () => undefined, { forced: args.depth });
		const abort = new AbortController();
		const result = await runClaudeReviewQuery({ queryFactory: host.queryFactory, diff, cwd: host.cwd, model: plan.model, depth: plan.depth, maxTurns: plan.maxTurns, abort, env: host.env });
		if (!result.ok) {
			host.writeError(result.failure.kind === 'failed' ? result.failure.message : `The review did not finish (${result.failure.kind}).`);
			return ClaudeReviewCliExit.Failed;
		}
		const findings: readonly ClaudeReviewFinding[] = result.value;
		await host.persist?.(findings, diff).catch(() => undefined);
		host.write(formatClaudeReviewCliOutput(findings, args.format));
		return claudeReviewCliExitCode(findings, args.failOn);
	} catch (error) {
		host.writeError(error instanceof Error ? error.message : String(error));
		return ClaudeReviewCliExit.Failed;
	}
}
