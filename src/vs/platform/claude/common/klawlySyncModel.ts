/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { IKlawlySyncLocal, KlawlySyncOptions, KlawlySyncOutcome, syncKlawlyResource } from './klawlySyncEngine.js';
import { klawlyLiveFiles } from './klawlySyncMerge.js';
import { restoreKlawlySnapshotSecrets } from './klawlySyncSecrets.js';
import { IKlawlySyncStore, KLAWLY_SYNC_RESOURCES, KlawlySyncResource } from './klawlySyncStore.js';

/** What the account menu and Settings → Sync show, in plain words. */
export interface KlawlySyncStatus {
	readonly signedIn: boolean;
	readonly paused: boolean;
	readonly running: boolean;
	/** Epoch ms of the last pass that finished without error. */
	readonly lastSyncedAt: number | undefined;
	readonly conflicts: number;
	readonly waiting: boolean;
	readonly error: string | undefined;
}

/** "just now", "2 minutes ago", "1 hour ago", "5 days ago". */
export function klawlySyncAgo(then: number, now: number): string {
	const minutes = Math.floor(Math.max(0, now - then) / 60_000);
	if (minutes < 1) {
		return localize('klawlySyncAgoNow', "just now");
	}
	if (minutes < 60) {
		return minutes === 1
			? localize('klawlySyncAgoMinute', "1 minute ago")
			: localize('klawlySyncAgoMinutes', "{0} minutes ago", minutes);
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return hours === 1
			? localize('klawlySyncAgoHour', "1 hour ago")
			: localize('klawlySyncAgoHours', "{0} hours ago", hours);
	}
	const days = Math.floor(hours / 24);
	return days === 1
		? localize('klawlySyncAgoDay', "1 day ago")
		: localize('klawlySyncAgoDays', "{0} days ago", days);
}

/** Opens Settings filtered to the sync section. */
export const KLAWLY_SYNC_OPEN_SETTINGS_COMMAND = 'workbench.action.openSettings';
export const KLAWLY_SYNC_OPEN_SETTINGS_ARGS = 'klawly.sync';

/** An action offered beside the status line. */
export type KlawlySyncStatusAction = 'signIn' | 'resume' | 'retry' | 'showDetails';

/** The status line: plain words, the actions that go with it, and the raw text behind Show Details. */
export interface KlawlySyncStatusLine {
	readonly text: string;
	readonly actions: readonly KlawlySyncStatusAction[];
	/** The raw error, shown only after Show Details. */
	readonly details: string | undefined;
	/** When set, the whole line links to Settings > Sync. */
	readonly link: { readonly command: string; readonly args: string } | undefined;
}

/** True when the error says GitHub refused the sign-in (the text may be lower-cased). */
function isKlawlySyncAuthError(error: string): boolean {
	return /\b(401|403|bad credentials|unauthori[sz]ed|forbidden)\b/.test(error.toLowerCase());
}

/** Turns a raw engine error into one plain sentence that says what failed and what to do. */
export function klawlySyncPlainError(error: string): string {
	const text = error.toLowerCase();
	if (isKlawlySyncAuthError(text)) {
		return localize('klawlySyncErrAuth', "Sync could not sign in to GitHub. Sign in again, then retry.");
	}
	if (/\b(429|rate limit)\b/.test(text)) {
		return localize('klawlySyncErrRate', "GitHub asked Klawly to slow down. Wait a few minutes, then retry.");
	}
	if (/(enotfound|econnrefused|econnreset|etimedout|eai_again|network|offline|fetch failed|timed? ?out)/.test(text)) {
		return localize('klawlySyncErrNetwork', "Sync could not reach GitHub. Check your connection, then retry.");
	}
	if (/\b(http|status)\s*:?\s*5\d\d\b/.test(text)) {
		return localize('klawlySyncErrServer', "GitHub had a problem. Try again in a few minutes.");
	}
	return localize('klawlySyncErrUnknown', "Sync failed. Retry, or choose Show Details to see why.");
}

/** The status line of the account menu: what is happening and what to do about it. */
export function klawlySyncStatusLine(status: KlawlySyncStatus, now: number): KlawlySyncStatusLine {
	const plain = (text: string): KlawlySyncStatusLine => ({ text, actions: [], details: undefined, link: undefined });
	if (!status.signedIn) {
		return plain(localize('klawlySyncSignedOut', "Sign in with GitHub to sync your setup"));
	}
	if (status.paused) {
		// DL-12: a paused line offers the control that ends the pause, and the link to its settings
		return { text: localize('klawlySyncPaused', "Sync is paused. Resume it to keep your setup up to date."), actions: ['resume'], details: undefined, link: { command: KLAWLY_SYNC_OPEN_SETTINGS_COMMAND, args: KLAWLY_SYNC_OPEN_SETTINGS_ARGS } };
	}
	if (status.error) {
		// DL-12: Retry cannot succeed before the user signs in again, so Sign In comes first
		const actions: readonly KlawlySyncStatusAction[] = isKlawlySyncAuthError(status.error) ? ['signIn', 'retry', 'showDetails'] : ['retry', 'showDetails'];
		return { text: klawlySyncPlainError(status.error), actions, details: status.error, link: undefined };
	}
	if (status.conflicts > 0) {
		const text = status.conflicts === 1
			? localize('klawlySyncConflictOne', "1 conflict needs you. Resolve it in Settings > Sync")
			: localize('klawlySyncConflictMany', "{0} conflicts need you. Resolve them in Settings > Sync", status.conflicts);
		return { text, actions: [], details: undefined, link: { command: KLAWLY_SYNC_OPEN_SETTINGS_COMMAND, args: KLAWLY_SYNC_OPEN_SETTINGS_ARGS } };
	}
	if (status.waiting) {
		return plain(localize('klawlySyncWaiting', "Sync is waiting for another of your computers to finish. It will continue by itself."));
	}
	if (status.running) {
		return plain(localize('klawlySyncRunning', "Syncing..."));
	}
	if (status.lastSyncedAt === undefined) {
		return plain(localize('klawlySyncNever', "Not synced yet"));
	}
	return plain(localize('klawlySyncedAgo', "Synced {0}", klawlySyncAgo(status.lastSyncedAt, now)));
}

