/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Picks the test tier of a change from the paths it touches (docs/rules/55-tiered-testing.md)
// and the unit tests that cover it, so nobody picks the tier by feel.
//   Tier 0  every edit, locally, no runner: lint, typecheck and the tests listed here.
//   Tier 1  a small fix in one area: one heavy-tests job on one OS, the listed tests plus the typecheck.
//   Tier 2  a normal PR, or any risky path below: the listed tests on Windows and macOS plus the
//           full typecheck, once when the PR is ready.
//   Tier 3  a release or the end of a sprint (--release): the full suites.
// Docs-only changes are Tier 0. The script never picks Tier 3 on its own.
//
// Usage: node build/klawly/test-tier.ts [--base <ref>] [--head <ref>] [--working] [--files <path>...]
//          [--release] [--json] [--github-output] [--dispatch [--ref <branch>] [--os any|Windows|macOS]]
//   --base          compare against this ref (default origin/main); the diff starts at the merge base
//   --head          the change's tip (default HEAD)
//   --working       also count uncommitted and untracked files (for Tier 0 while you work)
//   --files         classify these paths instead of a git diff
//   --release       Tier 3
//   --json          print the result as JSON
//   --github-output write tier, node-tests, electron-tests to $GITHUB_OUTPUT and a summary to $GITHUB_STEP_SUMMARY
//   --since         the head of the last passing heavy run: when HEAD is only a merge from the base and the
//                   branch side overlaps it in design/sync.json alone, say no new heavy run is needed
//   --dispatch      start the one heavy-tests run for this tier (refuses Tier 0 and unpushed commits)
// No dependencies.

