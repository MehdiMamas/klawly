/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFileSync } from 'child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { Emitter } from '../../../../base/common/event.js';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { ClaudeAgents, IClaudeAgentsRuntime, claudeCompare } from '../../common/claudeAgents.js';
import { ClaudeEvent, IClaudeWorktreeDiff } from '../../common/claudeRuntime.js';
import { claudeWorktreeName, formatBytes, isCleanupDue, parseNumstat, parseWorktreeList, sameWorktreeName, worktreeKeepReason, worktreeSlug } from '../../common/claudeWorktrees.js';
import { ClaudeRuntimeService } from '../../node/claudeRuntimeService.js';

/** A fake CLI that writes its arguments to `args.json` next to it, then waits for input like the real one. */
const ARGS_CLI = `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
require('fs').writeFileSync(__dirname + '/args.json', JSON.stringify(args));
const id = args[args.indexOf('--session-id') + 1] || args[args.indexOf('--resume') + 1];
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: id, model: 'fake-model' }));
require('readline').createInterface({ input: process.stdin }).on('line', () => { });
`;

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

suite('Claude agents', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	suite('list and status lines', () => {
		function setup() {
			const events = store.add(new Emitter<ClaudeEvent>());
			const answered: [string, string, boolean][] = [];
			let nextId = 0;
			const runtime = {
				onDidEvent: events.event,
				send: async () => ({ sessionId: `s${++nextId}` }),
				stop: async () => { },
				answerPermission: async (sessionId: string, requestId: string, allow: boolean) => { answered.push([sessionId, requestId, allow]); },
				addAllowRule: async () => { },
				worktreeDiff: async (): Promise<IClaudeWorktreeDiff> => ({ added: 3, removed: 1, files: 1, firstLine: 'x' }),
				applyWorktree: async () => { },
			} as unknown as IClaudeAgentsRuntime;
			const agents = store.add(new ClaudeAgents(runtime, () => '/work'));
			return { agents, events, answered };
		}

		test('agents group into NEEDS YOU, RUNNING and DONE with a status line each', async () => {
			const { agents, events } = setup();
			const waiting = agents.selected;
			await agents.send(waiting, { text: 'install zod' }, '/work');
			events.fire({ type: 'permission', sessionId: 's1', requestId: 'r1', toolName: 'Bash', input: { command: 'npm install' } });
			const running = agents.create();
			await agents.send(running, { text: 'run tests' }, '/work');
			events.fire({ type: 'toolUse', sessionId: 's2', toolUseId: 't1', name: 'Bash', input: { command: 'npm test' } });
			const done = agents.create();
			await agents.send(done, { text: 'say hi' }, '/work');
			events.fire({ type: 'result', sessionId: 's3', isError: false, text: 'hi' });
			events.fire({ type: 'ended', sessionId: 's3', exitCode: 0 });

			const now = Date.now();
			const summary = agents.sections().map(s => [s.status, s.rows.map(r => r.kind === 'agent' ? r.agent.title : '')]);
			assert.deepStrictEqual(summary, [['needsYou', ['install zod']], ['running', ['run tests']], ['done', ['say hi']]]);
			assert.ok(waiting.statusLine(now).startsWith('Permission · '));
			assert.ok(running.statusLine(now).startsWith('Bash · ') || running.statusLine(now).includes('0:0'));
			assert.ok(done.statusLine(now).startsWith('Done · '));
			assert.strictEqual(agents.count, 3);
			assert.deepStrictEqual(agents.sections('zod').map(s => s.rows.length), [1]);
		});

		test('a permission answered from Needs you clears the agent card too', async () => {
			const { agents, events, answered } = setup();
			const agent = agents.selected;
			await agents.send(agent, { text: 'go' }, '/work');
			events.fire({ type: 'permission', sessionId: 's1', requestId: 'r1', toolName: 'Bash', input: { command: 'npm install zod@4' } });
			const [item] = agents.needsYou();
			assert.strictEqual(item.kind, 'permission');
			if (item.kind !== 'permission') {
				return;
			}
			await agents.answerPermission(item.agent, item.card, true);
			assert.deepStrictEqual([answered, agent.pending, agents.needsYou().length, agent.status], [[['s1', 'r1', true]], undefined, 0, 'running']);
		});

		test('a usage limit becomes one row for all paused agents', async () => {
			const { agents, events } = setup();
			await agents.send(agents.selected, { text: 'go' }, '/work');
			events.fire({ type: 'rateLimit', sessionId: 's1', status: 'rejected', resetsAt: 1900000000 });
			events.fire({ type: 'result', sessionId: 's1', isError: true, text: 'You\'ve hit your usage limit' });
			const items = agents.needsYou();
			assert.deepStrictEqual(items.map(i => i.kind === 'limit' && i.agents.length), [1]);
		});

		test('parallel attempts get worktree names, one row, and a comparison', async () => {
			const { agents, events } = setup();
			const group = await agents.startMultitask('Fix the flaky test!', 3, { cwd: '/work' });
			assert.deepStrictEqual(group.attempts.map(a => a.worktree), ['try/fix-the-flaky-test-1', 'try/fix-the-flaky-test-2', 'try/fix-the-flaky-test-3']);
			events.fire({ type: 'result', sessionId: 's1', isError: false, text: 'ok' });
			events.fire({ type: 'ended', sessionId: 's1', exitCode: 0 });
			events.fire({ type: 'error', sessionId: 's2', message: 'boom\nmore' });
			events.fire({ type: 'ended', sessionId: 's2', exitCode: 1 });
			await new Promise(resolve => setTimeout(resolve, 0));
			assert.deepStrictEqual(agents.sections().map(s => [s.status, s.rows.length]), [['running', 1]]);
			assert.deepStrictEqual(group.attempts.map(a => a.failure?.message), [undefined, 'boom', undefined]);
			events.fire({ type: 'result', sessionId: 's3', isError: false, text: 'ok' });
			events.fire({ type: 'ended', sessionId: 's3', exitCode: 0 });
			await new Promise(resolve => setTimeout(resolve, 0));
			assert.deepStrictEqual(claudeCompare(group).passed.length, 2);
		});
	});

	suite('worktree helpers', () => {
		test('porcelain list, names, numstat, slug and sizes', () => {
			const entries = parseWorktreeList('worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/.claude/worktrees/fix-a\nHEAD def\nbranch refs/heads/worktree-fix-a\n');
			assert.deepStrictEqual(entries.map(e => [e.path, e.branch]), [['/r', 'main'], ['/r/.claude/worktrees/fix-a', 'worktree-fix-a']]);
			assert.deepStrictEqual([claudeWorktreeName('/r'), claudeWorktreeName('/r/.claude/worktrees/fix-a')], [undefined, 'fix-a']);
			assert.ok(sameWorktreeName('try/a-1', 'try+a-1'));
			assert.deepStrictEqual(parseNumstat('3\t1\ta.ts\n-\t-\tb.png\n', '+++ b/a.ts\n+hello\n'), { added: 3, removed: 1, files: 2, firstLine: 'hello' });
			assert.deepStrictEqual([worktreeSlug('Fix: the Thing!!'), formatBytes(1_200_000_000), formatBytes(340_000_000)], ['fix-the-thing', '1.2 GB', '340 MB']);
		});

		test('cleanup keeps dirty, running and young worktrees', () => {
			const now = 100 * 86400000;
			const old = now - 8 * 86400000;
			assert.deepStrictEqual([
				isCleanupDue({ dirty: false, running: false, modified: old }, 7, now),
				isCleanupDue({ dirty: true, running: false, modified: old }, 7, now),
				isCleanupDue({ dirty: false, running: true, modified: old }, 7, now),
				isCleanupDue({ dirty: false, running: false, modified: now - 86400000 }, 7, now),
				isCleanupDue({ dirty: false, running: false, modified: old }, 0, now),
				worktreeKeepReason({ dirty: true, running: false }),
				worktreeKeepReason({ dirty: true, running: true }),
			], [true, false, false, false, false, 'dirty', 'running']);
		});
	});

	suite('runtime with a real repository', function () {
		this.timeout(30000);
		let dir: string;
		let repo: string;
		let service: ClaudeRuntimeService;

		setup(async () => {
			dir = await realpath(await mkdtemp(join(tmpdir(), 'claude-p4-')));
			repo = join(dir, 'repo');
			await mkdir(repo);
			git(repo, 'init', '-q', '-b', 'main');
			await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
			git(repo, 'add', '.');
			git(repo, 'commit', '-q', '-m', 'init');
			await writeFile(join(dir, 'claude'), ARGS_CLI);
			await chmod(join(dir, 'claude'), 0o755);
			service = store.add(new ClaudeRuntimeService(new NullLogService(), { ...process.env, PATH: `${dir}:${process.env.PATH}`, KLAWLY_CLAUDE_BIN: '' }, dir));
		});

		teardown(async () => {
			await rm(dir, { recursive: true, force: true });
		});

		async function addWorktree(name: string, change: (path: string) => Promise<void>): Promise<string> {
			const path = join(repo, '.claude', 'worktrees', name);
			git(repo, 'worktree', 'add', '-q', '-b', `worktree-${name}`, path);
			await change(path);
			return path;
		}

		test('--worktree is passed for a new session only', async () => {
			const { sessionId } = await service.send({ cwd: repo, prompt: 'go', worktree: 'try/x-1' });
			await new Promise(resolve => setTimeout(resolve, 300));
			const args: string[] = JSON.parse(await readFile(join(dir, 'args.json'), 'utf8'));
			assert.deepStrictEqual([args[args.indexOf('--worktree') + 1], args.includes('--session-id')], ['try/x-1', true]);
			await service.close(sessionId);
		});

		test('lists size and age, and cleanup removes only old clean worktrees', async () => {
			const clean = await addWorktree('old-clean', async () => { });
			const dirty = await addWorktree('old-dirty', async path => { await writeFile(join(path, 'a.txt'), 'changed\n'); });
			await addWorktree('young', async () => { });
			const longAgo = new Date(Date.now() - 10 * 86400000);
			await utimes(clean, longAgo, longAgo);
			await utimes(dirty, longAgo, longAgo);

			const listed = await service.listWorktrees(repo);
			assert.deepStrictEqual(listed.map(w => [w.name, w.dirty, w.sizeBytes > 0]).sort(), [['old-clean', false, true], ['old-dirty', true, true], ['young', false, true]]);

			const result = await service.cleanupWorktrees(repo, 7);
			assert.deepStrictEqual([result.removed, [...result.kept].sort()], [['old-clean'], ['old-dirty', 'young']]);
			assert.ok(!git(repo, 'worktree', 'list').includes('old-clean'));
			assert.ok(!git(repo, 'branch', '--list', 'worktree-old-clean').trim(), 'the merged branch is deleted with it');
			assert.deepStrictEqual((await service.cleanupWorktrees(repo, 0)).removed, []);
		});

		test('apply puts the diff on the folder; a conflict says so and changes nothing', async () => {
			await addWorktree('good', async path => { await writeFile(join(path, 'a.txt'), 'one\ntwo\nthree\nfour\n'); await writeFile(join(path, 'new.txt'), 'hi\n'); });
			assert.deepStrictEqual(await service.worktreeDiff(repo, 'good'), { added: 2, removed: 0, files: 2, firstLine: 'four' });
			await service.applyWorktree(repo, 'good');
			assert.deepStrictEqual([await readFile(join(repo, 'a.txt'), 'utf8'), await readFile(join(repo, 'new.txt'), 'utf8')], ['one\ntwo\nthree\nfour\n', 'hi\n']);
			git(repo, 'checkout', '-q', '--', 'a.txt');
			await rm(join(repo, 'new.txt'));

			await addWorktree('bad', async path => { await writeFile(join(path, 'a.txt'), 'ONE\ntwo\nthree\n'); });
			await writeFile(join(repo, 'a.txt'), 'uno\ntwo\nthree\n');
			git(repo, 'commit', '-q', '-am', 'main changes line one');
			await assert.rejects(() => service.applyWorktree(repo, 'bad'));
			assert.strictEqual(await readFile(join(repo, 'a.txt'), 'utf8'), 'uno\ntwo\nthree\n');
			assert.strictEqual(git(repo, 'status', '--porcelain', '--untracked-files=no').trim(), '');
		});
	});
});
