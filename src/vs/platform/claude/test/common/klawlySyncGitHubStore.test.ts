/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IKlawlySyncHttp, KlawlySyncHttpResponse } from '../../common/klawlySyncDeviceFlow.js';
import { KlawlySyncGitHubStore } from '../../common/klawlySyncGitHubStore.js';

type Body = Record<string, unknown>;

/** A small in-memory GitHub git data API: repos, blobs, trees, commits and one branch ref. */
class FakeGitHub implements IKlawlySyncHttp {
	repoExists = false;
	readonly blobs = new Map<string, string>();
	readonly trees = new Map<string, Record<string, string>>();
	readonly commits = new Map<string, { tree: string; parent: string | undefined }>();
	head: string | undefined;
	readonly requests: string[] = [];
	conditionalHits = 0;
	private _n = 0;

	private id(kind: string) {
		return `${kind}${++this._n}`;
	}

	private blob(content: string) {
		for (const [sha, text] of this.blobs) {
			if (text === content) {
				return sha;
			}
		}
		const sha = this.id('b');
		this.blobs.set(sha, content);
		return sha;
	}

	async request(method: string, url: string, headers: Readonly<Record<string, string>>, body?: unknown): Promise<KlawlySyncHttpResponse> {
		const path = url.replace('https://api.github.com', '');
		this.requests.push(`${method} ${path.split('?')[0]}`);
		const ok = (status: number, data: unknown, extra: Record<string, string> = {}) => ({ status, headers: extra, body: data });
		if (method === 'GET' && path === '/repos/me/klawly-sync') {
			return this.repoExists ? ok(200, {}) : ok(404, { message: 'Not Found' });
		}
		if (method === 'POST' && path === '/user/repos') {
			this.repoExists = true;
			this.trees.set('t0', {});
			this.commits.set('c0', { tree: 't0', parent: undefined });
			this.head = 'c0';
			return ok(201, {});
		}
		if (method === 'GET' && path === '/repos/me/klawly-sync/git/ref/heads/main') {
			const etag = `"${this.head}"`;
			if (headers['If-None-Match'] === etag) {
				this.conditionalHits++;
				return ok(304, undefined);
			}
			return ok(200, { object: { sha: this.head } }, { etag });
		}
		const commitMatch = /\/git\/commits\/(?<sha>\w+)$/.exec(path);
		if (method === 'GET' && commitMatch) {
			return ok(200, { tree: { sha: this.commits.get(commitMatch.groups!.sha)!.tree } });
		}
		const treeMatch = /\/git\/trees\/(?<sha>\w+)$/.exec(path.split('?')[0]);
		if (method === 'GET' && treeMatch) {
			const tree = this.trees.get(treeMatch.groups!.sha)!;
			return ok(200, { tree: Object.entries(tree).map(([p, sha]) => ({ path: p, type: 'blob', sha })) });
		}
		const blobMatch = /\/git\/blobs\/(?<sha>\w+)$/.exec(path);
		if (method === 'GET' && blobMatch) {
			return ok(200, { content: Buffer.from(this.blobs.get(blobMatch.groups!.sha)!).toString('base64') });
		}
		if (method === 'POST' && path.endsWith('/git/trees')) {
			const input = body as Body;
			const next = { ...this.trees.get(input.base_tree as string) };
			for (const entry of input.tree as Body[]) {
				if (entry.sha === null) {
					delete next[entry.path as string];
				} else {
					next[entry.path as string] = this.blob(entry.content as string);
				}
			}
			const sha = this.id('t');
			this.trees.set(sha, next);
			return ok(201, { sha });
		}
		if (method === 'POST' && path.endsWith('/git/commits')) {
			const input = body as Body;
			const sha = this.id('c');
			this.commits.set(sha, { tree: input.tree as string, parent: (input.parents as string[])[0] });
			return ok(201, { sha });
		}
		if (method === 'PATCH' && path.endsWith('/git/refs/heads/main')) {
			const input = body as Body;
			if (input.force !== false || this.commits.get(input.sha as string)!.parent !== this.head) {
				return ok(422, { message: 'Update is not a fast forward' });
			}
			this.head = input.sha as string;
			return ok(200, {});
		}
		return ok(500, { message: `unhandled ${method} ${path}` });
	}
}

suite('Klawly Sync GitHub store', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('creates the private repo, pushes files and reads them back', async () => {
		const github = new FakeGitHub();
		const store = new KlawlySyncGitHubStore(github, 'token', 'me');
		assert.strictEqual(await store.read('rules'), undefined);
		assert.ok(github.repoExists);

		const pushed = await store.push('rules', undefined, { 'CLAUDE.md': 'hello\n', 'old.md': null }, 'Desktop-PC');
		assert.strictEqual(pushed.kind, 'ok');
		const back = await store.read('rules');
		assert.deepStrictEqual(back?.files, { 'CLAUDE.md': 'hello\n', 'old.md': null });
	});

	test('a push on a stale version is refused, and the other resources are untouched', async () => {
		const github = new FakeGitHub();
		const mine = new KlawlySyncGitHubStore(github, 'token', 'me');
		const theirs = new KlawlySyncGitHubStore(github, 'token', 'me');
		const first = await mine.push('rules', undefined, { 'CLAUDE.md': 'one\n' }, 'A');
		assert.strictEqual(first.kind, 'ok');
		const version = (await theirs.read('rules'))!.version;
		assert.strictEqual((await theirs.push('skills', undefined, { 's.md': 's' }, 'B')).kind, 'ok');

		// The branch moved for another resource: a push on the old version is not a fast forward, so
		// GitHub refuses it. That is a harmless conflict: rules are unchanged and the engine retries.
		const stale = await mine.push('rules', version, { 'CLAUDE.md': 'two\n' }, 'A');
		assert.strictEqual(stale.kind, 'conflict');
		assert.deepStrictEqual(stale.kind === 'conflict' && stale.current?.files, { 'CLAUDE.md': 'one\n' });
	});

	test('a real race ends in a conflict carrying the current content', async () => {
		const github = new FakeGitHub();
		const a = new KlawlySyncGitHubStore(github, 'token', 'me');
		const b = new KlawlySyncGitHubStore(github, 'token', 'me');
		const v1 = await a.push('rules', undefined, { 'CLAUDE.md': 'one\n' }, 'A');
		assert.strictEqual(v1.kind, 'ok');
		const seen = (await b.read('rules'))!;
		assert.strictEqual((await a.push('rules', seen.version, { 'CLAUDE.md': 'two\n' }, 'A')).kind, 'ok');
		const lost = await b.push('rules', seen.version, { 'CLAUDE.md': 'three\n' }, 'B');
		assert.strictEqual(lost.kind, 'conflict');
		assert.deepStrictEqual(lost.kind === 'conflict' && lost.current?.files, { 'CLAUDE.md': 'two\n' });
	});

	test('polling the branch uses If-None-Match and a 304 reuses the answer', async () => {
		const github = new FakeGitHub();
		const store = new KlawlySyncGitHubStore(github, 'token', 'me');
		await store.push('rules', undefined, { 'CLAUDE.md': 'x\n' }, 'A');
		await store.read('rules');
		await store.read('rules');
		assert.ok(github.conditionalHits >= 1);
	});
});
