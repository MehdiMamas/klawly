/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_CI_WAIT_LOG_LINES, CLAUDE_CI_WAIT_POLL_MS, ClaudeCiWaitArgs, ClaudeMergeGateArgs, ClaudeVerifyArgs, claudeNoModelRepoProblem } from '../common/claudeNoModelTools.js';

/**
 * The tools that wait on CI, run the right tests and merge, with no model call
 * (issue 844). They are plain polling and plain commands in the shared process.
 * GitHub, processes, files, the clock and the way a result reaches the chat are
 * injected, so tests run them against recorded GitHub JSON.
 */

/** What one GitHub request answered. `status` 0 means the request never reached GitHub. */
export interface ClaudeNoModelGitHubResponse {
	readonly status: number;
	readonly body?: unknown;
	readonly error?: string;
}

/** The GitHub calls the tools make, with the user's own GitHub sign-in. */
export interface ClaudeNoModelGitHub {
	json(method: 'GET' | 'PUT' | 'POST' | 'DELETE', endpoint: string, fields?: Readonly<Record<string, string>>): Promise<ClaudeNoModelGitHubResponse>;
	/** A plain-text answer such as a job log. Undefined when GitHub refuses. */
	text(endpoint: string): Promise<string | undefined>;
}

export interface ClaudeNoModelProcessResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export interface ClaudeNoModelHost {
	readonly github: ClaudeNoModelGitHub;
	run(command: string, args: readonly string[], cwd: string): Promise<ClaudeNoModelProcessResult>;
	/** The file's text, or undefined when it does not exist. */
	read(path: string): Promise<string | undefined>;
	/** Saves a log and returns where it is. */
	writeLog(name: string, text: string): Promise<string>;
	sleep(ms: number, signal: AbortSignal): Promise<void>;
	now(): number;
	/** Puts a finished background result into the chat that asked, as one message. */
	notify(sessionId: string, text: string): void;
}

/** The text a tool hands back to Claude. */
export interface ClaudeNoModelToolResult {
	readonly text: string;
	readonly isError?: boolean;
}

/** The last `count` non-empty lines of a log. */
export function claudeLastLines(text: string, count: number = CLAUDE_CI_WAIT_LOG_LINES): string {
	return text.replace(/\r/g, '').split('\n').filter(line => line.trim() !== '').slice(-count).join('\n');
}

/** One check, from a check run or a commit status. */
interface Check {
	readonly name: string;
	readonly state: 'pending' | 'pass' | 'fail';
	readonly url?: string;
	/** Id of the check run, which is the job id for GitHub Actions. */
	readonly jobId?: number;
}

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
const PASSED_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