import { execFileSync } from 'child_process';
import { appendFileSync, readFileSync, realpathSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export type Tier = 0 | 1 | 2 | 3;

/**
 * Paths that make a change Tier 2 or above however small it is. This is the one list: add a
 * path here when a change to it can break more than the tests next to it.
 */
export const RISKY_PATHS: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
	// Dependencies: a lock or manifest change reinstalls node_modules on every runner.
	{ kind: 'dependencies', pattern: /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|\.npmrc|\.nvmrc|cgmanifest\.json)$/ },
	// Build and test tooling.
	{ kind: 'build', pattern: /^(build|scripts|test)\/|^gulpfile|(^|\/)tsconfig[^/]*\.json$|^eslint\.config|^product\.json$|^\.vscode-test/ },
	// CI.
	{ kind: 'ci', pattern: /^\.github\// },
	// Shared core: code every part of the app loads.
	{ kind: 'shared-core', pattern: /^src\/[^/]+\.ts$|^src\/vs\/(base|code|server)\/|^src\/vs\/platform\/(instantiation|configuration|storage|files|log|environment|ipc|native)\/|^src\/vs\/editor\/common\/|^src\/vs\/workbench\/(browser|common|electron-browser)\/|^src\/vs\/workbench\/workbench\.[^/]+\.ts$/ },
	// Klawly's normalized Claude protocol, shared by the platform, the services and the UI.
	{ kind: 'shared-core', pattern: /^src\/vs\/platform\/claude\/common\/claude(Protocol|Types|Service)[^/]*\.ts$|^src\/vs\/workbench\/services\/claude\/common\// },
	// Public API: what extensions see.
	{ kind: 'public-api', pattern: /^src\/vscode-dts\/|^src\/vs\/workbench\/api\/|^src\/vs\/platform\/extensions\// },
	// Security: credentials, sandboxing, permissions and the process that runs Claude Code.
	{ kind: 'security', pattern: /^src\/vs\/platform\/(secrets|encryption|sandbox)\/|^src\/vs\/platform\/claude\/(node|electron-main)\/|(^|\/)[^/]*(credential|Credential|secret|Secret|permission|Permission|sandbox|Sandbox)[^/]*\.ts$/ },
];

/** Paths that need no runner: prose, images and the static design prototype. */
const DOCS_ONLY = /\.(md|txt|png|jpe?g|gif|svg|webp)$|^docs\/|^design\/|(^|\/)(LICENSE|ThirdPartyNotices)[^/]*$/;

/** A small fix touches at most this many source files (tests do not count) in one area. */
export const SMALL_FIX_MAX_FILES = 5;

/** Test folders whose tests need Electron (scripts/test); the rest run under npm run test-node. */
const ELECTRON_TEST = /\/test\/(.+\/)?(browser|electron-browser|electron-main|electron-utility)\//;

/** Files test/unit/node/index.js leaves out of the node run (its excludeGlobs). */
const NOT_IN_NODE = /^src\/vs\/platform\/environment\/test\/node\/nativeModules\.test\.ts$|^src\/vs\/base\/parts\/storage\/test\/node\/storage\.test\.ts$|^src\/vs\/workbench\/contrib\/testing\/test\/|^src\/vs\/sessions\/test\/web\.test\.ts$/;

export interface TierResult {
	readonly tier: Tier;
	/** Why the tier is what it is, one line each. */
	readonly reasons: readonly string[];
	readonly areas: readonly string[];
	/** For npm run test-node -- --run; empty at Tier 3, which runs the whole suite. */
	readonly nodeTests: readonly string[];
	/** For scripts/test --run; empty at Tier 3, which runs the whole suite. */
	readonly electronTests: readonly string[];
	/** Changed source files no test covers. */
	readonly uncovered: readonly string[];
}

/**
 * Classifies changed paths (repo-relative, forward slashes).
 * @param testImports every .ts file under a test/ folder in the head tree, mapped to the repo-relative
 * .ts files it imports. Only these tests are ever listed.
 */
export function pickTier(changed: readonly string[], testImports: ReadonlyMap<string, readonly string[]>, options: { release?: boolean } = {}): TierResult {
	const files = [...new Set(changed.map(file => file.replace(/\\/g, '/')))].sort();
	const code = files.filter(file => !DOCS_ONLY.test(file));
	const reasons: string[] = [];
	let tier: Tier = 0;

	if (code.length === 0) {
		reasons.push(files.length ? 'docs only: no runner' : 'no changes');
	} else {
		tier = 1;
		for (const file of code) {
			const risk = RISKY_PATHS.find(rule => rule.pattern.test(file));
			if (risk) {
				tier = 2;
				reasons.push(`${risk.kind}: ${file}`);
			}
		}
	}

	const areas = [...new Set(code.map(areaOf))].sort();
	const sources = code.filter(file => !isTestFolderFile(file));
	if (tier === 1 && areas.length > 1) {
		tier = 2;
		reasons.push(`more than one area: ${areas.join(', ')}`);
	}
	if (tier === 1 && sources.length > SMALL_FIX_MAX_FILES) {
		tier = 2;
		reasons.push(`${sources.length} source files (a small fix has at most ${SMALL_FIX_MAX_FILES})`);
	}
	if (tier === 1) {
		reasons.push(`small fix in ${areas[0]}`);
	}
	if (options.release) {
		tier = 3;
		reasons.push('release or end of sprint: full suites');
	}

	const tests = new Set<string>();
	const uncovered: string[] = [];
	if (tier > 0 && tier < 3) {
		const importers = invert(testImports);
		for (const file of code.filter(file => file.startsWith('src/') && file.endsWith('.ts'))) {
			const found = coveringTests(file, testImports, importers);
			found.forEach(test => tests.add(test));
			if (!found.length && !isTestFolderFile(file)) {
				uncovered.push(file);
			}
		}
	}
	const sorted = [...tests].sort();
	return {
		tier,
		reasons,
		areas,
		nodeTests: sorted.filter(test => !ELECTRON_TEST.test(test) && !NOT_IN_NODE.test(test)),
		electronTests: sorted.filter(test => ELECTRON_TEST.test(test)),
		uncovered,
	};
}

/** The part of the tree a file belongs to: a contribution, a service, a platform component or an extension. */
export function areaOf(file: string): string {
	const parts = file.split('/');
	if (parts[0] === 'src' && parts[1] === 'vs') {
		const deep = ['workbench', 'sessions', 'editor'].includes(parts[2]) && ['contrib', 'services', 'api'].includes(parts[3]);
		return parts.slice(0, Math.min(deep ? 5 : 4, parts.length - 1)).join('/');
	}
	if (parts[0] === 'extensions' && parts.length > 2) {
		return parts.slice(0, 2).join('/');
	}
	return parts.length > 1 ? parts[0] : '.';
}

function isTestFolderFile(file: string): boolean {
	return /(^|\/)test\//.test(file);
}

function isTestFile(file: string): boolean {
	return file.endsWith('.test.ts') && isTestFolderFile(file);
}

function invert(testImports: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
	const importers = new Map<string, string[]>();
	for (const [file, imports] of testImports) {
		for (const target of imports) {
			const list = importers.get(target) ?? [];
			list.push(file);
			importers.set(target, list);
		}
	}
	return importers;
}

/**
 * The tests that cover a file: the file itself if it is a test; tests that import it, directly or
 * through test helpers; else a test of the same name in a test folder for the file's layer
 * (common, node, browser, ...); else every test in the nearest such folder.
 */
function coveringTests(file: string, testImports: ReadonlyMap<string, readonly string[]>, importers: ReadonlyMap<string, readonly string[]>): string[] {
	const found = new Set<string>();
	// A changed test the head tree does not have (deleted on the branch) cannot run.
	if (isTestFile(file) && testImports.has(file)) {
		found.add(file);
	}
	const seen = new Set([file]);
	const queue = [file];
	while (queue.length) {
		for (const importer of importers.get(queue.shift()!) ?? []) {
			if (!seen.has(importer)) {
				seen.add(importer);
				if (isTestFile(importer)) {
					found.add(importer);
				} else {
					queue.push(importer);
				}
			}
		}
	}
	if (found.size || isTestFolderFile(file)) {
		return [...found];
	}

	const base = path.posix.basename(file, '.ts');
	const tests = [...testImports.keys()].filter(isTestFile);
	const folders = testFoldersFor(file);
	for (const folder of folders) {
		const named = tests.filter(test => test.startsWith(folder) && path.posix.basename(test, '.test.ts') === base);
		if (named.length) {
			return named;
		}
	}
	// Only the nearest folder: the ones above it hold the tests of a whole layer.
	return folders.length ? tests.filter(test => test.startsWith(folders[0])) : [];
}

/**
 * Test folders for a source file, nearest first: for src/vs/platform/claude/common/x.ts,
 * src/vs/platform/claude/test/common/ and then src/vs/platform/test/common/.
 */
function testFoldersFor(file: string): string[] {
	const parts = path.posix.dirname(file).split('/');
	const layerIndex = parts.findIndex((part, index) => index > 2 && /^(common|node|browser|electron-browser|electron-main|electron-utility|worker)$/.test(part));
	if (layerIndex < 0) {
		return [];
	}
	const layer = parts[layerIndex];
	const folders: string[] = [];
	for (let end = layerIndex; end > 2; end--) {
		folders.push(`${parts.slice(0, end).join('/')}/test/${layer}/`);
	}
	return folders;
}

/** The repo-relative .ts files a TypeScript source imports (relative and vs/ specifiers only). */
export function importsOf(file: string, content: string): string[] {
	const imports = new Set<string>();
	const specifier = /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)['"](?<spec>[^'"]+)['"]/gm;
	for (const match of content.matchAll(specifier)) {
		const spec = match.groups!.spec;
		let target: string | undefined;
		if (spec.startsWith('.')) {
			target = path.posix.join(path.posix.dirname(file), spec);
		} else if (spec.startsWith('vs/')) {
			target = `src/${spec}`;
		}
		if (target && /\.js$/.test(target)) {
			imports.add(target.replace(/\.js$/, '.ts'));
		}
	}
	return [...imports];
}

function git(args: readonly string[]): string {
	return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 2 ** 28, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

function lines(text: string): string[] {
	return text.split(/\r?\n/).filter(Boolean);
}

/** Every tracked .ts file under a test/ folder in src, with its imports. */
export function readTestImports(root: string): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const file of lines(git(['-C', root, 'ls-files', '--', ':(glob)src/**/test/**/*.ts']))) {
		try {
			map.set(file, importsOf(file, readFileSync(path.join(root, file), 'utf8')));
		} catch {
			// Listed but deleted in the working tree.
		}
	}
	return map;
}

