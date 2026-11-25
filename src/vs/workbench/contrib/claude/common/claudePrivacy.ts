/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ClaudeRuntimeState } from '../../../../platform/claude/common/claude.js';
import { ClaudeAccountOverview } from '../../../../platform/claude/common/claudeAccount.js';
import { claudeAccountSummary, claudePlanLabel } from './claudeSettingsPages.js';

/** Where a Claude plan (Free, Pro, Max) chooses whether its chats and coding sessions train Claude. */
export const CLAUDE_PRIVACY_SETTINGS_URL = 'https://claude.ai/settings/data-privacy-controls';
/** Claude Code's page on how each account type's data is used, kept and reported. */
export const CLAUDE_DATA_USAGE_URL = 'https://docs.anthropic.com/en/docs/claude-code/data-usage';
const BEDROCK_DATA_URL = 'https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html';
const VERTEX_DATA_URL = 'https://cloud.google.com/vertex-ai/generative-ai/docs/data-governance';

/** Claude plans under Anthropic's commercial terms; every other plan is under the consumer terms. */
const COMMERCIAL_PLANS = new Set(['team', 'enterprise']);

/** The Privacy page's account row: which terms apply to the account Claude Code signed in with, and where to read or change them. */
export interface ClaudePrivacyAccount {
	readonly label: string;
	readonly detail: string;
	readonly link?: { readonly label: string; readonly url: string };
}

/**
 * Describes the data terms of Claude Code's sign-in (issue 522). Klawly owns no
 * training switch: the account decides, so the row names the account type and
 * links to that account's own settings or terms.
 */
export function claudePrivacyAccount(state: ClaudeRuntimeState | undefined, overview: ClaudeAccountOverview | undefined): ClaudePrivacyAccount {
	if (!state?.installed || !state.authenticated) {
		const summary = claudeAccountSummary(state);
		return { label: summary.label, detail: localize('claudePrivacySignedOut', "Sign in to Claude Code to see which data terms apply to your account.") };
	}
	const readUsage = { label: localize('claudePrivacyReadUsage', "Read Data Usage"), url: CLAUDE_DATA_USAGE_URL };
	switch (state.authMode) {
		case 'claude-account': {
			const plan = overview?.account?.plan;
			const label = plan ? localize('claudePrivacyPlan', "Claude {0} Plan", claudePlanLabel(plan)) : localize('claudePrivacyClaudeAccount', "Claude Account");
			if (plan && COMMERCIAL_PLANS.has(plan.toLowerCase())) {
				return { label, detail: localize('claudePrivacyCommercialPlan', "Commercial terms. Anthropic does not train models on your code or prompts unless your organization opts in; your admin sets how long they are kept"), link: readUsage };
			}
			return {
				label,
				detail: localize('claudePrivacyConsumer', "Consumer terms. You choose whether your chats and coding sessions help train Claude in your Claude privacy settings"),
				link: { label: localize('claudePrivacyOpenSettings', "Open Privacy Settings"), url: CLAUDE_PRIVACY_SETTINGS_URL },
			};
		}
		case 'api-key':
			return { label: localize('claudePrivacyApiKey', "API Key"), detail: localize('claudePrivacyApiKeyDetail', "Commercial terms through the Claude Console. Anthropic does not train models on your code or prompts unless your organization opts in"), link: readUsage };
		case 'enterprise':
			return { label: localize('claudePrivacyEnterprise', "Your Organization"), detail: localize('claudePrivacyEnterpriseDetail', "Claude Code signs in through your organization, whose agreement decides how your code and prompts are used and kept"), link: readUsage };
		case 'bedrock':
			return { label: localize('claudePrivacyBedrock', "Amazon Bedrock"), detail: localize('claudePrivacyBedrockDetail', "Requests go to Amazon Bedrock under your AWS agreement, which decides how they are used and kept"), link: { label: localize('claudePrivacyReadAws', "Read AWS Data Protection"), url: BEDROCK_DATA_URL } };
		case 'vertex':
			return { label: localize('claudePrivacyVertex', "Google Vertex AI"), detail: localize('claudePrivacyVertexDetail', "Requests go to Google Vertex AI under your Google Cloud agreement, which decides how they are used and kept"), link: { label: localize('claudePrivacyReadGoogle', "Read Google Data Governance"), url: VERTEX_DATA_URL } };
		default:
			return { label: localize('claudePrivacySignedIn', "Signed In"), detail: localize('claudePrivacyUnknown', "Claude Code did not say how it signed in. Its data usage page lists the terms for each account type"), link: readUsage };
	}
}
