/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_CI_WAIT_TOOL_ID, CLAUDE_MERGE_GATE_TOOL_ID, CLAUDE_VERIFY_TOOL_ID } from '../../common/claudeNoModelTools.js';
import { CLAUDE_MERGE_WITHOUT_ASKING_SETTING, readClaudeMergeWithoutAsking } from '../../common/claudeConfiguration.js';
import { ClaudeNoModelGitHub, ClaudeNoModelGitHubResponse, ClaudeNoModelHost, ClaudeNoModelProcessResult, ClaudeNoModelTools, claudeLastLines, claudeTestCounts, claudeTestFailures } from '../../node/claudeNoModelTools.js';

type Route = ClaudeNoModelGitHubResponse | ((call: number) => ClaudeNoModelGitHubResponse);

/** A GitHub that answers recorded JSON by "METHOD endpoint" and remembers every call. */
function fakeGitHub(routes: Readonly<Record<string, Route>>, logs: Readonly<Record<string, string>> = {}): ClaudeNoModelGitHub & { readonly calls: string[] } {
	const calls: string[] = [];
	const counts = new Map<string, number>();
	return {
		calls,
		json: async (method, endpoint) => {
			const key = `${method} ${endpoint}`;
			calls.push(key);
			const count = (counts.get(key) ?? 0) + 1;
			counts.set(key, count);
			const route = routes[key];
			return route === undefined ? { status: 404, error: 'Not Found' } : typeof route === 'function' ? route(count) : route;
		},
		text: async endpoint => logs[endpoint],
	};
}

function fakeHost(github: ClaudeNoModelGitHub, options: { run?: (command: string, args: readonly string[]) => ClaudeNoModelProcessResult; files?: Record<string, string> } = {}): ClaudeNoModelHost & { readonly notes: { sessionId: string; text: string }[]; readonly ran: string[]; clock: number } {
	const notes: { sessionId: string; text: string }[] = [];
	const ran: string[] = [];
	const host = {
		github,
		notes,
		ran,
		clock: 0,
		run: async (command: string, args: readonly string[]) => {
			ran.push([command, ...args].join(' '));
			return options.run?.(command, args) ?? { code: 0, stdout: '', stderr: '' };
		},
		read: async (path: string) => options.files?.[path],
		writeLog: async (name: string) => `/logs/${name}.log`,
		sleep: async (ms: number) => { host.clock += ms; },
		now: () => host.clock,
		notify: (sessionId: string, text: string) => { notes.push({ sessionId, text }); },
	};
	return host;
}

const NEVER_ABORTED = new AbortController().signal;

