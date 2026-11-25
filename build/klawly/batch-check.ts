/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The one heavy check of a batch of ready PRs (docs/rules/55-tiered-testing.md, issue 1362).
// session-manager's batch_gate merges the PRs labeled `ready-batch` onto a staging branch in a worktree
// and runs this there with BATCH_PRS=1351,1352,... (see .batch-gate.json). Lanes run only Tier 0.
//
// A fresh worktree first gets the main checkout's node_modules and Electron build (worktree-setup.ts).
// Steps, in order; all run even after a failure so every PR gets its notes:
//   compile -> typecheck -> affected tests -> design-sync -> check-names -> screenshots (UI PRs only)
// It writes batch-result.json: { prs: { "<n>": { notes, screenshots } }, steps: [{ name, ok, logTail }] }
// and exits 0 only when every step passed.
//
// With BATCH_PRS unset or empty it is a baseline run of the current checkout (main alone): the last commit's files pick the tier.
//
// Usage: BATCH_PRS=1351,1352 node build/klawly/batch-check.ts [--base <ref>] [--dispatch] [--no-screenshots] [--out <file>]
//   --dispatch        after a green run, start at most one heavy-tests run for the staging branch
//                     (test-tier.ts --dispatch); the branch must be pushed
//   --no-screenshots  skip the screenshots step
// Screenshots reuse `npm run redesign-shots` (dark theme, large window), once for the whole batch.

import { execFileSync, spawnSync } from 'child_process';
import { existsSync, readdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { changedFiles, pickTier, readTestImports } from './test-tier.ts';
import { prepareWorktree } from './worktree-setup.ts';

export interface StepResult {
	readonly name: string;
	readonly ok: boolean;
	readonly logTail: string;
}

export interface PrResult {
	notes: string[];
	screenshots: string[];
}

export interface BatchResult {
	prs: Record<string, PrResult>;
	steps: StepResult[];
}

/** Paths whose change shows in the app window, so the batch takes screenshots. */
const UI_PATHS = /^src\/vs\/workbench\/(contrib|browser|services)\/.*\.(css|ts)$|^src\/vs\/sessions\//;
const NOT_UI = /\/(test|common|node|electron-main)\//;

/** Lines of a step's log kept in batch-result.json. */
const LOG_TAIL_LINES = 40;

/** The union of the files the PRs changed, forward slashes, sorted. */
export function unionChangedFiles(perPr: ReadonlyMap<string, readonly string[]>): string[] {
	const all = new Set<string>();
	for (const files of perPr.values()) {
		files.forEach(file => all.add(file.replace(/\\/g, '/')));
	}
	return [...all].sort();
}

/** The files a baseline run (no PRs) checks: the diff against the base, or else the last commit's files. */
export function baselineFiles(diffAgainstBase: readonly string[], lastCommit: () => string[]): string[] {
	return diffAgainstBase.length ? [...diffAgainstBase] : lastCommit();
}

/** True when a PR changes something that draws in the app. */
export function touchesUi(files: readonly string[]): boolean {
	return files.some(file => UI_PATHS.test(file) && !NOT_UI.test(file));
}

/**
 * The PRs a failed step points at: those that changed a file the step's log names. `covers` maps a
 * source file to the tests that cover it, so a failing test points at the PR that changed its source.
 * Without a hit the failure cannot be told apart, so it belongs to every PR in the batch.
 */
export function prsForFailure(log: string, perPr: ReadonlyMap<string, readonly string[]>, covers: ReadonlyMap<string, readonly string[]> = new Map()): { prs: string[]; attributed: boolean } {
	const text = log.replace(/\\/g, '/');
	const hit = new Set<string>();
	for (const [pr, files] of perPr) {
		for (const file of files) {
			if ([file, ...(covers.get(file) ?? [])].some(name => text.includes(name))) {
				hit.add(pr);
			}
		}
	}
	return hit.size ? { prs: [...hit].sort(), attributed: true } : { prs: [...perPr.keys()].sort(), attributed: false };
}

/** Puts each failed step in the notes of the PRs it points at, and the screenshots on the UI PRs. */
export function buildResult(steps: readonly StepResult[], perPr: ReadonlyMap<string, readonly string[]>, covers: ReadonlyMap<string, readonly string[]>, screenshots: readonly string[]): BatchResult {
	const prs: Record<string, PrResult> = {};
	for (const [pr, files] of perPr) {
		prs[pr] = { notes: [], screenshots: touchesUi(files) ? [...screenshots] : [] };
	}
	for (const step of steps) {
		if (step.ok) {
			continue;
		}
		const { prs: hit, attributed } = prsForFailure(step.logTail, perPr, covers);
		for (const pr of hit) {
			prs[pr].notes.push(attributed ? `${step.name} failed and names files this PR changed` : `${step.name} failed; not tied to one PR, so every PR in the batch carries it`);
		}
	}
	return { prs, steps: [...steps] };
}

function tail(text: string): string {
	return text.split(/\r?\n/).slice(-LOG_TAIL_LINES).join('\n');
}

function run(name: string, command: string, args: readonly string[]): StepResult {
	console.log(`\n== ${name}: ${command} ${args.join(' ')}`);
	const started = Date.now();
	const out = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
	const log = `${out.stdout ?? ''}${out.stderr ?? ''}${out.error ? String(out.error) : ''}`;
	const ok = out.status === 0;
	console.log(`${ok ? 'ok' : 'FAILED'} ${name} (${Math.round((Date.now() - started) / 1000)}s)`);
	if (!ok) {
		console.log(tail(log));
	}
	return { name, ok, logTail: tail(log) };
}

function git(args: readonly string[]): string {
	return execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
}

function lastCommitFiles(): string[] {
	try {
		return git(['diff', '--name-only', 'HEAD~1', 'HEAD']).split(/\r?\n/).filter(Boolean);
	} catch {
		return [];
	}
}

/** Files one PR changed, from GitHub, so the union can be mapped back to PRs. */
function prFiles(pr: string): string[] {
	const out = execFileSync('gh', ['pr', 'diff', pr, '--name-only'], { encoding: 'utf8', windowsHide: true });
	return out.split(/\r?\n/).filter(Boolean);
}

function parseArgs(argv: readonly string[]) {
	const options = { base: 'origin/main', dispatch: false, screenshots: true, out: 'batch-result.json' };
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case '--base': options.base = argv[++i]; break;
			case '--out': options.out = argv[++i]; break;
			case '--dispatch': options.dispatch = true; break;
			case '--no-screenshots': options.screenshots = false; break;
			default: throw new Error(`Unknown argument ${argv[i]}`);
		}
	}
	return options;
}

