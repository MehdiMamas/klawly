/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../files/common/files.js';
import { SessionStorage } from './claudeSessionStore.js';

/** File-service adapter so the renderer writes the same session files Node does. */
export function createFileServiceSessionStorage(files: IFileService): SessionStorage {
	const file = (path: string) => URI.file(path);
	return {
		read: async path => {
			const resource = file(path);
			if (!await files.exists(resource)) {
				return undefined;
			}
			return (await files.readFile(resource)).value.toString();
		},
		write: async (path, text) => {
			await files.writeFile(file(path), VSBuffer.fromString(text));
		},
		append: async (path, text) => {
			await files.writeFile(file(path), VSBuffer.fromString(text), { append: true });
		},
		list: async path => {
			try {
				const stat = await files.resolve(file(path));
				return (stat.children ?? []).map(child => child.name);
			} catch {
				return [];
			}
		},
		rename: async (from, to) => {
			await files.move(file(from), file(to), true);
		},
		mkdir: async path => {
			await files.createFolder(file(path));
		},
		remove: async path => {
			try {
				await files.del(file(path), { recursive: true });
			} catch {
				// Already gone.
			}
		},
	};
}
