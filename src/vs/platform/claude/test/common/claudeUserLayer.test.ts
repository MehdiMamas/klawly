/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { addClaudeUserMcpServer, claudeUserLayerDirectory, claudeUserLayerLabel, claudeUserLayerMcpScope, claudeUserLayerSettingsBelow, readClaudeUserLayerSettings, readClaudeUserMcpServers, removeClaudeUserMcpServer } from '../../common/claudeUserLayer.js';

/** Klawly's user layer in `~/.klawly/claude` (issue 455). */
suite('Claude user layer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the folder and labels follow the build\'s data folder', () => {
		assert.deepStrictEqual({
			windows: claudeUserLayerDirectory('C:\\Users\\me', '.klawly'),
			posix: claudeUserLayerDirectory('/home/me', '.klawly-dev'),
			label: claudeUserLayerLabel('.klawly', 'settings.json'),
		}, {
			windows: 'C:\\Users\\me\\.klawly\\claude',
			posix: '/home/me/.klawly-dev/claude',
			label: '~/.klawly/claude/settings.json',
		});
	});

	test('Claude Code\'s setup is used unless turned off', () => {
		assert.deepStrictEqual([undefined, true, false, 'no'].map(value => readClaudeUserLayerSettings(() => value).useClaudeCodeSetup), [true, true, false, true]);
	});

	test('the project wins: keys it sets are dropped, arrays merge, and the mode is never the user layer\'s', () => {
		const user = {
			model: 'opus',
			env: { A: '1', B: '2' },
			permissions: { allow: ['Bash(npm test)'], defaultMode: 'bypassPermissions' },
			hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] },
			statusLine: { type: 'command', command: 'mine' },
		};
		assert.deepStrictEqual({
			alone: claudeUserLayerSettingsBelow(user, []),
			below: claudeUserLayerSettingsBelow(user, [{ model: 'sonnet', env: { A: 'project' }, permissions: { allow: ['Read'] } }, { statusLine: { type: 'command', command: 'local' } }, undefined]),
			modeOnly: claudeUserLayerSettingsBelow({ permissions: { defaultMode: 'plan' } }, []),
			none: claudeUserLayerSettingsBelow(undefined, []),
		}, {
			alone: { model: 'opus', env: { A: '1', B: '2' }, permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] }, statusLine: { type: 'command', command: 'mine' } },
			below: { env: { B: '2' }, permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } },
			modeOnly: undefined,
			none: undefined,
		});
	});

	test('servers are added and removed in .mcp.json, keeping comments and other servers', () => {
		const text = '{\n\t// mine\n\t"mcpServers": {\n\t\t"keep": { "type": "stdio", "command": "x" }\n\t}\n}\n';
		const added = addClaudeUserMcpServer(text, 'docs', { type: 'http', url: 'https://docs.example/mcp' });
		const removed = removeClaudeUserMcpServer(added, 'docs');
		assert.deepStrictEqual({
			servers: readClaudeUserMcpServers(added),
			comment: added?.includes('// mine'),
			removed: readClaudeUserMcpServers(removed),
			fresh: readClaudeUserMcpServers(addClaudeUserMcpServer(undefined, 'run', { type: 'stdio', command: 'node', args: ['s.js'] })),
			broken: addClaudeUserMcpServer('[1, 2]', 'docs', { type: 'http', url: 'https://docs.example/mcp' }),
			absent: removeClaudeUserMcpServer(text, 'docs') === text,
			skipped: readClaudeUserMcpServers('{ "mcpServers": { "bad": 1, "ok": {} } }'),
		}, {
			servers: { keep: { type: 'stdio', command: 'x' }, docs: { type: 'http', url: 'https://docs.example/mcp' } },
			comment: true,
			removed: { keep: { type: 'stdio', command: 'x' } },
			fresh: { run: { type: 'stdio', command: 'node', args: ['s.js'] } },
			broken: undefined,
			absent: true,
			skipped: { ok: {} },
		});
	});

	test('running servers say where they are kept', () => {
		assert.deepStrictEqual([
			claudeUserLayerMcpScope('dynamic', 'docs', ['docs']),
			claudeUserLayerMcpScope('dynamic', 'klawly', ['docs']),
			claudeUserLayerMcpScope('user', 'mine', ['docs']),
			claudeUserLayerMcpScope('project', 'repo', undefined),
		], ['user', 'dynamic', 'claudeCode', 'project']);
	});
});
