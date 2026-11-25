/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_AUTOMATION_CLI_USAGE, parseClaudeAutomationCliArgs } from '../../common/claudeAutomationCli.js';
import { runClaudeAutomationCli } from '../../node/claudeAutomationCli.js';
import { ClaudeQuery, ClaudeQueryFactory, ClaudeQueryStart } from '../../node/claudeQuery.js';

suite('Klawly automations CLI', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the arguments are checked: command, flags, scope and the folder a workspace needs', () => {
		const usage = CLAUDE_AUTOMATION_CLI_USAGE;
		assert.deepStrictEqual([
			parseClaudeAutomationCliArgs(['automations', 'run', '--scope', 'user', '--id', 'digest']),
			parseClaudeAutomationCliArgs(['automations', 'run', '--scope', 'workspace', '--id', 'digest', '--folder', 'C:\work\app']),
			parseClaudeAutomationCliArgs(['automations', 'run', '--scope', 'workspace', '--id', 'digest']),
			parseClaudeAutomationCliArgs(['automations', 'run', '--scope', 'team', '--id', 'digest']),
			parseClaudeAutomationCliArgs(['automations', 'run', '--scope', 'user']),
			parseClaudeAutomationCliArgs(['automations', 'run', '--scope', 'user', '--id', 'a', '--id', 'b']),
			parseClaudeAutomationCliArgs(['automations', 'run', '--scope', 'user', '--id', 'a', '--bogus', 'x']),
			parseClaudeAutomationCliArgs(['automations', 'list']),
		], [
			{ scope: 'user', id: 'digest', folder: undefined },
			{ scope: 'workspace', id: 'digest', folder: 'C:\work\app' },
			usage, usage, usage, usage, usage, usage,
		]);
	});

	suite('run', () => {
		let home: string;
		setup(() => {
			home = mkdtempSync(join(tmpdir(), 'klawly-cli-'));
			mkdirSync(join(home, '.klawly'));
		});
		teardown(() => rmSync(home, { recursive: true, force: true }));

		function writeFile(automations: object[]): void {
			writeFileSync(join(home, '.klawly', 'automations.json'), JSON.stringify({ automations }));
		}
		const digest = { id: 'digest', name: 'Digest', prompt: 'Summarize.', trigger: { type: 'schedule', cron: '0 9 * * *' }, permissionMode: 'ask', runWhenClosed: true };

		async function run(messages: unknown[], args = ['automations', 'run', '--scope', 'user', '--id', 'digest']) {
			const starts: ClaudeQueryStart[] = [];
			let closed = false;
			const queryFactory: ClaudeQueryFactory = async start => {
				starts.push(start);
				return {
					async *[Symbol.asyncIterator]() { yield* messages; },
					close: () => { closed = true; },
				} as unknown as ClaudeQuery;
			};
			const out: string[] = [];
			const err: string[] = [];
			const code = await runClaudeAutomationCli(args, { env: {}, home, queryFactory, write: text => out.push(text), writeError: text => err.push(text) });
			return { code, out, err, starts, closed };
		}

		test('prints the answer, reads only and closes the query', async () => {
			writeFile([digest]);
			const result = await run([{ type: 'result', subtype: 'success', result: 'All quiet.' }]);
			const options = result.starts[0].options;
			const canUse = await options.canUseTool?.('Bash', {}, {} as never);
			assert.deepStrictEqual([result.code, result.out, result.err, result.closed, options.allowedTools, options.permissionMode, canUse?.behavior], [0, ['All quiet.'], [], true, ['Read', 'Grep', 'Glob'], 'default', 'deny']);
		});

		test('a failed run exits 1 and says why', async () => {
			writeFile([digest]);
			const result = await run([{ type: 'result', subtype: 'error_max_turns', errors: ['too many turns'] }]);
			assert.deepStrictEqual([result.code, result.out, result.err], [1, [], ['"Digest" failed: too many turns']]);
		});

		test('it refuses what is not opted in, in agent mode, off or missing, without starting Claude', async () => {
			const cases = [
				{ ...digest, runWhenClosed: undefined },
				{ ...digest, permissionMode: 'agent' },
				{ ...digest, enabled: false },
				{ ...digest, trigger: { type: 'githubPush', repo: 'a/b' } },
			];
			const codes: number[] = [];
			let started = 0;
			for (const automation of cases) {
				writeFile([automation]);
				const result = await run([]);
				codes.push(result.code);
				started += result.starts.length;
			}
			writeFile([]);
			codes.push((await run([])).code);
			assert.deepStrictEqual([codes, started], [[1, 1, 1, 1, 1], 0]);
		});

		test('wrong arguments exit 2', async () => {
			assert.strictEqual((await run([], ['automations'])).code, 2);
		});
	});
});
