/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The parts of the Anthropic Messages API wire format that the Copilot API
 * service reads and writes. Written from the public API reference
 * (https://docs.anthropic.com/en/api/messages); Klawly ships no Anthropic
 * package, so these stand in for the types it used to import. Unknown fields
 * are allowed everywhere, since the server may add them.
 */

export interface TextBlock {
	type: 'text';
	text: string;
	[key: string]: unknown;
}

export interface ToolUseBlock {
	type: 'tool_use';
	id: string;
	name: string;
	input: unknown;
	[key: string]: unknown;
}

export interface OtherBlock {
	type: string;
	[key: string]: unknown;
}

export type ContentBlock = TextBlock | ToolUseBlock | OtherBlock;

export interface Usage {
	input_tokens: number;
	output_tokens: number;
	[key: string]: unknown;
}

export interface Message {
	id: string;
	type: 'message';
	role: 'assistant';
	content: ContentBlock[];
	model: string;
	stop_reason: string | null;
	stop_sequence: string | null;
	usage: Usage;
	[key: string]: unknown;
}

export interface MessageParam {
	role: 'user' | 'assistant';
	content: string | OtherBlock[];
}

export interface MessageCreateParamsBase {
	model: string;
	max_tokens: number;
	messages: MessageParam[];
	system?: string | OtherBlock[];
	stream?: boolean;
	[key: string]: unknown;
}

export interface MessageCreateParamsNonStreaming extends MessageCreateParamsBase {
	stream?: false;
}

export interface MessageCreateParamsStreaming extends MessageCreateParamsBase {
	stream: true;
}

export type MessageCreateParams = MessageCreateParamsNonStreaming | MessageCreateParamsStreaming;

export interface MessageCountTokensParams {
	model: string;
	messages: MessageParam[];
	system?: string | OtherBlock[];
	[key: string]: unknown;
}

export interface MessageTokensCount {
	input_tokens: number;
}

export interface TextDelta {
	type: 'text_delta';
	text: string;
}

export interface OtherDelta {
	type: string;
	[key: string]: unknown;
}

export interface RawMessageStartEvent {
	type: 'message_start';
	message: Message;
}

export interface RawMessageDeltaEvent {
	type: 'message_delta';
	delta: { stop_reason?: string | null; stop_sequence?: string | null;[key: string]: unknown };
	usage: { output_tokens: number;[key: string]: unknown };
}

export interface RawMessageStopEvent {
	type: 'message_stop';
}

export interface RawContentBlockStartEvent {
	type: 'content_block_start';
	index: number;
	content_block: ContentBlock;
}

export interface RawContentBlockDeltaEvent {
	type: 'content_block_delta';
	index: number;
	delta: TextDelta | OtherDelta;
}

export interface RawContentBlockStopEvent {
	type: 'content_block_stop';
	index: number;
}

export type MessageStreamEvent = RawMessageStartEvent | RawMessageDeltaEvent | RawMessageStopEvent | RawContentBlockStartEvent | RawContentBlockDeltaEvent | RawContentBlockStopEvent;

export interface ErrorResponse {
	type: 'error';
	error: { type: string; message: string };
	request_id?: string | null;
}
