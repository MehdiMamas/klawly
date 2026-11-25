/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClaudeRemoteFilesService, parseClaudeRemoteUri } from '../../../../platform/claude/common/claudeRemoteFiles.js';
import { createFileSystemProviderError, FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType, IFileChange, IFileDeleteOptions, IFileOverwriteOptions, IFileSystemProviderWithFileReadWriteCapability, IFileWriteOptions, IStat } from '../../../../platform/files/common/files.js';

/**
 * `claude-remote:` files (issue 425): single files on the SSH host an agent ran
 * on, so Review can show what the agent changed there. It reads and stats, and
 * writes and deletes only so Reject and Restore put a file back on the host.
 * It never lists, renames or watches: an agent's change is opened by its uri.
 */
export class ClaudeRemoteFileSystemProvider implements IFileSystemProviderWithFileReadWriteCapability {
	readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
	readonly onDidChangeCapabilities = Event.None;
	readonly onDidChangeFile: Event<readonly IFileChange[]> = Event.None;

	constructor(@IClaudeRemoteFilesService private readonly _remoteFiles: IClaudeRemoteFilesService) { }

	watch(): IDisposable {
		return Disposable.None;
	}

	async stat(resource: URI): Promise<IStat> {
		const { host, path } = this.parse(resource);
		const stat = await this._remoteFiles.stat(host, path);
		if (!stat) {
			throw this.missing(host, path);
		}
		return { type: stat.type === 'directory' ? FileType.Directory : FileType.File, size: stat.size, mtime: stat.mtime, ctime: stat.mtime };
	}

	async readFile(resource: URI): Promise<Uint8Array> {
		const { host, path } = this.parse(resource);
		const content = await this._remoteFiles.readFile(host, path);
		if (!content) {
			throw this.missing(host, path);
		}
		return content.buffer;
	}

	async writeFile(resource: URI, content: Uint8Array, _opts: IFileWriteOptions): Promise<void> {
		const { host, path } = this.parse(resource);
		await this._remoteFiles.writeFile(host, path, VSBuffer.wrap(content));
	}

	async delete(resource: URI, _opts: IFileDeleteOptions): Promise<void> {
		const { host, path } = this.parse(resource);
		await this._remoteFiles.delete(host, path);
	}

	async mkdir(): Promise<void> {
		throw this.unsupported();
	}

	async readdir(): Promise<[string, FileType][]> {
		throw this.unsupported();
	}

	async rename(_from: URI, _to: URI, _opts: IFileOverwriteOptions): Promise<void> {
		throw this.unsupported();
	}

	private parse(resource: URI): { readonly host: string; readonly path: string } {
		const parsed = parseClaudeRemoteUri(resource);
		if (!parsed) {
			throw createFileSystemProviderError(localize('claudeRemoteFileInvalid', "Not a file on an SSH run target: {0}", resource.toString()), FileSystemProviderErrorCode.FileNotFound);
		}
		return parsed;
	}

	private missing(host: string, path: string): Error {
		return createFileSystemProviderError(localize('claudeRemoteFileMissing', "{0} is not on {1}.", path, host), FileSystemProviderErrorCode.FileNotFound);
	}

	private unsupported(): Error {
		return createFileSystemProviderError(localize('claudeRemoteFileUnsupported', "Klawly only opens single files an agent changed on an SSH host."), FileSystemProviderErrorCode.NoPermissions);
	}
}
