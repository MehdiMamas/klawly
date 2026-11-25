/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { isAbsolute, join, relative, resolve } from '../../../base/common/path.js';
import { formatClaudeReviewCliOutput } from '../common/claudeReviewCli.js';
import { planClaudeReviewRun } from '../common/claudeReviewDepth.js';
import { ClaudeReviewFinding } from '../common/claudeReviewLoop.js';
import { ClaudePersistedReview, parseClaudePersistedReview, reconcileClaudeFindings, serializeClaudePersistedReview } from '../common/claudeReviewPersist.js';
import { ClaudeReviewToolHost, isClaudeReviewRelativePath } from '../common/claudeReviewTools.js';
import { ClaudeQueryFactory } from './claudeQuery.js';
import { readClaudeReviewCliDiff } from './claudeReviewCli.js';
import { runClaudeReviewQuery } from './claudeReviewQuery.js';

/** The file, in the checkout's git directory, that holds the review the CLI, the tools and an agent share. */
export const CLAUDE_REVIEW_STORE_FILE = 'klawly-review.json';

function git(cwd: string, args: readonly string[]): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile('git', [...args], { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolvePromise(stdout));
	});
}

async function gitDirectory(cwd: string): Promise<string> {
	const dir = (await git(cwd, ['rev-parse', '--git-dir'])).trim();
	return isAbsolute(dir) ? dir : resolve(cwd, dir);
}

export interface ClaudeReviewHostOptions {
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly queryFactory: ClaudeQueryFactory;
	/** Tests replace the git reads. */
	readonly readDiff?: (cwd: string, base: string) => Promise<string>;
	readonly readHead?: (cwd: string) => Promise<string>;
	readonly gitDirectory?: (cwd: string) => Promise<string>;
}

/** The review tools' view of one checkout: its stored review in the git directory, its files and a new run. */
export function createClaudeReviewToolHost(options: ClaudeReviewHostOptions): ClaudeReviewToolHost {
	const readDiff = options.readDiff ?? readClaudeReviewCliDiff;
	const readHead = options.readHead ?? (async cwd => (await git(cwd, ['rev-parse', 'HEAD'])).trim());
	const storePath = async () => join(await (options.gitDirectory ?? gitDirectory)(options.cwd), CLAUDE_REVIEW_STORE_FILE);
	const inside = (file: string): string | undefined => {
		if (!isClaudeReviewRelativePath(file)) {
			return undefined;
		}
		const full = resolve(options.cwd, file);
		const rel = relative(options.cwd, full);
		return rel && !rel.startsWith('..') && !isAbsolute(rel) ? full : undefined;
	};
	const read = async (): Promise<ClaudePersistedReview | undefined> => {
		try {
			return parseClaudePersistedReview(await fs.readFile(await storePath(), 'utf8'));
		} catch {
			return undefined;
		}
	};
	const write = async (review: ClaudePersistedReview): Promise<void> => {
		await fs.writeFile(await storePath(), serializeClaudePersistedReview(review), 'utf8');
	};
	const storeReview = async (newFindings: readonly ClaudeReviewFinding[], diff: string) => {
		const previous = await read();
		const findings = reconcileClaudeFindings(previous?.findings ?? [], diff, newFindings);
		const sha = await readHead(options.cwd);
		await write({ reviewedSha: sha, findings });
		return { open: findings.filter(item => item.status === 'open').map(item => item.finding), sha };
	};
	return {
		read,
		write,
		store: storeReview,
		readFile: async file => {
			const full = inside(file);
			try {
				return full ? await fs.readFile(full, 'utf8') : undefined;
			} catch {
				return undefined;
			}
		},
		writeFile: async (file, content) => {
			const full = inside(file);
			if (!full) {
				return false;
			}
			await fs.writeFile(full, content, 'utf8');
			return true;
		},
		run: async ({ base, depth }) => {
			const diff = await readDiff(options.cwd, base);
			if (!diff.trim()) {
				return { text: `No changes against ${base}, so there is nothing to review.` };
			}
			const plan = planClaudeReviewRun(diff, () => undefined, { forced: depth });
			const result = await runClaudeReviewQuery({ queryFactory: options.queryFactory, diff, cwd: options.cwd, model: plan.model, depth: plan.depth, maxTurns: plan.maxTurns, abort: new AbortController(), env: options.env });
			if (!result.ok) {
				return { text: result.failure.kind === 'failed' ? result.failure.message : `The review did not finish (${result.failure.kind}).`, isError: true };
			}
			const { open, sha } = await storeReview(result.value, diff);
			return { text: formatClaudeReviewCliOutput(open, 'json', sha) };
		},
	};
}
