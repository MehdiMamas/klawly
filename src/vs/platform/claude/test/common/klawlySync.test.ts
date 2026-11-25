/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IKlawlySyncHttp, KlawlySyncHttpResponse, pollKlawlyDeviceToken, requestKlawlyDeviceCode } from '../../common/klawlySyncDeviceFlow.js';
import { IKlawlySyncLocal, KlawlySyncBase, syncKlawlyAll, syncKlawlyResource } from '../../common/klawlySyncEngine.js';
import { KlawlySyncConflict, KlawlySyncSnapshot, mergeKlawlySnapshots, mergeKlawlyText, withKlawlyTombstones } from '../../common/klawlySyncMerge.js';
import { makeKlawlySnapshotPortable, restoreKlawlySnapshotSecrets } from '../../common/klawlySyncSecrets.js';
import { IKlawlySyncStore, KlawlySyncPushResult, KlawlySyncRemote, KlawlySyncResource } from '../../common/klawlySyncStore.js';

// A fake key is joined at run time so repository secret scanners do not flag this file.
const FAKE_ANTHROPIC_KEY = ['sk', '-ant-', 'api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'].join('');

class FakeStore implements IKlawlySyncStore {
	readonly data = new Map<KlawlySyncResource, KlawlySyncRemote>();
	private _counter = 0;
	/** Runs before each push, so a test can make another machine push first. */
	beforePush: (() => Promise<void>) | undefined;
	pushes = 0;

	async read(resource: KlawlySyncResource) {
		return this.data.get(resource);
	}

	async push(resource: KlawlySyncResource, baseVersion: string | undefined, files: KlawlySyncSnapshot): Promise<KlawlySyncPushResult> {
		const hook = this.beforePush;
		this.beforePush = undefined;
		await hook?.();
		const current = this.data.get(resource);
		if (current?.version !== baseVersion) {
			return { kind: 'conflict', current };
		}
		this.pushes++;
		const version = `v${++this._counter}`;
		this.data.set(resource, { version, files });
		return { kind: 'ok', version };
	}

	async deleteResource(resource: KlawlySyncResource): Promise<void> {
		this.data.delete(resource);
	}
}

class FakeMachine implements IKlawlySyncLocal {
	readonly files = new Map<KlawlySyncResource, Record<string, string>>();
	readonly bases = new Map<KlawlySyncResource, KlawlySyncBase>();
	readonly secrets = new Map<string, string>();
	readonly conflicts: KlawlySyncConflict[] = [];

	set(resource: KlawlySyncResource, files: Record<string, string>) {
		this.files.set(resource, files);
	}

	get(resource: KlawlySyncResource) {
		return this.files.get(resource) ?? {};
	}

	async read(resource: KlawlySyncResource) {
		return { ...this.get(resource) };
	}

	async write(resource: KlawlySyncResource, expected: Record<string, string>, next: Record<string, string>) {
		if (JSON.stringify(this.get(resource)) !== JSON.stringify(expected)) {
			return false;
		}
		this.files.set(resource, { ...next });
		return true;
	}

	async readBase(resource: KlawlySyncResource) {
		return this.bases.get(resource) ?? { version: undefined, files: {} };
	}

	async writeBase(resource: KlawlySyncResource, base: KlawlySyncBase) {
		this.bases.set(resource, base);
	}

	async saveConflict(_resource: KlawlySyncResource, conflict: KlawlySyncConflict) {
		this.conflicts.push(conflict);
	}

	getSecret(name: string) {
		return this.secrets.get(name);
	}

	setSecret(name: string, value: string) {
		this.secrets.set(name, value);
	}
}

const options = (machine: string, sleeps: number[] = []) => ({
	machine,
	sleep: async (ms: number) => { sleeps.push(ms); },
	random: () => 0,
});

