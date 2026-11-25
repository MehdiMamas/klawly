/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ClaudeHistoryPreview } from './claudeHistoryPreview.js';
import { KlawlyFirstSignInChoice, KlawlySyncStatus } from './klawlySyncModel.js';

export const IKlawlySyncService = createDecorator<IKlawlySyncService>('klawlySyncService');

/** The IPC channel the shared process serves the Klawly Sync runtime on. */
export const KLAWLY_SYNC_CHANNEL = 'klawlySync';

/** Turns Klawly Sync on. Nothing runs, signs in or touches a file while it is off. */
export const KLAWLY_SYNC_ENABLED_SETTING = 'klawly.sync.enabled';

/** Also syncs project memory, keyed by git remote. Needs Klawly Sync on. Off by default. */
export const KLAWLY_SYNC_MEMORY_SETTING = 'klawly.sync.memory.enabled';

/** Also syncs the transcripts of recent sessions, keyed by git remote. Needs Klawly Sync on and a preview you approved. Off by default. */
export const KLAWLY_SYNC_HISTORY_SETTING = 'klawly.sync.history.enabled';

/** How many of the newest sessions of each project the history sync keeps. */
export const KLAWLY_SYNC_HISTORY_KEEP_SETTING = 'klawly.sync.history.keepSessions';

/** The most kilobytes of transcripts the history sync keeps for each project. */
export const KLAWLY_SYNC_HISTORY_MAX_KB_SETTING = 'klawly.sync.history.maxKilobytes';

/** Projects (git remote identities such as `github.com/owner/repo`) whose sessions are never synced. */
export const KLAWLY_SYNC_HISTORY_EXCLUDED_SETTING = 'klawly.sync.history.excludedProjects';

/** The code the user types at GitHub to approve a sign-in. */
export interface KlawlySyncUserCode {
	readonly userCode: string;
	readonly verificationUri: string;
	/** Epoch ms when the code stops working. */
	readonly expiresAt: number;
}

/** One synced note of a project (a Markdown file in the memory folder). */
export interface KlawlySyncMemoryNote {
	readonly name: string;
	readonly path: string;
	readonly bytes: number;
	/** Epoch ms of the last change on this machine. */
	readonly updatedAt: number;
}

/** What the synced folders hold for one project, shown by the memory view (issue 448). */
export interface KlawlySyncMemoryProject {
	/** The project identity as the folder spells it, such as `github.com__owner__app`. */
	readonly slug: string;
	readonly notes: readonly KlawlySyncMemoryNote[];
	/** Session transcripts synced for the project. */
	readonly transcripts: number;
}

/** A computer that synced its history, as its own manifest names it. No prompt text is read. */
export interface KlawlySyncMachine {
	readonly name: string;
	/** How many sessions the computer exported. */
	readonly sessions: number;
	/** True for the computer the view is open on. */
	readonly current: boolean;
}

/** A session another computer synced, as the agents column lists it (issue 448). Normalized: no file paths, no transcript text beyond the first prompt. */
export interface KlawlySyncImportedSession {
	/** The computer that exported it. */
	readonly machine: string;
	/** Unique across computers and projects. */
	readonly id: string;
	/** The first thing the person asked, cut short. */
	readonly title: string;
	readonly updatedAt: number;
}

export interface KlawlySyncMemoryOverview {
	readonly projects: readonly KlawlySyncMemoryProject[];
	readonly machines: readonly KlawlySyncMachine[];
}

/** How a sign-in ended. `off` means Klawly Sync is not turned on. */
export type KlawlySyncSignInResult = 'signedIn' | 'denied' | 'expired' | 'off';

/**
 * Klawly Sync as the workbench sees it. The runtime lives in the shared process and owns the
 * schedule, the engine, the GitHub store, the sign-in and the files; the workbench only shows
 * the status and asks for the four actions below. Off by default (see KLAWLY_SYNC_ENABLED_SETTING).
 */
export interface IKlawlySyncService {
	readonly _serviceBrand: undefined;

	/** Fires whenever any part of the status changes. */
	readonly onDidChangeStatus: Event<KlawlySyncStatus>;
	/** Fires while a sign-in waits for the user to approve it at GitHub. */
	readonly onDidRequestUserCode: Event<KlawlySyncUserCode>;

	getStatus(): Promise<KlawlySyncStatus>;
	/** The notes, transcripts and machines in the synced memory and history folders. Empty while both are off. */
	listMemory(): Promise<KlawlySyncMemoryOverview>;
	/** Sessions other computers synced, newest first. Empty while history sync is off. */
	listImportedSessions(): Promise<readonly KlawlySyncImportedSession[]>;
	/** Runs a pass now. Does nothing while Sync is off, signed out or paused. */
	syncNow(): Promise<void>;
	/** Pauses or resumes the schedule. The choice is kept in the shared preferences, so Settings > Sync shows it too. */
	setPaused(paused: boolean): Promise<void>;
	/** Clears the last error and runs a pass now. */
	retry(): Promise<void>;
	/**
	 * Starts the GitHub device flow and resolves when it ends. `choice` is what the first sign-in
	 * on this machine does with a setup that already sits in the store (default: merge).
	 */
	signIn(choice?: KlawlyFirstSignInChoice): Promise<KlawlySyncSignInResult>;
	/** Forgets the token and stops the schedule. Synced files stay where they are. */
	signOut(): Promise<void>;

	/** What the history sync would carry right now. Reads local files only; nothing leaves the machine. */
	previewHistory(): Promise<ClaudeHistoryPreview>;
	/** Records that the person saw the preview and agrees. Until then the history sync uploads and pulls nothing. */
	approveHistory(): Promise<void>;
	/** Deletes the synced history from the sync repo and from this machine, and takes the approval back. */
	deleteSyncedHistory(): Promise<void>;
}
