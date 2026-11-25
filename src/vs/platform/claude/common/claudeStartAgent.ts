/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_KLAWLY_MCP_SERVER } from './claudeTerminalRun.js';

/**
 * start_agent (issue 991): a chat starts a new local chat with a first message, in this
 * project or another one it names. The new chat gets the starter's mode and permission
 * level, so the tool never widens what the agent may do. The starter does not wait: the
 * new chat is a peer and its result is not returned. Cloud starts are out of scope (issue 1341).
 * The tool is `klawly_start_agent` on Klawly's own MCP server. It is not in the read-only set,
 * so the permission cards ask once per chat; the Auto level starts it without a card.
 */
export const CLAUDE_START_AGENT_TOOL = 'klawly_start_agent';
export const CLAUDE_START_AGENT_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_START_AGENT_TOOL}`;

export const CLAUDE_START_AGENT_TOOL_DESCRIPTION = [
	'Starts a new local chat with a first message and returns at once; the new chat runs on its own and nothing comes back.',
	'prompt is the whole first message, written for a chat that does not see this conversation.',
	'project is optional: the folder name, repository name or a distinctive part of either; leave it out to start in this chat\'s project.',
	'title is an optional short name for the chat.',
	'The new chat has the same mode and permission level as this one. Tell the user which chat you started.',
].join(' ');

/** What Claude passes to `klawly_start_agent`. */
export interface ClaudeStartAgentToolArgs {
	readonly prompt: string;
	readonly project?: string;
	readonly title?: string;
}

/** A `klawly_start_agent` call waiting for the window that owns the session. */
export type ClaudeStartAgentToolRequest = ClaudeStartAgentToolArgs & {
	readonly sessionId: string;
	readonly requestId: string;
};

export type ClaudeStartAgentToolResult =
	| { readonly kind: 'started'; readonly title: string; readonly project: string }
	| { readonly kind: 'needsPick'; readonly candidates: readonly string[] }
	| { readonly kind: 'failed'; readonly message: string };

/** Why the arguments cannot start a chat, or undefined when they can. */
export function claudeStartAgentArgsProblem(args: ClaudeStartAgentToolArgs): string | undefined {
	if (!args.prompt.trim()) {
		return 'Write the first message for the new chat in prompt.';
	}
	return undefined;
}

/** The text Claude reads back after a start. */
export function claudeStartAgentToolText(result: ClaudeStartAgentToolResult): { readonly text: string; readonly isError: boolean } {
	switch (result.kind) {
		case 'started':
			return { text: `Started the chat "${result.title}" in ${result.project}. It runs on its own with this chat's mode and permissions; no reply will come back. Tell the user it was started.`, isError: false };
		case 'needsPick':
			return { text: `More than one project fits (${result.candidates.join(', ')}). Ask the user which one, then call this tool again with a more exact project.`, isError: false };
		case 'failed':
			return { text: `Klawly could not start the chat: ${result.message}`, isError: true };
	}
}