suite('Klawly Sync merge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('line merge combines edits in different places and flags the same place', () => {
		const base = 'a\nb\nc\nd\n';
		assert.deepStrictEqual(mergeKlawlyText(base, 'A\nb\nc\nd\n', 'a\nb\nc\nD\n'), { text: 'A\nb\nc\nD\n' });
		assert.deepStrictEqual(mergeKlawlyText(base, 'x\nb\nc\nd\n', 'y\nb\nc\nd\n'), { conflict: true });
		assert.deepStrictEqual(mergeKlawlyText(base, 'x\nb\nc\nd\n', 'x\nb\nc\nd\n'), { text: 'x\nb\nc\nd\n' });
	});

	test('settings.json merges per key, .mcp.json per server', () => {
		const settings = mergeKlawlySnapshots(
			{ 'settings.json': '{"a":1,"b":1}' },
			{ 'settings.json': '{"a":2,"b":1}' },
			{ 'settings.json': '{"a":1,"b":2}' });
		assert.deepStrictEqual(JSON.parse(settings.files['settings.json']!), { a: 2, b: 2 });

		const mcp = mergeKlawlySnapshots(
			{ '.mcp.json': '{"mcpServers":{"x":{"command":"x"}}}' },
			{ '.mcp.json': '{"mcpServers":{"x":{"command":"x"},"l":{"command":"l"}}}' },
			{ '.mcp.json': '{"mcpServers":{"x":{"command":"x"},"r":{"command":"r"}}}' });
		assert.deepStrictEqual(Object.keys(JSON.parse(mcp.files['.mcp.json']!).mcpServers).sort(), ['l', 'r', 'x']);
		assert.deepStrictEqual(mcp.conflicts, []);

		const clash = mergeKlawlySnapshots(
			{ '.mcp.json': '{"mcpServers":{"x":{"command":"x"}}}' },
			{ '.mcp.json': '{"mcpServers":{"x":{"command":"l"}}}' },
			{ '.mcp.json': '{"mcpServers":{"x":{"command":"r"}}}' });
		assert.strictEqual(clash.conflicts.length, 1);
	});

	test('tombstones: a delete wins over an untouched file and never gets resurrected', () => {
		const base = { 'skills/a.md': 'a', 'skills/b.md': 'b' };
		const local = withKlawlyTombstones({ 'skills/b.md': 'b' }, base);
		assert.deepStrictEqual(local, { 'skills/a.md': null, 'skills/b.md': 'b' });
		// The other machine is still on the old copy: the delete wins, with no clock involved.
		assert.deepStrictEqual(mergeKlawlySnapshots(base, local, base).files, { 'skills/a.md': null, 'skills/b.md': 'b' });
		// Delete against edit is a conflict that keeps the edit.
		const clash = mergeKlawlySnapshots(base, local, { ...base, 'skills/a.md': 'a2' });
		assert.deepStrictEqual(clash.conflicts.map(c => c.path), ['skills/a.md']);
	});
});

suite('Klawly Sync secrets', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('MCP env and headers become placeholders and come back on restore', () => {
		const original = JSON.stringify({ mcpServers: { gh: { command: 'gh', env: { TOKEN: 'abc123' }, headers: { Authorization: 'Bearer xyz' } } } });
		const portable = makeKlawlySnapshotPortable({ '.mcp.json': original });
		assert.deepStrictEqual(portable.findings, []);
		assert.ok(!portable.files['.mcp.json']!.includes('abc123') && !portable.files['.mcp.json']!.includes('xyz'));
		assert.deepStrictEqual(portable.secrets, { MCP_GH_TOKEN: 'abc123', MCP_GH_HEADER_AUTHORIZATION: 'Bearer xyz' });

		const restored = restoreKlawlySnapshotSecrets(portable.files, name => portable.secrets[name]);
		assert.deepStrictEqual(restored.missing, []);
		assert.deepStrictEqual(JSON.parse(restored.files['.mcp.json']!), JSON.parse(original));

		const fresh = restoreKlawlySnapshotSecrets(portable.files, () => undefined);
		assert.deepStrictEqual(fresh.missing, ['MCP_GH_HEADER_AUTHORIZATION', 'MCP_GH_TOKEN']);
	});

	test('the scanner blocks a planted key in a rule file, reporting the path and a count only', () => {
		const portable = makeKlawlySnapshotPortable({ 'CLAUDE.md': `use ${FAKE_ANTHROPIC_KEY} for the API` });
		assert.deepStrictEqual(portable.findings, [{ path: 'CLAUDE.md', count: 1 }]);
		assert.ok(!JSON.stringify(portable.findings).includes(FAKE_ANTHROPIC_KEY));
	});
});

