/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NormalizedClaudeEvent } from '../../../../../platform/claude/common/claudeProtocol.js';
import { formatClaudeAgentEvent, formatClaudeRuntimeState } from '../../../../services/claude/common/claudeAgentLog.js';
import { buildClaudeDiagnosticsFiles, ClaudeDiagnosticsInput, CLAUDE_DIAGNOSTICS_LOG_LINES } from '../../common/claudeDiagnosticsExport.js';

const FAKE_KEY = ['sk', '-ant-', 'api03-diagnosticsvalue'].join('');
const FAKE_GITHUB = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');
const FILE_BODY = 'export const launchCodes = 1234;';
const PROMPT = 'please refactor the billing module';

function events(): NormalizedClaudeEvent[] {
	return [
		{ type: 'session.started', sessionId: 's1', model: 'claude-model' },
		{ type: 'tool.started', sessionId: 's1', call: { id: 't1', name: 'Write', category: 'write', input: { file_path: 'C:\\Users\\dev\\repo\\src\\a.ts', content: FILE_BODY }, display: { label: 'Write' } } },
		{ type: 'file.beforeWrite', sessionId: 's1', uri: 'file:///C:/Users/dev/repo/src/a.ts', before: FILE_BODY },
		{ type: 'file.afterWrite', sessionId: 's1', uri: 'file:///C:/Users/dev/repo/src/a.ts', after: `${FILE_BODY}\n// ${FAKE_KEY}` },
		{ type: 'assistant.completed', sessionId: 's1', text: `${PROMPT} done ${FAKE_KEY}` },
		{ type: 'tool.completed', sessionId: 's1', callId: 't1', result: { ok: true, output: FILE_BODY } },
		{ type: 'session.failed', sessionId: 's1', kind: 'process-crash', message: `crashed with ${FAKE_GITHUB}` },
	];
}

function input(overrides: Partial<ClaudeDiagnosticsInput> = {}): ClaudeDiagnosticsInput {
	const log = [
		formatClaudeRuntimeState({ installed: true, authenticated: true, version: '2.1.0', authMode: 'claude-account' }),
		...events().map(event => formatClaudeAgentEvent(event, 5)),
		'Error: spawn failed',
		'    at spawn (C:\\Users\\dev\\AppData\\claude.js:10:5)',
		`[checkpoint] ANTHROPIC_API_KEY=${FAKE_KEY}`,
	].join('\n');
	return {
		generatedAt: '2026-10-06T00:00:00.000Z',
		product: { nameLong: 'Klawly', version: '1.140.0', commit: 'abc123', quality: 'stable' },
		protocolVersion: 1,
		runtime: { installed: true, authenticated: true, version: '2.1.0', authMode: 'claude-account', binaryPath: 'C:\\Users\\dev\\.local\\bin\\claude.exe' },
		os: { type: 'Windows_NT', release: '10.0.26200', arch: 'x64' },
		configuration: {
			agent: { runtime: 'live', runtimePath: 'C:\\Users\\dev\\.local\\bin\\claude.exe', enabled: true },
			models: { custom: [`model-${FAKE_KEY}`] },
			mcp: { apiToken: 'plain-looking-value', headers: { Authorization: 'Basic dXNlcjpwYXNz' } },
			telemetry: { enabled: false },
		},
		log,
		homeDirectories: ['C:\\Users\\dev', 'C:/Users/dev'],
		...overrides,
	};
}

suite('Claude diagnostics export', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('lists the expected files with versions, OS and the protocol version', () => {
		const files = buildClaudeDiagnosticsFiles(input());
		assert.deepStrictEqual(files.map(file => file.path), ['README.txt', 'versions.json', 'configuration.json', 'events.json', 'errors.log', 'claude-agent.log']);
		assert.deepStrictEqual(JSON.parse(files[1].contents), {
			generatedAt: '2026-10-06T00:00:00.000Z',
			product: { name: 'Klawly', version: '1.140.0', commit: 'abc123', quality: 'stable' },
			claudeProtocolVersion: 1,
			claudeRuntime: { version: '2.1.0', installed: true, authenticated: true, authMode: 'claude-account', binaryPath: '~\\.local\\bin\\claude.exe' },
			os: { type: 'Windows_NT', release: '10.0.26200', arch: 'x64' },
		});
	});

	test('secrets, prompts and file contents never reach the archive', () => {
		const all = buildClaudeDiagnosticsFiles(input()).map(file => file.contents).join('\n');
		for (const forbidden of [FAKE_KEY, FAKE_GITHUB, FILE_BODY, 'launchCodes', PROMPT, 'plain-looking-value', 'dXNlcjpwYXNz', 'C:\\Users\\dev', 'C:/Users/dev']) {
			assert.strictEqual(all.includes(forbidden), false, forbidden);
		}
		assert.ok(all.includes('[redacted]'));
	});

	test('configuration keeps ordinary values and drops secret-named text', () => {
		const configuration = JSON.parse(buildClaudeDiagnosticsFiles(input())[2].contents);
		assert.deepStrictEqual(configuration, {
			claude: {
				agent: { runtime: 'live', runtimePath: '~\\.local\\bin\\claude.exe', enabled: true },
				models: { custom: ['model-[redacted]'] },
				mcp: { apiToken: '[redacted]', headers: { Authorization: '[redacted]' } },
				telemetry: { enabled: false },
			},
		});
	});

	test('events keep only their types, and errors keep error and stack lines', () => {
		const files = buildClaudeDiagnosticsFiles(input());
		assert.deepStrictEqual(JSON.parse(files[3].contents), {
			counts: { 'session.started': 1, 'tool.started': 1, 'file.beforeWrite': 1, 'file.afterWrite': 1, 'assistant.completed': 1, 'tool.completed': 1, 'session.failed': 1 },
			recent: ['session.started', 'tool.started', 'file.beforeWrite', 'file.afterWrite', 'assistant.completed', 'tool.completed', 'session.failed'],
		});
		assert.deepStrictEqual(files[4].contents.trimEnd().split('\n'), [
			'[claude] +5ms session.failed session=s1 kind=process-crash message=crashed with [redacted]',
			'Error: spawn failed',
			'    at spawn (~\\AppData\\claude.js:10:5)',
		]);
	});

	test('the log keeps the newest lines, cuts long lines, and works without a runtime', () => {
		const long = `[claude] note ${'x'.repeat(2000)}`;
		const lines = Array.from({ length: CLAUDE_DIAGNOSTICS_LOG_LINES + 5 }, (_value, index) => `line ${index}`);
		const files = buildClaudeDiagnosticsFiles(input({ log: [...lines, long].join('\r\n'), runtime: undefined, runtimeError: `probe failed ${FAKE_KEY}` }));
		const log = files[5].contents.trimEnd().split('\n');
		assert.strictEqual(log.length, CLAUDE_DIAGNOSTICS_LOG_LINES);
		assert.strictEqual(log[0], 'line 6');
		assert.ok(log[log.length - 1].endsWith('… [cut]') && log[log.length - 1].length < 600);
		assert.deepStrictEqual(JSON.parse(files[1].contents).claudeRuntime, { unavailable: 'probe failed [redacted]' });
		assert.strictEqual(buildClaudeDiagnosticsFiles(input({ log: '' }))[5].contents, '');
	});
});
