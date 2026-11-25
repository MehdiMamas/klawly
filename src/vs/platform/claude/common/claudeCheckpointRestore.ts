/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CheckpointFileRecord, RestoreConflict, TurnCheckpoint, postCheckpointUserEdits, sha256Hex } from './claudeCheckpoints.js';
import { stagedIndexConflicts } from './claudeGit.js';

/** An editor that is open for a checkpoint file. Text replaces go through it. */
export interface CheckpointDocument {
	readonly uri: string;
	getText(): string;
	isDirty(): boolean;
	replaceText(value: string): void;
	/**
	 * Reloads the model from disk after a clean file is restored, so the buffer
	 * is not dirty and its etag matches the bytes just written.
	 */
	revert?(): Promise<void> | void;
	/** Drops the model when the restore deletes the file. */
	close?(): Promise<void> | void;
}

const textEncoder = new TextEncoder();

/**
 * Restores every file in the checkpoint. User edits made after it are listed
 * first; a declined preview leaves the workspace alone.
 *
 * An open dirty document changes the buffer only. Disk is left as it is, so
 * closing that document without saving drops the restore.
 * An open clean document is written to disk and then reverted, so the model
 * matches those bytes and is not left dirty with a stale etag.
 * A clean document for a file the checkpoint says did not exist is deleted
 * and the model is closed.
 */
export async function restoreCheckpointContents(options: {
	readonly checkpoint: TurnCheckpoint;
	readonly documents: readonly CheckpointDocument[];
	readBlob(hash: string): Promise<Uint8Array>;
	readDisk(uri: string): Promise<Uint8Array | null>;
	writeDisk(uri: string, bytes: Uint8Array | null): Promise<void>;
	confirm(conflicts: readonly RestoreConflict[]): Promise<boolean>;
	/**
	 * Current staged blob id for each checkpoint file, or null when the path is
	 * not in the index. Absent when the index was not read. This restore writes
	 * working-tree bytes only and never the Git index.
	 */
	indexBlobs?: ReadonlyMap<string, string | null>;
}): Promise<'restored' | 'cancelled'> {
	for (const file of options.checkpoint.files) {
		if (file.existed && !file.hash) {
			throw new Error('Checkpoint is missing the original file contents.');
		}
	}
	const current = new Map<string, string | null>();
	for (const file of options.checkpoint.files) {
		current.set(file.uri, await currentHash(file, options));
	}
	const conflicts: RestoreConflict[] = postCheckpointUserEdits(options.checkpoint, current);
	if (options.indexBlobs) {
		conflicts.push(...stagedIndexConflicts(options.checkpoint.files, options.indexBlobs));
	}
	if (conflicts.length > 0 && !await options.confirm(conflicts)) {
		return 'cancelled';
	}
	const blobs = new Map<string, Uint8Array>();
	for (const file of options.checkpoint.files) {
		if (file.hash && !blobs.has(file.hash)) {
			blobs.set(file.hash, await options.readBlob(file.hash));
		}
	}
	for (const file of options.checkpoint.files) {
		const bytes = file.hash ? blobs.get(file.hash) ?? null : null;
		const document = options.documents.find(candidate => candidate.uri === file.uri);
		if (document) {
			await restoreOpenDocument(document, file.hash ? bytes : null, options.writeDisk);
			continue;
		}
		await options.writeDisk(file.uri, bytes);
	}
	return 'restored';
}

/**
 * Dirty: buffer only, disk unchanged. Clean: write the snapshot bytes, then
 * revert so the model is clean. A missing snapshot deletes a clean file and
 * closes the model instead of leaving an empty dirty buffer.
 */
async function restoreOpenDocument(document: CheckpointDocument, bytes: Uint8Array | null, writeDisk: (uri: string, bytes: Uint8Array | null) => Promise<void>): Promise<void> {
	const wasDirty = document.isDirty();
	const text = bytes ? textForModel(bytes) : '';
	if (wasDirty) {
		if (text !== undefined) {
			document.replaceText(text);
		}
		return;
	}
	await writeDisk(document.uri, bytes);
	if (bytes === null) {
		if (document.close) {
			await document.close();
		} else if (document.revert) {
			await document.revert();
		}
		return;
	}
	if (document.revert) {
		await document.revert();
		return;
	}
	if (text !== undefined) {
		document.replaceText(text);
	}
}

async function currentHash(file: CheckpointFileRecord, options: {
	readonly documents: readonly CheckpointDocument[];
	readBlob(hash: string): Promise<Uint8Array>;
	readDisk(uri: string): Promise<Uint8Array | null>;
}): Promise<string | null> {
	const document = options.documents.find(candidate => candidate.uri === file.uri);
	const disk = await options.readDisk(file.uri);
	if (!document || !document.isDirty()) {
		return disk ? sha256Hex(disk) : null;
	}
	const modelText = normalizeCheckpointText(document.getText());
	if (file.hash) {
		try {
			const decoded = decodeUtf8(await options.readBlob(file.hash));
			if (decoded !== undefined && normalizeCheckpointText(decoded) === modelText) {
				return file.hash;
			}
		} catch {
			// The blob is unreadable. Fall through to the bytes on disk.
		}
	}
	if (!disk) {
		return sha256Hex(textEncoder.encode(modelText));
	}
	const diskHash = await sha256Hex(disk);
	const decoded = decodeUtf8(disk);
	if (decoded === undefined || normalizeCheckpointText(decoded) === modelText) {
		return diskHash;
	}
	return sha256Hex(textEncoder.encode(modelText));
}

/** Model text has no BOM and uses LF. Raw disk bytes stay on disk for a clean restore. */
function textForModel(bytes: Uint8Array): string | undefined {
	const decoded = decodeUtf8(bytes);
	return decoded === undefined ? undefined : normalizeCheckpointText(decoded);
}

function normalizeCheckpointText(text: string): string {
	const withoutBom = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
	return withoutBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}
