/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeUsageWindow } from '../../../../platform/claude/common/claudeAccount.js';
import { ClaudeAccountEntry } from '../../../../platform/claude/common/claudeAccounts.js';
import { claudeChatAccountLabel } from '../../../../platform/claude/common/claudeChatAccount.js';

/** The plan limits last seen for one account, kept so Plan & Usage can show every account side by side. */
export interface ClaudeKnownUsage {
	readonly checkedAt: number;
	readonly windows: readonly ClaudeUsageWindow[];
}

export type ClaudeKnownUsageByAccount = Readonly<Record<string, ClaudeKnownUsage>>;

/** Reads the stored usage of every account; anything malformed reads as nothing known. */
export function readClaudeKnownUsage(raw: string | undefined): ClaudeKnownUsageByAccount {
	try {
		const parsed: unknown = raw ? JSON.parse(raw) : undefined;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {};
		}
		const known: Record<string, ClaudeKnownUsage> = {};
		for (const [id, value] of Object.entries(parsed as Record<string, Partial<ClaudeKnownUsage> | undefined>)) {
			if (value && typeof value.checkedAt === 'number' && Array.isArray(value.windows)) {
				known[id] = { checkedAt: value.checkedAt, windows: value.windows.filter(window => typeof window?.percent === 'number') };
			}
		}
		return known;
	} catch {
		return {};
	}
}

/** The stored usage with this account's windows replaced by the ones just seen. */
export function withClaudeKnownUsage(known: ClaudeKnownUsageByAccount, accountId: string, windows: readonly ClaudeUsageWindow[], checkedAt: number): ClaudeKnownUsageByAccount {
	return { ...known, [accountId]: { checkedAt, windows } };
}

/** One signed-in account in the side-by-side view. */
export interface ClaudeAccountUsageRow {
	readonly accountId: string;
	readonly label: string;
	readonly active: boolean;
	/** The windows last seen, or none when this account's limits were never read. */
	readonly windows: readonly ClaudeUsageWindow[];
	readonly checkedAt?: number;
	/** The soonest reset still ahead among its windows, in epoch milliseconds. */
	readonly resetsAt?: number;
	/** True for the one account whose limits reset first. */
	readonly resetsFirst: boolean;
}

/**
 * The rows of the all-accounts view: each signed-in account with its last-seen
 * windows, and a mark on the account that resets first. Fewer than two signed-in
 * accounts give no rows, as there is nothing to compare.
 */
export function claudeAccountsUsageRows(accounts: readonly ClaudeAccountEntry[], known: ClaudeKnownUsageByAccount, now: number): readonly ClaudeAccountUsageRow[] {
	const signedIn = accounts.filter(account => account.signedIn);
	if (signedIn.length < 2) {
		return [];
	}
	const rows = signedIn.map(account => {
		const entry = known[account.id];
		const windows = entry?.windows ?? [];
		const upcoming = windows.map(window => window.resetsAt).filter((at): at is number => at !== undefined && at > now);
		return {
			accountId: account.id,
			label: claudeChatAccountLabel(account),
			active: account.active,
			windows,
			checkedAt: entry?.checkedAt,
			resetsAt: upcoming.length ? Math.min(...upcoming) : undefined,
		};
	});
	const soonest = Math.min(...rows.map(row => row.resetsAt ?? Infinity));
	return rows.map(row => ({ ...row, resetsFirst: row.resetsAt !== undefined && row.resetsAt === soonest }));
}
