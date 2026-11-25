/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_CANVAS_TOOL } from '../../../../platform/claude/common/claudeCanvas.js';
import { ClaudeCommandInfo } from '../../../../platform/claude/common/claudeCommands.js';
import { AgentEnvelope } from '../../../../platform/claude/common/claudePrompt.js';

/** The `/canvas` prompt (issue 1039): Klawly expands it before Claude Code sees it. */
export const CLAUDE_CANVAS_COMMAND = 'canvas';

/**
 * Expands `/canvas <prompt>` into a prompt that tells Claude to build the page with the
 * `klawly_canvas` tool. Returns the text unchanged when it is not a `/canvas` prompt, or
 * when Claude Code already has a command of that name (the user's own command wins).
 */
export function expandClaudeCanvas(text: string, commands: readonly Pick<ClaudeCommandInfo, 'name'>[]): string {
	const match = /^\s*\/canvas(?:\s+(?<subject>[\s\S]*))?$/.exec(text);
	if (!match || commands.some(command => command.name === CLAUDE_CANVAS_COMMAND)) {
		return text;
	}
	const subject = match.groups?.subject?.trim() || 'the code or topic we are discussing';
	return [
		`Build this as a canvas: ${subject}`,
		'',
		`Use the ${CLAUDE_CANVAS_TOOL} tool to create it as one self-contained HTML page (plain HTML, CSS and JavaScript, no external libraries). Read the code or run commands first if you need facts. Keep your reply to at most two sentences.`,
	].join('\n');
}

/** The envelope with `/canvas` expanded, for `compileSubmission`. */
export function withClaudeCanvas(envelope: AgentEnvelope, session: { readonly commands: readonly ClaudeCommandInfo[]; readonly slashCommands: readonly string[] }): AgentEnvelope {
	const userText = expandClaudeCanvas(envelope.userText, [...session.commands, ...session.slashCommands.map(name => ({ name }))]);
	return userText === envelope.userText ? envelope : { ...envelope, userText };
}
