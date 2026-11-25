/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { isClaudeSshHost } from './claudeExecutionTarget.js';

/**
 * Files on an SSH host an agent ran on (issue 425): `claude-remote://<host>/<path>`.
 * Change capture records them, and Review reads and writes them through
 * {@link IClaudeRemoteFilesService}.
 */
export const CLAUDE_REMOTE_SCHEME = 'claude-remote';

/** Shared-process channel for {@link IClaudeRemoteFilesService}. */
export const CLAUDE_REMOTE_FILES_CHANNEL = 'claudeRemoteFiles';

export const IClaudeRemoteFilesService = createDecorator<IClaudeRemoteFilesService>('claudeRemoteFilesService');

export interface ClaudeRemoteFileStat {
	readonly type: 'file' | 'directory';
	readonly size: number;
	/** Milliseconds since the epoch. */
	readonly mtime: number;
}

/**
 * Reads and writes single files on an SSH host over the user's own `ssh`, the
 * same way the agent reached it. Paths are absolute POSIX paths on the host.
 */
export interface IClaudeRemoteFilesService {
	readonly _serviceBrand: undefined;
	/** Undefined when nothing is at `path`. */
	stat(host: string, path: string): Promise<ClaudeRemoteFileStat | undefined>;
	/** Undefined when the file does not exist. */
	readFile(host: string, path: string): Promise<VSBuffer | undefined>;
	/** Creates the parent folder when it is missing. */
	writeFile(host: string, path: string, content: VSBuffer): Promise<void>;
	delete(host: string, path: string): Promise<void>;
}

/** An absolute file path on a host: starts with `/`, one line, no NUL. */
export function isClaudeRemoteFilePath(value: string): boolean {
	return value.startsWith('/') && !/[\0\r\n]/.test(value) && value.length <= 4096;
}

export function claudeRemoteUri(host: string, path: string): URI {
	return URI.from({ scheme: CLAUDE_REMOTE_SCHEME, authority: host, path });
}

/** The host and path of a `claude-remote:` uri. Undefined for any other uri or a malformed one. */
export function parseClaudeRemoteUri(uri: URI): { readonly host: string; readonly path: string } | undefined {
	if (uri.scheme !== CLAUDE_REMOTE_SCHEME || !isClaudeSshHost(uri.authority) || !isClaudeRemoteFilePath(uri.path)) {
		return undefined;
	}
	return { host: uri.authority, path: uri.path };
}
