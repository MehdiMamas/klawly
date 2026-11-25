/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { isEqualOrParent } from '../../../base/common/extpath.js';
import { join, posix, relative, sep } from '../../../base/common/path.js';
import { localize } from '../../../nls.js';
import { getAppNodeModulesUri } from '../../agentHost/node/appNodeModules.js';
import { ClaudeExecutionTarget, claudeExecutionTargetInfo, ClaudeTargetInstall } from '../common/claudeExecutionTarget.js';
import { NormalizedClaudeEvent } from '../common/claudeProtocol.js';
import { parseAuthStatus } from './claudeRuntime.js';

/**
 * A target the runtime has prepared: the dev container is up, or the SSH host
 * answered `claude --version` and the auth probe. `local` and `worktree` need no
 * preparation and run Claude Code on this machine.
 */
export type ClaudePreparedTarget =
	| {
		readonly kind: 'devcontainer';
		/** The local folder `devcontainer up` ran for. */
		readonly workspaceFolder: string;
		/** The same folder inside the container. */
		readonly remoteWorkspaceFolder: string;
	}
	| { readonly kind: 'ssh'; readonly host: string; readonly remotePath?: string };

/** How Claude Code is to start: its flags, folder and variables. */
export interface ClaudeSpawnOptions {
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** A local port the remote process reaches on its own loopback (SSH `-R`), for Klawly's tool server. */
	readonly forwardPort?: number;
}

/** One process to start: Claude Code itself, a probe, or `devcontainer up`. */
export interface ClaudeSpawnCommand {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env: Readonly<Record<string, string>>;
	/** Written to the process's stdin before anything else: the secret values and JSON documents the remote shell reads before it starts claude. */
	readonly stdin?: string;
}

/** What the builders need from this machine. Injected so tests never read the real environment. */
export interface ClaudeTargetHost {
	/** This process's environment, for the local `ssh` and dev container CLI processes. */
	readonly env: NodeJS.ProcessEnv;
	/** Runs the dev container CLI as Node (`ELECTRON_RUN_AS_NODE`). */
	readonly nodePath: string;
	/** `@devcontainers/cli`'s `devcontainer.js`, the copy upstream ships. */
	readonly devContainerCliPath: string;
}

export interface ClaudeCommandResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** Runs one command to completion. Injected so tests never start a process. */
export type ClaudeCommandRunner = (command: ClaudeSpawnCommand, timeoutMs: number) => Promise<ClaudeCommandResult>;

export interface ClaudePrepareTargetContext {
	readonly cwd: string;
	readonly workspaceFolders: readonly string[];
	readonly trusted: boolean;
	readonly host: ClaudeTargetHost;
	readonly run: ClaudeCommandRunner;
}

/**
 * A target that could not be prepared. The message says what to fix, and the
 * session stops with it. `unreachable` means the host or the container is
 * gone; `install` is set when the target has no Claude Code yet.
 */
export class ClaudeExecutionTargetError extends Error {
	constructor(message: string, readonly reason?: 'unreachable' | 'missing', readonly install?: ClaudeTargetInstall) {
		super(message);
	}
}

/** The official installer for Linux and macOS, the same one Klawly's own setup runs (`claudeInstallerCommand`). */
const CLAUDE_INSTALL_SCRIPT = 'curl -fsSL https://claude.ai/install.sh | bash';

const PROBE_TIMEOUT_MS = 30_000;
const DEV_CONTAINER_UP_TIMEOUT_MS = 15 * 60_000;

/**
 * Claude Code variables a remote process gets. Never a credential: the host or
 * the container signs in itself (issue 425, Security).
 */
const REMOTE_ENV_ALLOWLIST: readonly string[] = [
	'CLAUDE_CODE_ENTRYPOINT',
	'CLAUDE_AGENT_SDK_CLIENT_APP',
	'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
	'DISABLE_TELEMETRY',
	'DISABLE_ERROR_REPORTING',
	'DISABLE_AUTOUPDATER',
];

/**
 * Claude Code's OpenTelemetry variables. A remote process gets them only when
 * Klawly's export setting turned telemetry on (`otelEnvironment`), so the
 * host reports to the same collector.
 */
