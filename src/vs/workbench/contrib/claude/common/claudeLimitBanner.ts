/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fromNow } from '../../../../base/common/date.js';
import { localize } from '../../../../nls.js';
import { ClaudeAccountEntry, ClaudeUsageLimit } from '../../../../platform/claude/common/claudeAccounts.js';
import { ClaudeAccountLimitOptions, ClaudeLimitPolicy, ClaudeLimitPolicyChoice, claudeShouldResumeAtReset } from '../../../../platform/claude/common/claudeLimitPolicy.js';
import { CLAUDE_SWITCH_ACCOUNT_COMMAND_ID } from './claudeViews.js';

/** Where the plan can be upgraded. */
export const CLAUDE_UPGRADE_URL = 'https://claude.ai/upgrade';
/** Where a Pro or Max plan's extra usage is turned on and capped. */
export const CLAUDE_EXTRA_USAGE_URL = 'https://claude.ai/settings/usage';
/** Where a Max plan moves to a larger tier. */
export const CLAUDE_BILLING_URL = 'https://claude.ai/settings/billing';
/** Where an API account buys Console credits. */
export const CLAUDE_CONSOLE_BILLING_URL = 'https://console.anthropic.com/settings/billing';

/** One button on the usage-limit banner: a command, or a page to open. */
export interface ClaudeLimitBannerAction {
	readonly id: 'switchAccount' | 'upgrade' | 'extraUsage' | 'addCredits';
	readonly label: string;
	readonly commandId?: string;
	readonly url?: string;
}

/** The banner a turn that stopped on a plan limit shows (issue 450, DL-86). */
export interface ClaudeLimitBanner {
	readonly title: string;
	/** When the limit resets, when Claude Code said. */
	readonly detail?: string;
	/** A line with no button, such as asking a Team admin. */
	readonly note?: string;
	/** The limit policy in force, in a line; none when the chat just asks (issue 1182). */
	readonly policyLine?: string;
	/** When the limit resets and the chat can wait for it, in epoch milliseconds (issue 1182). */
	readonly waitUntil?: number;
	readonly actions: readonly ClaudeLimitBannerAction[];
}

function policyName(policy: ClaudeLimitPolicy): string {
	switch (policy) {
		case 'extraUsage': return localize('claudePolicyExtraUsage', "keep going on extra usage");
		case 'apiKey': return localize('claudePolicyApiKey', "fall back to the API key");
		case 'otherAccount': return localize('claudePolicyOtherAccount', "offer another account");
		default: return localize('claudePolicyAsk', "ask");
	}
}

/**
 * The line that says what this chat does on a limit: what it is doing now, or
 * why it asks instead. Nothing when the policy is just to ask.
 */
export function claudeLimitPolicyLine(choice: ClaudeLimitPolicyChoice, account: ClaudeAccountLimitOptions | undefined): string | undefined {
	if (choice.blocked) {
		return localize('claudePolicyBlocked', "Your policy is to {0}, but this account does not allow it. Asking instead.", policyName(choice.blocked));
	}
	switch (choice.policy) {
		case 'extraUsage':
			return account?.extraUsageCapUsd !== undefined
				? localize('claudePolicyExtraUsageCap', "Continuing on extra usage, up to ${0}.", account.extraUsageCapUsd)
				: localize('claudePolicyExtraUsageNow', "Continuing on extra usage.");
		case 'apiKey': return localize('claudePolicyApiKeyNow', "Continuing on your API key.");
		case 'otherAccount': return localize('claudePolicyOtherAccountNow', "Offering another account to continue.");
		default: return undefined;
	}
}

function limitTitle(limit: ClaudeUsageLimit | undefined): string {
	switch (limit?.window) {
		case 'session': return localize('claudeLimitSession', "You reached your 5-hour session limit.");
		case 'week': return localize('claudeLimitWeek', "You reached your weekly limit.");
		case 'weekOpus': return localize('claudeLimitWeekOpus', "You reached your weekly Opus limit.");
		case 'weekSonnet': return localize('claudeLimitWeekSonnet', "You reached your weekly Sonnet limit.");
		case 'overage': return localize('claudeLimitOverage', "You used all of your extra usage.");
		case 'credits': return localize('claudeLimitCredits', "Your Claude Console credits ran out.");
		default: return localize('claudeLimitUnknown', "Claude reached its current usage limit.");
	}
}

/**
 * What a usage-limit stop shows: which limit, when it resets, and what the plan
 * offers. Switch Account comes first on every limit, since another signed-in
 * account has its own limits. Pro and Max plans can upgrade or turn on extra
 * usage; a Team or Enterprise plan's usage is its admin's, so it only says so.
 * An API account out of credits can add more. A plan Klawly does not know
 * offers only Switch Account.
 *
 * @param resetText Formats a reset time; tests pass a fixed one.
 */
