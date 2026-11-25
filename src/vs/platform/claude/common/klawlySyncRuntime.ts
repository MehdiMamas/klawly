/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { ClaudeHistoryPreview } from './claudeHistoryPreview.js';
import { IKlawlySyncHttp, pollKlawlyDeviceToken, requestKlawlyDeviceCode } from './klawlySyncDeviceFlow.js';
import { IKlawlySyncLocal, syncKlawlyAll } from './klawlySyncEngine.js';
import { applyKlawlyFirstSignIn, KlawlyFirstSignInChoice, KlawlySyncPreferences, KlawlySyncStatus, klawlySyncPlainError } from './klawlySyncModel.js';
import { IKlawlySyncTimers, KlawlySyncScheduler } from './klawlySyncScheduler.js';
import { IKlawlySyncService, KlawlySyncImportedSession, KlawlySyncMemoryOverview, KlawlySyncSignInResult, KlawlySyncUserCode } from './klawlySyncService.js';
import { IKlawlySyncStore, KLAWLY_SYNC_RESOURCES, KlawlySyncResource } from './klawlySyncStore.js';

/** The GitHub account Klawly Sync signed in as. */
export interface KlawlySyncCredentials {
	readonly token: string;
	readonly login: string;
}

/** Where the token lives between runs. The platform encrypts it; tests keep it in memory. */
export interface IKlawlySyncCredentialStore {
	load(): Promise<KlawlySyncCredentials | undefined>;
	save(credentials: KlawlySyncCredentials): Promise<void>;
	clear(): Promise<void>;
}

/** What the history sync needs from the platform (issue 448). */
export interface KlawlySyncHistoryHost {
	/** Has the person seen the preview and agreed? */
	isApproved(): Promise<boolean>;
	approve(): Promise<void>;
	revoke(): Promise<void>;
	preview(): Promise<ClaudeHistoryPreview>;
	/** Writes this machine's recent sessions into the synced folder, within the limits and the exclude list. */
	prepare(): Promise<void>;
	/** Removes the local synced copies and the merge base of the history. */
	clearLocal(): Promise<void>;
}

/** Everything the runtime needs from its platform. The shared process fills it in; tests use fakes. */
export interface KlawlySyncRuntimeHost {
	/** The setting that turns Klawly Sync on. */
	isEnabled(): boolean;
	/** The setting that adds project memory to the sync. */
	isMemoryEnabled(): boolean;
	/** The setting that adds session transcripts to the sync. */
	isHistoryEnabled(): boolean;
	/** Reads the synced memory and history folders for the memory view. */
	listMemory?(): Promise<KlawlySyncMemoryOverview>;
	/** Reads the sessions other computers synced. */
	listImportedSessions?(): Promise<readonly KlawlySyncImportedSession[]>;
	/** The files of the history sync. Without it the history is never synced. */
	readonly history?: KlawlySyncHistoryHost;
	readonly onDidChangeEnabled: Event<void>;
	readonly http: IKlawlySyncHttp;
	readonly timers: IKlawlySyncTimers;
	readonly credentials: IKlawlySyncCredentialStore;
	readonly local: IKlawlySyncLocal;
	createStore(http: IKlawlySyncHttp, credentials: KlawlySyncCredentials): IKlawlySyncStore;
	readPreferences(): Promise<KlawlySyncPreferences>;
	writePreferences(preferences: KlawlySyncPreferences): Promise<void>;
	readonly machine: string;
	sleep(ms: number): Promise<void>;
	random(): number;
	now(): number;
}

/**
 * Wires the scheduler, the engine, the GitHub store, the device-flow sign-in, the disk adapter
 * and the secrets into one service whose status the workbench can show.
 *
 * - Off by default: until the setting is on nothing is created, so no timer, request or file
 *   access happens and the status says "signed out".
 * - Turning the setting off, or signing out, disposes the scheduler.
 * - A pass never throws to the caller: a failure becomes `status.error` (one plain sentence),
 *   a clash becomes `status.conflicts` and that resource stops pushing until it is resolved.
 */
