/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeMcpAddRequest } from '../../common/claudeMcpConfig.js';
import { ClaudeNodeRuntimeService } from '../../node/claudeNodeRuntimeService.js';
import { ExecFileOptions } from '../../node/claudeRuntime.js';

/**
 * The Customize page adds and removes project MCP servers through `claude mcp`,
 * run with no shell. Servers for you in every project go in Klawly's
 * `~/.klawly/claude/.mcp.json`; `~/.claude.json` is never written (issue 455).
 */
suite('Claude MCP commands', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let home: string;

	setup(async () => {
		home = await fs.mkdtemp(join(tmpdir(), 'klawly-mcp-'));
	});

	teardown(async () => {
		await fs.rm(home, { recursive: true, force: true });
	});

	function service(fail?: string) {
		const calls: { file: string; args: readonly string[]; cwd: string | undefined }[] = [];
		const runtime = store.add(new ClaudeNodeRuntimeService({
			runtimePath: process.execPath,
			homeDirectory: home,
			dataFolderName: '.klawly',
			execFile: async (file: string, args: readonly string[], options: ExecFileOptions) => {
				if (args[0] === '--version') {
					return { stdout: '2.1.288\n', stderr: '' };
				}
				if (args[0] === 'auth') {
					return { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' };
				}
				calls.push({ file, args, cwd: options.cwd });
				if (fail) {
					throw Object.assign(new Error('Command failed'), { stderr: `${fail}\n` });
				}
				return { stdout: '', stderr: '' };
			},
		}));
		return { runtime, calls };
	}

	test('project servers run claude mcp in the project folder', async () => {
		const { runtime, calls } = service();
		await runtime.addMcpServer({ name: 'docs', scope: 'project', config: { type: 'http', url: 'https://docs.example/mcp' }, cwd: '/repo' });
		await runtime.removeMcpServer({ name: 'docs', scope: 'project', cwd: '/repo' });
		assert.deepStrictEqual(calls, [
			{ file: process.execPath, args: ['mcp', 'add-json', '--scope', 'project', 'docs', '{"type":"http","url":"https://docs.example/mcp"}'], cwd: '/repo' },
			{ file: process.execPath, args: ['mcp', 'remove', '--scope', 'project', 'docs'], cwd: '/repo' },
		]);
	});

	test('your servers go in ~/.klawly/claude/.mcp.json, and ~/.claude.json and ~/.claude stay byte for byte', async () => {
		const claudeJson = '{\n  "mcpServers": { "mine": { "type": "stdio", "command": "x" } }\n}\n';
		await fs.writeFile(join(home, '.claude.json'), claudeJson);
		await fs.mkdir(join(home, '.claude'));
		await fs.writeFile(join(home, '.claude', 'settings.json'), '{}\n');
		const { runtime, calls } = service();
		await runtime.addMcpServer({ name: 'docs', scope: 'user', config: { type: 'http', url: 'https://docs.example/mcp' } });
		await runtime.addMcpServer({ name: 'run', scope: 'user', config: { type: 'stdio', command: 'node', args: ['s.js'] } });
		await runtime.removeMcpServer({ name: 'docs', scope: 'user' });
		const errors: string[] = [];
		await runtime.addMcpServer({ name: 'docs', scope: 'local', config: { type: 'http', url: 'https://docs.example/mcp' }, cwd: '/repo' }).catch(error => errors.push(error.message));
		await runtime.removeMcpServer({ name: 'mine', scope: 'local', cwd: '/repo' }).catch(error => errors.push(error.message));
		const layer = JSON.parse(await fs.readFile(join(home, '.klawly', 'claude', '.mcp.json'), 'utf8'));
		assert.deepStrictEqual({
			layer,
			claudeJson: await fs.readFile(join(home, '.claude.json'), 'utf8'),
			claudeFolder: await fs.readdir(join(home, '.claude')),
			settings: await fs.readFile(join(home, '.claude', 'settings.json'), 'utf8'),
			errors: errors.length,
			runs: calls.length,
		}, {
			layer: { mcpServers: { run: { type: 'stdio', command: 'node', args: ['s.js'] } } },
			claudeJson,
			claudeFolder: ['settings.json'],
			settings: '{}\n',
			errors: 2,
			runs: 0,
		});
	});

	test('a refusal surfaces what Claude Code printed, and bad requests never run', async () => {
		const { runtime, calls } = service('MCP server docs already exists in project config');
		const errors: string[] = [];
		for (const run of [
			() => runtime.addMcpServer({ name: 'docs', scope: 'project', config: { type: 'stdio', command: 'node', args: [] }, cwd: '/repo' }),
			() => runtime.addMcpServer({ name: '--help', scope: 'project', config: { type: 'stdio', command: 'node', args: [] } } as ClaudeMcpAddRequest),
		]) {
			await run().catch(error => errors.push(error.message));
		}
		assert.deepStrictEqual({ errors, runs: calls.length }, {
			errors: ['MCP server docs already exists in project config', 'The MCP server is not valid.'],
			runs: 1,
		});
	});
});
