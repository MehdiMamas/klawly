/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { createClaudeBridge } from '../../node/claudeCliQuery.js';
import { ClaudeLocalBridge } from '../../node/claudeLocalBridge.js';
import { ClaudeQueryStart, ClaudeToolPermission } from '../../node/claudeQuery.js';

async function rpc(url: string, method: string, params?: unknown, id: number | null = 1): Promise<{ status: number; body: { result?: Record<string, unknown>; error?: { code: number } } | undefined }> {
	const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', ...id === null ? {} : { id }, method, params }) });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

suite('Claude local bridge', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('serves initialize, tools/list and tools/call over POST only, and refuses a wrong token', async () => {
		const bridge = new ClaudeLocalBridge();
		await bridge.start();
		store.add({ dispose: () => bridge.close() });
		bridge.addMcpServer('demo', { instructions: 'Use it.', tools: [{ name: 'echo', description: 'Echoes.', inputSchema: { type: 'object' }, alwaysLoad: true, call: async args => ({ content: [{ type: 'text', text: String(args.word) }] }) }] });
		const url = String(bridge.mcpConfig('demo').url);
		const initialize = await rpc(url, 'initialize', { protocolVersion: '2025-06-18' });
		const list = await rpc(url, 'tools/list');
		const call = await rpc(url, 'tools/call', { name: 'echo', arguments: { word: 'hi' } });
		const unknown = await rpc(url, 'tools/call', { name: 'nope' });
		const notification = await rpc(url, 'notifications/initialized', undefined, null);
		const get = await fetch(url);
		const wrongToken = await fetch(url.replace(/\/mcp\/[^/]+\//, '/mcp/wrong/'), { method: 'POST', body: '{}' });
		assert.deepStrictEqual({
			initialize: initialize.body?.result?.instructions,
			list: list.body?.result,
			call: call.body?.result,
			unknown: unknown.body?.error?.code,
			notification: notification.status,
			get: get.status,
			wrongToken: wrongToken.status,
		}, {
			initialize: 'Use it.',
			list: { tools: [{ name: 'echo', description: 'Echoes.', inputSchema: { type: 'object' }, _meta: { 'anthropic/alwaysLoad': true } }] },
			call: { content: [{ type: 'text', text: 'hi' }] },
			unknown: -32602,
			notification: 202,
			get: 405,
			wrongToken: 404,
		});
	});

	test('the permission tool asks the host and answers allow with the input, or deny with the reason', async () => {
		const asked: string[] = [];
		const canUseTool = async (name: string, input: Record<string, unknown>, context: { agentId?: string; toolUseID: string }): Promise<ClaudeToolPermission> => {
			asked.push(`${name} ${JSON.stringify(input)} ${context.toolUseID} ${context.agentId}`);
			return name === 'Bash' ? { behavior: 'deny', message: 'Not now.' } : { behavior: 'allow', updatedInput: { ...input, edited: true } };
		};
		const agents = new Map([['tool-1', 'agent-9']]);
		const wired = await createClaudeBridge({ options: { canUseTool } } as unknown as ClaudeQueryStart, { remember: (id, agent) => agents.set(id, agent), lookup: id => agents.get(id) });
		store.add({ dispose: () => wired.bridge.close() });
		const url = String(wired.mcpServers.klawly_permission.url);
		const answer = async (tool_name: string, tool_use_id: string) => {
			const reply = await rpc(url, 'tools/call', { name: 'approve', arguments: { tool_name, input: { file_path: 'a.ts' }, tool_use_id } });
			return JSON.parse(((reply.body?.result?.content as { text: string }[])[0]).text);
		};
		assert.deepStrictEqual({ write: await answer('Write', 'tool-1'), bash: await answer('Bash', 'tool-2'), asked, args: wired.hooks.PreToolUse !== undefined }, {
			write: { behavior: 'allow', updatedInput: { file_path: 'a.ts', edited: true } },
			bash: { behavior: 'deny', message: 'Not now.' },
			asked: ['Write {"file_path":"a.ts"} tool-1 agent-9', 'Bash {"file_path":"a.ts"} tool-2 undefined'],
			args: true,
		});
	});
});
