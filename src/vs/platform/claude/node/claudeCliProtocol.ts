/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudePromptMessage } from './claudeQuery.js';

/**
 * What Klawly reads from the lines Claude Code prints with
 * `--output-format stream-json`: the fields it needs, nothing more. The full
 * shapes are documented at https://code.claude.com/docs/en/headless.
 */
export interface ClaudeCliInitMessage {
	readonly type: 'system';
	readonly subtype: 'init';
	readonly session_id?: string;
	readonly model?: string;
	readonly slash_commands?: readonly string[];
	readonly agents?: readonly string[];
	readonly mcp_servers?: readonly { readonly name: string; readonly status: string }[];
}

/** One line of stream-json output that was not JSON. Claude Code prints only JSON, so this is a crash message or a warning. */
export interface ClaudeCliLineBatch {
	readonly messages: readonly unknown[];
	readonly invalid: readonly string[];
}

/**
 * Splits Claude Code's stdout into JSON messages. A chunk may end in the middle
 * of a line, so the rest waits for the next chunk. Line endings are `\n`, with
 * an optional `\r`.
 */
export class ClaudeJsonLineParser {
	private _rest = '';

	push(chunk: string): ClaudeCliLineBatch {
		this._rest += chunk;
		const lines = this._rest.split('\n');
		this._rest = lines.pop() ?? '';
		return readLines(lines);
	}

	/** The last line when the process ended without a final line break. */
	end(): ClaudeCliLineBatch {
		const last = this._rest;
		this._rest = '';
		return readLines([last]);
	}
}

function readLines(lines: readonly string[]): ClaudeCliLineBatch {
	const messages: unknown[] = [];
	const invalid: string[] = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) {
			continue;
		}
		try {
			messages.push(JSON.parse(line));
		} catch {
			invalid.push(line);
		}
	}
	return { messages, invalid };
}

/** The line that sends one user message on stdin with `--input-format stream-json`. */
export function claudeUserLine(message: ClaudePromptMessage): string {
	return `${JSON.stringify(message)}\n`;
}

/** Reads the `system` / `init` message, the one Claude Code prints once it is up. */
export function readClaudeCliInit(message: unknown): ClaudeCliInitMessage | undefined {
	if (typeof message !== 'object' || message === null) {
		return undefined;
	}
	const record = message as Record<string, unknown>;
	if (record.type !== 'system' || record.subtype !== 'init') {
		return undefined;
	}
	const strings = (value: unknown): string[] | undefined => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
	const servers = Array.isArray(record.mcp_servers)
		? record.mcp_servers.flatMap(server => typeof server === 'object' && server !== null && typeof (server as { name?: unknown }).name === 'string'
			? [{ name: (server as { name: string }).name, status: String((server as { status?: unknown }).status ?? '') }]
			: [])
		: undefined;
	return {
		type: 'system',
		subtype: 'init',
		session_id: typeof record.session_id === 'string' ? record.session_id : undefined,
		model: typeof record.model === 'string' ? record.model : undefined,
		slash_commands: strings(record.slash_commands),
		agents: strings(record.agents),
		mcp_servers: servers,
	};
}

/** The session id a message carries, when it has one. */
export function claudeCliSessionId(message: unknown): string | undefined {
	const id = typeof message === 'object' && message !== null ? (message as { session_id?: unknown }).session_id : undefined;
	return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** True for the message that ends a turn of the main conversation. */
export function isClaudeCliResult(message: unknown): boolean {
	return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'result';
}
