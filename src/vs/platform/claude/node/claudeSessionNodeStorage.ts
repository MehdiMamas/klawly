/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { SessionStorage } from '../common/claudeSessionStore.js';

/** Node filesystem for `<userData>/agent-sessions`. */
export class NodeSessionStorage implements SessionStorage {
	async read(path: string): Promise<string | undefined> {
		try {
			return await readFile(path, 'utf8');
		} catch (error) {
			if (isMissing(error)) {
				return undefined;
			}
			throw error;
		}
	}

	write(path: string, text: string): Promise<void> {
		return writeFile(path, text, 'utf8');
	}

	append(path: string, text: string): Promise<void> {
		return appendFile(path, text, 'utf8');
	}

	rename(from: string, to: string): Promise<void> {
		return rename(from, to);
	}

	mkdir(path: string): Promise<void> {
		return mkdir(path, { recursive: true }).then(() => undefined);
	}

	remove(path: string): Promise<void> {
		return rm(path, { recursive: true, force: true });
	}

	async list(path: string): Promise<readonly string[]> {
		try {
			return await readdir(path);
		} catch (error) {
			if (isMissing(error)) {
				return [];
			}
			throw error;
		}
	}
}

function isMissing(error: unknown): boolean {
	const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
	return code === 'ENOENT';
}
