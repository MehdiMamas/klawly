/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile as nodeExecFile } from 'child_process';
import { accessSync, constants } from 'fs';
import { delimiter, join } from '../../../base/common/path.js';
import { ClaudeRuntimeState } from '../common/claude.js';
import { ClaudeAccountDetails } from '../common/claudeAccount.js';
import { claudeCommand } from './claudeWindowsCommand.js';
import { assessClaudeRuntimeVersion, ClaudeVersionAssessment, parseClaudeVersion } from './claudeVersion.js';

const PROBE_TIMEOUT_MS = 5000;

/**
 * Names copied into the Claude process. Values are never logged.
 * `ANTHROPIC_API_KEY` is included because it is the supported API-key channel.
 */
const ENV_ALLOWLIST: readonly string[] = [
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'SHELL',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'TMPDIR',
	'TEMP',
	'TMP',
	'SystemRoot',
	'ComSpec',
	'PATHEXT',
	'USERPROFILE',
	'HOMEDRIVE',
	'HOMEPATH',
	'APPDATA',
	'LOCALAPPDATA',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'NO_PROXY',
	'http_proxy',
	'https_proxy',
	'no_proxy',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'NODE_EXTRA_CA_CERTS',
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_AUTH_TOKEN',
	'ANTHROPIC_BASE_URL',
	'ANTHROPIC_MODEL',
	'CLAUDE_CONFIG_DIR',
	// Opt-outs the user set themselves. They only ever reduce what Claude Code sends.
	'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
	'DISABLE_TELEMETRY',
	'DISABLE_ERROR_REPORTING',
	'DISABLE_AUTOUPDATER',
];

/**
 * Set when `claude.telemetry.enabled` is false, which is the default. Claude Code
 * then sends no telemetry, error reports, or other nonessential traffic.
 */
const TELEMETRY_OPT_OUT: Readonly<Record<string, string>> = {
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
	DISABLE_TELEMETRY: '1',
};

export interface ExecFileResult {
	stdout: string;
	stderr: string;
}

export interface ExecFileOptions {
	readonly timeout: number;
	readonly windowsHide: boolean;
	/** The child's whole environment. Built by {@link claudeProcessEnvironment}, never `process.env`. */
	readonly env: Readonly<Record<string, string>>;
	/** Where the child runs. Absent inherits this process's directory. */
	readonly cwd?: string;
	/** Written to the child's stdin, which is then closed. */
	readonly input?: string;
}

export type ExecFileRunner = (file: string, args: readonly string[], options: ExecFileOptions) => Promise<ExecFileResult>;

export interface ClaudeRuntimeProbe {
	readonly binary: string;
	readonly state: ClaudeRuntimeState;
	readonly versionAssessment?: ClaudeVersionAssessment;
}

export interface ClaudeProcessEnvironmentOptions {
	/** `claude.telemetry.enabled`. Anything but true turns Claude Code's nonessential traffic off. */
	readonly telemetryEnabled?: boolean;
	/** The folder of the Claude account in use (issue 450), as `CLAUDE_CONFIG_DIR`. Absent keeps the one the user set, if any. */
	readonly configDirectory?: string;
}

/**
 * The whole environment of every Claude process (agent turns, completions, and
 * the version and auth probes). Only names on the allowlist are copied.
 */
export function claudeProcessEnvironment(source: NodeJS.ProcessEnv = process.env, options?: ClaudeProcessEnvironmentOptions): Record<string, string> {
	const env: Record<string, string> = {
		CLAUDE_AGENT_SDK_CLIENT_APP: 'Klawly',
	};
	for (const name of ENV_ALLOWLIST) {
		const value = source[name];
		if (typeof value === 'string' && value.length > 0) {
			env[name] = value;
		}
	}
	if (options?.configDirectory) {
		env.CLAUDE_CONFIG_DIR = options.configDirectory;
	}
	if (options?.telemetryEnabled !== true) {
		Object.assign(env, TELEMETRY_OPT_OUT);
	}
	return env;
}

/**
 * The folders the official Claude Code installers put `claude` in. A Klawly
 * started before the install does not have them on its `PATH` (issue 91).
 */
export function claudeKnownInstallDirectories(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
	const home = platform === 'win32' ? env.USERPROFILE : env.HOME;
	if (!home) {
		return [];
	}
	if (platform === 'win32') {
		return [join(home, '.local', 'bin')];
	}
	return [join(home, '.local', 'bin'), join(home, '.claude', 'local')];
}

/**
 * Finds the Claude Code executable: the configured path, else `PATH`, else the
 * folders the official installers use.
 */