/** Lets the background watch of ciWait finish. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await new Promise(resolve => setImmediate(resolve));
	}
}

const PR_OPEN = { status: 200, body: { state: 'open', draft: false, mergeable_state: 'clean', base: { ref: 'main' }, head: { ref: 'fix', sha: 'abc', repo: { full_name: 'o/r' } } } };
const PROTECTED = { status: 200, body: { required_status_checks: { strict: true, contexts: ['heavy'] } } };
const check = (name: string, status: string, conclusion: string | null, id = 1) => ({ id, name, status, conclusion, html_url: `https://github.com/o/r/actions/runs/9/job/${id}` });
const checks = (...runs: unknown[]) => ({ status: 200, body: { check_runs: runs } });
const NO_STATUSES = { status: 200, body: { statuses: [] } };

suite('Claude no-model tools (issue 844)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('ci_wait', () => {
		test('answers at once and reports a green pull request when checks end', async () => {
			const github = fakeGitHub({
				'GET repos/o/r/pulls/5': PR_OPEN,
				'GET repos/o/r/commits/abc/check-runs?per_page=100': count => count === 1 ? checks(check('heavy', 'in_progress', null)) : checks(check('heavy', 'completed', 'success')),
				'GET repos/o/r/commits/abc/status': NO_STATUSES,
			});
			const host = fakeHost(github);
			const first = new ClaudeNoModelTools(host).ciWait('s1', { repo: 'o/r', pr: 5 }, NEVER_ABORTED);
			await settle();
			assert.deepStrictEqual({ immediate: first.text.startsWith('[ci_wait] WATCHING'), notes: host.notes.map(n => [n.sessionId, n.text.split('\n')[0]]), slept: host.clock }, {
				immediate: true,
				notes: [['s1', '[ci_wait] PASS · o/r PR #5']],
				slept: 30_000,
			});
		});

		test('reports the failing jobs and the last 40 log lines of a failed run', async () => {
			const log = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
			const github = fakeGitHub({
				'GET repos/o/r/actions/runs/9': { status: 200, body: { status: 'completed', conclusion: 'failure', html_url: 'https://github.com/o/r/actions/runs/9' } },
				'GET repos/o/r/actions/runs/9/jobs?per_page=100': { status: 200, body: { jobs: [{ id: 77, name: 'Windows', conclusion: 'failure' }, { id: 78, name: 'macOS', conclusion: 'success' }] } },
			}, { 'repos/o/r/actions/jobs/77/logs': log });
			const host = fakeHost(github);
			new ClaudeNoModelTools(host).ciWait('s1', { repo: 'o/r', run: 9 }, NEVER_ABORTED);
			await settle();
			const lines = host.notes[0].text.split('\n');
			assert.deepStrictEqual({ head: lines.slice(0, 4), logLines: lines.length - 4, first: lines[4], last: lines.at(-1) }, {
				head: ['[ci_wait] FAIL · o/r run 9', 'Run: https://github.com/o/r/actions/runs/9', 'Failing jobs: Windows', 'Last 40 log lines:'],
				logLines: 40,
				first: 'line 21',
				last: 'line 60',
			});
		});

		test('says a pull request never started, with the reasons', async () => {
			const github = fakeGitHub({
				'GET repos/o/r/pulls/5': PR_OPEN,
				'GET repos/o/r/commits/abc/check-runs?per_page=100': checks(),
				'GET repos/o/r/commits/abc/status': NO_STATUSES,
				'GET repos/o/r/actions/runners?per_page=100': { status: 200, body: { runners: [{ name: 'mac-1', status: 'offline' }] } },
				'GET repos/o/r/actions/workflows?per_page=100': { status: 200, body: { workflows: [{ id: 1 }] } },
			});
			const host = fakeHost(github);
			new ClaudeNoModelTools(host).ciWait('s1', { repo: 'o/r', pr: 5, grace_minutes: 1 }, NEVER_ABORTED);
			await settle();
			assert.deepStrictEqual({ head: host.notes[0].text.split('\n')[0], offline: host.notes[0].text.includes('Offline runners: mac-1'), waited: host.clock }, {
				head: '[ci_wait] NEVER STARTED · o/r PR #5',
				offline: true,
				waited: 60_000,
			});
		});

		test('refuses a bad repo and an argument mix without watching', () => {
			const tools = new ClaudeNoModelTools(fakeHost(fakeGitHub({})));
			assert.deepStrictEqual([
				tools.ciWait('s', { repo: 'nope', pr: 1 }, NEVER_ABORTED).isError,
				tools.ciWait('s', { repo: 'o/r' }, NEVER_ABORTED).isError,
				tools.ciWait('s', { repo: 'o/r', pr: 1, run: 2 }, NEVER_ABORTED).isError,
			], [true, true, true]);
		});

		test('sends nothing when the chat stopped', async () => {
			const controller = new AbortController();
			const github = fakeGitHub({ 'GET repos/o/r/actions/runs/9': { status: 200, body: { status: 'completed', conclusion: 'success' } } });
			const host = fakeHost(github);
			new ClaudeNoModelTools(host).ciWait('s1', { repo: 'o/r', run: 9 }, controller.signal);
			controller.abort();
			await settle();
			assert.deepStrictEqual(host.notes, []);
		});
	});

	suite('verify', () => {
		const base = (stdout: string) => (command: string, args: readonly string[]): ClaudeNoModelProcessResult => command === 'git' ? { code: 0, stdout, stderr: '' } : { code: 0, stdout: '', stderr: '' };

		test('runs nothing for a docs-only change', async () => {
			const host = fakeHost(fakeGitHub({}), { run: base('README.md\ndocs/a.md\n') });
			const result = await new ClaudeNoModelTools(host).verify({ cwd: '/w' });
			assert.deepStrictEqual({ text: result.text, ran: host.ran }, { text: '[verify] PASS · nothing to run · docs-only change (2 files)', ran: ['git diff --name-only origin/main...HEAD'] });
		});

		test('runs the node tests the tier script picks and reports counts', async () => {
			const host = fakeHost(fakeGitHub({}), {
				files: { '/w/build/klawly/test-tier.ts': 'x' },
				run: (command, args) => {
					if (command === 'git') { return { code: 0, stdout: 'src/a.ts\n', stderr: '' }; }
					if (command === 'node') { return { code: 0, stdout: JSON.stringify({ tier: 1, nodeTests: ['src/a.test.ts'] }), stderr: '' }; }
					return { code: 0, stdout: '  12 passing (30ms)\n', stderr: '' };
				},
			});
			const result = await new ClaudeNoModelTools(host).verify({ cwd: '/w' });
			assert.deepStrictEqual({ text: result.text.split('\n').slice(0, 3), error: result.isError, ran: host.ran.slice(1) }, {
				text: ['[verify] PASS · tier 1 from the repo\'s build/klawly/test-tier.ts', 'ok   a.test.ts · 12 passed · 0s', 'Full log: /logs/verify.log'],
				error: false,
				ran: ['node build/klawly/test-tier.ts --base origin/main --json', 'npm run test-node -- --run src/a.test.ts'],
			});
		});

		test('falls back to the npm scripts and names failing tests', async () => {
			const host = fakeHost(fakeGitHub({}), {
				files: { '/w/package.json': JSON.stringify({ scripts: { lint: 'x', test: 'y' } }) },
				run: (command, args) => command === 'git' ? { code: 0, stdout: 'src/a.ts\n', stderr: '' } : args[0] === 'run' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '  3 passing\n  1 failing\n  1) suite works\n    at src/a.test.ts:12:5\n', stderr: '' },
			});
			const result = await new ClaudeNoModelTools(host).verify({ cwd: '/w', base: 'origin/next' });
			assert.deepStrictEqual({ error: result.isError, lines: result.text.split('\n').slice(0, 7) }, {
				error: true,
				lines: ['[verify] FAIL · default tier: lint, test npm scripts', 'ok   lint · 0s', 'FAIL test · 3 passed, 1 failed · 0s', '--- test failed (exit 1) ---', 'Failing tests:', '  1) suite works', 'Where: src/a.test.ts:12:5'],
			});
		});

		test('refuses a base that is not a git ref', async () => {
			const result = await new ClaudeNoModelTools(fakeHost(fakeGitHub({}))).verify({ cwd: '/w', base: '--upload-pack=x' });
			assert.strictEqual(result.isError, true);
		});
	});

	suite('merge_gate', () => {
		const routes = (overrides: Record<string, Route> = {}): Record<string, Route> => ({
			'GET repos/o/r/pulls/5': PR_OPEN,
			'GET repos/o/r/branches/main/protection': PROTECTED,
			'GET repos/o/r/commits/abc/check-runs?per_page=100': checks(check('heavy', 'completed', 'success')),
			'GET repos/o/r/commits/abc/status': NO_STATUSES,
			'PUT repos/o/r/pulls/5/merge': { status: 200, body: { merged: true } },
			'DELETE repos/o/r/git/refs/heads/fix': { status: 204 },
			...overrides,
		});
		const first = async (overrides: Record<string, Route>, dryRun = false) => {
			const github = fakeGitHub(routes(overrides));
			const result = await new ClaudeNoModelTools(fakeHost(github)).mergeGate({ repo: 'o/r', pr: 5, dry_run: dryRun });
			return { text: result.text.split(' · ')[0] + ' · ' + (result.text.split(' · ')[1] ?? '').slice(0, 60), error: !!result.isError, calls: github.calls.filter(c => !c.startsWith('GET')) };
		};

		test('squash-merges a green pull request and deletes its branch', async () => {
			const github = fakeGitHub(routes());
			const result = await new ClaudeNoModelTools(fakeHost(github)).mergeGate({ repo: 'o/r', pr: 5 });
			assert.deepStrictEqual({ text: result.text, calls: github.calls.filter(c => !c.startsWith('GET')) }, {
				text: '[merge_gate] MERGED · PR #5 into main (squash). Deleted fix.',
				calls: ['PUT repos/o/r/pulls/5/merge', 'DELETE repos/o/r/git/refs/heads/fix'],
			});
		});

		test('a dry run only reports', async () => {
			const github = fakeGitHub(routes());
			const result = await new ClaudeNoModelTools(fakeHost(github)).mergeGate({ repo: 'o/r', pr: 5, dry_run: true });
			assert.deepStrictEqual({ text: result.text, calls: github.calls.filter(c => !c.startsWith('GET')) }, {
				text: '[merge_gate] OK · all 1 required checks are green. Dry run: would squash-merge PR #5 into main and delete fix.',
				calls: [],
			});
		});

		test('refuses a base with no protection', async () => {
			const result = await first({ 'GET repos/o/r/branches/main/protection': { status: 404, error: 'Not Found' } });
			assert.deepStrictEqual({ head: result.text.slice(0, 40), error: result.error, calls: result.calls }, { head: '[merge_gate] REFUSED · main has no branc', error: true, calls: [] });
		});

		test('refuses a red required check', async () => {
			const result = await first({ 'GET repos/o/r/commits/abc/check-runs?per_page=100': checks(check('heavy', 'completed', 'failure')) });
			assert.deepStrictEqual({ error: result.error, calls: result.calls, text: result.text.includes('REFUSED') }, { error: true, calls: [], text: true });
		});

		test('refuses a pending required check and points to ci_wait', async () => {
			const github = fakeGitHub(routes({ 'GET repos/o/r/commits/abc/check-runs?per_page=100': checks(check('heavy', 'in_progress', null)) }));
			const result = await new ClaudeNoModelTools(fakeHost(github)).mergeGate({ repo: 'o/r', pr: 5 });
			assert.deepStrictEqual({ error: result.isError, pending: result.text.includes('pending: heavy'), wait: result.text.includes('ci_wait'), merged: github.calls.some(c => c.startsWith('PUT')) }, { error: true, pending: true, wait: true, merged: false });
		});

		test('refuses a missing required check', async () => {
			const result = await first({ 'GET repos/o/r/commits/abc/check-runs?per_page=100': checks() });
			assert.deepStrictEqual({ error: result.error, calls: result.calls }, { error: true, calls: [] });
		});

		test('updates a branch that is behind a strict base, then asks to wait again', async () => {
			const github = fakeGitHub(routes({
				'GET repos/o/r/pulls/5': { status: 200, body: { ...PR_OPEN.body, mergeable_state: 'behind' } },
				'PUT repos/o/r/pulls/5/update-branch': { status: 202, body: {} },
			}));
			const result = await new ClaudeNoModelTools(fakeHost(github)).mergeGate({ repo: 'o/r', pr: 5 });
			assert.deepStrictEqual({ head: result.text.slice(0, 21), calls: github.calls.filter(c => !c.startsWith('GET')) }, { head: '[merge_gate] UPDATED ', calls: ['PUT repos/o/r/pulls/5/update-branch'] });
		});

		test('refuses a draft and a conflict', async () => {
			const draft = await first({ 'GET repos/o/r/pulls/5': { status: 200, body: { ...PR_OPEN.body, draft: true } } });
			const dirty = await first({ 'GET repos/o/r/pulls/5': { status: 200, body: { ...PR_OPEN.body, mergeable_state: 'dirty' } } });
			assert.deepStrictEqual([draft.error, dirty.error, draft.calls, dirty.calls], [true, true, [], []]);
		});
	});

	suite('helpers', () => {
		test('reads counts, failures and the last lines of a log', () => {
			assert.deepStrictEqual({
				mocha: claudeTestCounts('  5 passing\n  2 failing'),
				jest: claudeTestCounts('Tests:       1 failed, 4 passed, 5 total'),
				none: claudeTestCounts('nothing here'),
				failures: claudeTestFailures('  1) a thing\nat src/x.ts:3:1\nat src/x.ts:3:1'),
				last: claudeLastLines('a\n\nb\nc\n', 2),
			}, {
				mocha: { pass: 5, fail: 2 },
				jest: { pass: 4, fail: 1 },
				none: undefined,
				failures: { names: ['1) a thing'], locations: ['src/x.ts:3:1'] },
				last: 'b\nc',
			});
		});

		test('the Merge Without Asking setting is on only for true', () => {
			assert.deepStrictEqual({ key: CLAUDE_MERGE_WITHOUT_ASKING_SETTING, values: [true, false, 'true', undefined, 1].map(readClaudeMergeWithoutAsking) }, { key: 'klawly.delegation.mergeWithoutAsking', values: [true, false, false, false, false] });
		});

		test('the tool ids sit under the klawly MCP server', () => {
			assert.deepStrictEqual([CLAUDE_CI_WAIT_TOOL_ID, CLAUDE_VERIFY_TOOL_ID, CLAUDE_MERGE_GATE_TOOL_ID].map(id => /^mcp__[\w-]+__(ci_wait|verify|merge_gate)$/.test(id)), [true, true, true]);
		});
	});
});
