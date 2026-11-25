/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { createFileSystemProviderError, FilePermission, FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType, IFileChange, IFileSystemProviderWithFileReadWriteCapability, IStat } from '../../../../platform/files/common/files.js';
import { IClaudeReviewService } from './claudeReview.js';

/**
 * `claude-notebook-snapshot:` files (issue 526): a notebook as it was before
 * Claude's turn, so Review opens upstream's notebook diff editor instead of a
 * JSON text diff. The notebook diff editor reads both sides as files, so the
 * text snapshot is served here, read-only. It never lists, writes or watches.
 */
export class ClaudeNotebookSnapshotFileSystem implements IFileSystemProviderWithFileReadWriteCapability {
	readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.Readonly | FileSystemProviderCapabilities.PathCaseSensitive;
	readonly onDidChangeCapabilities = Event.None;
	readonly onDidChangeFile: Event<readonly IFileChange[]> = Event.None;

	constructor(private readonly _review: Pick<IClaudeReviewService, 'snapshotText'>) { }

	watch(): IDisposable {
		return Disposable.None;
	}

	async stat(resource: URI): Promise<IStat> {
		const bytes = this.bytes(resource);
		return { type: FileType.File, size: bytes.byteLength, mtime: 0, ctime: 0, permissions: FilePermission.Readonly };
	}

	async readFile(resource: URI): Promise<Uint8Array> {
		return this.bytes(resource);
	}

	async writeFile(): Promise<void> {
		throw this.readonly();
	}

	async delete(): Promise<void> {
		throw this.readonly();
	}

	async mkdir(): Promise<void> {
		throw this.readonly();
	}

	async readdir(): Promise<[string, FileType][]> {
		return [];
	}

	async rename(): Promise<void> {
		throw this.readonly();
	}

	private bytes(resource: URI): Uint8Array {
		const text = this._review.snapshotText(resource);
		if (text === undefined) {
			throw createFileSystemProviderError(localize('claudeNotebookSnapshotMissing', "The notebook as it was before Claude's turn is no longer available: {0}", resource.path), FileSystemProviderErrorCode.FileNotFound);
		}
		return VSBuffer.fromString(text).buffer;
	}

	private readonly(): Error {
		return createFileSystemProviderError(localize('claudeNotebookSnapshotReadonly', "The notebook before Claude's turn is read-only."), FileSystemProviderErrorCode.NoPermissions);
	}
}
