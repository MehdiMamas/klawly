/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_PLAN_DEPENDS_INSTRUCTIONS } from './claudePlanDependsPrompt.js';
import { CLAUDE_ADHD_REPLY_INSTRUCTIONS } from './claudeReplyStyle.js';
import { CLAUDE_ALLOW_EVERYTHING_INSTRUCTIONS } from './claudeSessionPermissions.js';
import { CLAUDE_KLAWLY_MCP_INSTRUCTIONS } from './claudeTerminalRun.js';

/** Issue 1172: every text Klawly adds to Claude's system prompt, for the read-only Settings view. */
export const CLAUDE_INJECTED_INSTRUCTIONS: readonly { readonly id: string; readonly title: string; readonly text: string }[] = [
	{ id: 'injectedTools', title: 'Klawly Tools', text: CLAUDE_KLAWLY_MCP_INSTRUCTIONS },
	{ id: 'injectedPlan', title: 'Plan Mode', text: CLAUDE_PLAN_DEPENDS_INSTRUCTIONS },
	{ id: 'injectedAllowEverything', title: 'Allow Everything', text: CLAUDE_ALLOW_EVERYTHING_INSTRUCTIONS },
	{ id: 'injectedAdhd', title: 'ADHD Mode Reply Style', text: CLAUDE_ADHD_REPLY_INSTRUCTIONS },
];
