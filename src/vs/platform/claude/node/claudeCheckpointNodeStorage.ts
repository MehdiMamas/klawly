/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { pipeline, Transform } from 'stream';
import { promisify } from 'util';
import { dirname, join } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { CheckpointStorage, CheckpointStorageStat } from '../common/claudeCheckpointStore.js';

const pipelineAsync = promisify(pipeline);

/** Node filesystem for the checkpoint object store. Large files are streamed. */
export class NodeCheckpointStorage implements CheckpointStorage {
	async exists(path: string): Promise<boolean> {
		return (await this.stat(path)) !== undefined;
	}

	readFile(path: string): Promise<Uint8Array> {
		return readFile(path);
	}

	writeFile(path: string, bytes: Uint8Array): Promise<void> {
		return writeFile(path, bytes);
	}

	rename(from: string, to: string): Promise<void> {
		return rename(from, to);
	}

	mkdir(path: string): Promise<void> {
		return mkdir(path, { recursive: true }).then(() => undefined);
	}

	async readDir(path: string): Promise<readonly string[]> {
		try {
			return await readdir(path);
		} catch (error) {
			if (isMissing(error)) {
				return [];
			}
			throw error;
		}
	}

	remove(path: string): Promise<void> {
		return rm(path, { force: true });
	}

	async stat(path: string): Promise<CheckpointStorageStat | undefined> {
		try {
			const info = await stat(path);
			return { mtime: info.mtimeMs, size: info.size };
		} catch (error) {
			if (isMissing(error)) {
				return undefined;
			}
			throw error;
		}
	}

	hashFile(path: string): Promise<string> {
		return hashStream(path);
	}

	/**
	 * One pass: hash while copying to a temp file, then rename onto the
	 * content-addressed path. An existing blob is left in place.
	 */
	async importLarge(source: string, place: (hash: string) => string): Promise<string> {
		const sample = place('ab' + 'c'.repeat(62));
		const tmp = join(dirname(dirname(sample)), `.tmp-${process.pid}-${generateUuid()}`);
		await this.mkdir(dirname(tmp));
		const hash = createHash('sha256');
		const hasher = new Transform({
			transform(chunk, _encoding, callback) {
				hash.update(chunk);
				callback(null, chunk);
			},
		});
		await pipelineAsync(createReadStream(source), hasher, createWriteStream(tmp));
		const digest = hash.digest('hex');
		const target = place(digest);
		if (await this.exists(target)) {
			await this.remove(tmp);
			return digest;
		}
		await this.mkdir(dirname(target));
		try {
			await this.rename(tmp, target);
		} catch (error) {
			if (await this.exists(target)) {
				await this.remove(tmp);
				return digest;
			}
			throw error;
		}
		return digest;
	}
}

function hashStream(path: string): Promise<string> {
	const hash = createHash('sha256');
	return pipelineAsync(createReadStream(path), hash).then(() => hash.digest('hex'));
}

function isMissing(error: unknown): boolean {
	const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
	return code === 'ENOENT';
}
