/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeCacheRoot, claudeMcpLogFolder, formatClaudeMcpLogLine } from '../../common/claudeMcpControl.js';
import { readClaudeMcpLog } from '../../node/claudeMcpLogs.js';

suite('Claude MCP logs (issue 512)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;

	setup(() => { root = mkdtempSync(join(tmpdir(), 'klawly-mcp-logs-')); });
	teardown(() => rmSync(root, { recursive: true, force: true }));

	test('the cache folder and log folder are named as Claude Code names them, and lines read as time, level, message without secrets', () => {
		assert.deepStrictEqual({
			mac: claudeCacheRoot('darwin', '/Users/me', {}),
			linux: claudeCacheRoot('linux', '/home/me', {}),
			xdg: claudeCacheRoot('linux', '/home/me', { XDG_CACHE_HOME: '/c' }),
			windows: claudeCacheRoot('win32', 'C:\\Users\\me', { LOCALAPPDATA: 'C:\\L' }),
			folder: claudeMcpLogFolder('/Users/me/my.app', 'claude.ai Vercel'),
			lines: [
				formatClaudeMcpLogLine('{"error":"connect failed","timestamp":"2026-10-12T10:00:00Z","sessionId":"x"}'),
				formatClaudeMcpLogLine('{"debug":"token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ"}')?.includes('sk-ant-api03'),
				formatClaudeMcpLogLine('plain text'),
				formatClaudeMcpLogLine('   '),
			],
		}, {
			mac: '/Users/me/Library/Caches/claude-cli-nodejs',
			linux: '/home/me/.cache/claude-cli-nodejs',
			xdg: '/c/claude-cli-nodejs',
			windows: 'C:\\L\\claude-cli-nodejs\\Cache',
			folder: '-Users-me-my-app/mcp-logs-claude-ai-Vercel',
			lines: ['2026-10-12T10:00:00Z [error] connect failed', false, 'plain text', undefined],
		});
	});

	test('reads the newest log of the session folder, else the newest of any project, else nothing', async () => {
		const write = (cwd: string, server: string, name: string, lines: string[]) => {
			const folder = join(root, claudeMcpLogFolder(cwd, server));
			mkdirSync(folder, { recursive: true });
			writeFileSync(join(folder, name), lines.join('\n'));
		};
		write('/work', 'docs', '2026-10-12T09-00-00-000Z.jsonl', ['{"debug":"old"}']);
		write('/work', 'docs', '2026-10-12T10-00-00-000Z.jsonl', ['{"debug":"new","timestamp":"T1"}']);
		write('/work-tree-a', 'tracker', '2026-10-11T10-00-00-000Z.jsonl', ['{"info":"older project"}']);
		write('/work-tree-b', 'tracker', '2026-10-12T10-00-00-000Z.jsonl', ['{"info":"newer project"}']);
		const own = await readClaudeMcpLog(root, '/work', 'docs');
		const elsewhere = await readClaudeMcpLog(root, '/work', 'tracker');
		assert.deepStrictEqual({
			own: own.lines,
			ownFile: own.file?.endsWith('2026-10-12T10-00-00-000Z.jsonl'),
			elsewhere: elsewhere.lines,
			none: await readClaudeMcpLog(root, '/work', 'missing'),
			noCache: await readClaudeMcpLog(join(root, 'nope'), '/work', 'docs'),
		}, {
			own: ['T1 [debug] new'],
			ownFile: true,
			elsewhere: ['[info] newer project'],
			none: { lines: [] },
			noCache: { lines: [] },
		});
	});
});