/**
 * The files changed since the merge base of base and head. Without a merge base it throws: a diff
 * of the two trees would count everything base gained since the branch, and its tests.
 */
export function changedFiles(base: string, head: string, working: boolean, run: (args: readonly string[]) => string = git): string[] {
	let from: string;
	try {
		from = run(['merge-base', base, head]);
	} catch {
		throw new Error(`No merge base for ${base} and ${head}: the history is too shallow. Fetch more (git fetch --deepen=<n> origin ${head} ${base.replace(/^origin\//, '')}) or pass --files.`);
	}
	const files = lines(run(working ? ['diff', '--name-only', from] : ['diff', '--name-only', from, head]));
	if (working) {
		files.push(...lines(run(['ls-files', '--others', '--exclude-standard'])));
	}
	return files;
}

/**
 * True when `head` only merges the base into the branch since `since` (the last passing heavy-run
 * head): one merge commit whose first parent is `since` and whose second parent is on the base,
 * and the files the branch side also changed (where a conflict could be) are design/sync.json
 * alone, which design-sync regenerates (docs/rules/36-design-prototype.md).
 */
export function isOnlyMainMerge(since: string, head: string, base: string, run: (args: readonly string[]) => string = git): boolean {
	const commits = lines(run(['rev-list', '--parents', `${since}..${head}`]));
	if (commits.length !== 1) {
		return false;
	}
	const [commit, first, second, ...rest] = commits[0].split(' ');
	if (!commit || first !== run(['rev-parse', since]) || !second || rest.length) {
		return false;
	}
	try {
		run(['merge-base', '--is-ancestor', second, base]);
	} catch {
		return false;
	}
	const forkPoint = run(['merge-base', first, second]);
	const mainSide = new Set(lines(run(['diff', '--name-only', first, commit])));
	const branchSide = lines(run(['diff', '--name-only', forkPoint, first]));
	return branchSide.filter(file => mainSide.has(file)).every(file => file === 'design/sync.json');
}