const REMOTE_OTEL_ENV: readonly string[] = [
	'CLAUDE_CODE_ENABLE_TELEMETRY',
	'OTEL_METRICS_EXPORTER',
	'OTEL_LOGS_EXPORTER',
	'OTEL_EXPORTER_OTLP_PROTOCOL',
	'OTEL_EXPORTER_OTLP_ENDPOINT',
	'OTEL_EXPORTER_OTLP_HEADERS',
];

/**
 * Remote variables that can hold a secret: OTLP headers often carry an auth
 * token. They never go on a command line, where `ps` shows them to every user
 * of this machine and of the host; the remote shell reads them from stdin, one
 * line each, before it starts claude.
 */
const REMOTE_SECRET_ENV: ReadonlySet<string> = new Set(['OTEL_EXPORTER_OTLP_HEADERS']);

/** Names removed from the local `ssh` and dev container CLI processes, so no SSH `SendEnv` or container setting can carry them. */
const CREDENTIAL_ENV = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_API_KEY|CLAUDE_CONFIG_DIR$|AWS_BEARER_TOKEN_BEDROCK$)/;

/** CLI flags whose value is a path on this machine, which means nothing on the target. */
const LOCAL_PATH_FLAGS: ReadonlySet<string> = new Set(['--add-dir', '--debug-file', '--plugin-dir', '--plugin-dir-no-mcp']);
const LOCAL_PATH_FLAG_PREFIXES: readonly string[] = ['--project-config-root='];

export function defaultClaudeTargetHost(): ClaudeTargetHost {
	return {
		env: process.env,
		nodePath: process.execPath,
		devContainerCliPath: join(getAppNodeModulesUri().fsPath, '@devcontainers', 'cli', 'devcontainer.js'),
	};
}

/**
 * Claude Code's flags from its spawn arguments, which may start with the local
 * executable; the flags start at the first `-`. Flags that carry a local path
 * are dropped.
 */
export function claudeCliArguments(args: readonly string[]): string[] {
	const start = args.findIndex(arg => arg.startsWith('-'));
	if (start < 0) {
		return [];
	}
	const flags: string[] = [];
	for (let index = start; index < args.length; index++) {
		const arg = args[index];
		if (LOCAL_PATH_FLAGS.has(arg)) {
			index++;
			continue;
		}
		if (LOCAL_PATH_FLAG_PREFIXES.some(prefix => arg.startsWith(prefix))) {
			continue;
		}
		flags.push(arg);
	}
	return flags;
}

/** The variables a remote Claude Code process gets: only names on the allowlist, never a credential. */
export function claudeRemoteEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const remote: Record<string, string> = {};
	const names = env.CLAUDE_CODE_ENABLE_TELEMETRY === '1' ? [...REMOTE_ENV_ALLOWLIST, ...REMOTE_OTEL_ENV] : REMOTE_ENV_ALLOWLIST;
	for (const name of names) {
		const value = env[name];
		// A secret travels as one stdin line, so a value with a line break is dropped.
		if (typeof value === 'string' && value.length > 0 && !(REMOTE_SECRET_ENV.has(name) && /[\r\n]/.test(value))) {
			remote[name] = value;
		}
	}
	return remote;
}

/** This machine's environment for `ssh` or the dev container CLI, without Claude credentials or Node debug options. */
export function claudeHostEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
	const host: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (typeof value === 'string' && !CREDENTIAL_ENV.test(name) && name !== 'NODE_OPTIONS' && name !== 'VSCODE_INSPECTOR_OPTIONS' && name !== 'ELECTRON_RUN_AS_NODE') {
			host[name] = value;
		}
	}
	return host;
}

/** POSIX single-quote escaping for a remote shell. */
export function claudeShellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `cd` into a remote folder. `~` stays outside the quotes so the remote shell expands it. */
function remoteChangeDirectory(folder: string | undefined): string | undefined {
	if (!folder) {
		return undefined;
	}
	if (folder === '~') {
		return 'cd ~';
	}
	if (folder.startsWith('~/')) {
		return `cd ~/${claudeShellQuote(folder.slice(2))}`;
	}
	return `cd ${claudeShellQuote(folder)}`;
}