export function resolveClaudeBinary(runtimePath: string | undefined, env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = canExecute, platform: NodeJS.Platform = process.platform): string | undefined {
	if (runtimePath && runtimePath.trim().length > 0) {
		const candidate = runtimePath.trim();
		return exists(candidate) ? candidate : undefined;
	}
	const pathValue = env.PATH ?? env.Path ?? '';
	const names = claudeProbeBinaryNames(platform);
	for (const directory of [...pathValue.split(delimiter), ...claudeKnownInstallDirectories(env, platform)]) {
		if (!directory) {
			continue;
		}
		for (const name of names) {
			const candidate = join(directory, name);
			if (exists(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

const WINDOWS_PATH_KEYS: readonly string[] = [
	'HKCU\\Environment',
	'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
];

/**
 * `env` for finding Claude Code. On Windows, the user and machine `Path` as the
 * registry holds them now are added: an installer that adds its folder there
 * only reaches processes started after it, not this one (issue 91).
 */
export async function claudeSearchEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, execFile: ExecFileRunner = defaultExecFile): Promise<NodeJS.ProcessEnv> {
	if (platform !== 'win32') {
		return env;
	}
	const reg = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
	const saved = await Promise.all(WINDOWS_PATH_KEYS.map(async key => {
		try {
			const { stdout } = await execFile(reg, ['query', key, '/v', 'Path'], { timeout: PROBE_TIMEOUT_MS, windowsHide: true, env: env.SystemRoot ? { SystemRoot: env.SystemRoot } : {} });
			return parseRegistryPath(stdout, env);
		} catch {
			return undefined;
		}
	}));
	const directories = [env.PATH ?? env.Path, ...saved].filter((value): value is string => !!value);
	return { ...env, PATH: directories.join(delimiter) };
}

/** The `Path` value of a `reg query` answer, with `%NAME%` references expanded from `env`. */
function parseRegistryPath(stdout: string, env: NodeJS.ProcessEnv): string | undefined {
	const value = /^\s+Path\s+REG_(?:EXPAND_)?SZ\s+(?<value>.*)$/im.exec(stdout)?.groups?.value.trim();
	return value?.replace(/%(?<name>[^%;]+)%/g, (match, name: string) => env[name] ?? match);
}

export async function probeClaudeRuntime(options?: {
	readonly runtimePath?: string;
	readonly execFile?: ExecFileRunner;
	readonly env?: NodeJS.ProcessEnv;
	readonly knownBadVersions?: readonly string[];
	readonly log?: (line: string) => void;
	readonly telemetryEnabled?: boolean;
	/** The folder of the Claude account in use (issue 450). Absent probes the default one. */
	readonly configDirectory?: string;
}): Promise<ClaudeRuntimeProbe> {
	const env = options?.env ?? process.env;
	const runner = options?.execFile ?? defaultExecFile;
	const childEnv = claudeProcessEnvironment(env, { telemetryEnabled: options?.telemetryEnabled, configDirectory: options?.configDirectory });
	const execFile = (file: string, args: readonly string[]) => runner(file, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, env: childEnv });
	// Only the search sees the saved `Path`: the child keeps the environment it was given.
	const searchEnv = options?.env || options?.runtimePath?.trim() ? env : await claudeSearchEnvironment(env, process.platform);
	const binary = resolveClaudeBinary(options?.runtimePath, searchEnv);
	if (!binary) {
		return {
			binary: options?.runtimePath?.trim() || 'claude',
			state: {
				installed: false,
				authenticated: false,
				error: options?.runtimePath ? 'The configured Claude runtime was not found.' : 'Claude Code is not installed.',
			},
		};
	}

	let version: string | undefined;
	try {
		const probed = await execFile(binary, ['--version']);
		version = parseClaudeVersion(probed.stdout);
	} catch {
		return {
			binary,
			state: {
				installed: false,
				authenticated: false,
				error: 'Claude Code did not respond to a version probe.',
				binaryPath: binary,
			},
		};
	}

	if (!version) {
		return {
			binary,
			state: {
				installed: false,
				authenticated: false,
				error: 'Claude Code did not report a version.',
				binaryPath: binary,
			},
		};
	}

	const versionAssessment = assessClaudeRuntimeVersion(version, { knownBad: options?.knownBadVersions });
	if ((versionAssessment.disposition === 'warn' || versionAssessment.disposition === 'newer') && versionAssessment.message) {
		options?.log?.(versionAssessment.message);
	}
	const auth = await readAuthStatus(binary, execFile);
	// A newer Claude Code is normal (it updates itself): it is logged above, never shown as an error.
	const warning = versionAssessment.disposition === 'warn' || versionAssessment.disposition === 'block' ? versionAssessment.message : undefined;
	const state: ClaudeRuntimeState = {
		installed: true,
		authenticated: auth.authenticated,
		version,
		authMode: auth.authMode,
		error: joinStatus(warning, auth.error),
		binaryPath: binary,
	};
	return { binary, state, versionAssessment };
}

export function defaultExecFile(file: string, args: readonly string[], options: ExecFileOptions): Promise<ExecFileResult> {
	return new Promise((resolve, reject) => {
		const command = claudeCommand(file, args);
		const child = nodeExecFile(command.file, [...command.args], { timeout: options.timeout, windowsHide: options.windowsHide, env: { ...options.env }, cwd: options.cwd, windowsVerbatimArguments: command.verbatim }, (error, stdout, stderr) => {
			if (error) {
				reject(Object.assign(error, { stdout: String(stdout), stderr: String(stderr) }));
				return;
			}
			resolve({ stdout: String(stdout), stderr: String(stderr) });
		});
		if (options.input !== undefined) {
			child.stdin?.end(options.input);
		}
	});
}

async function readAuthStatus(binary: string, execFile: (file: string, args: readonly string[]) => Promise<ExecFileResult>): Promise<Pick<ClaudeRuntimeState, 'authenticated' | 'authMode' | 'error'>> {
	let stdout = '';
	try {
		const result = await execFile(binary, ['auth', 'status']);
		stdout = result.stdout;
	} catch {
		return { authenticated: false, error: 'Claude auth status is unavailable.' };
	}
	const parsed = parseAuthStatus(stdout);
	if (!parsed) {
		return { authenticated: false, error: 'Claude auth status was not understood.' };
	}
	if (!parsed.loggedIn) {
		return { authenticated: false };
	}
	return { authenticated: true, authMode: mapAuthMode(parsed.authMethod, parsed.apiProvider) };
}

/**
 * The signed-in account `auth status` printed, for Plan & Usage before any
 * session has reported one (issue 536). Undefined when signed out or when it
 * printed no account. The runtime state never keeps these fields.
 */
export function parseAuthStatusAccount(stdout: string): ClaudeAccountDetails | undefined {
	const status = parseAuthStatus(stdout);
	if (!status?.loggedIn || (!status.email && !status.orgName && !status.subscriptionType)) {
		return undefined;
	}
	return { email: status.email, organization: status.orgName, plan: status.subscriptionType, provider: status.apiProvider };
}

export interface AuthStatusJson {
	loggedIn: boolean;
	authMethod?: string;
	apiProvider?: string;
	email?: string;
	orgName?: string;
	subscriptionType?: string;
}

export function parseAuthStatus(stdout: string): AuthStatusJson | undefined {
	const start = stdout.indexOf('{');
	const end = stdout.lastIndexOf('}');
	if (start < 0 || end <= start) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}
	const record = parsed as Record<string, unknown>;
	if (typeof record.loggedIn !== 'boolean') {
		return undefined;
	}
	return {
		loggedIn: record.loggedIn,
		authMethod: typeof record.authMethod === 'string' ? record.authMethod : undefined,
		apiProvider: typeof record.apiProvider === 'string' ? record.apiProvider : undefined,
		email: typeof record.email === 'string' && record.email ? record.email : undefined,
		orgName: typeof record.orgName === 'string' && record.orgName ? record.orgName : undefined,
		subscriptionType: typeof record.subscriptionType === 'string' && record.subscriptionType ? record.subscriptionType : undefined,
	};
}

function mapAuthMode(authMethod: string | undefined, apiProvider: string | undefined): ClaudeRuntimeState['authMode'] {
	const method = (authMethod ?? '').toLowerCase();
	const provider = (apiProvider ?? '').toLowerCase();
	if (provider === 'gateway' || method.includes('enterprise')) {
		return 'enterprise';
	}
	if (provider === 'bedrock') {
		return 'bedrock';
	}
	if (provider === 'vertex') {
		return 'vertex';
	}
	if (method.includes('api') || method.includes('key')) {
		return 'api-key';
	}
	if (method.includes('claude') || method.includes('oauth') || provider === 'firstparty') {
		return 'claude-account';
	}
	return 'unknown';
}

/**
 * What the probe looks for, best first. On Windows a native `claude.exe` wins
 * over an npm `.cmd` shim, which needs `cmd.exe` to start (claudeWindowsCommand.ts).
 */
export function claudeProbeBinaryNames(platform: NodeJS.Platform): readonly string[] {
	if (platform === 'win32') {
		// The native program first: it starts without a shell. A shim goes through cmd.exe (claudeCommand).
		return ['claude.exe', 'claude.cmd', 'claude.bat'];
	}
	return ['claude'];
}

function joinStatus(warning: string | undefined, authError: string | undefined): string | undefined {
	if (warning && authError) {
		return `${warning} ${authError}`;
	}
	return warning || authError;
}

function canExecute(file: string): boolean {
	try {
		accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
