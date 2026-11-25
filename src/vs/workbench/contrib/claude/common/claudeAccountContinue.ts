/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ClaudeModelInfo } from '../../../../platform/claude/common/claude.js';
import { ClaudeAccountEntry, claudeAccountNeedsSignIn, claudeAccountsSharingSignIn, ClaudeUsageLimit } from '../../../../platform/claude/common/claudeAccounts.js';

/** A button that retries the stopped turn on another signed-in account (issue 815). */
export interface ClaudeRetryAccountAction {
	readonly accountId: string;
	readonly label: string;
}

/**
 * "Retry with <account>" for each other account that is signed in and not flagged
 * as needing a new sign-in. The account that hit the limit is left out.
 */
export function claudeRetryAccountActions(accounts: readonly ClaudeAccountEntry[], limitedAccountId: string): readonly ClaudeRetryAccountAction[] {
	const sharing = claudeAccountsSharingSignIn(accounts);
	return accounts
		.filter(account => account.id !== limitedAccountId && !claudeAccountNeedsSignIn(account, sharing))
		.map(account => ({ accountId: account.id, label: localize('claudeRetryWithAccount', "Retry with {0}", account.email ?? account.id) }));
}

/** The quiet chat line where a chat moved to another account. */
export function claudeContinuedDivider(account: Pick<ClaudeAccountEntry, 'email' | 'plan'>): string {
	const who = account.email ?? localize('claudeContinuedAnotherAccount', "another account");
	return account.plan
		? localize('claudeContinuedWithPlan', "Continued with {0} ({1})", who, account.plan)
		: localize('claudeContinuedWith', "Continued with {0}", who);
}

export interface ClaudeRefitResult {
	readonly model: string | undefined;
	readonly effort: string | undefined;
	/** A line saying what changed, or undefined when the chat's model and effort still fit. */
	readonly note?: string;
}

const FAMILIES = ['opus', 'sonnet', 'haiku'] as const;

function family(model: Pick<ClaudeModelInfo, 'id' | 'resolvedModel'>): string | undefined {
	const text = `${model.id} ${model.resolvedModel ?? ''}`.toLowerCase();
	return FAMILIES.find(name => text.includes(name));
}

/**
 * After a switch to a plan that lacks the chat's model, picks the nearest one:
 * the same family first, then the first model the new account has. Effort drops to
 * the highest level the new model accepts when it does not take the chat's.
 */
export function claudeRefitModel(current: { model: string | undefined; effort: string | undefined }, available: readonly ClaudeModelInfo[]): ClaudeRefitResult {
	if (!available.length) {
		return current;
	}
	let model = current.model === undefined ? undefined : available.find(candidate => candidate.id === current.model);
	let note: string | undefined;
	if (current.model !== undefined && !model) {
		const wanted = family({ id: current.model });
		model = (wanted ? available.find(candidate => family(candidate) === wanted) : undefined) ?? available[0];
		note = localize('claudeRefitModel', "{0} is not on this plan. Continuing with {1}.", current.model, model.displayName);
	}
	let effort = current.effort;
	const target = model ?? available[0];
	if (effort !== undefined) {
		const levels: readonly string[] = target.supportsEffort ? target.supportedEffortLevels ?? [] : [];
		if (!levels.includes(effort)) {
			effort = levels.length ? levels[levels.length - 1] : undefined;
			const effortNote = localize('claudeRefitEffort', "{0} takes effort {1}.", target.displayName, effort ?? localize('claudeRefitNoEffort', "none"));
			note = note ? `${note} ${effortNote}` : effortNote;
		}
	}
	return { model: model?.id ?? current.model, effort, note };
}

/** Share of a window, 0 to 100, from which a calm note appears before the turn stops. */
export const CLAUDE_EARLY_WARNING_PERCENT = 80;

/**
 * A calm note at `allowed_warning`, or at 80 percent of a window or more, before
 * the turn stops. Undefined once the limit stopped the turn (the banner covers it).
 */
export function claudeEarlyWarning(limit: ClaudeUsageLimit | undefined): string | undefined {
	if (!limit || limit.status === 'rejected') {
		return undefined;
	}
	if (limit.status !== 'warning' && !(limit.percent !== undefined && limit.percent >= CLAUDE_EARLY_WARNING_PERCENT)) {
		return undefined;
	}
	const used = limit.percent !== undefined ? Math.round(limit.percent) : undefined;
	switch (limit.window) {
		case 'session': return used !== undefined ? localize('claudeWarnSessionPercent', "You have used {0}% of your 5-hour session.", used) : localize('claudeWarnSession', "You are close to your 5-hour session limit.");
		case 'week': return used !== undefined ? localize('claudeWarnWeekPercent', "You have used {0}% of your weekly limit.", used) : localize('claudeWarnWeek', "You are close to your weekly limit.");
		case 'weekOpus': return localize('claudeWarnWeekOpus', "You are close to your weekly Opus limit.");
		case 'weekSonnet': return localize('claudeWarnWeekSonnet', "You are close to your weekly Sonnet limit.");
		default: return localize('claudeWarnUnknown', "You are close to a usage limit.");
	}
}

/** The model to offer going on with when a per-model weekly limit stopped the turn, or undefined. */
export function claudeCheaperModelAction(limit: ClaudeUsageLimit | undefined, available: readonly ClaudeModelInfo[]): { model: string; label: string } | undefined {
	if (!limit || limit.status !== 'rejected' || !limit.model) {
		return undefined;
	}
	const other = available.find(candidate => {
		const name = family(candidate);
		return name !== undefined && name !== limit.model;
	});
	return other ? { model: other.id, label: localize('claudeGoOnWithModel', "Go On with {0}", other.displayName) } : undefined;
}