/** Flags whose inline JSON holds the bridge's secret URL, so it never goes on a command line. */
const REMOTE_DOCUMENT_FLAGS: ReadonlySet<string> = new Set(['--mcp-config', '--settings']);
const DOCUMENT_PLACEHOLDER = /^\0document(?<index>\d+)$/;

/**
 * Splits the inline JSON of `--mcp-config` and `--settings` out of the flags:
 * `ps` on the target shows every argument, and these carry the bridge token.
 * The documents travel on stdin and the flags point at a private file instead.
 */
function claudeRemoteDocuments(flags: readonly string[]): { readonly flags: string[]; readonly documents: string[] } {
	const documents: string[] = [];
	const moved = flags.map((flag, index) => {
		if (index > 0 && REMOTE_DOCUMENT_FLAGS.has(flags[index - 1]) && flag.startsWith('{')) {
			documents.push(flag);
			return `\0document${documents.length - 1}`;
		}
		return flag;
	});
	return { flags: moved, documents };
}

/**
 * One remote shell line: `cd <folder> && exec env K=V claude <flags>`. A secret
 * variable is read from stdin instead (`IFS= read -r K && export K`); `read`
 * takes one byte at a time from a pipe, so claude gets the rest of stdin.
 * Documents (one compact JSON line each, after the secrets) are written to a
 * private temp folder that the shell removes when claude ends; the shell then
 * stays as claude's parent instead of exec-ing it.
 */
export function claudeRemoteCommandLine(folder: string | undefined, env: Readonly<Record<string, string>>, args: readonly string[], documentCount = 0): string {
	const entries = Object.entries(env);
	const reads = entries.filter(([name]) => REMOTE_SECRET_ENV.has(name)).map(([name]) => `IFS= read -r ${name} && export ${name}`);
	const assignments = entries.filter(([name]) => !REMOTE_SECRET_ENV.has(name)).map(([name, value]) => `${name}=${claudeShellQuote(value)}`);
	const quoted = args.map(arg => {
		const document = DOCUMENT_PLACEHOLDER.exec(arg)?.groups?.index;
		return document !== undefined ? `"$d/${document}"` : claudeShellQuote(arg);
	});
	const program = ['claude', ...quoted];
	const cd = remoteChangeDirectory(folder);
	if (documentCount === 0) {
		const run = ['exec', ...assignments.length > 0 ? ['env', ...assignments] : [], ...program].join(' ');
		return [...cd ? [cd] : [], ...reads, run].join(' && ');
	}
	const writes = Array.from({ length: documentCount }, (_, index) => `IFS= read -r l && printf '%s' "$l" > "$d/${index}"`);
	const run = [...assignments.length > 0 ? ['env', ...assignments] : [], ...program].join(' ');
	const cleanup = `trap 'rm -rf "$d"' EXIT && trap 'exit 143' HUP INT TERM`;
	return [...cd ? [cd] : [], ...reads, 'umask 077', 'd=$(mktemp -d)', cleanup, ...writes, run].join(' && ');
}

/** The secret values and documents `claudeRemoteCommandLine` reads, one line each, in the same order. */
function claudeRemoteStdin(env: Readonly<Record<string, string>>, documents: readonly string[] = []): string | undefined {
	const lines = [...Object.entries(env).filter(([name]) => REMOTE_SECRET_ENV.has(name)).map(([, value]) => value), ...documents].map(value => `${value.replace(/[\r\n]+/g, ' ')}\n`);
	return lines.length > 0 ? lines.join('') : undefined;
}

/** The session folder inside the container: the same path under the container's workspace folder. */
export function claudeContainerFolder(target: Extract<ClaudePreparedTarget, { kind: 'devcontainer' }>, cwd: string | undefined): string {
	if (!cwd || !isEqualOrParent(cwd, target.workspaceFolder, process.platform !== 'linux')) {
		return target.remoteWorkspaceFolder;
	}
	const inner = relative(target.workspaceFolder, cwd).split(sep).filter(part => part.length > 0);
	return inner.length > 0 ? posix.join(target.remoteWorkspaceFolder, ...inner) : target.remoteWorkspaceFolder;
}

