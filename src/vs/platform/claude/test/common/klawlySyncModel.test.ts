/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IKlawlySyncLocal, KlawlySyncBase, syncKlawlyResource } from '../../common/klawlySyncEngine.js';
import { KlawlySyncConflict, KlawlySyncSnapshot } from '../../common/klawlySyncMerge.js';
import { KLAWLY_SYNC_DEFAULT_PREFERENCES, KlawlySyncStatus, applyKlawlyFirstSignIn, klawlySyncAgo, klawlySyncPlainError, klawlySyncPullNotice, klawlySyncStatusLine, klawlySyncStatusText, parseKlawlySyncPreferences, serializeKlawlySyncPreferences, toggleKlawlySyncExcluded } from '../../common/klawlySyncModel.js';
import { IKlawlySyncStore, KlawlySyncPushResult, KlawlySyncRemote, KlawlySyncResource } from '../../common/klawlySyncStore.js';

class FakeStore implements IKlawlySyncStore {
	readonly data = new Map<KlawlySyncResource, KlawlySyncRemote>();
	private _n = 0;
	async read(resource: KlawlySyncResource) { return this.data.get(resource); }
	async push(resource: KlawlySyncResource, baseVersion: string | undefined, files: KlawlySyncSnapshot): Promise<KlawlySyncPushResult> {
		const current = this.data.get(resource);
		if (current?.version !== baseVersion) {
			return { kind: 'conflict', current };
		}
		const version = `v${++this._n}`;
		this.data.set(resource, { version, files });
		return { kind: 'ok', version };
	}

	async deleteResource(resource: KlawlySyncResource): Promise<void> {
		this.data.delete(resource);
	}
}

class FakeMachine implements IKlawlySyncLocal {
	files: Record<string, string> = {};
	base: KlawlySyncBase = { version: undefined, files: {} };
	readonly secrets = new Map<string, string>();
	async read() { return { ...this.files }; }
	async write(_r: KlawlySyncResource, expected: Record<string, string>, next: Record<string, string>) {
		if (JSON.stringify(this.files) !== JSON.stringify(expected)) {
			return false;
		}
		this.files = { ...next };
		return true;
	}
	async readBase() { return this.base; }
	async writeBase(_r: KlawlySyncResource, base: KlawlySyncBase) { this.base = base; }
	async saveConflict(_r: KlawlySyncResource, _c: KlawlySyncConflict) { }
	getSecret(name: string) { return this.secrets.get(name); }
	setSecret(name: string, value: string) { this.secrets.set(name, value); }
}

const options = (machine: string) => ({ machine, sleep: async () => { }, random: () => 0 });

const status = (patch: Partial<KlawlySyncStatus> = {}): KlawlySyncStatus => ({
	signedIn: true, paused: false, running: false, lastSyncedAt: 0, conflicts: 0, waiting: false, error: undefined, ...patch,
});

