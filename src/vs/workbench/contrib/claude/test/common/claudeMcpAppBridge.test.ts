/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeMcpAppBridge, ClaudeMcpAppCall, ClaudeMcpAppFile, ClaudeMcpAppHostContext } from '../../common/claudeMcpAppBridge.js';

const CONTEXT: ClaudeMcpAppHostContext = {
	theme: 'dark',
	styles: { variables: {} },
	displayMode: 'inline',
	availableDisplayModes: ['inline', 'fullscreen', 'pip'],
	containerDimensions: { width: 600, maxHeight: 560 },
	platform: 'desktop',
};

function harness(call: ClaudeMcpAppCall, composerTakes = true, saves = true) {
	const log: unknown[] = [];
	let context = CONTEXT;
	const bridge = new ClaudeMcpAppBridge(call, {
		post: message => log.push(message),
		resize: height => log.push({ resize: height }),
		openLink: async url => {
			log.push({ open: url.toString() });
			return true;
		},
		draft: text => {
			log.push({ draft: text });
			return composerTakes;
		},
		hostContext: () => context,
		setDisplayMode: mode => {
			context = { ...context, displayMode: mode };
			return mode;
		},
		readResource: async uri => {
			log.push({ read: uri });
			if (uri.endsWith('missing')) {
				throw new Error('Resource not found');
			}
			return [{ uri, mimeType: 'text/plain', text: 'hello' }];
		},
		saveFile: async (file: ClaudeMcpAppFile) => {
			log.push({ save: file });
			return saves;
		},
	}, { name: 'Klawly', version: '1.0.0' });
	return { bridge, log };
}

const RUNNING: ClaudeMcpAppCall = { server: 'weather', tool: 'forecast', input: { city: 'Paris' }, done: false, failed: false };

