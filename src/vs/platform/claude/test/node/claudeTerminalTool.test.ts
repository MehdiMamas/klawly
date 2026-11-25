/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CLAUDE_FEEDBACK_TOOL, CLAUDE_FEEDBACK_TOOL_RESULT } from '../../common/claudeFeedbackTool.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_CANVAS_TOOL, ClaudeCanvasToolArgs, ClaudeCanvasToolResult } from '../../common/claudeCanvas.js';
import { CLAUDE_TERMINAL_TOOL, CLAUDE_TERMINAL_TOOL_ID, claudePolicyToolCall, claudeTerminalLastOutput, ClaudeTerminalRunRequest, ClaudeTerminalRunResult, claudeTerminalShellArgs, claudeTerminalToolResult } from '../../common/claudeTerminalRun.js';
import { classifyCommand } from '../../common/claudeToolPolicy.js';
import { ClaudeAgentRunner, ClaudeTerminalRunToolRequest } from '../../node/claudeAgentRunner.js';
import { ClaudeUserPermissionBridge } from '../../node/claudePermissionHost.js';
import { ClaudeNodeRuntimeService } from '../../node/claudeNodeRuntimeService.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery, ClaudeQueryStart, ClaudeTerminalToolHost } from '../../node/claudeQuery.js';
import { claudeKlawlyMcpServer, runClaudeTerminalTool } from '../../node/claudeTerminalTool.js';
import { CLAUDE_STATUS_TOOL } from '../../common/claudeStatusTool.js';

