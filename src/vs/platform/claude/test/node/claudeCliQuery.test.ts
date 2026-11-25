/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { createClaudeCliQuery } from '../../node/claudeCliQuery.js';
import { ClaudePromptMessage, ClaudeQueryOptions } from '../../node/claudeQuery.js';

const PROMPT: ClaudePromptMessage = { type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null };

function options(extra: Partial<ClaudeQueryOptions>): ClaudeQueryOptions {
	return { cwd: tmpdir(), permissionMode: 'default', env: {}, abortController: new AbortController(), ...extra } as ClaudeQueryOptions;
}

suite('Claude CLI query', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a dev container turn is refused: it can neither prompt nor run with prompts off', async () => {
		const target = { kind: 'devcontainer', workspaceFolder: '/w', remoteWorkspaceFolder: '/workspaces/w' } as const;
		await assert.rejects(createClaudeCliQuery({ prompt: (async function* () { })(), options: options({ executionTarget: target }) }), /dev container/);
	});

	test('usage windows come from rate-limit events; MCP servers it passes can be turned off and on', async () => {
		if (isWindows) {
			return;
		}
		const dir = await fs.mkdtemp(join(tmpdir(), 'klawly-cliquery-'));
		try {
			const script = join(dir, 'claude');
			const log = join(dir, 'args.log');
			await fs.writeFile(script, `#!/bin/sh
echo "$@" >> "${log}"
read line
echo '{"type":"system","subtype":"init","session_id":"s1","mcp_servers":[{"name":"mine","status":"connected"}]}'
echo '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour","utilization":0.4,"resetsAt":1900000000}}'
echo '{"type":"result","subtype":"success","is_error":false,"session_id":"s1"}'
`, { mode: 0o755 });
			let release!: () => void;
			const second = new Promise<void>(resolve => { release = resolve; });
			const prompt = (async function* () {
				yield PROMPT;
				await second;
				yield PROMPT;
			})();
			const query = await createClaudeCliQuery({ prompt, options: options({ pathToClaudeCodeExecutable: script, userMcpServers: { mine: { type: 'http', url: 'http://x' } } }) });
			const reader = query[Symbol.asyncIterator]();
			for (let message = await reader.next(); (message.value as { type?: string }).type !== 'result'; message = await reader.next()) {
				// drain to the first result
			}
			assert.deepStrictEqual(await query.usageLimits?.(), [{ kind: 'session', percent: 40, resetsAt: 1900000000000 }]);
			await query.toggleMcpServer?.('mine', false);
			assert.deepStrictEqual((await query.mcpServerStatus?.())?.map(status => status.state), ['disabled']);
			await assert.rejects(query.toggleMcpServer!('other', false), /MCP servers it passes/);
			release();
			for (let message = await reader.next(); !message.done && (message.value as { type?: string }).type !== 'result'; message = await reader.next()) {
				// drain to the second result
			}
			query.close();
			const lines = (await fs.readFile(log, 'utf8')).trim().split('\n');
			assert.deepStrictEqual(lines.map(line => [line.includes('--resume s1'), line.includes('"mine"')]), [[false, true], [true, false]]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
