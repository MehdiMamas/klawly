/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Before/after benchmark of Auto delegation (issue 1318): the same small task set run
// with the strong model alone ("off") and with the strong model delegating to cheaper
// models ("on"). Spends real Claude runs: it needs the owner's approval.
// Usage: node build/klawly/bench-auto-delegation.ts <outDir> [--arms off,on] [--tasks a,b] [--budget 3]
// Each run is `claude -p` in a fresh temp folder; success is the task's own `node --test`
// plus a hidden check. Writes one JSON file per run and summary.md into <outDir>.
// Nothing is sent anywhere else.

import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

type Files = Record<string, string>;
interface Task { readonly id: string; readonly prompt: string; readonly files: Files; readonly hidden: Files; readonly check: readonly string[] }

const STRONG = 'opus';

/** The delegation guidance Auto gives the chat (claudeDelegateGuidance), with sub-agents standing in for the delegate tool. */
const DELEGATION_GUIDANCE = [
	'# Delegate a task',
	'You may hand a self-contained task to a sub-agent on another model with the Agent tool (set its `model`).',
	'- Write the whole task in the prompt: the sub-agent does not see this conversation. Name the files, the goal and what "done" means.',
	'- `haiku` for small, mechanical work; `sonnet` for most coding; `opus` (yourself) for hard reasoning and the final check.',
	'- Plan and review yourself; delegate building and mechanical steps. Check the result by running the tests.',
].join('\n');

const SLUG_TEST = [
	"import test from 'node:test';",
	"import assert from 'node:assert/strict';",
	"import { slugify } from './slugify.mjs';",
	"test('basic', () => assert.equal(slugify('Hello World'), 'hello-world'));",
	"test('trims and collapses', () => assert.equal(slugify('  Hello   --  World! '), 'hello-world'));",
	"test('accents', () => assert.equal(slugify('Cr\u00e8me Br\u00fbl\u00e9e'), 'creme-brulee'));",
	"test('empty', () => assert.equal(slugify('!!!'), ''));",
	'',
].join('\n');

const LRU_TEST = [
	"import test from 'node:test';",
	"import assert from 'node:assert/strict';",
	"import { LRU } from './lru.mjs';",
	"test('evicts oldest', () => { const c = new LRU(2); c.set('a', 1); c.set('b', 2); c.set('c', 3); assert.equal(c.get('a'), undefined); assert.deepEqual(c.keys(), ['b', 'c']); });",
	"test('get refreshes', () => { const c = new LRU(2); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3); assert.equal(c.has('b'), false); assert.deepEqual(c.keys(), ['a', 'c']); });",
	"test('overwrite refreshes', () => { const c = new LRU(2); c.set('a', 1); c.set('b', 2); c.set('a', 9); c.set('c', 3); assert.equal(c.get('a'), 9); assert.equal(c.size, 2); });",
	"test('has keeps order', () => { const c = new LRU(2); c.set('a', 1); c.set('b', 2); c.has('a'); c.set('c', 3); assert.equal(c.has('a'), false); });",
	"test('bad capacity', () => assert.throws(() => new LRU(0), RangeError));",
	'',
].join('\n');

const RENAME_TEST = [
	"import test from 'node:test';",
	"import assert from 'node:assert/strict';",
	"import { readFileSync, readdirSync } from 'node:fs';",
	"import { loadUser, profile, team, audit } from './src/index.mjs';",
	"test('works', () => { assert.equal(loadUser(1).id, 1); assert.equal(profile(2), 'user2#2'); assert.deepEqual(team([1, 2]), ['user1', 'user2']); assert.equal(audit([3])[0].audited, true); });",
	"test('no leftovers', () => { for (const f of [...readdirSync('src').map(n => 'src/' + n), 'README.md']) { assert.ok(!/fetchUser/.test(readFileSync(f, 'utf8')) && !/fetchUser/.test(f), f); } });",
	'',
].join('\n');

const CLI_TEST = [
	"import test from 'node:test';",
	"import assert from 'node:assert/strict';",
	"import { spawnSync } from 'node:child_process';",
	"const run = (...a) => spawnSync('node', ['cli.mjs', ...a], { encoding: 'utf8' });",
	"test('table', () => { const r = run('report'); assert.equal(r.status, 0); assert.match(r.stdout, /total\\s+16\\.50/); });",
	"test('unknown flag', () => assert.equal(run('--nope', 'report').status, 2));",
	'',
].join('\n');

