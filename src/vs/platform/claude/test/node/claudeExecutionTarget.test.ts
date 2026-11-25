/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { PassThrough } from 'stream';
import { isWindows } from '../../../../base/common/platform.js';
import { join } from '../../../../base/common/path.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_DELEGATE_TOOL_ID } from '../../common/claudeDelegate.js';
import { ClaudeCheckpointStore, RemoteSnapshotWriteRequest } from '../../common/claudeCheckpointStore.js';
import { readClaudeExecutionTarget } from '../../common/claudeExecutionTarget.js';
import { NormalizedClaudeEvent } from '../../common/claudeProtocol.js';
import { IClaudeRemoteFilesService } from '../../common/claudeRemoteFiles.js';
import { ClaudeAgentRunRequest, ClaudeAgentRunner, ClaudePermissionBridge } from '../../node/claudeAgentRunner.js';
import { buildClaudeInstallCommand, buildClaudeProbeCommands, buildClaudeSpawnCommand, buildDevContainerUpCommand, claudeContainerPathToLocal, ClaudeCommandResult, ClaudeExecutionTargetError, ClaudePreparedTarget, claudeRemoteEnvironment, ClaudeSpawnCommand, ClaudeTargetHost, createClaudeTargetSpawner, parseDevContainerUp, prepareClaudeExecutionTarget, withClaudeExecutionTarget } from '../../node/claudeExecutionTarget.js';
import { ClaudeProcessRegistry } from '../../node/claudeProcessRegistry.js';
import { ClaudeQuery, ClaudeQueryOptions } from '../../node/claudeQuery.js';

const FOLDER = isWindows ? 'C:\\work\\shop' : '/work/shop';

const HOST: ClaudeTargetHost = {
	env: { PATH: '/usr/bin', SSH_AUTH_SOCK: '/tmp/agent.sock', ANTHROPIC_API_KEY: 'sk-secret', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret', NODE_OPTIONS: '--inspect' },
	nodePath: '/opt/klawly/klawly',
	devContainerCliPath: '/opt/klawly/node_modules/@devcontainers/cli/devcontainer.js',
};

/** What the runtime hands the spawner: Claude Code's flags, with some that carry a local path. */
const CLI_SPAWN = {
	args: ['--output-format', 'stream-json', '--verbose', '--add-dir', '/home/me/notes', '--project-config-root=/home/me/shop', '--resume', 'it\'s-1'],
	cwd: join(FOLDER, 'web'),
	env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_CLIENT_APP: 'Klawly', DISABLE_TELEMETRY: '1', ANTHROPIC_API_KEY: 'sk-secret', PATH: '/usr/bin' },
};

const SSH: ClaudePreparedTarget = { kind: 'ssh', host: 'build-box', remotePath: '~/src/shop' };
const CONTAINER: ClaudePreparedTarget = { kind: 'devcontainer', workspaceFolder: FOLDER, remoteWorkspaceFolder: '/workspaces/shop' };

/** The local `ssh` and dev container CLI processes keep the agent socket, never a credential or Node debug option. */
const HOST_ENV = { PATH: '/usr/bin', SSH_AUTH_SOCK: '/tmp/agent.sock' };
const REMOTE_FLAGS = `'--output-format' 'stream-json' '--verbose' '--resume' 'it'\\''s-1'`;
const REMOTE_ENV = `CLAUDE_CODE_ENTRYPOINT='sdk-ts' CLAUDE_AGENT_SDK_CLIENT_APP='Klawly' DISABLE_TELEMETRY='1'`;

function results(...list: ClaudeCommandResult[]): { run: (command: ClaudeSpawnCommand) => Promise<ClaudeCommandResult>; ran: string[][] } {
	const ran: string[][] = [];
	return {
		ran,
		run: async command => {
			ran.push([command.command, ...command.args]);
			return list.shift() ?? { code: 1, stdout: '', stderr: 'unexpected command' };
		},
	};
}

