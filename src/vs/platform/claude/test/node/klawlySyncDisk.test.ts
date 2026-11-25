/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { Server } from 'http';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { syncKlawlyAll } from '../../common/klawlySyncEngine.js';
import { KlawlySyncSnapshot } from '../../common/klawlySyncMerge.js';
import { IKlawlySyncStore, KlawlySyncPushResult, KlawlySyncRemote, KlawlySyncResource } from '../../common/klawlySyncStore.js';
import { KlawlySyncFileLocal } from '../../node/klawlySyncFileLocal.js';
import { KlawlySyncNodeHttp } from '../../node/klawlySyncNodeHttp.js';

/** A real store with versions and compare-and-swap, held in memory. */
class MemoryStore implements IKlawlySyncStore {
	private readonly _data = new Map<KlawlySyncResource, KlawlySyncRemote>();
	private _n = 0;

	async read(resource: KlawlySyncResource): Promise<KlawlySyncRemote | undefined> {
		return this._data.get(resource);
	}

	async push(resource: KlawlySyncResource, baseVersion: string | undefined, files: KlawlySyncSnapshot): Promise<KlawlySyncPushResult> {
		const current = this._data.get(resource);
		if (current?.version !== baseVersion) {
			return { kind: 'conflict', current };
		}
		const next = { version: `v${++this._n}`, files };
		this._data.set(resource, next);
		return { kind: 'ok', version: next.version };
	}

	async deleteResource(resource: KlawlySyncResource): Promise<void> {
		this._data.delete(resource);
	}
}

const runOptions = { machine: 'test', sleep: async () => { }, random: () => 0, excluded: new Set<KlawlySyncResource>(), paused: new Set<KlawlySyncResource>() };

suite('Klawly Sync on disk', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'klawly-sync-'));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	function machine(name: string) {
		const secrets = new Map<string, string>();
		const local = new KlawlySyncFileLocal({
			resourceDir: resource => join(root, name, 'files', resource),
			syncDir: join(root, name, '.sync'),
			getSecret: key => secrets.get(key),
			setSecret: (key, value) => { secrets.set(key, value); },
		});
		return { local, file: (resource: string, path: string) => join(root, name, 'files', resource, path) };
	}

	test('a rule written on one machine reaches the other, and a delete follows', async () => {
		const store = new MemoryStore();
		const a = machine('a');
		const b = machine('b');
		await fs.mkdir(join(root, 'a', 'files', 'rules'), { recursive: true });
		await fs.writeFile(a.file('rules', 'style.md'), 'use tabs');

		await syncKlawlyAll(a.local, store, runOptions);
		await syncKlawlyAll(b.local, store, runOptions);
		assert.strictEqual(await fs.readFile(b.file('rules', 'style.md'), 'utf8'), 'use tabs');

		await fs.rm(a.file('rules', 'style.md'));
		await syncKlawlyAll(a.local, store, runOptions);
		await syncKlawlyAll(b.local, store, runOptions);
		assert.deepStrictEqual(await b.local.read('rules'), {});
	});

	test('both machines editing the same line keeps the local file and the remote text next to it', async () => {
		const store = new MemoryStore();
		const a = machine('a');
		const b = machine('b');
		await fs.mkdir(join(root, 'a', 'files', 'rules'), { recursive: true });
		await fs.writeFile(a.file('rules', 'r.md'), 'one');
		await syncKlawlyAll(a.local, store, runOptions);
		await syncKlawlyAll(b.local, store, runOptions);

		await fs.writeFile(a.file('rules', 'r.md'), 'from a');
		await fs.writeFile(b.file('rules', 'r.md'), 'from b');
		await syncKlawlyAll(a.local, store, runOptions);
		const results = await syncKlawlyAll(b.local, store, runOptions);

		assert.strictEqual(results.get('rules')?.constructor === Error ? 'error' : (results.get('rules') as { kind: string }).kind, 'conflict');
		assert.strictEqual(await fs.readFile(b.file('rules', 'r.md'), 'utf8'), 'from b');
		assert.strictEqual(await fs.readFile(join(root, 'b', '.sync', 'conflicts', 'rules', 'r.md.remote'), 'utf8'), 'from a');
	});

	test('a changed folder is not overwritten: write is refused when the files moved on', async () => {
		const a = machine('a');
		await fs.mkdir(join(root, 'a', 'files', 'rules'), { recursive: true });
		await fs.writeFile(a.file('rules', 'r.md'), 'now');
		assert.strictEqual(await a.local.write('rules', { 'r.md': 'before' }, { 'r.md': 'sync' }), false);
		assert.strictEqual(await fs.readFile(a.file('rules', 'r.md'), 'utf8'), 'now');
	});

	test('a remote path that climbs out of the folder is refused', async () => {
		const a = machine('a');
		await assert.rejects(a.local.write('rules', {}, { '../escape.md': 'x' }), /outside its folder/);
		await assert.rejects(fs.access(join(root, 'a', 'files', 'escape.md')));
	});

	suite('node http', () => {
		let server: Server;
		let url: string;
		let seen: { method?: string; auth?: string; body: string } | undefined;

		setup(async () => {
			seen = undefined;
			const { createServer } = await import('http');
			server = createServer((request, response) => {
				let body = '';
				request.on('data', chunk => { body += chunk; });
				request.on('end', () => {
					seen = { method: request.method, auth: request.headers.authorization, body };
					response.setHeader('ETag', '"abc"');
					response.end(JSON.stringify({ ok: true }));
				});
			});
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
			url = `http://127.0.0.1:${(server.address() as { port: number }).port}/x`;
		});

		teardown(async () => {
			await new Promise<void>(resolve => server.close(() => resolve()));
		});

		test('sends JSON, parses the answer and lowercases header names', async () => {
			const http = new KlawlySyncNodeHttp((target, init) => fetch(target, init), ['127.0.0.1']);
			const response = await http.request('POST', url, { Authorization: 'Bearer t' }, { a: 1 });
			assert.deepStrictEqual({ seen, status: response.status, body: response.body, etag: response.headers.etag }, {
				seen: { method: 'POST', auth: 'Bearer t', body: '{"a":1}' },
				status: 200,
				body: { ok: true },
				etag: '"abc"',
			});
		});

		test('refuses hosts that are not GitHub', async () => {
			const http = new KlawlySyncNodeHttp();
			seen = undefined;
			await assert.rejects(http.request('GET', url, {}), /does not talk to 127\.0\.0\.1/);
			assert.strictEqual(seen, undefined);
		});
	});
});
