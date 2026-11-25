/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Issue 1171: `klawly_status` lets Claude put one short line on its chat tab while it works. */

import { CLAUDE_KLAWLY_MCP_SERVER } from './claudeTerminalRun.js';

export const CLAUDE_STATUS_TOOL = 'klawly_status';

/** The name the permission policy sees. */
export const CLAUDE_STATUS_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_STATUS_TOOL}`;

export const CLAUDE_STATUS_TOOL_DESCRIPTION = 'Show one short line about this chat to the user, on the chat tab, without waiting for a reply. kind is "info" (progress), "attention" (the user is needed soon) or "done" (the work is finished). The line clears when the user writes next. It changes nothing in the project.';

export type ClaudeStatusKind = 'info' | 'attention' | 'done';

export const CLAUDE_STATUS_KINDS: readonly ClaudeStatusKind[] = ['info', 'attention', 'done'];

/** The longest status line shown; longer text is cut. */
export const CLAUDE_STATUS_MAX_LENGTH = 120;

/** One status line from Claude for the chat `sessionId`. */
export interface ClaudeStatusReport {
	readonly sessionId: string;
	readonly text: string;
	readonly kind: ClaudeStatusKind;
}

/** Makes the reported text one trimmed line of at most the shown length; empty text is undefined. */
export function claudeStatusText(text: string): string | undefined {
	const line = text.replace(/\s+/g, ' ').trim();
	if (!line) {
		return undefined;
	}
	return line.length > CLAUDE_STATUS_MAX_LENGTH ? `${line.slice(0, CLAUDE_STATUS_MAX_LENGTH - 1)}…` : line;
}