const CLI_HIDDEN = [
	"import test from 'node:test';",
	"import assert from 'node:assert/strict';",
	"import { spawnSync } from 'node:child_process';",
	"const run = (...a) => spawnSync('node', ['cli.mjs', ...a], { encoding: 'utf8' });",
	"test('json', () => { const r = run('--json', 'report'); assert.equal(r.status, 0); assert.deepEqual(JSON.parse(r.stdout), { total: 16.5, items: [{ name: 'pen', qty: 3, price: 1.5 }, { name: 'book', qty: 1, price: 12 }] }); });",
	"test('json order independent', () => { const r = run('report', '--json'); assert.equal(JSON.parse(r.stdout).total, 16.5); });",
	"test('table unchanged', () => assert.match(run('report').stdout, /pen\\s+3\\s+1\\.50/));",
	"test('unknown flag', () => { const r = run('--nope', 'report'); assert.equal(r.status, 2); assert.ok(r.stderr.length > 0); });",
	'',
].join('\n');

const TASKS: Task[] = [
	{
		id: 'bug-slugify',
		prompt: 'The tests in test.mjs fail. Fix slugify.mjs so `node --test` passes. Do not edit test.mjs.',
		files: {
			'slugify.mjs': "export function slugify(s) {\n\treturn s.toLowerCase().replace(/ /g, '-');\n}\n",
			'test.mjs': SLUG_TEST,
		},
		hidden: { 'test.mjs': SLUG_TEST },
		check: ['test.mjs'],
	},
	{
		id: 'impl-lru',
		prompt: 'Implement the LRU cache described in README.md in lru.mjs so `node --test` passes. Do not edit test.mjs.',
		files: {
			'README.md': '# LRU\n`export class LRU` with `constructor(capacity)`, `get(key)` (returns undefined when missing; a hit makes the key most recent), `set(key, value)` (evicts the least recently used key beyond capacity; overwriting makes it most recent), `has(key)` (does not change recency), `get size()`, `keys()` (least to most recent). Capacity below 1 throws RangeError.\n',
			'lru.mjs': 'export class LRU {}\n',
			'test.mjs': LRU_TEST,
		},
		hidden: { 'test.mjs': LRU_TEST },
		check: ['test.mjs'],
	},
	{
		id: 'rename-fetchuser',
		prompt: 'Rename the function `fetchUser` to `loadUser` everywhere (definitions, imports, calls, comments, docs), including the file name src/fetchUser.mjs -> src/loadUser.mjs. test.mjs already expects the new names. Make `node --test` pass.',
		files: {
			'src/fetchUser.mjs': "// fetchUser returns a user record by id.\nexport function fetchUser(id) {\n\treturn { id, name: 'user' + id };\n}\n",
			'src/profile.mjs': "import { fetchUser } from './fetchUser.mjs';\nexport function profile(id) {\n\tconst u = fetchUser(id);\n\treturn u.name + '#' + u.id;\n}\n",
			'src/team.mjs': "import { fetchUser } from './fetchUser.mjs';\nexport function team(ids) {\n\treturn ids.map(id => fetchUser(id).name);\n}\n",
			'src/audit.mjs': "import { fetchUser } from './fetchUser.mjs';\n// Calls fetchUser once per id.\nexport function audit(ids) {\n\treturn ids.map(id => ({ ...fetchUser(id), audited: true }));\n}\n",
			'src/index.mjs': "export { fetchUser } from './fetchUser.mjs';\nexport { profile } from './profile.mjs';\nexport { team } from './team.mjs';\nexport { audit } from './audit.mjs';\n",
			'README.md': '# Users\nUse `fetchUser(id)` to get a user. `profile`, `team` and `audit` all call fetchUser.\n',
			'test.mjs': RENAME_TEST,
		},
		hidden: { 'test.mjs': RENAME_TEST },
		check: ['test.mjs'],
	},
	{
		id: 'feature-json-flag',
		prompt: 'Add a `--json` flag to the CLI: `node cli.mjs --json report` prints the report as a single JSON object `{"total":N,"items":[{"name":..,"qty":..,"price":..}]}` (items in input order) instead of the text table. Keep the text output unchanged without the flag, and unknown flags must still exit 2 with a message on stderr. Update README.md usage and add tests to test.mjs for the new flag. Make `node --test` pass. The cli parts live in args.mjs, format.mjs and cli.mjs.',
		files: {
			'data.mjs': "export const items = [{ name: 'pen', qty: 3, price: 1.5 }, { name: 'book', qty: 1, price: 12 }];\n",
			'args.mjs': "export function parseArgs(argv) {\n\tconst command = argv.find(a => !a.startsWith('--'));\n\tconst flags = argv.filter(a => a.startsWith('--'));\n\tfor (const f of flags) {\n\t\tif (f !== '--help') {\n\t\t\treturn { error: 'unknown flag ' + f };\n\t\t}\n\t}\n\treturn { command, help: flags.includes('--help') };\n}\n",
			'format.mjs': "export function formatTable(items) {\n\tconst rows = items.map(i => i.name.padEnd(8) + String(i.qty).padStart(3) + String(i.price.toFixed(2)).padStart(8));\n\tconst total = items.reduce((s, i) => s + i.qty * i.price, 0);\n\treturn [...rows, 'total'.padEnd(11) + total.toFixed(2).padStart(8)].join('\\n');\n}\n",
			'cli.mjs': "import { parseArgs } from './args.mjs';\nimport { formatTable } from './format.mjs';\nimport { items } from './data.mjs';\nconst a = parseArgs(process.argv.slice(2));\nif (a.error) {\n\tconsole.error(a.error);\n\tprocess.exit(2);\n}\nif (a.help || a.command !== 'report') {\n\tconsole.log('usage: cli.mjs [--help] report');\n\tprocess.exit(a.help ? 0 : 1);\n}\nconsole.log(formatTable(items));\n",
			'README.md': '# cli\nUsage: `node cli.mjs report` prints a table. `--help` shows usage.\n',
			'test.mjs': CLI_TEST,
		},
		hidden: { 'hidden.mjs': CLI_HIDDEN },
		check: ['hidden.mjs', 'test.mjs'],
	},
];

