/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { AgentMode } from '../../../../../platform/claude/common/claudeContext.js';

export interface ClaudeModeDescriptor {
	readonly mode: AgentMode;
	readonly label: string;
	/** One line on what the mode may do, shown in the mode menu (Phase 27). */
	readonly description: string;
	readonly placeholder: string;
	readonly icon: ThemeIcon;
}

/** Menu order: Agent, Plan, Ask, Debug (issue 484). Shift+Tab cycles through the same order. */
export function claudeModes(): readonly ClaudeModeDescriptor[] {
	return [
		{
			mode: 'agent',
			label: localize('claudeModeAgent', "Agent"),
			description: localize('claudeModeAgentDesc', "Edits workspace files. Commands, web and MCP ask."),
			placeholder: localize('claudeComposerPlaceholder', "Plan, build, / for commands, @ for context"),
			icon: Codicon.sparkle,
		},
		{
			mode: 'plan',
			label: localize('claudeModePlan', "Plan"),
			description: localize('claudeModePlanDesc', "Reads and runs commands. Writes only plan files."),
			placeholder: localize('claudeComposerPlanPlaceholder', "Describe what to plan — only plan files change until Build"),
			icon: Codicon.checklist,
		},
		{
			mode: 'ask',
			label: localize('claudeModeAsk', "Ask"),
			description: localize('claudeModeAskDesc', "Reads and runs commands. Never edits files."),
			placeholder: localize('claudeComposerAskPlaceholder', "Ask about the codebase — no files change"),
			icon: Codicon.commentDiscussion,
		},
		{
			mode: 'debug',
			label: localize('claudeModeDebug', "Debug"),
			description: localize('claudeModeDebugDesc', "Hypotheses, logging, your reproduction, then a small fix."),
			placeholder: localize('claudeComposerDebugPlaceholder', "Describe the bug — Claude logs it, you reproduce it"),
			icon: Codicon.bug,
		},
	];
}

export function describeMode(mode: AgentMode): ClaudeModeDescriptor {
	const modes = claudeModes();
	return modes.find(candidate => candidate.mode === mode) ?? modes[0];
}

/** The idle composer's placeholder: the mode's prompt in a new chat, a follow-up once the session has a turn. */
export function composerPlaceholder(mode: AgentMode, followUp: boolean): string {
	return followUp ? localize('claudeFollowUpPlaceholder', "Add a follow-up") : describeMode(mode).placeholder;
}

export function nextMode(mode: AgentMode, reverse = false): AgentMode {
	const modes = claudeModes();
	const index = modes.findIndex(candidate => candidate.mode === mode);
	const step = reverse ? modes.length - 1 : 1;
	return modes[(index + step) % modes.length].mode;
}
