/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../files/common/files.js';
import { CheckpointStorage, CheckpointStorageStat } from './claudeCheckpointStore.js';

/** File-service adapter so the renderer can read and restore the same object store. */
export function createFileServiceCheckpointStorage(files: IFileService): CheckpointStorage {
	const file = (path: string) => URI.file(path);
	return {
		exists: path => files.exists(file(path)),
		readFile: async path => (await files.readFile(file(path))).value.buffer,
		writeFile: async (path, bytes) => {
			await files.writeFile(file(path), VSBuffer.wrap(bytes));
		},
		rename: async (from, to) => {
			await files.move(file(from), file(to), true);
		},
		mkdir: async path => {
			await files.createFolder(file(path));
		},
		readDir: async path => {
			try {
				const stat = await files.resolve(file(path));
				return (stat.children ?? []).map(child => child.name);
			} catch {
				return [];
			}
		},
		remove: async path => {
			try {
				await files.del(file(path));
			} catch {
				// Already gone.
			}
		},
		stat: async path => {
			try {
				const stat = await files.stat(file(path));
				return { mtime: stat.mtime, size: stat.size } satisfies CheckpointStorageStat;
			} catch {
				return undefined;
			}
		},
	};
}
