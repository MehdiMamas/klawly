/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A tiny MCP server over stdio for trying MCP Apps by hand (issue 669). It has one tool,
// `clock`, whose `_meta.ui.resourceUri` names a `ui://` page; Klawly draws that page under the
// tool's card. Add it to Claude Code, then ask Claude to call the clock tool:
//
//   claude mcp add klawly-sample-app -- node build/klawly/sample-mcp-app-server.ts
//
// It has no dependencies; it speaks just enough JSON-RPC (initialize, tools/list, tools/call,
// resources/list, resources/read).

import * as readline from 'node:readline';

const APP_URI = 'ui://klawly-sample/clock.html';

const APP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
body { font: 13px var(--font-sans, system-ui); color: var(--color-text-primary, inherit); background: var(--color-background-primary, transparent); margin: 0; padding: 12px; }
button { font: inherit; padding: 4px 10px; }
</style></head><body>
<div id="time">Loading...</div>
<button id="ask">Ask Claude for the date</button>
<script>
const out = document.getElementById('time');
out.textContent = new Date().toLocaleTimeString();
document.getElementById('ask').onclick = () => parent.postMessage({ jsonrpc: '2.0', method: 'ui/message', id: 1, params: { role: 'user', content: [{ type: 'text', text: 'What is the date today?' }] } }, '*');
</script></body></html>`;

function reply(id: unknown, result: unknown): void {
	process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function handle(message: { id?: unknown; method?: string; params?: { uri?: string } }): void {
	switch (message.method) {
		case 'initialize':
			return reply(message.id, { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'klawly-sample-app', version: '1.0.0' } });
		case 'tools/list':
			return reply(message.id, { tools: [{ name: 'clock', description: 'Shows the current time in a small app.', inputSchema: { type: 'object', properties: {} }, _meta: { ui: { resourceUri: APP_URI } } }] });
		case 'tools/call':
			return reply(message.id, { content: [{ type: 'text', text: `It is ${new Date().toISOString()}.` }] });
		case 'resources/list':
			return reply(message.id, { resources: [{ uri: APP_URI, name: 'Clock', mimeType: 'text/html;profile=mcp-app' }] });
		case 'resources/read':
			return reply(message.id, { contents: [{ uri: message.params?.uri ?? APP_URI, mimeType: 'text/html;profile=mcp-app', text: APP_HTML, _meta: { ui: { prefersBorder: true } } }] });
		default:
			if (message.id !== undefined) {
				process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
			}
	}
}

readline.createInterface({ input: process.stdin }).on('line', line => {
	try {
		handle(JSON.parse(line));
	} catch {
		// Not JSON: ignore.
	}
});
