/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Issue 1169: `klawly_mode` returns the chat's modes as data, so Claude can check them again after compaction. */

import { AgentMode } from './claudeContext.js';
import { ClaudeReplyStyle } from './claudeReplyStyle.js';
import { ClaudeSessionPermissions, claudeRunsUnasked } from './claudeSessionPermissions.js';
import { CLAUDE_KLAWLY_MCP_SERVER } from './claudeTerminalRun.js';

export const CLAUDE_MODE_TOOL = 'klawly_mode';

/** The name the permission policy sees. */
export const CLAUDE_MODE_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_MODE_TOOL}`;

export const CLAUDE_MODE_TOOL_DESCRIPTION = 'Return the modes of this chat as JSON: the chat mode (agent, ask, plan or debug), the permission level (ask-each-time, allow-all-commands or allow-everything), whether the workspace is trusted, and the reply style (default or adhd). It changes nothing. Call it when you are unsure which modes apply, for example after the conversation was compacted.';

/** What the modes of one chat are right now. */
export interface ClaudeModeState {
	readonly chatMode: AgentMode;
	readonly permissionLevel: 'ask-each-time' | 'allow-all-commands' | 'allow-everything';
	/** True when Allow Everything runs tools without a card in this mode. */
	readonly runsUnasked: boolean;
	/** True when Allow Everything also covers credentials. */
	readonly allowCredentials: boolean;
	readonly workspaceTrusted: boolean;
	readonly replyStyle: ClaudeReplyStyle;
}

/** Reads the state from what the runner already holds. Pure, so the same call can be tested. */
export function claudeModeState(mode: AgentMode, permissions: ClaudeSessionPermissions | undefined, trusted: boolean, replyStyle: ClaudeReplyStyle | undefined): ClaudeModeState {
	const level = permissions?.allowEverything ? 'allow-everything' : permissions?.allowAllCommands ? 'allow-all-commands' : 'ask-each-time';
	return {
		chatMode: mode,
		permissionLevel: level,
		runsUnasked: claudeRunsUnasked(permissions, mode, trusted),
		allowCredentials: permissions?.allowCredentials === true,
		workspaceTrusted: trusted,
		replyStyle: replyStyle === 'adhd' ? 'adhd' : 'default',
	};
}