function objectOf(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function listOf(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.map(objectOf) : [];
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/** Check runs and commit statuses of one commit, as one list. Throws with the GitHub error. */
async function checksOf(github: ClaudeNoModelGitHub, repo: string, sha: string): Promise<Check[]> {
	const runs = await github.json('GET', `repos/${repo}/commits/${sha}/check-runs?per_page=100`);
	if (runs.status !== 200) {
		throw new Error(runs.error ?? `GitHub answered ${runs.status}.`);
	}
	const checks: Check[] = listOf(objectOf(runs.body).check_runs).map(run => {
		const conclusion = str(run.conclusion);
		const state = run.status !== 'completed' ? 'pending' : conclusion && FAILED_CONCLUSIONS.has(conclusion) ? 'fail' : conclusion && PASSED_CONCLUSIONS.has(conclusion) ? 'pass' : 'fail';
		return { name: str(run.name) ?? 'check', state, url: str(run.html_url), jobId: typeof run.id === 'number' ? run.id : undefined } satisfies Check;
	});
	const statuses = await github.json('GET', `repos/${repo}/commits/${sha}/status`);
	if (statuses.status === 200) {
		for (const status of listOf(objectOf(statuses.body).statuses)) {
			const state = str(status.state);
			checks.push({ name: str(status.context) ?? 'status', state: state === 'success' ? 'pass' : state === 'pending' ? 'pending' : 'fail', url: str(status.target_url) });
		}
	}
	return checks;
}

/** The text of one ci_wait message: result first, then the run, then a failure's jobs and log. */
function ciMessage(parts: { readonly repo: string; readonly target: string; readonly outcome: string; readonly url?: string; readonly note?: string; readonly failed?: readonly string[]; readonly log?: string }): string {
	const lines = [`[ci_wait] ${parts.outcome.toUpperCase()} · ${parts.repo} ${parts.target}`];
	if (parts.url) {
		lines.push(`Run: ${parts.url}`);
	}
	if (parts.note) {
		lines.push(parts.note);
	}
	if (parts.failed?.length) {
		lines.push(`Failing jobs: ${parts.failed.join(', ')}`);
	}
	if (parts.log) {
		lines.push(`Last ${CLAUDE_CI_WAIT_LOG_LINES} log lines:`, parts.log);
	}
	return lines.join('\n');
}

export class ClaudeNoModelTools {

	constructor(private readonly _host: ClaudeNoModelHost) { }

	/**
	 * Starts a background watch and returns at once. When CI ends, one message
	 * goes into the chat `sessionId`. The watch stops with `signal`.
	 */
	ciWait(sessionId: string, args: ClaudeCiWaitArgs, signal: AbortSignal): ClaudeNoModelToolResult {
		const problem = claudeNoModelRepoProblem(args.repo) ?? ((args.pr === undefined) === (args.run === undefined) ? 'Give either pr or run, not both and not neither.' : undefined);
		if (problem) {
			return { text: problem, isError: true };
		}
		const graceMinutes = args.grace_minutes !== undefined && args.grace_minutes > 0 ? args.grace_minutes : 10;
		const watch = args.pr !== undefined ? this.watchPullRequest(args.repo, args.pr, graceMinutes, signal) : this.watchRun(args.repo, args.run!, signal);
		void watch.then(message => {
			if (message !== undefined && !signal.aborted) {
				this._host.notify(sessionId, message);
			}
		}, error => {
			if (!signal.aborted) {
				this._host.notify(sessionId, ciMessage({ repo: args.repo, target: args.pr !== undefined ? `PR #${args.pr}` : `run ${args.run}`, outcome: 'error', note: `The watch stopped: ${error instanceof Error ? error.message : String(error)}` }));
			}
		});
		const target = args.pr !== undefined ? `PR #${args.pr}` : `run ${args.run}`;
		return { text: `[ci_wait] WATCHING · ${args.repo} ${target}. One message arrives in this chat when CI ends (checked every ${CLAUDE_CI_WAIT_POLL_MS / 1000} s, no model involved). Do not poll; carry on or end your turn.` };
	}

	private async watchPullRequest(repo: string, pr: number, graceMinutes: number, signal: AbortSignal): Promise<string | undefined> {
		const target = `PR #${pr}`;
		const start = this._host.now();
		while (!signal.aborted) {
			const info = await this._host.github.json('GET', `repos/${repo}/pulls/${pr}`);
			if (info.status !== 200) {
				return ciMessage({ repo, target, outcome: 'error', note: `Could not read the pull request: ${info.error ?? `GitHub answered ${info.status}`}.` });
			}
			const sha = str(objectOf(objectOf(info.body).head).sha);
			if (!sha) {
				return ciMessage({ repo, target, outcome: 'error', note: 'GitHub sent no head commit for the pull request.' });
			}
			const checks = await checksOf(this._host.github, repo, sha);
			if (checks.length === 0) {
				if (this._host.now() - start >= graceMinutes * 60_000) {
					return ciMessage({ repo, target, outcome: 'never started', note: `No checks appeared within ${graceMinutes} minutes. ${await this.neverStartedReasons(repo)}` });
				}
			} else if (!checks.some(check => check.state === 'pending')) {
				return this.finishedMessage(repo, target, checks);
			}
			await this._host.sleep(CLAUDE_CI_WAIT_POLL_MS, signal);
		}
		return undefined;
	}

	/** Why a pull request got no checks, from what GitHub can tell about the repository. */
	private async neverStartedReasons(repo: string): Promise<string> {
		const reasons = ['A workflow may not run for this branch (check its `on:` triggers), or it may be workflow_dispatch only: start it by hand.'];
		const runners = await this._host.github.json('GET', `repos/${repo}/actions/runners?per_page=100`);
		if (runners.status === 200) {
			const offline = listOf(objectOf(runners.body).runners).filter(runner => runner.status === 'offline').map(runner => str(runner.name) ?? 'runner');
			if (offline.length) {
				reasons.push(`Offline runners: ${offline.join(', ')}. A job that needs one waits forever.`);
			}
		}
		const workflows = await this._host.github.json('GET', `repos/${repo}/actions/workflows?per_page=100`);
		if (workflows.status === 200 && listOf(objectOf(workflows.body).workflows).length === 0) {
			reasons.unshift('The repository has no workflow at all.');
		}
		return reasons.join(' ');
	}

	private async finishedMessage(repo: string, target: string, checks: readonly Check[]): Promise<string> {
		const failed = checks.filter(check => check.state === 'fail');
		if (failed.length === 0) {
			return ciMessage({ repo, target, outcome: 'pass', url: checks[0].url, note: `${checks.length} checks green.` });
		}
		const first = failed[0];
		const log = first.jobId !== undefined && /\/actions\/runs\//.test(first.url ?? '') ? await this._host.github.text(`repos/${repo}/actions/jobs/${first.jobId}/logs`) : undefined;
		return ciMessage({ repo, target, outcome: 'fail', url: first.url, failed: failed.map(check => check.name), log: log ? claudeLastLines(log) : undefined });
	}

	private async watchRun(repo: string, run: number, signal: AbortSignal): Promise<string | undefined> {
		const target = `run ${run}`;
		while (!signal.aborted) {
			const info = await this._host.github.json('GET', `repos/${repo}/actions/runs/${run}`);
			if (info.status !== 200) {
				return ciMessage({ repo, target, outcome: 'error', note: `Could not read the run: ${info.error ?? `GitHub answered ${info.status}`}.` });
			}
			const body = objectOf(info.body);
			if (body.status === 'completed') {
				const url = str(body.html_url);
				if (body.conclusion === 'success') {
					return ciMessage({ repo, target, outcome: 'pass', url });
				}
				const jobs = await this._host.github.json('GET', `repos/${repo}/actions/runs/${run}/jobs?per_page=100`);
				const failedJobs = listOf(objectOf(jobs.body).jobs).filter(job => job.conclusion === 'failure' || job.conclusion === 'timed_out');
				const jobId = typeof failedJobs[0]?.id === 'number' ? failedJobs[0].id : undefined;
				const log = jobId !== undefined ? await this._host.github.text(`repos/${repo}/actions/jobs/${jobId}/logs`) : undefined;
				return ciMessage({ repo, target, outcome: body.conclusion === 'cancelled' ? 'cancelled' : 'fail', url, failed: failedJobs.map(job => str(job.name) ?? 'job'), log: log ? claudeLastLines(log) : undefined });
			}
			await this._host.sleep(CLAUDE_CI_WAIT_POLL_MS, signal);
		}
		return undefined;
	}

	/** Picks the test tier from the diff, runs it, and returns one compact result. */
	async verify(args: ClaudeVerifyArgs): Promise<ClaudeNoModelToolResult> {
		const base = args.base?.trim() || 'origin/main';
		if (!/^[\w./-]+$/.test(base) || base.startsWith('-')) {
			return { text: `That base is not a git ref: ${base}`, isError: true };
		}
		const diff = await this._host.run('git', ['diff', '--name-only', `${base}...HEAD`], args.cwd);
		if (diff.code !== 0) {
			return { text: `[verify] ERROR · could not diff against ${base}: ${claudeLastLines(diff.stderr || diff.stdout, 3)}`, isError: true };
		}
		const files = diff.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
		if (files.length === 0) {
			return { text: `[verify] PASS · nothing to run · no changed files against ${base}` };
		}
		if (files.every(file => DOCS_ONLY.test(file))) {
			return { text: `[verify] PASS · nothing to run · docs-only change (${files.length} files)` };
		}
		const steps = await this.stepsFor(args.cwd, base);
		if (steps.steps.length === 0) {
			return { text: `[verify] PASS · nothing to run · ${steps.reason}` };
		}
		const results: { name: string; code: number | null; log: string; secs: number }[] = [];
		for (const step of steps.steps) {
			const started = this._host.now();
			const result = await this._host.run(step.command, step.args, args.cwd);
			results.push({ name: step.name, code: result.code, log: `${result.stdout}\n${result.stderr}`, secs: Math.round((this._host.now() - started) / 1000) });
			if (result.code !== 0) {
				break;
			}
		}
		const logFile = await this._host.writeLog('verify', results.map(result => `=== ${result.name} (exit ${result.code}) ===\n${result.log}`).join('\n'));
		const ok = results.every(result => result.code === 0);
		const lines = [`[verify] ${ok ? 'PASS' : 'FAIL'} · ${steps.reason}`];
		for (const result of results) {
			const counts = claudeTestCounts(result.log);
			lines.push(`${result.code === 0 ? 'ok  ' : 'FAIL'} ${result.name}${counts ? ` · ${counts.pass} passed${counts.fail ? `, ${counts.fail} failed` : ''}` : ''} · ${result.secs}s`);
		}
		for (const result of results.filter(r => r.code !== 0)) {
			const failures = claudeTestFailures(result.log);
			lines.push(`--- ${result.name} failed (exit ${result.code}) ---`);
			if (failures.names.length) {
				lines.push('Failing tests:', ...failures.names.map(name => `  ${name}`));
			}
			if (failures.locations.length) {
				lines.push(`Where: ${failures.locations.join(', ')}`);
			}
			lines.push('Last lines:', claudeLastLines(result.log, 12));
		}
		lines.push(`Full log: ${logFile}`);
		return { text: lines.join('\n').slice(0, VERIFY_MAX_CHARS), isError: !ok };
	}

	/** The commands to run: the repo's own tier script, else typecheck, lint and test scripts. */
	private async stepsFor(cwd: string, base: string): Promise<{ readonly reason: string; readonly steps: readonly { readonly name: string; readonly command: string; readonly args: readonly string[] }[] }> {
		const tierScript = await this._host.read(`${cwd}/build/klawly/test-tier.ts`) !== undefined ? 'build/klawly/test-tier.ts' : undefined;
		if (tierScript) {
			const picked = await this._host.run('node', [tierScript, '--base', base, '--json'], cwd);
			try {
				const result = JSON.parse(picked.stdout) as { tier: number; nodeTests: string[] };
				const tests = result.nodeTests.filter(file => /^[\w./-]+$/.test(file));
				return {
					reason: `tier ${result.tier} from the repo's ${tierScript}`,
					steps: tests.map(file => ({ name: file.split('/').at(-1) ?? file, command: 'npm', args: ['run', 'test-node', '--', '--run', file] })),
				};
			} catch {
				return { reason: `the repo's ${tierScript} gave no answer (${claudeLastLines(picked.stderr || picked.stdout, 2)})`, steps: [] };
			}
		}
		for (const script of ['scripts/test-tier.mjs', 'scripts/test-tier.js']) {
			if (await this._host.read(`${cwd}/${script}`) !== undefined) {
				return { reason: `the repo's ${script}`, steps: [{ name: 'tier', command: 'node', args: [script] }] };
			}
		}
		const manifest = await this._host.read(`${cwd}/package.json`);
		let scripts: Record<string, unknown> = {};
		try {
			scripts = manifest ? objectOf(objectOf(JSON.parse(manifest)).scripts) : {};
		} catch {
			// No readable package.json: no scripts.
		}
		const names = ['typecheck', 'type-check', 'lint', 'test'].filter(name => typeof scripts[name] === 'string');
		return {
			reason: names.length ? `default tier: ${names.join(', ')} npm scripts` : 'the repo has no tier script and no typecheck, lint or test script',
			steps: names.map(name => ({ name, command: 'npm', args: name === 'test' ? ['test'] : ['run', name] })),
		};
	}

	/**
	 * Merges a pull request when its required checks are green, or says why
	 * not. `dryRun` only reports. The user's approval is asked by the tool
	 * permission prompt before this runs, unless the setting skips it.
	 */
	async mergeGate(args: ClaudeMergeGateArgs): Promise<ClaudeNoModelToolResult> {
		const problem = claudeNoModelRepoProblem(args.repo);
		if (problem) {
			return { text: problem, isError: true };
		}
		const { repo, pr } = args;
		const github = this._host.github;
		const info = await github.json('GET', `repos/${repo}/pulls/${pr}`);
		if (info.status !== 200) {
			return { text: `[merge_gate] ERROR · could not read PR #${pr}: ${info.error ?? `GitHub answered ${info.status}`}.`, isError: true };
		}
		const body = objectOf(info.body);
		const base = str(objectOf(body.base).ref) ?? 'main';
		const head = str(objectOf(body.head).ref) ?? '';
		const sha = str(objectOf(body.head).sha) ?? '';
		if (body.state !== 'open') {
			return refused(`PR #${pr} is ${body.merged ? 'already merged' : 'closed'}, nothing to merge.`);
		}
		const required = await this.requiredChecks(repo, base);
		if (!required) {
			return refused(`${base} has no branch protection or ruleset. Add required checks before merging.`);
		}
		if (required.names.length === 0) {
			return refused(`${base} has ${required.source} but no required status checks.`);
		}
		if (body.draft === true) {
			return refused('the PR is a draft.');
		}
		let checks: Check[];
		try {
			checks = await checksOf(github, repo, sha);
		} catch (error) {
			return { text: `[merge_gate] ERROR · could not read the checks: ${error instanceof Error ? error.message : String(error)}`, isError: true };
		}
		const byName = new Map(checks.map(check => [check.name, check]));
		const missing = required.names.filter(name => !byName.has(name));
		const pending = required.names.filter(name => byName.get(name)?.state === 'pending');
		const failed = required.names.filter(name => byName.get(name)?.state === 'fail');
		if (missing.length || pending.length || failed.length) {
			const bits = [missing.length ? `missing: ${missing.join(', ')}` : '', pending.length ? `pending: ${pending.join(', ')}` : '', failed.length ? `failed: ${failed.join(', ')}` : ''].filter(Boolean);
			const wait = pending.length && !missing.length && !failed.length ? ` Call ci_wait for PR #${pr}, then merge_gate again.` : '';
			return refused(`required checks are not green (${bits.join('; ')}).${wait}`);
		}
		const state = str(body.mergeable_state);
		if (state === 'dirty') {
			return { text: '[merge_gate] REFUSED · the PR has merge conflicts. Resolve them (rebase or merge the base) and push.', isError: true };
		}
		if (state === 'behind' && required.strict) {
			if (args.dry_run) {
				return { text: `[merge_gate] BEHIND · PR #${pr} is behind ${base}, which ${required.source} requires up to date. Dry run: would update the branch, then you call ci_wait again.` };
			}
			const updated = await github.json('PUT', `repos/${repo}/pulls/${pr}/update-branch`);
			if (updated.status !== 202) {
				return { text: `[merge_gate] ERROR · PR #${pr} is behind ${base} and updating it failed: ${updated.error ?? `GitHub answered ${updated.status}`}.`, isError: true };
			}
			return { text: `[merge_gate] UPDATED · PR #${pr} was behind ${base}; its branch is updated and its checks restart. Call ci_wait for PR #${pr}, then merge_gate again.` };
		}
		if (state === 'blocked') {
			return { text: '[merge_gate] REFUSED · the checks are green but GitHub still blocks the merge (a required review, or a rule that is not about checks). Look at the PR.', isError: true };
		}
		if (args.dry_run) {
			return { text: `[merge_gate] OK · all ${required.names.length} required checks are green. Dry run: would squash-merge PR #${pr} into ${base} and delete ${head}.` };
		}
		const merged = await github.json('PUT', `repos/${repo}/pulls/${pr}/merge`, { merge_method: 'squash' });
		if (merged.status !== 200) {
			return { text: `[merge_gate] ERROR · the merge failed: ${merged.error ?? `GitHub answered ${merged.status}`}.`, isError: true };
		}
		const deleted = head && objectOf(body.head).repo !== null && objectOf(objectOf(body.head).repo).full_name === repo ? await github.json('DELETE', `repos/${repo}/git/refs/heads/${head.split('/').map(encodeURIComponent).join('/')}`) : undefined;
		return { text: `[merge_gate] MERGED · PR #${pr} into ${base} (squash).${deleted ? deleted.status === 204 ? ` Deleted ${head}.` : ` Could not delete ${head}: ${deleted.error ?? deleted.status}.` : ''}` };
	}

	/** The required check names and whether the branch must be up to date, from branch protection or else rulesets. */
	private async requiredChecks(repo: string, base: string): Promise<{ readonly names: readonly string[]; readonly strict: boolean; readonly source: string } | undefined> {
		const ref = base.split('/').map(encodeURIComponent).join('/');
		const protection = await this._host.github.json('GET', `repos/${repo}/branches/${ref}/protection`);
		if (protection.status === 200) {
			const checks = objectOf(objectOf(protection.body).required_status_checks);
			const names = new Set<string>([...(Array.isArray(checks.contexts) ? checks.contexts.filter((name): name is string => typeof name === 'string') : []), ...listOf(checks.checks).map(check => str(check.context)).filter((name): name is string => !!name)]);
			return { names: [...names], strict: checks.strict === true, source: 'branch protection' };
		}
		const rules = await this._host.github.json('GET', `repos/${repo}/rules/branches/${ref}`);
		if (rules.status === 200) {
			const checkRules = listOf(rules.body).filter(rule => rule.type === 'required_status_checks');
			if (checkRules.length) {
				const names = checkRules.flatMap(rule => listOf(objectOf(rule.parameters).required_status_checks).map(check => str(check.context)).filter((name): name is string => !!name));
				return { names, strict: checkRules.some(rule => objectOf(rule.parameters).strict_required_status_checks_policy === true), source: 'a ruleset' };
			}
		}
		return undefined;
	}
}

function refused(why: string): ClaudeNoModelToolResult {
	return { text: `[merge_gate] REFUSED · ${why}`, isError: true };
}

/** Paths that need no tests: prose, images and the design prototype. */
const DOCS_ONLY = /\.(md|mdx|txt|rst|png|jpe?g|gif|svg|webp)$|(^|\/)docs?\/|^design\/|(^|\/)(LICENSE|CHANGELOG|README)/i;

/** One verify result is cut at this many characters; the full log is in the file. */
const VERIFY_MAX_CHARS = 6000;

/** Passed and failed counts from a test log, or undefined when no known runner printed them. */
export function claudeTestCounts(log: string): { readonly pass: number; readonly fail: number } | undefined {
	const passing = /(\d+) passing/i.exec(log);
	if (passing) {
		return { pass: Number(passing[1]), fail: Number(/(\d+) failing/i.exec(log)?.[1] ?? 0) };
	}
	const jest = /Tests?:\s+(?:(\d+) failed,\s*)?(?:\d+ skipped,\s*)?(\d+) passed/i.exec(log);
	if (jest) {
		return { pass: Number(jest[2]), fail: Number(jest[1] ?? 0) };
	}
	const passed = /(\d+) passed(?:,\s*(\d+) failed)?/i.exec(log);
	return passed ? { pass: Number(passed[1]), fail: Number(passed[2] ?? 0) } : undefined;
}

/** The failing test names and the file:line places a log points at. */
export function claudeTestFailures(log: string): { readonly names: readonly string[]; readonly locations: readonly string[] } {
	const lines = log.replace(/\r/g, '').split('\n');
	const names = [...new Set(lines.filter(line => /^\s*(\d+\) |✗|✖|×|FAIL\b|not ok\b)/.test(line)).map(line => line.trim()))].slice(0, 15);
	const locations = [...new Set(log.match(/[\w./\\-]+\.(?:[tj]sx?|mjs|py|rs|go):\d+(?::\d+)?/g) ?? [])].slice(0, 12);
	return { names, locations };
}