suite('Klawly Sync status and settings', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ago text', () => {
		assert.strictEqual(klawlySyncAgo(0, 30_000), 'just now');
		assert.strictEqual(klawlySyncAgo(0, 2 * 60_000), '2 minutes ago');
		assert.strictEqual(klawlySyncAgo(0, 3 * 3_600_000), '3 hours ago');
		assert.strictEqual(klawlySyncAgo(0, 5 * 86_400_000), '5 days ago');
		assert.strictEqual(klawlySyncAgo(100, 0), 'just now');
		assert.strictEqual(klawlySyncAgo(0, 60_000), '1 minute ago');
		assert.strictEqual(klawlySyncAgo(0, 3_600_000), '1 hour ago');
		assert.strictEqual(klawlySyncAgo(0, 86_400_000), '1 day ago');
	});

	test('status line picks the most urgent state', () => {
		const now = 2 * 60_000;
		assert.strictEqual(klawlySyncStatusText(status(), now), 'Synced 2 minutes ago');
		assert.strictEqual(klawlySyncStatusText(status({ signedIn: false }), now), 'Sign in with GitHub to sync your setup');
		assert.strictEqual(klawlySyncStatusText(status({ paused: true, error: 'x' }), now), 'Sync is paused. Resume it to keep your setup up to date.');
		assert.strictEqual(klawlySyncStatusText(status({ error: 'offline', conflicts: 2 }), now), 'Sync could not reach GitHub. Check your connection, then retry.');
		assert.ok(klawlySyncStatusText(status({ conflicts: 1 }), now).startsWith('1 conflict needs you'));
		assert.ok(klawlySyncStatusText(status({ conflicts: 3 }), now).startsWith('3 conflicts need you'));
		assert.strictEqual(klawlySyncStatusText(status({ waiting: true }), now), 'Sync is waiting for another of your computers to finish. It will continue by itself.');
		assert.strictEqual(klawlySyncStatusText(status({ running: true }), now), 'Syncing...');
		assert.strictEqual(klawlySyncStatusText(status({ lastSyncedAt: undefined }), now), 'Not synced yet');
	});

	test('a paused line offers Resume and the Settings link', () => {
		const line = klawlySyncStatusLine(status({ paused: true }), 0);
		assert.deepStrictEqual({ actions: line.actions, link: line.link?.args }, { actions: ['resume'], link: 'klawly.sync' });
		assert.deepStrictEqual(klawlySyncStatusLine(status({ error: 'ENOTFOUND' }), 0).actions, ['retry', 'showDetails']);
	});

	test('errors are plain words with Retry and Show Details, raw text behind details', () => {
		const line = klawlySyncStatusLine(status({ error: 'HTTP 401 Bad credentials' }), 0);
		assert.deepStrictEqual(line, {
			text: 'Sync could not sign in to GitHub. Sign in again, then retry.',
			actions: ['signIn', 'retry', 'showDetails'],
			details: 'HTTP 401 Bad credentials',
			link: undefined,
		});
		assert.strictEqual(klawlySyncPlainError('getaddrinfo ENOTFOUND api.github.com'), 'Sync could not reach GitHub. Check your connection, then retry.');
		assert.strictEqual(klawlySyncPlainError('HTTP 429'), 'GitHub asked Klawly to slow down. Wait a few minutes, then retry.');
		assert.strictEqual(klawlySyncPlainError('HTTP 503'), 'GitHub had a problem. Try again in a few minutes.');
		assert.strictEqual(klawlySyncPlainError('status 502'), 'GitHub had a problem. Try again in a few minutes.');
		// a stray number or the word token is not an auth or server error
		const unknown = 'Sync failed. Retry, or choose Show Details to see why.';
		assert.deepStrictEqual([
			klawlySyncPlainError('wrote 512 files'),
			klawlySyncPlainError('invalid token in gist payload'),
		], [unknown, unknown]);
		assert.strictEqual(klawlySyncPlainError('weird'),'Sync failed. Retry, or choose Show Details to see why.');
	});

	test('the conflict line links to Settings > Sync', () => {
		const line = klawlySyncStatusLine(status({ conflicts: 1 }), 0);
		assert.deepStrictEqual(line.link, { command: 'workbench.action.openSettings', args: 'klawly.sync' });
		assert.strictEqual(line.text, '1 conflict needs you. Resolve it in Settings > Sync');
	});

	test('pull notice names the kind and the machine', () => {
		const synced = { kind: 'synced', pulled: ['CLAUDE.md'], pushed: false, missingSecrets: [] } as const;
		assert.strictEqual(klawlySyncPullNotice('rules', synced, 'MacBook'), 'User rules updated from MacBook');
		assert.strictEqual(klawlySyncPullNotice('rules', synced, undefined), 'User rules updated from another machine');
		assert.strictEqual(klawlySyncPullNotice('rules', { ...synced, pulled: [] }, 'MacBook'), undefined);
		assert.strictEqual(klawlySyncPullNotice('rules', { kind: 'unchanged' }, 'MacBook'), undefined);
		assert.strictEqual(klawlySyncPullNotice('rules', new Error('x'), 'MacBook'), undefined);
	});

	test('preferences toggle, round trip and ignore bad input', () => {
		let prefs = toggleKlawlySyncExcluded(KLAWLY_SYNC_DEFAULT_PREFERENCES, 'mcp');
		prefs = toggleKlawlySyncExcluded(prefs, 'rules');
		assert.deepStrictEqual(prefs.excluded, ['rules', 'mcp']);
		assert.deepStrictEqual(toggleKlawlySyncExcluded(prefs, 'rules').excluded, ['mcp']);
		const paused = { ...prefs, paused: true };
		assert.deepStrictEqual(parseKlawlySyncPreferences(serializeKlawlySyncPreferences(paused)), paused);
		assert.deepStrictEqual(parseKlawlySyncPreferences('{"paused":true,"excluded":["mcp","nope"]}'), { paused: true, excluded: ['mcp'] });
		for (const bad of [undefined, '', 'nope', 'null', '5']) {
			assert.deepStrictEqual(parseKlawlySyncPreferences(bad), KLAWLY_SYNC_DEFAULT_PREFERENCES);
		}
	});
});

suite('Klawly Sync first sign-in choice', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	async function setup() {
		const store = new FakeStore();
		const first = new FakeMachine();
		first.files = { 'a.md': 'synced a\n', 'b.md': 'synced b\n' };
		await syncKlawlyResource('rules', first, store, options('A'));
		const second = new FakeMachine();
		second.files = { 'a.md': 'mine a\n', 'c.md': 'mine c\n' };
		return { store, second };
	}

	test('use the synced setup replaces this machine files', async () => {
		const { store, second } = await setup();
		const outcome = await applyKlawlyFirstSignIn('useSynced', 'rules', second, store, options('B'));
		assert.strictEqual(outcome.kind, 'synced');
		assert.deepStrictEqual(second.files, { 'a.md': 'synced a\n', 'b.md': 'synced b\n' });
		assert.deepStrictEqual(await syncKlawlyResource('rules', second, store, options('B')), { kind: 'unchanged' });
	});

	test('keep this machine pushes its files over the synced ones', async () => {
		const { store, second } = await setup();
		await applyKlawlyFirstSignIn('keepMine', 'rules', second, store, options('B'));
		assert.strictEqual(second.files['a.md'], 'mine a\n');
		const remote = await store.read('rules');
		assert.strictEqual(remote?.files['a.md'], 'mine a\n');
		assert.strictEqual(remote?.files['c.md'], 'mine c\n');
	});

	test('merge keeps additions from both sides and flags the clash', async () => {
		const { store, second } = await setup();
		const outcome = await applyKlawlyFirstSignIn('merge', 'rules', second, store, options('B'));
		assert.strictEqual(outcome.kind, 'conflict');
		assert.strictEqual(second.files['b.md'], 'synced b\n');
		assert.strictEqual(second.files['c.md'], 'mine c\n');
	});

	test('use synced on an empty store changes nothing', async () => {
		const store = new FakeStore();
		const m = new FakeMachine();
		m.files = { 'a.md': 'x\n' };
		await applyKlawlyFirstSignIn('useSynced', 'rules', m, store, options('B'));
		assert.deepStrictEqual(m.files, { 'a.md': 'x\n' });
	});
});
