/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_DELEGATE_TOOL } from '../../../../platform/claude/common/claudeDelegate.js';
import { ClaudeCommandInfo } from '../../../../platform/claude/common/claudeCommands.js';
import { CLAUDE_DELEGATE_TEMPLATES, CLAUDE_DELEGATE_TEMPLATE_LABELS, ClaudeDelegateTemplate } from '../../../../platform/claude/common/claudeDelegateTemplates.js';
import { claudeReviewLoopPrompt } from '../../../../platform/claude/common/claudeReviewCli.js';
import { AgentEnvelope } from '../../../../platform/claude/common/claudePrompt.js';

/**
 * The slash rows for the delegate templates (issue 1110): `/watch-ci`,
 * `/run-tests`, `/merge-pr` and `/find`. Klawly expands them on send into a
 * `klawly_delegate` call with the template, so a user can ask for one by name.
 */
export function expandClaudeDelegateTemplateSlash(text: string, commands: readonly Pick<ClaudeCommandInfo, 'name'>[]): string {
	const match = /^\s*\/(?<name>[a-z-]+)(?:\s+(?<args>[\s\S]*))?$/.exec(text);
	const name = match?.groups?.name;
	if (name === 'review-loop' && !commands.some(command => command.name === name)) {
		return claudeReviewLoopPrompt();
	}
	if (!name || !(CLAUDE_DELEGATE_TEMPLATES as readonly string[]).includes(name) || commands.some(command => command.name === name)) {
		return text;
	}
	const template = name as ClaudeDelegateTemplate;
	const args = match.groups?.args?.trim();
	if (!args) {
		return `Use ${CLAUDE_DELEGATE_TOOL} with template "${template}" (${CLAUDE_DELEGATE_TEMPLATE_LABELS[template]}). I did not say what it is for: ask me before you start.`;
	}
	return `Use ${CLAUDE_DELEGATE_TOOL} with template "${template}" (${CLAUDE_DELEGATE_TEMPLATE_LABELS[template]}) and args: ${args}`;
}

/** The envelope with a delegate template slash command expanded, for `compileSubmission`. */
export function withClaudeDelegateTemplateSlash(envelope: AgentEnvelope, session: { readonly commands: readonly ClaudeCommandInfo[]; readonly slashCommands: readonly string[] }): AgentEnvelope {
	const userText = expandClaudeDelegateTemplateSlash(envelope.userText, [...session.commands, ...session.slashCommands.map(name => ({ name }))]);
	return userText === envelope.userText ? envelope : { ...envelope, userText };
}