suite('Klawly Sync engine', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the first machine pushes, the second pulls, both end equal', async () => {
		const store = new FakeStore();
		const a = new FakeMachine();
		const b = new FakeMachine();
		a.set('rules', { 'CLAUDE.md': 'one\n' });
		assert.strictEqual((await syncKlawlyResource('rules', a, store, options('A'))).kind, 'synced');
		const pulled = await syncKlawlyResource('rules', b, store, options('B'));
		assert.deepStrictEqual(pulled, { kind: 'synced', pulled: ['CLAUDE.md'], pushed: false, missingSecrets: [] });
		assert.deepStrictEqual(b.get('rules'), { 'CLAUDE.md': 'one\n' });
		assert.deepStrictEqual(await syncKlawlyResource('rules', b, store, options('B')), { kind: 'unchanged' });
	});

	test('a delete travels as a tombstone and an offline machine does not bring the file back', async () => {
		const store = new FakeStore();
		const a = new FakeMachine();
		const b = new FakeMachine();
		a.set('skills', { 'x.md': 'x', 'y.md': 'y' });
		await syncKlawlyResource('skills', a, store, options('A'));
		await syncKlawlyResource('skills', b, store, options('B'));
		a.set('skills', { 'y.md': 'y' });
		await syncKlawlyResource('skills', a, store, options('A'));
		await syncKlawlyResource('skills', b, store, options('B'));
		assert.deepStrictEqual(b.get('skills'), { 'y.md': 'y' });
		assert.strictEqual(store.data.get('skills')!.files['x.md'], null);
	});

	test('two machines editing different places both land, with a retry after losing the race', async () => {
		const store = new FakeStore();
		const a = new FakeMachine();
		const b = new FakeMachine();
		a.set('rules', { 'CLAUDE.md': 'a\nb\nc\n' });
		await syncKlawlyResource('rules', a, store, options('A'));
		await syncKlawlyResource('rules', b, store, options('B'));
		a.set('rules', { 'CLAUDE.md': 'A\nb\nc\n' });
		b.set('rules', { 'CLAUDE.md': 'a\nb\nC\n' });
		const sleeps: number[] = [];
		// B reads, then A pushes before B's push lands: B must retry on the new head.
		store.beforePush = async () => { await syncKlawlyResource('rules', a, store, options('A')); };
		const result = await syncKlawlyResource('rules', b, store, options('B', sleeps));
		assert.strictEqual(result.kind, 'synced');
		assert.strictEqual(sleeps.length, 1);
		assert.deepStrictEqual(b.get('rules'), { 'CLAUDE.md': 'A\nb\nC\n' });
		await syncKlawlyResource('rules', a, store, options('A'));
		assert.deepStrictEqual(a.get('rules'), b.get('rules'));
	});

	test('it gives up after 5 retries with backoff and jitter and reports waiting', async () => {
		const store = new FakeStore();
		const a = new FakeMachine();
		a.set('rules', { 'CLAUDE.md': 'x\n' });
		const sleeps: number[] = [];
		let n = 0;
		store.push = async (_r, _b, _f) => ({ kind: 'conflict', current: { version: `v${n++}`, files: {} } });
		const result = await syncKlawlyResource('rules', a, store, { ...options('A', sleeps), random: () => 0.5 });
		assert.deepStrictEqual(result, { kind: 'waiting' });
		assert.deepStrictEqual(sleeps, [750, 1500, 3000, 6000, 12000]);
	});

	test('a real conflict keeps the local file, saves the remote one and pushes nothing', async () => {
		const store = new FakeStore();
		const a = new FakeMachine();
		const b = new FakeMachine();
		a.set('rules', { 'CLAUDE.md': 'start\n' });
		await syncKlawlyResource('rules', a, store, options('A'));
		await syncKlawlyResource('rules', b, store, options('B'));
		a.set('rules', { 'CLAUDE.md': 'from a\n' });
		b.set('rules', { 'CLAUDE.md': 'from b\n' });
		await syncKlawlyResource('rules', a, store, options('A'));
		const pushes = store.pushes;
		const result = await syncKlawlyResource('rules', b, store, options('B'));
		assert.strictEqual(result.kind, 'conflict');
		assert.deepStrictEqual(b.conflicts, [{ path: 'CLAUDE.md', local: 'from b\n', remote: 'from a\n' }]);
		assert.deepStrictEqual(b.get('rules'), { 'CLAUDE.md': 'from b\n' });
		assert.strictEqual(store.pushes, pushes);
	});

	test('an edit made while syncing is never overwritten', async () => {
		const store = new FakeStore();
		const a = new FakeMachine();
		const b = new FakeMachine();
		a.set('rules', { 'CLAUDE.md': 'one\n' });
		await syncKlawlyResource('rules', a, store, options('A'));
		const realWrite = b.write.bind(b);
		let raced = false;
		b.write = async (resource, expected, next) => {
			if (!raced) {
				raced = true;
				b.set('rules', { 'CLAUDE.md': 'typed meanwhile\n' });
			}
			return realWrite(resource, expected, next);
		};
		await syncKlawlyResource('rules', b, store, options('B'));
		assert.ok(JSON.stringify(b.get('rules')).includes('typed meanwhile') || store.data.get('rules')!.files['CLAUDE.md']!.includes('typed meanwhile'));
	});

	test('secrets never leave the machine and a second machine gets the placeholder', async () => {
		const store = new FakeStore();
		const a = new FakeMachine();
		const b = new FakeMachine();
		a.set('mcp', { '.mcp.json': JSON.stringify({ mcpServers: { gh: { command: 'gh', env: { TOKEN: 'abc123' } } } }) });
		await syncKlawlyResource('mcp', a, store, options('A'));
		assert.ok(!JSON.stringify(store.data.get('mcp')).includes('abc123'));
		const result = await syncKlawlyResource('mcp', b, store, options('B'));
		assert.deepStrictEqual(result.kind === 'synced' && result.missingSecrets, ['MCP_GH_TOKEN']);
		b.setSecret('MCP_GH_TOKEN', 'mine');
		await syncKlawlyResource('mcp', b, store, options('B'));
		assert.ok(b.get('mcp')['.mcp.json'].includes('mine'));
	});

	test('a planted key blocks the push and nothing reaches the store', async () => {
		const store = new FakeStore();
		const a = new FakeMachine();
		a.set('rules', { 'CLAUDE.md': FAKE_ANTHROPIC_KEY });
		const result = await syncKlawlyResource('rules', a, store, options('A'));
		assert.deepStrictEqual(result, { kind: 'blocked', findings: [{ path: 'CLAUDE.md', count: 1 }] });
		assert.strictEqual(store.data.size, 0);
	});

	test('excluded and paused kinds are skipped, one failing kind does not stop the rest', async () => {
		const store = new FakeStore();
		const a = new FakeMachine();
		a.set('rules', { 'CLAUDE.md': 'r\n' });
		a.set('agents', { 'a.md': 'a' });
		a.set('skills', { 's.md': 's' });
		const realRead = store.read.bind(store);
		store.read = async resource => { if (resource === 'skills') { throw new Error('boom'); } return realRead(resource); };
		const results = await syncKlawlyAll(a, store, { ...options('A'), excluded: new Set<KlawlySyncResource>(['agents']), paused: new Set<KlawlySyncResource>(['commands']) });
		assert.ok(results.get('rules') && !(results.get('rules') instanceof Error));
		assert.ok(results.get('skills') instanceof Error);
		assert.ok(!results.has('agents') && !results.has('commands'));
		assert.ok(!store.data.has('agents'));
	});
});

