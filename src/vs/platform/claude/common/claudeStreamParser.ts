/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeEvent } from './claudeRuntime.js';

type Json = { [key: string]: unknown };

function asObject(value: unknown): Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {};
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

/** Turns tool_result content (a string or a list of blocks) into plain text. */
function toolResultText(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content.map(block => asString(asObject(block).text) ?? '').join('');
	}
	return '';
}

/**
 * Parses the CLI's `--output-format stream-json --include-partial-messages` lines into normalized events.
 * Holds the little state it needs: which assistant messages already streamed their text as deltas,
 * so the complete message does not repeat it.
 */
export class ClaudeStreamParser {

	private sessionId = '';
	private streamedMessageIds = new Set<string>();
	private currentStreamMessageId = '';

	/** The session id the CLI reported, empty until its first line. */
	get id(): string {
		return this.sessionId;
	}

	/** Parses one stdout line. Returns the events it holds; blank or unparsable lines give none. */
	parseLine(line: string): ClaudeEvent[] {
		const trimmed = line.trim();
		if (!trimmed) {
			return [];
		}
		let message: Json;
		try {
			message = asObject(JSON.parse(trimmed));
		} catch {
			return [];
		}
		this.sessionId = asString(message.session_id) ?? this.sessionId;
		const sessionId = this.sessionId;

		switch (message.type) {
			case 'system':
				if (message.subtype === 'init') {
					return [{ type: 'started', sessionId, model: asString(message.model), cwd: asString(message.cwd) }];
				}
				if (message.subtype === 'status' && PERMISSION_MODES.includes(message.permissionMode as string)) {
					return [{ type: 'mode', sessionId, mode: message.permissionMode as 'default' }];
				}
				return [];
			case 'stream_event':
				return this.parseStreamEvent(sessionId, asObject(message.event));
			case 'assistant':
				return this.parseAssistant(sessionId, asObject(message.message));
			case 'user':
				return this.parseUser(sessionId, asObject(message.message));
			case 'control_request': {
				const request = asObject(message.request);
				if (request.subtype !== 'can_use_tool') {
					return [];
				}
				return [{
					type: 'permission',
					sessionId,
					requestId: asString(message.request_id) ?? '',
					toolName: asString(request.tool_name) ?? '',
					input: asObject(request.input),
					description: asString(request.description),
				}];
			}
			case 'rate_limit_event': {
				const info = asObject(message.rate_limit_info);
				return [{ type: 'rateLimit', sessionId, status: asString(info.status) ?? 'unknown', resetsAt: asNumber(info.resetsAt) }];
			}
			case 'result': {
				const usage = asObject(message.usage);
				return [{
					type: 'result',
					sessionId,
					isError: message.is_error === true,
					text: asString(message.result) ?? '',
					costUsd: asNumber(message.total_cost_usd),
					usage: { inputTokens: asNumber(usage.input_tokens) ?? 0, outputTokens: asNumber(usage.output_tokens) ?? 0 },
				}];
			}
			default:
				return [];
		}
	}

	private parseStreamEvent(sessionId: string, event: Json): ClaudeEvent[] {
		if (event.type === 'message_start') {
			this.currentStreamMessageId = asString(asObject(event.message).id) ?? '';
			return [];
		}
		if (event.type === 'content_block_delta') {
			const delta = asObject(event.delta);
			const text = asString(delta.text);
			if (delta.type === 'text_delta' && text) {
				this.streamedMessageIds.add(this.currentStreamMessageId);
				return [{ type: 'text', sessionId, text }];
			}
		}
		return [];
	}

	private parseAssistant(sessionId: string, message: Json): ClaudeEvent[] {
		const alreadyStreamed = this.streamedMessageIds.delete(asString(message.id) ?? '');
		const events: ClaudeEvent[] = [];
		for (const raw of Array.isArray(message.content) ? message.content : []) {
			const block = asObject(raw);
			if (block.type === 'text' && !alreadyStreamed) {
				events.push({ type: 'text', sessionId, text: asString(block.text) ?? '' });
			} else if (block.type === 'tool_use') {
				events.push({ type: 'toolUse', sessionId, toolUseId: asString(block.id) ?? '', name: asString(block.name) ?? '', input: asObject(block.input) });
			}
		}
		return events;
	}

	private parseUser(sessionId: string, message: Json): ClaudeEvent[] {
		const events: ClaudeEvent[] = [];
		for (const raw of Array.isArray(message.content) ? message.content : []) {
			const block = asObject(raw);
			if (block.type === 'tool_result') {
				events.push({ type: 'toolResult', sessionId, toolUseId: asString(block.tool_use_id) ?? '', output: toolResultText(block.content), isError: block.is_error === true });
			}
		}
		return events;
	}
}
