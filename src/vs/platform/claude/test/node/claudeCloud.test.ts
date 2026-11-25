/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { addClaudeCloudSessionRecord, CLAUDE_CLOUD_REVIEW_MAX_DIFF, claudeCloudReviewDocument, CLAUDE_CLOUD_SESSION_LIMIT, claudeCloudSessionUrl, claudeCloudStartArguments, claudeCloudUnavailableReason, readClaudeCloudCapability, readClaudeCloudSessionRecords, readClaudeCloudSendResult, readClaudeCloudSessionId, readClaudeCloudText, claudeTeleportArguments } from '../../common/claudeCloud.js';
import { ClaudeNodeRuntimeService } from '../../node/claudeNodeRuntimeService.js';
import { ExecFileOptions } from '../../node/claudeRuntime.js';

/** What `claude --help` of Claude Code 2.1.296 prints around the cloud options. */
const HELP_2_1_296 = [
	'  --chrome                              Enable Claude in Chrome integration',
	'  --cloud [description|session_id|url]  Create a cloud session with the given',
	'                                        description, or attach to an existing',
	'                                        one by session ID or claude.ai/code URL',
	'  --teleport [session]                  Resume a teleport session, optionally',
	'                                        specify session ID',
	'  --remote-control [name]               Start an interactive session with Remote',
].join('\n');

