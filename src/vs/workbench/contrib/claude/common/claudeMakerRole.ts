/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The repository whose admin or maintain permission makes a signed-in GitHub account Klawly's maker (issue 1184). */
export const CLAUDE_MAKER_REPOSITORY = 'MehdiMamas/klawly-ide';

/** How long a verified role is trusted before it is checked again. */
export const CLAUDE_MAKER_RECHECK_MS = 24 * 60 * 60 * 1000;

/** The role a signed-in account has. `team` is reserved for future collaborators. */
export type ClaudeMakerRole = 'maker' | 'user';

/** A role verified with the account's token, keyed on the numeric GitHub user id (logins can be renamed). */
export interface ClaudeMakerVerdict {
	readonly userId: number;
	readonly role: ClaudeMakerRole;
	readonly checkedAt: number;
}

/**
 * Decides the role from the two GitHub responses: `GET /user` (numeric id) and
 * `GET /repos/MehdiMamas/klawly-ide` (`permissions`). Anything missing or malformed is a normal user.
 * The check runs in an app users can patch, so it only unlocks behaviour; nothing secret rides on it.
 */
export function claudeMakerVerdict(user: unknown, repo: unknown, now: number): ClaudeMakerVerdict | undefined {
	const userId = (user as { id?: unknown } | undefined)?.id;
	if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) {
		return undefined;
	}
	const permissions = (repo as { permissions?: { admin?: unknown; maintain?: unknown } } | undefined)?.permissions;
	const isMaker = permissions?.admin === true || permissions?.maintain === true;
	return { userId, role: isMaker ? 'maker' : 'user', checkedAt: now };
}

/** True when the role must be checked again: never checked, a different account, or older than a day. */
export function claudeMakerNeedsRecheck(verdict: ClaudeMakerVerdict | undefined, signedInUserId: number | undefined, now: number): boolean {
	if (signedInUserId === undefined) {
		return false;
	}
	return !verdict || verdict.userId !== signedInUserId || now - verdict.checkedAt >= CLAUDE_MAKER_RECHECK_MS || now < verdict.checkedAt;
}

/** The role that applies now. Signing out (no signed-in id) or another account's verdict drops it at once. */
export function claudeEffectiveMakerRole(verdict: ClaudeMakerVerdict | undefined, signedInUserId: number | undefined): ClaudeMakerRole {
	return verdict && signedInUserId !== undefined && verdict.userId === signedInUserId ? verdict.role : 'user';
}

/** Reads a stored verdict; anything malformed is no verdict. */
export function parseClaudeMakerVerdict(raw: string | undefined): ClaudeMakerVerdict | undefined {
	try {
		const value = raw ? JSON.parse(raw) as Partial<ClaudeMakerVerdict> : undefined;
		if (value && typeof value.userId === 'number' && typeof value.checkedAt === 'number' && (value.role === 'maker' || value.role === 'user')) {
			return { userId: value.userId, role: value.role, checkedAt: value.checkedAt };
		}
	} catch {
		// A damaged entry is checked again.
	}
	return undefined;
}