export function claudeLimitBanner(limit: ClaudeUsageLimit | undefined, resetText: (resetsAt: number) => string = resetsAt => fromNow(resetsAt, true), policyLine?: string, now: number = Date.now()): ClaudeLimitBanner {
	const resetsAt = limit?.window === 'overage' ? limit.overage?.resetsAt ?? limit.resetsAt : limit?.resetsAt;
	const waitUntil = limit && limit.window !== 'credits' && claudeShouldResumeAtReset(limit, now, true) ? resetsAt : undefined;
	const detail = resetsAt !== undefined ? localize('claudeLimitResets', "Resets {0}.", resetText(resetsAt)) : undefined;
	const actions: ClaudeLimitBannerAction[] = [{ id: 'switchAccount', label: localize('claudeLimitSwitchAccount', "Switch Account..."), commandId: CLAUDE_SWITCH_ACCOUNT_COMMAND_ID }];
	if (limit?.window === 'credits') {
		actions.push({ id: 'addCredits', label: localize('claudeLimitAddCredits', "Add Credits"), url: CLAUDE_CONSOLE_BILLING_URL });
		return { title: limitTitle(limit), detail, policyLine, waitUntil, actions };
	}
	const plan = limit?.plan?.toLowerCase();
	let note: string | undefined;
	if (plan === 'team' || plan === 'enterprise') {
		note = localize('claudeLimitAskAdmin', "Your organization manages this plan's usage. Ask your admin for more.");
	} else if (plan === 'pro' || plan === 'max') {
		if (limit?.window === 'overage') {
			actions.push({ id: 'extraUsage', label: localize('claudeLimitManageExtraUsage', "Manage Extra Usage"), url: CLAUDE_EXTRA_USAGE_URL });
		} else if (!limit?.overage?.inUse && limit?.overage?.disabledReason !== 'org_level_disabled') {
			// Extra usage keeps the turn going past the plan's limits, paid as it is used.
			actions.push({ id: 'extraUsage', label: localize('claudeLimitTurnOnExtraUsage', "Turn On Extra Usage"), url: CLAUDE_EXTRA_USAGE_URL });
		}
		actions.push(plan === 'pro'
			? { id: 'upgrade', label: localize('claudeLimitUpgradeMax', "Upgrade to Max"), url: CLAUDE_UPGRADE_URL }
			: { id: 'upgrade', label: localize('claudeLimitUpgradePlan', "Upgrade Plan"), url: CLAUDE_BILLING_URL });
	}
	return { title: limitTitle(limit), detail, note, policyLine, waitUntil, actions };
}

/** One way to carry on after a limit, from the banner: retry under an account, with a policy for this chat (issue 1385). */
export interface ClaudeLimitRetryOption {
	readonly id: 'otherAccount' | 'extraUsage' | 'apiKey';
	readonly label: string;
	/** The account to retry under; the chat's own account when absent. */
	readonly accountId?: string;
	/** The policy this chat keeps from now on. */
	readonly policy: ClaudeLimitPolicy;
}

function accountLabel(account: ClaudeAccountEntry): string {
	return account.email ?? account.organization ?? account.id;
}

/**
 * The Retry buttons a limit banner adds: one per other signed-in account, Use Extra
 * Usage when the account that hit the limit allows it, and Use API Key when it allows
 * the fallback and a signed-in account has no plan (an API key account).
 *
 * @param currentAccountId The account the chat ran under: the id the chat was pinned to, else the active one.
 */
export function claudeLimitRetryOptions(accounts: readonly ClaudeAccountEntry[], currentAccountId: string | undefined, options: ClaudeAccountLimitOptions | undefined): readonly ClaudeLimitRetryOption[] {
	const others = accounts.filter(account => account.signedIn && !account.mismatch && account.id !== currentAccountId);
	const result: ClaudeLimitRetryOption[] = [];
	for (const account of others) {
		if (account.plan !== undefined) {
			result.push({ id: 'otherAccount', label: localize('claudeLimitRetryWith', "Retry with {0}", accountLabel(account)), accountId: account.id, policy: 'otherAccount' });
		}
	}
	if (options?.allowExtraUsage) {
		result.push({ id: 'extraUsage', label: localize('claudeLimitUseExtraUsage', "Use Extra Usage"), policy: 'extraUsage' });
	}
	const apiAccount = options?.allowApiFallback ? others.find(account => account.plan === undefined) : undefined;
	if (apiAccount) {
		result.push({ id: 'apiKey', label: localize('claudeLimitUseApiKey', "Use API Key"), accountId: apiAccount.id, policy: 'apiKey' });
	}
	return result;
}
