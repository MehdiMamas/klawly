/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Off by default. When true, Claude Code runs agent commands in its sandbox. */
export const CLAUDE_SANDBOX_ENABLED_SETTING = 'claude.sandbox.enabled';

/** While the sandbox is on, sandboxed Bash commands run without a prompt. Claude Code's default is true. */
export const CLAUDE_SANDBOX_AUTO_ALLOW_BASH_SETTING = 'claude.sandbox.autoAllowBash';

/** While the sandbox is on, Claude may ask to run a command outside it. Claude Code's default is true. */
export const CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_SETTING = 'claude.sandbox.allowUnsandboxedCommands';

/** While the sandbox is on, sandboxed commands may listen on local ports. */
export const CLAUDE_SANDBOX_ALLOW_LOCAL_BINDING_SETTING = 'claude.sandbox.allowLocalBinding';

/** The OTLP collector Claude Code exports metrics and events to. Empty exports nothing. */
export const CLAUDE_OTEL_ENDPOINT_SETTING = 'claude.telemetry.otel.endpoint';

/** The OTLP protocol for {@link CLAUDE_OTEL_ENDPOINT_SETTING}. */
export const CLAUDE_OTEL_PROTOCOL_SETTING = 'claude.telemetry.otel.protocol';

/** OTLP headers as `key=value` pairs separated by commas, the `OTEL_EXPORTER_OTLP_HEADERS` format. */
export const CLAUDE_OTEL_HEADERS_SETTING = 'claude.telemetry.otel.headers';

/**
 * Claude Code settings an organization's policy hands to every Claude process.
 * Only a policy value is read; Claude Code keeps only its restrictive keys.
 */
export const CLAUDE_MANAGED_SETTINGS_SETTING = 'claude.managedSettings';

/** The settings an organization's policy can lock. */
export const CLAUDE_POLICY_SETTINGS: readonly string[] = [CLAUDE_SANDBOX_ENABLED_SETTING, CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_SETTING, CLAUDE_MANAGED_SETTINGS_SETTING];

export const CLAUDE_OTEL_PROTOCOLS = ['grpc', 'http/protobuf', 'http/json'] as const;

export type ClaudeOtelProtocol = typeof CLAUDE_OTEL_PROTOCOLS[number];

export interface ClaudeSandboxSettings {
	readonly enabled: boolean;
	readonly autoAllowBash: boolean;
	readonly allowUnsandboxedCommands: boolean;
	readonly allowLocalBinding: boolean;
}

export interface ClaudeOtelSettings {
	/** Empty exports nothing. */
	readonly endpoint: string;
	readonly protocol: ClaudeOtelProtocol;
	readonly headers: string;
}

/** What an organization's policy set. A field is absent when no policy sets it. */
export interface ClaudeManagedPolicy {
	readonly sandboxEnabled?: boolean;
	readonly allowUnsandboxedCommands?: boolean;
	/** A Claude Code settings object, passed on as is. */
	readonly settings?: Readonly<Record<string, unknown>>;
}

/** The sandbox, telemetry export and policy settings a session opens with. */
export interface ClaudeSecuritySettings {
	readonly sandbox: ClaudeSandboxSettings;
	readonly otel: ClaudeOtelSettings;
	readonly managed: ClaudeManagedPolicy;
}

/**
 * Reads the settings. `getValue` is the effective value (a policy wins over the
 * user), `policyValue` only what a policy set.
 */
export function readClaudeSecuritySettings(getValue: (key: string) => unknown, policyValue: (key: string) => unknown): ClaudeSecuritySettings {
	const protocol = getValue(CLAUDE_OTEL_PROTOCOL_SETTING);
	const sandboxPolicy = policyValue(CLAUDE_SANDBOX_ENABLED_SETTING);
	const unsandboxedPolicy = policyValue(CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_SETTING);
	const settingsPolicy = readSettingsObject(policyValue(CLAUDE_MANAGED_SETTINGS_SETTING));
	return {
		sandbox: {
			enabled: getValue(CLAUDE_SANDBOX_ENABLED_SETTING) === true,
			autoAllowBash: getValue(CLAUDE_SANDBOX_AUTO_ALLOW_BASH_SETTING) !== false,
			allowUnsandboxedCommands: getValue(CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_SETTING) !== false,
			allowLocalBinding: getValue(CLAUDE_SANDBOX_ALLOW_LOCAL_BINDING_SETTING) === true,
		},
		otel: {
			endpoint: readString(getValue(CLAUDE_OTEL_ENDPOINT_SETTING)),
			protocol: CLAUDE_OTEL_PROTOCOLS.find(value => value === protocol) ?? 'http/protobuf',
			headers: readString(getValue(CLAUDE_OTEL_HEADERS_SETTING)),
		},
		managed: {
			...(typeof sandboxPolicy === 'boolean' ? { sandboxEnabled: sandboxPolicy } : {}),
			...(typeof unsandboxedPolicy === 'boolean' ? { allowUnsandboxedCommands: unsandboxedPolicy } : {}),
			...(settingsPolicy && Object.keys(settingsPolicy).length > 0 ? { settings: settingsPolicy } : {}),
		},
	};
}

/**
 * The policy tier Klawly hands Claude Code: the policy's Claude settings object,
 * with Klawly's own sandbox policies on top. Claude Code keeps only restrictive
 * keys, and drops all of it when an IT-managed Claude tier exists unless that
 * tier opts in.
 */
export function claudeManagedSettings(managed: ClaudeManagedPolicy): Record<string, unknown> | undefined {
	const settings: Record<string, unknown> = managed.settings ? structuredClone({ ...managed.settings }) : {};
	const sandbox: Record<string, unknown> = {};
	if (managed.sandboxEnabled === true) {
		sandbox.enabled = true;
		sandbox.failIfUnavailable = true;
	}
	if (managed.allowUnsandboxedCommands === false) {
		sandbox.allowUnsandboxedCommands = false;
	}
	if (Object.keys(sandbox).length > 0) {
		const existing = settings.sandbox;
		settings.sandbox = { ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}), ...sandbox };
	}
	return Object.keys(settings).length > 0 ? settings : undefined;
}

function readString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

/** A policy carries an object setting as JSON text; the configuration may already have parsed it. */
function readSettingsObject(value: unknown): Record<string, unknown> | undefined {
	let parsed = value;
	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

/**
 * Whether Claude Code's sandbox can start on this machine, as far as Klawly can
 * tell without starting it. `ready`: what it needs is here. `missing`: commands
 * to install first. `setup`: Claude Code checks on the first sandboxed turn and
 * may need a one-time install (`/sandbox install` on Windows).
 */
export interface ClaudeSandboxStatus {
	/** `setup`: only Claude Code can tell, when a sandboxed turn starts. `unsupported`: Claude Code has no sandbox for this platform. */
	readonly state: 'ready' | 'missing' | 'setup' | 'unsupported';
	readonly platform: 'linux' | 'darwin' | 'win32' | 'other';
	/** What to install first, such as bubblewrap and socat on Linux. */
	readonly missing: readonly string[];
}
