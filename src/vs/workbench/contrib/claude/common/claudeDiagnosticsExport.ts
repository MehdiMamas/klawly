/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeRuntimeState } from '../../../../platform/claude/common/claude.js';
import { CLAUDE_REDACTED, redactClaudeSecrets } from '../../../../platform/claude/common/claudeSecretPatterns.js';

/** Developer: Export Claude Agent Diagnostics (master plan section 51). */
export const CLAUDE_EXPORT_DIAGNOSTICS_COMMAND_ID = 'claude.exportDiagnostics';

/** Most recent output-channel lines kept in the export. */
export const CLAUDE_DIAGNOSTICS_LOG_LINES = 2000;

/** Event types listed in order, newest last. */
export const CLAUDE_DIAGNOSTICS_RECENT_EVENTS = 200;

/** A longer log line is cut, so a stray dump cannot carry a whole file into the export. */
const MAX_LINE = 500;

/** Setting names whose text values are dropped whatever they hold. */
const SECRET_SETTING_NAME = /key|token|secret|password|passwd|credential|auth(?!ors?\b)|cookie|header/i;

export interface ClaudeDiagnosticsInput {
	/** ISO time the export was made. */
	readonly generatedAt: string;
	readonly product: {
		readonly nameLong: string;
		readonly version: string;
		readonly commit?: string;
		readonly date?: string;
		readonly quality?: string;
	};
	readonly protocolVersion: number;
	/** Undefined when the runtime state could not be read; `runtimeError` says why. */
	readonly runtime?: ClaudeRuntimeState;
	readonly runtimeError?: string;
	readonly os: { readonly type: string; readonly release: string; readonly arch: string };
	/** The `claude` configuration section, as `IConfigurationService.getValue('claude')` returns it. */
	readonly configuration: unknown;
	/** Text of the Claude Agent output channel. Its lines are already redacted when written. */
	readonly log: string;
	/** Folders replaced by `~` wherever they appear, such as the user home. */
	readonly homeDirectories: readonly string[];
}

export interface ClaudeDiagnosticsFile {
	readonly path: string;
	readonly contents: string;
}

/**
 * The files of the diagnostics ZIP. Everything is redacted again here: secret
 * shapes become `[redacted]`, secret-named settings lose their text, the home
 * folder becomes `~`, and long lines are cut. No prompt, file body, tool input
 * or assistant text is read; the log never had them. Redaction is a best effort.
 */
export function buildClaudeDiagnosticsFiles(input: ClaudeDiagnosticsInput): ClaudeDiagnosticsFile[] {
	const scrub = (text: string) => scrubClaudeDiagnosticsText(text, input.homeDirectories);
	const lines = input.log.split(/\r?\n/).filter(line => line.length > 0).slice(-CLAUDE_DIAGNOSTICS_LOG_LINES).map(line => clipLine(scrub(line)));
	const events = eventTypes(lines);
	const counts: Record<string, number> = {};
	for (const type of events) {
		counts[type] = (counts[type] ?? 0) + 1;
	}
	const errors = lines.filter(line => /\b(?:error|errors|failed|failure|exception|crash(?:ed)?|fatal)\b|^\s+at\s/i.test(line));
	const runtime = input.runtime;
	const versions = {
		generatedAt: input.generatedAt,
		product: {
			name: input.product.nameLong,
			version: input.product.version,
			commit: input.product.commit,
			date: input.product.date,
			quality: input.product.quality,
		},
		claudeProtocolVersion: input.protocolVersion,
		claudeRuntime: runtime ? {
			version: runtime.version !== undefined ? scrub(runtime.version) : undefined,
			installed: runtime.installed,
			authenticated: runtime.authenticated,
			authMode: runtime.authMode,
			binaryPath: runtime.binaryPath !== undefined ? scrub(runtime.binaryPath) : undefined,
			error: runtime.error !== undefined ? clipLine(scrub(runtime.error)) : undefined,
		} : { unavailable: clipLine(scrub(input.runtimeError ?? 'unknown')) },
		os: input.os,
	};
	return [
		{ path: 'README.txt', contents: readme(input.generatedAt) },
		{ path: 'versions.json', contents: json(versions) },
		{ path: 'configuration.json', contents: json({ claude: sanitizeSetting(input.configuration, '', scrub) }) },
		{ path: 'events.json', contents: json({ counts, recent: events.slice(-CLAUDE_DIAGNOSTICS_RECENT_EVENTS) }) },
		{ path: 'errors.log', contents: errors.length > 0 ? `${errors.join('\n')}\n` : '' },
		{ path: 'claude-agent.log', contents: lines.length > 0 ? `${lines.join('\n')}\n` : '' },
	];
}

/** The event type of each `[claude] +12ms tool.started ...` line, in order. Nothing else from the line. */
function eventTypes(lines: readonly string[]): string[] {
	const types: string[] = [];
	for (const line of lines) {
		const type = /^\[claude\] \+\d+ms (?<type>[a-z]+\.[A-Za-z]+)\b/.exec(line)?.groups?.type;
		if (type) {
			types.push(type);
		}
	}
	return types;
}

function sanitizeSetting(value: unknown, name: string, scrub: (text: string) => string): unknown {
	if (typeof value === 'string') {
		return SECRET_SETTING_NAME.test(name) && value.length > 0 ? CLAUDE_REDACTED : scrub(value);
	}
	if (Array.isArray(value)) {
		return value.map(item => sanitizeSetting(item, name, scrub));
	}
	if (value && typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			result[key] = sanitizeSetting(child, key, scrub);
		}
		return result;
	}
	return value;
}

/** Replaces secret shapes with `[redacted]` and each home folder with `~`. */
export function scrubClaudeDiagnosticsText(text: string, homes: readonly string[]): string {
	let result = redactClaudeSecrets(text);
	for (const home of homes) {
		if (home.length > 1) {
			result = result.split(home).join('~');
		}
	}
	return result;
}

function clipLine(line: string): string {
	return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}… [cut]` : line;
}

function json(value: unknown): string {
	return `${JSON.stringify(value, undefined, '\t')}\n`;
}

function readme(generatedAt: string): string {
	return [
		'Klawly Claude Agent diagnostics',
		`Generated: ${generatedAt}`,
		'',
		'versions.json       product, Claude runtime and protocol versions, OS and architecture',
		'configuration.json  claude.* settings; secret-like values are replaced by [redacted]',
		'events.json         recent agent event types and their counts, without content',
		'errors.log          error and stack lines from the Claude Agent output',
		'claude-agent.log    recent Claude Agent output lines',
		'',
		'Known secret formats are replaced by [redacted] and the home folder by ~.',
		'Redaction is a best effort. Read the files before you share them.',
		'',
	].join('\n');
}