function main(): void {
	const options = parseArgs(process.argv.slice(2));
	const prList = (process.env.BATCH_PRS ?? '').split(',').map(pr => pr.trim()).filter(Boolean);
	const root = git(['rev-parse', '--show-toplevel']);
	process.chdir(root);
	prepareWorktree(root);

	const perPr = new Map<string, string[]>(prList.map(pr => [pr, prFiles(pr)]));
	// The staging branch holds the merged batch, so its diff against the base is the union.
	let union = changedFiles(options.base, 'HEAD', false);
	if (!union.length) {
		union = unionChangedFiles(perPr);
	}
	if (!prList.length) {
		// No PRs: a baseline run of main alone (batch_gate after a red batch). Check what the last commit changed.
		union = baselineFiles(union, () => lastCommitFiles());
		console.log('Baseline run: no BATCH_PRS, checking the current checkout alone.');
	}
	console.log(`Batch ${prList.join(', ') || '(none)'}: ${union.length} changed files`);

	const imports = readTestImports(root);
	const tier = pickTier(union, imports);
	console.log(`Tier ${tier.tier}: ${tier.reasons.join('; ')}`);
	// Source file -> the listed tests that import it, to point a failing test back at the PR that changed it.
	const covers = new Map<string, string[]>();
	for (const test of [...tier.nodeTests, ...tier.electronTests]) {
		for (const imported of imports.get(test) ?? []) {
			covers.set(imported, [...(covers.get(imported) ?? []), test]);
		}
	}

	const steps: StepResult[] = [];
	const code = tier.tier > 0;
	if (code) {
		steps.push(run('compile', 'npm', ['run', 'compile']));
		steps.push(run('typecheck', 'npm', ['run', 'typecheck-client']));
		if (tier.nodeTests.length) {
			steps.push(run('node-tests', 'npm', ['run', 'test-node', '--', ...tier.nodeTests.flatMap(file => ['--run', file])]));
		}
		if (tier.electronTests.length) {
			const script = process.platform === 'win32' ? path.join('scripts', 'test.bat') : './scripts/test.sh';
			steps.push(run('electron-tests', script, tier.electronTests.flatMap(file => ['--run', file])));
		}
	} else {
		console.log('Docs only: compile, typecheck and tests skipped.');
	}
	steps.push(run('design-sync', 'npm', ['run', 'design-sync']));
	steps.push(run('check-names', 'npm', ['run', 'check-names']));

	const screenshots: string[] = [];
	const uiPrs = [...perPr].filter(([, files]) => touchesUi(files)).map(([pr]) => pr);
	if (uiPrs.length && options.screenshots && code) {
		const outDir = path.join('design', '.parity', 'batch');
		steps.push(run('screenshots', 'npm', ['run', 'redesign-shots', '--', '--theme', 'dark', '--size', 'large', '--out', outDir]));
		if (existsSync(outDir)) {
			screenshots.push(...readdirSync(outDir).filter(file => file.endsWith('.png')).map(file => path.join(outDir, file).replace(/\\/g, '/')));
		}
	}

	const result = buildResult(steps, perPr, covers, screenshots);
	for (const pr of uiPrs) {
		if (!result.prs[pr].screenshots.length) {
			result.prs[pr].notes.push(options.screenshots ? 'no screenshots were produced' : 'screenshots skipped (--no-screenshots)');
		}
	}
	writeFileSync(options.out, JSON.stringify(result, null, '\t') + '\n');
	const failed = steps.filter(step => !step.ok);
	console.log(`\n${failed.length ? `RED: ${failed.map(step => step.name).join(', ')} failed` : 'GREEN'}; wrote ${options.out}`);

	if (!failed.length && options.dispatch) {
		const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
		execFileSync('node', ['build/klawly/test-tier.ts', '--dispatch', '--ref', branch], { stdio: 'inherit', windowsHide: true });
	}
	process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
