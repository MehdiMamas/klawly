/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { dirname, join } from '../../../base/common/path.js';
import { IKlawlySyncLocal, KlawlySyncBase } from '../common/klawlySyncEngine.js';
import { KlawlySyncConflict, sameKlawlySnapshot } from '../common/klawlySyncMerge.js';
import { KlawlySyncResource } from '../common/klawlySyncStore.js';

/** Where a resource kind lives on this machine, and where the sync keeps its own state. */
export interface KlawlySyncFileLocalOptions {
	/** The folder holding the live files of a resource, or `undefined` when this machine has none. */
	readonly resourceDir: (resource: KlawlySyncResource) => string;
	/** `~/.klawly/claude/.sync`: holds `base/` and `conflicts/`. */
	readonly syncDir: string;
	readonly getSecret: (name: string) => string | undefined;
	readonly setSecret: (name: string, value: string) => void;
}

/** Writes `content` to `target` atomically: a tmp file in the same folder, flushed, then renamed. */
export async function writeKlawlyFileAtomic(target: string, content: string): Promise<void> {
	await fs.mkdir(dirname(target), { recursive: true });
	const tmp = `${target}.${process.pid}.tmp`;
	const handle = await fs.open(tmp, 'w');
	try {
		await handle.writeFile(content, 'utf8');
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.rename(tmp, target);
}

async function walk(root: string, prefix = ''): Promise<string[]> {
	let entries;
	try {
		entries = await fs.readdir(join(root, prefix), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
	const files: string[] = [];
	for (const entry of entries) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			files.push(...await walk(root, relative));
		} else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
			files.push(relative);
		}
	}
	return files;
}

/**
 * The machine side of Klawly Sync on a real disk. Reads are plain files, writes are atomic and
 * compare-and-swap against what the engine read, and the base copy of each resource lives in
 * `.sync/base/<resource>.json`. Paths from the store are checked so a remote file can never
 * escape the resource folder.
 */
export class KlawlySyncFileLocal implements IKlawlySyncLocal {

	constructor(private readonly _options: KlawlySyncFileLocalOptions) { }

	async read(resource: KlawlySyncResource): Promise<Record<string, string>> {
		const root = this._options.resourceDir(resource);
		const files: Record<string, string> = {};
		for (const path of await walk(root)) {
			files[path] = await fs.readFile(join(root, path), 'utf8');
		}
		return files;
	}

	async write(resource: KlawlySyncResource, expected: Record<string, string>, next: Record<string, string>): Promise<boolean> {
		const root = this._options.resourceDir(resource);
		if (!sameKlawlySnapshot(await this.read(resource), expected)) {
			return false;
		}
		for (const [path, content] of Object.entries(next)) {
			if (expected[path] !== content) {
				await writeKlawlyFileAtomic(this._safePath(root, path), content);
			}
		}
		for (const path of Object.keys(expected)) {
			if (next[path] === undefined) {
				await fs.rm(this._safePath(root, path), { force: true });
			}
		}
		return true;
	}

	async readBase(resource: KlawlySyncResource): Promise<KlawlySyncBase> {
		try {
			return JSON.parse(await fs.readFile(this._basePath(resource), 'utf8')) as KlawlySyncBase;
		} catch {
			return { version: undefined, files: {} };
		}
	}

	async writeBase(resource: KlawlySyncResource, base: KlawlySyncBase): Promise<void> {
		await writeKlawlyFileAtomic(this._basePath(resource), JSON.stringify(base));
	}

	async saveConflict(resource: KlawlySyncResource, conflict: KlawlySyncConflict): Promise<void> {
		const target = this._safePath(join(this._options.syncDir, 'conflicts', resource), `${conflict.path}.remote`);
		if (conflict.remote === null) {
			await fs.rm(target, { force: true });
		} else {
			await writeKlawlyFileAtomic(target, conflict.remote);
		}
	}

	getSecret(name: string): string | undefined {
		return this._options.getSecret(name);
	}

	setSecret(name: string, value: string): void {
		this._options.setSecret(name, value);
	}

	private _basePath(resource: KlawlySyncResource): string {
		return join(this._options.syncDir, 'base', `${resource}.json`);
	}

	private _safePath(root: string, path: string): string {
		const target = join(root, path);
		if (path.startsWith('/') || path.split('/').includes('..') || !target.startsWith(root)) {
			throw new Error(`Klawly Sync refused a path outside its folder: ${path}`);
		}
		return target;
	}
}
