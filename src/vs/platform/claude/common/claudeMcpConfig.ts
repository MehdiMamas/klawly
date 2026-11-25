/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Where Claude Code keeps an MCP server: `local` is yours in this project,
 * `project` is the project's `.mcp.json`, shared through the repository, and
 * `user` is yours in every project.
 */
export type ClaudeMcpScope = 'local' | 'project' | 'user';

export const CLAUDE_MCP_SCOPES: readonly ClaudeMcpScope[] = ['local', 'project', 'user'];

/** `stdio` runs a command; `http` and `sse` connect to a URL. */
export type ClaudeMcpTransport = 'stdio' | 'http' | 'sse';

export const CLAUDE_MCP_TRANSPORTS: readonly ClaudeMcpTransport[] = ['stdio', 'http', 'sse'];

/** The JSON `claude mcp add-json` takes. */
export type ClaudeMcpServerConfig =
	| { readonly type: 'stdio'; readonly command: string; readonly args: readonly string[] }
	| { readonly type: 'http' | 'sse'; readonly url: string };

export interface ClaudeMcpAddRequest {
	readonly name: string;
	readonly scope: ClaudeMcpScope;
	readonly config: ClaudeMcpServerConfig;
	/** The project folder `local` and `project` scopes belong to. */
	readonly cwd?: string;
}

export interface ClaudeMcpRemoveRequest {
	readonly name: string;
	readonly scope: ClaudeMcpScope;
	readonly cwd?: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_COMMAND_LENGTH = 4096;

/** Letters, digits, `.`, `_` and `-`, starting with a letter or digit, so the name can never read as a flag. */
export function isClaudeMcpServerName(value: unknown): value is string {
	return typeof value === 'string' && NAME.test(value);
}

export function readClaudeMcpScope(value: unknown): ClaudeMcpScope | undefined {
	return CLAUDE_MCP_SCOPES.find(scope => scope === value);
}

/**
 * Splits a command line into words the way a shell would for plain input:
 * spaces separate, and single or double quotes keep spaces in one word.
 * Backslashes are literal, so Windows paths survive. Undefined when a quote is
 * left open.
 */
export function splitCommandLine(line: string): string[] | undefined {
	const words: string[] = [];
	let word = '';
	let inWord = false;
	let quote: '"' | '\'' | undefined;
	for (const char of line) {
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				word += char;
			}
		} else if (char === '"' || char === '\'') {
			quote = char;
			inWord = true;
		} else if (/\s/.test(char)) {
			if (inWord) {
				words.push(word);
				word = '';
				inWord = false;
			}
		} else {
			word += char;
			inWord = true;
		}
	}
	if (quote) {
		return undefined;
	}
	if (inWord) {
		words.push(word);
	}
	return words;
}

/** An http or https URL, or undefined. */
function readServerUrl(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length > MAX_COMMAND_LENGTH) {
		return undefined;
	}
	try {
		const url = new URL(value.trim());
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The server config for what the form holds: a command line for `stdio`, a URL
 * otherwise. Undefined when the command is empty or unbalanced, or the URL is
 * not http or https.
 */
export function claudeMcpServerConfig(transport: ClaudeMcpTransport, target: string): ClaudeMcpServerConfig | undefined {
	if (transport !== 'stdio') {
		const url = readServerUrl(target);
		return url ? { type: transport, url } : undefined;
	}
	if (target.length > MAX_COMMAND_LENGTH) {
		return undefined;
	}
	const words = splitCommandLine(target);
	if (!words || words.length === 0 || !words[0]) {
		return undefined;
	}
	return { type: 'stdio', command: words[0], args: words.slice(1) };
}

function readServerConfig(value: unknown): ClaudeMcpServerConfig | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const config = value as Record<string, unknown>;
	if (config.type === 'http' || config.type === 'sse') {
		const url = readServerUrl(config.url);
		return url ? { type: config.type, url } : undefined;
	}
	if (config.type !== 'stdio' || typeof config.command !== 'string' || !config.command || config.command.length > MAX_COMMAND_LENGTH || !Array.isArray(config.args)) {
		return undefined;
	}
	const args = config.args;
	if (!args.every((arg): arg is string => typeof arg === 'string') || args.join(' ').length > MAX_COMMAND_LENGTH) {
		return undefined;
	}
	return { type: 'stdio', command: config.command, args: [...args] };
}

function readCwd(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Checks a request that crossed a process boundary. Undefined when any part is off. */
export function readClaudeMcpAddRequest(value: unknown): ClaudeMcpAddRequest | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const request = value as Record<string, unknown>;
	const scope = readClaudeMcpScope(request.scope);
	const config = readServerConfig(request.config);
	if (!isClaudeMcpServerName(request.name) || !scope || !config) {
		return undefined;
	}
	return { name: request.name, scope, config, cwd: readCwd(request.cwd) };
}

export function readClaudeMcpRemoveRequest(value: unknown): ClaudeMcpRemoveRequest | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const request = value as Record<string, unknown>;
	const scope = readClaudeMcpScope(request.scope);
	if (!isClaudeMcpServerName(request.name) || !scope) {
		return undefined;
	}
	return { name: request.name, scope, cwd: readCwd(request.cwd) };
}

/** `claude mcp add-json --scope <scope> <name> <json>`. */
export function claudeMcpAddArguments(request: ClaudeMcpAddRequest): string[] {
	return ['mcp', 'add-json', '--scope', request.scope, request.name, JSON.stringify(request.config)];
}

/** `claude mcp remove --scope <scope> <name>`. */
export function claudeMcpRemoveArguments(request: ClaudeMcpRemoveRequest): string[] {
	return ['mcp', 'remove', '--scope', request.scope, request.name];
}
