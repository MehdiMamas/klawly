/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeCommandInfo } from '../../../../platform/claude/common/claudeCommands.js';
import { AgentEnvelope } from '../../../../platform/claude/common/claudePrompt.js';

/** The `/visualize` prompt (issue 492): Klawly expands it before Claude Code sees it. */
export const CLAUDE_VISUALIZE_COMMAND = 'visualize';

/**
 * What `/visualize <subject>` sends. It names the two fences the timeline draws:
 * Mermaid for structure, and the small chart spec (or Vega-Lite) for numbers.
 */
function visualizePrompt(subject: string): string {
	return [
		`Visualize this: ${subject}`,
		'',
		'Answer with one compact visual and at most two sentences around it. Read the code or run commands first if you need facts.',
		'- For structure, flow, sequence or relations: one ```mermaid block (flowchart, sequenceDiagram, classDiagram, stateDiagram or erDiagram), at most about 15 nodes.',
		'- For numbers: one ```chart block with JSON {"type": "bar" | "line", "title": "...", "x": "axis title", "y": "axis title", "labels": ["..."], "series": [{"name": "...", "values": [1, 2]}]}. A ```vega-lite block with inline data.values, a bar or line mark and x/y (and optional color) fields also works.',
		'Do not write files for the visual.',
	].join('\n');
}

/**
 * Expands `/visualize <subject>` into the prompt Claude gets. Returns the text unchanged
 * when it is not a `/visualize` prompt, or when Claude Code already has a command of that
 * name (the user's own command wins).
 */
export function expandClaudeVisualize(text: string, commands: readonly Pick<ClaudeCommandInfo, 'name'>[]): string {
	const match = /^\s*\/visualize(?:\s+(?<subject>[\s\S]*))?$/.exec(text);
	if (!match || commands.some(command => command.name === CLAUDE_VISUALIZE_COMMAND)) {
		return text;
	}
	const subject = match.groups?.subject?.trim();
	return visualizePrompt(subject || 'the code or topic we are discussing');
}

/** The envelope with `/visualize` expanded, for `compileSubmission`. */
export function withClaudeVisualize(envelope: AgentEnvelope, session: { readonly commands: readonly ClaudeCommandInfo[]; readonly slashCommands: readonly string[] }): AgentEnvelope {
	const userText = expandClaudeVisualize(envelope.userText, [...session.commands, ...session.slashCommands.map(name => ({ name }))]);
	return userText === envelope.userText ? envelope : { ...envelope, userText };
}