/** Klawly's tools as the local bridge serves them: the names, and each call routed by name. */
const handlers = new Map<string, (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>>();
async function klawly(...args: Parameters<typeof claudeKlawlyMcpServer>): Promise<string[] | undefined> {
	const server = await claudeKlawlyMcpServer(...args);
	for (const tool of server?.tools ?? []) {
		handlers.set(tool.name, input => tool.call(input, new AbortController().signal));
	}
	return server?.tools.map(tool => tool.name);
}

/**
 * Issue 452: Claude hands interactive commands (sign-ins, sudo, prompts) to the
 * user in a visible terminal and continues when the command ends.
 */
suite('Claude run_in_terminal', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const folders: string[] = [];

	teardown(() => {
		for (const folder of folders.splice(0)) {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	function workspace(): string {
		const folder = mkdtempSync(join(tmpdir(), 'klawly-terminal-'));
		folders.push(folder);
		return folder;
	}

	test('each shell runs one command and exits with its status', () => {
		assert.deepStrictEqual([
			'/bin/zsh',
			'/usr/bin/bash',
			'C:\\Program Files\\Git\\bin\\bash.exe',
			'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
			'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
			'C:\\WINDOWS\\system32\\cmd.exe',
			'fish',
		].map(shell => claudeTerminalShellArgs(shell, 'gh auth login')), [
			['-c', 'gh auth login'],
			['-c', 'gh auth login'],
			['-c', 'gh auth login'],
			['-NoLogo', '-Command', 'gh auth login'],
			['-NoLogo', '-Command', 'gh auth login'],
			['/d', '/s', '/c', 'gh auth login'],
			['-c', 'gh auth login'],
		]);
	});

	test('Claude reads the last lines of the terminal and a result for every outcome', () => {
		const bottomUp = ['', '   ', 'Logged in as octocat', '✓ Authentication complete.', '! First copy your one-time code: 1234-5678', 'older'];
		assert.deepStrictEqual({
			last: claudeTerminalLastOutput(bottomUp, 3),
			chars: claudeTerminalLastOutput(['abcdef'], 40, 4),
			empty: claudeTerminalLastOutput(['', '']),
			exited: claudeTerminalToolResult('gh auth login', { kind: 'exited', exitCode: 0, lastOutput: 'Logged in as octocat' }),
			failedExit: claudeTerminalToolResult('gh auth login', { kind: 'exited', exitCode: 1, lastOutput: '' }),
			cancelled: claudeTerminalToolResult('gh auth login', { kind: 'cancelled' }),
			failed: claudeTerminalToolResult('gh auth login', { kind: 'failed', message: 'no shell' }),
		}, {
			last: '! First copy your one-time code: 1234-5678\n✓ Authentication complete.\nLogged in as octocat',
			chars: 'cdef',
			empty: '',
			exited: { text: '`gh auth login` ended with exit code 0.\nLast output:\nLogged in as octocat', isError: false },
			failedExit: { text: '`gh auth login` ended with exit code 1.\nThe terminal showed no output.', isError: true },
			cancelled: { text: 'The user cancelled `gh auth login` before it finished. Do not run it again unless the user asks.\nThe terminal showed no output.', isError: true },
			failed: { text: 'Klawly could not run `gh auth login` in a terminal: no shell', isError: true },
		});
	});

	test('the permission policy sees the tool as Bash, and sign-ins touch credentials', () => {
		assert.deepStrictEqual({
			terminal: claudePolicyToolCall(CLAUDE_TERMINAL_TOOL_ID, { command: 'gh auth login', reason: 'Sign in to GitHub' }),
			other: claudePolicyToolCall('Read', { file_path: 'a.ts' }),
			risks: ['gh auth login', 'npm login', 'az login', 'gcloud auth login', 'aws sso login', 'docker login ghcr.io', 'gh pr create'].map(command => classifyCommand(command).risk),
		}, {
			terminal: { toolName: 'Bash', input: { command: 'gh auth login', description: 'Sign in to GitHub' } },
			other: { toolName: 'Read', input: { file_path: 'a.ts' } },
			risks: ['credentials', 'credentials', 'credentials', 'credentials', 'credentials', 'credentials', classifyCommand('gh pr create').risk],
		});
		assert.notStrictEqual(classifyCommand('gh pr create').risk, 'credentials');
	});

	test('the tool answers every call, even when the host throws or the command is empty', async () => {
		const calls: string[] = [];
		const host: ClaudeTerminalToolHost = {
			run: async (command, reason) => {
				calls.push(`${command} | ${reason}`);
				if (command === 'boom') {
					throw new Error('terminal service is gone');
				}
				return { kind: 'exited', exitCode: 0, lastOutput: 'ok' };
			},
		};
		assert.deepStrictEqual([
			await runClaudeTerminalTool(host, { command: ' gh auth login ', reason: 'Sign in' }, {}),
			await runClaudeTerminalTool(host, { command: 'boom' }, undefined),
			await runClaudeTerminalTool(host, { command: '  ' }, undefined),
		], [
			{ content: [{ type: 'text', text: '`gh auth login` ended with exit code 0.\nLast output:\nok' }], isError: false },
			{ content: [{ type: 'text', text: 'Klawly could not run `boom` in a terminal: terminal service is gone' }], isError: true },
			{ content: [{ type: 'text', text: 'Give the command to run.' }], isError: true },
		]);
		assert.deepStrictEqual(calls, ['gh auth login | Sign in', 'boom | undefined']);
	});

	test('issue 525: the settings tools join the server, alone or with the terminal tool, and their calls reach the window', async () => {
		const calls: unknown[] = [];
		const settings = { call: async (args: unknown) => { calls.push(args); return { kind: 'set', key: 'editor.fontSize', previous: 14, value: 16, scope: 'user' } as const; } };
		const alone = await klawly(undefined, settings);
		const both = await klawly({ run: async () => ({ kind: 'cancelled' }) }, settings);
		const none = await klawly(undefined, undefined);
		const answer = await handlers.get('klawly_settings_set')!({ key: 'editor.fontSize', value: 16 }, {});
		await handlers.get('klawly_settings_find')!({ query: 'font' }, {});
		assert.deepStrictEqual({ alone, both, none, answer, calls }, {
			alone: ['klawly_settings_find', 'klawly_settings_set'],
			both: [CLAUDE_TERMINAL_TOOL, 'klawly_settings_find', 'klawly_settings_set'],
			none: undefined,
			answer: { content: [{ type: 'text', text: 'Changed editor.fontSize from 14 to 16 (user settings).' }], isError: false },
			calls: [{ action: 'set', key: 'editor.fontSize', value: 16, scope: 'user' }, { action: 'find', query: 'font' }],
		});
	});

	test('issue 1171: the status tool reports one cleaned line and refuses an empty one', async () => {
		const reports: unknown[] = [];
		const servers = await klawly(undefined, undefined, undefined, undefined, undefined, undefined, undefined, report => reports.push(report));
		const ok = await handlers.get(CLAUDE_STATUS_TOOL)!({ text: '  Tests\n are   green ', kind: 'done' }, {});
		const empty = await handlers.get(CLAUDE_STATUS_TOOL)!({ text: '   ', kind: 'info' }, {});
		assert.deepStrictEqual({ servers, ok, empty, reports }, {
			servers: [CLAUDE_STATUS_TOOL],
			ok: { content: [{ type: 'text', text: 'Shown on the chat tab.' }], isError: undefined },
			empty: { content: [{ type: 'text', text: 'The status line was empty, so nothing was shown.' }], isError: true },
			reports: [{ text: 'Tests are green', kind: 'done' }],
		});
	});

	test('issue 1174: the feedback tool only requests the form, with cleaned text, and refuses an empty report', async () => {
		const requests: unknown[] = [];
		const servers = await klawly(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, request => requests.push(request));
		const ok = await handlers.get(CLAUDE_FEEDBACK_TOOL)!({ title: ' Chat\n freezes ', description: ' It froze. ', kind: 'bug' }, {});
		const empty = await handlers.get(CLAUDE_FEEDBACK_TOOL)!({ title: ' ', description: 'x', kind: 'idea' }, {});
		assert.deepStrictEqual({ servers, ok, empty, requests }, {
			servers: [CLAUDE_FEEDBACK_TOOL],
			ok: { content: [{ type: 'text', text: CLAUDE_FEEDBACK_TOOL_RESULT }], isError: undefined },
			empty: { content: [{ type: 'text', text: 'The title or the description was empty, so the form was not opened.' }], isError: true },
			requests: [{ title: 'Chat freezes', description: 'It froze.', kind: 'bug' }],
		});
	});

	test('issue 493: the canvas tool joins the server and answers with the file the window opens', async () => {
		const saved: unknown[] = [];
		const canvas = {
			save: async (args: ClaudeCanvasToolArgs): Promise<ClaudeCanvasToolResult> => {
				saved.push(args);
				return args.html ? { kind: 'saved', path: '/home/me/.klawly/canvases/s1/slow-tests.html', name: 'slow-tests', title: 'Slowest tests', updated: false } : { kind: 'failed', message: 'Give the HTML of the page.' };
			},
		};
		const servers = await klawly(undefined, undefined, undefined, canvas);
		const ok = await handlers.get(CLAUDE_CANVAS_TOOL)!({ name: 'slow-tests', title: 'Slowest tests', html: '<table></table>' }, {});
		const failed = await handlers.get(CLAUDE_CANVAS_TOOL)!({ name: 'slow-tests', html: '' }, {});
		assert.deepStrictEqual({ servers, ok, failed, saved: saved.length }, {
			servers: [CLAUDE_CANVAS_TOOL],
			ok: { content: [{ type: 'text', text: `Canvas file: /home/me/.klawly/canvases/s1/slow-tests.html\nCanvas title: Slowest tests\nKlawly opened the canvas beside the chat. Call ${CLAUDE_CANVAS_TOOL} again with the name "slow-tests" to update it.` }], isError: false },
			failed: { content: [{ type: 'text', text: 'Give the HTML of the page.' }], isError: true },
			saved: 2,
		});
	});

	test('the Klawly MCP server names the tool and tells Claude when to use it', async () => {
		const server = await claudeKlawlyMcpServer({ run: async () => ({ kind: 'cancelled' }) });
		const tool = server!.tools[0];
		assert.deepStrictEqual({ name: tool.name, keys: Object.keys((tool.inputSchema as { properties: object }).properties), alwaysLoad: tool.alwaysLoad, tools: server!.tools.length, instructions: typeof server!.instructions }, {
			name: CLAUDE_TERMINAL_TOOL,
			keys: ['command', 'reason'],
			alwaysLoad: true,
			tools: 1,
			instructions: 'string',
		});
		for (const word of ['gh auth login', 'npm login', 'az login', 'gcloud auth login', 'ssh', 'sudo', 'instead of Bash']) {
			assert.ok(tool.description.includes(word), word);
		}
		assert.strictEqual((await tool.call({ command: 'sudo true' }, new AbortController().signal)).isError, true);
	});

	async function openRunner(terminalRun?: (request: ClaudeTerminalRunToolRequest) => Promise<ClaudeTerminalRunResult>) {
		const registry = store.add(new ClaudeProcessRegistry());
		const bridge = new ClaudeUserPermissionBridge();
		const releases: Array<() => void> = [];
		let captured: ClaudeQueryStart | undefined;
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			terminalRun,
			queryFactory: async start => {
				captured = start;
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(releases);
			},
		}));
		const cwd = workspace();
		const done = (async () => {
			for await (const event of runner.start({ sessionId: 'session-1', prompt: 'hi', cwd, mode: 'agent', workspaceTrusted: true, permissionBridge: bridge })) {
				void event;
			}
		})();
		store.add({ dispose: () => { bridge.dispose(); releases.forEach(release => release()); void done; } });
		await waitFor(() => !!captured);
		return { options: () => captured!.options, bridge, cwd };
	}

	test('the runner gives the session the tool only when the runtime can open terminals, and Bash rules gate it', async () => {
		const quiet = await openRunner();
		assert.strictEqual(quiet.options().terminalTool, undefined);

		const requests: Omit<ClaudeTerminalRunToolRequest, 'signal'>[] = [];
		const h = await openRunner(async ({ signal, ...request }) => {
			requests.push(request);
			return { kind: 'exited', exitCode: 0, lastOutput: '' };
		});
		assert.deepStrictEqual(await h.options().terminalTool!.run('gh auth login', 'Sign in', undefined), { kind: 'exited', exitCode: 0, lastOutput: '' });
		assert.deepStrictEqual(requests, [{ sessionId: 'session-1', command: 'gh auth login', reason: 'Sign in', cwd: h.cwd }]);

		// A sign-in asks every time, like the same command through Bash.
		assert.strictEqual((await h.options().screenTool(CLAUDE_TERMINAL_TOOL_ID, { command: 'gh auth login' }))?.decision, 'ask');
		const approved = h.options().canUseTool(CLAUDE_TERMINAL_TOOL_ID, { command: 'gh auth login' }, { signal: new AbortController().signal, toolUseID: 't1' });
		await waitFor(() => h.bridge.hasPending('session-1'));
		h.bridge.resolve('session-1', 't1', 'allow-once');
		assert.strictEqual((await approved).behavior, 'allow');
	});

	async function openService() {
		const releases: Array<() => void> = [];
		let captured: ClaudeQueryStart | undefined;
		const service = store.add(new ClaudeNodeRuntimeService({
			runtimePath: process.execPath,
			execFile: async (_file, args) => args[0] === '--version' ? { stdout: '2.1.288\n', stderr: '' } : { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' },
			queryFactory: async start => {
				captured = start;
				await start.prompt[Symbol.asyncIterator]().next();
				return idleQuery(releases);
			},
		}));
		store.add({ dispose: () => releases.forEach(release => release()) });
		const requests: ClaudeTerminalRunRequest[] = [];
		store.add(service.onDidRequestTerminalRun(request => requests.push(request)));
		const cwd = workspace();
		const { sessionId } = await service.begin({ prompt: 'hi', cwd, mode: 'agent', workspaceFolders: [cwd], workspaceTrusted: true });
		await waitFor(() => !!captured);
		return { service, sessionId, requests, cwd, tool: () => captured!.options.terminalTool! };
	}

	test('the runtime asks the owning window and waits for its answer', async () => {
		const h = await openService();
		const pending = h.tool().run('gh auth login', 'Finish signing in to GitHub', undefined);
		await waitFor(() => h.requests.length === 1);
		assert.deepStrictEqual({ ...h.requests[0], requestId: typeof h.requests[0].requestId }, { sessionId: h.sessionId, requestId: 'string', command: 'gh auth login', reason: 'Finish signing in to GitHub', cwd: h.cwd });
		await h.service.resolveTerminalRun('other-session', h.requests[0].requestId, { kind: 'exited', exitCode: 9, lastOutput: '' });
		await h.service.resolveTerminalRun(h.sessionId, h.requests[0].requestId, { kind: 'exited', exitCode: 0, lastOutput: 'Logged in' });
		assert.deepStrictEqual(await pending, { kind: 'exited', exitCode: 0, lastOutput: 'Logged in' });
	});

	test('a stop or Claude Code cancelling the call ends the wait as cancelled', async () => {
		const h = await openService();
		const stopped = h.tool().run('sudo apt update', undefined, undefined);
		await waitFor(() => h.requests.length === 1);
		await h.service.interrupt(h.sessionId);
		assert.deepStrictEqual(await stopped, { kind: 'cancelled' });

		const abort = new AbortController();
		const aborted = h.tool().run('npm login', undefined, abort.signal);
		await waitFor(() => h.requests.length === 2);
		abort.abort();
		assert.deepStrictEqual(await aborted, { kind: 'cancelled' });
	});

	test('issue 1376: the review tools register only with a review host and call through to it', async () => {
		const runs: unknown[] = [];
		const review = {
			read: async () => undefined,
			write: async () => { },
			readFile: async () => undefined,
			writeFile: async () => false,
			store: async () => ({ open: [], sha: 'abc' }),
			run: async (args: unknown) => { runs.push(args); return { text: 'ran' }; },
		};
		const without = await klawly(undefined);
		const servers = await klawly(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, review);
		const quick = await handlers.get('run_review')!({}, {});
		await handlers.get('run_review')!({ base: ' develop ', depth: 'deep' }, {});
		const missing = await handlers.get('mark_addressed')!({ ids: ['x'] }, {});
		assert.deepStrictEqual({ without, servers, quick, runs, missing }, {
			without: undefined,
			servers: ['get_review_findings', 'mark_addressed', 'apply_suggestion', 'run_review'],
			quick: { content: [{ type: 'text', text: 'ran' }], isError: undefined },
			runs: [{ base: 'main', depth: 'quick' }, { base: 'develop', depth: 'deep' }],
			missing: { content: [{ type: 'text', text: 'There is no stored review for this checkout.' }], isError: true },
		});
	});
});

function idleQuery(releases: Array<() => void>): ClaudeQuery {
	let release: (() => void) | undefined;
	const done = new Promise<void>(resolve => {
		release = resolve;
		releases.push(resolve);
	});
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: 'system', subtype: 'init', slash_commands: [], skills: [], session_id: 'sdk-session' };
			await done;
		},
		interrupt: async () => release?.(),
		setModel: async () => undefined,
		supportedModels: async () => [],
		supportedCommands: async () => [],
		stopTask: async () => undefined,
		close: () => release?.(),
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > 5000) {
			assert.fail('condition was not met');
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}
