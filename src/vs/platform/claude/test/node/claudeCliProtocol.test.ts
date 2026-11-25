/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeJsonLineParser, claudeCliSessionId, claudeUserLine, isClaudeCliResult, readClaudeCliInit } from '../../node/claudeCliProtocol.js';

suite('Claude stream-json protocol', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the parser joins a line cut across chunks, skips blank lines and keeps a non-JSON line apart', () => {
		const parser = new ClaudeJsonLineParser();
		const first = parser.push('{"type":"system","subtype":"init","session_id":"s1"}\n{"type":"assis');
		const second = parser.push('tant"}\r\n\nwarning: slow disk\n{"type":"result"}');
		const end = parser.end();
		assert.deepStrictEqual({ first, second, end }, {
			first: { messages: [{ type: 'system', subtype: 'init', session_id: 's1' }], invalid: [] },
			second: { messages: [{ type: 'assistant' }], invalid: ['warning: slow disk'] },
			end: { messages: [{ type: 'result' }], invalid: [] },
		});
	});

	test('a user message goes out as one line of JSON', () => {
		const line = claudeUserLine({ type: 'user', message: { role: 'user', content: 'hi\nthere' } } as never);
		assert.deepStrictEqual({ line, lines: line.split('\n').length }, { line: '{"type":"user","message":{"role":"user","content":"hi\\nthere"}}\n', lines: 2 });
	});

	test('the init message gives the session, the model and the lists Klawly shows', () => {
		assert.deepStrictEqual({
			init: readClaudeCliInit({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-haiku', slash_commands: ['help', 3], agents: ['Explore'], mcp_servers: [{ name: 'docs', status: 'connected' }, { status: 'x' }] }),
			notInit: readClaudeCliInit({ type: 'system', subtype: 'status' }),
			garbage: readClaudeCliInit('x'),
			session: claudeCliSessionId({ session_id: 's2' }),
			noSession: claudeCliSessionId({ session_id: '' }),
			result: [isClaudeCliResult({ type: 'result' }), isClaudeCliResult({ type: 'assistant' })],
		}, {
			init: { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-haiku', slash_commands: ['help'], agents: ['Explore'], mcp_servers: [{ name: 'docs', status: 'connected' }] },
			notInit: undefined,
			garbage: undefined,
			session: 's2',
			noSession: undefined,
			result: [true, false],
		});
	});
});
