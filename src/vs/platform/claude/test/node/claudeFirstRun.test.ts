/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { ClaudeConversation, claudeClassifyError } from '../../common/claudeConversation.js';
import { ClaudeEvent } from '../../common/claudeRuntime.js';
import { checkClaudeCli, checkClaudeSignIn } from '../../node/claudeCli.js';
import { checkGitFolder } from '../../node/claudeGit.js';
import { ClaudeRuntimeService } from '../../node/claudeRuntimeService.js';

/**
 * A `claude` stand-in for the first-run and edge states. `FAKE_VERSION`, `FAKE_AUTH` (`in`, `out`, `hang`, `junk`)
 * and `FAKE_TURN` (`limit`, `network`, `crash`) choose what it does; it never calls a model.
 */
const FAKE_CLI = `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log((process.env.FAKE_VERSION || '2.1.0') + ' (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') {
	if (process.env.FAKE_AUTH === 'hang') { setTimeout(() => {}, 60000); return; }
	if (process.env.FAKE_AUTH === 'junk') { console.log('not json'); process.exit(0); }
	const loggedIn = process.env.FAKE_AUTH !== 'out';
	console.log(JSON.stringify({ loggedIn }));
	process.exit(loggedIn ? 0 : 1);
}
const id = args[args.indexOf('--session-id') + 1] || args[args.indexOf('--resume') + 1];
const out = o => console.log(JSON.stringify({ session_id: id, ...o }));
out({ type: 'system', subtype: 'init', model: 'fake-model' });
require('readline').createInterface({ input: process.stdin }).on('line', () => {
	if (process.env.FAKE_TURN === 'limit') {
		out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000 } });
		out({ type: 'result', is_error: true, result: 'You\\'ve hit your usage limit' });
	} else if (process.env.FAKE_TURN === 'network') {
		out({ type: 'result', is_error: true, result: 'API Error: Unable to connect to API (ENOTFOUND api.anthropic.com)' });
	} else if (process.env.FAKE_TURN === 'crash') {
		console.error('segfault');
		process.exit(1);
	}
});
`;

suite('Claude first run and edge states', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let dir: string;
	let cwd: string;

	setup(async () => {
		dir = await realpath(await mkdtemp(join(tmpdir(), 'claude-p3-')));
		cwd = join(dir, 'work');
		await mkdir(cwd);
		await writeFile(join(dir, 'claude'), FAKE_CLI);
		await chmod(join(dir, 'claude'), 0o755);
	});

	teardown(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
		return { ...process.env, PATH: dir, KLAWLY_CLAUDE_BIN: '', ...extra };
	}

	suite('CLI and sign-in', () => {
		test('no command on PATH is missing', async () => {
			const status = await checkClaudeCli(env({ PATH: join(dir, 'empty') }));
			assert.deepStrictEqual([status.found, status.reason], [false, 'missing']);
		});

		test('version 1 is too old and names the version', async () => {
			const status = await checkClaudeCli(env({ FAKE_VERSION: '1.0.88' }));
			assert.deepStrictEqual([status.found, status.reason, status.version], [false, 'tooOld', '1.0.88']);
			assert.ok(status.error?.includes('1.0.88'));
		});

		test('a command that will not run is runFailed', async () => {
			await writeFile(join(dir, 'claude'), '#!/bin/sh\nexit 3\n');
			const status = await checkClaudeCli(env());
			assert.deepStrictEqual([status.found, status.reason], [false, 'runFailed']);
		});

		test('signed in, signed out, and no answer', async () => {
			assert.strictEqual((await checkClaudeSignIn(env({ FAKE_AUTH: 'in' }))).state, 'signedIn');
			assert.strictEqual((await checkClaudeSignIn(env({ FAKE_AUTH: 'out' }))).state, 'signedOut');
			assert.strictEqual((await checkClaudeSignIn(env({ FAKE_AUTH: 'junk' }))).state, 'unknown');
			const hung = await checkClaudeSignIn(env({ FAKE_AUTH: 'hang' }), 300);
			assert.deepStrictEqual([hung.state, hung.error], ['unknown', 'The check timed out after 0.3 s.']);
		});
	});

	suite('turn that ends badly', () => {
		async function runTurn(turn: string): Promise<ClaudeConversation> {
			const service = store.add(new ClaudeRuntimeService(new NullLogService(), env({ FAKE_TURN: turn }), dir));
			const conversation = store.add(new ClaudeConversation());
			const ended = new Promise<void>(resolve => store.add(service.onDidEvent(event => {
				conversation.handle(event as ClaudeEvent);
				if (event.type === 'ended' || (event.type === 'result' && event.isError)) {
					resolve();
				}
			})));
			conversation.addUser('go');
			const { sessionId } = await service.send({ cwd, prompt: 'go' });
			conversation.sessionId = sessionId;
			await ended;
			await service.close(sessionId);
			return conversation;
		}

		test('limit event gives the reset time', async () => {
			const conversation = await runTurn('limit');
			assert.deepStrictEqual([conversation.edge, conversation.notice, conversation.working], [{ kind: 'limited', resetsAt: 1900000000000 }, undefined, false]);
		});

		test('network error is offline', async () => {
			const conversation = await runTurn('network');
			assert.deepStrictEqual([conversation.edge, conversation.notice], [{ kind: 'offline' }, undefined]);
		});

		test('non-zero exit is a crash', async () => {
			const conversation = await runTurn('crash');
			assert.deepStrictEqual([conversation.edge?.kind, conversation.edge?.kind === 'crashed' && conversation.edge.exitCode, conversation.notice], ['crashed', 1, undefined]);
		});

		test('the next prompt clears the state', async () => {
			const conversation = await runTurn('network');
			conversation.addUser('again');
			assert.strictEqual(conversation.edge, undefined);
		});

		test('classifies the CLI wording', () => {
			assert.deepStrictEqual(claudeClassifyError('Claude AI usage limit reached|1900000000'), { kind: 'limited', resetsAt: 1900000000000 });
			assert.deepStrictEqual(claudeClassifyError('fetch failed'), { kind: 'offline' });
			assert.strictEqual(claudeClassifyError('Invalid API key'), undefined);
		});
	});

	suite('git', () => {
		test('a plain folder is not a repo, and a refusing git is unsafe', async () => {
			assert.strictEqual((await checkGitFolder(cwd, { ...process.env, GIT_CEILING_DIRECTORIES: dir })).state, 'notRepo');
			await mkdir(join(dir, 'bin'));
			await writeFile(join(dir, 'bin', 'git'), '#!/bin/sh\necho "fatal: detected dubious ownership in repository" >&2\nexit 128\n');
			await chmod(join(dir, 'bin', 'git'), 0o755);
			assert.strictEqual((await checkGitFolder(cwd, { ...process.env, PATH: join(dir, 'bin') })).state, 'unsafe');
		});
	});
});