/** The status text alone (see klawlySyncStatusLine for the actions and link). */
export function klawlySyncStatusText(status: KlawlySyncStatus, now: number): string {
	return klawlySyncStatusLine(status, now).text;
}

/** The names shown for each kind in Settings → Sync and in notices. */
export function klawlySyncResourceLabel(resource: KlawlySyncResource): string {
	switch (resource) {
		case 'rules': return localize('klawlySyncRules', "User rules");
		case 'settings': return localize('klawlySyncSettings', "Editor settings");
		case 'mcp': return localize('klawlySyncMcp', "MCP servers");
		case 'skills': return localize('klawlySyncSkills', "Skills");
		case 'agents': return localize('klawlySyncAgents', "Agents");
		case 'commands': return localize('klawlySyncCommands', "Commands");
		case 'outputStyles': return localize('klawlySyncOutputStyles', "Output styles");
		case 'app': return localize('klawlySyncApp', "App settings");
		case 'memory': return localize('klawlySyncMemory', "Project memory");
		case 'history': return localize('klawlySyncHistory', "Session history");
	}
}

/** The notice after a pull changed local files, or undefined when nothing was pulled. */
export function klawlySyncPullNotice(resource: KlawlySyncResource, outcome: KlawlySyncOutcome | Error, machine: string | undefined): string | undefined {
	if (outcome instanceof Error || outcome.kind !== 'synced' || outcome.pulled.length === 0) {
		return undefined;
	}
	const label = klawlySyncResourceLabel(resource);
	return machine
		? localize('klawlySyncUpdatedFrom', "{0} updated from {1}", label, machine)
		: localize('klawlySyncUpdated', "{0} updated from another machine", label);
}

/** What the user set in Settings → Sync. */
export interface KlawlySyncPreferences {
	readonly paused: boolean;
	readonly excluded: readonly KlawlySyncResource[];
}

export const KLAWLY_SYNC_DEFAULT_PREFERENCES: KlawlySyncPreferences = { paused: false, excluded: [] };

export function toggleKlawlySyncExcluded(prefs: KlawlySyncPreferences, resource: KlawlySyncResource): KlawlySyncPreferences {
	const excluded = prefs.excluded.includes(resource)
		? prefs.excluded.filter(r => r !== resource)
		: KLAWLY_SYNC_RESOURCES.filter(r => r === resource || prefs.excluded.includes(r));
	return { ...prefs, excluded };
}

export function serializeKlawlySyncPreferences(prefs: KlawlySyncPreferences): string {
	return JSON.stringify(prefs);
}

/** Reads stored preferences; anything unreadable or unknown falls back to the defaults. */
export function parseKlawlySyncPreferences(raw: string | undefined): KlawlySyncPreferences {
	if (!raw) {
		return KLAWLY_SYNC_DEFAULT_PREFERENCES;
	}
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== 'object' || value === null) {
			return KLAWLY_SYNC_DEFAULT_PREFERENCES;
		}
		const { paused, excluded } = value as { paused?: unknown; excluded?: unknown };
		return {
			paused: paused === true,
			excluded: Array.isArray(excluded) ? KLAWLY_SYNC_RESOURCES.filter(r => excluded.includes(r)) : [],
		};
	} catch {
		return KLAWLY_SYNC_DEFAULT_PREFERENCES;
	}
}

/** The choice on a second machine's first sign-in, when the store already holds a setup. */
export type KlawlyFirstSignInChoice = 'merge' | 'useSynced' | 'keepMine';

/**
 * Applies the first sign-in choice to one resource, then syncs it.
 * - merge: three-way merge with an empty base (both sides' additions are kept, a clash is a conflict).
 * - useSynced: this machine's files become the synced ones.
 * - keepMine: the synced files count as already seen, so this machine's files win and are pushed.
 */
export async function applyKlawlyFirstSignIn(choice: KlawlyFirstSignInChoice, resource: KlawlySyncResource, local: IKlawlySyncLocal, store: IKlawlySyncStore, options: KlawlySyncOptions): Promise<KlawlySyncOutcome> {
	if (choice !== 'merge') {
		const remote = await store.read(resource);
		if (remote) {
			await local.writeBase(resource, { version: remote.version, files: remote.files });
			if (choice === 'useSynced') {
				const current = await local.read(resource);
				const restored = restoreKlawlySnapshotSecrets(remote.files, name => local.getSecret(name));
				const next = klawlyLiveFiles(restored.files);
				if (!await local.write(resource, current, next)) {
					return { kind: 'waiting' };
				}
				return { kind: 'synced', pulled: Object.keys(next).sort(), pushed: false, missingSecrets: restored.missing };
			}
		}
	}
	return syncKlawlyResource(resource, local, store, options);
}
