/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IKlawlySyncHttp, KlawlySyncHttpResponse } from '../../common/klawlySyncDeviceFlow.js';
import { IKlawlySyncLocal, KlawlySyncBase } from '../../common/klawlySyncEngine.js';
import { KlawlySyncCredentials, KlawlySyncRuntime, KlawlySyncRuntimeHost } from '../../common/klawlySyncRuntime.js';
import { KlawlySyncStatus, klawlySyncPlainError } from '../../common/klawlySyncModel.js';
import { IKlawlySyncTimers } from '../../common/klawlySyncScheduler.js';
import { IKlawlySyncStore, KlawlySyncPushResult, KlawlySyncRemote, KlawlySyncResource } from '../../common/klawlySyncStore.js';

class FakeTimers implements IKlawlySyncTimers {
	active = 0;
	setTimeout(): IDisposable {
		this.active++;
		let live = true;
		return { dispose: () => { if (live) { live = false; this.active--; } } };
	}
	setInterval(): IDisposable {
		return this.setTimeout();
	}
}

class FakeStore implements IKlawlySyncStore {
	readonly remotes = new Map<KlawlySyncResource, KlawlySyncRemote>();
	failWith: Error | undefined;
	reads = 0;
	readonly deletedResources: KlawlySyncResource[] = [];
	private _version = 0;

	async read(resource: KlawlySyncResource): Promise<KlawlySyncRemote | undefined> {
		this.reads++;
		if (this.failWith) {
			throw this.failWith;
		}
		return this.remotes.get(resource);
	}

	async push(resource: KlawlySyncResource, _base: string | undefined, files: KlawlySyncRemote['files']): Promise<KlawlySyncPushResult> {
		const version = `v${++this._version}`;
		this.remotes.set(resource, { version, files });
		return { kind: 'ok', version };
	}

	async deleteResource(resource: KlawlySyncResource): Promise<void> {
		this.deletedResources.push(resource);
		this.remotes.delete(resource);
	}
}

class FakeLocal implements IKlawlySyncLocal {
	readonly files = new Map<KlawlySyncResource, Record<string, string>>();
	readonly bases = new Map<KlawlySyncResource, KlawlySyncBase>();
	private readonly _secrets = new Map<string, string>();

	async read(resource: KlawlySyncResource) { return { ...this.files.get(resource) }; }
	async write(resource: KlawlySyncResource, _expected: Record<string, string>, next: Record<string, string>) { this.files.set(resource, { ...next }); return true; }
	async readBase(resource: KlawlySyncResource) { return this.bases.get(resource) ?? { version: undefined, files: {} }; }
	async writeBase(resource: KlawlySyncResource, base: KlawlySyncBase) { this.bases.set(resource, base); }
	async saveConflict() { }
	getSecret(name: string) { return this._secrets.get(name); }
	setSecret(name: string, value: string) { this._secrets.set(name, value); }
}

function response(status: number, body: unknown): KlawlySyncHttpResponse {
	return { status, headers: {}, body };
}

/** Plays GitHub's device flow: a code, one "pending", then a token, then the account. */
class FakeHttp implements IKlawlySyncHttp {
	pollAnswers: unknown[] = [{ error: 'authorization_pending' }, { access_token: 'tok' }];
	requests: string[] = [];

	async request(_method: string, url: string): Promise<KlawlySyncHttpResponse> {
		this.requests.push(url);
		if (url.endsWith('/login/device/code')) {
			return response(200, { device_code: 'dev', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 900 });
		}
		if (url.endsWith('/login/oauth/access_token')) {
			return response(200, this.pollAnswers.shift());
		}
		return response(200, { login: 'octo' });
	}
}

