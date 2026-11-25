/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { matchesClaudeCopySegment, readClaudeWorktreeSetup, readClaudeWorktreesMax } from '../../common/claudeWorktreeSetup.js';
import { runClaudeWorktreeSetup } from '../../node/claudeWorktreeSetupRunner.js';

suite('Claude worktree setup (issue 511)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;

	setup(() => { root = mkdtempSync(join(tmpdir(), 'klawly-worktree-setup-')); });
	teardown(() => rmSync(root, { recursive: true, force: true }));

	test('the setup file: copy paths stay inside the repository, setup can be per OS, and the cap has a floor', () => {
		const file = JSON.stringify({ copy: ['.env*', '../secret', '/etc/passwd', 'C:/x', 'config/*.json'], setup: { darwin: ['brew bundle'], default: ['npm ci'] } });
		assert.deepStrictEqual({
			mac: readClaudeWorktreeSetup(file, 'darwin'),
			linux: readClaudeWorktreeSetup(file, 'linux')?.commands,
			list: readClaudeWorktreeSetup(JSON.stringify({ setup: ['a', 7, ' '] }), 'linux'),
			empty: readClaudeWorktreeSetup('{}', 'linux'),
			broken: readClaudeWorktreeSetup('{', 'linux'),
			globs: [matchesClaudeCopySegment('.env.local', '.env*'), matchesClaudeCopySegment('x.env', '.env*'), matchesClaudeCopySegment('a.json', '?.json')],
			max: [readClaudeWorktreesMax(5), readClaudeWorktreesMax(0), readClaudeWorktreesMax('x')],
		}, {
			mac: { copy: ['.env*', 'config/*.json'], commands: ['brew bundle'] },
			linux: ['npm ci'],
			list: { copy: [], commands: ['a'] },
			empty: undefined,
			broken: undefined,
			globs: [true, false, true],
			max: [5, 20, 20],
		});
	});

	test('copies matching files into the worktree, keeps ones already there, runs the commands in order and stops at a failure', async () => {
		const repo = join(root, 'repo');
		const tree = join(root, 'tree');
		mkdirSync(join(repo, 'config'), { recursive: true });
		mkdirSync(tree, { recursive: true });
		writeFileSync(join(repo, '.env'), 'A=1');
		writeFileSync(join(repo, '.env.local'), 'B=2');
		writeFileSync(join(repo, 'config', 'local.json'), '{}');
		writeFileSync(join(tree, '.env.local'), 'kept');
		// In the Electron test renderer, execPath is the Electron helper: it only acts as node with ELECTRON_RUN_AS_NODE.
		const runAsNode = !process.versions.electron ? '' : process.platform === 'win32' ? 'set "ELECTRON_RUN_AS_NODE=1" && ' : 'ELECTRON_RUN_AS_NODE=1 ';
		const node = `${runAsNode}"${process.execPath}"`;
		const result = await runClaudeWorktreeSetup(repo, tree, {
			copy: ['.env*', 'config/*.json', 'missing.txt'],
			commands: [`${node} -e "require('fs').writeFileSync('ran.txt', 'yes')"`, `${node} -e "console.log('boom'); process.exit(2)"`, `${node} -e "require('fs').writeFileSync('never.txt', 'no')"`],
		});
		assert.deepStrictEqual({
			copied: result.copied.slice().sort(),
			kept: readFileSync(join(tree, '.env.local'), 'utf8'),
			ran: readFileSync(join(tree, 'ran.txt'), 'utf8'),
			never: existsSync(join(tree, 'never.txt')),
			failed: result.failed?.includes('process.exit(2)'),
			exits: result.commands.map(command => command.exitCode),
			output: result.commands[1]?.output.trim(),
		}, {
			copied: ['.env', 'config/local.json'],
			kept: 'kept',
			ran: 'yes',
			never: false,
			failed: true,
			exits: [0, 2],
			output: 'boom',
		});
	});
});