/** `ssh` for one remote shell line, with the user's own config and keys and never a prompt. */
export function claudeSshCommand(host: string, remoteLine: string, env: NodeJS.ProcessEnv, forwardPort?: number): ClaudeSpawnCommand {
	// BatchMode: no password or host-key prompt can hang a process with no terminal.
	// `--` ends ssh's options, so the host can never read as one.
	// `-R` lets the remote claude reach Klawly's tool server on this machine's loopback.
	const forward = forwardPort ? ['-o', 'ExitOnForwardFailure=yes', '-R', `127.0.0.1:${forwardPort}:127.0.0.1:${forwardPort}`] : [];
	return { command: 'ssh', args: ['-T', '-o', 'BatchMode=yes', ...forward, '--', host, remoteLine], env: claudeHostEnvironment(env) };
}

function devContainerCommand(host: ClaudeTargetHost, args: readonly string[]): ClaudeSpawnCommand {
	return { command: host.nodePath, args: [host.devContainerCliPath, ...args], env: { ...claudeHostEnvironment(host.env), ELECTRON_RUN_AS_NODE: '1' } };
}

function devContainerExec(target: Extract<ClaudePreparedTarget, { kind: 'devcontainer' }>, host: ClaudeTargetHost, remoteLine: string): ClaudeSpawnCommand {
	return devContainerCommand(host, ['exec', '--workspace-folder', target.workspaceFolder, '/bin/sh', '-c', remoteLine]);
}

/** How Claude Code starts on a prepared target. */
export function buildClaudeSpawnCommand(target: ClaudePreparedTarget, options: ClaudeSpawnOptions, host: ClaudeTargetHost): ClaudeSpawnCommand {
	const { flags, documents } = claudeRemoteDocuments(claudeCliArguments(options.args));
	const env = claudeRemoteEnvironment(options.env);
	const command = target.kind === 'ssh'
		? claudeSshCommand(target.host, claudeRemoteCommandLine(target.remotePath, env, flags, documents.length), host.env, options.forwardPort)
		: devContainerExec(target, host, claudeRemoteCommandLine(claudeContainerFolder(target, options.cwd), env, flags, documents.length));
	const stdin = claudeRemoteStdin(env, documents);
	return stdin ? { ...command, stdin } : command;
}

/** `claude --version` and `claude auth status` on the target, run before the session starts. */
export function buildClaudeProbeCommands(target: ClaudePreparedTarget, host: ClaudeTargetHost): { readonly version: ClaudeSpawnCommand; readonly auth: ClaudeSpawnCommand } {
	const probe = (args: readonly string[]) => target.kind === 'ssh'
		? claudeSshCommand(target.host, claudeRemoteCommandLine(target.remotePath, {}, args), host.env)
		: devContainerExec(target, host, claudeRemoteCommandLine(target.remoteWorkspaceFolder, {}, args));
	return { version: probe(['--version']), auth: probe(['auth', 'status']) };
}

/**
 * The official installer on the target, for a visible terminal. SSH gets a
 * terminal (`-t`) so the host can ask for a password or a host key.
 */
export function buildClaudeInstallCommand(target: ClaudePreparedTarget, host: ClaudeTargetHost): ClaudeTargetInstall {
	if (target.kind === 'ssh') {
		return { where: target.host, executable: 'ssh', args: ['-t', '--', target.host, CLAUDE_INSTALL_SCRIPT], display: CLAUDE_INSTALL_SCRIPT };
	}
	const exec = devContainerExec(target, host, CLAUDE_INSTALL_SCRIPT);
	return {
		where: localize('claudeTargetTheDevContainer', "the dev container"),
		executable: exec.command,
		args: exec.args,
		env: { ELECTRON_RUN_AS_NODE: '1' },
		display: CLAUDE_INSTALL_SCRIPT,
	};
}

/** `devcontainer up` for the workspace folder: builds the container, or reuses a running one. */
export function buildDevContainerUpCommand(workspaceFolder: string, host: ClaudeTargetHost): ClaudeSpawnCommand {
	return devContainerCommand(host, ['up', '--workspace-folder', workspaceFolder]);
}

