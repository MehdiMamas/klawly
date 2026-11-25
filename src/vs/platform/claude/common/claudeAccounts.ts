/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Claude Code sign-in Klawly found on this computer: `~/.claude`, or
 * `CLAUDE_CONFIG_DIR` when the user set one. It is always in the list, and Klawly
 * never removes its folder (issue 450).
 */
export const CLAUDE_DEFAULT_ACCOUNT_ID = 'default';

/**
 * One Claude account in Switch Account (issue 450). Every account but the
 * default one signs in inside its own folder under Klawly's user data, so
 * several stay signed in side by side. Only the sign-in differs: rules, MCP
 * servers, skills and settings are the same for every account. Accounts stay
 * on this computer and are never synced.
 */
export interface ClaudeAccountEntry {
	readonly id: string;
	readonly email?: string;
	/** The Claude plan, such as `pro` or `max`, as Claude Code names it. */
	readonly plan?: string;
	readonly organization?: string;
	/** False when Claude Code reports no sign-in in this account's folder. */
	readonly signedIn: boolean;
	/** The folder is signed in as another email than when it was added, so it needs a new sign-in. */
	readonly mismatch?: boolean;
	/** The account new sessions in every window use. */
	readonly active: boolean;
}

/**
 * Where a new account signs in: the Sign In terminal runs `claude auth login`
 * with this environment, then the workbench calls `finishAddAccount`.
 * Nothing here is a credential: it only names the account's folder.
 */
export interface ClaudeAccountSignIn {
	readonly id: string;
	readonly env: Readonly<Record<string, string>>;
}

/**
 * Which plan window a usage limit is about.
 * - `session`, `week`, `weekOpus`, `weekSonnet`: as in {@link ClaudeUsageWindowKind}.
 * - `overage`: extra usage, paid past the plan's limits.
 * - `credits`: an API account out of Console credits (`billing_error`).
 * - `unknown`: Claude Code named no window.
 */
export type ClaudeUsageLimitWindow = 'session' | 'week' | 'weekOpus' | 'weekSonnet' | 'overage' | 'credits' | 'unknown';

export type ClaudeUsageLimitStatus = 'allowed' | 'warning' | 'rejected';

/** Extra usage, as Claude Code reports it next to a plan limit. */
export interface ClaudeUsageOverage {
	readonly status?: ClaudeUsageLimitStatus;
	/** When extra usage resets, in epoch milliseconds. */
	readonly resetsAt?: number;
	/** Why extra usage cannot be used, such as `out_of_credits` or `org_level_disabled`. */
	readonly disabledReason?: string;
	/** True while requests are paid as extra usage. */
	readonly inUse?: boolean;
}

/**
 * A plan limit Claude Code reported (issue 450), normalized from its rate-limit
 * event. A turn that stopped on it carries it on `session.failed`.
 */
export interface ClaudeUsageLimit {
	readonly window: ClaudeUsageLimitWindow;
	readonly status: ClaudeUsageLimitStatus;
	/** When the window resets, in epoch milliseconds. */
	readonly resetsAt?: number;
	/** How much of the window is used, 0 to 100, when Claude Code says. */
	readonly percent?: number;
	readonly overage?: ClaudeUsageOverage;
	/** The model family the window is about, when it is a per-model window. */
	readonly model?: 'opus' | 'sonnet';
	/** The plan of the account that hit the limit, such as `pro` or `max`. The runner adds it from the account it knows. */
	readonly plan?: string;
}

/**
 * Ids of folders that report the same sign-in as an earlier folder. On macOS Claude
 * Code keeps the sign-in in the keychain, so two folders may serve one account
 * (issue 815). Such an added folder needs a new sign-in; the default account is
 * never flagged.
 */
export function claudeAccountsSharingSignIn(accounts: readonly Pick<ClaudeAccountEntry, 'id' | 'email' | 'signedIn'>[]): ReadonlySet<string> {
	const seen = new Set<string>();
	const shared = new Set<string>();
	for (const account of accounts) {
		const email = account.signedIn ? account.email?.toLowerCase() : undefined;
		if (!email) {
			continue;
		}
		if (seen.has(email) && account.id !== CLAUDE_DEFAULT_ACCOUNT_ID) {
			shared.add(account.id);
		}
		seen.add(email);
	}
	return shared;
}

/** Whether an account's folder needs a new sign-in: signed out, another email than when added, or the same sign-in as an earlier folder. */
export function claudeAccountNeedsSignIn(account: Pick<ClaudeAccountEntry, 'id' | 'signedIn' | 'mismatch'>, sharing: ReadonlySet<string>): boolean {
	return !account.signedIn || !!account.mismatch || sharing.has(account.id);
}

const LIMIT_WINDOWS: Readonly<Record<string, ClaudeUsageLimitWindow>> = {
	five_hour: 'session',
	seven_day: 'week',
	seven_day_opus: 'weekOpus',
	seven_day_sonnet: 'weekSonnet',
	seven_day_overage_included: 'week',
	overage: 'overage',
};

function limitStatus(value: unknown): ClaudeUsageLimitStatus | undefined {
	switch (value) {
		case 'allowed': return 'allowed';
		case 'allowed_warning': return 'warning';
		case 'rejected': return 'rejected';
		default: return undefined;
	}
}

/** A reset time in epoch milliseconds. Claude Code sends seconds; a value already in milliseconds is kept. */
function epochMilliseconds(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	return value < 1e12 ? value * 1000 : value;
}

/**
 * Reads Claude Code's `rate_limit_info`. Undefined when it is not one, so an
 * unknown shape never invents a limit.
 */
export function claudeUsageLimitFromRateLimitInfo(info: unknown): ClaudeUsageLimit | undefined {
	if (!info || typeof info !== 'object') {
		return undefined;
	}
	const record = info as Record<string, unknown>;
	const status = limitStatus(record.status);
	if (!status) {
		return undefined;
	}
	const window = typeof record.rateLimitType === 'string' ? LIMIT_WINDOWS[record.rateLimitType] ?? 'unknown' : 'unknown';
	const percent = typeof record.utilization === 'number' && Number.isFinite(record.utilization)
		// Claude Code sends a fraction here, while its usage report sends a percentage.
		? Math.min(100, Math.max(0, record.utilization <= 1 ? record.utilization * 100 : record.utilization))
		: undefined;
	const overageStatus = limitStatus(record.overageStatus);
	const overageResetsAt = epochMilliseconds(record.overageResetsAt);
	const disabledReason = typeof record.overageDisabledReason === 'string' ? record.overageDisabledReason : undefined;
	const inUse = record.isUsingOverage === true || record.overageInUse === true ? true : undefined;
	const overage: ClaudeUsageOverage | undefined = overageStatus || overageResetsAt || disabledReason || inUse
		? { status: overageStatus, resetsAt: overageResetsAt, disabledReason, inUse }
		: undefined;
	return {
		window,
		status,
		resetsAt: epochMilliseconds(record.resetsAt),
		percent,
		overage,
		model: window === 'weekOpus' ? 'opus' : window === 'weekSonnet' ? 'sonnet' : undefined,
	};
}