const VERSION_OK: ClaudeCommandResult = { code: 0, stdout: '2.3.1 (Claude Code)\n', stderr: '' };
const AUTH_OK: ClaudeCommandResult = { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' };

async function failure(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return 'no error';
}

suite('claudeExecutionTarget', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('an SSH target runs claude on the host through the user\'s ssh, with no credential and no local path', () => {
		assert.deepStrictEqual(buildClaudeSpawnCommand(SSH, CLI_SPAWN, HOST), {
			command: 'ssh',
			args: ['-T', '-o', 'BatchMode=yes', '--', 'build-box', `cd ~/'src/shop' && exec env ${REMOTE_ENV} claude ${REMOTE_FLAGS}`],
			env: HOST_ENV,
		});
	});

	test('a dev container target runs claude through devcontainer exec, in the same folder inside the container', () => {
		assert.deepStrictEqual(buildClaudeSpawnCommand(CONTAINER, CLI_SPAWN, HOST), {
			command: '/opt/klawly/klawly',
			args: [HOST.devContainerCliPath, 'exec', '--workspace-folder', FOLDER, '/bin/sh', '-c', `cd '/workspaces/shop/web' && exec env ${REMOTE_ENV} claude ${REMOTE_FLAGS}`],
			env: { ...HOST_ENV, ELECTRON_RUN_AS_NODE: '1' },
		});
	});

	test('the probes run claude --version and claude auth status on the target; devcontainer up builds the workspace folder', () => {
		const ssh = buildClaudeProbeCommands({ kind: 'ssh', host: 'me@build-box' }, HOST);
		const container = buildClaudeProbeCommands(CONTAINER, HOST);
		assert.deepStrictEqual({
			ssh: [ssh.version.args, ssh.auth.args],
			container: [container.version.args.at(-1), container.auth.args.at(-1)],
			up: buildDevContainerUpCommand(FOLDER, HOST).args,
		}, {
			ssh: [['-T', '-o', 'BatchMode=yes', '--', 'me@build-box', `exec claude '--version'`], ['-T', '-o', 'BatchMode=yes', '--', 'me@build-box', `exec claude 'auth' 'status'`]],
			container: [`cd '/workspaces/shop' && exec claude '--version'`, `cd '/workspaces/shop' && exec claude 'auth' 'status'`],
			up: [HOST.devContainerCliPath, 'up', '--workspace-folder', FOLDER],
		});
	});

	test('reads devcontainer up\'s last JSON line', () => {
		assert.deepStrictEqual([
			parseDevContainerUp('[123 ms] Start: Run\n{"outcome":"success","containerId":"abc","remoteUser":"node","remoteWorkspaceFolder":"/workspaces/shop"}\n'),
			parseDevContainerUp('{"outcome":"error","message":"Dev container config not found."}'),
			parseDevContainerUp('no json'),
		], [{ outcome: 'success', remoteWorkspaceFolder: '/workspaces/shop' }, { outcome: 'error', error: 'Dev container config not found.' }, undefined]);
	});

	test('a target from IPC or storage must be well formed; an SSH host can never read as an option', () => {
		assert.deepStrictEqual([
			readClaudeExecutionTarget({ kind: 'devcontainer' }),
			readClaudeExecutionTarget({ kind: 'ssh', host: 'build-box', remotePath: '/srv/shop' }),
			readClaudeExecutionTarget({ kind: 'ssh', host: 'build-box', remotePath: '' }),
			readClaudeExecutionTarget({ kind: 'ssh', host: '-oProxyCommand=touch x' }),
			readClaudeExecutionTarget({ kind: 'ssh', host: 'build box' }),
			readClaudeExecutionTarget({ kind: 'ssh', host: 'build-box', remotePath: 'src/shop' }),
			readClaudeExecutionTarget({ kind: 'cloud' }),
		], [{ kind: 'devcontainer' }, { kind: 'ssh', host: 'build-box', remotePath: '/srv/shop' }, { kind: 'ssh', host: 'build-box' }, undefined, undefined, undefined, undefined]);
	});

	test('a host that answers both probes is ready; each failed probe says what to fix', async () => {
		const context = (run: (command: ClaudeSpawnCommand) => Promise<ClaudeCommandResult>) => ({ cwd: FOLDER, workspaceFolders: [FOLDER], trusted: true, host: HOST, run });
		const ready = results(VERSION_OK, AUTH_OK);
		const prepared = await prepareClaudeExecutionTarget({ kind: 'ssh', host: 'build-box', remotePath: '/srv/shop' }, context(ready.run));
		const unreachable = await failure(prepareClaudeExecutionTarget({ kind: 'ssh', host: 'build-box' }, context(results({ code: 255, stdout: '', stderr: 'ssh: Could not resolve hostname build-box\n' }).run)));
		const missing = await failure(prepareClaudeExecutionTarget({ kind: 'ssh', host: 'build-box' }, context(results({ code: 127, stdout: '', stderr: 'sh: 1: claude: not found' }).run)));
		const signedOut = await failure(prepareClaudeExecutionTarget({ kind: 'ssh', host: 'build-box' }, context(results(VERSION_OK, { code: 1, stdout: '{"loggedIn":false}', stderr: '' }).run)));
		assert.deepStrictEqual({ prepared, probes: ready.ran.length, unreachable, missing, signedOut }, {
			prepared: { kind: 'ssh', host: 'build-box', remotePath: '/srv/shop' },
			probes: 2,
			unreachable: 'Klawly could not connect to build-box over SSH: ssh: Could not resolve hostname build-box. Klawly uses your own SSH config and keys; check that ssh build-box works in a terminal without a password prompt.',
			missing: 'Claude Code is not installed in build-box. Install it there (curl -fsSL https://claude.ai/install.sh | bash, or npm install -g @anthropic-ai/claude-code), then start the session again.',
			signedOut: 'Claude Code in build-box has no account yet. Run claude there once and log in; Klawly never sends your Claude credentials to another machine.',
		});
	});

	test('a dev container is built only in a trusted workspace, then probed inside', async () => {
		const untrusted = results();
		const refused = await failure(prepareClaudeExecutionTarget({ kind: 'devcontainer' }, { cwd: FOLDER, workspaceFolders: [FOLDER], trusted: false, host: HOST, run: untrusted.run }));
		const trusted = results({ code: 0, stdout: '{"outcome":"success","remoteWorkspaceFolder":"/workspaces/shop"}', stderr: '' }, VERSION_OK, AUTH_OK);
		const prepared = await prepareClaudeExecutionTarget({ kind: 'devcontainer' }, { cwd: join(FOLDER, 'web'), workspaceFolders: [FOLDER], trusted: true, host: HOST, run: trusted.run });
		const local = await prepareClaudeExecutionTarget({ kind: 'worktree' }, { cwd: FOLDER, workspaceFolders: [FOLDER], trusted: true, host: HOST, run: untrusted.run });
		assert.deepStrictEqual({ refused, ranUntrusted: untrusted.ran.length, prepared, firstCommand: trusted.ran[0].slice(2), local }, {
			refused: 'Trust this workspace before Klawly builds its dev container.',
			ranUntrusted: 0,
			prepared: CONTAINER,
			firstCommand: ['up', '--workspace-folder', FOLDER],
			local: undefined,
		});
	});

	test('the spawner hands back the child and drains stderr', () => {
		const spawned: { command: string; args: readonly string[] }[] = [];
		const logged: string[] = [];
		const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcessWithoutNullStreams;
		const spawner = createClaudeTargetSpawner(SSH, HOST, line => logged.push(line), (command, args, options) => {
			spawned.push({ command, args });
			return child;
		});
		const process = spawner({ args: ['--output-format', 'stream-json'], env: {} });
		child.stderr.emit('data', Buffer.from('Warning: Permanently added build-box\n'));
		assert.deepStrictEqual({ same: process === child, command: spawned[0].command, logged }, {
			same: true,
			command: 'ssh',
			logged: ['[ssh] Warning: Permanently added build-box'],
		});
	});

	test('a missing Claude Code carries the installer for a visible terminal; an unreachable host does not', async () => {
		const context = (run: (command: ClaudeSpawnCommand) => Promise<ClaudeCommandResult>) => ({ cwd: FOLDER, workspaceFolders: [FOLDER], trusted: true, host: HOST, run });
		const thrown = async (promise: Promise<unknown>) => {
			try {
				await promise;
			} catch (error) {
				return error instanceof ClaudeExecutionTargetError ? { reason: error.reason, install: error.install } : undefined;
			}
			return undefined;
		};
		const script = 'curl -fsSL https://claude.ai/install.sh | bash';
		assert.deepStrictEqual({
			missing: await thrown(prepareClaudeExecutionTarget({ kind: 'ssh', host: 'build-box' }, context(results({ code: 127, stdout: '', stderr: 'sh: 1: claude: not found' }).run))),
			unreachable: await thrown(prepareClaudeExecutionTarget({ kind: 'ssh', host: 'build-box' }, context(results({ code: 255, stdout: '', stderr: 'ssh: connect to host build-box port 22: Connection refused' }).run))),
			container: buildClaudeInstallCommand(CONTAINER, HOST),
		}, {
			missing: { reason: 'missing', install: { where: 'build-box', executable: 'ssh', args: ['-t', '--', 'build-box', script], display: script } },
			unreachable: { reason: 'unreachable', install: undefined },
			container: { where: 'the dev container', executable: HOST.nodePath, args: [HOST.devContainerCliPath, 'exec', '--workspace-folder', FOLDER, '/bin/sh', '-c', script], env: { ELECTRON_RUN_AS_NODE: '1' }, display: script },
		});
	});

	test('a remote target gets the OpenTelemetry variables only when Klawly turned telemetry on', () => {
		const otel = { OTEL_METRICS_EXPORTER: 'otlp', OTEL_LOGS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4317', OTEL_EXPORTER_OTLP_HEADERS: 'x-team=shop' };
		assert.deepStrictEqual({
			on: claudeRemoteEnvironment({ ...CLI_SPAWN.env, CLAUDE_CODE_ENABLE_TELEMETRY: '1', ...otel }),
			off: claudeRemoteEnvironment({ ...CLI_SPAWN.env, ...otel }),
		}, {
			on: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_CLIENT_APP: 'Klawly', DISABLE_TELEMETRY: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '1', ...otel },
			off: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_CLIENT_APP: 'Klawly', DISABLE_TELEMETRY: '1' },
		});
	});

	test('the OTLP headers never go on a command line: the remote shell reads them from stdin before it starts claude', () => {
		const headers = 'Authorization=Bearer tok-123';
		const env = { ...CLI_SPAWN.env, CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4317', OTEL_EXPORTER_OTLP_HEADERS: headers };
		const ssh = buildClaudeSpawnCommand(SSH, { ...CLI_SPAWN, env }, HOST);
		const container = buildClaudeSpawnCommand(CONTAINER, { ...CLI_SPAWN, env }, HOST);
		const read = `IFS= read -r OTEL_EXPORTER_OTLP_HEADERS && export OTEL_EXPORTER_OTLP_HEADERS`;
		const run = `exec env ${REMOTE_ENV} CLAUDE_CODE_ENABLE_TELEMETRY='1' OTEL_EXPORTER_OTLP_ENDPOINT='http://collector:4317' claude ${REMOTE_FLAGS}`;
		assert.deepStrictEqual({
			onCommandLine: [ssh, container].some(command => [command.command, ...command.args, ...Object.values(command.env)].some(part => part.includes('tok-123'))),
			ssh: [ssh.args.at(-1), ssh.stdin],
			container: [container.args.at(-1), container.stdin],
			multiline: claudeRemoteEnvironment({ ...env, OTEL_EXPORTER_OTLP_HEADERS: `${headers}\nx=y` }).OTEL_EXPORTER_OTLP_HEADERS,
		}, {
			onCommandLine: false,
			ssh: [`cd ~/'src/shop' && ${read} && ${run}`, `${headers}\n`],
			container: [`cd '/workspaces/shop/web' && ${read} && ${run}`, `${headers}\n`],
			multiline: undefined,
		});
	});

	test('the spawner writes the secrets to stdin before the runtime writes anything', () => {
		const stdin = new PassThrough();
		const child = Object.assign(new EventEmitter(), { stdin, stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcessWithoutNullStreams;
		const spawner = createClaudeTargetSpawner(SSH, HOST, undefined, () => child);
		const process = spawner({ args: ['--output-format', 'stream-json'], env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_HEADERS: 'x-token=abc' } });
		process.stdin.write('{"type":"user"}\n');
		assert.strictEqual(String(stdin.read()), 'x-token=abc\n{"type":"user"}\n');
	});

	test('a POSIX shell reads the secret line and leaves the rest of stdin to claude', async () => {
		if (isWindows) {
			// The remote side is always a POSIX shell; this machine has none to run it.
			return;
		}
		const bin = await fs.mkdtemp(join(tmpdir(), 'klawly-target-'));
		try {
			await fs.writeFile(join(bin, 'claude'), `#!/bin/sh\nprintf '%s|%s|' "$OTEL_EXPORTER_OTLP_HEADERS" "$CLAUDE_CODE_ENABLE_TELEMETRY"\ncat\n`, { mode: 0o755 });
			const command = buildClaudeSpawnCommand({ kind: 'ssh', host: 'build-box' }, { ...CLI_SPAWN, env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer it\'s $HOME' } }, HOST);
			const shell = spawn('/bin/sh', ['-c', command.args.at(-1)!], { env: { PATH: `${bin}:/usr/bin:/bin` } });
			let stdout = '';
			shell.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk); });
			const closed = new Promise(resolve => shell.on('close', resolve));
			shell.stdin.end(`${command.stdin}{"type":"user"}\n`);
			await closed;
			assert.strictEqual(stdout, `Authorization=Bearer it's $HOME|1|{"type":"user"}\n`);
		} finally {
			await fs.rm(bin, { recursive: true, force: true });
		}
	});

	test('the bridge token never goes on the remote command line: the config documents travel on stdin into a private file', async () => {
		const mcp = JSON.stringify({ mcpServers: { klawly: { type: 'http', url: 'http://127.0.0.1:4000/mcp/tok-secret' } } });
		const settings = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:4000/hook/tok-secret/PreToolUse' }] }] } });
		const command = buildClaudeSpawnCommand({ kind: 'ssh', host: 'build-box' }, { ...CLI_SPAWN, args: ['--output-format', 'stream-json', '--settings', settings, '--mcp-config', mcp], env: {} }, HOST);
		assert.deepStrictEqual({
			onCommandLine: [command.command, ...command.args].some(part => part.includes('tok-secret')),
			stdin: command.stdin,
			remote: /'--settings' "\$d\/0" '--mcp-config' "\$d\/1"/.test(command.args.at(-1)!),
		}, { onCommandLine: false, stdin: `${settings}\n${mcp}\n`, remote: true });
		if (isWindows) {
			return;
		}
		const bin = await fs.mkdtemp(join(tmpdir(), 'klawly-target-'));
		try {
			await fs.writeFile(join(bin, 'claude'), `#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in --settings|--mcp-config) printf '%s:%s:%s\\n' "$1" "$(stat -c %a "$2" 2>/dev/null || stat -f %Lp "$2")" "$(cat "$2" | cut -c1-12)"; echo "$2" >> "$0.paths";; esac; shift; done\ncat\n`, { mode: 0o755 });
			const shell = spawn('/bin/sh', ['-c', command.args.at(-1)!], { env: { PATH: `${bin}:/usr/bin:/bin` } });
			let stdout = '';
			shell.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk); });
			const closed = new Promise(resolve => shell.on('close', resolve));
			shell.stdin.end(`${command.stdin}{"type":"user"}\n`);
			await closed;
			const paths = (await fs.readFile(join(bin, 'claude.paths'), 'utf8')).trim().split('\n');
			const gone = await Promise.all(paths.map(path => fs.access(path).then(() => false, () => true)));
			assert.deepStrictEqual({ stdout, gone }, { stdout: `--settings:600:{"hooks":{"P\n--mcp-config:600:{"mcpServers\n{"type":"user"}\n`, gone: [true, true] });
		} finally {
			await fs.rm(bin, { recursive: true, force: true });
		}
	});

	test('a container path under the workspace mount is the same file here; anything else has no local copy', () => {
		assert.deepStrictEqual([
			claudeContainerPathToLocal(CONTAINER, '/workspaces/shop/web/a.ts'),
			claudeContainerPathToLocal(CONTAINER, '/workspaces/shop'),
			claudeContainerPathToLocal(CONTAINER, '/workspaces/shop/../other/a.ts'),
			claudeContainerPathToLocal(CONTAINER, '/workspaces/shopping/a.ts'),
			claudeContainerPathToLocal(CONTAINER, '/etc/hosts'),
			claudeContainerPathToLocal(CONTAINER, 'web/a.ts'),
		], [join(FOLDER, 'web', 'a.ts'), FOLDER, undefined, undefined, undefined, undefined]);
	});

	test('session.started names the target; other events and subagents are left alone', () => {
		const started: NormalizedClaudeEvent = { type: 'session.started', sessionId: 's1' };
		assert.deepStrictEqual([
			withClaudeExecutionTarget(started, { kind: 'ssh', host: 'build-box' }),
			withClaudeExecutionTarget({ ...started, parentRunId: 'r1' }, { kind: 'devcontainer' }),
			withClaudeExecutionTarget(started, undefined),
		], [
			{ type: 'session.started', sessionId: 's1', target: { kind: 'ssh', label: 'build-box' } },
			{ type: 'session.started', sessionId: 's1', parentRunId: 'r1' },
			started,
		]);
	});
});

