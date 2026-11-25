/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeMcpAddArguments, claudeMcpRemoveArguments, claudeMcpServerConfig, isClaudeMcpServerName, readClaudeMcpAddRequest, readClaudeMcpRemoveRequest, splitCommandLine } from '../../common/claudeMcpConfig.js';

suite('Claude MCP config', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('names never read as flags, and command lines split like a shell for plain input', () => {
		assert.deepStrictEqual({
			names: ['github', 'my.server_2', '-rm', '', 'a b', 'x'.repeat(65)].map(isClaudeMcpServerName),
			plain: splitCommandLine('npx -y @scope/server'),
			quoted: splitCommandLine('node "C:\\My Tools\\server.js" --port \'80 80\''),
			empty: splitCommandLine('  ""  '),
			open: splitCommandLine('node "server.js'),
		}, {
			names: [true, true, false, false, false, false],
			plain: ['npx', '-y', '@scope/server'],
			quoted: ['node', 'C:\\My Tools\\server.js', '--port', '80 80'],
			empty: [''],
			open: undefined,
		});
	});

	test('the form makes a config only from a command or an http URL', () => {
		assert.deepStrictEqual([
			claudeMcpServerConfig('stdio', 'npx -y server'),
			claudeMcpServerConfig('stdio', '   '),
			claudeMcpServerConfig('stdio', '""'),
			claudeMcpServerConfig('http', 'https://example.com/mcp'),
			claudeMcpServerConfig('sse', 'file:///etc/passwd'),
			claudeMcpServerConfig('http', 'not a url'),
		], [
			{ type: 'stdio', command: 'npx', args: ['-y', 'server'] },
			undefined,
			undefined,
			{ type: 'http', url: 'https://example.com/mcp' },
			undefined,
			undefined,
		]);
	});

	test('requests from another process are checked before they become arguments', () => {
		const add = readClaudeMcpAddRequest({ name: 'docs', scope: 'project', config: { type: 'stdio', command: 'node', args: ['s.js'] }, cwd: '/repo' });
		const remove = readClaudeMcpRemoveRequest({ name: 'docs', scope: 'user', cwd: '' });
		assert.deepStrictEqual({
			add: add && claudeMcpAddArguments(add),
			remove: remove && claudeMcpRemoveArguments(remove),
			removeCwd: remove?.cwd,
			rejected: [
				readClaudeMcpAddRequest({ name: '--evil', scope: 'user', config: { type: 'http', url: 'https://x.dev' } }),
				readClaudeMcpAddRequest({ name: 'ok', scope: 'global', config: { type: 'http', url: 'https://x.dev' } }),
				readClaudeMcpAddRequest({ name: 'ok', scope: 'user', config: { type: 'stdio', command: 'node', args: [1] } }),
				readClaudeMcpAddRequest({ name: 'ok', scope: 'user', config: { type: 'ws', url: 'https://x.dev' } }),
				readClaudeMcpRemoveRequest({ name: 'ok' }),
				readClaudeMcpRemoveRequest(undefined),
			],
		}, {
			add: ['mcp', 'add-json', '--scope', 'project', 'docs', '{"type":"stdio","command":"node","args":["s.js"]}'],
			remove: ['mcp', 'remove', '--scope', 'user', 'docs'],
			removeCwd: undefined,
			rejected: [undefined, undefined, undefined, undefined, undefined, undefined],
		});
	});
});
