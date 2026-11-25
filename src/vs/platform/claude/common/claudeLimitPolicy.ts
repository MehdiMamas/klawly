/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaudeUsageLimit } from './claudeAccounts.js';

/** Setting: what a chat does when its account reaches a plan limit. */
export const CLAUDE_ACCOUNTS_ON_LIMIT_SETTING = 'claude.accounts.onLimit';
/** Setting: per account limit options, keyed by account id. */
export const CLAUDE_ACCOUNTS_LIMIT_OPTIONS_SETTING = 'claude.accounts.limitOptions';

/**
 * What happens when a chat's account reaches a limit (issue 1182).
 * - `ask`: stop and ask, the default.
 * - `extraUsage`: keep going on the account's extra usage, up to its cap.
 * - `apiKey`: fall back to the API key.
 * - `otherAccount`: offer another signed-in account.
 */
export type ClaudeLimitPolicy = 'ask' | 'extraUsage' | 'apiKey' | 'otherAccount';

export const CLAUDE_LIMIT_POLICIES: readonly ClaudeLimitPolicy[] = ['ask', 'extraUsage', 'apiKey', 'otherAccount'];

/** Where the policy in force came from. */
export type ClaudeLimitPolicySource = 'chat' | 'global';

/** What one account allows (setting `claude.accounts.limitOptions`). */
export interface ClaudeAccountLimitOptions {
	readonly allowExtraUsage?: boolean;
	/** Spend cap for extra usage, in US dollars. */
	readonly extraUsageCapUsd?: number;
	readonly allowApiFallback?: boolean;
	readonly kind?: 'personal' | 'work';
}

export function readClaudeLimitPolicy(value: unknown): ClaudeLimitPolicy | undefined {
	return CLAUDE_LIMIT_POLICIES.find(policy => policy === value);
}

/** Reads the per account options, dropping entries and fields of the wrong type. */
export function readClaudeLimitOptions(value: unknown): Readonly<Record<string, ClaudeAccountLimitOptions>> {
	const result: Record<string, ClaudeAccountLimitOptions> = {};
	if (!value || typeof value !== 'object') {
		return result;
	}
	for (const [id, raw] of Object.entries(value)) {
		if (!raw || typeof raw !== 'object') {
			continue;
		}
		const entry = raw as Record<string, unknown>;
		const cap = entry.extraUsageCapUsd;
		result[id] = {
			allowExtraUsage: typeof entry.allowExtraUsage === 'boolean' ? entry.allowExtraUsage : undefined,
			extraUsageCapUsd: typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 ? cap : undefined,
			allowApiFallback: typeof entry.allowApiFallback === 'boolean' ? entry.allowApiFallback : undefined,
			kind: entry.kind === 'personal' || entry.kind === 'work' ? entry.kind : undefined,
		};
	}
	return result;
}

export interface ClaudeLimitPolicyInput {
	/** The chat's own override, when it set one. */
	readonly chatPolicy?: ClaudeLimitPolicy;
	readonly globalPolicy?: ClaudeLimitPolicy;
	/** The options of the account that hit the limit. */
	readonly account?: ClaudeAccountLimitOptions;
	/** True when another signed-in account could take over. */
	readonly otherAccountAvailable?: boolean;
}

export interface ClaudeLimitPolicyChoice {
	/** What the chat will do. `ask` when the wanted policy is not allowed. */
	readonly policy: ClaudeLimitPolicy;
	readonly source: ClaudeLimitPolicySource;
	/** The policy that was wanted, when it was not allowed and so fell back to `ask`. */
	readonly blocked?: ClaudeLimitPolicy;
}

/**
 * The policy in force: the chat's override, else the global one, else `ask`. A
 * policy the account does not allow falls back to `ask`, so nothing spends
 * money or switches account without the account's say.
 */
export function resolveClaudeLimitPolicy(input: ClaudeLimitPolicyInput): ClaudeLimitPolicyChoice {
	const source: ClaudeLimitPolicySource = input.chatPolicy ? 'chat' : 'global';
	const wanted = input.chatPolicy ?? input.globalPolicy ?? 'ask';
	const allowed = wanted === 'extraUsage' ? input.account?.allowExtraUsage === true
		: wanted === 'apiKey' ? input.account?.allowApiFallback === true
			: wanted === 'otherAccount' ? input.otherAccountAvailable === true
				: true;
	return allowed ? { policy: wanted, source } : { policy: 'ask', source, blocked: wanted };
}

/**
 * Whether a chat that stopped on a limit continues by itself at the reset time:
 * only when the user chose to wait and Claude Code said when the window resets.
 */
export function claudeShouldResumeAtReset(limit: ClaudeUsageLimit | undefined, now: number, resumeAtReset: boolean): boolean {
	return resumeAtReset && limit?.status === 'rejected' && limit.resetsAt !== undefined && limit.resetsAt > now;
}
