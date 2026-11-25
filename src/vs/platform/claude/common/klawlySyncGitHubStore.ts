/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IKlawlySyncHttp, KlawlySyncHttpResponse } from './klawlySyncDeviceFlow.js';
import { KlawlySyncSnapshot } from './klawlySyncMerge.js';
import { IKlawlySyncStore, KlawlySyncPushResult, KlawlySyncRemote, KlawlySyncResource } from './klawlySyncStore.js';

/** The repo in the user's own account that holds the synced files. */
export const KLAWLY_SYNC_REPO_NAME = 'klawly-sync';

const API = 'https://api.github.com';
const BRANCH = 'main';
const TOMBSTONES_FILE = '.tombstones.json';

function record(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function str(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** Reasons the store can fail in words the status line shows. */
export class KlawlySyncStoreError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

/**
 * {@link IKlawlySyncStore} on a private repo `<login>/klawly-sync`. One folder per resource, the
 * branch's head commit is the version, and a push is a commit on top of the version it names:
 * moving the ref without `force` is the compare-and-swap, which GitHub rejects (422) when
 * another machine moved the branch first. Polling sends `If-None-Match`, and a 304 does not
 * count against the rate limit. The token is the "Klawly Sync" GitHub App's user token.
 */
export class KlawlySyncGitHubStore implements IKlawlySyncStore {

	private readonly _blobs = new Map<string, string>();
	private _head: { etag: string | undefined; sha: string } | undefined;
	private _ready = false;

	constructor(
		private readonly _http: IKlawlySyncHttp,
		private readonly _token: string,
		private readonly _login: string,
	) { }

	private get repoUrl(): string {
		return `${API}/repos/${this._login}/${KLAWLY_SYNC_REPO_NAME}`;
	}

	private async call(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, extra: Record<string, string> = {}): Promise<KlawlySyncHttpResponse> {
		return this._http.request(method, url, {
			Accept: 'application/vnd.github+json',
			Authorization: `Bearer ${this._token}`,
			'X-GitHub-Api-Version': '2022-11-28',
			...extra,
		}, body);
	}

	private fail(response: KlawlySyncHttpResponse, doing: string): never {
		const message = str(record(response.body).message);
		throw new KlawlySyncStoreError(`GitHub did not let Klawly Sync ${doing} (HTTP ${response.status}${message ? `: ${message}` : ''}).`, response.status);
	}

	/** Creates the private repo on first use. Needs the app installed on the account. */
	private async ensureRepo(): Promise<void> {
		if (this._ready) {
			return;
		}
		const found = await this.call('GET', this.repoUrl);
		if (found.status === 404) {
			const created = await this.call('POST', `${API}/user/repos`, { name: KLAWLY_SYNC_REPO_NAME, private: true, auto_init: true, description: 'Klawly Sync: your Klawly setup. Created by Klawly.' });
			if (created.status !== 201) {
				this.fail(created, 'create the klawly-sync repo');
			}
		} else if (found.status !== 200) {
			this.fail(found, 'open the klawly-sync repo');
		}
		this._ready = true;
	}

	/** The branch head, from a conditional request when the last answer is known. */
	private async head(): Promise<string> {
		await this.ensureRepo();
		const response = await this.call('GET', `${this.repoUrl}/git/ref/heads/${BRANCH}`, undefined, this._head?.etag ? { 'If-None-Match': this._head.etag } : {});
		if (response.status === 304 && this._head) {
			return this._head.sha;
		}
		if (response.status !== 200) {
			this.fail(response, 'read the sync branch');
		}
		const sha = str(record(record(response.body).object).sha);
		this._head = { etag: response.headers.etag, sha };
		return sha;
	}

	private async tree(commitSha: string): Promise<{ treeSha: string; entries: { path: string; sha: string }[] }> {
		const commit = await this.call('GET', `${this.repoUrl}/git/commits/${commitSha}`);
		if (commit.status !== 200) {
			this.fail(commit, 'read the sync commit');
		}
		const treeSha = str(record(record(commit.body).tree).sha);
		const tree = await this.call('GET', `${this.repoUrl}/git/trees/${treeSha}?recursive=1`);
		if (tree.status !== 200) {
			this.fail(tree, 'read the sync files');
		}
		const raw = record(tree.body).tree;
		const entries = (Array.isArray(raw) ? raw : []).map(record).filter(e => e.type === 'blob').map(e => ({ path: str(e.path), sha: str(e.sha) }));
		return { treeSha, entries };
	}

	private async blob(sha: string): Promise<string> {
		const cached = this._blobs.get(sha);
		if (cached !== undefined) {
			return cached;
		}
		const response = await this.call('GET', `${this.repoUrl}/git/blobs/${sha}`);
		if (response.status !== 200) {
			this.fail(response, 'read a synced file');
		}
		const text = Buffer.from(str(record(response.body).content), 'base64').toString('utf8');
		this._blobs.set(sha, text);
		return text;
	}

	private async readAt(resource: KlawlySyncResource, commitSha: string): Promise<{ remote: KlawlySyncRemote | undefined; treeSha: string; paths: string[] }> {
		const { treeSha, entries } = await this.tree(commitSha);
		const prefix = `${resource}/`;
		const mine = entries.filter(e => e.path.startsWith(prefix));
		if (mine.length === 0) {
			return { remote: undefined, treeSha, paths: [] };
		}
		const files: Record<string, string | null> = {};
		for (const entry of mine) {
			const relative = entry.path.slice(prefix.length);
			const content = await this.blob(entry.sha);
			if (relative === TOMBSTONES_FILE) {
				for (const dead of JSON.parse(content) as string[]) {
					files[dead] ??= null;
				}
			} else {
				files[relative] = content;
			}
		}
		return { remote: { version: commitSha, files }, treeSha, paths: mine.map(e => e.path) };
	}

	async read(resource: KlawlySyncResource): Promise<KlawlySyncRemote | undefined> {
		return (await this.readAt(resource, await this.head())).remote;
	}

	async push(resource: KlawlySyncResource, baseVersion: string | undefined, files: KlawlySyncSnapshot, machine: string): Promise<KlawlySyncPushResult> {
		const head = await this.head();
		const parent = baseVersion ?? head;
		const { remote, treeSha, paths } = await this.readAt(resource, parent);
		if (baseVersion === undefined && remote) {
			return { kind: 'conflict', current: remote };
		}
		const prefix = `${resource}/`;
		const entries: { path: string; mode: '100644'; type: 'blob'; content?: string; sha?: null }[] = [];
		const wanted = new Set<string>();
		const dead: string[] = [];
		for (const [path, content] of Object.entries(files)) {
			if (content === null) {
				dead.push(path);
			} else {
				wanted.add(prefix + path);
				entries.push({ path: prefix + path, mode: '100644', type: 'blob', content });
			}
		}
		if (dead.length > 0) {
			wanted.add(prefix + TOMBSTONES_FILE);
			entries.push({ path: prefix + TOMBSTONES_FILE, mode: '100644', type: 'blob', content: JSON.stringify(dead.sort(), undefined, '\t') + '\n' });
		}
		for (const path of paths) {
			if (!wanted.has(path)) {
				entries.push({ path, mode: '100644', type: 'blob', sha: null });
			}
		}
		const tree = await this.call('POST', `${this.repoUrl}/git/trees`, { base_tree: treeSha, tree: entries });
		if (tree.status !== 201) {
			this.fail(tree, 'write the sync files');
		}
		const commit = await this.call('POST', `${this.repoUrl}/git/commits`, { message: `Sync ${resource} from ${machine}`, tree: str(record(tree.body).sha), parents: [parent] });
		if (commit.status !== 201) {
			this.fail(commit, 'write the sync commit');
		}
		const sha = str(record(commit.body).sha);
		const moved = await this.call('PATCH', `${this.repoUrl}/git/refs/heads/${BRANCH}`, { sha, force: false });
		if (moved.status === 422 || moved.status === 409) {
			this._head = undefined;
			return { kind: 'conflict', current: await this.read(resource) };
		}
		if (moved.status !== 200) {
			this.fail(moved, 'move the sync branch');
		}
		this._head = undefined;
		return { kind: 'ok', version: sha };
	}

	async deleteResource(resource: KlawlySyncResource, machine: string): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const head = await this.head();
			const { treeSha, paths } = await this.readAt(resource, head);
			if (paths.length === 0) {
				return;
			}
			const tree = await this.call('POST', `${this.repoUrl}/git/trees`, { base_tree: treeSha, tree: paths.map(path => ({ path, mode: '100644', type: 'blob', sha: null })) });
			if (tree.status !== 201) {
				this.fail(tree, 'remove the sync files');
			}
			const commit = await this.call('POST', `${this.repoUrl}/git/commits`, { message: `Delete ${resource} from ${machine}`, tree: str(record(tree.body).sha), parents: [head] });
			if (commit.status !== 201) {
				this.fail(commit, 'write the sync commit');
			}
			const moved = await this.call('PATCH', `${this.repoUrl}/git/refs/heads/${BRANCH}`, { sha: str(record(commit.body).sha), force: false });
			this._head = undefined;
			if (moved.status === 200) {
				return;
			}
			if (moved.status !== 422 && moved.status !== 409) {
				this.fail(moved, 'move the sync branch');
			}
		}
		throw new Error(`Could not remove ${resource} from the sync repo: it kept changing. Try again.`);
	}
}