/** The container's workspace folder from `devcontainer up`'s last JSON line, or the CLI's own error. */
export function parseDevContainerUp(stdout: string): { readonly outcome: 'success'; readonly remoteWorkspaceFolder: string } | { readonly outcome: 'error'; readonly error: string } | undefined {
	for (const line of stdout.trim().split('\n').reverse()) {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (!value || typeof value !== 'object') {
			continue;
		}
		const record = value as Record<string, unknown>;
		if (record.outcome === 'success' && typeof record.remoteWorkspaceFolder === 'string') {
			return { outcome: 'success', remoteWorkspaceFolder: record.remoteWorkspaceFolder };
		}
		if (record.outcome === 'error') {
			return { outcome: 'error', error: typeof record.message === 'string' ? record.message : '' };
		}
	}
	return undefined;
}

function lastLine(text: string): string {
	return text.trim().split(/\r?\n/).filter(line => line.trim().length > 0).at(-1)?.trim() ?? '';
}

function missingCommand(result: ClaudeCommandResult): boolean {
	return result.code === 127 || /(command )?not found|no such file/i.test(result.stderr);
}

/**
 * Runs `claude --version` and the auth probe on the target. A failure throws a
 * {@link ClaudeExecutionTargetError} that says what to install or do.
 */
export async function probeClaudeExecutionTarget(target: ClaudePreparedTarget, host: ClaudeTargetHost, run: ClaudeCommandRunner): Promise<string> {
	const where = target.kind === 'ssh' ? target.host : localize('claudeTargetTheDevContainer', "the dev container");
	const probes = buildClaudeProbeCommands(target, host);
	const version = await run(probes.version, PROBE_TIMEOUT_MS);
	if (target.kind === 'ssh' && version.code === 255) {
		throw new ClaudeExecutionTargetError(localize('claudeTargetSshUnreachable', "Klawly could not connect to {0} over SSH: {1}. Klawly uses your own SSH config and keys; check that ssh {0} works in a terminal without a password prompt.", target.host, lastLine(version.stderr) || localize('claudeTargetNoDetail', "no details")), 'unreachable');
	}
	if (version.code !== 0 || !version.stdout.trim()) {
		if (missingCommand(version)) {
			throw new ClaudeExecutionTargetError(localize('claudeTargetNotInstalled', "Claude Code is not installed in {0}. Install it there (curl -fsSL https://claude.ai/install.sh | bash, or npm install -g @anthropic-ai/claude-code), then start the session again.", where), 'missing', buildClaudeInstallCommand(target, host));
		}
		throw new ClaudeExecutionTargetError(localize('claudeTargetVersionFailed', "Claude Code did not start in {0}: {1}", where, lastLine(version.stderr) || lastLine(version.stdout) || localize('claudeTargetNoDetail', "no details")));
	}
	const auth = await run(probes.auth, PROBE_TIMEOUT_MS);
	const status = parseAuthStatus(auth.stdout);
	if (!status?.loggedIn) {
		throw new ClaudeExecutionTargetError(localize('claudeTargetNoAccount', "Claude Code in {0} has no account yet. Run claude there once and log in; Klawly never sends your Claude credentials to another machine.", where));
	}
	return lastLine(version.stdout);
}

/**
 * Gets a remote target ready before its first query: `devcontainer up` (only in a
 * trusted workspace) or nothing for SSH, then the probes. Undefined for a target
 * that runs on this machine.
 */
export async function prepareClaudeExecutionTarget(target: ClaudeExecutionTarget | undefined, context: ClaudePrepareTargetContext): Promise<ClaudePreparedTarget | undefined> {
	if (!target || target.kind === 'local' || target.kind === 'worktree') {
		return undefined;
	}
	let prepared: ClaudePreparedTarget;
	if (target.kind === 'ssh') {
		prepared = { kind: 'ssh', host: target.host, remotePath: target.remotePath };
	} else {
		// Building a dev container runs the workspace's own configuration: Workspace Trust comes first.
		if (!context.trusted) {
			throw new ClaudeExecutionTargetError(localize('claudeTargetDevContainerUntrusted', "Trust this workspace before Klawly builds its dev container."));
		}
		const workspaceFolder = context.workspaceFolders.find(folder => isEqualOrParent(context.cwd, folder, process.platform !== 'linux')) ?? context.cwd;
		const up = await context.run(buildDevContainerUpCommand(workspaceFolder, context.host), DEV_CONTAINER_UP_TIMEOUT_MS);
		const parsed = parseDevContainerUp(up.stdout);
		if (parsed?.outcome !== 'success') {
			const detail = parsed?.error || lastLine(up.stderr) || localize('claudeTargetNoDetail', "no details");
			throw new ClaudeExecutionTargetError(localize('claudeTargetDevContainerFailed', "Klawly could not start the dev container: {0}. It needs Docker and a .devcontainer/devcontainer.json in the workspace.", detail), 'unreachable');
		}
		prepared = { kind: 'devcontainer', workspaceFolder, remoteWorkspaceFolder: parsed.remoteWorkspaceFolder };
	}
	await probeClaudeExecutionTarget(prepared, context.host, context.run);
	return prepared;
}

