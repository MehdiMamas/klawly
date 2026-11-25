/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { claudeManagedSettings, ClaudeOtelSettings, ClaudeSandboxSettings, ClaudeSecuritySettings } from '../common/claudeSecuritySettings.js';

/** Claude Code's `sandbox` settings object, as `--settings` takes it. */
export type ClaudeSandboxOption = Readonly<Record<string, unknown>>;

/** The settings keys and variables the sandbox, telemetry export and policy settings set. */
export interface ClaudeSecurityOptions {
	readonly sandbox?: ClaudeSandboxOption;
	readonly managedSettings?: Readonly<Record<string, unknown>>;
	/** Added to the Claude process environment. */
	readonly env: Readonly<Record<string, string>>;
}

/**
 * Maps the settings to Claude Code settings. Nothing is set for a setting left at its
 * default, so the user's own Claude settings still decide.
 */
export function claudeSecurityOptions(security: ClaudeSecuritySettings | undefined, denyRead?: readonly string[]): ClaudeSecurityOptions {
	if (!security) {
		return { env: {} };
	}
	const sandbox = sandboxOption(security.sandbox, denyRead);
	const managedSettings = claudeManagedSettings(security.managed);
	return {
		...(sandbox ? { sandbox } : {}),
		...(managedSettings ? { managedSettings } : {}),
		env: otelEnvironment(security.otel),
	};
}

/**
 * The sandbox stays Claude Code's to decide while the setting is off. When it
 * is on, `failIfUnavailable` makes a sandbox that cannot start fail the turn
 * instead of running commands unsandboxed.
 */
function sandboxOption(sandbox: ClaudeSandboxSettings, denyRead?: readonly string[]): ClaudeSandboxOption | undefined {
	if (!sandbox.enabled) {
		return undefined;
	}
	return {
		enabled: true,
		failIfUnavailable: true,
		autoAllowBashIfSandboxed: sandbox.autoAllowBash,
		allowUnsandboxedCommands: sandbox.allowUnsandboxedCommands,
		...(sandbox.allowLocalBinding ? { network: { allowLocalBinding: true } } : {}),
		// Files Claude cannot read (issue 458); best effort, the host check is the guarantee.
		...(denyRead && denyRead.length > 0 ? { filesystem: { denyRead: [...denyRead] } } : {}),
	};
}

/**
 * Claude Code's documented telemetry variables. Only an http or https endpoint
 * turns export on; otherwise nothing is set and nothing is sent.
 */
export function otelEnvironment(otel: ClaudeOtelSettings): Record<string, string> {
	if (!/^https?:\/\/\S+$/i.test(otel.endpoint)) {
		return {};
	}
	return {
		CLAUDE_CODE_ENABLE_TELEMETRY: '1',
		OTEL_METRICS_EXPORTER: 'otlp',
		OTEL_LOGS_EXPORTER: 'otlp',
		OTEL_EXPORTER_OTLP_PROTOCOL: otel.protocol,
		OTEL_EXPORTER_OTLP_ENDPOINT: otel.endpoint,
		...(otel.headers ? { OTEL_EXPORTER_OTLP_HEADERS: otel.headers } : {}),
	};
}

/**
 * A clear message for a sandbox that is on but cannot start, with what to do
 * on this platform. Undefined for any other failure.
 */
export function claudeSandboxFailureMessage(message: string, platform: NodeJS.Platform): string | undefined {
	if (!/sandbox/i.test(message) || !/unavailable|not available|cannot|could not|missing|not installed|not supported|unsupported|bubblewrap|bwrap|socat/i.test(message)) {
		return undefined;
	}
	const fix = platform === 'linux'
		? 'Install bubblewrap and socat, or turn off Sandbox in Klawly Settings > Agents.'
		: 'Run /sandbox in Claude Code to see what it needs, or turn off Sandbox in Klawly Settings > Agents.';
	return `The sandbox is on but cannot start on this machine, so Claude ran nothing. ${fix} Claude Code said: ${message.trim()}`;
}
