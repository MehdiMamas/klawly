/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeQueryOptions } from '../../node/claudeQuery.js';
import { buildClaudeCliArguments, claudeCliSettings } from '../../node/claudeCliArgs.js';

suite('Claude command line', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function args(options: Partial<ClaudeQueryOptions>, sessionId?: string): string[] {
		const base: ClaudeQueryOptions = {
			cwd: '/work',
			permissionMode: 'default',
			env: {},
			abortController: new AbortController(),
			canUseTool: async () => ({ behavior: 'deny', message: 'test' }),
			screenTool: async () => undefined,
			...options,
		};
		return buildClaudeCliArguments(base, { bridgeMcpServers: {}, permissionBridge: true }, sessionId);
	}
	const after = (list: string[], flag: string) => list.includes(flag) ? list[list.indexOf(flag) + 1] : undefined;

	test('a plain turn talks stream-json over stdin and stdout and asks the permission tool', () => {
		const list = args({});
		assert.deepStrictEqual(list, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--setting-sources', '', '--permission-prompt-tool', 'mcp__klawly_permission__approve']);
	});

	test('plugin folders to try become --plugin-dir, and none leaves the flag out', () => {
		assert.deepStrictEqual({
			tried: after(args({ plugins: ['/cache/claude-plugin-trials/team/lint'] }), '--plugin-dir'),
			none: after(args({}), '--plugin-dir'),
		}, { tried: '/cache/claude-plugin-trials/team/lint', none: undefined });
	});

	test('the user layer rides under the flag settings (issue 455)', () => {
		const settings = claudeCliSettings({
			flagSettings: { attribution: { commit: '' } },
			userSettings: { attribution: { commit: 'mine', pr: 'mine' }, env: { A: '1' } },
		} as unknown as ClaudeQueryOptions);
		assert.deepStrictEqual(settings, { attribution: { commit: '' }, env: { A: '1' } });
	});

	test('user MCP servers ride in --mcp-config beside the bridge ones, and the bridge wins a clash', () => {
		const options = { userMcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' }, klawly: { type: 'stdio', command: 'x' } } } as unknown as ClaudeQueryOptions;
		const list = buildClaudeCliArguments(options, { bridgeMcpServers: { klawly: { type: 'http', url: 'http://127.0.0.1:1/mcp/t/klawly' } }, permissionBridge: true });
		assert.deepStrictEqual(JSON.parse(after(list, '--mcp-config')!), { mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' }, klawly: { type: 'http', url: 'http://127.0.0.1:1/mcp/t/klawly' } } });
	});

	test('an AGENTS.md system prompt is appended, and none leaves the flag out (issue 499)', () => {
		assert.deepStrictEqual({
			agents: after(args({ systemPrompt: 'Contents of AGENTS.md' }), '--append-system-prompt'),
			none: after(args({}), '--append-system-prompt'),
		}, { agents: 'Contents of AGENTS.md', none: undefined });
	});

	test('a resumed turn continues the session, and a fork copies it', () => {
		assert.deepStrictEqual({
			resume: after(args({ resume: 's1' }, 's1'), '--resume'),
			fork: args({ resume: 's1', forkSession: true }, 's1').includes('--fork-session'),
			restart: args({ resume: 's1', forkSession: true }, 's2').includes('--fork-session'),
			fresh: args({}).includes('--resume'),
		}, { resume: 's1', fork: true, restart: false, fresh: false });
	});

	test('without the bridge Claude Code is told to prompt no one', () => {
		const list = buildClaudeCliArguments({} as ClaudeQueryOptions, { bridgeMcpServers: {}, permissionBridge: false });
		assert.deepStrictEqual([after(list, '--permission-prompts'), list.includes('--permission-prompt-tool')], ['none', false]);
	});
});