suite('KlawlySyncRuntime', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function make(options: { enabled?: boolean; memory?: boolean; history?: boolean; approved?: boolean; credentials?: KlawlySyncCredentials; paused?: boolean } = {}) {
		const enabledChanged = disposables.add(new Emitter<void>());
		const state = { enabled: options.enabled ?? true, memory: options.memory ?? false, history: options.history ?? false, approved: options.approved ?? false, prepared: 0, cleared: 0, credentials: options.credentials, paused: options.paused ?? false, now: 1_000 };
		const timers = new FakeTimers();
		const store = new FakeStore();
		const local = new FakeLocal();
		const http = new FakeHttp();
		let storeCreated = 0;
		const host: KlawlySyncRuntimeHost = {
			isEnabled: () => state.enabled,
			isMemoryEnabled: () => state.memory,
			isHistoryEnabled: () => state.history,
			listImportedSessions: async () => [{ machine: 'Desktop', id: 'Desktop/p/1', title: 'hello', updatedAt: 5 }],
			history: {
				isApproved: async () => state.approved,
				approve: async () => { state.approved = true; },
				revoke: async () => { state.approved = false; },
				preview: async () => ({ projects: [], totalBytes: 0 }),
				prepare: async () => { state.prepared++; },
				clearLocal: async () => { state.cleared++; local.files.delete('history'); },
			},
			onDidChangeEnabled: enabledChanged.event,
			http,
			timers,
			credentials: {
				load: async () => state.credentials,
				save: async c => { state.credentials = c; },
				clear: async () => { state.credentials = undefined; },
			},
			local,
			createStore: () => { storeCreated++; return store; },
			readPreferences: async () => ({ paused: state.paused, excluded: [] }),
			writePreferences: async preferences => { state.paused = preferences.paused; },
			machine: 'test-machine',
			sleep: async () => { },
			random: () => 0,
			now: () => state.now,
		};
		const runtime = disposables.add(new KlawlySyncRuntime(host));
		const statuses: KlawlySyncStatus[] = [];
		disposables.add(runtime.onDidChangeStatus(s => statuses.push(s)));
		return { runtime, state, timers, store, local, http, enabledChanged, statuses, storeCreated: () => storeCreated };
	}

	const signedIn: KlawlySyncCredentials = { token: 'tok', login: 'octo' };

	test('listMemory reads empty when the host cannot list or fails', async () => {
		const { runtime } = make();
		assert.deepStrictEqual(await runtime.listMemory(), { projects: [], machines: [] });
	});

	test('issue 448: imported sessions list only while Sync and history sync are on', async () => {
		const off = make({ enabled: true, history: false }).runtime;
		const on = make({ enabled: true, history: true }).runtime;
		assert.deepStrictEqual({ off: await off.listImportedSessions(), on: (await on.listImportedSessions()).map(s => [s.machine, s.title]) }, { off: [], on: [['Desktop', 'hello']] });
	});

	test('off by default: nothing is created, no timer runs, sign-in says off', async () => {
		const { runtime, timers, store, http, storeCreated } = make({ enabled: false, credentials: signedIn });
		assert.deepStrictEqual(await runtime.getStatus(), { signedIn: false, paused: false, running: false, lastSyncedAt: undefined, conflicts: 0, waiting: false, error: undefined });
		await runtime.syncNow();
		assert.strictEqual(await runtime.signIn(), 'off');
		assert.deepStrictEqual({ timers: timers.active, reads: store.reads, requests: http.requests.length, stores: storeCreated() }, { timers: 0, reads: 0, requests: 0, stores: 0 });
	});

	test('signed out while on: idle, nothing scheduled', async () => {
		const { runtime, timers, store } = make();
		const status = await runtime.getStatus();
		assert.deepStrictEqual({ signedIn: status.signedIn, timers: timers.active, reads: store.reads }, { signedIn: false, timers: 0, reads: 0 });
	});

	test('status goes syncing, then idle with a last-synced time', async () => {
		const { runtime, local, store, statuses, state } = make({ credentials: signedIn });
		local.files.set('rules', { 'a.md': 'hello' });
		await runtime.getStatus();
		await runtime.syncNow();
		state.now = 5_000;
		await runtime.syncNow();
		const status = await runtime.getStatus();
		assert.ok(statuses.some(s => s.running), 'a running status was announced');
		assert.deepStrictEqual({ signedIn: status.signedIn, running: status.running, error: status.error, conflicts: status.conflicts, synced: status.lastSyncedAt !== undefined, pushed: store.remotes.has('rules') }, { signedIn: true, running: false, error: undefined, conflicts: 0, synced: true, pushed: true });
	});

	test('memory is neither read nor pushed unless its own setting is on', async () => {
		const off = make({ credentials: signedIn });
		off.local.files.set('memory', { 'p/a.md': 'note' });
		await off.runtime.getStatus();
		await off.runtime.syncNow();
		const on = make({ credentials: signedIn, memory: true });
		on.local.files.set('memory', { 'p/a.md': 'note' });
		await on.runtime.getStatus();
		await on.runtime.syncNow();
		assert.deepStrictEqual({ off: off.store.remotes.has('memory'), on: on.store.remotes.has('memory') }, { off: false, on: true });
	});

	test('a failure becomes a plain-word error, and retry clears it once the store works', async () => {
		const { runtime, store } = make({ credentials: signedIn });
		store.failWith = new Error('getaddrinfo ENOTFOUND api.github.com');
		await runtime.getStatus();
		await runtime.syncNow();
		const failed = await runtime.getStatus();
		assert.deepStrictEqual({ error: failed.error, synced: failed.lastSyncedAt }, { error: klawlySyncPlainError('ENOTFOUND'), synced: undefined });

		store.failWith = undefined;
		await runtime.retry();
		const ok = await runtime.getStatus();
		assert.deepStrictEqual({ error: ok.error, synced: ok.lastSyncedAt !== undefined }, { error: undefined, synced: true });
	});

	test('both sides changing the same file shows as a conflict, not an error', async () => {
		const { runtime, local, store } = make({ credentials: signedIn });
		local.files.set('rules', { 'a.md': 'mine' });
		store.remotes.set('rules', { version: 'r1', files: { 'a.md': 'theirs' } });
		await runtime.getStatus();
		await runtime.syncNow();
		const status = await runtime.getStatus();
		assert.deepStrictEqual({ conflicts: status.conflicts > 0, error: status.error }, { conflicts: true, error: undefined });
	});

	test('sign-in runs the device flow, stores the token and starts syncing', async () => {
		const { runtime, state, http, store } = make();
		const codes: string[] = [];
		disposables.add(runtime.onDidRequestUserCode(c => codes.push(c.userCode)));
		assert.strictEqual(await runtime.signIn(), 'signedIn');
		await runtime.syncNow();
		const status = await runtime.getStatus();
		assert.deepStrictEqual({ codes, credentials: state.credentials, signedIn: status.signedIn, read: store.reads > 0, user: http.requests.some(r => r.endsWith('/user')) }, { codes: ['ABCD-1234'], credentials: { token: 'tok', login: 'octo' }, signedIn: true, read: true, user: true });
	});

	test('sign-in ends as denied when the user refuses', async () => {
		const { runtime, http, state } = make();
		http.pollAnswers = [{ error: 'access_denied' }];
		assert.deepStrictEqual({ result: await runtime.signIn(), credentials: state.credentials }, { result: 'denied', credentials: undefined });
	});

	test('sign-out forgets the token and stops the schedule', async () => {
		const { runtime, state, timers, store } = make({ credentials: signedIn });
		await runtime.syncNow();
		assert.ok(timers.active > 0, 'a schedule runs while signed in');
		await runtime.signOut();
		const reads = store.reads;
		await runtime.syncNow();
		const status = await runtime.getStatus();
		assert.deepStrictEqual({ timers: timers.active, credentials: state.credentials, signedIn: status.signedIn, reads: store.reads - reads }, { timers: 0, credentials: undefined, signedIn: false, reads: 0 });
	});

	test('turning the setting off stops the schedule', async () => {
		const { runtime, state, timers, enabledChanged } = make({ credentials: signedIn });
		await runtime.getStatus();
		assert.ok(timers.active > 0);
		state.enabled = false;
		enabledChanged.fire();
		const status = await runtime.getStatus();
		assert.deepStrictEqual({ timers: timers.active, signedIn: status.signedIn }, { timers: 0, signedIn: false });
	});

	test('paused in preferences: no pass runs', async () => {
		const { runtime, store } = make({ credentials: signedIn, paused: true });
		await runtime.syncNow();
		const status = await runtime.getStatus();
		assert.deepStrictEqual({ paused: status.paused, reads: store.reads }, { paused: true, reads: 0 });
	});

	test('setPaused keeps the choice in the preferences and resume runs a pass', async () => {
		const { runtime, store, state, statuses } = make({ credentials: signedIn, paused: true });
		await runtime.getStatus();
		await runtime.setPaused(false);
		await runtime.syncNow();
		const resumed = { stored: state.paused, paused: (await runtime.getStatus()).paused, ran: store.reads > 0 };
		await runtime.setPaused(true);
		assert.deepStrictEqual({ resumed, storedAfterPause: state.paused, last: statuses[statuses.length - 1].paused }, { resumed: { stored: false, paused: false, ran: true }, storedAfterPause: true, last: true });
	});

	test('both toggles off: nothing is uploaded, not even a resource that holds files', async () => {
		const { runtime, local, store, state } = make({ credentials: signedIn, memory: false, history: false, approved: true });
		local.files.set('memory', { 'p/a.md': 'note' });
		local.files.set('history', { 'transcripts/p/s.jsonl': 'said' });
		await runtime.getStatus();
		await runtime.syncNow();
		assert.deepStrictEqual({ remotes: [...store.remotes.keys()], prepared: state.prepared }, { remotes: [], prepared: 0 });
	});

	test('history on but not approved after a preview: nothing is exported or uploaded', async () => {
		const { runtime, local, store, state } = make({ credentials: signedIn, history: true, approved: false });
		local.files.set('history', { 'transcripts/p/s.jsonl': 'said' });
		await runtime.getStatus();
		await runtime.syncNow();
		assert.deepStrictEqual({ remotes: [...store.remotes.keys()], prepared: state.prepared }, { remotes: [], prepared: 0 });
	});

	test('approving the preview starts the history sync', async () => {
		const { runtime, local, store, state } = make({ credentials: signedIn, history: true, approved: false });
		local.files.set('history', { 'transcripts/p/s.jsonl': 'said' });
		await runtime.getStatus();
		await runtime.approveHistory();
		await runtime.syncNow();
		assert.deepStrictEqual({ remotes: [...store.remotes.keys()], prepared: state.prepared > 0 }, { remotes: ['history'], prepared: true });
	});

	test('approval alone does not sync history while its setting is off', async () => {
		const { runtime, local, store } = make({ credentials: signedIn, history: false, approved: true });
		local.files.set('history', { 'transcripts/p/s.jsonl': 'said' });
		await runtime.getStatus();
		await runtime.syncNow();
		assert.deepStrictEqual([...store.remotes.keys()], []);
	});

	test('Delete Synced History removes it from the store and this machine and takes the approval back', async () => {
		const { runtime, local, store, state } = make({ credentials: signedIn, history: true, approved: true });
		local.files.set('history', { 'transcripts/p/s.jsonl': 'said' });
		await runtime.getStatus();
		await runtime.syncNow();
		assert.ok(store.remotes.has('history'));
		await runtime.deleteSyncedHistory();
		await runtime.syncNow();
		assert.deepStrictEqual({ deleted: store.deletedResources, remote: store.remotes.has('history'), local: local.files.has('history'), approved: state.approved, cleared: state.cleared }, { deleted: ['history'], remote: false, local: false, approved: false, cleared: 1 });
	});

	test('Delete Synced History while signed out says what to do and touches nothing', async () => {
		const { runtime, state } = make({ history: true, approved: true });
		await runtime.getStatus();
		await assert.rejects(() => runtime.deleteSyncedHistory(), /Sign in/);
		assert.deepStrictEqual({ approved: state.approved, cleared: state.cleared }, { approved: true, cleared: 0 });
	});
});