function writeFiles(dir: string, files: Files): void {
	for (const [name, text] of Object.entries(files)) {
		const target = join(dir, name);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, text);
	}
}

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : fallback;
}

interface ModelUse { costUsd: number; tokens: number }
interface Result { task: string; arm: string; ok: boolean; costUsd: number; tokens: number; wallSec: number; apiSec: number; turns: number; models: Record<string, ModelUse>; subagents: number; terminal: string }

const outDir = process.argv[2];
if (!outDir) {
	console.error('usage: node build/klawly/bench-auto-delegation.ts <outDir> [--arms off,on] [--tasks a,b] [--budget 3]');
	process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const arms = arg('--arms', 'off,on').split(',');
const only = arg('--tasks', '').split(',').filter(Boolean);
const budget = arg('--budget', '3');
const results: Result[] = [];

for (const task of TASKS.filter(t => !only.length || only.includes(t.id))) {
	for (const arm of arms) {
		const dir = mkdtempSync(join(tmpdir(), `klawly-bench-${task.id}-${arm}-`));
		writeFiles(dir, task.files);
		const args = ['-p', task.prompt, '--model', STRONG, '--output-format', 'json', '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--permission-mode', 'bypassPermissions', '--max-budget-usd', budget];
		if (arm === 'on') {
			args.push('--append-system-prompt', DELEGATION_GUIDANCE);
		} else {
			args.push('--disallowedTools', 'Agent,Task');
		}
		const start = Date.now();
		const run = spawnSync('claude', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });
		const wallSec = (Date.now() - start) / 1000;
		let json: any = {};
		try {
			json = JSON.parse(run.stdout);
		} catch {
			json = { parseError: String(run.stderr).slice(0, 500) };
		}
		writeFiles(dir, task.hidden);
		const check = spawnSync('node', ['--test', ...task.check], { cwd: dir, encoding: 'utf8' });
		const models: Record<string, ModelUse> = {};
		let tokens = 0;
		for (const [model, u] of Object.entries<any>(json.modelUsage ?? {})) {
			const t = u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
			models[model] = { costUsd: Number(u.costUSD.toFixed(4)), tokens: t };
			tokens += t;
		}
		const r: Result = {
			task: task.id, arm, ok: check.status === 0, costUsd: Number((json.total_cost_usd ?? 0).toFixed(4)), tokens,
			wallSec: Number(wallSec.toFixed(1)), apiSec: Number(((json.duration_api_ms ?? 0) / 1000).toFixed(1)), turns: json.num_turns ?? 0,
			models, subagents: json.subagent_stats?.spawned ?? 0, terminal: json.terminal_reason ?? 'none',
		};
		results.push(r);
		writeFileSync(join(outDir, `${task.id}.${arm}.json`), JSON.stringify({ result: r, claude: { ...json, result: undefined, session_id: undefined }, testOutputTail: check.stdout.split('\n').slice(-15).join('\n') }, undefined, '\t'));
		console.log(JSON.stringify(r));
		rmSync(dir, { recursive: true, force: true });
	}
}

const lines = ['| Task | Arm | Pass | Cost USD | Tokens | Wall s | Sub-agents | Models |', '|---|---|---|---|---|---|---|---|'];
for (const r of results) {
	lines.push(`| ${r.task} | ${r.arm} | ${r.ok ? 'yes' : 'NO'} | ${r.costUsd.toFixed(2)} | ${r.tokens} | ${r.wallSec} | ${r.subagents} | ${Object.keys(r.models).join(', ')} |`);
}
writeFileSync(join(outDir, 'summary.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
