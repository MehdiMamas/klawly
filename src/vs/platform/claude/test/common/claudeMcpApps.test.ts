/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeMcpAppFromContents, claudeMcpToolName, findClaudeMcpApp, readClaudeMcpAppTool } from '../../common/claudeMcpApps.js';

suite('Claude MCP Apps', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a tool draws an app from ui.resourceUri or the flat key, ui:// only, and Claude Code names it like its tool calls', () => {
		const servers = [
			{ name: 'my.weather', apps: [readClaudeMcpAppTool('forecast', { ui: { resourceUri: 'ui://weather/forecast', visibility: ['model', 'app', 'other'] } })!] },
			{ name: 'maps', apps: [readClaudeMcpAppTool('route', { 'ui/resourceUri': 'ui://maps/route' })!] },
		];
		assert.deepStrictEqual({
			tools: [
				readClaudeMcpAppTool('a', { ui: { resourceUri: 'https://example.com/app.html' } }),
				readClaudeMcpAppTool('b', undefined),
				readClaudeMcpAppTool('c', { ui: {} }),
			],
			name: claudeMcpToolName('my.weather', 'get forecast'),
			weather: findClaudeMcpApp('mcp__my_weather__forecast', servers)?.app,
			maps: findClaudeMcpApp('mcp__maps__route', servers)?.server.name,
			none: findClaudeMcpApp('mcp__maps__forecast', servers),
		}, {
			tools: [undefined, undefined, undefined],
			name: 'mcp__my_weather__get_forecast',
			weather: { tool: 'forecast', resourceUri: 'ui://weather/forecast', visibility: ['model', 'app'] },
			maps: 'maps',
			none: undefined,
		});
	});

	test('a resource read becomes the app: the HTML item as text or base64, with its CSP and border, or why not', () => {
		const html = '<!doctype html><p>Sunny</p>';
		assert.deepStrictEqual([
			claudeMcpAppFromContents('weather', 'forecast', 'ui://weather/forecast', [
				{ uri: 'ui://weather/forecast.json', mimeType: 'application/json', text: '{}' },
				{ uri: 'ui://weather/forecast', mimeType: 'text/html;profile=mcp-app', text: html, meta: { ui: { csp: { connectDomains: ['https://api.example.com', 3], other: ['x'] }, prefersBorder: false } } },
			]),
			claudeMcpAppFromContents('weather', 'forecast', 'ui://weather/forecast', [{ uri: 'ui://weather/forecast', blob: encodeBase64(VSBuffer.fromString(html)) }]),
			claudeMcpAppFromContents('weather', 'forecast', 'ui://weather/forecast', []),
			claudeMcpAppFromContents('weather', 'forecast', 'ui://weather/forecast', [{ uri: 'ui://weather/forecast', mimeType: 'text/html' }]),
		], [
			{ ok: true, app: { server: 'weather', tool: 'forecast', uri: 'ui://weather/forecast', html, mimeType: 'text/html;profile=mcp-app', csp: { connectDomains: ['https://api.example.com'] }, prefersBorder: false } },
			{ ok: true, app: { server: 'weather', tool: 'forecast', uri: 'ui://weather/forecast', html, mimeType: 'text/html' } },
			{ ok: false, message: 'The weather MCP server returned nothing for ui://weather/forecast.' },
			{ ok: false, message: 'The weather MCP server returned no HTML for ui://weather/forecast.' },
		]);
	});
});
