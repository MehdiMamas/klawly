/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Issue 1174: `klawly_feedback` opens the Send Feedback form with Claude's text filled in. It never
 * sends: the report goes out only when the user clicks Send in the form, through the same sign-in,
 * relay and triage as any other report.
 */

import { CLAUDE_KLAWLY_MCP_SERVER } from './claudeTerminalRun.js';

export const CLAUDE_FEEDBACK_TOOL = 'klawly_feedback';

/** The name the permission policy sees. */
export const CLAUDE_FEEDBACK_TOOL_ID = `mcp__${CLAUDE_KLAWLY_MCP_SERVER}__${CLAUDE_FEEDBACK_TOOL}`;

export const CLAUDE_FEEDBACK_TOOL_DESCRIPTION = 'Open Klawly\'s Send Feedback form with a report filled in (title, description, kind bug, idea or other). Use it when the user wants something sent as feedback to the Klawly team. Nothing is sent by this tool: the user reads the form, can change it, and sends it with the Send button themselves. Write the description in plain words from the user\'s own words and your diagnosis, with no secrets, tokens or personal paths. One call per topic; ask the user before splitting or merging topics.';

export type ClaudeFeedbackToolKind = 'bug' | 'idea' | 'other';

export const CLAUDE_FEEDBACK_TOOL_KINDS: readonly ClaudeFeedbackToolKind[] = ['bug', 'idea', 'other'];

/** A report Claude wants the user to review and send, for the chat `sessionId`. */
export interface ClaudeFeedbackToolRequest {
	readonly sessionId: string;
	readonly title: string;
	readonly description: string;
	readonly kind: ClaudeFeedbackToolKind;
}

/** What the tool says back to Claude once the form is requested. */
export const CLAUDE_FEEDBACK_TOOL_RESULT = 'The Send Feedback form is open on the user\'s screen with your text. Nothing has been sent: the user sends it themselves with the Send button, or cancels. Do not say it was sent.';

/** Makes the title one trimmed line and cuts both to the form's limits; undefined when either is empty. */
export function claudeFeedbackToolText(title: string, description: string): { readonly title: string; readonly description: string } | undefined {
	const line = title.replace(/\s+/g, ' ').trim().slice(0, 200);
	const body = description.trim().slice(0, 30_000);
	return line && body ? { title: line, description: body } : undefined;
}
