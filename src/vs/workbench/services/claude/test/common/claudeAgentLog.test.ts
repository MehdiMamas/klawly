/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeRuntimeState } from '../../../../../platform/claude/common/claude.js';
import { NormalizedClaudeEvent } from '../../../../../platform/claude/common/claudeProtocol.js';
import { formatClaudeAgentEvent, formatClaudeAgentFailure, formatClaudeLogLine, formatClaudeRuntimeState, redactSecrets } from '../../common/claudeAgentLog.js';

const SECRET = 'sk-ant-api03-testsecretvalue';

suite('Claude agent log', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('redacts credential-shaped text', () => {
		const raw = `key ${SECRET} Bearer abc.def API_KEY=hunter2 ANTHROPIC_API_KEY=secret AKIAIOSFODNN7EXAMPLE`;
		const redacted = redactSecrets(raw);
		assert.strictEqual(redacted.includes(SECRET), false);
		assert.strictEqual(redacted.includes('abc.def'), false);
		assert.strictEqual(redacted.includes('hunter2'), false);
		assert.strictEqual(redacted.includes('AKIAIOSFODNN7EXAMPLE'), false);
		assert.ok(redacted.includes('[redacted]'));
		assert.ok(redacted.includes('Bearer [redacted]'));
		assert.ok(redacted.includes('API_KEY=[redacted]'));
		assert.ok(redacted.includes('ANTHROPIC_API_KEY=[redacted]'));
	});

	test('redacts json keys, prefixed env names, and GitHub tokens', () => {
		const github = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
		const pat = 'github_pat_11AAAAAAA0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
		const raw = `"apiKey": "${SECRET}" "token": "json-token" OPENAI_API_KEY=sk-live GITHUB_TOKEN=${github} ${pat}`;
		const redacted = redactSecrets(raw);
		assert.strictEqual(redacted.includes(SECRET), false);
		assert.strictEqual(redacted.includes('json-token'), false);
		assert.strictEqual(redacted.includes('sk-live'), false);
		assert.strictEqual(redacted.includes(github), false);
		assert.strictEqual(redacted.includes(pat), false);
		assert.ok(redacted.includes('"apiKey": "[redacted]"'));
		assert.ok(redacted.includes('"token": "[redacted]"'));
		assert.ok(redacted.includes('OPENAI_API_KEY=[redacted]'));
		assert.ok(redacted.includes('GITHUB_TOKEN=[redacted]'));
	});

	test('redacts PEM private key blocks and JWTs through the shared pattern list', () => {
		const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
		const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----';
		assert.strictEqual(redactSecrets(`failed ${jwt} with ${pem}`), 'failed [redacted] with -----BEGIN OPENSSH PRIVATE KEY-----[redacted]-----END OPENSSH PRIVATE KEY-----');
		const line = formatClaudeAgentFailure(`refused ${pem}`);
		assert.strictEqual(line.includes('b3BlbnNzaC1rZXkt'), false);
	});

	test('file write lines keep the local file name but never the file contents', () => {
		const before: NormalizedClaudeEvent = { type: 'file.beforeWrite', sessionId: 'session-1', uri: 'file:///ws/src/a.ts', before: `const key = "${SECRET}";` };
		const after: NormalizedClaudeEvent = { type: 'file.afterWrite', sessionId: 'session-1', uri: 'file:///ws/src/a.ts', after: `password=${SECRET}` };
		assert.deepStrictEqual([formatClaudeAgentEvent(before, 1), formatClaudeAgentEvent(after, 2)], [
			'[claude] +1ms file.beforeWrite session=session-1 uri=file:///ws/src/a.ts',
			'[claude] +2ms file.afterWrite session=session-1 uri=file:///ws/src/a.ts',
		]);
	});

	test('a free-form log line is redacted and ends in exactly one newline', () => {
		assert.deepStrictEqual([formatClaudeLogLine(`index ${SECRET}`), formatClaudeLogLine('Git index could not be read.\n')], [
			'index [redacted]\n',
			'Git index could not be read.\n',
		]);
	});

	test('logs tool names and drops file contents', () => {
		const event: NormalizedClaudeEvent = {
			type: 'tool.started',
			sessionId: 'session-1',
			call: {
				id: 'call-1',
				name: 'Read',
				category: 'read',
				input: { content: SECRET },
				display: { label: 'Read', file: 'src/secret.ts', command: `cat ${SECRET}` },
			},
		};
		const line = formatClaudeAgentEvent(event, 12);
		assert.ok(line.includes('tool.started'));
		assert.ok(line.includes('tool=Read'));
		assert.ok(line.includes('category=read'));
		assert.ok(line.includes('+12ms'));
		assert.strictEqual(line.includes(SECRET), false);
		assert.strictEqual(line.includes('src/secret.ts'), false);
	});

	test('logs assistant size without the text', () => {
		const event: NormalizedClaudeEvent = {
			type: 'assistant.delta',
			sessionId: 'session-1',
			text: `token ${SECRET}`,
		};
		const line = formatClaudeAgentEvent(event, 0);
		assert.ok(line.includes(`chars=${event.text.length}`));
		assert.strictEqual(line.includes(SECRET), false);
		assert.strictEqual(line.includes('token'), false);
	});

	test('redacts a failed-session message and keeps the kind', () => {
		const event: NormalizedClaudeEvent = {
			type: 'session.failed',
			sessionId: 'session-1',
			kind: 'auth',
			message: `rejected ${SECRET}`,
		};
		const line = formatClaudeAgentEvent(event, 4);
		assert.ok(line.includes('kind=auth'));
		assert.ok(line.includes('[redacted]'));
		assert.strictEqual(line.includes(SECRET), false);
	});

	test('logs runtime version and a redacted error', () => {
		const state: ClaudeRuntimeState = {
			installed: false,
			authenticated: false,
			version: '2.1.288',
			authMode: 'unknown',
			error: `missing ${SECRET}`,
		};
		const line = formatClaudeRuntimeState(state);
		assert.ok(line.includes('installed=false'));
		assert.ok(line.includes('version=2.1.288'));
		assert.ok(line.includes('[redacted]'));
		assert.strictEqual(line.includes(SECRET), false);
	});

	test('formats a thrown test-session failure', () => {
		const line = formatClaudeAgentFailure(`Authorization Bearer ${SECRET}`);
		assert.ok(line.startsWith('[claude] test session failed:'));
		assert.strictEqual(line.includes(SECRET), false);
	});
});