export class KlawlySyncRuntime extends Disposable implements IKlawlySyncService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeStatus = this._register(new Emitter<KlawlySyncStatus>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;
	private readonly _onDidRequestUserCode = this._register(new Emitter<KlawlySyncUserCode>());
	readonly onDidRequestUserCode = this._onDidRequestUserCode.event;

	private readonly _scheduler = this._register(new MutableDisposable<KlawlySyncScheduler>());
	private _syncStore: IKlawlySyncStore | undefined;
	private _signedIn = false;
	private _paused = false;
	private _running = false;
	private _waiting = false;
	private _lastSyncedAt: number | undefined;
	private _error: string | undefined;
	private readonly _conflicts = new Map<KlawlySyncResource, number>();
	private _firstChoice: KlawlyFirstSignInChoice | undefined;
	private _generation = 0;
	private _started: Promise<void>;

	constructor(private readonly _host: KlawlySyncRuntimeHost) {
		super();
		this._register(_host.onDidChangeEnabled(() => { this._started = this._start(); }));
		this._started = this._start();
	}

	async listMemory(): Promise<KlawlySyncMemoryOverview> {
		const empty: KlawlySyncMemoryOverview = { projects: [], machines: [] };
		return this._host.listMemory ? await this._host.listMemory().catch(() => empty) : empty;
	}

	async listImportedSessions(): Promise<readonly KlawlySyncImportedSession[]> {
		if (!this._host.isEnabled() || !this._host.isHistoryEnabled() || !this._host.listImportedSessions) {
			return [];
		}
		return this._host.listImportedSessions().catch(() => []);
	}

	async getStatus(): Promise<KlawlySyncStatus> {
		await this._started;
		return this._status();
	}

	async syncNow(): Promise<void> {
		await this._started;
		await this._runNow();
	}

	async setPaused(paused: boolean): Promise<void> {
		await this._started;
		const preferences = await this._host.readPreferences();
		if (preferences.paused !== paused) {
			await this._host.writePreferences({ ...preferences, paused });
		}
		if (this._paused !== paused) {
			this._paused = paused;
			// un-pausing triggers a pass; the scheduler runs it
			this._scheduler.value?.setPaused(paused);
			this._emit();
		}
	}

	async retry(): Promise<void> {
		await this._started;
		this._error = undefined;
		this._emit();
		await this._runNow();
	}

	async signIn(choice: KlawlyFirstSignInChoice = 'merge'): Promise<KlawlySyncSignInResult> {
		await this._started;
		if (!this._host.isEnabled()) {
			return 'off';
		}
		const code = await requestKlawlyDeviceCode(this._host.http);
		this._onDidRequestUserCode.fire({ userCode: code.userCode, verificationUri: code.verificationUri, expiresAt: this._host.now() + code.expiresIn * 1000 });
		const result = await pollKlawlyDeviceToken(this._host.http, code, ms => this._host.sleep(ms));
		if (result.kind !== 'token') {
			return result.kind;
		}
		const login = await this._fetchLogin(result.accessToken);
		await this._host.credentials.save({ token: result.accessToken, login });
		this._firstChoice = choice;
		this._error = undefined;
		this._started = this._start();
		await this._started;
		return 'signedIn';
	}

	async previewHistory(): Promise<ClaudeHistoryPreview> {
		await this._started;
		return this._host.history?.preview() ?? { projects: [], totalBytes: 0 };
	}

	async approveHistory(): Promise<void> {
		await this._started;
		await this._host.history?.approve();
		await this._runNow();
	}

	async deleteSyncedHistory(): Promise<void> {
		await this._started;
		const store = this._syncStore;
		if (!store) {
			throw new Error(localize('klawlySyncDeleteSignedOut', "Sign in to Klawly Sync first, so it can delete the history from your sync repo."));
		}
		// Take the approval back first, so a pass that is already queued cannot upload it again.
		await this._host.history?.revoke();
		await store.deleteResource('history', this._host.machine);
		await this._host.history?.clearLocal();
		this._conflicts.delete('history');
	}

	async signOut(): Promise<void> {
		await this._started;
		this._generation++;
		this._stop();
		this._firstChoice = undefined;
		this._error = undefined;
		this._lastSyncedAt = undefined;
		this._conflicts.clear();
		await this._host.credentials.clear();
		this._emit();
	}

	private async _fetchLogin(token: string): Promise<string> {
		const response = await this._host.http.request('GET', 'https://api.github.com/user', { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' });
		const body = response.body as { login?: unknown } | null | undefined;
		const login = typeof body === 'object' && body !== null ? body.login : undefined;
		if (response.status !== 200 || typeof login !== 'string' || login === '') {
			throw new Error(`GitHub did not say who signed in (HTTP ${response.status}).`);
		}
		return login;
	}

	/** Creates the store and the schedule when Sync is on and signed in; tears both down otherwise. */
	private async _start(): Promise<void> {
		this._stop();
		const generation = ++this._generation;
		if (!this._host.isEnabled()) {
			this._emit();
			return;
		}
		const credentials = await this._host.credentials.load();
		if (generation !== this._generation || !this._host.isEnabled()) {
			return;
		}
		if (!credentials) {
			this._emit();
			return;
		}
		const preferences = await this._host.readPreferences();
		if (generation !== this._generation) {
			return;
		}
		this._syncStore = this._host.createStore(this._host.http, credentials);
		this._signedIn = true;
		this._paused = preferences.paused;
		const scheduler = new KlawlySyncScheduler(() => this._pass(), this._host.timers);
		this._scheduler.value = scheduler;
		scheduler.setPaused(preferences.paused);
		this._emit();
		scheduler.trigger();
	}

	private _stop(): void {
		this._scheduler.clear();
		this._syncStore = undefined;
		this._signedIn = false;
		this._running = false;
		this._waiting = false;
	}

	private async _runNow(): Promise<void> {
		const scheduler = this._scheduler.value;
		if (!scheduler || scheduler.paused) {
			return;
		}
		scheduler.trigger();
		await scheduler.idle();
	}

	private async _pass(): Promise<void> {
		const store = this._syncStore;
		if (!store || !this._host.isEnabled()) {
			return;
		}
		const generation = this._generation;
		this._running = true;
		this._emit();
		let error: string | undefined;
		try {
			error = await this._sync(store);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		if (generation !== this._generation) {
			return;
		}
		this._running = false;
		this._error = error === undefined ? undefined : klawlySyncPlainError(error);
		if (error === undefined) {
			this._lastSyncedAt = this._host.now();
		}
		this._emit();
	}

	/** One pass over every resource. Resolves with the first raw error, or undefined when all went well. */
	private async _sync(store: IKlawlySyncStore): Promise<string | undefined> {
		const preferences = await this._host.readPreferences();
		if (preferences.paused !== this._paused) {
			// Only on a change: un-pausing triggers a run, which would loop from inside a pass.
			this._paused = preferences.paused;
			this._scheduler.value?.setPaused(preferences.paused);
		}
		if (preferences.paused) {
			return undefined;
		}
		const history = this._host.isHistoryEnabled() && this._host.history && await this._host.history.isApproved() ? this._host.history : undefined;
		const options = {
			machine: this._host.machine,
			sleep: (ms: number) => this._host.sleep(ms),
			random: () => this._host.random(),
			excluded: new Set<KlawlySyncResource>([...preferences.excluded, ...this._host.isMemoryEnabled() ? [] : ['memory' as const], ...history ? [] : ['history' as const]]),
			paused: new Set<KlawlySyncResource>(this._conflicts.keys()),
		};
		let error: string | undefined;
		const choice = this._firstChoice;
		this._firstChoice = undefined;
		if (choice && choice !== 'merge') {
			for (const resource of KLAWLY_SYNC_RESOURCES) {
				if (!options.excluded.has(resource)) {
					try {
						await applyKlawlyFirstSignIn(choice, resource, this._host.local, store, options);
					} catch (e) {
						error ??= e instanceof Error ? e.message : String(e);
					}
				}
			}
		}
		if (history) {
			await history.prepare().catch(e => { error ??= e instanceof Error ? e.message : String(e); });
		}
		let waiting = false;
		for (const [resource, outcome] of await syncKlawlyAll(this._host.local, store, options)) {
			if (outcome instanceof Error) {
				error ??= outcome.message;
			} else if (outcome.kind === 'conflict') {
				this._conflicts.set(resource, outcome.conflicts.length);
			} else if (outcome.kind === 'blocked') {
				error ??= localize('klawlySyncBlocked', "Sync did not push {0} because it still holds a secret.", resource);
			} else if (outcome.kind === 'waiting') {
				waiting = true;
			}
		}
		this._waiting = waiting;
		return error;
	}

	private _status(): KlawlySyncStatus {
		let conflicts = 0;
		for (const count of this._conflicts.values()) {
			conflicts += count;
		}
		return {
			signedIn: this._signedIn,
			paused: this._paused,
			running: this._running,
			lastSyncedAt: this._lastSyncedAt,
			conflicts,
			waiting: this._waiting,
			error: this._error,
		};
	}

	private _emit(): void {
		this._onDidChangeStatus.fire(this._status());
	}
}