/** Klawly's cloud agents are Claude Code's own cloud sessions (issue 516). */
suite('Claude cloud sessions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function service(reply: (args: readonly string[]) => { stdout: string; stderr: string } | Error) {
		const calls: { args: readonly string[]; cwd: string | undefined; input: string | undefined }[] = [];
		const runtime = store.add(new ClaudeNodeRuntimeService({
			runtimePath: process.execPath,
			execFile: async (_file: string, args: readonly string[], options: ExecFileOptions) => {
				if (args[0] === '--version') {
					return { stdout: '2.1.296 (Claude Code)\n', stderr: '' };
				}
				if (args[0] === 'auth') {
					return { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' };
				}
				calls.push({ args, cwd: options.cwd, input: options.input });
				const result = reply(args);
				if (result instanceof Error) {
					throw result;
				}
				return result;
			},
		}));
		return { runtime, calls };
	}

	test('reads session IDs and claude.ai/code links, and nothing else', () => {
		assert.deepStrictEqual([
			'session_01DiUkqY2kzbUbDmW1w96rfi',
			' cse_abc123 ',
			'https://claude.ai/code/session_01DiUkqY2kzbUbDmW1w96rfi?from=cli&m=0',
			'claude.ai/code/cse_abc123',
			'--help',
			'session_',
			'session_a b',
			'https://evil.example/code/session_abc',
			'https://claude.ai/code/../session_abc',
			42,
		].map(readClaudeCloudSessionId), [
			'session_01DiUkqY2kzbUbDmW1w96rfi',
			'cse_abc123',
			'session_01DiUkqY2kzbUbDmW1w96rfi',
			'cse_abc123',
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	test('builds the commands with the = form, so a task cannot read as an option', () => {
		assert.deepStrictEqual({
			start: claudeCloudStartArguments(readClaudeCloudText('  --dangerously-skip-permissions\n fix the\tlogin bug ')!),
			teleport: claudeTeleportArguments('session_abc'),
			picker: claudeTeleportArguments(undefined),
			empty: readClaudeCloudText(' \n '),
			long: readClaudeCloudText('x'.repeat(8001)),
		}, {
			start: ['--cloud=--dangerously-skip-permissions fix the login bug'],
			teleport: ['--teleport=session_abc'],
			picker: ['--teleport'],
			empty: undefined,
			long: undefined,
		});
	});

	test('reads the capability from the help, and the send result from its JSON or stderr', () => {
		assert.deepStrictEqual({
			current: readClaudeCloudCapability(HELP_2_1_296, '2.1.296', '/bin/claude'),
			old: readClaudeCloudCapability('  --remote-control [name]  Start an interactive session\n  --resume [value]', '2.0.1'),
			sent: readClaudeCloudSendResult('{"ok":true,"session_id":"session_abc","url":"https://claude.ai/code/session_abc?from=cli&m=0"}\n', ''),
			untrustedUrl: readClaudeCloudSendResult('{"ok":true,"session_id":"session_abc","url":"http://claude.ai.evil.example/x"}', ''),
			refused: readClaudeCloudSendResult('{"ok":false,"session_id":"session_abc","error":"cloud session session_abc is archived and cannot accept new messages"}', ''),
			policy: readClaudeCloudSendResult('', 'Error: Cloud sessions are disabled by your organization\'s policy. Contact your organization admin to enable them.\n'),
		}, {
			current: { cloud: true, teleport: true, remoteControl: true, version: '2.1.296', binary: '/bin/claude' },
			old: { cloud: false, teleport: false, remoteControl: true, version: '2.0.1', binary: undefined },
			sent: { ok: true, sessionId: 'session_abc', url: 'https://claude.ai/code/session_abc?from=cli&m=0' },
			untrustedUrl: { ok: true, sessionId: 'session_abc', url: undefined },
			refused: { ok: false, sessionId: 'session_abc', error: 'cloud session session_abc is archived and cannot accept new messages' },
			policy: { ok: false, error: 'Cloud sessions are disabled by your organization\'s policy. Contact your organization admin to enable them.' },
		});
	});

	test('the runtime reads the help once, and sends a message on stdin with no shell', async () => {
		const { runtime, calls } = service(args => args[0] === '--help'
			? { stdout: HELP_2_1_296, stderr: '' }
			: { stdout: '{"ok":true,"session_id":"session_abc","url":"https://claude.ai/code/session_abc"}', stderr: '' });
		const first = await runtime.getCloudCapability();
		await runtime.getCloudCapability();
		const sent = await runtime.sendToCloudSession({ session: 'https://claude.ai/code/session_abc', message: 'also update the docs', cwd: '/repo' });
		const refused = await runtime.sendToCloudSession({ session: '--help', message: 'x' }).catch((error: Error) => error.message);
		assert.deepStrictEqual({ first: { cloud: first.cloud, teleport: first.teleport, version: first.version }, sent, refused, calls }, {
			first: { cloud: true, teleport: true, version: '2.1.296' },
			sent: { ok: true, sessionId: 'session_abc', url: 'https://claude.ai/code/session_abc' },
			refused: 'The cloud session or the message is not valid.',
			calls: [
				{ args: ['--help'], cwd: undefined, input: undefined },
				{ args: ['-p', '--cloud=session_abc', '--output-format', 'json'], cwd: '/repo', input: 'also update the docs' },
			],
		});
	});

	test('a failed send reports what Claude Code printed', async () => {
		const { runtime } = service(() => Object.assign(new Error('Command failed'), { stdout: '', stderr: 'Error: Session not found: session_gone\n' }));
		assert.deepStrictEqual(await runtime.sendToCloudSession({ session: 'session_gone', message: 'hello' }), { ok: false, error: 'Session not found: session_gone' });
	});

	test('Run in says why Cloud is unavailable instead of failing after a click (issue 532)', () => {
		const ready = { cloud: true, teleport: true, version: '2.1.296', binary: 'claude' };
		assert.deepStrictEqual({
			ready: claudeCloudUnavailableReason(ready, 'claude-account'),
			enterprise: claudeCloudUnavailableReason(ready, 'enterprise'),
			apiKey: claudeCloudUnavailableReason(ready, 'api-key'),
			bedrock: claudeCloudUnavailableReason(ready, 'bedrock'),
			old: claudeCloudUnavailableReason({ cloud: false, teleport: false, version: '2.1.200', binary: 'claude' }),
			oldUnknown: claudeCloudUnavailableReason({ cloud: false, teleport: false, binary: 'claude' }),
			unread: claudeCloudUnavailableReason({ cloud: false, teleport: false, binary: 'claude', error: 'timed out' }),
			missing: claudeCloudUnavailableReason({ cloud: false, teleport: false }),
			missingError: claudeCloudUnavailableReason({ cloud: false, teleport: false, error: 'ENOENT' }),
			noRuntime: claudeCloudUnavailableReason(undefined),
		}, {
			ready: undefined,
			enterprise: undefined,
			apiKey: 'needs Claude Code signed in with a Claude account, not an API key, Bedrock or Vertex',
			bedrock: 'needs Claude Code signed in with a Claude account, not an API key, Bedrock or Vertex',
			old: 'needs Claude Code 2.1.296 or later; this is 2.1.200',
			oldUnknown: 'needs Claude Code 2.1.296 or later',
			unread: 'Klawly could not read what Claude Code supports: timed out',
			missing: 'Claude Code is not installed',
			missingError: 'Klawly could not read what Claude Code supports: ENOENT',
			noRuntime: 'this Claude runtime cannot reach cloud sessions',
		});
	});

	test('records starts and sends per workspace, newest first, and reads back only valid entries (issue 532)', () => {
		let records = addClaudeCloudSessionRecord([], { title: '  Fix the\nflaky test ' }, 100, 'a1');
		records = addClaudeCloudSessionRecord(records, { sessionId: 'https://claude.ai/code/session_abc', title: 'also update the docs' }, 200, 'unused');
		records = addClaudeCloudSessionRecord(records, { sessionId: 'session_abc', title: 'a second message' }, 300, 'unused');
		records = addClaudeCloudSessionRecord(records, { title: '   ' }, 400, 'b2');
		const stored = JSON.parse(JSON.stringify([...records, { id: 'start-x', title: 'no times' }, { id: '--evil', title: 't', startedAt: 1, updatedAt: 1 }, 'junk', records[0]]));
		const many = Array.from({ length: CLAUDE_CLOUD_SESSION_LIMIT + 3 }, (_, index) => index).reduce((all, index) => addClaudeCloudSessionRecord(all, { title: `task ${index}` }, index, `k${index}`), records);
		assert.deepStrictEqual({
			records,
			read: readClaudeCloudSessionRecords(stored),
			urls: records.map(claudeCloudSessionUrl),
			capped: [many.length, many.at(-1)?.title],
		}, {
			records: [
				{ id: 'session_abc', sessionId: 'session_abc', title: 'also update the docs', startedAt: 200, updatedAt: 300 },
				{ id: 'start-a1', sessionId: undefined, title: 'Fix the flaky test', startedAt: 100, updatedAt: 100 },
			],
			read: [
				{ id: 'session_abc', sessionId: 'session_abc', title: 'also update the docs', startedAt: 200, updatedAt: 300 },
				{ id: 'start-a1', sessionId: undefined, title: 'Fix the flaky test', startedAt: 100, updatedAt: 100 },
			],
			urls: ['https://claude.ai/code/session_abc', 'https://claude.ai/code'],
			capped: [CLAUDE_CLOUD_SESSION_LIMIT, 'task 3'],
		});
	});

	test('Review Diff document: header, empty and cut', () => {
		const long = 'x'.repeat(CLAUDE_CLOUD_REVIEW_MAX_DIFF + 5);
		const cut = claudeCloudReviewDocument(long, { filesChanged: 2, added: 3, removed: 1 });
		assert.deepStrictEqual({
			one: claudeCloudReviewDocument('diff --git a/a b/a\n', { filesChanged: 1, added: 4, removed: 0 }),
			many: claudeCloudReviewDocument('diff --git a/a b/a\n', { filesChanged: 2, added: 5, removed: 6 }),
			empty: claudeCloudReviewDocument('  \n', { filesChanged: 0, added: 0, removed: 0 }),
			cut: [cut?.startsWith('# 2 files changed, +3 -1\nxxx'), cut?.endsWith('[The diff is cut here; open the worktree to read the rest.]\n'), (cut?.length ?? 0) < long.length + 200],
		}, {
			one: '# 1 file changed, +4 -0\ndiff --git a/a b/a\n',
			many: '# 2 files changed, +5 -6\ndiff --git a/a b/a\n',
			empty: undefined,
			cut: [true, true, true],
		});
	});
});