suite('Klawly Sync device flow', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function http(answers: KlawlySyncHttpResponse[], seen: { url: string; body: unknown }[] = []): IKlawlySyncHttp {
		return { request: async (_m, url, _h, body) => { seen.push({ url, body }); return answers.shift()!; } };
	}

	test('asks for a device code with the app client ID', async () => {
		const seen: { url: string; body: unknown }[] = [];
		const code = await requestKlawlyDeviceCode(http([{ status: 200, headers: {}, body: { device_code: 'd', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 } }], seen));
		assert.deepStrictEqual(code, { deviceCode: 'd', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 900 });
		assert.deepStrictEqual(seen, [{ url: 'https://github.com/login/device/code', body: { client_id: 'Iv23lijm3L8bSxBkj6V4' } }]);
	});

	test('polls through pending and slow_down until the token arrives', async () => {
		const sleeps: number[] = [];
		const code = { deviceCode: 'd', userCode: 'u', verificationUri: 'v', interval: 5, expiresIn: 900 };
		const result = await pollKlawlyDeviceToken(http([
			{ status: 200, headers: {}, body: { error: 'authorization_pending' } },
			{ status: 200, headers: {}, body: { error: 'slow_down', interval: 10 } },
			{ status: 200, headers: {}, body: { access_token: 'tok' } },
		]), code, async ms => { sleeps.push(ms); });
		assert.deepStrictEqual(result, { kind: 'token', accessToken: 'tok' });
		assert.deepStrictEqual(sleeps, [5000, 5000, 10000]);
	});

	test('reports denied and expired', async () => {
		const code = { deviceCode: 'd', userCode: 'u', verificationUri: 'v', interval: 1, expiresIn: 10 };
		assert.deepStrictEqual(await pollKlawlyDeviceToken(http([{ status: 200, headers: {}, body: { error: 'access_denied' } }]), code, async () => { }), { kind: 'denied' });
		assert.deepStrictEqual(await pollKlawlyDeviceToken(http([{ status: 200, headers: {}, body: { error: 'expired_token' } }]), code, async () => { }), { kind: 'expired' });
	});
});