/**
 * Starts Claude Code on a prepared target. Klawly talks to it over the
 * process's stdin and stdout as it does a local one; only where it runs changes.
 */
export function createClaudeTargetSpawner(target: ClaudePreparedTarget, host: ClaudeTargetHost, log?: (line: string) => void, spawnProcess: (command: string, args: readonly string[], options: { cwd?: string; env: Record<string, string> }) => ChildProcessWithoutNullStreams = defaultSpawn): (options: ClaudeSpawnOptions) => ChildProcessWithoutNullStreams {
	return options => {
		const command = buildClaudeSpawnCommand(target, options, host);
		const child = spawnProcess(command.command, command.args, { cwd: command.cwd, env: { ...command.env } });
		if (command.stdin) {
			// Before anything else is written, so the remote shell reads the secrets first.
			child.stdin.write(command.stdin);
		}
		child.stderr.on('data', (chunk: Buffer) => log?.(`[${target.kind}] ${String(chunk).trimEnd()}`));
		return child;
	};
}

function defaultSpawn(command: string, args: readonly string[], options: { cwd?: string; env: Record<string, string> }): ChildProcessWithoutNullStreams {
	return spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

/** Runs a probe or `devcontainer up` to completion, killing it after `timeoutMs`. */
export function runClaudeTargetCommand(command: ClaudeSpawnCommand, timeoutMs: number): Promise<ClaudeCommandResult> {
	return new Promise(resolve => {
		const child = spawn(command.command, [...command.args], { cwd: command.cwd, env: { ...command.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: timeoutMs });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk); });
		child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk); });
		child.on('error', error => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
		child.on('close', code => resolve({ code, stdout, stderr }));
	});
}

/** `session.started` with the target's kind and label, for the Agents column and the session header. */
export function withClaudeExecutionTarget(event: NormalizedClaudeEvent, target: ClaudeExecutionTarget | undefined, notice?: string): NormalizedClaudeEvent {
	if (event.type !== 'session.started' || event.parentRunId !== undefined || !target) {
		return event;
	}
	const info = claudeExecutionTargetInfo(target);
	return { ...event, target: notice ? { ...info, notice } : info };
}

/**
 * The notice for a resumed session whose host or container is gone: the turn
 * runs on this machine in a new Claude Code conversation, because the old one
 * is stored on the target.
 */
export function claudeTargetFallbackNotice(target: ClaudeExecutionTarget, error: ClaudeExecutionTargetError): string {
	return localize('claudeTargetFallback', "{0} is not reachable, so this agent now runs on this computer in a new Claude Code conversation. Its earlier conversation stays on {0}. {1}", claudeExecutionTargetInfo(target).label, error.message);
}

/**
 * Where a write tool's file is on this machine, for change capture. Inside a
 * dev container the workspace is a bind mount, so a container path under the
 * container's workspace folder maps to the same file here. Undefined when the
 * path is outside the mount.
 */
export function claudeContainerPathToLocal(target: Extract<ClaudePreparedTarget, { kind: 'devcontainer' }>, containerPath: string): string | undefined {
	if (!posix.isAbsolute(containerPath)) {
		return undefined;
	}
	const relativePath = posix.relative(target.remoteWorkspaceFolder, posix.normalize(containerPath));
	if (relativePath === '') {
		return target.workspaceFolder;
	}
	if (relativePath === '..' || relativePath.startsWith('../') || posix.isAbsolute(relativePath)) {
		return undefined;
	}
	return join(target.workspaceFolder, ...relativePath.split('/'));
}
