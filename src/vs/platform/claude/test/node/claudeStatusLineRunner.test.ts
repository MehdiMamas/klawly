/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeStatusLineInput } from '../../common/claudeStatusLine.js';
import { ClaudeStatusLineHost, nodeClaudeStatusLineHost as productionHost, runClaudeStatusLine } from '../../node/claudeStatusLineRunner.js';
import { removeDirWithRetries } from './claudeTestFiles.js';

/**
 * The production host, with room for a slow machine: the heavy check runs several batches on one
 * Mac, and a node start that stalled past the production 5 seconds failed these tests (issue 1558).
 * The 5 second limit itself is not what these tests are about.
 */
function nodeClaudeStatusLineHost(...args: Parameters<typeof productionHost>): ClaudeStatusLineHost {
	const host = productionHost(...args);
	return { ...host, run: (command, cwd, input, env) => host.run(command, cwd, input, env, 120_000) };
}

suite('Claude status line runner (issue 515)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'klawly-statusline-'));
		mkdirSync(join(root, 'home', '.claude'), { recursive: true });
		mkdirSync(join(root, 'work', '.claude'), { recursive: true });
	});

	teardown(() => removeDirWithRetries(root, 20, 200));

	function input(): ClaudeStatusLineInput {
		const cwd = join(root, 'work');
		return { hook_event_name: 'Status', session_id: 'abc', cwd, model: { id: 'opus', display_name: 'Opus 5.5' }, workspace: { current_dir: cwd, project_dir: cwd } };
	}

	/** A command that prints the model's name from the JSON on stdin, with node so it runs on every OS. */
	function nodeCommand(script: string): string {
		const file = join(root, `${Math.random().toString(36).slice(2)}.js`);
		writeFileSync(file, script);
		// In the Electron test renderer, execPath is the Electron helper: it only acts as node with ELECTRON_RUN_AS_NODE.
		const runAsNode = !process.versions.electron ? '' : process.platform === 'win32' ? 'set "ELECTRON_RUN_AS_NODE=1" && ' : 'ELECTRON_RUN_AS_NODE=1 ';
		return `${runAsNode}"${process.execPath}" "${file}"`;
	}

	test('runs the command with the session JSON on stdin and returns its first line', async () => {
		const command = nodeCommand(`let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write('\\n'+j.model.display_name+' - '+j.session_id+'\\nmore');});`);
		writeFileSync(join(root, 'home', '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command } }));
		const host = nodeClaudeStatusLineHost({ ...process.env, CLAUDE_CONFIG_DIR: '' }, join(root, 'home'));
		assert.deepStrictEqual(await runClaudeStatusLine({ cwd: join(root, 'work'), trusted: true, input: input() }, host), { kind: 'line', text: 'Opus 5.5 - abc' });
	});

	test('a project command runs only in a trusted workspace, and no status line is none', async () => {
		const command = nodeCommand(`process.stdout.write('project');`);
		writeFileSync(join(root, 'work', '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command } }));
		const host = nodeClaudeStatusLineHost({ ...process.env, CLAUDE_CONFIG_DIR: '' }, join(root, 'home'));
		assert.deepStrictEqual({
			trusted: await runClaudeStatusLine({ cwd: join(root, 'work'), trusted: true, input: input() }, host),
			untrusted: await runClaudeStatusLine({ cwd: join(root, 'work'), trusted: false, input: input() }, host),
		}, { trusted: { kind: 'line', text: 'project' }, untrusted: { kind: 'none' } });
	});

	test('the Klawly user layer ranks above ~/.claude, which is read only while it is used (issue 455)', async () => {
		writeFileSync(join(root, 'home', '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: nodeCommand(`process.stdout.write('claude code');`) } }));
		const layer = join(root, 'home', '.klawly', 'claude');
		const env = { ...process.env, CLAUDE_CONFIG_DIR: '' };
		const run = (useClaudeCodeSetup: boolean) => runClaudeStatusLine({ cwd: join(root, 'work'), trusted: true, input: input() }, nodeClaudeStatusLineHost(env, join(root, 'home'), layer, useClaudeCodeSetup));
		const before = { on: await run(true), off: await run(false) };
		mkdirSync(layer, { recursive: true });
		writeFileSync(join(layer, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: nodeCommand(`process.stdout.write('klawly');`) } }));
		assert.deepStrictEqual({ before, after: await run(true) }, {
			before: { on: { kind: 'line', text: 'claude code' }, off: { kind: 'none' } },
			after: { kind: 'line', text: 'klawly' },
		});
	});

	test('a failing or silent command is a failure, not a line', async () => {
		const failing = nodeCommand(`process.exit(3);`);
		writeFileSync(join(root, 'home', '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: failing } }));
		const host = nodeClaudeStatusLineHost({ ...process.env, CLAUDE_CONFIG_DIR: '' }, join(root, 'home'));
		const result = await runClaudeStatusLine({ cwd: join(root, 'work'), trusted: true, input: input() }, host);
		assert.deepStrictEqual({ kind: result.kind, exit: result.kind === 'failed' && result.message.includes('3') }, { kind: 'failed', exit: true });
	});
});