suite('Claude MCP App bridge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('initialize answers with the host context, then sends the input, and the result once the call ends', async () => {
		const { bridge, log } = harness(RUNNING);
		bridge.hostContextChanged();
		await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} });
		await bridge.handle({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
		bridge.update({ ...RUNNING, output: 'Sunny, 21 C', done: true });
		bridge.update({ ...RUNNING, output: 'Sunny, 21 C', done: true });
		bridge.hostContextChanged();
		const initialize = log[0] as { result: { protocolVersion: string } };
		assert.deepStrictEqual(log, [
			{ jsonrpc: '2.0', id: 1, result: { protocolVersion: initialize.result.protocolVersion, hostInfo: { name: 'Klawly', version: '1.0.0' }, hostCapabilities: { openLinks: {}, logging: {}, message: { text: {} }, serverResources: {}, downloadFile: {} }, hostContext: CONTEXT } },
			{ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { city: 'Paris' } } },
			{ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: 'Sunny, 21 C' }], isError: false } },
			{ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: CONTEXT },
		]);
	});

	test('sizes are clamped, links open for http and https only, messages and tool calls go to the composer, other requests fail', async () => {
		const { bridge, log } = harness({ ...RUNNING, done: true, failed: true, output: 'Timed out' });
		await bridge.handle('not json-rpc');
		await bridge.handle({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 2000 } });
		await bridge.handle({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 0.5 } });
		await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'ui/open-link', params: { url: 'https://example.com/a' } });
		await bridge.handle({ jsonrpc: '2.0', id: 3, method: 'ui/open-link', params: { url: 'command:workbench.action.quit' } });
		await bridge.handle({ jsonrpc: '2.0', id: 4, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: 'Show me Lyon too' }, { type: 'image', data: 'x' }] } });
		await bridge.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'forecast', arguments: { city: 'Lyon' } } });
		await bridge.handle({ jsonrpc: '2.0', id: 6, method: 'sampling/createMessage', params: {} });
		await bridge.handle({ jsonrpc: '2.0', id: 7, method: 'ping' });
		assert.deepStrictEqual(log, [
			{ resize: 560 },
			{ resize: 32 },
			{ open: 'https://example.com/a' },
			{ jsonrpc: '2.0', id: 2, result: { isError: false } },
			{ jsonrpc: '2.0', id: 3, result: { isError: true } },
			{ draft: 'Show me Lyon too' },
			{ jsonrpc: '2.0', id: 4, result: { isError: false } },
			{ draft: 'Call the forecast tool of the weather MCP server with these arguments:\n```json\n{\n  "city": "Lyon"\n}\n```' },
			{ jsonrpc: '2.0', id: 5, result: { content: [{ type: 'text', text: 'Klawly put this call in the composer. Claude runs it when the user sends it.' }], isError: true } },
			{ jsonrpc: '2.0', id: 6, error: { code: -32601, message: 'Klawly does not support sampling/createMessage in MCP Apps yet.' } },
			{ jsonrpc: '2.0', id: 7, result: {} },
		]);
	});

	test('the result carries images and structured content', async () => {
		const { bridge, log } = harness({ ...RUNNING, done: true, output: 'ok', images: [{ mimeType: 'image/png', data: 'AAAA' }], structuredContent: { temp: 21 } });
		await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} });
		await bridge.handle({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
		assert.deepStrictEqual(log[2], { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: 'ok' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], structuredContent: { temp: 21 }, isError: false } });
	});

	test('resources/read answers from the host and reports a failure as an error', async () => {
		const { bridge, log } = harness(RUNNING);
		await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'file://weather/a.txt' } });
		await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'file://weather/missing' } });
		await bridge.handle({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: {} });
		assert.deepStrictEqual(log, [
			{ read: 'file://weather/a.txt' },
			{ jsonrpc: '2.0', id: 1, result: { contents: [{ uri: 'file://weather/a.txt', mimeType: 'text/plain', text: 'hello' }] } },
			{ read: 'file://weather/missing' },
			{ jsonrpc: '2.0', id: 2, result: { contents: [], isError: true, message: 'Resource not found' } },
			{ jsonrpc: '2.0', id: 3, result: { contents: [] } },
		]);
	});

	test('display modes: a supported mode is set and announced, an unknown one keeps the current mode', async () => {
		const { bridge, log } = harness(RUNNING);
		await bridge.handle({ jsonrpc: '2.0', id: 9, method: 'ui/initialize', params: {} });
		await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'ui/request-display-mode', params: { mode: 'fullscreen' } });
		await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'ui/request-display-mode', params: { mode: 'tiny' } });
		assert.deepStrictEqual(log.slice(2), [
			{ jsonrpc: '2.0', id: 1, result: { mode: 'fullscreen' } },
			{ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { ...CONTEXT, displayMode: 'fullscreen' } },
			{ jsonrpc: '2.0', id: 2, result: { mode: 'fullscreen' } },
		]);
	});

	test('ui/download-file saves each embedded resource under a plain file name', async () => {
		const { bridge, log } = harness(RUNNING);
		await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'ui/download-file', params: { contents: [
			{ type: 'resource', resource: { uri: 'file:///a/b/report.csv?x=1', mimeType: 'text/csv', text: 'a,b' } },
			{ type: 'resource', resource: { uri: 'file:///a/..%2F..%2Fx', blob: 'AAAA' } },
		] } });
		await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'ui/download-file', params: { contents: [{ type: 'resource_link', uri: 'https://example.com/x' }] } });
		await bridge.handle({ jsonrpc: '2.0', id: 3, method: 'ui/download-file', params: { contents: [] } });
		assert.deepStrictEqual(log, [
			{ save: { name: 'report.csv', mimeType: 'text/csv', text: 'a,b' } },
			{ save: { name: '..%2F..%2Fx', blob: 'AAAA' } },
			{ jsonrpc: '2.0', id: 1, result: { isError: false } },
			{ jsonrpc: '2.0', id: 2, result: { isError: true } },
			{ jsonrpc: '2.0', id: 3, result: { isError: true } },
		]);
	});

	test('ui/download-file is an error when the user says no', async () => {
		const { bridge, log } = harness(RUNNING, true, false);
		await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'ui/download-file', params: { contents: [{ type: 'resource', resource: { uri: 'file:///a.txt', text: 'x' } }] } });
		assert.deepStrictEqual(log[1], { jsonrpc: '2.0', id: 1, result: { isError: true } });
	});

	test('a message the composer cannot take is an error', async () => {
		const { bridge, log } = harness(RUNNING, false);
		await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: 'Hi' }] } });
		await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'ui/message', params: { role: 'user', content: [] } });
		assert.deepStrictEqual(log, [
			{ draft: 'Hi' },
			{ jsonrpc: '2.0', id: 1, result: { isError: true } },
			{ jsonrpc: '2.0', id: 2, result: { isError: true } },
		]);
	});
});