function parseArgs(argv: readonly string[]) {
	const options = { base: 'origin/main', head: 'HEAD', working: false, files: undefined as string[] | undefined, release: false, json: false, githubOutput: false, dispatch: false, since: '', ref: '', os: 'any' };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			const next = argv[++i];
			if (next === undefined) {
				throw new Error(`${arg} needs a value`);
			}
			return next;
		};
		switch (arg) {
			case '--base': options.base = value(); break;
			case '--head': options.head = value(); break;
			case '--ref': options.ref = value(); break;
			case '--os': options.os = value(); break;
			case '--working': options.working = true; break;
			case '--release': options.release = true; break;
			case '--json': options.json = true; break;
			case '--github-output': options.githubOutput = true; break;
			case '--since': options.since = argv[++i]; break;
			case '--dispatch': options.dispatch = true; break;
			case '--files':
				options.files = [];
				while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
					options.files.push(argv[++i]);
				}
				break;
			default: throw new Error(`Unknown argument ${arg}`);
		}
	}
	if (!['any', 'Windows', 'macOS'].includes(options.os)) {
		throw new Error('--os is any, Windows or macOS');
	}
	return options;
}

/** The OSes tiers 2 and 3 run on: the repo variable HEAVY_TEST_OSES, else Windows and macOS. */
function heavyOses(): string {
	try {
		const value = execFileSync('gh', ['variable', 'get', 'HEAVY_TEST_OSES'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
		return (JSON.parse(value) as string[]).join(' and ');
	} catch {
		return 'Windows and macOS';
	}
}

function runnerText(tier: number): string {
	return ['local only, no runner', 'one heavy-tests job on one OS, plus the typecheck', `heavy-tests on ${heavyOses()}, plus the full typecheck`, `heavy-tests full suites on ${heavyOses()}`][tier];
}

function describe(result: TierResult): string {
	const out = [`Tier ${result.tier}: ${runnerText(result.tier)}`, ...result.reasons.map(reason => `  - ${reason}`)];
	if (result.tier > 0 && result.tier < 3) {
		out.push(`Node tests (${result.nodeTests.length}):`, ...result.nodeTests.map(test => `  ${test}`));
		out.push(`Electron tests (${result.electronTests.length}):`, ...result.electronTests.map(test => `  ${test}`));
	}
	if (result.uncovered.length) {
		out.push(`No test covers (${result.uncovered.length}):`, ...result.uncovered.map(file => `  ${file}`));
	}
	return out.join('\n');
}

function dispatchArgs(result: TierResult, ref: string, os: string): string[] {
	const args = ['workflow', 'run', 'heavy-tests.yml', '-f', `ref=${ref}`, '-f', `tier=${result.tier}`, '-f', `os=${os}`];
	if (result.tier < 3) {
		args.push('-f', `node-tests=${result.nodeTests.join(' ')}`, '-f', `electron-tests=${result.electronTests.join(' ')}`);
	}
	return args;
}

function main(): void {
	const options = parseArgs(process.argv.slice(2));
	const root = git(['rev-parse', '--show-toplevel']);
	if (options.since && isOnlyMainMerge(options.since, options.head, options.base)) {
		console.log(`No new heavy run needed: ${options.head} only merges ${options.base} since ${options.since}, and the branch side overlaps it in design/sync.json alone.`);
		return;
	}
	const changed = options.files ?? changedFiles(options.base, options.head, options.working);
	const result = pickTier(changed, readTestImports(root), { release: options.release });

	if (options.json) {
		console.log(JSON.stringify(result, null, '\t'));
	} else {
		console.log(describe(result));
	}

	if (options.githubOutput) {
		const output = process.env.GITHUB_OUTPUT;
		if (output) {
			appendFileSync(output, `tier=${result.tier}\nnode-tests=${result.nodeTests.join(' ')}\nelectron-tests=${result.electronTests.join(' ')}\n`);
		}
		const summary = process.env.GITHUB_STEP_SUMMARY;
		if (summary) {
			appendFileSync(summary, `### Test tier\n\n\`\`\`\n${describe(result)}\n\`\`\`\n`);
		}
		// The workflow passes the tier it was started at; a lower one skips OSes or the typecheck.
		const requested = Number(process.env.REQUESTED_TIER);
		if (requested && result.tier > requested) {
			console.log(`::warning::This change is Tier ${result.tier} but the run was started at Tier ${requested}: start it again with -f tier=${result.tier}.`);
		}
	}

	if (options.dispatch) {
		if (result.tier === 0) {
			console.log('Tier 0 needs no runner: run the listed checks locally.');
			return;
		}
		const ref = options.ref || git(['rev-parse', '--abbrev-ref', 'HEAD']);
		const local = git(['rev-parse', 'HEAD']);
		let remote = '';
		try {
			remote = git(['rev-parse', `origin/${ref}`]);
		} catch {
			// Never pushed.
		}
		if (!options.ref && remote !== local) {
			throw new Error(`origin/${ref} is not at HEAD: push the branch first, the runner tests what is on GitHub`);
		}
		// One OS for Tier 1; the workflow runs Tier 2 and 3 on every supported OS itself.
		const args = dispatchArgs(result, ref, result.tier === 1 ? options.os : 'any');
		console.log(`gh ${args.map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ')}`);
		execFileSync('gh', args, { stdio: 'inherit', windowsHide: true });
	}
}

// Real paths: Node resolves symlinks in the entry point's URL, not in argv.
if (process.argv[1] && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