suite('claudeExecutionTarget runner', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function answeringQuery(beforeResult: () => Promise<void> = async () => undefined): ClaudeQuery {
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: 'system', subtype: 'init', session_id: 'sdk-session', model: 'claude-test' };
				await beforeResult();
				yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sdk-session' };
			},
			interrupt: async () => undefined,
			setModel: async () => undefined,
			supportedModels: async () => [],
			supportedCommands: async () => [],
			stopTask: async () => undefined,
			close: () => undefined,
		};
	}

	interface RunOptions {
		/** Files the agent writes after init, each approved by the user. */
		readonly writes?: readonly string[];
		readonly checkpoints?: ClaudeCheckpointStore;
		readonly remoteFiles?: Pick<IClaudeRemoteFilesService, 'readFile'>;
		/** Starts the runner with a delegate request, so the session has the delegate tool. */
		readonly delegate?: boolean;
	}

	async function run(request: Partial<ClaudeAgentRunRequest>, commands: ClaudeCommandResult[], options: RunOptions = {}): Promise<{ events: NormalizedClaudeEvent[]; opened: (ClaudeQueryOptions['executionTarget'] | 'none')[]; resumed: (string | undefined)[]; logged: string[]; prompts: (string | undefined)[]; plugins: (readonly string[] | undefined)[] }> {
		const registry = store.add(new ClaudeProcessRegistry());
		const events: NormalizedClaudeEvent[] = [];
		const opened: (ClaudeQueryOptions['executionTarget'] | 'none')[] = [];
		const resumed: (string | undefined)[] = [];
		const logged: string[] = [];
		const prompts: (string | undefined)[] = [];
		const plugins: (readonly string[] | undefined)[] = [];
		const bridge: ClaudePermissionBridge = { request: async () => options.writes ? { behavior: 'allow' } : { behavior: 'deny', message: 'test' } };
		const runner = store.add(new ClaudeAgentRunner({
			registry,
			timeoutMs: 5000,
			queryFactory: async start => {
				opened.push(start.options.executionTarget ?? 'none');
				resumed.push(start.options.resume);
				prompts.push(start.options.systemPrompt);
				plugins.push(start.options.plugins);
				await start.prompt[Symbol.asyncIterator]().next();
				return answeringQuery(async () => {
					for (const [index, file] of (options.writes ?? []).entries()) {
						await start.options.canUseTool('Write', { file_path: file, content: 'after' }, { signal: new AbortController().signal, toolUseID: `write-${index}` });
					}
				});
			},
			executionTargetHost: HOST,
			runTargetCommand: results(...commands).run,
			checkpoints: options.checkpoints,
			remoteFiles: options.remoteFiles,
			delegateRequest: options.delegate ? async () => ({ kind: 'stopped' }) : undefined,
			log: line => logged.push(line),
		}));
		for await (const event of runner.start({ sessionId: 's1', prompt: 'hi', cwd: FOLDER, mode: 'agent', workspaceTrusted: true, permissionBridge: bridge, ...request })) {
			events.push(event);
			if (event.type === 'session.completed' || event.type === 'session.failed') {
				break;
			}
		}
		return { events, opened, resumed, logged, prompts, plugins };
	}

	/** A checkpoint store that records what the runner captured, in order. */
	function recordingCheckpoints(): { checkpoints: ClaudeCheckpointStore; calls: unknown[] } {
		const calls: unknown[] = [];
		const checkpoints = {
			beginTurn: async () => undefined,
			garbageCollect: async () => undefined,
			snapshotApprovedWrite: async (input: { absolutePath: string }) => { calls.push(['local', input.absolutePath]); },
			noteAfterWrite: async (_sessionId: string, absolutePath: string) => { calls.push(['local after', absolutePath]); },
			snapshotRemoteWrite: async (input: RemoteSnapshotWriteRequest) => { calls.push(['remote', input.uri, input.bytes && VSBuffer.wrap(input.bytes).toString()]); },
			noteRemoteAfterWrite: async (_sessionId: string, uri: string, bytes: Uint8Array | null) => { calls.push(['remote after', uri, bytes && VSBuffer.wrap(bytes).toString()]); },
		} as unknown as ClaudeCheckpointStore;
		return { checkpoints, calls };
	}

	test('a failed probe stops the session with its message before Claude Code starts', async () => {
		const { events, opened } = await run({ executionTarget: { kind: 'ssh', host: 'build-box' } }, [{ code: 127, stdout: '', stderr: 'claude: command not found' }]);
		const failed = events.find(event => event.type === 'session.failed');
		const script = 'curl -fsSL https://claude.ai/install.sh | bash';
		assert.deepStrictEqual({ opened, failed: failed?.type === 'session.failed' ? { message: failed.message, install: failed.targetInstall } : undefined }, {
			opened: [],
			failed: {
				message: 'Claude Code is not installed in build-box. Install it there (curl -fsSL https://claude.ai/install.sh | bash, or npm install -g @anthropic-ai/claude-code), then start the session again.',
				install: { where: 'build-box', executable: 'ssh', args: ['-t', '--', 'build-box', script], display: script },
			},
		});
	});

	test('a remote session learns to delegate from its system prompt, since the bundled plugin cannot reach the host (issue 1406)', async () => {
		const remote = await run({ executionTarget: { kind: 'ssh', host: 'build-box' } }, [VERSION_OK, AUTH_OK], { delegate: true });
		const remoteWithout = await run({ executionTarget: { kind: 'ssh', host: 'build-box' } }, [VERSION_OK, AUTH_OK]);
		assert.deepStrictEqual({
			guided: remote.prompts.map(prompt => !!prompt?.includes(CLAUDE_DELEGATE_TOOL_ID)),
			plugins: remote.plugins,
			withoutTool: remoteWithout.prompts.map(prompt => !!prompt?.includes(CLAUDE_DELEGATE_TOOL_ID)),
		}, { guided: [true], plugins: [undefined], withoutTool: [false] });
	});

	test('a ready host opens the query on it, and session.started names it', async () => {
		const { events, opened } = await run({ executionTarget: { kind: 'ssh', host: 'build-box' } }, [VERSION_OK, AUTH_OK]);
		const started = events.find(event => event.type === 'session.started');
		assert.deepStrictEqual({ opened, target: started?.type === 'session.started' ? started.target : undefined }, {
			opened: [{ kind: 'ssh', host: 'build-box', remotePath: undefined }],
			target: { kind: 'ssh', label: 'build-box' },
		});
	});

	test('a resumed agent whose host is gone runs here in a new conversation, and says so once', async () => {
		const { events, opened, resumed } = await run({ executionTarget: { kind: 'ssh', host: 'build-box' }, resumeSessionId: 'old-sdk-session' }, [{ code: 255, stdout: '', stderr: 'ssh: connect to host build-box port 22: Connection refused\n' }]);
		const started = events.find(event => event.type === 'session.started');
		assert.deepStrictEqual({ opened, resumed, target: started?.type === 'session.started' ? started.target : undefined }, {
			opened: ['none'],
			resumed: [undefined],
			target: {
				kind: 'local',
				label: 'Local',
				notice: 'build-box is not reachable, so this agent now runs on this computer in a new Claude Code conversation. Its earlier conversation stays on build-box. Klawly could not connect to build-box over SSH: ssh: connect to host build-box port 22: Connection refused. Klawly uses your own SSH config and keys; check that ssh build-box works in a terminal without a password prompt.',
			},
		});
	});

	test('a new agent on an unreachable host fails instead of moving here', async () => {
		const { events, opened } = await run({ executionTarget: { kind: 'ssh', host: 'build-box' } }, [{ code: 255, stdout: '', stderr: 'ssh: connect to host build-box port 22: Connection refused\n' }]);
		assert.deepStrictEqual({ opened, failed: events.some(event => event.type === 'session.failed') }, { opened: [], failed: true });
	});

	test('an approved write on an SSH host is captured there, before and after, under its claude-remote uri', async () => {
		const { checkpoints, calls } = recordingCheckpoints();
		const reads: string[] = [];
		const remoteFiles: Pick<IClaudeRemoteFilesService, 'readFile'> = {
			readFile: async (host, path) => {
				reads.push(`${host}:${path}`);
				return path === '/srv/shop/new.ts' && reads.length < 3 ? undefined : VSBuffer.fromString(reads.length < 3 ? 'before' : 'after');
			},
		};
		await run({ executionTarget: { kind: 'ssh', host: 'build-box', remotePath: '/srv/shop' } }, [VERSION_OK, AUTH_OK], { writes: ['/srv/shop/src/a.ts', '/srv/shop/new.ts'], checkpoints, remoteFiles });
		// The after-write reads finish when the query ends, which can be just after `session.completed`.
		for (let attempt = 0; calls.length < 4 && attempt < 200; attempt++) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		assert.deepStrictEqual(calls, [
			['remote', 'claude-remote://build-box/srv/shop/src/a.ts', 'before'],
			['remote', 'claude-remote://build-box/srv/shop/new.ts', null],
			['remote after', 'claude-remote://build-box/srv/shop/src/a.ts', 'after'],
			['remote after', 'claude-remote://build-box/srv/shop/new.ts', 'after'],
		]);
	});

	test('in a dev container a write under the workspace mount is captured on this disk; one outside it is not', async () => {
		const { checkpoints, calls } = recordingCheckpoints();
		const { logged } = await run({ executionTarget: { kind: 'devcontainer' } }, [{ code: 0, stdout: '{"outcome":"success","remoteWorkspaceFolder":"/workspaces/shop"}', stderr: '' }, VERSION_OK, AUTH_OK], { writes: ['/workspaces/shop/web/a.ts', '/tmp/out.txt'], checkpoints });
		for (let attempt = 0; calls.length < 2 && attempt < 200; attempt++) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		assert.deepStrictEqual({ calls, logged: logged.filter(line => line.startsWith('Not capturing')) }, {
			calls: [['local', join(FOLDER, 'web', 'a.ts')], ['local after', join(FOLDER, 'web', 'a.ts')]],
			logged: ['Not capturing Write on devcontainer: /tmp/out.txt has no copy Klawly can restore.'],
		});
	});
});
