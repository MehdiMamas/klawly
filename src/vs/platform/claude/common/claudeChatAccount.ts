/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_DEFAULT_ACCOUNT_ID, ClaudeAccountEntry, claudeAccountNeedsSignIn, claudeAccountsSharingSignIn } from './claudeAccounts.js';

/**
 * The account new chats start on (issue 1181). Empty means the account that is
 * active in Switch Account. The value is an account id from {@link ClaudeAccountEntry}.
 */
export const CLAUDE_ACCOUNTS_DEFAULT_ACCOUNT_SETTING = 'claude.accounts.defaultAccount';

/** Where a chat's account came from, nearest first. */
export type ClaudeChatAccountSource = 'chat' | 'parent' | 'default' | 'active';

export interface ClaudeChatAccountChoice {
	readonly accountId: string;
	readonly source: ClaudeChatAccountSource;
}

export interface ClaudeChatAccountInput {
	/** The account picked for this chat in the composer chip, if any. */
	readonly chatAccountId?: string;
	/** The account of the chat that started this one (a worker or delegated chat), if any. */
	readonly parentAccountId?: string;
	/** The value of {@link CLAUDE_ACCOUNTS_DEFAULT_ACCOUNT_SETTING}. */
	readonly globalDefaultAccountId?: string;
	readonly accounts: readonly ClaudeAccountEntry[];
}

/** Reads the global default account setting. A non-string or blank value means none. */
export function readClaudeDefaultAccountId(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Picks the account a chat runs on: the chat's own pick, else its parent chat's,
 * else the global default, else the active account. An id is skipped when that
 * account was removed or needs a new sign-in, so a stale pick falls through to
 * the next choice instead of failing the turn. Undefined when no account is
 * usable at all.
 */
export function resolveClaudeChatAccount(input: ClaudeChatAccountInput): ClaudeChatAccountChoice | undefined {
	const sharing = claudeAccountsSharingSignIn(input.accounts);
	const usable = new Set(input.accounts.filter(account => !claudeAccountNeedsSignIn(account, sharing)).map(account => account.id));
	const candidates: readonly (readonly [string | undefined, ClaudeChatAccountSource])[] = [
		[input.chatAccountId, 'chat'],
		[input.parentAccountId, 'parent'],
		[input.globalDefaultAccountId, 'default'],
		[input.accounts.find(account => account.active)?.id, 'active'],
		[CLAUDE_DEFAULT_ACCOUNT_ID, 'active'],
	];
	for (const [accountId, source] of candidates) {
		if (accountId && usable.has(accountId)) {
			return { accountId, source };
		}
	}
	return undefined;
}

/** The text of the account chip and of the usage row: the email, then the plan, such as `me@example.com · Max`. */
export function claudeChatAccountLabel(account: Pick<ClaudeAccountEntry, 'id' | 'email' | 'plan'>): string {
	const name = account.email ?? account.id;
	const plan = account.plan ? account.plan.charAt(0).toUpperCase() + account.plan.slice(1) : undefined;
	return plan ? `${name} · ${plan}` : name;
}

/**
 * The account a usage row names. The row shows the limits of the chat's account,
 * so it names it whenever more than one account is signed in; with one account
 * there is nothing to tell apart and the name is left out.
 */
export function claudeUsageRowAccountName(accounts: readonly ClaudeAccountEntry[], accountId: string): string | undefined {
	const account = accounts.find(entry => entry.id === accountId);
	if (!account || accounts.filter(entry => entry.signedIn).length < 2) {
		return undefined;
	}
	return claudeChatAccountLabel(account);
}
